(() => {
  const api = globalThis.browser || chrome;
  const KEY = 'safeSocialSettings';
  const SELECTOR = 'article img, main img, article video[poster], main video[poster]';
  const records = new Map();
  const revealed = new WeakMap();
  let enabled = false;
  let epoch = 0;
  let timer;
  let observer;
  let busy = false;
  let rescan = false;
  let strings = { show: 'Show image', filtered: 'SafeSocial', unavailable: 'SafeSocial: classifier unavailable. Open WebBrain settings to retry.' };
  let notice;
  const source = media => media.tagName === 'VIDEO' ? media.poster : media.currentSrc || media.src;

  function clear(media, record) {
    media.classList.remove('wb-safesocial-blur', 'wb-safesocial-hide', 'wb-safesocial-dim');
    record?.overlay?.remove();
  }
  function reset() {
    epoch++;
    clearTimeout(timer);
    observer?.disconnect();
    observer = null;
    for (const [media, record] of records) clear(media, record);
    records.clear();
    notice?.remove(); notice = null;
  }
  function visible(media) {
    const rect = media.getBoundingClientRect();
    return media.isConnected && rect.width >= 140 && rect.height >= 140
      && rect.bottom > 0 && rect.right > 0 && rect.top < innerHeight && rect.left < innerWidth;
  }
  function position(media, record) {
    if (!record.overlay) return;
    const rect = media.getBoundingClientRect();
    record.overlay.hidden = !visible(media);
    record.overlay.style.left = `${(Math.max(0, rect.left) + Math.min(rect.right, innerWidth)) / 2}px`;
    record.overlay.style.top = `${(Math.max(0, rect.top) + Math.min(rect.bottom, innerHeight)) / 2}px`;
  }
  function apply(media, record, result) {
    if (!result.labels?.length || revealed.get(media) === record.url) return;
    if (['blur', 'hide', 'dim'].includes(result.action)) media.classList.add(`wb-safesocial-${result.action}`);
    const overlay = document.createElement('div');
    overlay.className = 'wb-safesocial-overlay';
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = `${strings.filtered} · ${strings.show}`;
    button.addEventListener('click', event => {
      event.preventDefault(); event.stopPropagation();
      revealed.set(media, record.url);
      clear(media, record);
    });
    overlay.append(button);
    document.body.append(overlay);
    record.overlay = overlay;
    position(media, record);
  }
  function showUnavailable() {
    if (notice) return;
    notice = document.createElement('div');
    notice.className = 'wb-safesocial-notice';
    notice.setAttribute('role', 'status');
    notice.textContent = strings.unavailable;
    document.body.append(notice);
  }
  async function scan() {
    if (!enabled || document.hidden) return;
    if (busy) { rescan = true; return; }
    busy = true;
    rescan = false;
    const runEpoch = epoch;
    try {
      for (const [media, record] of records) {
        if (!media.isConnected || source(media) !== record.url) { clear(media, record); records.delete(media); }
        else position(media, record);
      }
      // Work only on visible, sufficiently large images and video posters.
      for (const media of document.querySelectorAll(SELECTOR)) {
        if (!enabled || epoch !== runEpoch || document.hidden) break;
        if (!visible(media)) continue;
        const url = source(media);
        if (!url || revealed.get(media) === url) continue;
        const previous = records.get(media);
        if (previous?.url === url && (!previous.retryAt || previous.retryAt > Date.now())) continue;
        const record = { url };
        records.set(media, record);
        let result;
        try { result = await api.runtime.sendMessage({ target: 'safesocial', command: 'classify', url }); }
        catch { result = { ok: false }; }
        if (!enabled || epoch !== runEpoch || !media.isConnected || source(media) !== url) continue;
        if (result?.ok) {
          notice?.remove(); notice = null;
          apply(media, record, result);
        } else {
          record.retryAt = Date.now() + 30_000;
          if (!result?.disabled) showUnavailable();
        }
      }
    } finally {
      busy = false;
      if (enabled && (rescan || runEpoch !== epoch)) schedule();
    }
  }
  function schedule() {
    if (!enabled) return;
    clearTimeout(timer);
    timer = setTimeout(() => { void scan(); }, 200);
  }
  function configure(value) {
    reset();
    enabled = value?.enabled === true;
    if (!enabled) return;
    observer = new MutationObserver(schedule);
    observer.observe(document.documentElement, {
      childList: true, subtree: true, attributes: true, attributeFilter: ['src', 'srcset', 'poster'],
    });
    schedule();
  }
  api.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes[KEY]) configure(changes[KEY].newValue);
  });
  addEventListener('scroll', () => {
    for (const [media, record] of records) position(media, record);
    schedule();
  }, { passive: true });
  addEventListener('resize', schedule);
  document.addEventListener('load', schedule, true);
  document.addEventListener('visibilitychange', schedule);
  let settingsChanged = false;
  api.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes[KEY]) settingsChanged = true;
  });
  api.storage.local.get([KEY, 'wbLocale']).then(stored => {
    if (stored.wbLocale === 'tr') strings = {
      show: 'Görseli göster', filtered: 'SafeSocial',
      unavailable: 'SafeSocial: sınıflandırıcı kullanılamıyor. WebBrain ayarlarından yeniden deneyin.',
    };
    if (!settingsChanged) configure(stored[KEY]);
  }).catch(() => {});
})();
