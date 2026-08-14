import { t } from './i18n.js';

(async () => {
  const status = document.getElementById('status');
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach(track => track.stop());
    status.textContent = t('mic.granted');
    status.className = 'success';
    await chrome.runtime.sendMessage({ type: 'mic-permission-granted' });
    window.close();
  } catch {
    status.textContent = t('mic.denied');
    status.className = 'error';
    await chrome.runtime.sendMessage({ type: 'mic-permission-denied' });
  }
})();
