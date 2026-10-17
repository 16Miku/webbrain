import { rawStorage } from 'lib/storage-namespace';

// WebBrain locale code -> Mue locale code. Mue ships no Filipino, Hebrew,
// Hindi, Korean, Malay, Polish or Thai UI strings; those fall back to English
// for Mue's own settings screens (the WebBrain-specific strings in
// lib/wb-strings.js are translated for every WebBrain locale).
const WB_TO_MUE = {
  en: 'en_GB',
  zh: 'zh_CN',
  ar: 'ar',
  bn: 'bn',
  nl: 'nl',
  fr: 'fr',
  de: 'de_DE',
  id: 'id_ID',
  ja: 'ja',
  fa: 'fa',
  pt: 'pt_BR',
  ru: 'ru',
  es: 'es',
  tr: 'tr_TR',
  uk: 'uk',
  vi: 'vi',
};

/** The WebBrain UI language (same source of truth as the side panel). */
export function resolveWebBrainLocale() {
  let saved;
  try {
    saved = String(rawStorage?.getItem('wbLocale') || '').trim();
  } catch {
    saved = '';
  }
  if (saved) return saved;
  return String(globalThis.navigator?.language || 'en').slice(0, 2).toLowerCase();
}

const RTL = new Set(['ar', 'fa', 'he', 'ur']);

/**
 * What the document should announce. The WebBrain-specific strings are translated for every
 * WebBrain locale, so the page language is the WebBrain one even where Mue's own screens fall
 * back to English; only the translation lookup uses the Mue fallback.
 */
export function resolveDocumentLanguage() {
  const code = resolveWebBrainLocale();
  const lang = String(code || 'en').replace('_', '-');
  return { lang, dir: RTL.has(lang.slice(0, 2).toLowerCase()) ? 'rtl' : 'ltr' };
}

export function resolveMueLanguage() {
  return WB_TO_MUE[resolveWebBrainLocale()] || 'en_GB';
}
