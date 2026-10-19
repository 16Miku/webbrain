// The install guide downloads D1 first and the in-browser chat model after it.
// The guide can be closed while D1 downloads, so the chat model's download is
// queued in storage and the background starts it once D1's download is over:
// when the guide reads D1's status, and on an alarm while the guide is gone.

export const CHAT_AFTER_D1_KEY = 'installChatModelAfterD1';
export const CHAT_AFTER_D1_ALARM = 'install-chat-model-after-d1';
// D1's download and load stop after thirty minutes (d1-worker.js), so a queue
// this old was left behind by a browser restart or an abandoned guide.
export const CHAT_AFTER_D1_MAX_AGE_MS = 45 * 60_000;

// D1 is still checking the GPU, downloading or loading.
const D1_TRANSFER_STATUSES = new Set(['checking', 'downloading', 'loading']);
// A chat-model download that has started, or a transfer holding the WebGPU
// download slot (install.js LOCAL_MODEL_TRANSFER_STATUSES).
const CHAT_TRANSFER_STATUSES = new Set(['checking', 'starting', 'queued', 'downloading', 'paused', 'stopping', 'loading']);

/**
 * `d1Status()` reads D1's status, `chatStatus(model)` the chat model's
 * download status and `startChat(model)` starts that download. A start that
 * fails keeps the queue for the next check, and `onStartError` hears why.
 */
export function createChatModelAfterD1({ api, d1Status, chatStatus, startChat, onStartError = () => {}, now = () => Date.now() }) {
  const storage = api.storage.local;
  const read = async () => (await storage.get(CHAT_AFTER_D1_KEY))?.[CHAT_AFTER_D1_KEY] || null;
  const clearAlarm = async () => { try { await api.alarms?.clear?.(CHAT_AFTER_D1_ALARM); } catch { /* best effort */ } };
  const clear = async () => { await storage.remove(CHAT_AFTER_D1_KEY); await clearAlarm(); };
  // One step at a time: the guide's status reads and the alarm must not both
  // start the download.
  let steps = Promise.resolve();
  const serial = (fn) => {
    const step = steps.then(fn);
    steps = step.catch(() => {});
    return step;
  };

  // Returns whether the chat model still waits for D1. D1's status is read
  // here, after any Pause or Resume ahead of this step, never before it.
  async function step() {
    const queued = await read();
    if (!queued || typeof queued.model !== 'string' || !queued.model) {
      if (queued) await storage.remove(CHAT_AFTER_D1_KEY);
      await clearAlarm();
      return false;
    }
    const age = now() - Number(queued.queuedAt);
    if (!(age >= 0 && age <= CHAT_AFTER_D1_MAX_AGE_MS)) { await clear(); return false; }
    let d1;
    try { d1 = await d1Status(); } catch { return true; }
    const d1State = String(d1?.status || '');
    if (d1?.loaded !== true && D1_TRANSFER_STATUSES.has(d1State)) return true;
    // Paused on the guide: its Resume carries on to the chat model.
    if (d1State === 'stopped' && queued.paused === true && d1?.cached !== true) return true;
    // D1's download is over: ready or saved, failed, or stopped some other way.
    let chat;
    try { chat = await chatStatus(queued.model); } catch { return true; }
    const chatState = String(chat?.status || '');
    // Not started yet, or failed; or paused when the guide's Resume queued it.
    const startable = chat?.ready !== true
      && (!CHAT_TRANSFER_STATUSES.has(chatState) || (chatState === 'paused' && queued.resumeChat === true));
    const other = chat?.activeTransfer;
    const otherModel = String(other?.modelId || other?.model || '').trim();
    if (startable && otherModel && otherModel !== queued.model && CHAT_TRANSFER_STATUSES.has(String(other?.status || ''))) {
      // Another model holds the WebGPU download slot: start when it is free.
      return true;
    }
    if (startable) {
      try {
        await startChat(queued.model);
      } catch (error) {
        // Kept for the next check (the alarm, or the guide's next read) until
        // it starts or the queue is too old.
        onStartError(error);
        return true;
      }
    }
    await clear();
    return false;
  }

  return {
    // The guide asked for both models: the chat model follows D1. A chat
    // download that is paused now was paused before this click, so it resumes
    // after D1; one paused later, elsewhere, is left paused.
    queue: (model) => serial(async () => {
      let resumeChat = false;
      try { resumeChat = String((await chatStatus(model))?.status || '') === 'paused'; } catch { /* not known to be paused */ }
      await storage.set({ [CHAT_AFTER_D1_KEY]: { model, queuedAt: now(), paused: false, ...(resumeChat ? { resumeChat: true } : {}) } });
      try { await api.alarms?.create?.(CHAT_AFTER_D1_ALARM, { periodInMinutes: 0.5 }); } catch { /* the guide's reads still advance it */ }
    }),
    // The guide pauses D1: the chat model waits for its Resume. Called before
    // D1 is stopped, so no check sees the stop without the Pause.
    pause: () => serial(async () => {
      const queued = await read();
      if (queued?.model) await storage.set({ [CHAT_AFTER_D1_KEY]: { ...queued, paused: true } });
    }),
    queued: () => serial(async () => !!(await read())?.model),
    advance: () => serial(step),
  };
}
