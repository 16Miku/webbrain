/** One isolated WASM worker per browser, shared by every Instagram tab. */
export function createSafeSocialHost({ WorkerClass = globalThis.Worker } = {}) {
  let worker;
  let nextId = 0;
  let state = { status: 'idle', progress: 0 };
  const pending = new Map();
  function stop() {
    worker?.terminate();
    worker = null;
    for (const item of pending.values()) { clearTimeout(item.timer); item.reject(new Error('Classifier stopped.')); }
    pending.clear();
    state = { status: 'idle', progress: 0 };
  }
  function start() {
    if (worker) return;
    const current = worker = new WorkerClass(new URL('./worker.js', import.meta.url), { type: 'module' });
    current.onmessage = ({ data }) => {
      if (worker !== current) return;
      if (data.state) { state = data.state; return; }
      const item = pending.get(data.id);
      if (!item) return;
      pending.delete(data.id);
      clearTimeout(item.timer);
      if (data.error) item.reject(new Error(data.error));
      else item.resolve(data.result);
    };
    current.onerror = () => { stop(); state = { status: 'error', progress: 0 }; };
  }
  return {
    async handle(command, payload = {}) {
      if (command === 'status') return { ...state };
      if (command === 'stop') { stop(); return { ...state }; }
      if (!['prepare', 'classify'].includes(command)) throw new Error('Unknown classifier command.');
      start();
      if (pending.size >= 32) throw new Error('Classifier is busy.');
      const id = ++nextId;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { stop(); state = { status: 'error', progress: 0 }; }, 180_000);
        pending.set(id, { resolve, reject, timer });
        worker.postMessage({ id, command, url: payload.url });
      });
    },
  };
}
