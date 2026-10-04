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
    const typeLabels = { recaptcha_v2: 'reCAPTCHA v2', recaptcha_v2_enterprise: 'reCAPTCHA v2 Enterprise',
      recaptcha_v3: 'reCAPTCHA v3', recaptcha_v3_enterprise: 'reCAPTCHA v3 Enterprise',
      turnstile: 'Cloudflare Turnstile', image_to_text: t('st.captcha.image_type'), hcaptcha: 'hCaptcha', ...{"geetest": "GeeTest v3/v4", "mtcaptcha": "MTCaptcha", "aws_waf": "Amazon WAF", "botdeflector": "BotDeflector", "cloudflare_challenge": "Cloudflare Challenge", "cloudflare_waiting_room": "Cloudflare Waiting Room", "datadome": "DataDome", "aws_recognition": "AWS recognition", "recaptcha_recognition": "reCAPTCHA recognition", "vision_engine": "VisionEngine", "alibaba": "Alibaba", "altcha": "Altcha", "cybersiara": "CyberSiARA", "funcaptcha": "FunCaptcha", "atb": "atbCAPTCHA", "audio": "Audio", "basilisk": "Basilisk / FaucetPay", "binance": "Binance", "bounding_box": "Bounding box", "captchafox": "CaptchaFox", "capy": "Capy", "coordinates": "Coordinates", "cutcaptcha": "CutCaptcha", "drag_and_drop": "Drag and drop", "draw_around": "Draw around", "friendly": "Friendly Captcha", "funcaptcha_recognition": "FunCaptcha recognition", "grid": "Grid", "hunt": "Hunt", "imperva": "Imperva / Incapsula", "keycaptcha": "KeyCaptcha", "lemin": "Lemin", "prosopo": "Prosopo", "rotate": "Rotation", "temu_recognition": "Temu recognition", "tencent": "Tencent / TenDI", "text_captcha": "Text questions", "tspd": "TSPD", "vk": "VK Captcha", "vk_recognition": "VK recognition", "yandex": "Yandex SmartCaptcha", "yandex_recognition": "Yandex recognition", "yidun": "Yidun", "antigate": "AntiGate", "complex_image": "ComplexImage (audio, coordinates, grid, rotation, text)", "funcaptcha_match": "FunCaptcha Match", "geetest_recognition": "GeeTest recognition", "hcaptcha_recognition": "hCaptcha recognition", "lemin_recognition": "Lemin recognition"} };
    const coverage = document.getElementById(`${id}-coverage`);
    if (coverage) coverage.textContent = provider.nativeTypes.map(type => typeLabels[type] || type).join(', ');
    const docs = document.getElementById(`${id}-docs`);
    if (docs) docs.href = provider.docs;
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
      show('fail', provider.id === 'capsolver' ? t('st.captcha.need_key') : t(['nopecha', 'nonecap'].includes(provider.id) ? 'st.captcha.hcaptcha_need_key' : 'st.captcha.provider_need_key', { provider: provider.name }));
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
        show('ok', response.unit === 'credits'
          ? t('st.captcha.credits_ok', { balance: Number(response.balance).toLocaleString() })
          : t('st.captcha.balance_ok', { balance: `$${Number(response.balance).toFixed(4)}` }));
      } catch (error) { show('fail', t('st.captcha.balance_fail', { error: error.message })); }
    }));
  }
}
