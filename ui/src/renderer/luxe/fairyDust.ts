/**
 * FAIRY DUST — the pointer's sparkle trail in the 4K finish.
 *
 * A fairy follows the mouse around pressing the buttons: a thin, twinkling
 * stream of tiny stars that trails the pointer, drifts, and dies. It is meant
 * to be FELT more than seen — a few motes on a slow move, a small burst on a
 * click, nothing at all when the hand is still.
 *
 * Crisp + 3D-ish, cheaply:
 *   - one full-screen canvas at device-pixel resolution (a 1px star is one
 *     device pixel on a 5K panel — no CSS-scaled blur), pointer-transparent;
 *   - additive blending, so overlapping motes brighten like light instead of
 *     stacking like paint;
 *   - each mote has a DEPTH z: near motes are bigger, brighter, spawn wider
 *     around the pointer and carry more of its velocity; far ones are small,
 *     dim, tight to the path — parallax reads as a cloud with volume;
 *   - each mote is a soft additive halo (the light) around a hard PIXEL core
 *     snapped to the device-pixel grid (the retro), and at the peak of its
 *     twinkle it grows a one-pixel cross — an 8-bit sparkle.
 *
 * Colour comes from the ACTIVE finish: the accent metal (gold on platinum,
 * platinum on gold, the theme's neon otherwise) with a white heart, and one
 * mote in five is pure white — the "sparkle". Re-read on every theme change.
 *
 * Motion (apple-design-motion): responds on the first pointer event, tracks
 * 1:1 (motes spawn AT the pointer, inheriting its velocity), and there is no
 * canned timeline — the rAF loop runs only while a mote is alive and parks
 * the moment the last one fades. Reduced motion → no dust at all.
 */

interface Mote {
  x: number; y: number;
  vx: number; vy: number;
  born: number;      // ms
  ttl: number;       // ms
  z: number;         // 0 far … 1 near
  size: number;      // base radius, CSS px
  phase: number;     // twinkle phase
  rate: number;      // twinkle rate, rad/ms
  white: boolean;    // pure-white sparkle
  spin: number;      // (kept for a future rotating variant)
  burst: boolean;    // born of a click — bigger, brighter, thrown outward
}

const MAX_MOTES = 220;
const GRAVITY = 26;          // px/s² — dust settles, slowly
const DRAG = 0.985;          // per frame at 60fps (normalised below)
const TTL_MIN = 520, TTL_MAX = 1150;

let canvas: HTMLCanvasElement | null = null;
let ctx: CanvasRenderingContext2D | null = null;
let motes: Mote[] = [];
let raf = 0;
let lastT = 0;
let running = false;
let cleanup: (() => void) | null = null;
let dpr = 1;
let accent = { r: 212, g: 175, b: 55 };   // resolved theme accent
let lastPtr: { x: number; y: number; t: number } | null = null;
let spawnCarry = 0;                        // fractional motes owed
let reduced = false;

// ── colour ─────────────────────────────────────────────────────────────────
/** Resolve the finish's accent (a CSS var that may be a color-mix()) to RGB by
 *  letting the browser compute it on a throwaway element. */
function readAccent(): void {
  const probe = document.createElement('i');
  probe.style.cssText = 'position:fixed;left:-9px;top:-9px;width:0;height:0;color:var(--m-acc, var(--hw-accent, var(--neon, #d4af37)))';
  document.body.appendChild(probe);
  const c = getComputedStyle(probe).color;
  probe.remove();
  const m = c.match(/rgba?\(([^)]+)\)/);
  if (m) {
    const p = m[1].split(',').map(Number);
    accent = { r: p[0], g: p[1], b: p[2] };
  }
}

// ── canvas ─────────────────────────────────────────────────────────────────
function fit(): void {
  if (!canvas || !ctx) return;
  dpr = Math.min(3, window.devicePixelRatio || 1);
  const w = window.innerWidth, h = window.innerHeight;
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  canvas.style.width = `${w}px`;
  canvas.style.height = `${h}px`;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

// ── spawning ───────────────────────────────────────────────────────────────
function rand(a: number, b: number): number { return a + Math.random() * (b - a); }

function spawn(x: number, y: number, vx: number, vy: number, n: number, burst = false): void {
  const now = performance.now();
  for (let i = 0; i < n && motes.length < MAX_MOTES; i++) {
    const z = Math.random() ** 0.8;                       // more far than near
    const spread = burst ? 4 + z * 8 : 1.5 + z * 6;       // near motes wander wider
    const ang = Math.random() * Math.PI * 2;
    const r = Math.random() * spread;
    // trail: inherit a slice of the pointer's velocity (more when near), plus a
    // little scatter; a burst throws outward instead
    const inherit = burst ? 0 : 0.10 + z * 0.22;
    const throwV = burst ? rand(60, 240) : rand(4, 22);   // the click EXPLODES a little
    motes.push({
      x: x + Math.cos(ang) * r,
      y: y + Math.sin(ang) * r,
      vx: vx * inherit + Math.cos(ang) * throwV,
      vy: vy * inherit + Math.sin(ang) * throwV - (burst ? 0 : rand(6, 26)), // a lift, like dust catching air
      born: now,
      ttl: rand(TTL_MIN, TTL_MAX) * (0.75 + z * 0.5) * (burst ? 1.25 : 1),
      z,
      size: 0.6 + z * 1.6,
      phase: Math.random() * Math.PI * 2,
      rate: rand(0.010, 0.026),
      white: burst ? Math.random() < 0.45 : Math.random() < 0.2,
      spin: Math.random() * Math.PI,
      burst,
    });
  }
  wake();
}

// ── render ─────────────────────────────────────────────────────────────────
function draw(now: number, dt: number): void {
  if (!ctx || !canvas) return;
  const w = window.innerWidth, h = window.innerHeight;
  ctx.clearRect(0, 0, w, h);
  ctx.globalCompositeOperation = 'lighter';
  const drag = Math.pow(DRAG, dt * 60);
  const alive: Mote[] = [];
  const onePx = 1 / dpr; // one DEVICE pixel, in CSS px — the star core's stroke
  for (const m of motes) {
    const age = now - m.born;
    if (age >= m.ttl) continue;
    // physics
    m.vy += GRAVITY * dt;
    m.vx *= drag; m.vy *= drag;
    m.x += m.vx * dt; m.y += m.vy * dt;
    m.spin += dt * (0.6 + m.z * 1.2);
    // life: quick in, long soft out
    const t = age / m.ttl;
    const env = t < 0.08 ? t / 0.08 : Math.pow(1 - (t - 0.08) / 0.92, 1.5);
    const tw = 0.55 + 0.45 * Math.sin(m.phase + age * m.rate);
    const a = env * tw * (0.35 + m.z * 0.65);
    if (a < 0.01) { alive.push(m); continue; }
    const cr = m.white ? 255 : accent.r, cg = m.white ? 255 : accent.g, cb = m.white ? 255 : accent.b;
    // halo — the LIGHT: soft, tinted, additive, grows toward the viewer
    const R = m.size * (2.6 + m.z * 3.6) * (m.burst ? 1.35 : 1);
    const g = ctx.createRadialGradient(m.x, m.y, 0, m.x, m.y, R);
    g.addColorStop(0, `rgba(255,255,255,${(a * 0.85).toFixed(3)})`);
    g.addColorStop(0.35, `rgba(${cr},${cg},${cb},${(a * 0.6).toFixed(3)})`);
    g.addColorStop(1, `rgba(${cr},${cg},${cb},0)`);
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(m.x, m.y, R, 0, Math.PI * 2); ctx.fill();
    // pixel core — a hard square SNAPPED to the device-pixel grid, so it is a
    // real pixel on any display: 1 device px far away, up to 3 near, 4 in a
    // burst. That is the retro in it; the halo above is the light on it.
    const px = Math.max(1, Math.round((0.9 + m.z * 2.1) * (m.burst ? 1.4 : 1)));   // in device px
    const cell = px * onePx;
    const sx = Math.round(m.x / cell) * cell, sy = Math.round(m.y / cell) * cell;
    ctx.fillStyle = `rgba(255,255,255,${Math.min(1, a * 1.35).toFixed(3)})`;
    ctx.fillRect(sx - cell / 2, sy - cell / 2, cell, cell);
    // twinkle peak → a pixel cross around the core (the retro sparkle)
    if (tw > 0.86) {
      const k = (tw - 0.86) / 0.14;
      ctx.fillStyle = `rgba(${cr},${cg},${cb},${Math.min(1, a * 1.1 * k).toFixed(3)})`;
      const arm = cell * (m.z > 0.6 ? 2 : 1);
      ctx.fillRect(sx - cell / 2 - arm, sy - cell / 2, arm, cell);       // left
      ctx.fillRect(sx + cell / 2,       sy - cell / 2, arm, cell);       // right
      ctx.fillRect(sx - cell / 2, sy - cell / 2 - arm, cell, arm);       // up
      ctx.fillRect(sx - cell / 2, sy + cell / 2,       cell, arm);       // down
    }
    alive.push(m);
  }
  motes = alive;
  ctx.globalCompositeOperation = 'source-over';
}

function frame(t: number): void {
  raf = 0;
  const dt = lastT ? Math.min(0.05, (t - lastT) / 1000) : 1 / 60;
  lastT = t;
  draw(t, dt);
  if (motes.length && running) raf = requestAnimationFrame(frame);
  else { lastT = 0; if (ctx && canvas && !motes.length) ctx.clearRect(0, 0, canvas.width, canvas.height); }
}
function wake(): void { if (running && !raf) raf = requestAnimationFrame(frame); }

// ── pointer ────────────────────────────────────────────────────────────────
function onMove(e: PointerEvent): void {
  if (reduced) return;
  const now = performance.now();
  let vx = 0, vy = 0, speed = 0;
  if (lastPtr) {
    const dt = Math.max(1, now - lastPtr.t);
    vx = (e.clientX - lastPtr.x) / dt * 1000; // px/s
    vy = (e.clientY - lastPtr.y) / dt * 1000;
    speed = Math.hypot(vx, vy);
  }
  lastPtr = { x: e.clientX, y: e.clientY, t: now };
  // Spawn rate follows speed — a slow drift sheds a mote every few frames, a
  // sweep leaves a stream — but capped so a flick can't dump a cloud.
  spawnCarry += Math.min(2.2, 0.35 + speed / 900);
  const n = Math.floor(spawnCarry);
  spawnCarry -= n;
  if (n > 0) spawn(e.clientX, e.clientY, vx, vy, n);
}
function onDown(e: PointerEvent): void {
  if (reduced) return;
  // the fairy presses the button: a small burst
  spawn(e.clientX, e.clientY, 0, 0, 26, true);
}
function onLeave(): void { lastPtr = null; }

// ── public API ─────────────────────────────────────────────────────────────
export function startFairyDust(el: HTMLCanvasElement): void {
  if (running) return;
  running = true;
  canvas = el;
  ctx = el.getContext('2d', { alpha: true });
  reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  fit();
  readAccent();
  const opts: AddEventListenerOptions = { passive: true, capture: true };
  window.addEventListener('pointermove', onMove, opts);
  window.addEventListener('pointerdown', onDown, opts);
  window.addEventListener('pointerleave', onLeave, opts);
  window.addEventListener('resize', fit);
  window.addEventListener('terminator:theme', readAccent);
  window.addEventListener('terminator:finish', readAccent);
  cleanup = () => {
    window.removeEventListener('pointermove', onMove, opts);
    window.removeEventListener('pointerdown', onDown, opts);
    window.removeEventListener('pointerleave', onLeave, opts);
    window.removeEventListener('resize', fit);
    window.removeEventListener('terminator:theme', readAccent);
    window.removeEventListener('terminator:finish', readAccent);
  };
}

export function stopFairyDust(): void {
  if (!running) return;
  running = false;
  if (raf) { cancelAnimationFrame(raf); raf = 0; }
  lastT = 0;
  motes = [];
  cleanup?.(); cleanup = null;
  if (ctx && canvas) ctx.clearRect(0, 0, canvas.width, canvas.height);
  canvas = null; ctx = null;
}
