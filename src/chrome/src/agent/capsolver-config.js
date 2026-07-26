// CapSolver account keys currently use the CAP- prefix shown in Settings.
// Keep this check intentionally structural: account validity and balance are
// verified by the CapSolver API, while this prevents empty or obviously
// malformed values from enabling paid CAPTCHA solving.
export const CAPSOLVER_API_KEY_PATTERN = /^CAP-[A-Za-z0-9_-]{20,}$/;

export function normalizeCapsolverApiKey(value) {
  return typeof value === 'string' ? value.trim() : '';
}

export function isValidCapsolverApiKey(value) {
  return CAPSOLVER_API_KEY_PATTERN.test(normalizeCapsolverApiKey(value));
}

export function isCapsolverEnabled(apiKey, enabled) {
  return enabled === true && isValidCapsolverApiKey(apiKey);
}
