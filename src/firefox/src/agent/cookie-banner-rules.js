// WebBrain's own cookie-banner rules, for banners the vendored autoconsent
// rules do not cover. They use autoconsent's JSON rule format (upstream
// docs/rule-syntax.md) and reach the content script next to the bundled rules,
// so autoconsent runs them exactly as it runs its own. This file is WebBrain's
// own code, under WebBrain's license; nothing in it is copied from autoconsent.
//
// Rules here must stay DOM-only: no `eval` steps. The host runs page-world
// code only for autoconsent's own named snippets.
//
// When an autoconsent update starts covering one of these sites, delete our
// rule. A selector array is a chain: each later selector is searched inside the
// shadow root (or iframe document) of the elements the earlier one found.

// Efilli (efilli.com) is a Turkish consent platform. It renders its banner in
// the open shadow root of an <efilli-layout-dynamic> element, which page-level
// selectors cannot see. Each site designs its own layout from Efilli's
// templates and usually keeps the template's component names: "Reject Button"
// in the English one (n11.com, migros.com.tr, turkcell.com.tr), "reddet" in the
// Turkish one (teknosa.com, koton.com). Layouts that renamed it (flypgs.com puts
// a "Reddet" link inside the text) are found by the button's Turkish text
// instead. A layout can hold the same button twice, once in a collapsed banner
// that is hidden, so the decline clicks every match; Efilli records the same
// refusal for each.
const EFILLI_HOST = 'efilli-layout-dynamic';
const EFILLI_REJECT = '[data-name="Reject Button"], [data-name="reddet"]';
const EFILLI_ACCEPT = '[data-name="Accept Button"], [data-name="kabul et"]';

// An XPath selector (autoconsent's "xpath/" prefix) where only text tells the
// reject button apart.
const MEDIAMARKT_TR_REJECT = "xpath///button[@form='pwa-consent-layer-form'][normalize-space(.)='Reddet']";

// Turkish banners no rule knows. autoconsent's heuristic does not read Turkish
// cookie wording yet, so this rule does the same job for them in XPath: a
// button whose whole text is a Turkish refusal ("Reddet", "Tümünü reddet",
// "Reddediyorum", ...) inside a short block that talks about cookies the way
// banners do. Delete it once the vendored heuristic reads Turkish. XPath sees
// neither shadow roots (Efilli has its own rules) nor layout, so the cookie
// wording must be specific: "çerez" alone also means snacks.
const TR_UPPER = 'ABCÇDEFGĞHIİJKLMNOÖPQRSŞTUÜVWXYZ';
const TR_LOWER = 'abcçdefgğhıijklmnoöpqrsştuüvwxyz';
// normalize-space() trims only ASCII whitespace, and banners pad buttons with
// no-break spaces (flypgs.com: "\u00a0Reddet\u00a0"), so those become spaces first.
const trLower = expr => `translate(normalize-space(translate(${expr}, '\u00a0', ' ')), '${TR_UPPER}', '${TR_LOWER}')`;
const TR_REJECT_TEXTS = [
  'reddet', 'tümünü reddet', 'hepsini reddet', 'tüm çerezleri reddet', 'çerezleri reddet',
  'isteğe bağlı çerezleri reddet', 'zorunlu olmayan çerezleri reddet', 'reddet ve kapat',
  'reddediyorum', 'kabul etmiyorum',
];
const TR_COOKIE_PHRASES = [
  'çerez politika', 'çerez aydınlatma', 'çerez tercih', 'çerez ayar', 'kullandığımız çerez', 'tanımlama bilgi', 'cookie',
];
const TR_COOKIE_VERBS = [
  'kullanıyor', 'kullanmakta', 'kullanılmakta', 'kullanılıyor', 'kullanılır', 'yararlanıyor', 'faydalanıyor',
];
const anyOf = (text, needles) => needles.map(needle => `contains(${text}, '${needle}')`).join(' or ');
// XPath 1.0 has no "in": look the text up in a |-separated list instead.
const textIsRefusal = text => `contains('|${TR_REJECT_TEXTS.join('|')}|', concat('|', ${text}, '|'))`;
const blockText = trLower('.');
const TR_REJECT = 'xpath///*['
  + "self::button or self::a or @role='button' or contains(@class, 'button') or contains(@class, 'btn')"
  + " or (self::input and (@type='button' or @type='submit'))"
  + `][${textIsRefusal(trLower('.'))} or ${textIsRefusal(trLower('@value'))}]`
  + `[ancestor::*[position() <= 8][string-length(normalize-space(.)) < 3000][${anyOf(blockText, TR_COOKIE_PHRASES)}`
  + ` or (contains(${blockText}, 'çerez') and (${anyOf(blockText, TR_COOKIE_VERBS)}))]]`;

// The text fallback searches from the layout's root <div> (an XPath selector
// in a chain runs inside the element the previous step found): any element
// with no child elements whose whole text is a Turkish refusal.
const EFILLI_REJECT_TEXT = [EFILLI_HOST, 'div', `xpath/.//*[not(*)][${textIsRefusal(trLower('.'))}]`];
const EFILLI_SHOWING = [{
  any: [{ visible: [EFILLI_HOST, EFILLI_REJECT], check: 'any' }, { visible: EFILLI_REJECT_TEXT, check: 'any' }],
}];

const RULES = [
  {
    name: 'Efilli',
    prehideSelectors: [EFILLI_HOST],
    detectCmp: EFILLI_SHOWING,
    detectPopup: EFILLI_SHOWING,
    optIn: [{ waitForThenClick: [EFILLI_HOST, EFILLI_ACCEPT] }],
    optOut: [{
      if: { exists: [EFILLI_HOST, EFILLI_REJECT] },
      then: [{ waitForThenClick: [EFILLI_HOST, EFILLI_REJECT], all: true }],
      else: [{ waitForThenClick: EFILLI_REJECT_TEXT, all: true }],
    }],
  },
  // hepsiburada.com renamed Efilli's components and gave its buttons ids:
  // "Reddet" (reject) is #hb-reject-all, "Kabul Et" (accept) #hb-accept-all.
  {
    name: 'hepsiburada',
    runContext: { main: true, frame: false, urlPattern: '^https?://([a-z0-9-]+\\.)*hepsiburada\\.com(:[0-9]+)?/' },
    prehideSelectors: [EFILLI_HOST],
    detectCmp: [{ visible: [EFILLI_HOST, '#hb-reject-all'], check: 'any' }],
    detectPopup: [{ visible: [EFILLI_HOST, '#hb-reject-all'], check: 'any' }],
    optIn: [{ waitForThenClick: [EFILLI_HOST, '#hb-accept-all'] }],
    optOut: [{ waitForThenClick: [EFILLI_HOST, '#hb-reject-all'] }],
  },
  // mediamarkt.com.tr runs its own consent layer, not the one autoconsent's
  // mediamarkt.de rule knows. Its buttons belong to the form
  // "pwa-consent-layer-form"; only "Kabul et" (accept) has an id, so the
  // reject button is found by its text.
  {
    name: 'mediamarkt.com.tr',
    runContext: { main: true, frame: false, urlPattern: '^https?://([a-z0-9-]+\\.)*mediamarkt\\.com\\.tr(:[0-9]+)?/' },
    prehideSelectors: [],
    detectCmp: [{ visible: MEDIAMARKT_TR_REJECT, check: 'any' }],
    detectPopup: [{ visible: MEDIAMARKT_TR_REJECT, check: 'any' }],
    optIn: [{ waitForThenClick: '#pwa-consent-layer-accept-all-button' }],
    optOut: [{ waitForThenClick: MEDIAMARKT_TR_REJECT }],
  },
  // Named like autoconsent's own heuristic so the agent's note does not name
  // a consent platform it cannot know. A page can hold the refusal twice (a
  // banner and a hidden settings panel), so the decline clicks every match.
  {
    name: 'heuristic-tr',
    prehideSelectors: [],
    detectCmp: [{ visible: TR_REJECT, check: 'any' }],
    detectPopup: [{ visible: TR_REJECT, check: 'any' }],
    optIn: [{ visible: TR_REJECT, check: 'none' }],
    optOut: [{ waitForThenClick: TR_REJECT, all: true }],
  },
];

function deepFreeze(value) {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

export const WEBBRAIN_COOKIE_BANNER_RULES = deepFreeze(RULES);

// The rules to send to one frame, filtered like the bundled ones: the top
// frame gets rules without a URL pattern plus those whose pattern matches;
// a subframe gets only frame rules whose pattern names its URL.
export function cookieBannerRulesFor(url, { mainFrame = true } = {}) {
  const href = String(url || '');
  return WEBBRAIN_COOKIE_BANNER_RULES.filter((rule) => {
    const context = { main: true, frame: false, urlPattern: '', ...(rule.runContext || {}) };
    if (mainFrame ? !context.main : !context.frame) return false;
    if (!context.urlPattern) return mainFrame;
    try {
      return new RegExp(context.urlPattern).test(href);
    } catch {
      return false;
    }
  });
}
