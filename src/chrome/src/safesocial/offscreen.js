import { createSafeSocialHost } from './host.js';
const host = createSafeSocialHost();
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (message?.target !== 'safesocial-host') return false;
  // Content scripts and other extension pages must pass the background gate.
  if (sender.id !== chrome.runtime.id || sender.tab ||
      sender.url !== chrome.runtime.getURL('src/background.js')) return false;
  host.handle(message.command, message).then(
    result => respond({ ok: true, ...result }), error => respond({ ok: false, error: error.message }),
  );
  return true;
});
