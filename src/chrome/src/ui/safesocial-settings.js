import { t } from './i18n.js';
import { LABELS, SETTINGS_KEY, normalizeSettings } from '../safesocial/config.js';

const api = globalThis.browser || chrome;
const card = document.getElementById('safesocial-card');
const toggle = card.querySelector('#safesocial-enabled');
const action = card.querySelector('#safesocial-action');
const threshold = card.querySelector('#safesocial-threshold');
const thresholdValue = card.querySelector('output');
const status = card.querySelector('#safesocial-status');
const retry = card.querySelector('#safesocial-retry');
const remove = card.querySelector('#safesocial-remove');
let settings = normalizeSettings();
let requestEpoch = 0;
let polling;
const labels = card.querySelector('#safesocial-labels');
for (const name of LABELS) {
  const label = document.createElement('label');
  label.className = 'safesocial-label';
  const input = document.createElement('input');
  input.type = 'checkbox'; input.name = name;
  const text = document.createElement('span');
  text.dataset.i18n = `st.safesocial.label.${name}`;
  text.textContent = t(text.dataset.i18n);
  label.append(input, text); labels.append(label);
}
const send = command => api.runtime.sendMessage({ target: 'safesocial', command });
function render() {
  toggle.checked = settings.enabled;
  action.value = settings.action;
  threshold.value = Math.round(settings.threshold * 100);
  thresholdValue.textContent = `${threshold.value}%`;
  for (const input of labels.querySelectorAll('input')) input.checked = settings.labels[input.name];
  remove.disabled = settings.enabled;
  retry.hidden = !settings.enabled;
}
function showState(value) {
  if (!settings.enabled) { status.textContent = t('st.safesocial.disabled'); return; }
  const name = ['downloading', 'loading', 'ready', 'error'].includes(value?.status) ? value.status : 'idle';
  status.textContent = t(`st.safesocial.${name}`, { progress: value?.progress || 0 });
}
async function poll() {
  const epoch = requestEpoch;
  try { const result = await send('status'); if (epoch === requestEpoch) showState(result); } catch { /* retry reports failures */ }
}
async function prepare() {
  const epoch = ++requestEpoch;
  clearInterval(polling);
  if (!settings.enabled) { showState(); return; }
  showState({ status: 'loading' });
  polling = setInterval(poll, 1000);
  try {
    const result = await send('prepare');
    if (epoch !== requestEpoch) return;
    if (!result?.ok) throw new Error(result?.error || t('st.safesocial.error'));
    showState({ status: 'ready' });
  } catch (error) {
    if (epoch === requestEpoch) status.textContent = `${t('st.safesocial.error')} ${error.message}`;
  } finally {
    if (epoch === requestEpoch) clearInterval(polling);
  }
}
let saveQueue = Promise.resolve();
function save() {
  const next = normalizeSettings({
    enabled: toggle.checked, action: action.value, threshold: Number(threshold.value) / 100,
    labels: Object.fromEntries([...labels.querySelectorAll('input')].map(input => [input.name, input.checked])),
  });
  saveQueue = saveQueue.catch(() => {}).then(() => api.storage.local.set({ [SETTINGS_KEY]: next }))
    .catch(error => { status.textContent = error.message; });
}
for (const input of [toggle, action, threshold, ...labels.querySelectorAll('input')]) input.addEventListener('change', save);
threshold.addEventListener('input', () => { thresholdValue.textContent = `${threshold.value}%`; });
retry.addEventListener('click', prepare);
remove.addEventListener('click', async () => {
  remove.disabled = true;
  try {
    const result = await send('remove');
    status.textContent = result?.ok ? t('st.safesocial.removed') : t('st.safesocial.error');
  } catch { status.textContent = t('st.safesocial.error'); }
  finally { remove.disabled = settings.enabled; }
});
let changed = false;
api.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes[SETTINGS_KEY]) return;
  changed = true;
  settings = normalizeSettings(changes[SETTINGS_KEY].newValue);
  render(); void prepare();
});
api.storage.local.get(SETTINGS_KEY).then(stored => {
  if (changed) return;
  settings = normalizeSettings(stored[SETTINGS_KEY]); render();
  // Opening settings is read-only. A prior opt-in can load on the next image.
  if (settings.enabled) void poll(); else showState();
}).catch(error => { status.textContent = error.message; });
addEventListener('pagehide', () => { requestEpoch++; clearInterval(polling); });
