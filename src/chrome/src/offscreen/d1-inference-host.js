import { dispatchD1Worker, resetD1Worker } from '../providers/d1-host.js';

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== 'd1-offscreen') return;
  if (sender.id !== chrome.runtime.id || sender.tab || !String(sender.url || '').startsWith(chrome.runtime.getURL(''))) { sendResponse({ ok: false, error: 'D1 accepts extension-owned requests only.' }); return; }
  if (message.command === 'reset') { resetD1Worker(); sendResponse({ ok: true, result: { reset: true } }); return; }
  dispatchD1Worker(message.command, message.payload, message.timeoutMs).then(result => sendResponse({ ok: true, result }), error => sendResponse({ ok: false, error: error.message }));
  return true;
});
