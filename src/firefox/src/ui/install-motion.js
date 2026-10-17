// Motion helpers for the first-install page. Everything here is progressive
// enhancement: the page is complete and readable without any of it, and each
// helper returns early (leaving the finished state showing) when the user asks
// for reduced motion or the browser lacks the needed API.

const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';

export function prefersReducedMotion(windowLike = globalThis.window) {
  try {
    return Boolean(windowLike?.matchMedia?.(REDUCED_MOTION_QUERY)?.matches);
  } catch {
    return false;
  }
}

/**
 * Reveal cards as they scroll in, and run each scene's looping animation only
 * while it is on screen. Offscreen loops would burn CPU on a page the user
 * will probably leave open in a background tab.
 */
export function initializeScenePlayback({
  documentLike = globalThis.document,
  windowLike = globalThis.window,
} = {}) {
  const root = documentLike?.documentElement;
  if (!root) return false;
  const scenes = Array.from(documentLike.querySelectorAll?.('.scene') || []);
  const reveals = Array.from(documentLike.querySelectorAll?.('[data-reveal]') || []);
  const Observer = windowLike?.IntersectionObserver;

  if (prefersReducedMotion(windowLike) || typeof Observer !== 'function') {
    for (const el of reveals) el.classList.add('is-revealed');
    for (const scene of scenes) scene.classList.add('is-playing');
    return false;
  }

  // Only now is it safe to hide [data-reveal] elements: the observer below is
  // guaranteed to bring them back.
  root.classList.add('js-motion');
  reveals.forEach((el, index) => el.style.setProperty('--rd', String(index % 3)));

  const revealObserver = new Observer((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      entry.target.classList.add('is-revealed');
      revealObserver.unobserve(entry.target);
    }
  }, { threshold: 0.12, rootMargin: '0px 0px -6% 0px' });
  for (const el of reveals) revealObserver.observe(el);

  const sceneObserver = new Observer((entries) => {
    for (const entry of entries) entry.target.classList.toggle('is-playing', entry.isIntersecting);
  }, { threshold: 0.3 });
  for (const scene of scenes) sceneObserver.observe(scene);
  return true;
}

/** Feed the pointer position to each card so its spotlight can follow it. */
export function initializeCardSpotlight({ documentLike = globalThis.document } = {}) {
  const cards = Array.from(documentLike?.querySelectorAll?.('.fcard') || []);
  for (const card of cards) {
    card.addEventListener('pointermove', (event) => {
      const rect = card.getBoundingClientRect();
      card.style.setProperty('--mx', `${Math.round(event.clientX - rect.left)}px`);
      card.style.setProperty('--my', `${Math.round(event.clientY - rect.top)}px`);
    });
  }
  return cards.length > 0;
}

export function formatClock(totalSeconds) {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  const minutes = Math.floor(seconds / 60);
  return `${String(minutes).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}

/** Tick the mock "REC" clock while the recording scene is on screen. */
export function startRecordingClock({
  documentLike = globalThis.document,
  windowLike = globalThis.window,
  startSeconds = 12 * 60 + 34,
} = {}) {
  const clocks = Array.from(documentLike?.querySelectorAll?.('[data-rec-timer]') || []);
  if (clocks.length === 0 || prefersReducedMotion(windowLike) || !windowLike?.setInterval) return null;
  let seconds = startSeconds;
  return windowLike.setInterval(() => {
    // Skip the tick (but keep the count) when the scene is paused offscreen.
    seconds += 1;
    for (const clock of clocks) {
      if (clock.closest?.('.scene')?.classList.contains('is-playing')) clock.textContent = formatClock(seconds);
    }
  }, 1000);
}

/**
 * Rotate the hero showcase tabs until the visitor takes over. The tab's CSS
 * progress bar drives the timing (its animationend moves to the next tab), so
 * hovering or focusing the showcase pauses it for free via animation-play-state.
 */
export function initializeShowcaseAutoplay({
  documentLike = globalThis.document,
  windowLike = globalThis.window,
  select,
  intervalMs = 7000,
} = {}) {
  const showcase = documentLike?.querySelector?.('.feature-showcase');
  const tabs = Array.from(documentLike?.querySelectorAll?.('[data-feature]') || []);
  if (!showcase || tabs.length < 2 || typeof select !== 'function') return () => {};
  if (prefersReducedMotion(windowLike)) return () => {};

  showcase.style.setProperty('--autoplay-ms', `${intervalMs}ms`);
  showcase.classList.add('is-autoplaying');

  const stop = () => {
    showcase.classList.remove('is-autoplaying', 'is-paused');
    showcase.removeEventListener('animationend', onProgressEnd);
    showcase.removeEventListener('pointerenter', pause);
    showcase.removeEventListener('pointerleave', resume);
    showcase.removeEventListener('focusin', pause);
    showcase.removeEventListener('focusout', resume);
  };
  const pause = () => showcase.classList.add('is-paused');
  const resume = () => showcase.classList.remove('is-paused');
  function onProgressEnd(event) {
    if (event.animationName !== 'tab-progress') return;
    const current = tabs.findIndex((tab) => tab.getAttribute('aria-selected') === 'true');
    select(tabs[(current + 1) % tabs.length].dataset.feature);
  }

  showcase.addEventListener('animationend', onProgressEnd);
  showcase.addEventListener('pointerenter', pause);
  showcase.addEventListener('pointerleave', resume);
  showcase.addEventListener('focusin', pause);
  showcase.addEventListener('focusout', resume);
  // A deliberate choice ends the rotation for good.
  for (const tab of tabs) {
    tab.addEventListener('click', stop, { once: true });
    tab.addEventListener('keydown', stop, { once: true });
  }
  return stop;
}

/**
 * The hero looks complete in a laptop-sized window, so nothing says the page
 * continues. A floating pill points down until the visitor finds the rest on
 * their own: it never appears if the next section is already in view, and it
 * goes for good once they scroll or click it. Returns a function that retires
 * it early.
 */
export function initializeScrollCue({
  documentLike = globalThis.document,
  windowLike = globalThis.window,
  delayMs = 1400,
  scrolledPx = 120,
} = {}) {
  const cue = documentLike?.querySelector?.('[data-scroll-cue]');
  const target = documentLike?.querySelector?.('.more-head');
  const Observer = windowLike?.IntersectionObserver;
  // Without the observer there is no way to tell when the cue stops being useful,
  // so leave it hidden rather than let it sit over the content.
  if (!cue || !target || typeof Observer !== 'function') return () => {};

  let finished = false;
  let revealTimer = null;
  const nextFrame = windowLike.requestAnimationFrame?.bind(windowLike) || ((fn) => fn());

  const observer = new Observer((entries) => {
    if (entries.some((entry) => entry.isIntersecting)) dismiss();
  }, { rootMargin: '0px 0px -12% 0px' });

  function dismiss() {
    if (finished) return;
    finished = true;
    windowLike.clearTimeout?.(revealTimer);
    observer.disconnect();
    windowLike.removeEventListener?.('scroll', onScroll);
    cue.removeEventListener?.('click', dismiss);
    cue.classList.remove('is-visible');
    // Leave the layout and the tab order once the fade has finished.
    windowLike.setTimeout(() => { cue.hidden = true; }, 400);
  }
  function onScroll() {
    if ((windowLike.scrollY || 0) > scrolledPx) dismiss();
  }

  windowLike.addEventListener?.('scroll', onScroll, { passive: true });
  cue.addEventListener('click', dismiss);
  observer.observe(target);
  revealTimer = windowLike.setTimeout(() => {
    if (finished) return;
    // A reload can restore a scroll position that is already past the hero.
    if ((windowLike.scrollY || 0) > scrolledPx) { dismiss(); return; }
    cue.hidden = false;
    // Next frame, so the fade-in transition actually runs.
    nextFrame(() => { if (!finished) cue.classList.add('is-visible'); });
  }, delayMs);
  return dismiss;
}
