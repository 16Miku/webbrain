/**
 * Floating WebBrain shortcut for selected page text.
 *
 * A small bar (Translate | Explain | Proofread | More…) appears next to the
 * selection. Translate, Explain and Proofread answer in a card on the page;
 * More… opens the full popup, whose actions and question box continue in the
 * side panel, and so does a follow-up typed in a card.
 *
 * Runs only in the top frame. The UI is isolated in a closed Shadow DOM;
 * the background owns prompt construction and untrusted-content wrapping.
 */
(function () {
  const shortcutConfig = globalThis.__webbrainSelectionShortcutConfig;
  if ((window.top !== window && shortcutConfig?.allowNestedFrame !== true)
      || window.__webbrainSelectionShortcutInjected) return;
  window.__webbrainSelectionShortcutInjected = true;

  const api = globalThis.browser || globalThis.chrome;
  if (!api?.runtime || !api?.storage?.local) return;

  const STORAGE_KEY = 'selectionShortcutEnabled';
  const LOCALE_STORAGE_KEY = 'wbLocale';
  const SUBMIT_MESSAGE = typeof shortcutConfig?.submitMessage === 'string'
    && shortcutConfig.submitMessage.trim()
    ? shortcutConfig.submitMessage.trim()
    : 'WB_SELECTION_SHORTCUT_SUBMIT';
  // Read when a request is sent, not once at load: the PDF viewer keeps its window id
  // current while its tab moves between windows.
  const currentSubmitFields = () => shortcutConfig?.submitFields
    && typeof shortcutConfig.submitFields === 'object'
    && !Array.isArray(shortcutConfig.submitFields)
    ? { ...shortcutConfig.submitFields }
    : {};
  const LOCALIZATION_MESSAGE = 'WB_SELECTION_SHORTCUT_LOCALIZATION';
  const INLINE_MESSAGE = 'WB_SELECTION_SHORTCUT_INLINE';
  const INLINE_CANCEL_MESSAGE = 'WB_SELECTION_SHORTCUT_INLINE_CANCEL';
  const GAP = 8;
  const TOOLBAR_HEIGHT = 38;
  const POPUP_WIDTH = 316;
  const CARD_WIDTH = 420;
  // The room a card should have on one side of the selection before it is
  // placed there; with less on both sides it takes the larger side and scrolls.
  const CARD_PREFERRED_HEIGHT = 300;
  // Keep in step with INLINE_SELECTION_MAX_CHARS in context-menu-storage.js.
  // Longer selections are read better in the side panel than in a small card.
  const INLINE_MAX_CHARS = 4000;
  // Keep in step with INLINE_ANSWER_MAX_CHARS in context-menu-storage.js. An answer is never
  // held beyond it, so a follow-up or a continuation carries the card's text whole.
  const INLINE_ANSWER_MAX_CHARS = 64000;
  const INLINE_ACTIONS = Object.freeze(['translate', 'explain', 'proofread']);
  const MAX_SELECTION_HIGHLIGHT_RECTS = 200;
  const TRANSLATION_LANGUAGES = Object.freeze([
    'en', 'es', 'fr', 'tr', 'zh', 'ru', 'uk', 'ar',
    'ja', 'ko', 'id', 'th', 'ms', 'tl', 'pl', 'he',
    'hi', 'pt', 'vi', 'bn', 'fa', 'nl', 'de',
  ]);
  const LOCALIZATION_KEYS = Object.freeze([
    'askSelection', 'askHighlightedText', 'openChat', 'summarize', 'explain', 'quiz',
    'proofread', 'humanize', 'translate', 'translateTo', 'askAbout',
    'askQuestion', 'sendQuestion', 'includePageContext', 'hideShortcut', 'sentManual', 'sendFailed',
    'more', 'askFollowUp', 'sendFollowUp', 'working', 'autoDetect', 'inlineFailed', 'retry',
    'cutOff', 'continueInPanel',
  ]);
  // English copy for strings the card shows before the localization bundle
  // arrives (or when the background cannot be reached).
  const DEFAULT_STRINGS = Object.freeze({
    translateTo: 'Translate to',
    autoDetect: 'Auto-detect',
    inlineFailed: 'Could not get an answer.',
    cutOff: 'This answer was cut off.',
    continueInPanel: 'Continue in side panel',
  });
  // Language codes the browser's detector reports that differ from ours.
  const DETECTED_LANGUAGE_ALIASES = Object.freeze({ iw: 'he', fil: 'tl', in: 'id' });

  let enabled = true;
  let suppressed = false;
  let submitting = false;
  let interacting = false;
  let snapshot = null;
  let host = null;
  let shadow = null;
  let highlightLayer = null;
  let shortcut = null;
  let moreButton = null;
  let moreBrain = null;
  let popup = null;
  let question = null;
  let includePageContext = null;
  let sendButton = null;
  let card = null;
  let cardParts = null;
  let cardState = null;
  let cardSide = 'above';
  let cardOpener = null;
  let cardRequestId = 0;
  // Id of the model call the card is waiting on, so closing or redoing the card can cancel it.
  let cardJobId = '';
  let toolbarLeft = 0;
  let interfaceLanguage = resolveInterfaceLanguage('');
  let localization = null;
  let localizationRequestId = 0;
  let toast = null;
  let toastTimer = null;
  let selectionTimer = null;

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  // The small Nucleus mark and orbit renderer from assets/loader-candidates/.
  // Play two orbits on reveal, then leave only the monochrome mark.
  function mountMoreBrain(canvas) {
    let ctx = null;
    try { ctx = canvas?.getContext('2d'); } catch { /* More remains usable without canvas. */ }
    if (!ctx || typeof Path2D !== 'function') return { play() {}, destroy() {} };
    const mark = new Path2D('M46.6 93.2C46 92.7 45.5 91.5 45 89.6C44.6 87.9 44 86 43.7 85.2C42.8 83.1 42.9 82.9 44.7 81.9C45.6 81.4 47.2 80.2 48.2 79.3L50 77.6L51.5 78.9C52.2 79.7 53.7 80.8 54.7 81.5C57.1 83.1 57.1 83.3 56.2 85.6C55.8 86.7 55.2 88.6 55 89.9C54.3 93.2 53.5 93.8 50 93.8C48.1 93.8 47.2 93.7 46.6 93.2ZM26.6 81.8C24.1 80.9 21.6 79.3 20.6 77.8C19.2 75.8 19.3 75.5 21.5 75.2C23.4 75 26.9 73.1 26.9 72.3C26.9 72 26.5 71.9 25.7 72.1C19.4 73.3 16 72 14.6 67.9C14.4 67.1 14 66.5 13.8 66.5C12.5 66.5 13.1 69.9 14.8 72.1C16.3 74 16.1 74.1 13.2 73.3C3.5 70.4 5.5 55.2 15.3 57.3C17.9 57.8 18 57.1 15.7 55.9C11.7 53.8 5.8 56.7 4.5 61.4C4 63.3 3.8 63.4 3 62.4C-0.1 59 -0 50.7 3.1 47.9C3.7 47.3 3.8 47.4 4.4 48.3C5.3 49.7 5.9 49.5 5.6 47.7C5.3 46 5.9 43.5 6.9 42.2C7.8 41 7.9 40.8 7.2 40.8C6.7 40.8 5.1 42.3 3.4 44.5C1.6 46.9 1.6 40.5 3.4 37C4.5 35 5.3 34.1 7.1 32.9C8.4 32 8.5 31.8 8.6 29.9C8.7 27.1 10.4 23.9 12.6 21.9C17.9 17.2 29 17.5 28.9 22.2C28.9 25.5 28.5 26.4 26.8 26.7C24 27.2 22.9 28.5 25.3 28.5C28.7 28.5 31.2 31.5 31.2 35.6C31.2 39 31.7 40.2 34.2 42.9C37.2 46.1 38.1 49 36.7 52.2C36.2 53.5 36.2 53.6 36.8 54.3C37.8 55.4 37.8 55.4 41.5 48.4C46.3 39.5 47.7 38.2 51.5 39.2C53.7 39.8 54.6 40.9 58.3 48C62 55 62.2 55.3 63.2 54.3C63.8 53.7 63.8 53.5 63.3 52.2C61.9 49 62.7 46.3 66 42.7C67.3 41.2 68.5 40 68.5 39.9C68.5 39.9 68.7 38.1 68.8 36.1C69.2 31 70.7 29 74.4 28.6C75.4 28.4 76.2 28.2 76.2 27.9C76.2 27.4 73.7 26.5 72.4 26.5C71.8 26.5 71.5 26.3 71.5 25.6C71.5 25.1 71.4 24.2 71.1 23.6C70.4 21.4 73 18.5 75.7 18.5C76.9 18.5 77.1 17.7 76.1 17.4C74.8 16.9 72 17.6 70.6 18.6L69.3 19.6L67.6 17.9C65.8 16.3 62.9 14.7 62.4 15.1C62.3 15.2 63.2 16.3 64.4 17.4C68.3 20.9 70.1 26.3 68.3 29L67.6 30.1L66.7 29.2C65.4 28 65 28.6 65.8 30.3C66.4 31.5 66.5 32.2 66.2 35.2C65.9 39.4 65.3 40.5 62.8 41.6C61.6 42.1 61.2 42.5 61.3 42.9C61.4 43.3 61.3 44 60.9 44.7L60.3 45.9L58.8 43C57 39.7 55.4 37.9 53.4 36.9C51.8 36.1 51.5 35.6 51.5 33.1C51.6 30.9 52.3 29.9 54.7 28.9C57 27.9 56.8 27.1 54.5 27.4C53.6 27.5 52.6 27.7 52.2 27.9C51.7 28.1 51.6 27.8 51.3 26C50.8 21.8 51.6 20 54.5 19C57.1 18.1 56.3 17.1 53.5 17.7C51.3 18.2 51.4 18.3 51.4 13.9C51.4 8.8 51.6 8.3 53.6 7.2C57.4 5.2 64.6 6.5 67.2 9.8C68.2 11.1 68.3 11.2 71 11.2C75.5 11.2 78.7 13.2 80.4 17C81 18.5 81.4 18.9 82.5 19.2C87 20.4 90.5 24.4 91.4 29C91.6 30.1 91.5 30.5 91 30.9C90.4 31.4 90.5 31.5 92.4 32.6C94.5 33.8 96.2 35.7 97.2 38.2C97.9 39.7 98.2 43.9 97.8 44.5C97.4 45.2 96.3 44.8 96 43.9C95.7 42.9 93.1 40.6 92.8 40.9C92.7 41.1 92.7 41.5 93 41.8C94 43.2 94.4 44.5 94.5 46.7C94.5 48 94.6 49.1 94.6 49.2C94.6 49.3 95.1 48.9 95.6 48.3C96.5 47.2 96.5 47.1 97.1 47.9C99.5 50.9 100.1 56.1 98.5 59.9C97.4 62.4 96.3 63.5 95.9 62.5C94.9 59.1 93.4 57.3 91 56.1C89 55 85.9 55 84.2 56C82.8 56.8 82.6 57.6 83.8 57.4C89.5 56.3 93.1 59 93.1 64.5C93.1 68.9 90.9 72.1 86.9 73.3C83.9 74.1 83.6 74 84.8 72.6C86.1 71.1 86.9 69.2 86.9 67.9C86.9 66.4 86.2 66.4 85.6 67.8C83.8 72.1 80.4 73.4 74.3 72.1C73.6 71.9 73.1 72 73.1 72.2C73.1 73 76.7 75 78.5 75.2C80.6 75.5 80.8 75.9 79.5 77.7C74.1 85.7 54.2 82.4 51.4 73C51 71.9 50.8 70.5 50.8 70C50.8 67.3 49.4 68.3 49.1 71.2C48.4 77.4 41.7 81.7 32.1 82.1C29.5 82.3 27.8 82.1 26.6 81.8ZM34.5 78.6C36 78 37.7 76.7 37.7 76.1C37.7 75.5 36.2 75.8 34 76.9C32.8 77.6 31.4 78.1 30.8 78.1C29.7 78.1 29 78.5 29.5 79C30 79.4 33.1 79.2 34.5 78.6ZM70.5 78.7C70.5 78.4 69.7 78.1 68.9 78C68 77.9 66.5 77.3 65.4 76.7C63.2 75.4 61.7 75.6 62.9 77C64.5 78.8 70.8 80.1 70.5 78.7ZM40.9 69.4C42.2 69.1 43.8 68.8 44.4 68.8C45.3 68.7 45.6 68.5 45.5 67.9C45.4 67.4 45.9 66.1 46.6 64.9C47.3 63.8 48.3 61.9 48.8 60.8C50.1 58.3 50 58.3 51.6 61.6C52.3 63.1 53.3 65 53.9 65.8C54.6 66.7 54.8 67.4 54.6 67.7C54.1 68.5 54.5 68.8 56.2 68.8C57 68.8 58.1 69 58.4 69.2C59.7 69.9 63.2 70.1 65 69.6C66.4 69.3 67.3 68.6 69.6 66.1C72.6 63 73.8 62.3 76.4 62.3C78.2 62.3 78 61.6 75.9 60.7C74.2 60 74.2 59.9 74.5 58.5C75.4 53.5 77.8 51.1 82.7 50C85 49.6 87.9 47.9 88.3 47C88.6 46.1 88.2 46 86.9 46.8C85.7 47.4 79.2 48.6 78.9 48.2C78.2 47.5 81.7 40.9 84 38.7C87.6 35.3 87.9 31.3 84.8 28.5C83.7 27.4 83.2 27.6 83.9 28.9C85.3 31.6 84.1 35.5 81.2 37.2C79.4 38.4 79.3 38.5 76.7 44.7C68.2 65.1 67.1 66.9 62.1 66.9C58.2 66.9 56.9 65.6 53 58C51.6 55.1 50.2 52.7 50 52.7C49.8 52.7 48.3 55.5 46.5 58.8C42.9 65.9 42.2 66.6 38.3 66.8C33.4 67.1 32.2 65.5 25.5 50L20.6 38.4L18.6 37.1C15.9 35.3 15.1 32.4 16.3 28.6C16.8 27.2 15.9 27.5 14.6 29.3C12.2 32.6 12.9 36.2 16.4 39.1C18.2 40.6 21.8 47.6 21.1 48.2C20.8 48.5 14.3 47.4 13.2 46.8C10.7 45.5 11.6 47.3 14.2 49C14.8 49.3 16.2 49.8 17.3 50C21.5 50.9 23.3 52.3 24.8 56.1C26.1 59.2 26.1 60.2 24.7 60.6C21.7 61.3 21.9 62.1 25.2 62.5C27 62.7 27.3 63 29.8 65.6C34 69.9 36 70.6 40.9 69.4ZM39.1 44.8C38.8 44.1 38.6 43.3 38.6 43C38.6 42.6 38 42 36.9 41.5C34.5 40.2 33.9 39 33.8 34.8C33.7 32.2 33.8 31 34.3 30.1C35.1 28.6 34.7 28.2 33.3 29.2L32.3 30L31.7 29C29.9 26.3 31.8 20.8 35.6 17.4C37 16.2 37.6 15.4 37.3 15.2C36.8 14.9 32.9 17.2 31.7 18.6L30.8 19.7L29.5 18.7C27.8 17.5 26.1 16.9 22.8 16.7C19.7 16.4 19.6 16.3 21 14.6C22.9 12.4 25.1 11.4 28.7 11.2C31.8 11.1 31.9 11 32.9 9.8C36.1 5.5 46.9 5 48.5 9.1C48.9 10.3 49 17.6 48.5 17.8C48.4 17.9 47.6 17.9 46.7 17.7C45.8 17.5 45 17.5 44.5 17.7C43.6 18.2 43.9 18.7 45.3 19C48.2 19.5 49.5 22.6 48.7 26.7C48.5 28 48.3 28.1 47.6 27.8C46.3 27.4 44.1 27.4 44 27.9C43.9 28.1 44.7 28.7 45.8 29.1C49.1 30.5 50 35 47.2 36.5C44.9 37.7 43.1 39.7 41.4 42.8L39.7 45.9L39.1 44.8Z');
    const size = 22;
    const tau = Math.PI * 2;
    const duration = 2000;
    const radius = size * 0.44;
    const markPx = size * 0.62;
    const samples = 10;
    const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
    const theme = window.matchMedia('(prefers-color-scheme: dark)');
    const mono = (value) => [value, value, value];
    const rgba = (color, alpha) => `rgba(${color.join(',')},${clamp(alpha, 0, 1)})`;
    let scale = 1;
    let palette;
    let frame = 0;
    let startedAt = 0;

    function restyle() {
      scale = clamp(window.devicePixelRatio || 1, 1, 4);
      canvas.width = canvas.height = Math.round(size * scale);
      const rgb = getComputedStyle(moreButton).color.match(/[\d.]+/g)?.slice(0, 3).map(Number) || [23, 23, 23];
      const ink = Math.round(rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722);
      const dark = ink > 128;
      palette = { dark, ink: mono(ink), glow: mono(dark ? ink * 0.8 : ink + 60), hot: mono(dark ? 255 : ink) };
    }

    function markTransform() {
      ctx.translate((size - markPx) / 2, (size - markPx) / 2);
      ctx.scale(markPx / 100, markPx / 100);
    }

    function drawMark() {
      ctx.globalCompositeOperation = 'source-over';
      ctx.save();
      markTransform();
      ctx.fillStyle = rgba(palette.ink, 1);
      ctx.fill(mark, 'evenodd');
      ctx.restore();
    }

    function clear() {
      ctx.setTransform(scale, 0, 0, scale, 0, 0);
      ctx.clearRect(0, 0, size, size);
    }

    function glowDot(point, color, alpha) {
      const r = 2.1 * (palette.dark ? 1.3 : 1.05);
      const gradient = ctx.createRadialGradient(point[0], point[1], 0, point[0], point[1], r);
      gradient.addColorStop(0, rgba(color, alpha));
      gradient.addColorStop(0.25, rgba(palette.glow, alpha * 0.7));
      gradient.addColorStop(1, rgba(palette.glow, 0));
      ctx.fillStyle = gradient;
      ctx.beginPath();
      ctx.arc(point[0], point[1], r, 0, tau);
      ctx.fill();
    }

    const depthAlpha = (z) => z < 0 ? 0.3 + 0.42 * (1 + z) : 0.86 + 0.14 * z;
    const depthWidth = (z) => z < 0 ? 0.76 + 0.16 * (1 + z) : 1 + 0.22 * z;

    // Tapered ribbons, with the same depth split as the original Nucleus.
    function ribbon(points, start, end, overMark) {
      if (end <= start) return;
      const left = [], right = [];
      for (let i = start; i <= end; i++) {
        const before = points[Math.max(0, i - 1)], after = points[Math.min(samples, i + 1)];
        const length = Math.hypot(after[0] - before[0], after[1] - before[1]) || 1;
        const width = (1.5 * Math.pow(1 - i / samples, 0.8) + 0.3) * depthWidth(points[i][2]) / 2;
        const nx = -(after[1] - before[1]) / length * width;
        const ny = (after[0] - before[0]) / length * width;
        left.push([points[i][0] + nx, points[i][1] + ny]);
        right.push([points[i][0] - nx, points[i][1] - ny]);
      }
      ctx.beginPath();
      left.forEach(([x, y], i) => i ? ctx.lineTo(x, y) : ctx.moveTo(x, y));
      for (let i = right.length - 1; i >= 0; i--) ctx.lineTo(...right[i]);
      ctx.closePath();
      const gradient = ctx.createLinearGradient(...points[start].slice(0, 2), ...points[end].slice(0, 2));
      for (const offset of [0, 0.5, 1]) {
        const i = Math.round(start + (end - start) * offset);
        const u = i / samples;
        const color = overMark ? palette.glow : palette.hot.map((value, k) => Math.round(value + (palette.glow[k] - value) * Math.min(1, u * 1.7)));
        gradient.addColorStop(offset, rgba(color, Math.pow(1 - u, 1.5) * depthAlpha(points[i][2]) * 0.95));
      }
      ctx.fillStyle = gradient;
      ctx.fill();
    }

    function drawSpark(points, front, overMark = false) {
      let start = -1;
      for (let i = 0; i < samples; i++) {
        const isFront = (points[i][2] + points[i + 1][2]) / 2 >= 0;
        if (isFront === front && start < 0) start = i;
        if ((isFront !== front || i === samples - 1) && start >= 0) {
          ribbon(points, start, isFront === front ? i + 1 : i, overMark);
          start = -1;
        }
      }
      if ((points[0][2] >= 0) === front) glowDot(points[0], overMark ? palette.glow : palette.hot, depthAlpha(points[0][2]));
    }

    function draw(time) {
      clear();
      const sparks = [0, 1, 2].map((orbit) => Array.from({ length: samples + 1 }, (_, sample) => {
        const t = time - sample * 0.014;
        const angle = (orbit + 1) * 1.7 + tau * t * (orbit % 2 ? -1 : 1);
        const inclination = 1.2 + 0.14 * Math.sin(t * 0.9 + orbit);
        const plane = orbit * Math.PI / 3 + 0.35 + 0.32 * t;
        const x = radius * Math.cos(angle), y = radius * Math.sin(angle);
        const tiltedY = y * Math.cos(inclination);
        return [size / 2 + x * Math.cos(plane) - tiltedY * Math.sin(plane),
          size / 2 + x * Math.sin(plane) + tiltedY * Math.cos(plane), Math.sin(angle) * Math.sin(inclination)];
      }));
      const blend = palette.dark ? 'lighter' : 'source-over';
      ctx.globalCompositeOperation = blend;
      sparks.forEach((points) => drawSpark(points, false));
      drawMark();
      ctx.globalCompositeOperation = blend;
      sparks.forEach((points) => drawSpark(points, true));
      if (palette.dark) {
        ctx.globalCompositeOperation = 'source-over';
        ctx.save();
        markTransform();
        ctx.clip(mark, 'evenodd');
        ctx.setTransform(scale, 0, 0, scale, 0, 0);
        sparks.forEach((points) => drawSpark(points, true, true));
        ctx.restore();
      }
      ctx.globalCompositeOperation = 'source-over';
    }

    function settle() {
      cancelAnimationFrame(frame);
      frame = 0;
      restyle();
      clear();
      drawMark();
    }

    function tick(now) {
      if (now - startedAt >= duration || shortcut.hidden || document.visibilityState === 'hidden' || motion.matches) {
        settle();
        return;
      }
      draw((now - startedAt) / 1000);
      frame = requestAnimationFrame(tick);
    }

    const watch = new MutationObserver(() => { if (shortcut.hidden) settle(); });
    watch.observe(shortcut, { attributes: true, attributeFilter: ['hidden'] });
    document.addEventListener('visibilitychange', settle);
    motion.addEventListener('change', settle);
    theme.addEventListener('change', settle);
    settle();
    return {
      play() {
        settle();
        if (motion.matches || document.visibilityState === 'hidden') return;
        startedAt = performance.now();
        frame = requestAnimationFrame(tick);
      },
      destroy() {
        cancelAnimationFrame(frame);
        watch.disconnect();
        document.removeEventListener('visibilitychange', settle);
        motion.removeEventListener('change', settle);
        theme.removeEventListener('change', settle);
      },
    };
  }

  function isTextField(element) {
    return element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement;
  }

  function isSupportedTranslationLanguage(value) {
    return TRANSLATION_LANGUAGES.includes(value);
  }

  function serializeRect(rect) {
    return {
      left: rect.left,
      top: rect.top,
      right: rect.right,
      bottom: rect.bottom,
      width: rect.width,
      height: rect.height,
    };
  }

  function collectVisibleHighlightRects(rects) {
    const visibleRects = [];
    for (const rect of rects) {
      const isVisible = rect.bottom > 0
        && rect.right > 0
        && rect.top < window.innerHeight
        && rect.left < window.innerWidth;
      if (!isVisible) continue;
      visibleRects.push(rect);
      if (visibleRects.length >= MAX_SELECTION_HIGHLIGHT_RECTS) break;
    }
    return visibleRects;
  }

  function resolveInterfaceLanguage(value) {
    const preferred = String(value || '').trim().toLowerCase();
    if (isSupportedTranslationLanguage(preferred)) return preferred;
    const browserLanguage = String(navigator.language || 'en').slice(0, 2).toLowerCase();
    return isSupportedTranslationLanguage(browserLanguage) ? browserLanguage : 'en';
  }

  function str(key) {
    return localization?.strings?.[key] || DEFAULT_STRINGS[key] || '';
  }

  function languageName(code) {
    try {
      return new Intl.DisplayNames([interfaceLanguage], { type: 'language' }).of(code) || '';
    } catch {
      return '';
    }
  }

  function baseLanguage(code) {
    const base = String(code || '').trim().toLowerCase().split('-')[0];
    return DETECTED_LANGUAGE_ALIASES[base] || base;
  }

  // The browser's own detector (no network, no model call). Resolves '' when
  // it is missing, unsure, or slow, so Translate still works without it.
  function detectSourceLanguage(text) {
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(''), 600);
      const finish = (result) => {
        clearTimeout(timer);
        const top = result?.isReliable ? String(result.languages?.[0]?.language || '') : '';
        resolve(top.toLowerCase() === 'und' ? '' : top);
      };
      try {
        const detect = api.i18n?.detectLanguage;
        if (typeof detect !== 'function') {
          finish(null);
        } else if (globalThis.browser?.i18n === api.i18n) {
          // Firefox: promise API.
          Promise.resolve(detect.call(api.i18n, text)).then(finish, () => finish(null));
        } else {
          detect.call(api.i18n, text, finish);
        }
      } catch {
        finish(null);
      }
    });
  }

  function normalizeLocalization(response) {
    if (!response?.ok || !response.strings || typeof response.strings !== 'object') return null;
    const strings = {};
    for (const key of LOCALIZATION_KEYS) {
      const value = response.strings[key];
      if (typeof value !== 'string' || !value.trim()) return null;
      strings[key] = value;
    }
    return {
      locale: resolveInterfaceLanguage(response.locale),
      dir: response.dir === 'rtl' ? 'rtl' : 'ltr',
      strings,
    };
  }

  function applyLocalization() {
    if (!shadow) return;
    if (!localization) {
      // The language bundle did not load. The card still runs on the built-in English
      // text, and its target list has to exist too: Translate asks for a target when the
      // text is already in the interface language.
      populateTargetLanguages();
      return;
    }
    const strings = localization.strings;
    host.lang = localization.locale;
    host.dir = localization.dir;
    shortcut.setAttribute('aria-label', strings.askHighlightedText);
    popup.setAttribute('aria-label', strings.askHighlightedText);
    for (const action of ['summarize', 'quiz', 'humanize']) {
      const label = shadow.querySelector(`[data-action="${action}"] .action-label`);
      if (label) label.textContent = strings[action];
    }
    for (const action of INLINE_ACTIONS) {
      const label = shadow.querySelector(`[data-inline="${action}"] .bar-label`);
      if (label) label.textContent = strings[action];
    }
    shadow.querySelector('[data-more] .bar-label').textContent = strings.more;
    question.setAttribute('aria-label', strings.askQuestion);
    question.placeholder = strings.askQuestion;
    sendButton.setAttribute('aria-label', strings.sendQuestion);
    const contextOptionLabel = shadow.querySelector('.context-option span');
    if (contextOptionLabel) contextOptionLabel.textContent = strings.includePageContext;
    const hideButton = shadow.querySelector('.hide');
    if (hideButton) hideButton.textContent = strings.hideShortcut;
    cardParts.followUp.placeholder = strings.askFollowUp;
    cardParts.followUp.setAttribute('aria-label', strings.askFollowUp);
    cardParts.send.setAttribute('aria-label', strings.sendFollowUp);
    cardParts.target.setAttribute('aria-label', strings.translateTo);
    cardParts.skeleton.setAttribute('aria-label', strings.working);
    cardParts.retry.textContent = strings.retry;
    cardParts.cutText.textContent = strings.cutOff;
    cardParts.continueButton.textContent = strings.continueInPanel;
    populateTargetLanguages();
    renderCard();
    // Label widths change with the language, and the bar is centered on the selection.
    if (snapshot && !shortcut.hidden) positionShortcut();
  }

  async function refreshLocalization(value) {
    interfaceLanguage = resolveInterfaceLanguage(value);
    const requestId = ++localizationRequestId;
    try {
      const response = await api.runtime.sendMessage({
        type: LOCALIZATION_MESSAGE,
        locale: interfaceLanguage,
      });
      if (requestId !== localizationRequestId) return;
      const next = normalizeLocalization(response);
      if (!next) return;
      interfaceLanguage = next.locale;
      localization = next;
      applyLocalization();
    } catch { /* English markup remains the offline fallback. */ }
  }

  function readSelection() {
    if (!enabled || suppressed || submitting || isTextField(document.activeElement)) return null;
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null;
    const text = selection.toString().trim();
    if (!text) return null;

    const range = selection.getRangeAt(0);
    const ancestor = range.commonAncestorContainer.nodeType === Node.ELEMENT_NODE
      ? range.commonAncestorContainer
      : range.commonAncestorContainer.parentElement;
    if (ancestor?.closest?.('input, textarea')) return null;

    const rects = Array.from(range.getClientRects()).filter((rect) => rect.width > 0 && rect.height > 0);
    const visibleRects = collectVisibleHighlightRects(rects);
    const rect = visibleRects[0] || rects[0] || range.getBoundingClientRect();
    if (!rect || (!rect.width && !rect.height)) return null;
    return {
      text,
      rect: serializeRect(rect),
      rects: (visibleRects.length ? visibleRects : [rect]).map(serializeRect),
    };
  }

  function ensureSurface() {
    if (host?.isConnected) return;
    host = document.createElement('div');
    host.id = 'webbrain-selection-shortcut-host';
    (window.__wbPageMonitorDecorations ??= new WeakSet()).add(host);
    host.style.cssText = 'position:fixed;inset:0;width:100vw;height:100vh;display:block;pointer-events:none;z-index:2147483647';
    shadow = host.attachShadow({ mode: 'closed' });
    shadow.innerHTML = `
      <style>
        :host {
          --accent:#6c63ff; --accent-strong:#554cf2; --bg:#fff;
          --hover:#f4f3ff; --text:#171722; --muted:#666679; --border:#dedee9;
          --field:#f5f5f7; --field-strong:#e8e8ee;
          --shadow:0 18px 50px rgba(24,20,70,.22),0 3px 12px rgba(24,20,70,.12);
          color-scheme:light dark;
        }
        * { box-sizing:border-box; }
        button,textarea,input,select { font:inherit; }
        [hidden] { display:none !important; }
        .selection-highlight {
          position:fixed; border-radius:3px; pointer-events:none;
          background:rgba(108,99,255,.3); box-shadow:inset 0 0 0 1px rgba(85,76,242,.18);
        }
        .shortcut {
          position:fixed; display:flex; align-items:center; max-width:calc(100vw - 16px);
          overflow:hidden; padding:4px; border:1px solid var(--border); border-radius:12px;
          background:var(--bg); color:var(--text);
          box-shadow:0 10px 26px rgba(35,30,95,.2),0 2px 7px rgba(35,30,95,.12);
          pointer-events:auto; white-space:nowrap;
          font:14px/1.2 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
        }
        .bar-item {
          flex:0 1 auto; min-width:0; padding:8px 12px; border:0; border-radius:8px; background:transparent;
          color:inherit; font-weight:550; cursor:pointer;
        }
        .bar-item:hover { background:var(--hover); }
        .bar-item[data-more] { display:flex; align-items:center; gap:5px; flex:none; }
        .more-brain { display:block; flex:none; width:22px; height:22px; pointer-events:none; }
        .bar-label { display:block; overflow:hidden; text-overflow:ellipsis; }
        /* On a narrow viewport the bar tightens, then shortens the other labels, so More stays on screen. */
        @media (max-width:420px) { .bar-item { padding:8px 8px; } }
        .bar-sep { flex:0 0 1px; width:1px; height:16px; background:var(--border); }
        .popup {
          position:fixed; width:min(${POPUP_WIDTH}px,calc(100vw - 16px));
          max-height:calc(100vh - 16px); overflow-y:auto; overscroll-behavior:contain;
          padding:12px;
          border:1px solid var(--border); border-radius:16px; background:var(--bg);
          color:var(--text); box-shadow:var(--shadow); pointer-events:auto;
          font:15px/1.35 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
        }
        .actions { display:grid; grid-template-columns:minmax(0,1fr); gap:2px; }
        .action,.hide {
          border:0; border-radius:10px; background:transparent;
          color:var(--text); text-align:start; cursor:pointer;
        }
        .action {
          width:100%; min-width:0; display:flex; align-items:center; gap:9px;
          padding:10px 12px; font-size:15px; font-weight:550;
        }
        .action-icon {
          width:17px; height:17px; flex:0 0 17px; color:var(--accent);
          fill:none; stroke:currentColor; stroke-width:1.7;
          stroke-linecap:round; stroke-linejoin:round;
        }
        .action-label { min-width:0; }
        .action:hover .action-icon { color:var(--accent-strong); }
        .action:hover,.hide:hover { background:var(--hover); }
        .question-wrap { position:relative; margin-top:8px; }
        textarea {
          display:block; width:100%; min-height:76px; max-height:150px; resize:vertical;
          padding:10px 42px 10px 11px; border:1px solid var(--border); border-radius:12px;
          background:var(--bg); color:var(--text); font:14px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
        }
        textarea::placeholder { color:var(--muted); }
        textarea:focus { border-color:var(--accent); outline:none; }
        .send {
          position:absolute; right:8px; bottom:8px; width:28px; height:28px;
          display:grid; place-items:center; padding:0; border:0; border-radius:9px;
          background:var(--accent); color:#fff; cursor:pointer;
        }
        .send:hover:not(:disabled) { background:var(--accent-strong); }
        .send:disabled { opacity:.38; cursor:default; }
        .send svg { width:15px; height:15px; }
        .context-option {
          display:flex; align-items:flex-start; gap:8px; margin:8px 2px 2px;
          color:var(--muted); font-size:13px; line-height:1.35; cursor:pointer;
        }
        .context-option input { margin:2px 0 0; accent-color:var(--accent); }
        .divider { height:1px; margin:10px 0 4px; background:var(--border); }
        .hide-row { display:flex; }
        .hide {
          width:auto; margin-left:auto; padding:5px 8px;
          color:var(--muted); font-size:12px; line-height:1.25;
        }
        .card {
          position:fixed; width:min(${CARD_WIDTH}px,calc(100vw - 16px)); display:flex; flex-direction:column;
          padding:14px; overflow:hidden; border:1px solid var(--border); border-radius:18px;
          background:var(--bg); color:var(--text); box-shadow:var(--shadow); pointer-events:auto;
          font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
        }
        .card:focus { outline:none; }
        .card-lang { display:flex; flex:none; align-items:center; gap:10px; margin-bottom:12px; }
        .lang-source,.lang-target {
          min-width:0; padding:9px 14px; border:0; border-radius:12px; background:var(--field);
          color:var(--muted); font-size:15px; line-height:1.3;
        }
        .lang-source { flex:1 1 0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
        .lang-arrow { flex:none; width:18px; height:18px; color:var(--muted); }
        .lang-select-wrap { position:relative; flex:1 1 0; min-width:0; }
        .lang-target {
          display:block; width:100%; appearance:none; -webkit-appearance:none; -moz-appearance:none;
          padding-inline-end:36px; color:var(--text); cursor:pointer; text-overflow:ellipsis;
        }
        .lang-chevron {
          position:absolute; inset-inline-end:12px; top:50%; width:16px; height:16px;
          transform:translateY(-50%); color:var(--muted); pointer-events:none;
        }
        .card-quote {
          flex:none; max-height:6em; margin:0 0 12px; padding:2px 0; padding-inline-start:12px;
          overflow-y:auto; border-inline-start:3px solid var(--border); color:var(--muted);
          font-size:14px; line-height:1.45; overflow-wrap:anywhere; white-space:pre-wrap;
        }
        .card-result { flex:1 1 auto; min-height:0; overflow-y:auto; overscroll-behavior:contain; overflow-wrap:anywhere; }
        .card-result.fade {
          -webkit-mask-image:linear-gradient(to bottom,#000 calc(100% - 32px),transparent);
          mask-image:linear-gradient(to bottom,#000 calc(100% - 32px),transparent);
        }
        .card-text.plain { white-space:pre-wrap; }
        .card-text p { margin:0 0 .6em; }
        .card-text ul,.card-text ol { margin:0 0 .6em; padding-inline-start:1.3em; }
        .card-text li { margin:.15em 0; }
        .card-text > :last-child { margin-bottom:0; }
        .card-text code {
          padding:1px 6px; border-radius:6px; background:var(--field);
          font:.9em ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
        }
        .card-skeleton i {
          display:block; height:12px; margin:9px 0; border-radius:6px; background:var(--field-strong);
          animation:wb-pulse 1.2s ease-in-out infinite;
        }
        .card-skeleton i:nth-child(1) { width:92%; }
        .card-skeleton i:nth-child(2) { width:78%; animation-delay:.12s; }
        .card-skeleton i:nth-child(3) { width:54%; animation-delay:.24s; }
        @keyframes wb-pulse { 50% { opacity:.45; } }
        .card-error { display:flex; flex-direction:column; align-items:flex-start; gap:6px; }
        .card-error-detail { color:var(--muted); font-size:13px; line-height:1.4; }
        .card-retry {
          padding:6px 12px; border:1px solid var(--border); border-radius:10px; background:transparent;
          color:var(--text); font-size:14px; font-weight:550; cursor:pointer;
        }
        .card-retry:hover { background:var(--hover); }
        .card-cut {
          display:flex; flex:none; flex-wrap:wrap; align-items:center; gap:6px 10px; margin-top:10px;
          color:var(--muted); font-size:13px; line-height:1.4;
        }
        .card-notice { flex:none; margin-top:10px; color:var(--muted); font-size:13px; line-height:1.4; }
        .card-continue {
          padding:5px 11px; border:1px solid var(--border); border-radius:10px; background:transparent;
          color:var(--text); font-size:13px; font-weight:550; cursor:pointer;
        }
        .card-continue:hover { background:var(--hover); }
        .followup {
          display:flex; flex:none; align-items:center; gap:8px; margin-top:12px;
          padding:5px 5px 5px 14px; border-radius:16px; background:var(--field);
        }
        .followup:focus-within { box-shadow:0 0 0 2px rgba(108,99,255,.34); }
        .followup-input {
          flex:1 1 auto; min-width:0; padding:6px 0; border:0; outline:none; background:transparent;
          color:var(--text); font-size:15px; line-height:1.4;
        }
        .followup-input::placeholder { color:var(--muted); }
        .followup-send {
          display:grid; flex:none; place-items:center; width:34px; height:34px; padding:0;
          border:0; border-radius:50%; background:var(--field-strong); color:var(--muted); cursor:default;
        }
        .followup-send:not(:disabled) { background:var(--accent); color:#fff; cursor:pointer; }
        .followup-send:not(:disabled):hover { background:var(--accent-strong); }
        .followup-send svg { width:16px; height:16px; }
        :host([dir="rtl"]) .lang-arrow,:host([dir="rtl"]) .followup-send svg { transform:scaleX(-1); }
        .bar-item:focus-visible,.action:focus-visible,.hide:focus-visible,.send:focus-visible,textarea:focus-visible,.context-option input:focus-visible,
        .lang-target:focus-visible,.card-retry:focus-visible,.followup-send:focus-visible {
          outline:3px solid rgba(108,99,255,.34); outline-offset:2px;
        }
        .bar-item:focus-visible { outline-offset:-2px; }
        .toast {
          position:fixed; left:50%; bottom:22px; max-width:min(440px,calc(100vw - 24px));
          transform:translateX(-50%); padding:10px 14px; border:1px solid var(--border);
          border-radius:12px; background:var(--bg); color:var(--text); box-shadow:var(--shadow);
          font:600 13px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
          pointer-events:none;
        }
        @media (prefers-color-scheme:dark) {
          :host {
            --bg:#20202a; --hover:#2d2c42; --text:#f5f4ff; --muted:#b5b3c7;
            --border:#444355; --field:#2a2a36; --field-strong:#383748;
            --shadow:0 18px 54px rgba(0,0,0,.46),0 3px 12px rgba(0,0,0,.28);
          }
        }
        @media (prefers-reduced-motion:reduce) { .card-skeleton i { animation:none; } }
      </style>
      <div class="selection-highlights" aria-hidden="true"></div>
      <div class="shortcut" role="toolbar" aria-label="Ask WebBrain about this" hidden>
        <button class="bar-item" type="button" data-inline="translate"><span class="bar-label">Translate</span></button>
        <span class="bar-sep" aria-hidden="true"></span>
        <button class="bar-item" type="button" data-inline="explain"><span class="bar-label">Explain</span></button>
        <span class="bar-sep" aria-hidden="true"></span>
        <button class="bar-item" type="button" data-inline="proofread"><span class="bar-label">Proofread</span></button>
        <span class="bar-sep" aria-hidden="true"></span>
        <button class="bar-item" type="button" data-more aria-haspopup="dialog" aria-expanded="false"><canvas class="more-brain" width="44" height="44" aria-hidden="true"></canvas><span class="bar-label">More…</span></button>
      </div>
      <div class="popup" role="dialog" aria-label="Ask WebBrain about this" hidden>
        <div class="main-view">
          <div class="actions">
            <button class="action" type="button" data-action="summarize">
              <svg class="action-icon" viewBox="0 0 20 20" fill="none" aria-hidden="true" focusable="false">
                <path d="M4 5h12M4 9h9M4 13h12M4 17h7"/>
              </svg>
              <span class="action-label">Summarize</span>
            </button>
            <button class="action" type="button" data-action="quiz">
              <svg class="action-icon" viewBox="0 0 20 20" fill="none" aria-hidden="true" focusable="false">
                <circle cx="10" cy="10" r="7"/>
                <path d="M7.8 7.8a2.5 2.5 0 0 1 4.8 1c0 1.8-2.6 2.1-2.6 3.7M10 15.5h.01"/>
              </svg>
              <span class="action-label">Quiz me</span>
            </button>
            <button class="action" type="button" data-action="humanize">
              <svg class="action-icon" viewBox="0 0 20 20" fill="none" aria-hidden="true" focusable="false">
                <circle cx="10" cy="7" r="2.5"/>
                <path d="M4.8 16.5C5.6 13.5 7.4 12 10 12s4.4 1.5 5.2 4.5"/>
              </svg>
              <span class="action-label">Humanize</span>
            </button>
          </div>
          <div class="question-wrap">
            <textarea maxlength="2000" rows="3" aria-label="Ask WebBrain a question" placeholder="Ask WebBrain…"></textarea>
            <button class="send" type="button" aria-label="Send question" disabled>
              <svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M4 10h11M11 6l4 4-4 4" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
            </button>
          </div>
          <label class="context-option">
            <input type="checkbox" checked>
            <span>Include page &amp; conversation context</span>
          </label>
          <div class="divider"></div>
          <div class="hide-row">
            <button class="hide" type="button">Hide this</button>
          </div>
        </div>
      </div>
      <div class="card" role="dialog" tabindex="-1" hidden>
        <div class="card-lang" hidden>
          <span class="lang-source">Auto-detect</span>
          <svg class="lang-arrow" viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M3 10h13M12 6l4 4-4 4" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>
          <span class="lang-select-wrap">
            <select class="lang-target" aria-label="Translate to"></select>
            <svg class="lang-chevron" viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M5 8l5 5 5-5" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>
          </span>
        </div>
        <blockquote class="card-quote" hidden></blockquote>
        <div class="card-result" aria-live="polite">
          <div class="card-skeleton" role="status" aria-label="Working…"><i></i><i></i><i></i></div>
          <div class="card-text" hidden></div>
          <div class="card-error" hidden>
            <span class="card-error-text">Could not get an answer.</span>
            <span class="card-error-detail" hidden></span>
            <button class="card-retry" type="button">Try again</button>
          </div>
        </div>
        <div class="card-cut" hidden>
          <span class="card-cut-text">This answer was cut off.</span>
          <button class="card-continue" type="button">Continue in side panel</button>
        </div>
        <div class="card-notice" role="status" hidden></div>
        <div class="followup">
          <input class="followup-input" type="text" maxlength="2000" aria-label="Ask a follow-up" placeholder="Ask a follow-up">
          <button class="followup-send" type="button" aria-label="Send follow-up" disabled>
            <svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M4 10h11M11 6l4 4-4 4" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
          </button>
        </div>
      </div>
      <div class="toast" role="status" aria-live="polite" hidden></div>
    `;

    highlightLayer = shadow.querySelector('.selection-highlights');
    shortcut = shadow.querySelector('.shortcut');
    moreButton = shadow.querySelector('[data-more]');
    popup = shadow.querySelector('.popup');
    question = shadow.querySelector('textarea');
    includePageContext = shadow.querySelector('.context-option input');
    sendButton = shadow.querySelector('.send');
    card = shadow.querySelector('.card');
    cardParts = {
      lang: shadow.querySelector('.card-lang'),
      source: shadow.querySelector('.lang-source'),
      target: shadow.querySelector('.lang-target'),
      quote: shadow.querySelector('.card-quote'),
      result: shadow.querySelector('.card-result'),
      skeleton: shadow.querySelector('.card-skeleton'),
      text: shadow.querySelector('.card-text'),
      error: shadow.querySelector('.card-error'),
      errorText: shadow.querySelector('.card-error-text'),
      errorDetail: shadow.querySelector('.card-error-detail'),
      retry: shadow.querySelector('.card-retry'),
      cut: shadow.querySelector('.card-cut'),
      cutText: shadow.querySelector('.card-cut-text'),
      continueButton: shadow.querySelector('.card-continue'),
      notice: shadow.querySelector('.card-notice'),
      followUp: shadow.querySelector('.followup-input'),
      send: shadow.querySelector('.followup-send'),
    };
    toast = shadow.querySelector('.toast');
    applyLocalization();

    shadow.querySelectorAll('[data-inline]').forEach((button) => {
      button.addEventListener('click', (event) => {
        if (event.isTrusted) openCard(button.dataset.inline, button);
      });
    });
    moreButton.addEventListener('click', (event) => {
      if (event.isTrusted && snapshot && !submitting) openPopup();
    });
    shadow.querySelectorAll('[data-action]').forEach((button) => {
      button.addEventListener('click', (event) => {
        if (!event.isTrusted) return;
        submitSelection(button.dataset.action, '', interfaceLanguage);
      });
    });
    question.addEventListener('input', () => {
      sendButton.disabled = !question.value.trim();
    });
    sendButton.addEventListener('click', (event) => {
      if (event.isTrusted) submitSelection('custom', question.value);
    });
    shadow.querySelector('.hide').addEventListener('click', (event) => {
      if (event.isTrusted) disableShortcut();
    });
    cardParts.target.addEventListener('change', () => {
      if (!cardState || !isSupportedTranslationLanguage(cardParts.target.value)) return;
      cardState.target = cardParts.target.value;
      if (snapshot?.text.length > INLINE_MAX_CHARS) {
        submitSelection('translate', '', cardState.target);
        return;
      }
      runInline();
    });
    cardParts.retry.addEventListener('click', (event) => {
      if (event.isTrusted) runInline();
    });
    cardParts.continueButton.addEventListener('click', (event) => {
      if (event.isTrusted) continueInPanel();
    });
    cardParts.followUp.addEventListener('input', syncFollowUpSend);
    cardParts.send.addEventListener('click', (event) => {
      if (event.isTrusted) submitFollowUp();
    });
    cardParts.result.addEventListener('scroll', updateResultFade);
    host.addEventListener('pointerdown', () => { interacting = true; }, true);
    host.addEventListener('pointerup', () => {
      setTimeout(() => { interacting = false; }, 0);
    }, true);
    (document.documentElement || document.body).appendChild(host);
    moreBrain = mountMoreBrain(moreButton.querySelector('.more-brain'));
  }

  function getVisibleSelectionBottom() {
    if (!snapshot) return 0;
    return (snapshot.rects || []).reduce(
      (bottom, selectionRect) => Math.max(bottom, selectionRect.bottom),
      snapshot.rect.bottom,
    );
  }

  function positionShortcut() {
    if (!snapshot || !shortcut) return;
    const rect = snapshot.rect;
    // Fractional size: offsetWidth rounds, which can overshoot the margin by a sub-pixel.
    const box = shortcut.getBoundingClientRect();
    const width = box.width;
    const height = box.height || TOOLBAR_HEIGHT;
    let left = rect.left + rect.width / 2 - width / 2;
    let top = rect.top - height - GAP;
    if (top < GAP) top = getVisibleSelectionBottom() + GAP;
    left = clamp(left, GAP, Math.max(GAP, window.innerWidth - width - GAP));
    top = clamp(top, GAP, Math.max(GAP, window.innerHeight - height - GAP));
    // Round down so the measured fractional width cannot cross the viewport margin.
    toolbarLeft = Math.floor(left);
    shortcut.style.left = `${toolbarLeft}px`;
    shortcut.style.top = `${Math.floor(top)}px`;
  }

  function positionPopup() {
    if (!popup || popup.hidden || !shortcut) return;
    const buttonRect = shortcut.getBoundingClientRect();
    const popupRect = popup.getBoundingClientRect();
    let left = buttonRect.left;
    let top = buttonRect.bottom + 8;
    if (top + popupRect.height > window.innerHeight - GAP) top = buttonRect.top - popupRect.height - 8;
    left = clamp(left, GAP, Math.max(GAP, window.innerWidth - popupRect.width - GAP));
    top = clamp(top, GAP, Math.max(GAP, window.innerHeight - popupRect.height - GAP));
    popup.style.left = `${Math.round(left)}px`;
    popup.style.top = `${Math.round(top)}px`;
  }

  // A card replaces the bar where it stood and grows away from the selection,
  // on the side with more room, so the selected text stays visible. The side is
  // chosen once per card; later content only changes its height.
  function chooseCardSide() {
    const roomAbove = snapshot.rect.top - GAP * 2;
    const roomBelow = window.innerHeight - getVisibleSelectionBottom() - GAP * 2;
    cardSide = roomAbove >= CARD_PREFERRED_HEIGHT || roomAbove >= roomBelow ? 'above' : 'below';
  }

  function positionCard() {
    if (!card || card.hidden || !snapshot) return;
    const room = cardSide === 'above'
      ? snapshot.rect.top - GAP * 2
      : window.innerHeight - getVisibleSelectionBottom() - GAP * 2;
    card.style.maxHeight = `${Math.round(clamp(room, 160, window.innerHeight - GAP * 2))}px`;
    const box = card.getBoundingClientRect();
    const width = box.width;
    const height = box.height;
    const left = clamp(toolbarLeft, GAP, Math.max(GAP, window.innerWidth - width - GAP));
    card.style.left = `${Math.floor(left)}px`;
    if (cardSide === 'above') {
      const bottom = clamp(window.innerHeight - (snapshot.rect.top - GAP), GAP, Math.max(GAP, window.innerHeight - height - GAP));
      card.style.top = 'auto';
      card.style.bottom = `${Math.floor(bottom)}px`;
    } else {
      const top = clamp(getVisibleSelectionBottom() + GAP, GAP, Math.max(GAP, window.innerHeight - height - GAP));
      card.style.bottom = 'auto';
      card.style.top = `${Math.floor(top)}px`;
    }
  }

  function clearSelectionHighlight() {
    highlightLayer?.replaceChildren();
  }

  function showSelectionHighlight() {
    clearSelectionHighlight();
    if (!highlightLayer || !snapshot) return;
    const rects = snapshot.rects?.length ? snapshot.rects : [snapshot.rect];
    for (const rect of rects) {
      const highlight = document.createElement('span');
      highlight.className = 'selection-highlight';
      highlight.style.left = `${rect.left}px`;
      highlight.style.top = `${rect.top}px`;
      highlight.style.width = `${rect.width}px`;
      highlight.style.height = `${rect.height}px`;
      highlightLayer.appendChild(highlight);
    }
  }

  const surfacePressedKeys = new Set();

  function containSurfaceKeyboardEvent(event) {
    const key = event.code || event.key;
    const onSurface = !!host && event.composedPath?.().includes(host);
    // Submitting/dismissing the dialog can move focus before the chord's
    // keyup. Its release still belongs to the dialog, not the underlying page.
    if (!onSurface && event.type === 'keydown') surfacePressedKeys.delete(key);
    const ownedRelease = event.type === 'keyup' && surfacePressedKeys.has(key);
    if (!onSurface && !ownedRelease) return;
    if (event.type === 'keydown' && event.isTrusted) surfacePressedKeys.add(key);
    if (event.type === 'keyup') surfacePressedKeys.delete(key);
    event.stopImmediatePropagation();
    if (event.type !== 'keydown') return;
    if (event.key === 'Escape') {
      event.preventDefault();
      if (!popup.hidden) closePopup(true);
      else if (!card.hidden) closeCard(true);
      else dismissSurface();
    } else if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && shadow?.activeElement === question) {
      event.preventDefault();
      submitSelection('custom', question.value);
    } else if (event.key === 'Enter' && !event.shiftKey && !event.altKey && !event.metaKey && !event.ctrlKey
        && !event.isComposing && event.keyCode !== 229 && shadow?.activeElement === cardParts.followUp) {
      // Enter confirms an IME composition; only a plain Enter sends the follow-up.
      event.preventDefault();
      submitFollowUp();
    }
  }

  function showShortcut(nextSnapshot) {
    ensureSurface();
    clearSelectionHighlight();
    resetCard();
    snapshot = nextSnapshot;
    popup.hidden = true;
    moreButton.setAttribute('aria-expanded', 'false');
    question.value = '';
    includePageContext.checked = true;
    sendButton.disabled = true;
    shortcut.hidden = false;
    positionShortcut();
    moreBrain?.play();
  }

  async function openPopup() {
    if (!snapshot || submitting) return;
    if (!localization) {
      // A card asked for while the language bundle loads is replaced by this popup, so
      // take a newer request id now: its continuation then stops, instead of starting a
      // paid model call that closeCard would only cancel a moment later.
      cardRequestId += 1;
      await refreshLocalization(interfaceLanguage);
    }
    if (!snapshot || submitting) return;
    ensureSurface();
    applyLocalization();
    if (!card.hidden) closeCard(false);
    popup.hidden = false;
    moreButton.setAttribute('aria-expanded', 'true');
    popup.style.visibility = 'hidden';
    positionPopup();
    popup.style.visibility = '';
    showSelectionHighlight();
    shadow.querySelector('[data-action="summarize"]')?.focus();
  }

  function closePopup(restoreFocus) {
    if (!popup) return;
    popup.hidden = true;
    moreButton.setAttribute('aria-expanded', 'false');
    question.value = '';
    includePageContext.checked = true;
    sendButton.disabled = true;
    clearSelectionHighlight();
    if (restoreFocus && shortcut && !shortcut.hidden) moreButton.focus();
  }

  // ---- Inline cards (Translate, Explain, Proofread) ----

  function populateTargetLanguages() {
    if (!cardParts) return;
    const select = cardParts.target;
    const options = TRANSLATION_LANGUAGES
      .map((code) => ({ code, label: languageName(code) || code }))
      .sort((a, b) => a.label.localeCompare(b.label, interfaceLanguage));
    // The placeholder is only chosen when the text is already in the interface
    // language and the person has not picked a target yet.
    const placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.disabled = true;
    placeholder.hidden = true;
    placeholder.textContent = str('translateTo');
    select.replaceChildren(placeholder, ...options.map(({ code, label }) => {
      const option = document.createElement('option');
      option.value = code;
      option.textContent = label;
      return option;
    }));
  }

  // Small, safe renderer for the model's answer: paragraphs, "- " and "1." lists,
  // **bold**, *italic* and `code`. Everything else stays plain text, and nothing is parsed as HTML.
  function appendInlineMarkup(parent, text) {
    const pattern = /`[^`\n]+`|\*\*[^*\n]+\*\*|\*[^*\s][^*\n]*\*/g;
    let last = 0;
    let match;
    while ((match = pattern.exec(text))) {
      if (match.index > last) parent.append(text.slice(last, match.index));
      const token = match[0];
      const code = token[0] === '`';
      const bold = token.startsWith('**');
      const element = document.createElement(code ? 'code' : bold ? 'strong' : 'em');
      element.textContent = token.slice(bold ? 2 : 1, bold ? -2 : -1);
      parent.append(element);
      last = match.index + token.length;
    }
    if (last < text.length) parent.append(text.slice(last));
  }

  function renderAnswer(container, text, markdown) {
    container.replaceChildren();
    container.classList.toggle('plain', !markdown);
    if (!markdown) {
      container.textContent = text;
      return;
    }
    let list = null;
    let paragraph = null;
    for (const rawLine of text.replace(/\r\n?/g, '\n').split('\n')) {
      const line = rawLine.trim();
      if (!line) {
        list = paragraph = null;
        continue;
      }
      const bullet = line.match(/^[-*•]\s+(.*)$/);
      const numbered = line.match(/^\d+[.)]\s+(.*)$/);
      if (bullet || numbered) {
        const tag = bullet ? 'ul' : 'ol';
        if (!list || list.localName !== tag) {
          list = document.createElement(tag);
          container.append(list);
        }
        paragraph = null;
        const item = document.createElement('li');
        appendInlineMarkup(item, (bullet || numbered)[1]);
        list.append(item);
        continue;
      }
      list = null;
      const heading = line.match(/^#{1,6}\s+(.*)$/);
      if (!paragraph) {
        paragraph = document.createElement('p');
        container.append(paragraph);
      } else {
        paragraph.append(document.createElement('br'));
      }
      if (heading) {
        const strong = document.createElement('strong');
        appendInlineMarkup(strong, heading[1]);
        paragraph.append(strong);
      } else {
        appendInlineMarkup(paragraph, line);
      }
    }
  }

  function updateResultFade() {
    if (!cardParts) return;
    const { result } = cardParts;
    result.classList.toggle('fade', result.scrollHeight - result.scrollTop - result.clientHeight > 4);
  }

  // Draws the card from cardState alone, so every change goes through here.
  function renderCard() {
    if (!card || !cardState) return;
    const { kind, status } = cardState;
    const parts = cardParts;
    card.setAttribute('aria-label', localization?.strings?.[kind] || kind);
    parts.lang.hidden = kind !== 'translate';
    parts.quote.hidden = kind !== 'translate';
    if (kind === 'translate') {
      parts.quote.textContent = cardState.quote;
      parts.source.textContent = cardState.sourceLabel || str('autoDetect');
      parts.target.value = cardState.target;
    }
    // A cut-off with no text has nothing to show or retry, so only the notice remains.
    const cutOffOnly = status === 'error' && cardState.truncated;
    parts.result.hidden = status === 'idle' || cutOffOnly;
    parts.result.setAttribute('aria-busy', status === 'loading' ? 'true' : 'false');
    parts.skeleton.hidden = status !== 'loading';
    parts.text.hidden = status !== 'ready';
    parts.error.hidden = status !== 'error' || cutOffOnly;
    parts.cut.hidden = !((status === 'ready' || cutOffOnly) && cardState.truncated);
    parts.notice.hidden = !(status !== 'loading' && cardState.notice);
    parts.notice.textContent = status !== 'loading' ? cardState.notice : '';
    if (status === 'ready') renderAnswer(parts.text, cardState.text, kind === 'explain');
    if (status === 'error') {
      parts.errorText.textContent = str('inlineFailed');
      parts.errorDetail.textContent = cardState.error;
      parts.errorDetail.hidden = !cardState.error;
    }
    syncFollowUpSend();
    positionCard();
    updateResultFade();
  }

  // A follow-up continues from the card's answer, so it can only be sent once there is one.
  // The field stays typeable meanwhile; sending while the answer is still loading would
  // cancel that request and ask a question with no answer behind it.
  function syncFollowUpSend() {
    if (!cardParts) return;
    cardParts.send.disabled = !(cardParts.followUp.value.trim() && cardState?.status === 'ready');
  }

  async function openCard(kind, opener) {
    if (!snapshot || submitting || !INLINE_ACTIONS.includes(kind)) return;
    if (kind !== 'translate' && snapshot.text.length > INLINE_MAX_CHARS) {
      // Too long for a card: the side panel is the better place to read it. This is
      // decided before anything is awaited, because the panel can only be opened
      // inside the click's user gesture, which the localization wait would outlive.
      submitSelection(kind, '', interfaceLanguage);
      return;
    }
    // Claim the card before anything is awaited: a second click while the
    // localization loads takes a newer id, so this call stops instead of opening
    // a second card and starting a second paid request.
    const requestId = ++cardRequestId;
    if (!localization) await refreshLocalization(interfaceLanguage);
    if (requestId !== cardRequestId || !snapshot || submitting) return;
    ensureSurface();
    applyLocalization();
    closePopup(false);
    cardOpener = opener || null;
    cardState = {
      kind,
      status: 'loading',
      target: kind === 'translate' ? interfaceLanguage : '',
      sourceLabel: '',
      quote: kind === 'translate' ? snapshot.text : '',
      text: '',
      truncated: false,
      notice: '',
      error: '',
    };
    cardParts.followUp.value = '';
    cardParts.send.disabled = true;
    shortcut.hidden = true;
    card.hidden = false;
    chooseCardSide();
    showSelectionHighlight();
    renderCard();
    // Focus stays inside the card so a selection change caused by the click
    // does not dismiss it, and Escape and Enter reach the card's handlers.
    card.focus({ preventScroll: true });
    if (kind === 'translate') {
      // Long selections go straight to the side panel, where an automatic target
      // could be a no-op. Require an explicit target rather than guessing.
      if (snapshot?.text.length > INLINE_MAX_CHARS) {
        cardState.status = 'idle';
        cardState.target = '';
        renderCard();
        cardParts.target.focus({ preventScroll: true });
        return;
      }
      const detected = await detectSourceLanguage(cardState?.quote || '');
      if (requestId !== cardRequestId || !cardState) return;
      cardState.sourceLabel = detected ? languageName(detected) : '';
      // Translating into the language the text is already in would only echo it,
      // so wait for the person to choose a target instead.
      if (detected && baseLanguage(detected) === cardState.target) {
        cardState.status = 'idle';
        cardState.target = '';
        renderCard();
        cardParts.target.focus({ preventScroll: true });
        return;
      }
    }
    runInline();
  }

  function newInlineJobId() {
    const bytes = new Uint8Array(12);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, (byte) => (byte % 36).toString(36)).join('');
  }

  // Tell the background to stop the model call the card no longer needs.
  function cancelInline() {
    const jobId = cardJobId;
    cardJobId = '';
    if (!jobId) return;
    try {
      Promise.resolve(api.runtime.sendMessage({ type: INLINE_CANCEL_MESSAGE, jobId })).catch(() => {});
    } catch { /* The call ends on its own timeout if the background is unreachable. */ }
  }

  async function runInline() {
    if (!cardState || !snapshot) return;
    // Retrying or retargeting replaces the call that is still running.
    cancelInline();
    const requestId = ++cardRequestId;
    const jobId = newInlineJobId();
    cardJobId = jobId;
    const { kind, target } = cardState;
    const selectionText = snapshot.text;
    cardState.status = 'loading';
    cardState.text = '';
    cardState.truncated = false;
    cardState.notice = '';
    cardState.error = '';
    renderCard();
    try {
      const response = await api.runtime.sendMessage({
        type: INLINE_MESSAGE,
        jobId,
        action: kind,
        selectionText,
        language: kind === 'translate' ? target : interfaceLanguage,
      });
      if (requestId !== cardRequestId || !cardState) return;
      cardJobId = '';
      let answer = typeof response?.text === 'string' ? response.text : '';
      cardState.truncated = response?.truncated === true;
      // This also applies to a textless cut-off, where it warns that continuing
      // in the panel would be blocked by the exhausted allowance.
      cardState.notice = typeof response?.notice === 'string' ? response.notice.slice(0, 300) : '';
      if (!response?.ok || !answer.trim()) {
        throw new Error(typeof response?.error === 'string' && !cardState.truncated ? response.error : '');
      }
      if (answer.length > INLINE_ANSWER_MAX_CHARS) {
        let end = INLINE_ANSWER_MAX_CHARS;
        const last = answer.charCodeAt(end - 1);
        if (last >= 0xd800 && last <= 0xdbff) end -= 1;
        answer = answer.slice(0, end);
        cardState.truncated = true;
      }
      cardState.status = 'ready';
      cardState.text = answer;
    } catch (error) {
      if (requestId !== cardRequestId || !cardState) return;
      cardJobId = '';
      cardState.status = 'error';
      cardState.error = String(error?.message || '').slice(0, 300);
    }
    renderCard();
  }

  function submitFollowUp() {
    const value = cardParts?.followUp.value.trim();
    if (!value || cardState?.status !== 'ready') return;
    // A follow-up continues in the side panel with the card's answer as context.
    // It takes the question box's default for page context, which is on whenever
    // that box is closed.
    submitSelection('custom', value, '', {
      priorAction: cardState.kind,
      priorAnswer: cardState.text,
    });
  }

  // A cut-off answer is finished in the side panel, where the reply is not capped. The
  // panel picks up from the unfinished text; running the action again would reach the
  // same limit. With no text to resume from, it starts the action over.
  function continueInPanel() {
    if (!cardState?.truncated) return;
    const { kind, target } = cardState;
    submitSelection(kind, '', kind === 'translate' ? target : interfaceLanguage, {
      continueFrom: cardState.text || '',
    });
  }

  // Forget the card without touching the bar; a request still in flight is cancelled and ignored.
  function resetCard() {
    cancelInline();
    cardRequestId += 1;
    cardState = null;
    cardOpener = null;
    if (!card) return;
    card.hidden = true;
    cardParts.followUp.value = '';
    cardParts.send.disabled = true;
  }

  function closeCard(restoreFocus) {
    if (!card || card.hidden) return;
    const opener = cardOpener;
    resetCard();
    clearSelectionHighlight();
    if (snapshot && shortcut) {
      shortcut.hidden = false;
      positionShortcut();
      if (restoreFocus) (opener?.isConnected ? opener : moreButton).focus();
    }
  }

  function dismissSurface() {
    clearSelectionHighlight();
    snapshot = null;
    resetCard();
    if (shortcut) shortcut.hidden = true;
    if (popup) popup.hidden = true;
    if (moreButton) moreButton.setAttribute('aria-expanded', 'false');
    if (question) question.value = '';
    if (includePageContext) includePageContext.checked = true;
    if (sendButton) sendButton.disabled = true;
  }

  function destroySurface() {
    hideToast();
    cancelInline();
    cardRequestId += 1;
    moreBrain?.destroy();
    moreBrain = null;
    host?.remove();
    host = shadow = highlightLayer = shortcut = moreButton = popup = question = includePageContext = sendButton = toast = null;
    card = cardParts = cardState = cardOpener = null;
    snapshot = null;
  }

  function hideToast() {
    clearTimeout(toastTimer);
    toastTimer = null;
    if (toast) toast.hidden = true;
  }

  function showToast(message) {
    if (suppressed) return;
    ensureSurface();
    toast.textContent = message;
    toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      if (toast) toast.hidden = true;
      toastTimer = null;
    }, 3800);
  }

  async function submitSelection(action, customQuestion = '', language = '', extra = {}) {
    if (submitting || !snapshot?.text) return;
    if (action === 'custom' && !String(customQuestion || '').trim()) return;
    if (action === 'translate' && !isSupportedTranslationLanguage(language)) return;
    const request = {
      ...currentSubmitFields(),
      type: SUBMIT_MESSAGE,
      action,
      selectionText: snapshot.text,
      question: action === 'custom' ? String(customQuestion).trim() : undefined,
      ...(action === 'custom' ? { includePageContext: includePageContext?.checked === true } : {}),
      // The earlier card answer a follow-up continues from; the background validates it.
      ...(action === 'custom' && extra.priorAnswer
        ? { priorAction: extra.priorAction, priorAnswer: extra.priorAnswer }
        : {}),
      // The unfinished text of a cut-off card answer, so the side panel resumes it.
      ...(action !== 'custom' && extra.continueFrom ? { continueFrom: extra.continueFrom } : {}),
      language: action === 'custom' ? undefined : (language || interfaceLanguage),
    };
    submitting = true;
    dismissSurface();
    try {
      const response = await api.runtime.sendMessage(request);
      if (!response?.ok) throw new Error(response?.error || 'Selection request was not accepted.');
      if (response.requiresManualOpen) showToast(localization?.strings.sentManual || 'Sent to WebBrain. Open the sidebar if it does not start.');
    } catch {
      showToast(localization?.strings.sendFailed || 'Could not send to WebBrain. Try the right-click menu instead.');
    } finally {
      submitting = false;
    }
  }

  function disableShortcut() {
    enabled = false;
    destroySurface();
    Promise.resolve(api.storage.local.set({ [STORAGE_KEY]: false })).catch(() => {});
  }

  function refreshFromSelection() {
    clearTimeout(selectionTimer);
    selectionTimer = setTimeout(() => {
      const next = readSelection();
      if (next) showShortcut(next);
      else if (!shadow?.activeElement && !interacting) dismissSurface();
    }, 0);
  }

  document.addEventListener('pointerup', (event) => {
    if (!event.composedPath?.().includes(host)) refreshFromSelection();
  }, true);
  document.addEventListener('keyup', (event) => {
    if (!event.composedPath?.().includes(host)) refreshFromSelection();
  }, true);
  document.addEventListener('pointerdown', (event) => {
    if (host && !event.composedPath?.().includes(host)) dismissSurface();
  }, true);
  document.addEventListener('selectionchange', () => {
    if (!interacting && !shadow?.activeElement) refreshFromSelection();
  });
  window.addEventListener('scroll', (event) => {
    if (!event.composedPath?.().includes(host)) dismissSurface();
  }, true);
  window.addEventListener('resize', dismissSurface);
  window.addEventListener('keydown', containSurfaceKeyboardEvent, true);
  window.addEventListener('keypress', containSurfaceKeyboardEvent, true);
  window.addEventListener('keyup', containSurfaceKeyboardEvent, true);
  window.addEventListener('blur', () => surfacePressedKeys.clear());
  // A reload, navigation or closed tab ends this page without closing the card, so the
  // model call it is waiting on would run to its timeout for an answer nobody can see.
  window.addEventListener('pagehide', () => {
    if (cardJobId) dismissSurface();
  });

  api.runtime.onMessage.addListener((message) => {
    if (message?.type === 'WB_HIDE_FOR_TOOL_USE') {
      suppressed = true;
      hideToast();
      dismissSurface();
    } else if (message?.type === 'WB_SHOW_AFTER_TOOL_USE') {
      suppressed = false;
    }
  });
  api.storage.onChanged?.addListener?.((changes, area) => {
    if (area !== 'local') return;
    if (changes[STORAGE_KEY]) {
      enabled = changes[STORAGE_KEY].newValue !== false;
      if (!enabled) destroySurface();
    }
    if (changes[LOCALE_STORAGE_KEY]) void refreshLocalization(changes[LOCALE_STORAGE_KEY].newValue);
  });
  Promise.resolve(api.storage.local.get({ [STORAGE_KEY]: true, [LOCALE_STORAGE_KEY]: '' }))
    .then((stored) => {
      enabled = stored?.[STORAGE_KEY] !== false;
      void refreshLocalization(stored?.[LOCALE_STORAGE_KEY]);
      if (!enabled) destroySurface();
    })
    .catch(() => { enabled = true; });

  function rectOf(selector) {
    return shadow?.querySelector(selector)?.getBoundingClientRect().toJSON() || null;
  }

  // Isolated-world diagnostic hook used by deterministic browser fixtures.
  window.__webbrainSelectionShortcut = {
    refreshFromSelection,
    openPopup,
    openInline: (kind) => openCard(kind, null),
    submitPreset: (action) => submitSelection(action, '', interfaceLanguage),
    submitCustom: (value) => submitSelection('custom', value),
    submitFollowUp: (value) => {
      if (cardParts) cardParts.followUp.value = value;
      submitFollowUp();
    },
    chooseTarget: (code) => {
      if (!cardParts) return;
      cardParts.target.value = code;
      cardParts.target.dispatchEvent(new Event('change'));
    },
    setIncludePageContext: (value) => {
      if (includePageContext) includePageContext.checked = value === true;
    },
    hideShortcut: disableShortcut,
    getState: () => ({
      enabled,
      suppressed,
      submitting,
      interfaceLanguage,
      hasSelection: !!snapshot?.text,
      shortcutVisible: !!shortcut && !shortcut.hidden,
      popupVisible: !!popup && !popup.hidden,
      highlightRectCount: highlightLayer?.childElementCount || 0,
      toastVisible: !!toast && !toast.hidden,
      shortcutRect: shortcut && !shortcut.hidden ? shortcut.getBoundingClientRect().toJSON() : null,
      selectionRect: snapshot?.rect || null,
      selectionBottom: snapshot ? getVisibleSelectionBottom() : null,
      shortcutLabel: shortcut?.getAttribute('aria-label') || '',
      shortcutBackground: shortcut ? getComputedStyle(shortcut).backgroundColor : '',
      shortcutColor: shortcut ? getComputedStyle(shortcut).color : '',
      shortcutBoxShadow: shortcut ? getComputedStyle(shortcut).boxShadow : '',
      barLabels: shortcut
        ? Array.from(shortcut.querySelectorAll('.bar-label'), (label) => label.textContent)
        : [],
      moreExpanded: moreButton?.getAttribute('aria-expanded') === 'true',
      moreRect: shortcut && !shortcut.hidden ? rectOf('[data-more]') : null,
      inlineRects: shortcut && !shortcut.hidden
        ? Object.fromEntries(INLINE_ACTIONS.map((kind) => [kind, rectOf(`[data-inline="${kind}"]`)]))
        : null,
      summarizeRect: popup && !popup.hidden ? rectOf('[data-action="summarize"]') : null,
      popupActions: popup
        ? Array.from(popup.querySelectorAll('[data-action]'), (button) => button.dataset.action)
        : [],
      hideRect: popup && !popup.hidden ? rectOf('.hide') : null,
      questionRect: popup && !popup.hidden ? question?.getBoundingClientRect().toJSON() || null : null,
      questionValue: question?.value || '',
      includePageContextChecked: includePageContext?.checked === true,
      includePageContextLabel: shadow?.querySelector('.context-option span')?.textContent || '',
      hideLabel: shadow?.querySelector('.hide')?.textContent || '',
      actionIconCount: shadow?.querySelectorAll('.action > .action-icon').length || 0,
      direction: host?.dir || 'ltr',
      summarizeLabel: shadow?.querySelector('[data-action="summarize"] .action-label')?.textContent || '',
      quizLabel: shadow?.querySelector('[data-action="quiz"] .action-label')?.textContent || '',
      cardVisible: !!card && !card.hidden,
      cardKind: cardState?.kind || '',
      cardStatus: cardState?.status || '',
      cardText: cardState?.text || '',
      cardError: cardState?.error || '',
      cardTargetOptions: cardParts ? cardParts.target.options.length : 0,
      cardSide,
      cardRect: card && !card.hidden ? card.getBoundingClientRect().toJSON() : null,
      cardSourceLabel: cardParts && !cardParts.lang.hidden ? cardParts.source.textContent : '',
      cardTarget: cardParts && !cardParts.lang.hidden ? cardParts.target.value : '',
      cardTargetLabel: cardParts && !cardParts.lang.hidden
        ? cardParts.target.selectedOptions[0]?.textContent || ''
        : '',
      cardTargetOptionCount: cardParts ? cardParts.target.options.length : 0,
      cardQuote: cardParts && !cardParts.quote.hidden ? cardParts.quote.textContent : '',
      cardHtml: cardParts && !cardParts.text.hidden ? cardParts.text.innerHTML : '',
      followUpRect: card && !card.hidden ? rectOf('.followup') : null,
      followUpSendRect: card && !card.hidden ? rectOf('.followup-send') : null,
      retryRect: cardParts && !cardParts.error.hidden ? rectOf('.card-retry') : null,
      cardTruncated: cardState?.truncated === true,
      cutNoticeText: cardParts && !cardParts.cut.hidden ? cardParts.cutText.textContent : '',
      cardNotice: cardParts && !cardParts.notice.hidden ? cardParts.notice.textContent : '',
      continueRect: cardParts && !cardParts.cut.hidden ? rectOf('.card-continue') : null,
      continueLabel: cardParts && !cardParts.cut.hidden ? cardParts.continueButton.textContent : '',
      followUpPlaceholder: cardParts?.followUp.placeholder || '',
      followUpValue: cardParts?.followUp.value || '',
      followUpSendDisabled: cardParts ? cardParts.send.disabled : true,
    }),
  };
})();
