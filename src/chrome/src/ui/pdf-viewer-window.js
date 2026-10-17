/**
 * Keeps the window id the PDF viewer reports with a selection current.
 *
 * The background uses it to tell whether WebBrain's side panel is already showing in
 * the viewer's window (re-opening an open panel closes it). A viewer tab can be
 * dragged into another window after it started, so the id is read again whenever the
 * tab is attached somewhere, the window gains focus, and at the start of each pointer
 * gesture, which is always ahead of the selection it would be sent with.
 */
export function trackViewerWindow({ api, target, fields }) {
  let latest = 0;

  async function refresh() {
    const request = ++latest;
    try {
      const id = (await api.windows?.getCurrent?.())?.id;
      // A slower, older lookup must not overwrite a newer answer.
      if (request === latest && Number.isInteger(id)) fields.windowId = id;
    } catch { /* keep the last id we confirmed */ }
  }

  api.tabs?.onAttached?.addListener?.(refresh);
  target.addEventListener('focus', refresh);
  target.addEventListener('pointerdown', refresh, true);
  return { refresh };
}
