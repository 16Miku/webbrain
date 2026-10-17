import { resolveDocumentLanguage } from 'lib/locale';
import { WB_STRINGS } from 'lib/wb-strings';

/**
 * Sets <html lang/dir> from the WebBrain locale (not Mue's fallback locale), because the
 * WebBrain-specific controls are translated for every WebBrain locale. An unknown saved locale
 * renders the English strings, so English is announced then.
 */
export function applyDocumentLanguage(root = document.documentElement) {
  const resolved = resolveDocumentLanguage();
  const { lang, dir } = WB_STRINGS[resolved.lang] ? resolved : { lang: 'en', dir: 'ltr' };
  root.lang = lang;
  root.dir = dir;
  return { lang, dir };
}
