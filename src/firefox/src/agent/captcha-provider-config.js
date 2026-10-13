import { CAPTCHA_CATALOG } from './captcha-catalog.js';
import { normalizeCaptchaType } from './captcha-frame-runtime.js';
import { isValidCapsolverApiKey } from './capsolver-config.js';

// Automatic widget routes remain separate from the complete native catalog.
const STANDARD_TYPES = ['recaptcha_v2', 'recaptcha_v2_enterprise', 'recaptcha_v3', 'recaptcha_v3_enterprise', 'turnstile', 'image_to_text'];
export const CAPTCHA_PROVIDERS = [
  { id: 'capsolver', name: 'CapSolver', key: 'capsolverApiKey', enabled: 'captchaSolverEnabled', weight: 'capsolverWeight', defaultWeight: 100, domId: 'captcha', types: STANDARD_TYPES, docs: 'https://docs.capsolver.com/en/guide/getting-started/' },
  { id: '2captcha', name: '2Captcha', key: 'twoCaptchaApiKey', enabled: 'twoCaptchaEnabled', weight: 'twoCaptchaWeight', defaultWeight: 99, domId: 'two-captcha', types: STANDARD_TYPES, docs: 'https://2captcha.com/api-docs' },
  { id: 'capmonster', name: 'CapMonster Cloud', key: 'capmonsterApiKey', enabled: 'capmonsterEnabled', weight: 'capmonsterWeight', defaultWeight: 98, domId: 'capmonster', types: STANDARD_TYPES, docs: 'https://docs.capmonster.cloud/docs/captchas/' },
  { id: 'solvecaptcha', name: 'SolveCaptcha', key: 'solveCaptchaApiKey', enabled: 'solveCaptchaEnabled', weight: 'solveCaptchaWeight', defaultWeight: 97, domId: 'solve-captcha', types: STANDARD_TYPES, docs: 'https://solvecaptcha.com/captcha-solver-api' },
  { id: 'anti-captcha', name: 'Anti-Captcha', key: 'antiCaptchaApiKey', enabled: 'antiCaptchaEnabled', weight: 'antiCaptchaWeight', defaultWeight: 96, domId: 'anti-captcha', types: STANDARD_TYPES, docs: 'https://anti-captcha.com/apidoc' },
  { id: 'nopecha', name: 'NopeCHA', key: 'nopechaApiKey', enabled: 'nopechaEnabled', weight: 'nopechaWeight', defaultWeight: 95, domId: 'nopecha', types: ["hcaptcha"], docs: 'https://nopecha.com/api-reference/' },
  { id: 'nonecap', name: 'NoneCap', key: 'nonecapApiKey', enabled: 'nonecapEnabled', weight: 'nonecapWeight', defaultWeight: 94, domId: 'nonecap', types: ["hcaptcha"], docs: 'https://nonecap.com/api-reference/' },
].map(provider => ({ ...provider, nativeTypes: [...new Set(CAPTCHA_CATALOG.filter(c => c.provider === provider.id).map(c => c.family))] }));
export const CAPTCHA_SETTINGS_KEYS = [
  ...CAPTCHA_PROVIDERS.flatMap(provider => [provider.key, provider.enabled, provider.weight]),
  'webbrainCloudManaged', 'webbrainCloudCapsolverBrokerEnabled',
];
export function normalizeTwoCaptchaApiKey(value) {
  return typeof value === 'string' ? value.trim() : '';
}
export function isValidTwoCaptchaApiKey(value) {
  return /^[a-f0-9]{32}$/i.test(normalizeTwoCaptchaApiKey(value));
}
export function isValidCaptchaApiKey(id, value) {
  const key = normalizeTwoCaptchaApiKey(value);
  if (id === 'nonecap') return /^nc_live_[A-Za-z0-9_-]{32}$/.test(key);
  // NopeCHA documents an opaque subscription key, not a 32-hex constraint.
  if (id === 'nopecha') return /^[A-Za-z0-9_-]{1,256}$/.test(key);
  return id === 'capsolver' ? isValidCapsolverApiKey(value)
    : CAPTCHA_PROVIDERS.some(provider => provider.id === id) && isValidTwoCaptchaApiKey(value);
}
export function normalizeCaptchaWeight(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

// Managed browsers never use personal keys or fallback settings from storage.
export function getCaptchaProviders(stored = {}) {
  if (stored.webbrainCloudManaged === true) {
    return stored.captchaSolverEnabled === true && stored.webbrainCloudCapsolverBrokerEnabled === true
      ? [{ id: 'capsolver', apiKey: '', useCloudBroker: true }] : [];
  }
  // Stable sorting preserves the default provider order when weights tie.
  return CAPTCHA_PROVIDERS.filter(provider => stored[provider.enabled] === true && isValidCaptchaApiKey(provider.id, stored[provider.key]))
    .map(provider => ({ id: provider.id, apiKey: normalizeTwoCaptchaApiKey(stored[provider.key]),
      weight: normalizeCaptchaWeight(stored[provider.weight], provider.defaultWeight) }))
    .sort((a, b) => b.weight - a.weight);
}

// Capabilities describe this integration, rather than every product a service sells.
export function captchaProviderSupportsType(providerId, type) {
  const normalized = normalizeCaptchaType(type);
  return CAPTCHA_PROVIDERS.find(provider => provider.id === providerId)?.types.includes(normalized) === true;
}
