// CONSOLE — the analog-desk "separation" stage for the Terminator mixer.
//
// In the box every strip is the same maths, so sources mask and smear into one
// another. A real desk (SSL / Neve / API) gives every channel its OWN slight
// colour — transformer / op-amp saturation, a tiny EQ tilt from component
// tolerance, a sub-sonic filter — and a summing bus that glues. This processor
// is that, once per strip (role 'channel', seeded by the strip's NAME so "kick"
// is always the same kick, live and in an export) and once on the master
// (role 'bus'). Zero latency (no oversampling → PDC is untouched); the
// saturator is a bounded 2nd+3rd-order polynomial, so its harmonics stop at 3×
// the input and aliasing is negligible at the levels used. Unity small-signal
// gain — the A/B is character, not loudness (the gate measures it).
//
// Runs in a live AudioContext and in every export's OfflineAudioContext from
// the same file, so what you heard is what prints. Exercised headlessly by
// scripts/console.test.mts (npm run test:console).

// ── deterministic per-strip seed ─────────────────────────────────────────
function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h >>> 0;
}
function mulberry32(a) {
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
/** Six uniform draws in [-1, 1] for a strip name — the "component tolerance". */
function toleranceFor(name) {
  const r = mulberry32(fnv1a(String(name || 'strip')));
  const out = [];
  for (let i = 0; i < 6; i++) out.push(r() * 2 - 1);
  return out;
}

// ── biquads (RBJ cookbook) ───────────────────────────────────────────────
function hpCoeffs(f, sr, q) {
  const w0 = 2 * Math.PI * f / sr, cw = Math.cos(w0), sw = Math.sin(w0), al = sw / (2 * q);
  const b0 = (1 + cw) / 2, b1 = -(1 + cw), b2 = (1 + cw) / 2, a0 = 1 + al, a1 = -2 * cw, a2 = 1 - al;
  return [b0 / a0, b1 / a0, b2 / a0, a1 / a0, a2 / a0];
}
function shelfCoeffs(kind, f, dB, sr, S) {
  const A = Math.pow(10, dB / 40);
  const w0 = 2 * Math.PI * f / sr, cw = Math.cos(w0), sw = Math.sin(w0);
  const al = sw / 2 * Math.sqrt((A + 1 / A) * (1 / S - 1) + 2);
  const sq = 2 * Math.sqrt(A) * al;
  let b0, b1, b2, a0, a1, a2;
  if (kind === 'low') {
    b0 = A * ((A + 1) - (A - 1) * cw + sq); b1 = 2 * A * ((A - 1) - (A + 1) * cw); b2 = A * ((A + 1) - (A - 1) * cw - sq);
    a0 = (A + 1) + (A - 1) * cw + sq; a1 = -2 * ((A - 1) + (A + 1) * cw); a2 = (A + 1) + (A - 1) * cw - sq;
  } else {
    b0 = A * ((A + 1) + (A - 1) * cw + sq); b1 = -2 * A * ((A - 1) + (A + 1) * cw); b2 = A * ((A + 1) + (A - 1) * cw - sq);
    a0 = (A + 1) - (A - 1) * cw + sq; a1 = 2 * ((A - 1) - (A + 1) * cw); a2 = (A + 1) - (A - 1) * cw - sq;
  }
  return [b0 / a0, b1 / a0, b2 / a0, a1 / a0, a2 / a0];
}
function peakCoeffs(f, dB, sr, q) {
  const A = Math.pow(10, dB / 40);
  const w0 = 2 * Math.PI * f / sr, cw = Math.cos(w0), sw = Math.sin(w0), al = sw / (2 * q);
  const b0 = 1 + al * A, b1 = -2 * cw, b2 = 1 - al * A, a0 = 1 + al / A, a1 = -2 * cw, a2 = 1 - al / A;
  return [b0 / a0, b1 / a0, b2 / a0, a1 / a0, a2 / a0];
}
const IDENTITY = [1, 0, 0, 0, 0];

// ── the desk models ──────────────────────────────────────────────────────
// Every number below is the value at AMOUNT = 100 %; AMOUNT scales the drive
// and the EQ deviations linearly (the sub-sonic HPF stays — it is part of
// what a desk IS, and 20–26 Hz is benign). Tolerances jitter around them.
const FLAVOURS = {
  // Clean, forward, odd-harmonic (the VCA / op-amp desk). Tight sub filter,
  // a hair of air on top.
  SSL:  { a2: 0.012, a3: 0.144, hp: 24, lowF: 100, low: 0.0,  highF: 8000, high: 0.25, peakF: 0,    peak: 0,    lp: 0,
          bus: { a2: 0.008, a3: 0.25, low: 0.0,  lp: 21000 } },
  // Transformer warmth — even harmonics, a little weight down low, softened
  // top end (the iron rolls the air off).
  NEVE: { a2: 0.048, a3: 0.072, hp: 20, lowF: 100, low: 0.4,  highF: 6000, high: -0.2, peakF: 0,    peak: 0,    lp: 18000,
          bus: { a2: 0.03,  a3: 0.18, low: 0.3,  lp: 17000 } },
  // Punch — 2nd AND 3rd, a presence lift around 3 kHz.
  API:  { a2: 0.03,  a3: 0.12,  hp: 22, lowF: 120, low: 0.2,  highF: 8000, high: 0.0,  peakF: 3000, peak: 0.25, lp: 0,
          bus: { a2: 0.02,  a3: 0.2,  low: 0.15, lp: 20000 } },
};

class Biquad {
  constructor() { this.c = IDENTITY; this.z1 = 0; this.z2 = 0; }
  set(c) { this.c = c; }
  run(x) {
    const c = this.c;
    const y = c[0] * x + this.z1;
    this.z1 = c[1] * x - c[3] * y + this.z2;
    this.z2 = c[2] * x - c[4] * y;
    return y;
  }
}

class ConsoleStageProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const po = (options && options.processorOptions) || {};
    this.role = po.role === 'bus' ? 'bus' : 'channel';
    this.tol = this.role === 'bus' ? [0, 0, 0, 0, 0, 0] : toleranceFor(po.seed);
    // Initial flavour / amount arrive with the options so an export's first
    // block is already at the setting (no glide at the head of a stem).
    this.flavour = (typeof po.flavour === 'string' && FLAVOURS[po.flavour]) ? po.flavour : 'SSL';
    const amt0 = (typeof po.amount === 'number' && isFinite(po.amount)) ? Math.max(0, Math.min(1, po.amount)) : 0.5;
    this.amount = amt0;        // 0..1
    this.amountTarget = amt0;
    // Per channel: HPF, low shelf, high shelf, presence peak, 1-pole LPF, DC blocker.
    this.ch = [0, 1].map(() => ({ hp: new Biquad(), lo: new Biquad(), hi: new Biquad(), pk: new Biquad(), lp: 0, lpA: 0, dcX: 0, dcY: 0 }));
    this.a2 = 0; this.a3 = 0; this.x0 = 4; this.oddHold = 0; this.evenHold = 0;
    this.dcR = 1 - (2 * Math.PI * 5) / sampleRate;
    this.recompute();
    this.port.onmessage = (e) => {
      const d = e.data || {};
      if (typeof d.flavour === 'string' && FLAVOURS[d.flavour]) this.flavour = d.flavour;
      if (typeof d.amount === 'number' && isFinite(d.amount)) this.amountTarget = Math.max(0, Math.min(1, d.amount));
      this.recompute();
    };
  }

  recompute() {
    const F = FLAVOURS[this.flavour];
    const amt = this.amount;
    const t = this.tol;
    const sr = sampleRate;
    const isBus = this.role === 'bus';
    // Saturator. Tolerance jitters drive ±15 % per strip.
    const drive = isBus ? F.bus : F;
    this.a2 = drive.a2 * amt * (1 + 0.15 * t[0]);
    this.a3 = drive.a3 * amt * (1 + 0.15 * t[1]);
    // The odd polynomial x − a3·x³ peaks at x0 = 1/√(3·a3); beyond it we hold
    // (continuous, zero slope) instead of folding back — a soft ceiling only a
    // +6 dB fader on a hot source ever reaches.
    this.x0 = this.a3 > 1e-9 ? 1 / Math.sqrt(3 * this.a3) : 1e9;
    this.oddHold = this.x0 - this.a3 * this.x0 * this.x0 * this.x0;
    this.evenHold = this.a2 * this.x0 * this.x0;
    // EQ.
    const hpF = isBus ? 0 : Math.max(10, F.hp + 2 * t[2]);
    const lowDb = (isBus ? F.bus.low : F.low) * amt + (isBus ? 0 : 0.3 * t[3] * amt);
    const highDb = (isBus ? 0 : F.high * amt + 0.3 * t[4] * amt);
    const lowF = F.lowF * (1 + 0.1 * t[5]);
    const highF = F.highF * (1 + 0.1 * t[2]);
    const lpF = isBus ? F.bus.lp : F.lp;
    const hpC = hpF > 0 ? hpCoeffs(hpF, sr, Math.SQRT1_2) : IDENTITY;
    const loC = Math.abs(lowDb) > 1e-4 ? shelfCoeffs('low', lowF, lowDb, sr, 1) : IDENTITY;
    const hiC = Math.abs(highDb) > 1e-4 ? shelfCoeffs('high', Math.min(highF, sr * 0.45), highDb, sr, 1) : IDENTITY;
    const pkC = (!isBus && F.peakF > 0 && Math.abs(F.peak) > 1e-4) ? peakCoeffs(F.peakF, F.peak * amt, sr, 0.7) : IDENTITY;
    // 1-pole LPF: at AMOUNT 0 it opens fully (fc → ∞); otherwise fc blends from
    // very open toward the flavour's corner.
    let lpA = 0;
    if (lpF > 0 && amt > 0 && lpF < sr * 0.49) {
      const fc = lpF + (sr * 0.49 - lpF) * (1 - amt);
      lpA = Math.exp(-2 * Math.PI * fc / sr);
    }
    for (const c of this.ch) { c.hp.set(hpC); c.lo.set(loC); c.hi.set(hiC); c.pk.set(pkC); c.lpA = lpA; }
  }

  sat(x) {
    // Odd part (3rd harmonic): x − a3·x³, held flat past x0. Even part (2nd
    // harmonic): a2·x², also held — then a DC blocker downstream eats the
    // offset the even term carries.
    const ax = Math.abs(x);
    if (ax >= this.x0) return (x < 0 ? -this.oddHold : this.oddHold) + this.evenHold;
    return x - this.a3 * x * ax * ax + this.a2 * x * x;
  }

  process(inputs, outputs) {
    const input = inputs[0];
    const output = outputs[0];
    if (!output || !output[0]) return true;
    const n = output[0].length;
    // AMOUNT glides over ~23 ms so a knob move never steps.
    if (this.amount !== this.amountTarget) {
      const step = 1 / 1024 * n;
      if (Math.abs(this.amountTarget - this.amount) <= step) this.amount = this.amountTarget;
      else this.amount += Math.sign(this.amountTarget - this.amount) * step;
      this.recompute();
    }
    const hasIn = input && input.length > 0 && input[0];
    for (let c = 0; c < output.length; c++) {
      const out = output[c];
      const inp = hasIn ? (input[c] || input[0]) : null;
      const s = this.ch[c] || this.ch[0];
      if (!inp) { out.fill(0); continue; }
      for (let i = 0; i < n; i++) {
        let x = inp[i];
        x = s.hp.run(x);
        x = s.lo.run(x);
        x = s.hi.run(x);
        x = s.pk.run(x);
        if (s.lpA > 0) { s.lp = x + s.lpA * (s.lp - x); x = s.lp; }
        x = this.sat(x);
        // DC blocker (1-pole HPF at 5 Hz) — eats the offset the even term
        // carries. Always in, so AMOUNT sweeping through 0 never switches modes.
        const y = x - s.dcX + this.dcR * s.dcY;
        s.dcX = x; s.dcY = y;
        out[i] = y;
      }
    }
    return true;
  }
}

registerProcessor('console-stage', ConsoleStageProcessor);
