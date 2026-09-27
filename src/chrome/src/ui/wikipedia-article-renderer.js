const ALLOWED_ELEMENTS = new Set([
  'ABBR', 'A', 'B', 'BLOCKQUOTE', 'BR', 'CAPTION', 'CITE', 'CODE', 'DD', 'DEL',
  'DETAILS', 'DFN', 'DIV', 'DL', 'DT', 'EM', 'FIGCAPTION', 'FIGURE', 'H1', 'H2',
  'H3', 'H4', 'H5', 'H6', 'HR', 'I', 'INS', 'KBD', 'LI', 'MARK', 'OL', 'P',
  'PRE', 'Q', 'S', 'SAMP', 'SECTION', 'SMALL', 'STRONG', 'SUB', 'SUMMARY', 'SUP',
  'TABLE', 'TBODY', 'TD', 'TFOOT', 'TH', 'THEAD', 'TIME', 'TR', 'U', 'UL', 'VAR',
]);

const MATHML_NAMESPACE = 'http://www.w3.org/1998/Math/MathML';
const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';
const MATHML_ELEMENTS = new Set([
  'ANNOTATION', 'MATH', 'MENCLOSE', 'MERROR', 'MFENCED', 'MFRAC', 'MI', 'MMULTISCRIPTS',
  'MN', 'MO', 'MOVER', 'MPADDED', 'MPHANTOM', 'MPRESCRIPTS', 'MROOT', 'MROW', 'MS',
  'MSPACE', 'MSQRT', 'MSTYLE', 'MSUB', 'MSUBSUP', 'MSUP', 'MTABLE', 'MTD', 'MTEXT',
  'MTR', 'MUNDER', 'MUNDEROVER', 'NONE', 'SEMANTICS',
]);
const SVG_ELEMENTS = new Set([
  'CIRCLE', 'CLIPPATH', 'DEFS', 'DESC', 'ELLIPSE', 'G', 'LINE', 'LINEARGRADIENT',
  'MASK', 'PATH', 'POLYGON', 'POLYLINE', 'RADIALGRADIENT', 'RECT', 'STOP', 'SVG',
  'SYMBOL', 'TEXT', 'TITLE', 'TSPAN', 'USE',
]);
const SVG_DROP_WITH_CONTENT = new Set([
  'ANIMATE', 'ANIMATEMOTION', 'ANIMATETRANSFORM', 'DISCARD', 'FOREIGNOBJECT', 'IMAGE',
  'SCRIPT', 'SET', 'STYLE',
]);

// These elements are discarded with their descendants. Unknown presentation
// elements are otherwise unwrapped so their readable text is retained.
const DROP_WITH_CONTENT = new Set([
  'APPLET', 'AREA', 'ASIDE', 'AUDIO', 'BASE', 'BUTTON', 'CANVAS', 'EMBED', 'FOOTER',
  'FORM', 'FRAME', 'FRAMESET', 'HEAD', 'HEADER', 'IFRAME', 'INPUT', 'LINK', 'MAP',
  'MENU', 'META', 'NAV', 'NOSCRIPT', 'OBJECT', 'OPTION', 'SCRIPT', 'SELECT', 'SOURCE',
  'STYLE', 'TEMPLATE', 'TEXTAREA', 'TRACK', 'VIDEO',
]);

const ARTICLE_ROOT_SELECTORS = [
  '#mw-content-text .mw-parser-output',
  '.mw-parser-output',
  '#mw-content-text',
  'article',
  'main',
  '[role="main"]',
  'body',
];

const NON_ARTICLE_PATH = /(?:^|\/)_assets_\/|\.(?:avif|bmp|css|gif|ico|jpe?g|js|mjs|mp3|mp4|ogg|otf|pdf|png|svg|ttf|webm|webp|woff2?)$/i;
const BLOCKED_IMAGE_PATH = /\.(?:aac|avi|css|flac|html?|js|m4a|m4v|mjs|mov|mp3|mp4|oga|ogg|ogv|opus|pdf|svgz|wav|webm|woff2?)$/i;

function decodeUrlPart(value) {
  try { return decodeURIComponent(value); } catch { return value; }
}

function encodedArticlePath(path) {
  return String(path || '').replace(/^\/+/, '').split('/').map(part => encodeURIComponent(decodeUrlPart(part))).join('/');
}

export function wikipediaFragmentId(value) {
  const decoded = decodeUrlPart(String(value || '').replace(/^#/, '')).normalize('NFKC').trim();
  const safe = decoded.replace(/[^\p{L}\p{N}_.:-]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 120);
  return safe ? `wb-wiki-${safe}` : '';
}

export function classifyWikipediaHref(rawHref, currentArticlePath = '') {
  const value = String(rawHref || '').trim();
  if (!value || value.length > 2_048 || /[\u0000-\u001f\u007f]/.test(value)) return null;

  if (value.startsWith('#')) {
    const fragmentId = wikipediaFragmentId(value);
    return fragmentId ? { kind: 'fragment', fragmentId } : null;
  }

  if (value.startsWith('//') || /^[a-z][a-z\d+.-]*:/i.test(value)) {
    try {
      const external = new URL(value.startsWith('//') ? `https:${value}` : value);
      return external.protocol === 'https:' ? { kind: 'external', href: external.href } : null;
    } catch {
      return null;
    }
  }

  try {
    const current = encodedArticlePath(currentArticlePath);
    const resolved = new URL(value, `https://offline.invalid/${current}`);
    let path = decodeUrlPart(resolved.pathname.replace(/^\/+/, ''));
    if (/^\/wiki\//i.test(value)) path = path.replace(/^wiki\//i, '');
    path = path.replace(/^\/+/, '');
    if (!path || NON_ARTICLE_PATH.test(path)) return null;
    const fragment = decodeUrlPart(resolved.hash.slice(1));
    const currentNormalized = decodeUrlPart(String(currentArticlePath || '').replace(/^\/+/, ''));
    if (path === currentNormalized && fragment) {
      const fragmentId = wikipediaFragmentId(fragment);
      return fragmentId ? { kind: 'fragment', fragmentId } : null;
    }
    return { kind: 'article', path, fragment, fragmentId: wikipediaFragmentId(fragment) };
  } catch {
    return null;
  }
}

export function classifyWikipediaImageSource(rawSource, currentArticlePath = '') {
  const value = String(rawSource || '').trim();
  if (!value || value.length > 2_048 || value.startsWith('#') || value.startsWith('//')
    || /^[a-z][a-z\d+.-]*:/i.test(value) || /[\u0000-\u001f\u007f]/.test(value)) return '';
  try {
    const current = encodedArticlePath(currentArticlePath);
    const resolved = new URL(value, `https://offline.invalid/${current}`);
    const path = decodeUrlPart(resolved.pathname.replace(/^\/+/, ''));
    return path && !BLOCKED_IMAGE_PATH.test(path) ? path : '';
  } catch {
    return '';
  }
}

function semanticRoot(parsed) {
  for (const selector of ARTICLE_ROOT_SELECTORS) {
    const candidate = parsed.querySelector(selector);
    if (candidate) return candidate;
  }
  return parsed.body || parsed.documentElement;
}

function safeIntegerAttribute(source, name, minimum, maximum) {
  const value = Number.parseInt(source.getAttribute(name), 10);
  return Number.isInteger(value) && value >= minimum && value <= maximum ? String(value) : '';
}

function appendSanitizedChildren(source, target, context) {
  for (const child of source.childNodes) {
    const sanitized = sanitizeNode(child, context);
    if (sanitized) target.append(sanitized);
    if (context.exhausted) break;
  }
}

function copySharedAttributes(source, target) {
  const language = String(source.getAttribute('lang') || '').trim();
  if (/^[a-z]{2,8}(?:-[a-z\d]{1,8})*$/i.test(language)) target.setAttribute('lang', language);
  const direction = String(source.getAttribute('dir') || '').toLowerCase();
  if (['auto', 'ltr', 'rtl'].includes(direction)) target.setAttribute('dir', direction);
  const sourceId = source.getAttribute('id') || source.getAttribute('name');
  const id = wikipediaFragmentId(sourceId);
  if (id) target.id = id;
}

function safeLength(value, { allowPercent = true, maximum = 16_384 } = {}) {
  const match = String(value || '').trim().match(/^([+-]?(?:\d+(?:\.\d*)?|\.\d+))(px|em|ex|rem|%)?$/i);
  if (!match) return '';
  const number = Number(match[1]);
  if (!Number.isFinite(number) || Math.abs(number) > maximum || (!allowPercent && match[2] === '%')) return '';
  return `${number}${match[2] || ''}`;
}

function safeSvgId(value) {
  const safe = String(value || '').normalize('NFKC').replace(/[^a-z\d_.:-]+/gi, '-').replace(/^-+|-+$/g, '').slice(0, 100);
  return safe ? `wb-svg-${safe}` : '';
}

function safeSvgFragmentReference(value) {
  const raw = String(value || '').trim();
  if (!raw.startsWith('#')) return '';
  const id = safeSvgId(raw.slice(1));
  return id ? `#${id}` : '';
}

function safeSvgPaint(value) {
  const raw = String(value || '').trim();
  if (!raw || raw.length > 128) return '';
  const fragment = raw.match(/^url\(\s*(['"]?)(#[^)\s'"]+)\1\s*\)$/i);
  if (fragment) {
    const reference = safeSvgFragmentReference(fragment[2]);
    return reference ? `url(${reference})` : '';
  }
  return /^(?:none|currentcolor|transparent|#[0-9a-f]{3,8}|[a-z]{3,24}|(?:rgb|hsl)a?\([0-9.,%+\-\s]+\))$/i.test(raw)
    ? raw
    : '';
}

function safeSvgNumberList(value, maximumLength = 2_000) {
  const raw = String(value || '').trim();
  return raw.length <= maximumLength && /^[0-9eE.,+\-\s]+$/.test(raw) ? raw : '';
}

function copyMathmlAttributes(source, target) {
  copySharedAttributes(source, target);
  const altText = String(source.getAttribute('alttext') || source.getAttribute('aria-label') || '').trim().slice(0, 1_000);
  if (altText) target.setAttribute('aria-label', altText);
  if (source.tagName.toUpperCase() === 'MATH') {
    const display = String(source.getAttribute('display') || '').toLowerCase();
    if (['block', 'inline'].includes(display)) target.setAttribute('display', display);
    target.classList.add('wiki-math');
  }
  const variant = String(source.getAttribute('mathvariant') || '').toLowerCase();
  if (/^(?:normal|bold|italic|bold-italic|double-struck|bold-fraktur|script|bold-script|fraktur|sans-serif|bold-sans-serif|sans-serif-italic|sans-serif-bold-italic|monospace|initial|tailed|looped|stretched)$/.test(variant)) {
    target.setAttribute('mathvariant', variant);
  }
  const mathSize = safeLength(source.getAttribute('mathsize'), { maximum: 512 });
  if (mathSize) target.setAttribute('mathsize', mathSize);
  for (const name of ['accent', 'accentunder', 'displaystyle', 'fence', 'largeop', 'movablelimits', 'separator', 'stretchy', 'symmetric']) {
    const value = String(source.getAttribute(name) || '').toLowerCase();
    if (['true', 'false'].includes(value)) target.setAttribute(name, value);
  }
  const form = String(source.getAttribute('form') || '').toLowerCase();
  if (['infix', 'prefix', 'postfix'].includes(form)) target.setAttribute('form', form);
}

function sanitizedMathmlElement(source, context) {
  const tag = source.tagName.toUpperCase();
  if (!MATHML_ELEMENTS.has(tag)) {
    const fragment = context.document.createDocumentFragment();
    appendSanitizedChildren(source, fragment, context);
    return fragment;
  }
  const target = context.document.createElementNS(MATHML_NAMESPACE, source.localName.toLowerCase());
  copyMathmlAttributes(source, target);
  appendSanitizedChildren(source, target, context);
  if (tag === 'MATH') context.graphics += 1;
  return target;
}

function copySvgAttributes(source, target) {
  const id = safeSvgId(source.getAttribute('id'));
  if (id) target.id = id;
  const ariaLabel = String(source.getAttribute('aria-label') || '').trim().slice(0, 1_000);
  if (ariaLabel) target.setAttribute('aria-label', ariaLabel);
  const role = String(source.getAttribute('role') || '').toLowerCase();
  if (role === 'img') target.setAttribute('role', 'img');

  for (const name of ['x', 'y', 'x1', 'y1', 'x2', 'y2', 'cx', 'cy', 'r', 'rx', 'ry', 'width', 'height', 'dx', 'dy', 'font-size', 'stroke-width', 'stroke-dashoffset']) {
    const value = safeLength(source.getAttribute(name), { maximum: 100_000 });
    if (value) target.setAttribute(name, value);
  }
  for (const name of ['opacity', 'fill-opacity', 'stroke-opacity', 'offset']) {
    const raw = String(source.getAttribute(name) || '').trim();
    if (!raw) continue;
    const number = Number(raw.replace(/%$/, ''));
    if (Number.isFinite(number) && number >= 0 && number <= (raw.endsWith('%') ? 100 : 1)) target.setAttribute(name, raw);
  }
  for (const name of ['fill', 'stroke', 'stop-color']) {
    const value = safeSvgPaint(source.getAttribute(name));
    if (value) target.setAttribute(name, value);
  }
  const points = safeSvgNumberList(source.getAttribute('points'));
  if (points) target.setAttribute('points', points);
  const pathData = String(source.getAttribute('d') || '').trim();
  if (pathData.length <= 32_000 && /^[a-z\d.,+\-\s]+$/i.test(pathData)) target.setAttribute('d', pathData);
  const transform = String(source.getAttribute('transform') || '').trim();
  if (transform.length <= 1_000 && /^(?:(?:matrix|translate|scale|rotate|skewX|skewY)\([0-9eE.,+\-\s]+\)\s*)+$/.test(transform)) {
    target.setAttribute('transform', transform);
  }
  const dashArray = safeSvgNumberList(source.getAttribute('stroke-dasharray'), 1_000);
  if (dashArray) target.setAttribute('stroke-dasharray', dashArray);
  const linecap = String(source.getAttribute('stroke-linecap') || '').toLowerCase();
  if (['butt', 'round', 'square'].includes(linecap)) target.setAttribute('stroke-linecap', linecap);
  const linejoin = String(source.getAttribute('stroke-linejoin') || '').toLowerCase();
  if (['arcs', 'bevel', 'miter', 'miter-clip', 'round'].includes(linejoin)) target.setAttribute('stroke-linejoin', linejoin);
  const textAnchor = String(source.getAttribute('text-anchor') || '').toLowerCase();
  if (['start', 'middle', 'end'].includes(textAnchor)) target.setAttribute('text-anchor', textAnchor);
  const baseline = String(source.getAttribute('dominant-baseline') || '').toLowerCase();
  if (/^(?:auto|alphabetic|central|hanging|ideographic|mathematical|middle|text-after-edge|text-before-edge)$/.test(baseline)) {
    target.setAttribute('dominant-baseline', baseline);
  }

  for (const name of ['clip-path', 'mask']) {
    const raw = String(source.getAttribute(name) || '').trim();
    const match = raw.match(/^url\(\s*(['"]?)(#[^)\s'"]+)\1\s*\)$/i);
    const reference = match && safeSvgFragmentReference(match[2]);
    if (reference) target.setAttribute(name, `url(${reference})`);
  }
  const href = safeSvgFragmentReference(source.getAttribute('href') || source.getAttribute('xlink:href'));
  if (source.tagName.toUpperCase() === 'USE' && href) target.setAttribute('href', href);
}

function sanitizedSvgElement(source, context) {
  const tag = source.tagName.toUpperCase();
  if (SVG_DROP_WITH_CONTENT.has(tag)) return null;
  if (!SVG_ELEMENTS.has(tag)) {
    const fragment = context.document.createDocumentFragment();
    appendSanitizedChildren(source, fragment, context);
    return fragment;
  }
  const target = context.document.createElementNS(SVG_NAMESPACE, source.localName.toLowerCase());
  copySvgAttributes(source, target);
  if (tag === 'SVG') {
    const viewBox = safeSvgNumberList(source.getAttribute('viewBox'), 200);
    if (viewBox && viewBox.trim().split(/[\s,]+/).length === 4) target.setAttribute('viewBox', viewBox);
    const aspect = String(source.getAttribute('preserveAspectRatio') || '').trim();
    if (/^(?:none|x(?:Min|Mid|Max)Y(?:Min|Mid|Max)(?:\s+(?:meet|slice))?)$/.test(aspect)) target.setAttribute('preserveAspectRatio', aspect);
    target.classList.add('wiki-inline-svg');
  }
  appendSanitizedChildren(source, target, context);
  if (tag === 'SVG') context.graphics += 1;
  return target;
}

function sanitizedLink(source, context) {
  const link = classifyWikipediaHref(source.getAttribute('href'), context.articlePath);
  const target = context.document.createElement(link ? 'a' : 'span');
  copySharedAttributes(source, target);
  const title = String(source.getAttribute('title') || '').trim().slice(0, 500);
  if (title) target.title = title;
  appendSanitizedChildren(source, target, context);
  if (!link) return target;

  if (link.kind === 'external') {
    target.href = link.href;
    target.target = '_blank';
    target.rel = 'noopener noreferrer';
  } else if (link.kind === 'fragment') {
    target.href = `#${link.fragmentId}`;
  } else {
    target.dataset.wikipediaPath = link.path;
    if (link.fragment) target.dataset.wikipediaFragment = link.fragment;
    const href = context.articleHref?.(link.path, link.fragment);
    target.href = String(href || '#');
  }
  return target;
}

function imageSourceCandidates(source) {
  const candidates = ['src', 'data-src', 'data-original', 'data-lazy-src']
    .map(name => source.getAttribute(name))
    .filter(Boolean);
  for (const name of ['srcset', 'data-srcset']) {
    const value = source.getAttribute(name);
    if (!value) continue;
    candidates.push(...value.split(',').map(item => item.trim().split(/\s+/, 1)[0]).filter(Boolean));
  }
  return candidates;
}

function sanitizedImage(source, context) {
  if (context.images >= context.maxImages) return null;
  const path = imageSourceCandidates(source)
    .map(candidate => classifyWikipediaImageSource(candidate, context.articlePath))
    .find(Boolean);
  if (!path) return null;
  context.images += 1;

  const slot = context.document.createElement('span');
  slot.className = 'wiki-image-slot';
  slot.dataset.state = 'pending';
  slot.dataset.wikipediaImagePath = path;
  slot.setAttribute('aria-busy', 'true');

  const image = context.document.createElement('img');
  image.alt = String(source.getAttribute('alt') || source.getAttribute('title') || '').trim().slice(0, 1_000);
  image.decoding = 'async';
  // The loader performs its own IntersectionObserver-based lazy queue. Once a
  // slot is queued, eager loading lets a hidden Blob image fire load/error.
  image.loading = 'eager';
  image.referrerPolicy = 'no-referrer';
  image.hidden = true;
  for (const name of ['width', 'height']) {
    const value = safeIntegerAttribute(source, name, 1, 16_384);
    if (value) image.setAttribute(name, value);
  }
  const width = Number(image.getAttribute('width'));
  const height = Number(image.getAttribute('height'));
  const ratio = width / height;
  if (width > 0 && height > 0 && ratio >= 0.1 && ratio <= 10) slot.style.aspectRatio = `${width} / ${height}`;

  const placeholder = context.document.createElement('span');
  placeholder.className = 'wiki-image-placeholder';
  placeholder.setAttribute('aria-hidden', 'true');
  slot.append(image, placeholder);
  return slot;
}

function sanitizeElement(source, context) {
  const tag = source.tagName.toUpperCase();
  if (source.namespaceURI === MATHML_NAMESPACE || tag === 'MATH') return sanitizedMathmlElement(source, context);
  if (source.namespaceURI === SVG_NAMESPACE || tag === 'SVG') return sanitizedSvgElement(source, context);
  if (tag === 'IMG') return sanitizedImage(source, context);
  if (DROP_WITH_CONTENT.has(tag)) return null;
  if (!ALLOWED_ELEMENTS.has(tag)) {
    const fragment = context.document.createDocumentFragment();
    appendSanitizedChildren(source, fragment, context);
    return fragment;
  }
  if (tag === 'H1' && String(source.textContent || '').trim().toLowerCase() === context.title.toLowerCase()) {
    return null;
  }
  if (tag === 'A') return sanitizedLink(source, context);

  const outputTag = tag === 'H1' ? 'h2' : tag.toLowerCase();
  const target = context.document.createElement(outputTag);
  copySharedAttributes(source, target);

  if (tag === 'TD' || tag === 'TH') {
    for (const name of ['colspan', 'rowspan']) {
      const value = safeIntegerAttribute(source, name, 1, 24);
      if (value) target.setAttribute(name, value);
    }
    const scope = String(source.getAttribute('scope') || '').toLowerCase();
    if (tag === 'TH' && ['col', 'colgroup', 'row', 'rowgroup'].includes(scope)) target.setAttribute('scope', scope);
  } else if (tag === 'OL') {
    const start = safeIntegerAttribute(source, 'start', -10_000, 10_000);
    if (start) target.setAttribute('start', start);
  } else if (tag === 'LI') {
    const value = safeIntegerAttribute(source, 'value', -10_000, 10_000);
    if (value) target.setAttribute('value', value);
  } else if (tag === 'TIME') {
    const datetime = String(source.getAttribute('datetime') || '').trim().slice(0, 100);
    if (datetime) target.setAttribute('datetime', datetime);
  } else if (tag === 'ABBR' || tag === 'DFN') {
    const title = String(source.getAttribute('title') || '').trim().slice(0, 500);
    if (title) target.title = title;
  } else if (tag === 'DETAILS' && source.hasAttribute('open')) {
    target.setAttribute('open', '');
  }

  appendSanitizedChildren(source, target, context);
  if (tag !== 'TABLE') return target;
  const scroller = context.document.createElement('div');
  scroller.className = 'wiki-table-scroll';
  scroller.append(target);
  return scroller;
}

function sanitizeNode(source, context) {
  if (context.exhausted) return null;
  if (source.nodeType === 3) {
    const remaining = context.maxTextChars - context.textChars;
    if (remaining <= 0) {
      context.exhausted = true;
      context.truncated = true;
      return null;
    }
    const value = String(source.nodeValue || '').slice(0, remaining);
    context.textChars += value.length;
    if (value.length < String(source.nodeValue || '').length) {
      context.exhausted = true;
      context.truncated = true;
    }
    return context.document.createTextNode(value);
  }
  if (source.nodeType !== 1) return null;
  context.nodes += 1;
  if (context.nodes > context.maxNodes) {
    context.exhausted = true;
    context.truncated = true;
    return null;
  }
  return sanitizeElement(source, context);
}

export function renderWikipediaArticle(unsafeHtml, container, options = {}) {
  const document = container?.ownerDocument;
  const Parser = document?.defaultView?.DOMParser || globalThis.DOMParser;
  if (!document || typeof Parser !== 'function') throw new Error('This browser cannot format the Wikipedia article.');
  const maxSourceChars = Math.max(8_000, Math.min(2_000_000, Number(options.maxSourceChars) || 1_000_000));
  const source = String(unsafeHtml || '');
  // The parsed document is inert and receives a deny-all policy before any
  // archive markup, preventing resource URLs from turning a local read into a
  // network request. Only reconstructed nodes enter the live document.
  const parsed = new Parser().parseFromString(
    `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src 'none'; media-src 'none'; frame-src 'none'; style-src 'none'">${source.slice(0, maxSourceChars)}`,
    'text/html',
  );
  const context = {
    articleHref: typeof options.articleHref === 'function' ? options.articleHref : null,
    articlePath: String(options.articlePath || ''),
    document,
    exhausted: false,
    graphics: 0,
    images: 0,
    maxImages: Math.max(1, Math.min(48, Number(options.maxImages) || 24)),
    maxNodes: Math.max(500, Math.min(50_000, Number(options.maxNodes) || 20_000)),
    maxTextChars: Math.max(2_000, Math.min(500_000, Number(options.maxTextChars) || 250_000)),
    nodes: 0,
    textChars: 0,
    title: String(options.title || '').trim(),
    truncated: source.length > maxSourceChars,
  };
  const output = document.createDocumentFragment();
  appendSanitizedChildren(semanticRoot(parsed), output, context);
  container.replaceChildren(output);
  container.dataset.format = 'rich';
  return { empty: !container.textContent.trim() && context.images === 0 && context.graphics === 0, graphics: context.graphics, images: context.images, truncated: context.truncated, nodes: context.nodes, textChars: context.textChars };
}

export function sanitizeWikipediaSvg(unsafeSvg, document, options = {}) {
  const Parser = document?.defaultView?.DOMParser || globalThis.DOMParser;
  const Serializer = document?.defaultView?.XMLSerializer || globalThis.XMLSerializer;
  if (!document || typeof Parser !== 'function' || typeof Serializer !== 'function') {
    throw new Error('This browser cannot sanitize the Wikipedia vector image.');
  }
  const maxSourceChars = Math.max(1_000, Math.min(1_000_000, Number(options.maxSourceChars) || 512_000));
  const source = String(unsafeSvg || '').slice(0, maxSourceChars);
  const parsed = new Parser().parseFromString(source, 'image/svg+xml');
  if (parsed.documentElement?.localName?.toLowerCase() !== 'svg' || parsed.querySelector('parsererror')) {
    throw new Error('The Wikipedia vector image is malformed.');
  }
  const context = {
    articleHref: null,
    articlePath: '',
    document,
    exhausted: false,
    graphics: 0,
    images: 0,
    maxImages: 1,
    maxNodes: Math.max(100, Math.min(10_000, Number(options.maxNodes) || 5_000)),
    maxTextChars: Math.max(100, Math.min(50_000, Number(options.maxTextChars) || 10_000)),
    nodes: 0,
    textChars: 0,
    title: '',
    truncated: source.length < String(unsafeSvg || '').length,
  };
  const output = sanitizeNode(parsed.documentElement, context);
  if (!output || output.nodeType !== 1 || output.namespaceURI !== SVG_NAMESPACE || context.graphics !== 1) {
    throw new Error('The Wikipedia vector image has no safe SVG root.');
  }
  return new Serializer().serializeToString(output);
}

export function renderPlainWikipediaArticle(text, container) {
  const paragraph = container.ownerDocument.createElement('p');
  paragraph.className = 'wiki-plain-fallback';
  paragraph.textContent = String(text || '');
  container.replaceChildren(paragraph);
  container.dataset.format = 'plain';
}
