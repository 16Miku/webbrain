import { t } from './i18n.js';
import { THEME_MODES, applyMode, loadMode, watch } from './theme.js';

const runtimeApi = globalThis.browser || globalThis.chrome;
let currentThemeMode = 'system';
loadMode().then((mode) => {
  currentThemeMode = mode;
  applyMode(mode, { syncStorage: false });
});
watch(() => currentThemeMode);
runtimeApi?.storage?.onChanged?.addListener?.((changes, area) => {
  if (area !== 'local' || !changes.themeMode) return;
  const next = changes.themeMode.newValue;
  if (THEME_MODES.includes(next)) currentThemeMode = next;
});

const elements = Object.fromEntries([
  'enabled', 'installed-count', 'archive-bytes', 'storage-usage', 'notice',
].map(id => [id, document.getElementById(id)]));
let snapshot = null;
let polling = false;
let processingDownload = false;

function bytes(value) {
  const number = Number(value) || 0;
  if (number < 1024) return `${number} B`;
  const units = ['KiB', 'MiB', 'GiB', 'TiB'];
  let amount = number;
  let unit = -1;
  do { amount /= 1024; unit += 1; } while (amount >= 1024 && unit < units.length - 1);
  return `${amount.toFixed(amount >= 10 ? 1 : 2)} ${units[unit]}`;
}

function notice(message, kind = '') {
  elements.notice.textContent = message || '';
  elements.notice.dataset.kind = kind;
}

async function command(commandName, payload = {}) {
  const response = await runtimeApi.runtime.sendMessage({
    target: 'background', action: 'apocalypse_mode', command: commandName, ...payload,
  });
  if (response?.error) throw new Error(response.error);
  return response;
}

function render() {
  elements.enabled.checked = snapshot?.enabled === true;
  elements['installed-count'].textContent = String(snapshot?.installedCount || 0);
  elements['archive-bytes'].textContent = bytes(snapshot?.totalBytes);
  const usage = snapshot?.storage?.usage;
  elements['storage-usage'].textContent = usage == null ? t('ap.unavailable') : bytes(usage);
  elements['storage-usage'].parentElement.title = `${t('ap.metric.storage')}: ${elements['storage-usage'].textContent}`;
}

async function refresh() {
  snapshot = await command('status');
  render();
}

elements.enabled.addEventListener('change', async () => {
  try {
    snapshot = await command('enable', { enabled: elements.enabled.checked });
    render();
    notice(t(elements.enabled.checked ? 'ap.enabled_notice' : 'ap.disabled_notice'), 'success');
  } catch (error) {
    elements.enabled.checked = !elements.enabled.checked;
    notice(error.message, 'error');
  }
});

document.addEventListener('wb-locale-changed', render);

async function poll() {
  if (polling) return;
  polling = true;
  try {
    if (!processingDownload && (snapshot?.archives || []).some(record => ['queued', 'downloading', 'retrying'].includes(record.status))) {
      processingDownload = true;
      command('process').catch(() => {}).finally(() => { processingDownload = false; });
    }
    await refresh();
  } catch { /* The next poll or persisted alarm retries. */ }
  finally { polling = false; }
}

await refresh().catch(error => notice(error.message, 'error'));
setInterval(poll, 2_000);
