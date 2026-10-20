/* WebBrain activity-indicator candidates (canvas 2D, no dependencies).
 *
 *   WBLoaders.synapse(canvas, opts)  neurons firing; a signal keeps re-tracing the W.
 *       size ≥ 48  the mark redrawn as a neural circuit (outline, fissure, stem, W)
 *       size < 48  opts.variant 'w' (default): the W alone
 *                  opts.variant 'brain': the W inside the traced brain outline
 *                  (this one shipped: src/<browser>/src/ui/activity-brain.js)
 *   WBLoaders.nucleus(canvas, opts)  the mono mark as a nucleus, sparks whizzing on
 *       precessing 3D orbits that pass behind and in front of it, plus short-lived
 *       sparks from random angles and embers at large sizes ("nuclear").
 *
 * opts: { size (CSS px the drawing is laid out for), theme: 'dark' | 'light',
 *         color: 'violet' | 'pink' | 'mono', speed (1 = normal), seed,
 *         nucleus only: orbits (default 3), mark, markSmall (SVG path data,
 *         viewBox 0 0 100 100; see marks.js) }
 * The canvas's bitmap width / size sets the pixel density, so give it
 * width = height = size × devicePixelRatio (or more).
 * Each call returns { frame(now) }: call it from requestAnimationFrame.
 */
(function (global) {
  const TAU = Math.PI * 2;
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const rgba = (c, a) => 'rgba(' + c[0] + ',' + c[1] + ',' + c[2] + ',' + clamp(a, 0, 1).toFixed(3) + ')';
  const mix = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t].map(Math.round);
  function rng(seed) {
    let a = seed | 0;
    return function () {
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // Colors from sidepanel.css tokens (dark = :root, light = [data-theme=light]).
  const THEMES = {
    dark: { ink: [232, 232, 232], line: [160, 160, 184], dark: true },
    light: { ink: [44, 24, 16], line: [107, 91, 71], dark: false },
  };
  const PALETTES = {
    violet: { dark: { a: [124, 116, 255], hot: [240, 238, 255] }, light: { a: [91, 82, 232], hot: [52, 42, 190] } },
    pink: { dark: { a: [255, 92, 157], hot: [255, 238, 245] }, light: { a: [214, 51, 120], hot: [150, 20, 80] } },
    mono: { dark: { a: [196, 196, 220], hot: [255, 255, 255] }, light: { a: [107, 91, 71], hot: [44, 24, 16] } },
  };

  // Tapered ribbon through pts[s..e] (head first), filled with a head→tail gradient.
  // Smooth where stroked segments would show joints.
  function ribbon(ctx, pts, s, e, wFn, aFn, colFn) {
    if (e - s < 1) return;
    const Lx = [], Ly = [], Rx = [], Ry = [];
    for (let i = s; i <= e; i++) {
      const p0 = pts[Math.max(0, i - 1)], p1 = pts[Math.min(pts.length - 1, i + 1)];
      let tx = p1[0] - p0[0], ty = p1[1] - p0[1];
      const tl = Math.hypot(tx, ty) || 1;
      tx /= tl; ty /= tl;
      const hw = wFn(i) / 2;
      Lx.push(pts[i][0] - ty * hw); Ly.push(pts[i][1] + tx * hw);
      Rx.push(pts[i][0] + ty * hw); Ry.push(pts[i][1] - tx * hw);
    }
    ctx.beginPath();
    ctx.moveTo(Lx[0], Ly[0]);
    for (let i = 1; i < Lx.length; i++) ctx.lineTo(Lx[i], Ly[i]);
    for (let i = Rx.length - 1; i >= 0; i--) ctx.lineTo(Rx[i], Ry[i]);
    ctx.closePath();
    const m = Math.round((s + e) / 2);
    const g = ctx.createLinearGradient(pts[s][0], pts[s][1], pts[e][0], pts[e][1]);
    g.addColorStop(0, rgba(colFn(s), aFn(s)));
    if (m > s && m < e) g.addColorStop(0.5, rgba(colFn(m), aFn(m)));
    g.addColorStop(1, rgba(colFn(e), aFn(e)));
    ctx.fillStyle = g;
    ctx.fill();
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

  /* ───────────────────────── A · SİNAPS ───────────────────────── */
  function synapse(canvas, o) {
    const size = o.size;
    const themeName = o.theme || 'dark';
    const T = THEMES[themeName];
    const C = PALETTES[o.color || 'violet'][themeName];
    const ctx = canvas.getContext('2d');
    const dpr = canvas.width / size;
    const rnd = rng(o.seed || 11);
    const small = size < 48;
    const speed = o.speed || 1;

    // The WebBrain mark redrawn as a neural circuit, in the mark's own unit space
    // (x right, y down, brain spans x −1…1): 0-4 the W the signal keeps tracing,
    // 5-22 neurons sampled along the traced brain outline, 23 the central fissure,
    // 24-27 interior neurons, 28-29 the brainstem.
    const HERO_NODES = [
      [-0.66, -0.38], [-0.34, 0.3], [0, -0.1], [0.34, 0.3], [0.66, -0.38],
      [0, -0.77], [-0.29, -0.79], [-0.55, -0.65], [-0.76, -0.44], [-0.89, -0.17], [-0.92, 0.12], [-0.76, 0.37], [-0.52, 0.53], [-0.22, 0.57],
      [0, 0.44], [0.22, 0.57], [0.52, 0.54], [0.75, 0.38], [0.91, 0.13], [0.89, -0.17], [0.76, -0.44], [0.55, -0.65], [0.29, -0.79],
      [0, -0.44], [-0.36, -0.5], [0.36, -0.5], [-0.62, 0.12], [0.62, 0.12], [0, 0.64], [0, 0.82],
    ];
    const HERO_EDGES = [
      [23, 5], [23, 2], [24, 7], [24, 23], [24, 0], [25, 21], [25, 23], [25, 4],
      [26, 10], [26, 11], [26, 1], [26, 9], [27, 18], [27, 17], [27, 3], [27, 19],
      [0, 8], [4, 20], [1, 13], [3, 15], [14, 28], [28, 29],
    ];
    const W_SMALL = [[-0.84, -0.52], [-0.42, 0.5], [0, -0.1], [0.42, 0.5], [0.84, -0.52]];
    // 1× brain variant: the brain's own lobed outline (traced from the mark, 72 points),
    // the central fissure and the stem drawn as anatomy; the W and six surface neurons fire.
    const BRAIN_OUTLINE = [0.00, -0.82, -0.07, -0.87, -0.15, -0.89, -0.24, -0.88, -0.31, -0.84, -0.38, -0.79, -0.47, -0.79, -0.54, -0.75, -0.60, -0.69, -0.65, -0.63, -0.73, -0.59, -0.79, -0.53, -0.83, -0.46, -0.84, -0.37, -0.91, -0.32, -0.95, -0.25, -0.97, -0.16, -0.95, -0.08, -0.97, -0.01, -1.00, 0.07, -0.99, 0.16, -0.96, 0.23, -0.90, 0.28, -0.86, 0.35, -0.82, 0.43, -0.75, 0.47, -0.66, 0.48, -0.61, 0.53, -0.56, 0.60, -0.49, 0.64, -0.40, 0.65, -0.31, 0.65, -0.23, 0.63, -0.22, 0.55, -0.15, 0.51, -0.06, 0.51, 0.00, 0.47, 0.07, 0.51, 0.16, 0.51, 0.22, 0.55, 0.23, 0.63, 0.32, 0.65, 0.41, 0.65, 0.49, 0.63, 0.56, 0.59, 0.61, 0.52, 0.66, 0.47, 0.74, 0.47, 0.82, 0.43, 0.86, 0.35, 0.89, 0.28, 0.96, 0.23, 0.99, 0.16, 1.00, 0.07, 0.97, -0.01, 0.95, -0.08, 0.97, -0.16, 0.95, -0.25, 0.90, -0.32, 0.84, -0.37, 0.83, -0.46, 0.79, -0.53, 0.73, -0.59, 0.65, -0.63, 0.60, -0.69, 0.54, -0.75, 0.47, -0.79, 0.38, -0.79, 0.31, -0.85, 0.24, -0.88, 0.15, -0.89, 0.07, -0.87];
    const brainSmall = small && o.variant === 'brain';
    const SURFACE = [6, 18, 30, 42, 54, 66];
    const layout = small
      ? (brainSmall ? HERO_NODES.slice(0, 5).concat(SURFACE.map(function (k) { return [BRAIN_OUTLINE[2 * k], BRAIN_OUTLINE[2 * k + 1]]; })) : W_SMALL)
      : HERO_NODES;
    const half = small ? size * (brainSmall ? 0.42 : 0.4) : size * 0.42;
    const cx = size / 2, cy = size / 2 + (small ? 0 : size * 0.01);
    const nodes = layout.map(function (p, i) {
      return {
        x0: cx + p[0] * half, y0: cy + p[1] * half,
        x: 0, y: 0, edges: [], last: -9, flash: 0, ringAge: 9, dend: [],
        k: small ? (brainSmall && i >= 5 ? 0.6 : 1) : i < 5 ? 1.15 : 0.75 + rnd() * 0.45, ph: rnd() * TAU, spine: i < 5,
      };
    });
    nodes.forEach(function (n) { n.x = n.x0; n.y = n.y0; });
    const ocx = cx, ocy = cy - 0.12 * half; // outline centre, for outward lobes

    const edges = [];
    function addEdge(i, j, kind) {
      const a = nodes[i], b = nodes[j];
      const len = Math.hypot(b.x0 - a.x0, b.y0 - a.y0);
      let bx, by;
      if (kind === 'outline') {
        const mx = (a.x0 + b.x0) / 2 - ocx, my = (a.y0 + b.y0) / 2 - ocy;
        const ml = Math.hypot(mx, my) || 1;
        bx = (mx / ml) * len * 0.2; by = (my / ml) * len * 0.2;
      } else {
        const nx = -(b.y0 - a.y0) / len, ny = (b.x0 - a.x0) / len;
        const bend = kind === 'straight' ? 0 : (rnd() - 0.5) * (kind === 'spine' ? 0.14 : 0.42) * len;
        bx = nx * bend; by = ny * bend;
      }
      edges.push({ a: i, b: j, bx: bx, by: by, glow: 0, len: len * 1.04, spine: kind === 'spine', outline: kind === 'outline' });
      nodes[i].edges.push(edges.length - 1);
      nodes[j].edges.push(edges.length - 1);
      return edges.length - 1;
    }
    const spineEdge = [];
    for (let i = 0; i < 4; i++) spineEdge.push(addEdge(i, i + 1, 'spine'));
    const outlinePx = [];
    if (brainSmall) for (let i = 0; i < BRAIN_OUTLINE.length; i += 2) outlinePx.push([cx + BRAIN_OUTLINE[i] * half, cy + BRAIN_OUTLINE[i + 1] * half]);
    let brainGlow = 0;
    if (!small) {
      for (let i = 0; i < 18; i++) addEdge(5 + i, 5 + ((i + 1) % 18), 'outline');
      HERO_EDGES.forEach(function (e) { addEdge(e[0], e[1], 'inner'); });
      nodes.forEach(function (n) {
        const cnt = 2 + Math.floor(rnd() * 2);
        for (let q = 0; q < cnt; q++) {
          const ang = rnd() * TAU;
          const L = size * (0.022 + rnd() * 0.028);
          const bend = (rnd() - 0.5) * 0.9;
          n.dend.push({ dx: Math.cos(ang) * L, dy: Math.sin(ang) * L, cx: Math.cos(ang + bend) * L * 0.55, cy: Math.sin(ang + bend) * L * 0.55 });
        }
      });
    }

    function qpt(e, s) {
      const a = nodes[e.a], b = nodes[e.b], u = 1 - s;
      const ccx = (a.x + b.x) / 2 + e.bx, ccy = (a.y + b.y) / 2 + e.by;
      return [u * u * a.x + 2 * u * s * ccx + s * s * b.x, u * u * a.y + 2 * u * s * ccy + s * s * b.y];
    }

    const pulses = [];
    const REFRACT = small ? 0.35 : 0.5;
    const MAXP = small ? 4 : 12;
    const unit = half; // px per unit
    let nextSpont = 0.25;
    let nextSweep = small ? 0.1 : 0.6;
    let sweepDir = 1;

    function spawn(ei, from, v, route) {
      pulses.push({ e: ei, from: from, s: route ? 0 : -rnd() * 0.08, v: v / edges[ei].len, route: route || null });
    }
    function fire(ni, fromEdge, t, branch) {
      const n = nodes[ni];
      const fresh = t - n.last >= REFRACT;
      if (!fresh && !branch) return;
      n.last = t;
      n.flash = 1;
      if (fromEdge === -1) n.ringAge = 0; // ripple only where a spike originates
      if (!fresh || small) return;
      const p = pulses.length >= MAXP ? 0.1 : pulses.length < 3 ? 0.8 : 0.5;
      n.edges.forEach(function (ei) {
        if (ei === fromEdge || edges[ei].spine) return;
        if (rnd() < p) spawn(ei, ni, unit * 2.1 * (0.8 + rnd() * 0.45));
      });
    }

    let t = 0;
    let lastNow = null;
    function frame(now) {
      const dt = lastNow == null ? 0.016 : clamp((now - lastNow) / 1000, 0, 0.05) * speed;
      lastNow = now;
      t += dt;

      if (!small) nodes.forEach(function (n) { n.x = n.x0 + Math.sin(t * 0.7 + n.ph) * size * 0.004; n.y = n.y0 + Math.cos(t * 0.55 + n.ph * 1.3) * size * 0.004; });

      // the W sweep: a signal runs the spine end to end, alternating direction
      if (t >= nextSweep) {
        const route = sweepDir > 0 ? [0, 1, 2, 3, 4] : [4, 3, 2, 1, 0];
        sweepDir = -sweepDir;
        fire(route[0], -1, t, true);
        brainGlow = 1;
        const ei = spineEdge[sweepDir < 0 ? 0 : 3];
        spawn(ei, route[0], unit * (small ? 4.6 : 3.4), { path: route, i: 1 });
        nextSweep = t + (small ? 1.55 : 2.3);
      }
      if (t >= nextSpont) {
        const pool = nodes.length;
        fire(Math.floor(rnd() * pool), -1, t, false);
        nextSpont = t + (small ? 0.35 + rnd() * 0.5 : (pulses.length > 4 ? 0.5 : 0.14) + rnd() * 0.36);
      }
      for (let i = pulses.length - 1; i >= 0; i--) {
        const p = pulses[i];
        p.s += p.v * dt;
        const e = edges[p.e];
        if (p.s > 0) e.glow = Math.max(e.glow, p.route ? 1 : 0.85);
        if (p.s >= 1) {
          pulses.splice(i, 1);
          const to = e.a === p.from ? e.b : e.a;
          if (p.route) {
            fire(to, p.e, t, true);
            const r = p.route;
            if (r.i < r.path.length - 1) {
              const nxt = r.path[r.i + 1];
              const ei = spineEdge[Math.min(to, nxt)];
              pulses.push({ e: ei, from: to, s: p.s - 1, v: (p.v * e.len) / edges[ei].len, route: { path: r.path, i: r.i + 1 } });
            }
          } else fire(to, p.e, t, false);
        }
      }
      const fd = Math.exp(-dt / 0.2), gd = Math.exp(-dt / (small ? 0.38 : 0.45));
      nodes.forEach(function (n) { n.flash *= fd; n.ringAge += dt; });
      edges.forEach(function (e) { e.glow *= gd; });
      brainGlow *= Math.exp(-dt / 0.7);

      // ── draw
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, size, size);
      ctx.lineCap = 'round';
      const lw = small ? 0.9 : clamp(size * 0.004, 0.6, 1.5);
      const baseA = T.dark ? (small ? 0.3 : 0.15) : small ? 0.36 : 0.2;
      const spineA = T.dark ? (small ? 0.46 : 0.3) : small ? 0.52 : 0.36;
      const outlineA = T.dark ? 0.21 : 0.27;

      if (brainSmall) {
        const top = outlinePx[0], bot = outlinePx[36];
        ctx.beginPath();
        ctx.moveTo(outlinePx[0][0], outlinePx[0][1]);
        for (let i = 1; i < outlinePx.length; i++) ctx.lineTo(outlinePx[i][0], outlinePx[i][1]);
        ctx.closePath();
        ctx.moveTo(top[0], top[1] + half * 0.05);
        ctx.lineTo(nodes[2].x, nodes[2].y);
        ctx.lineJoin = 'round';
        ctx.strokeStyle = rgba(T.line, T.dark ? 0.4 : 0.46);
        ctx.lineWidth = 0.8;
        ctx.stroke();
        if (brainGlow > 0.02) {
          ctx.strokeStyle = rgba(C.a, brainGlow * (T.dark ? 0.45 : 0.4));
          ctx.stroke();
        }
        ctx.beginPath();
        ctx.moveTo(bot[0], bot[1] + half * 0.04);
        ctx.lineTo(cx, cy + half * 0.84);
        ctx.strokeStyle = rgba(T.line, T.dark ? 0.4 : 0.46);
        ctx.lineWidth = 1.7;
        ctx.stroke();
      }
      edges.forEach(function (e) {
        const a = nodes[e.a], b = nodes[e.b];
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.quadraticCurveTo((a.x + b.x) / 2 + e.bx, (a.y + b.y) / 2 + e.by, b.x, b.y);
        ctx.strokeStyle = rgba(T.line, e.spine ? spineA : e.outline ? outlineA : baseA);
        ctx.lineWidth = e.spine ? lw * 1.15 : lw;
        ctx.stroke();
        if (e.glow > 0.02) {
          ctx.strokeStyle = rgba(C.a, e.glow * (T.dark ? 0.6 : 0.55));
          ctx.lineWidth = lw * (e.spine ? 1.5 : 1.25);
          ctx.stroke();
        }
      });
      nodes.forEach(function (n) {
        n.dend.forEach(function (d) {
          ctx.beginPath();
          ctx.moveTo(n.x, n.y);
          ctx.quadraticCurveTo(n.x + d.cx, n.y + d.cy, n.x + d.dx, n.y + d.dy);
          ctx.strokeStyle = n.flash > 0.05 ? rgba(mix(T.line, C.a, n.flash), baseA + n.flash * 0.6) : rgba(T.line, baseA);
          ctx.lineWidth = lw * 0.8;
          ctx.stroke();
        });
      });

      const add = T.dark ? 'lighter' : 'source-over';
      ctx.globalCompositeOperation = add;
      const tailPx = small ? size * 0.3 : size * 0.12;
      const headR = small ? 2.1 : clamp(size * 0.022, 1.5, 6);
      pulses.forEach(function (p) {
        if (p.s <= 0) return;
        const e = edges[p.e];
        const fwd = e.a === p.from;
        const sH = fwd ? p.s : 1 - p.s;
        const span = tailPx / e.len;
        const N = small ? 5 : 8;
        const pts = [qpt(e, sH)];
        for (let k2 = 1; k2 <= N; k2++) {
          const sk = fwd ? sH - (span * k2) / N : sH + (span * k2) / N;
          if (sk < 0 || sk > 1) break;
          pts.push(qpt(e, sk));
        }
        if (pts.length > 1) {
          ribbon(ctx, pts, 0, pts.length - 1,
            function (i) { return lw * (2.4 - 1.8 * (i / N)); },
            function (i) { return (1 - i / N) * 0.9; },
            function (i) { return mix(C.hot, C.a, i / N); });
        }
        glowDot(ctx, pts[0][0], pts[0][1], headR * (T.dark ? 1.7 : 1.3), C.hot, C.a, T.dark ? 1 : 0.9);
      });

      const rb = small ? 1.05 : clamp(size * 0.012, 0.85, 3.4);
      nodes.forEach(function (n) {
        const f = n.flash;
        const r = rb * n.k;
        ctx.globalCompositeOperation = add;
        if (f > 0.03) {
          glowDot(ctx, n.x, n.y, r * (small ? 2.6 + 3.2 * f : 3.2 + 6.5 * f), C.hot, C.a, (T.dark ? 0.9 : 0.42) * f);
          if (!small && n.ringAge < 0.55) {
            const ra = n.ringAge / 0.55;
            ctx.beginPath();
            ctx.arc(n.x, n.y, r * 2 + ra * size * (T.dark ? 0.085 : 0.06), 0, TAU);
            ctx.strokeStyle = rgba(C.a, (1 - ra) * (1 - ra) * (T.dark ? 0.55 : 0.35));
            ctx.lineWidth = Math.max(0.6, size * 0.003);
            ctx.stroke();
          }
        }
        ctx.globalCompositeOperation = 'source-over';
        ctx.beginPath();
        ctx.arc(n.x, n.y, r * (1 + 0.5 * f), 0, TAU);
        ctx.fillStyle = f > 0.05
          ? rgba(mix(T.line, C.hot, Math.min(1, f * 1.4)), 0.6 + 0.4 * f)
          : rgba(T.line, T.dark ? (n.spine ? 0.72 : brainSmall ? 0.32 : 0.5) : n.spine ? 0.75 : brainSmall ? 0.38 : 0.55);
        ctx.fill();
      });
      ctx.globalCompositeOperation = 'source-over';
    }
    return { frame: frame };
  }

  /* ───────────────────────── B · ÇEKİRDEK ───────────────────────── */
  function nucleus(canvas, o) {
    const size = o.size;
    const themeName = o.theme || 'dark';
    const T = THEMES[themeName];
    const C = PALETTES[o.color || 'violet'][themeName];
    const ctx = canvas.getContext('2d');
    const dpr = canvas.width / size;
    const rnd = rng(o.seed || 5);
    const small = size < 48;
    const speed = o.speed || 1;
    const mark = new Path2D(small ? o.markSmall || o.mark : o.mark);
    const markPx = size * (small ? 0.62 : 0.46);
    const R = size * (small ? 0.44 : 0.4);
    const cx = size / 2, cy = size / 2;
    const count = o.orbits || 3;

    // persistent orbits (atom-like, 180°/n apart, precessing together)
    const orbits = [];
    for (let i = 0; i < count; i++) {
      orbits.push({
        inc: 1.2 + (rnd() - 0.5) * 0.12,
        phi0: (i * Math.PI) / count + 0.35,
        w: TAU * (1.15 + rnd() * 0.55) * (i % 2 ? -1 : 1),
        th0: rnd() * TAU,
        prec: 0.32,
        wob: rnd() * TAU,
      });
    }
    const transients = []; // short-lived sparks on random planes — "from every angle"
    let nextT = 0.4;
    const embers = [];

    function pos(ob, tt) {
      const th = ob.th0 + ob.w * tt;
      const inc = ob.inc + 0.14 * Math.sin(tt * 0.9 + ob.wob);
      const phi = ob.phi0 + ob.prec * tt;
      const x = R * Math.cos(th), y = R * Math.sin(th);
      const y2 = y * Math.cos(inc), z = y * Math.sin(inc);
      return [cx + x * Math.cos(phi) - y2 * Math.sin(phi), cy + x * Math.sin(phi) + y2 * Math.cos(phi), z / R];
    }

    let t = 0;
    let lastNow = null;
    const J = small ? 10 : 18;
    const DT = small ? 0.014 : 0.011;
    const w0 = small ? 1.5 : clamp(size * 0.032, 1.2, 4.6);
    const headR = small ? 2.1 : clamp(size * 0.03, 1.7, 7.5);
    const add = T.dark ? 'lighter' : 'source-over';

    function depthA(z) { return z < 0 ? 0.3 + 0.42 * (1 + z) : 0.86 + 0.14 * z; }
    function depthW(z) { return z < 0 ? 0.76 + 0.16 * (1 + z) : 1 + 0.22 * z; }

    // one spark = head + J trail samples; segments are split into back/front runs by depth
    function drawSpark(sp, front, overMark) {
      const P = sp.pts;
      let s = -1;
      for (let j = 0; j < J; j++) {
        const zf = (P[j][2] + P[j + 1][2]) / 2 >= 0;
        if (zf === front) { if (s < 0) s = j; }
        if ((zf !== front || j === J - 1) && s >= 0) {
          const e = zf === front ? j + 1 : j;
          run(P, s, e, sp.env, overMark);
          s = -1;
        }
      }
    }
    function run(P, s, e, env, overMark) {
      const u = function (i) { return i / J; };
      const aF = function (i) { return Math.pow(1 - u(i), 1.5) * depthA(P[i][2]) * env; };
      const wF = function (i) { return (w0 * Math.pow(1 - u(i), 0.8) + 0.3) * depthW(P[i][2]); };
      if (overMark) {
        ribbon(ctx, P, s, e, function (i) { return wF(i) * 1.15; }, function (i) { return aF(i) * 0.95; }, function () { return C.a; });
        return;
      }
      if (T.dark) ribbon(ctx, P, s, e, function (i) { return wF(i) * 3.4; }, function (i) { return aF(i) * 0.2; }, function () { return C.a; });
      ribbon(ctx, P, s, e, wF, function (i) { return aF(i) * (T.dark ? 0.95 : 0.9); }, function (i) { return mix(C.hot, C.a, Math.min(1, u(i) * 1.7)); });
    }
    function drawHead(sp, k) {
      const p = sp.pts[0];
      glowDot(ctx, p[0], p[1], headR * depthW(p[2]) * (T.dark ? 1.3 : 1.05) * k, C.hot, C.a, depthA(p[2]) * sp.env);
    }
    function drawEmber(e) {
      const k = 1 - e.age / e.life;
      ctx.beginPath();
      ctx.arc(e.x, e.y, e.r * (0.4 + 0.6 * k), 0, TAU);
      ctx.fillStyle = rgba(T.dark ? mix(C.hot, C.a, 1 - k) : C.a, k * k * (e.z < 0 ? 0.4 : 0.85) * (T.dark ? 1 : 0.6));
      ctx.fill();
    }
    function markTransform() {
      ctx.translate(cx - markPx / 2, cy - markPx / 2);
      ctx.scale(markPx / 100, markPx / 100);
    }

    function frame(now) {
      const dt = lastNow == null ? 0.016 : clamp((now - lastNow) / 1000, 0, 0.05) * speed;
      lastNow = now;
      t += dt;

      if (t >= nextT) {
        transients.push({
          inc: 0.3 + rnd() * 1.15,
          phi0: rnd() * TAU,
          w: TAU * (1.35 + rnd() * 0.7) * (rnd() < 0.5 ? -1 : 1),
          th0: rnd() * TAU,
          prec: (rnd() - 0.5) * 0.6,
          wob: rnd() * TAU,
          born: t,
          life: 0.75 + rnd() * 0.6,
        });
        nextT = t + (small ? 0.95 : 0.5) + rnd() * (small ? 0.8 : 0.6);
      }
      for (let i = transients.length - 1; i >= 0; i--) if (t - transients[i].born > transients[i].life) transients.splice(i, 1);

      const sparks = [];
      function sample(ob, tt, env) {
        const pts = [];
        for (let j = 0; j <= J; j++) pts.push(pos(ob, tt - j * DT));
        sparks.push({ pts: pts, env: env, k: small ? 1 : 0.82 + Math.random() * 0.36 });
      }
      orbits.forEach(function (ob) { sample(ob, t, 1); });
      transients.forEach(function (ob) {
        const age = t - ob.born;
        sample(ob, age, Math.pow(Math.sin((Math.PI * age) / ob.life), 0.7));
      });

      // embers flick off the heads (hero size only)
      if (!small) {
        sparks.forEach(function (sp) {
          if (Math.random() < 0.35) {
            const p = sp.pts[0], q = sp.pts[1];
            const tx = p[0] - q[0], ty = p[1] - q[1], tl = Math.hypot(tx, ty) || 1;
            const side = Math.random() < 0.5 ? -1 : 1;
            const sp2 = size * (0.18 + Math.random() * 0.3);
            embers.push({
              x: p[0], y: p[1],
              vx: ((-ty / tl) * side * 0.8 + (tx / tl) * 0.35) * sp2,
              vy: ((tx / tl) * side * 0.8 + (ty / tl) * 0.35) * sp2 + size * 0.03,
              z: p[2], age: 0, life: 0.14 + Math.random() * 0.22, r: clamp(size * 0.005, 0.6, 1.6) * sp.env,
            });
          }
        });
      }
      for (let i = embers.length - 1; i >= 0; i--) {
        const e = embers[i];
        e.age += dt;
        if (e.age >= e.life) { embers.splice(i, 1); continue; }
        e.x += e.vx * dt; e.y += e.vy * dt;
        e.vx *= 0.9; e.vy *= 0.9;
      }

      // ── draw
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, size, size);

      if (T.dark) {
        const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, markPx * 0.9);
        g.addColorStop(0, rgba(C.a, 0.17 + 0.05 * Math.sin(t * 3.1)));
        g.addColorStop(1, rgba(C.a, 0));
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, size, size);
      }

      // behind the nucleus
      ctx.globalCompositeOperation = add;
      sparks.forEach(function (sp) { drawSpark(sp, false, false); });
      embers.forEach(function (e) { if (e.z < 0) drawEmber(e); });
      sparks.forEach(function (sp) { if (sp.pts[0][2] < 0) drawHead(sp, sp.k); });

      // the mark
      ctx.globalCompositeOperation = 'source-over';
      ctx.save();
      markTransform();
      ctx.fillStyle = rgba(T.ink, 1);
      ctx.fill(mark, 'evenodd');
      ctx.restore();

      // in front: luminous over the background…
      ctx.globalCompositeOperation = add;
      sparks.forEach(function (sp) { drawSpark(sp, true, false); });
      embers.forEach(function (e) { if (e.z >= 0) drawEmber(e); });
      sparks.forEach(function (sp) { if (sp.pts[0][2] >= 0) drawHead(sp, sp.k); });
      // …and still visible where it crosses the light mark (additive light vanishes on white)
      if (T.dark) {
        ctx.globalCompositeOperation = 'source-over';
        ctx.save();
        markTransform();
        ctx.clip(mark, 'evenodd');
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        sparks.forEach(function (sp) { drawSpark(sp, true, true); });
        sparks.forEach(function (sp) {
          const p = sp.pts[0];
          if (p[2] >= 0) glowDot(ctx, p[0], p[1], headR * 1.1, C.a, C.a, 0.9 * sp.env);
        });
        ctx.restore();
      }
      ctx.globalCompositeOperation = 'source-over';
    }
    return { frame: frame };
  }

  global.WBLoaders = { synapse: synapse, nucleus: nucleus };
})(window);
