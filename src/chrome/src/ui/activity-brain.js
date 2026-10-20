// The activity bar's working indicator: the WebBrain mark as a tiny neural
// circuit. A signal keeps tracing the W, the brain's outline brightens as it
// passes, and a few neurons on the outline fire at random. It animates only
// while the bar is shown and the panel is visible, and holds one still frame
// under prefers-reduced-motion. Purely decorative: #activity-live-status
// announces what the agent is doing.
//
// A canvas rather than SVG/CSS because each signal has a tapered tail drawn
// with additive light on dark themes; at 22px that reads as a spark, where a
// moving stroke dash reads as a line. The directions we explored before this
// one are kept in assets/loader-candidates/.

const TAU = Math.PI * 2;
// CSS box of the indicator; keep in sync with .activity-brain in sidepanel.css.
const SIZE = 22;

// Geometry in the mark's own unit space (x right, y down, the brain spans
// x −1…1), traced from assets/logo-mark.png: the W, and 72 points along the
// brain's lobed outline starting at the top centre and going counter-clockwise.
const W_PATH = [[-0.66, -0.38], [-0.34, 0.3], [0, -0.1], [0.34, 0.3], [0.66, -0.38]];
const OUTLINE = [
  0.00, -0.82, -0.07, -0.87, -0.15, -0.89, -0.24, -0.88, -0.31, -0.84, -0.38, -0.79,
  -0.47, -0.79, -0.54, -0.75, -0.60, -0.69, -0.65, -0.63, -0.73, -0.59, -0.79, -0.53,
  -0.83, -0.46, -0.84, -0.37, -0.91, -0.32, -0.95, -0.25, -0.97, -0.16, -0.95, -0.08,
  -0.97, -0.01, -1.00, 0.07, -0.99, 0.16, -0.96, 0.23, -0.90, 0.28, -0.86, 0.35,
  -0.82, 0.43, -0.75, 0.47, -0.66, 0.48, -0.61, 0.53, -0.56, 0.60, -0.49, 0.64,
  -0.40, 0.65, -0.31, 0.65, -0.23, 0.63, -0.22, 0.55, -0.15, 0.51, -0.06, 0.51,
  0.00, 0.47, 0.07, 0.51, 0.16, 0.51, 0.22, 0.55, 0.23, 0.63, 0.32, 0.65,
  0.41, 0.65, 0.49, 0.63, 0.56, 0.59, 0.61, 0.52, 0.66, 0.47, 0.74, 0.47,
  0.82, 0.43, 0.86, 0.35, 0.89, 0.28, 0.96, 0.23, 0.99, 0.16, 1.00, 0.07,
  0.97, -0.01, 0.95, -0.08, 0.97, -0.16, 0.95, -0.25, 0.90, -0.32, 0.84, -0.37,
  0.83, -0.46, 0.79, -0.53, 0.73, -0.59, 0.65, -0.63, 0.60, -0.69, 0.54, -0.75,
  0.47, -0.79, 0.38, -0.79, 0.31, -0.85, 0.24, -0.88, 0.15, -0.89, 0.07, -0.87,
];
const OUTLINE_NOTCH = 36; // the bottom centre, where the brainstem hangs
const SURFACE = [6, 18, 30, 42, 54, 66]; // outline points that fire on their own

const SWEEP_EVERY_S = 1.55;
const SWEEP_SPEED = 4.6; // mark units per second: one pass over the W takes ~0.65s
const REFRACTORY_S = 0.35;

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const mix = (a, b, t) => [0, 1, 2].map((i) => Math.round(a[i] + (b[i] - a[i]) * t));
const rgba = (c, a) => `rgba(${c[0]},${c[1]},${c[2]},${clamp(a, 0, 1).toFixed(3)})`;

function parseColor(value, fallback) {
  const text = String(value || '').trim();
  let m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(text);
  if (m) {
    const hex = m[1].length === 3 ? m[1].replace(/./g, '$&$&') : m[1];
    return [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16));
  }
  m = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/i.exec(text);
  return m ? [m[1], m[2], m[3]].map((n) => Math.round(Number(n))) : fallback;
}

// Colors come from the theme tokens, so a theme switch restyles the indicator.
function readPalette(root) {
  const style = getComputedStyle(root);
  const dark = root.getAttribute('data-theme') !== 'light';
  const accent = parseColor(style.getPropertyValue('--accent'), dark ? [108, 99, 255] : [91, 82, 232]);
  const line = parseColor(style.getPropertyValue('--text-secondary'), dark ? [160, 160, 184] : [107, 91, 71]);
  if (dark) return { dark, line, glow: mix(accent, [255, 255, 255], 0.12), hot: mix(accent, [255, 255, 255], 0.88) };
  // On cream, light can't be brighter than the page, so a signal's core is a deeper accent instead.
  return { dark, line, glow: accent, hot: [accent[0] * 0.57, accent[1] * 0.51, accent[2] * 0.82].map(Math.round) };
}

function glowDot(ctx, x, y, r, core, halo, a) {
  const g = ctx.createRadialGradient(x, y, 0, x, y, r);
  g.addColorStop(0, rgba(core, a));
  g.addColorStop(0.25, rgba(halo, a * 0.7));
  g.addColorStop(1, rgba(halo, 0));
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, TAU);
  ctx.fill();
}

// A tapered ribbon through pts (head first), filled with a head-to-tail gradient.
function ribbon(ctx, pts, width, alpha, color) {
  const left = [], right = [];
  pts.forEach((p, i) => {
    const p0 = pts[Math.max(0, i - 1)], p1 = pts[Math.min(pts.length - 1, i + 1)];
    const tl = Math.hypot(p1[0] - p0[0], p1[1] - p0[1]) || 1;
    const nx = -(p1[1] - p0[1]) / tl, ny = (p1[0] - p0[0]) / tl;
    const hw = width(i) / 2;
    left.push([p[0] + nx * hw, p[1] + ny * hw]);
    right.push([p[0] - nx * hw, p[1] - ny * hw]);
  });
  ctx.beginPath();
  left.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
  for (let i = right.length - 1; i >= 0; i--) ctx.lineTo(right[i][0], right[i][1]);
  ctx.closePath();
  const last = pts.length - 1;
  const g = ctx.createLinearGradient(pts[0][0], pts[0][1], pts[last][0], pts[last][1]);
  g.addColorStop(0, rgba(color(0), alpha(0)));
  g.addColorStop(1, rgba(color(last), alpha(last)));
  ctx.fillStyle = g;
  ctx.fill();
}

function createCircuit() {
  const half = SIZE * 0.42;
  const at = (x, y) => [SIZE / 2 + x * half, SIZE / 2 + y * half];
  const nodes = W_PATH.concat(SURFACE.map((k) => [OUTLINE[2 * k], OUTLINE[2 * k + 1]]))
    .map(([x, y], i) => ({ p: at(x, y), r: i < 5 ? 1.05 : 0.63, onW: i < 5, last: -9, flash: 0 }));
  const outline = [];
  for (let i = 0; i < OUTLINE.length; i += 2) outline.push(at(OUTLINE[i], OUTLINE[i + 1]));
  // The W's four strokes, each bent a little so the circuit doesn't look ruled.
  const strokes = [0, 1, 2, 3].map((i) => {
    const a = nodes[i].p, b = nodes[i + 1].p;
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const bend = (Math.random() - 0.5) * 0.14 * len;
    const ctl = [(a[0] + b[0]) / 2 - ((b[1] - a[1]) / len) * bend, (a[1] + b[1]) / 2 + ((b[0] - a[0]) / len) * bend];
    return { a: i, b: i + 1, ctl, len: len * 1.04, glow: 0 };
  });
  const point = (e, s) => {
    const a = nodes[e.a].p, b = nodes[e.b].p, u = 1 - s;
    return [u * u * a[0] + 2 * u * s * e.ctl[0] + s * s * b[0], u * u * a[1] + 2 * u * s * e.ctl[1] + s * s * b[1]];
  };

  let t = 0;
  let lastNow = null;
  let nextSweep = 0.1;
  let nextSpark = 0.25;
  let forwardNext = true;
  let outlineGlow = 0;
  let pulse = null; // the signal on the W: { stroke, forward, s }

  function fire(i, force) {
    const n = nodes[i];
    if (!force && t - n.last < REFRACTORY_S) return;
    n.last = t;
    n.flash = 1;
  }

  function advance(now) {
    const dt = lastNow == null ? 1 / 60 : clamp((now - lastNow) / 1000, 0, 0.05);
    lastNow = now;
    t += dt;
    if (t >= nextSweep) {
      // Each sweep runs the whole W, alternating direction.
      const forward = forwardNext;
      forwardNext = !forwardNext;
      fire(forward ? 0 : 4, true);
      outlineGlow = 1;
      pulse = { stroke: forward ? 0 : 3, forward, s: 0 };
      nextSweep = t + SWEEP_EVERY_S;
    }
    if (t >= nextSpark) {
      fire(Math.floor(Math.random() * nodes.length), false);
      nextSpark = t + 0.35 + Math.random() * 0.5;
    }
    if (pulse) {
      let e = strokes[pulse.stroke];
      pulse.s += ((SWEEP_SPEED * half) / e.len) * dt;
      e.glow = 1;
      while (pulse && pulse.s >= 1) {
        fire(pulse.forward ? e.b : e.a, true);
        const next = pulse.stroke + (pulse.forward ? 1 : -1);
        if (next < 0 || next > 3) {
          pulse = null;
          break;
        }
        const carried = (pulse.s - 1) * e.len;
        e = strokes[next];
        pulse = { stroke: next, forward: pulse.forward, s: carried / e.len };
        e.glow = 1;
      }
    }
    const flashDecay = Math.exp(-dt / 0.2);
    const glowDecay = Math.exp(-dt / 0.38);
    nodes.forEach((n) => { n.flash *= flashDecay; });
    strokes.forEach((e) => { e.glow *= glowDecay; });
    outlineGlow *= Math.exp(-dt / 0.7);
  }

  function draw(ctx, scale, pal, still) {
    ctx.setTransform(scale, 0, 0, scale, 0, 0);
    ctx.clearRect(0, 0, SIZE, SIZE);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    const lw = 0.9;
    const anatomy = rgba(pal.line, pal.dark ? 0.4 : 0.46);

    // The outline and the central fissure, from the top of the brain down to the W.
    ctx.beginPath();
    outline.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    ctx.closePath();
    ctx.moveTo(outline[0][0], outline[0][1] + half * 0.05);
    ctx.lineTo(nodes[2].p[0], nodes[2].p[1]);
    ctx.strokeStyle = anatomy;
    ctx.lineWidth = 0.8;
    ctx.stroke();
    if (!still && outlineGlow > 0.02) {
      ctx.strokeStyle = rgba(pal.glow, outlineGlow * (pal.dark ? 0.45 : 0.4));
      ctx.stroke();
    }
    const notch = outline[OUTLINE_NOTCH];
    ctx.beginPath();
    ctx.moveTo(notch[0], notch[1] + half * 0.04);
    ctx.lineTo(SIZE / 2, SIZE / 2 + half * 0.84);
    ctx.strokeStyle = anatomy;
    ctx.lineWidth = 1.7;
    ctx.stroke();

    // The W. A still frame keeps it softly lit so it still reads as working.
    strokes.forEach((e) => {
      const a = nodes[e.a].p, b = nodes[e.b].p;
      ctx.beginPath();
      ctx.moveTo(a[0], a[1]);
      ctx.quadraticCurveTo(e.ctl[0], e.ctl[1], b[0], b[1]);
      ctx.strokeStyle = rgba(pal.line, pal.dark ? 0.46 : 0.52);
      ctx.lineWidth = lw * 1.15;
      ctx.stroke();
      const glow = still ? 0.5 : e.glow;
      if (glow > 0.02) {
        ctx.strokeStyle = rgba(pal.glow, glow * (pal.dark ? 0.6 : 0.55));
        ctx.lineWidth = lw * 1.5;
        ctx.stroke();
      }
    });

    const light = pal.dark ? 'lighter' : 'source-over';
    if (!still && pulse) {
      ctx.globalCompositeOperation = light;
      const e = strokes[pulse.stroke];
      const head = pulse.forward ? pulse.s : 1 - pulse.s;
      const span = (SIZE * 0.3) / e.len;
      const pts = [point(e, head)];
      for (let k = 1; k <= 5; k++) {
        const s = head + ((pulse.forward ? -1 : 1) * span * k) / 5;
        if (s < 0 || s > 1) break;
        pts.push(point(e, s));
      }
      if (pts.length > 1) {
        ribbon(ctx, pts, (i) => lw * (2.4 - 1.8 * (i / 5)), (i) => (1 - i / 5) * 0.9, (i) => mix(pal.hot, pal.glow, i / 5));
      }
      glowDot(ctx, pts[0][0], pts[0][1], 2.1 * (pal.dark ? 1.7 : 1.3), pal.hot, pal.glow, pal.dark ? 1 : 0.9);
    }

    nodes.forEach((n) => {
      const f = still ? 0 : n.flash;
      if (f > 0.03) {
        ctx.globalCompositeOperation = light;
        glowDot(ctx, n.p[0], n.p[1], n.r * (2.6 + 3.2 * f), pal.hot, pal.glow, (pal.dark ? 0.9 : 0.42) * f);
      }
      ctx.globalCompositeOperation = 'source-over';
      ctx.beginPath();
      ctx.arc(n.p[0], n.p[1], n.r * (1 + 0.5 * f), 0, TAU);
      ctx.fillStyle = f > 0.05
        ? rgba(mix(pal.line, pal.hot, Math.min(1, f * 1.4)), 0.6 + 0.4 * f)
        : rgba(pal.line, n.onW ? (pal.dark ? 0.72 : 0.75) : pal.dark ? 0.32 : 0.38);
      ctx.fill();
    });
    ctx.globalCompositeOperation = 'source-over';
  }

  return {
    advance,
    draw,
    // After a pause, continue from where the circuit was instead of jumping ahead.
    resume() { lastNow = null; },
  };
}

/** Drive the `canvas.activity-brain` inside the activity bar. Returns `{ destroy }`. */
export function mountActivityBrain(bar) {
  const canvas = bar?.querySelector?.('canvas.activity-brain');
  let ctx = null;
  try { ctx = canvas?.getContext?.('2d') || null; } catch { ctx = null; }
  // Without a canvas the label still says what is happening; nothing else depends on this.
  if (!ctx) return { destroy() {} };

  const root = document.documentElement;
  const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)') || null;
  const circuit = createCircuit();
  let palette = readPalette(root);
  let scale = 2;
  let frame = 0;

  const shown = () => !bar.classList.contains('hidden') && document.visibilityState !== 'hidden';

  function restyle() {
    palette = readPalette(root);
    // Back the 22px box with enough pixels for the screen and the panel's UI zoom.
    const zoom = Number.parseFloat(getComputedStyle(root).getPropertyValue('--ui-scale-zoom')) || 1;
    scale = clamp((window.devicePixelRatio || 1) * zoom, 1, 4);
    const px = Math.round(SIZE * scale);
    if (canvas.width !== px) {
      canvas.width = px;
      canvas.height = px;
    }
  }

  function tick(now) {
    circuit.advance(now);
    circuit.draw(ctx, scale, palette, false);
    frame = requestAnimationFrame(tick);
  }

  function stop() {
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
  }

  function sync() {
    if (!shown()) {
      stop();
      return;
    }
    restyle();
    if (reduceMotion?.matches) {
      stop();
      circuit.draw(ctx, scale, palette, true);
      return;
    }
    if (!frame) {
      circuit.resume();
      frame = requestAnimationFrame(tick);
    }
  }

  const barWatch = new MutationObserver(sync);
  barWatch.observe(bar, { attributes: true, attributeFilter: ['class'] });
  // Theme switches and the panel's UI zoom both land on <html>.
  const rootWatch = new MutationObserver(sync);
  rootWatch.observe(root, { attributes: true, attributeFilter: ['data-theme', 'style'] });
  document.addEventListener('visibilitychange', sync);
  reduceMotion?.addEventListener?.('change', sync);
  sync();

  return {
    destroy() {
      stop();
      barWatch.disconnect();
      rootWatch.disconnect();
      document.removeEventListener('visibilitychange', sync);
      reduceMotion?.removeEventListener?.('change', sync);
    },
  };
}
