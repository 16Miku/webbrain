// A small clock face that empties as an auto-timeout runs down: a ring that
// shrinks clockwise with a hand sweeping the removed part. It carries no text
// (the label next to it says what happens), so it needs no translation.
const SVG_NS = 'http://www.w3.org/2000/svg';
const RADIUS = 9;
export const TIMEOUT_RING_CIRCUMFERENCE = 2 * Math.PI * RADIUS;
// Below this share of the time (or this many seconds) the ring turns to the warning color.
const LOW_SHARE = 0.2;
const LOW_MS = 10_000;

function svgEl(name, attrs = {}) {
  const el = document.createElementNS(SVG_NS, name);
  for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, String(value));
  return el;
}

export function createTimeoutRing() {
  const ring = document.createElement('span');
  ring.className = 'timeout-ring';
  ring.setAttribute('aria-hidden', 'true');
  const svg = svgEl('svg', { viewBox: '0 0 24 24', width: 22, height: 22 });
  svg.append(
    svgEl('circle', { class: 'timeout-ring-track', cx: 12, cy: 12, r: RADIUS, fill: 'none', 'stroke-width': 3 }),
    svgEl('circle', {
      class: 'timeout-ring-progress', cx: 12, cy: 12, r: RADIUS, fill: 'none', 'stroke-width': 3, 'stroke-linecap': 'round',
      'stroke-dasharray': TIMEOUT_RING_CIRCUMFERENCE.toFixed(3), 'stroke-dashoffset': 0, transform: 'rotate(-90 12 12)',
    }),
    svgEl('line', { class: 'timeout-ring-hand', x1: 12, y1: 12, x2: 12, y2: 7, 'stroke-width': 2, 'stroke-linecap': 'round' }),
  );
  ring.appendChild(svg);
  return ring;
}

export function timeoutRingShare(remainingMs, totalMs) {
  const total = Number(totalMs);
  const remaining = Number(remainingMs);
  if (!Number.isFinite(total) || total <= 0 || !Number.isFinite(remaining)) return 0;
  return Math.max(0, Math.min(1, remaining / total));
}

export function formatTimeoutRingTime(remainingMs) {
  const seconds = Math.max(0, Math.ceil(Number(remainingMs) / 1000) || 0);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

export function updateTimeoutRing(ring, remainingMs, totalMs) {
  if (!ring) return;
  const share = timeoutRingShare(remainingMs, totalMs);
  const progress = ring.querySelector('.timeout-ring-progress');
  const hand = ring.querySelector('.timeout-ring-hand');
  if (progress) progress.setAttribute('stroke-dashoffset', (TIMEOUT_RING_CIRCUMFERENCE * (1 - share)).toFixed(3));
  if (hand) hand.setAttribute('transform', `rotate(${((1 - share) * 360).toFixed(1)} 12 12)`);
  ring.classList.toggle('timeout-ring-low', share <= LOW_SHARE || Number(remainingMs) <= LOW_MS);
  ring.title = formatTimeoutRingTime(remainingMs);
}
