/**
 * Which WebBrain side panels are on screen, per browser window.
 *
 * Running `sidePanel.setOptions()` + `sidePanel.open()` on a panel that is already
 * open makes Chrome tear it down again, so a request that arrives while the panel is
 * showing (a follow-up typed in a page card, a right-click action) must not repeat
 * them. The background cannot ask the panel first: `sidePanel.open()` has to run
 * before the first await of the handler that received the user's gesture. So each
 * panel keeps a port to the background and says whether it is visible, and the
 * background reads that answer synchronously.
 */

export const SIDEPANEL_PRESENCE_PORT = 'wb-sidepanel-presence';

const RECONNECT_BASE_MS = 500;
const RECONNECT_MAX_MS = 30_000;
// A port that closes this soon after it opened was refused, not outlived.
const QUICK_CLOSE_MS = 1_000;

/** Background side: accepts presence ports from the side panel page only. */
export function createSidePanelPresence(api) {
  const panelUrl = api.runtime.getURL('src/ui/sidepanel.html');
  const visibleWindowByPort = new Map();

  function fromSidePanel(port) {
    return port?.name === SIDEPANEL_PRESENCE_PORT
      && port.sender?.id === api.runtime.id
      && String(port.sender?.url || '').split(/[?#]/)[0] === panelUrl;
  }

  function attach(port) {
    if (!fromSidePanel(port)) return false;
    port.onMessage.addListener((message) => {
      if (message?.visible === true && Number.isInteger(message.windowId)) {
        visibleWindowByPort.set(port, message.windowId);
      } else {
        visibleWindowByPort.delete(port);
      }
    });
    port.onDisconnect.addListener(() => {
      visibleWindowByPort.delete(port);
    });
    return true;
  }

  function isVisibleInWindow(windowId) {
    if (!Number.isInteger(windowId)) return false;
    for (const visibleWindowId of visibleWindowByPort.values()) {
      if (visibleWindowId === windowId) return true;
    }
    return false;
  }

  return { attach, isVisibleInWindow };
}

/**
 * Side panel side: keeps a port open and reports whether this page is visible.
 * The port is reopened when the background worker restarts, which drops it.
 */
export function reportSidePanelPresence({
  runtime,
  doc,
  windowId,
  schedule = (callback, delay) => setTimeout(callback, delay),
  now = () => Date.now(),
}) {
  if (!Number.isInteger(windowId)) return { stop() {} };
  let port = null;
  let stopped = false;
  let quickCloses = 0;

  const report = () => {
    try {
      port?.postMessage({ visible: doc.visibilityState === 'visible', windowId });
    } catch { /* the port closed under us; its disconnect handler reconnects */ }
  };

  const connect = () => {
    if (stopped) return;
    let next;
    try {
      next = runtime.connect({ name: SIDEPANEL_PRESENCE_PORT });
    } catch {
      stopped = true; // the extension was reloaded or removed; this page is stale
      return;
    }
    const openedAt = now();
    port = next;
    next.onDisconnect.addListener(() => {
      void runtime.lastError;
      if (port === next) port = null;
      quickCloses = now() - openedAt < QUICK_CLOSE_MS ? quickCloses + 1 : 0;
      const delay = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** quickCloses);
      schedule(connect, delay);
    });
    report();
  };

  doc.addEventListener('visibilitychange', report);
  connect();
  return {
    stop() {
      stopped = true;
      doc.removeEventListener('visibilitychange', report);
      try { port?.disconnect(); } catch { /* already closed */ }
      port = null;
    },
  };
}
