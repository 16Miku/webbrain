let worker = null, nextId = 0, state = { status: 'idle' };
const pending = new Map();

export function resetD1Worker(reason = new Error('D1 worker reset.')) {
  worker?.terminate(); worker = null; state = { status: 'idle' };
  for (const request of pending.values()) { clearTimeout(request.timer); request.reject(reason); }
  pending.clear();
}

// The caller stopped waiting: the Worker skips or stops that evaluation and
// keeps the model. Only a request's own deadline below discards the Worker.
export function cancelD1Request(requestId) {
  if (worker && typeof requestId === 'string') worker.postMessage({ id: ++nextId, type: 'cancel', payload: { requestId } });
}

export function dispatchD1Worker(type, payload, timeoutMs = 90_000) {
  if (!worker) {
    worker = new Worker((globalThis.browser || globalThis.chrome).runtime.getURL('src/providers/d1-worker.js'), { type: 'module' });
    worker.onmessage = event => {
      if (event.data?.state) { state = event.data.state; return; }
      const request = pending.get(event.data?.id); if (!request) return;
      pending.delete(event.data.id); clearTimeout(request.timer);
      event.data.ok ? request.resolve(event.data.result) : request.reject(Object.assign(new Error(event.data.error), typeof event.data.code === 'string' ? { code: event.data.code } : {}));
    };
    worker.onerror = event => resetD1Worker(new Error('D1 worker failed: ' + event.message));
  }
  if (type === 'status' && ['downloading', 'loading', 'checking'].includes(state.status)) return Promise.resolve({ ...state, ready: false });
  const id = ++nextId;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resetD1Worker(new Error('D1 worker request timed out; its session was discarded.')), timeoutMs);
    pending.set(id, { resolve, reject, timer }); worker.postMessage({ id, type, payload });
  });
}
