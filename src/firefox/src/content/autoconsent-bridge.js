// Per-frame isolated-world loader. A fresh instance is needed after coverage
// is restored: an old instance's pending rule steps must stay cancelled.
(() => {
  const existing = window.__webbrainAutoconsentBridge;
  if (existing) { existing.resync(); return; }
  const api = globalThis.browser || globalThis.chrome;
  const CONTENT_MESSAGE = 'webbrain-autoconsent';
  const BACKGROUND_MESSAGE = 'webbrain-autoconsent-bg';
  let current;
  const send = msg => api.runtime.sendMessage({ type: CONTENT_MESSAGE, msg });

  function stop() {
    if (!current) return;
    current.cancelled = true;
    current.runtime?.stop();
    current.lastReport = null;
  }
  function start() {
    const owner = { cancelled: false, runtime: null, lastReport: null };
    current = owner;
    import(api.runtime.getURL('src/content/autoconsent-runtime.js')).then(({ createCookieBannerRuntime }) => {
      if (owner.cancelled || current !== owner) return;
      owner.runtime = createCookieBannerRuntime(msg => {
        if (owner.cancelled || current !== owner) return;
        if (msg.type === 'report') owner.lastReport = msg;
        try { send(msg)?.catch?.(() => {}); } catch { stop(); }
      }, () => send({ type: 'checkCoverage' }));
    }).catch(() => { if (current === owner) stop(); });
  }
  api.runtime.onMessage.addListener(message => {
    if (message?.type !== BACKGROUND_MESSAGE || !message.msg) return;
    if (message.msg.type === 'stop') { stop(); return; }
    Promise.resolve(current?.runtime?.receive(message.msg)).catch(() => stop());
  });
  api.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.cookieBanners?.newValue === 'off') stop();
  });
  // Kept in the isolated world for diagnostics; page JavaScript sees neither.
  window.autoconsentReceiveMessage = message => current?.runtime?.receive(message);
  window.__webbrainAutoconsentBridge = {
    resync() {
      if (current?.cancelled || current?.runtime?.stopped) start();
      else if (current?.lastReport) {
        try { send(current.lastReport)?.catch?.(() => {}); } catch { stop(); }
      }
    },
  };
  start();
})();
