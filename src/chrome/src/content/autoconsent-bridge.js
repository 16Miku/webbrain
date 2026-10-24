// Injected by src/agent/cookie-banner-host.js into WebBrain's isolated world,
// right before vendor/autoconsent/autoconsent.playwright.js. That upstream
// script talks only through window.autoconsentSendMessage and
// window.autoconsentReceiveMessage; in an isolated world those globals are
// invisible to the page. Messages are namespaced so autoconsent's generic
// types ('init', 'eval', 'report') never reach WebBrain's other listeners.
(() => {
  const existing = window.__webbrainAutoconsentBridge;
  if (existing) {
    // Injected again after the service worker restarted and lost its record
    // of this frame: tell it where this frame's run already is.
    existing.resync();
    return;
  }
  const api = globalThis.browser || globalThis.chrome;
  const CONTENT_MESSAGE = 'webbrain-autoconsent';
  const BACKGROUND_MESSAGE = 'webbrain-autoconsent-bg';
  let lastReport = null;

  const send = (msg) => {
    try {
      const sent = api.runtime.sendMessage({ type: CONTENT_MESSAGE, msg });
      sent?.catch?.(() => {});
    } catch {
      // The extension was reloaded; this frame's copy is orphaned.
    }
  };

  window.autoconsentSendMessage = async (msg) => {
    if (msg?.type === 'report') lastReport = msg;
    send(msg);
  };

  api.runtime.onMessage.addListener((message) => {
    if (message?.type !== BACKGROUND_MESSAGE || !message.msg) return;
    const receive = window.autoconsentReceiveMessage;
    if (typeof receive !== 'function') return;
    Promise.resolve(receive(message.msg)).catch(() => {});
  });

  window.__webbrainAutoconsentBridge = {
    resync() {
      if (lastReport) send(lastReport);
    },
  };
})();
