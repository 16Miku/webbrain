import { CAPTCHA_PROVIDERS, CAPTCHA_SETTINGS_KEYS, isValidCaptchaApiKey, normalizeCaptchaWeight } from '../agent/captcha-provider-config.js';

export async function initCaptchaSettings(storage, sendToBackground, t) {
  const stored = await storage.get(CAPTCHA_SETTINGS_KEYS);
  const managed = stored.webbrainCloudManaged === true;
  const card = document.getElementById('captcha-card');
  if (!card) return;
  card.hidden = managed;
  if (managed) return;
  for (const provider of CAPTCHA_PROVIDERS) {
    const id = provider.domId;
    const keyInput = document.getElementById(`${id}-api-key`);
    const enabled = document.getElementById(`${id}-enabled`);
    const weight = document.getElementById(`${id}-weight`);
    const result = document.getElementById(`test-${id}`);
    if (!keyInput || !enabled || !weight || !result) continue;
    keyInput.value = stored[provider.key] || '';
    enabled.checked = stored[provider.enabled] === true;
    weight.value = normalizeCaptchaWeight(stored[provider.weight], provider.defaultWeight);
    let manuallyDisabled = false;
    let messageTimer;
    const show = (status, message) => {
      clearTimeout(messageTimer);
      result.className = `test-result show ${status}`;
      result.textContent = message;
      result.style.color = '';
      messageTimer = setTimeout(() => result.classList.remove('show'), 5000);
    };
    const validKey = () => {
      const key = keyInput.value.trim();
      if (isValidCaptchaApiKey(provider.id, key)) return key;
      show('fail', provider.id === 'capsolver' ? t('st.captcha.need_key') : t('st.captcha.provider_need_key', { provider: provider.name }));
      return null;
    };
    // Typing opts in by default, but an explicit unchecked box wins for this edit.
    keyInput.addEventListener('input', () => {
      if (!manuallyDisabled) enabled.checked = !!keyInput.value.trim();
    });
    const save = async () => {
      const key = validKey();
      if (!key) return;
      keyInput.value = key;
      await storage.set({ [provider.key]: key, [provider.enabled]: enabled.checked });
      show('ok', t(provider.id === 'capsolver' && enabled.checked ? 'st.captcha.saved' : 'st.providers.saved'));
    };
    // Report storage failures, rather than silently showing a successful save.
    const handle = fn => async () => { try { await fn(); } catch (error) { show('fail', error.message); } };
    document.getElementById(`btn-save-${id}`).addEventListener('click', handle(save));
    enabled.addEventListener('change', handle(async () => {
      manuallyDisabled = !enabled.checked;
      if (!enabled.checked) await storage.set({ [provider.enabled]: false });
      else if (isValidCaptchaApiKey(provider.id, keyInput.value)) await save();
      else {
        enabled.checked = false;
        validKey();
      }
    }));
    weight.addEventListener('change', handle(async () => {
      const value = normalizeCaptchaWeight(weight.value === '' ? undefined : Number(weight.value), provider.defaultWeight);
      weight.value = value;
      await storage.set({ [provider.weight]: value });
    }));
    document.getElementById(`btn-clear-${id}`).addEventListener('click', handle(async () => {
      await storage.remove([provider.key, provider.enabled]);
      keyInput.value = '';
      enabled.checked = false;
      manuallyDisabled = false;
      show('ok', t('st.captcha.cleared'));
    }));
    document.getElementById(`btn-test-${id}`).addEventListener('click', handle(async () => {
      const key = validKey();
      if (!key) return;
      show('', t('st.captcha.checking'));
      const action = provider.id === 'capsolver' ? 'test_capsolver_balance'
        : provider.id === '2captcha' ? 'test_two_captcha_balance' : 'test_captcha_provider_balance';
      try {
        const response = await sendToBackground(action, { apiKey: key, provider: provider.id });
        if (!response?.ok) throw new Error(response?.error || 'Unknown error');
        show('ok', t('st.captcha.balance_ok', { balance: `$${Number(response.balance).toFixed(4)}` }));
      } catch (error) { show('fail', t('st.captcha.balance_fail', { error: error.message })); }
    }));
  }
}
