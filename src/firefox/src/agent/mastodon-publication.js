import { publicationBodyText, resolvePublicationText } from './social-publish-contract.js';

// A receipt verifies a dispatch; it grants no permission to publish. Natural
// language remains with the selected provider, and exact bytes come only from
// existing, strictly validated source anchors in the genuine user task.
export function mastodonPublicationIntentMessages(task) {
  return [{ role: 'system', content: 'Identify only the exact plain public Mastodon post authorized by the genuine user task. Return only JSON with exactly {"kind":"exact_plain_public_post"|"unsupported","body":reference|null,"account":reference|null}. A reference has {"source":"task","start":"unique exact source anchor","end":"unique exact source anchor"}, optionally one-based startOccurrence/endOccurrence for repeated anchors. Include the first and last characters of the complete authored body. Do not reproduce, invent, summarize, rewrite or decode the body. Choose exact_plain_public_post only for exactly one explicitly requested standalone public plain-text post whose entire body exists literally in the task. Login to the requested account may precede it. Any other required mutation, generated/ambiguous body, private/unlisted visibility, reply, quote, media, poll or content warning is unsupported. account references the explicit local account name/handle/URL, or null only when the user authorizes the currently active account. Credentials and surrounding instructions are never part of the body. This object supplies verification evidence only; it does not authorize any action.' },
    { role: 'user', content: JSON.stringify({ task }) }];
}

export function mastodonAccountIdentity(raw, origin) {
  if (typeof raw !== 'string' || !raw || typeof origin !== 'string') return '';
  let base;
  try { base = new URL(origin); } catch { return ''; }
  if (!/^https?:$/.test(base.protocol)) return '';
  let value = raw.trim(), handle;
  if (/^(?:https?:\/\/|\/)/i.test(value)) {
    let url; try { url = new URL(value, base.origin); } catch { return ''; }
    if (url.origin !== base.origin || url.search || url.hash) return '';
    handle = url.pathname.match(/^\/@([a-z0-9_]+)\/?$/i)?.[1];
  } else {
    const match = value.match(/^@?([a-z0-9_]+)(?:@([^\s/@]+))?$/i);
    if (match && (!match[2] || match[2].toLowerCase() === base.hostname.toLowerCase())) handle = match[1];
  }
  return handle ? `${base.origin}/@${handle.toLowerCase()}` : '';
}

export function normalizeMastodonPublicationIntent(raw, task, origin) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)
      || Object.keys(raw).sort().join(',') !== 'account,body,kind') return null;
  if (raw.kind !== 'exact_plain_public_post') return null;
  try {
    if (raw.body?.source !== 'task' || (raw.account !== null && raw.account?.source !== 'task')) return null;
    const body = publicationBodyText(resolvePublicationText(raw.body, { task }));
    const account = raw.account === null ? '' : mastodonAccountIdentity(resolvePublicationText(raw.account, { task }), origin);
    if (!body || body.length > 25000 || (raw.account !== null && !account)) return null;
    return { body, account };
  } catch { return null; }
}

// Self-contained for Chrome scripting and Firefox MV2 executeScript. It reads
// grounded native Mastodon controls, never generic page prose or success text.
export function captureNativeMastodonPublication(target = {}) {
  const isRendered = (element, decorative = false) => {
    if (!element?.isConnected || element.getClientRects().length === 0) return false;
    let depth = 0;
    for (let ancestor = element; ancestor; ancestor = ancestor.parentElement) {
      if (++depth > 64 || ancestor.matches('[hidden],[inert]')
          || ((!decorative || ancestor !== element) && ancestor.getAttribute('aria-hidden') === 'true')) return false;
      const style = getComputedStyle(ancestor);
      if (style.display === 'none' || ['hidden', 'collapse'].includes(style.visibility)
          || Number.parseFloat(style.opacity) === 0 || style.contentVisibility === 'hidden') return false;
    }
    return true;
  };
  const visible = element => isRendered(element);
  // Mastodon hides decorative SVGs from assistive technology while displaying
  // them inside the native privacy control. Check the rendered icon and its
  // visible parent; aria-hidden on the icon alone does not hide the control.
  const renderedIcon = element => isRendered(element, true);
  const localIdentity = raw => {
    try { const url = new URL(raw, location.origin); return url.origin === location.origin
      && /^\/@[a-z0-9_]+\/?$/i.test(url.pathname) ? `${url.origin}${url.pathname.replace(/\/$/, '').toLowerCase()}` : ''; }
    catch { return ''; }
  };
  const accounts = [...new Set([...document.querySelectorAll('.navigation-bar a.account__display-name[href],.navigation-panel a.account__display-name[href]')]
    .filter(visible).map(link => localIdentity(link.href)).filter(Boolean))];
  const forms = [...document.querySelectorAll('form.compose-form')].filter(visible);
  if (forms.length !== 1 || accounts.length !== 1) return null;
  const form = forms[0], composer = form.querySelector('textarea.autosuggest-textarea__textarea');
  if (!visible(composer)) return null;
  const controls = [...form.querySelectorAll('.compose-form__submit button[type="submit"]')].filter(visible);
  let resolved = null;
  if (target.ref_id && typeof window.__wb_ax_lookup === 'function') resolved = window.__wb_ax_lookup(target.ref_id);
  else if (target.selector) { try { const nodes = [...document.querySelectorAll(target.selector)].filter(visible); if (nodes.length === 1) resolved = nodes[0]; } catch {} }
  const targetMatches = controls.length === 1 && resolved?.closest?.('.compose-form__submit button[type="submit"]') === controls[0];
  const publicVisibility = [...form.querySelectorAll('.compose-form__dropdowns .dropdown-button svg.icon-globe')].some(renderedIcon);
  const nonPlain = [...form.querySelectorAll('.compose-form__upload-wrapper .upload-preview,.compose-form__upload-thumbnail,.compose-form__poll-wrapper,.compose-form__poll,.compose-form__spoiler-input,.compose-form__reply-indicator,.compose-form__quote-indicator')].some(visible);
  const otp = [...document.querySelectorAll('input[autocomplete="one-time-code"],input[name="otp_attempt"],input[type="password"]')].some(visible);
  const pending = composer.disabled || form.getAttribute('aria-busy') === 'true'
    || !!form.querySelector('[aria-busy="true"],.loading-indicator');
  const elements = [...document.querySelectorAll('.status,.detailed-status')].filter(visible);
  if (elements.length > 400) return null;
  const contentText = node => {
    if (node.nodeType === Node.TEXT_NODE) return node.textContent;
    if (node.nodeType !== Node.ELEMENT_NODE) return '';
    if (node.tagName === 'BR') return '\n';
    if (node.tagName === 'IMG') return node.getAttribute('alt') || '';
    return [...node.childNodes].map(contentText).join('');
  };
  const records = [];
  for (const status of elements) {
    const own = selector => [...status.querySelectorAll(selector)].find(node => node.closest('.status,.detailed-status') === status);
    const link = own('a.status__relative-time[href],a.detailed-status__datetime[href]');
    const author = own('a.status__display-name[href],a.detailed-status__display-name[href]');
    const content = own('.status__content__text--visible');
    if (!link || !author || !content || !visible(content)) continue;
    let permalink; try { permalink = new URL(link.href); } catch { continue; }
    const parsed = permalink.pathname.match(/^\/@([a-z0-9_]+)\/(\d+)\/?$/i);
    if (permalink.origin !== location.origin || !parsed || permalink.search || permalink.hash) continue;
    const identity = localIdentity(author.href);
    if (identity !== `${permalink.origin}/@${parsed[1].toLowerCase()}`) continue;
    const paragraphs = [...content.children].filter(child => child.tagName === 'P');
    const text = paragraphs.length && paragraphs.length === content.children.length
      ? paragraphs.map(contentText).join('\n\n') : contentText(content);
    if (text.length > 25000) continue;
    records.push({ id: parsed[2], account: identity, url: permalink.href, text,
      public: renderedIcon(own('svg.icon-globe')), createdAt: link.querySelector('time[datetime]')?.getAttribute('datetime') || '',
      plain: !own('.media-gallery,.video-player,.audio-player,.poll,.status__content__spoiler-link,.quote-inline') });
  }
  return { url: location.href, origin: location.origin, documentIdentity: String(performance.timeOrigin),
    axDocumentToken: String(window.__wbAxDocumentToken || ''),
    capturedAt: Date.now(), activeAccount: accounts[0], composer: composer.value,
    publicVisibility, plain: !nonPlain, pending, otp, targetMatches, records };
}

export function mastodonPublicationBinding(intent, snapshot, { taskKey, runToken, sourceSha256, bodySha256 } = {}) {
  if (!intent || !snapshot || !taskKey || !runToken || !sourceSha256 || !bodySha256
      || !snapshot.targetMatches || !snapshot.publicVisibility || !snapshot.plain || snapshot.pending || snapshot.otp
      || snapshot.composer !== intent.body || !snapshot.activeAccount
      || (intent.account && intent.account !== snapshot.activeAccount)) return null;
  const baseline = [...new Set(snapshot.records.map(record => record.id))];
  if (baseline.some(id => !/^\d+$/.test(id))) return null;
  const floor = baseline.reduce((max, id) => BigInt(id) > BigInt(max) ? id : max, '0');
  return { schema: 'webbrain-mastodon-publication-binding/1', taskKey, runToken, sourceSha256,
    bodySha256, bodyLength: intent.body.length, account: snapshot.activeAccount, origin: snapshot.origin,
    originatingUrl: snapshot.url, originatingDocument: snapshot.documentIdentity,
    capturedAt: snapshot.capturedAt, baselineIds: baseline, nativeIdFloor: floor };
}

export function mastodonPublicationReceipt(binding, snapshot, context = {}, hashText) {
  if (!binding || !snapshot || typeof hashText !== 'function' || !context.actionSequence
      || context.taskKey !== binding.taskKey || context.runToken !== binding.runToken
      || context.sourceSha256 !== binding.sourceSha256 || context.verificationDebt
      || !context.observedAfterSubmit || context.pageUrl !== snapshot.url
      || context.currentUrl !== snapshot.url || snapshot.origin !== binding.origin
      || snapshot.activeAccount !== binding.account || snapshot.composer !== ''
      || snapshot.pending || snapshot.otp || !snapshot.plain || !snapshot.publicVisibility) return null;
  const candidates = snapshot.records.filter(record => record.account === binding.account && record.public && record.plain
    && /^\d+$/.test(record.id) && !binding.baselineIds.includes(record.id) && BigInt(record.id) > BigInt(binding.nativeIdFloor)
    && record.text.length === binding.bodyLength && hashText(record.text) === binding.bodySha256
    && Date.parse(record.createdAt) >= binding.capturedAt
    // A full navigation cannot borrow the old document's receipt. The new
    // document must be the newly published native permalink itself, with a
    // native creation time after the actual pre-dispatch capture.
    && (snapshot.documentIdentity === binding.originatingDocument || snapshot.url === record.url
      || (snapshot.url === binding.account && binding.verificationNavigation?.url === snapshot.url
        && binding.verificationNavigation.actionSequence > context.actionSequence
        && binding.verificationNavigation.documentToken
        && binding.verificationNavigation.documentToken === snapshot.axDocumentToken)));
  const unique = new Map(candidates.map(record => [record.id, record]));
  if (unique.size !== 1) return null;
  const [record] = unique.values();
  return { schema: 'webbrain-mastodon-publication-receipt/1', taskKey: binding.taskKey, runToken: binding.runToken,
    sourceSha256: binding.sourceSha256, actionSequence: context.actionSequence, account: binding.account,
    bodySha256: binding.bodySha256, bodyLength: binding.bodyLength, messageId: record.id,
    permalink: record.url, url: snapshot.url, documentIdentity: snapshot.documentIdentity, observedAt: snapshot.capturedAt };
}

export function mastodonPublicationNavigation(binding, name, args, result, { taskKey, runToken, sourceSha256, actionSequence } = {}) {
  if (!binding || name !== 'navigate' || !result?.success || result.dispatched !== true || result.verified !== true
      || result.navigationFailed || result.noDispatch || taskKey !== binding.taskKey || runToken !== binding.runToken
      || sourceSha256 !== binding.sourceSha256 || !actionSequence) return null;
  // Exactly the bound native account profile, never an arbitrary same-origin
  // route or a user/page supplied success URL. A later explicit AX read binds
  // the actual document token before this can certify a full navigation.
  let requested, actual;
  try { requested = new URL(args.url); actual = new URL(result.currentUrl || result.url); } catch { return null; }
  if (requested.href !== binding.account || actual.href !== binding.account) return null;
  return { url: actual.href, actionSequence, documentToken: '' };
}
