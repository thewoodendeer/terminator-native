// LOUDNESS METER — ITU-R BS.1770-4 / EBU R128, on the audio thread.
//
// Feeds: the master output (stereo). Never touches the signal (no outputs).
//
//   K-weighting   per channel: stage 1 high-shelf (+4 dB above ~1.5 kHz),
//                 stage 2 RLB high-pass (~38 Hz). Coefficients are DESIGNED at
//                 the running sample rate from the spec's analogue prototypes
//                 (f0 = 1681.97 Hz / Q 0.7071752 / +3.99984 dB and
//                 f0 = 38.13547 Hz / Q 0.5003271), which reproduces the spec's
//                 published 48 kHz table to 6 decimals and stays correct at
//                 44.1 / 88.2 / 96 kHz.
//   Blocks        100 ms hops; MOMENTARY = the last 400 ms (4 hops),
//                 SHORT-TERM = the last 3 s (30 hops); channel weights 1/1.
//   INTEGRATED    all 400 ms blocks (100 ms hop) gated: absolute −70 LUFS,
//                 then relative −10 LU below the gated mean — recomputed
//                 every hop over the whole history (RESET clears it).
//   LRA           loudness range: short-term values, absolute −70 / relative
//                 −20 LU gate, 10th → 95th percentile (EBU Tech 3342).
//   SAMPLE PEAK   per channel per hop, plus TRUE PEAK: 4× oversampled with a
//                 48-tap windowed-sinc interpolator (BS.1770 Annex 2 method;
//                 within ±0.1 dB of the spec's table filter).
//   CORRELATION   L/R Pearson correlation over the hop (+1 mono … −1 out of
//                 phase), for the stereo/phase readout.
//
// Posts once per hop: { m, s, i, lra, peakL, peakR, tpL, tpR, corr, hops }.
// Messages in: 'reset' (integrated + LRA + peak holds).

const HOP_S = 0.1;

// Filter design — the SAME analogue prototypes + bilinear mapping the spec
// used for its 48 kHz table (as in libebur128), so the table is reproduced
// exactly at 48 kHz and stays correct at 44.1 / 88.2 / 96 kHz.
function highShelf(fs, f0, Q, gainDb) {
  const K = Math.tan(Math.PI * f0 / fs);
  const Vh = Math.pow(10, gainDb / 20);
  const Vb = Math.pow(Vh, 0.4996667741545416);
  const a0 = 1 + K / Q + K * K;
  return [
    (Vh + Vb * K / Q + K * K) / a0,
    2 * (K * K - Vh) / a0,
    (Vh - Vb * K / Q + K * K) / a0,
    2 * (K * K - 1) / a0,
    (1 - K / Q + K * K) / a0,
  ];
}
function highPass(fs, f0, Q) {
  const K = Math.tan(Math.PI * f0 / fs);
  const a0 = 1 + K / Q + K * K;
  return [1, -2, 1, 2 * (K * K - 1) / a0, (1 - K / Q + K * K) / a0];
}

class Biquad {
  constructor(c) { this.c = c; this.z1 = 0; this.z2 = 0; }
  run(x) {
    const [b0, b1, b2, a1, a2] = this.c;
    const y = b0 * x + this.z1;
    this.z1 = b1 * x - a1 * y + this.z2;
    this.z2 = b2 * x - a2 * y;
    return y;
  }
}

// 4× oversampling interpolator: 4 phases × 12 taps of a Kaiser-windowed sinc.
function designTruePeak() {
  const PH = 4, TAPS = 12, N = PH * TAPS;
  const beta = 8; // Kaiser
  const i0 = (x) => { let s = 1, t = 1; for (let k = 1; k < 30; k++) { t *= (x / (2 * k)) * (x / (2 * k)); s += t; } return s; };
  const h = new Float64Array(N);
  const c = (N - 1) / 2;
  for (let n = 0; n < N; n++) {
    const x = (n - c) / PH;
    const sinc = x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x);
    const r = (n - c) / c;
    const w = i0(beta * Math.sqrt(Math.max(0, 1 - r * r))) / i0(beta);
    h[n] = sinc * w;
  }
  // per-phase taps; normalise each phase to unity DC gain
  const phases = [];
  for (let p = 0; p < PH; p++) {
    const t = new Float64Array(TAPS); let sum = 0;
    for (let k = 0; k < TAPS; k++) { t[k] = h[k * PH + p]; sum += t[k]; }
    for (let k = 0; k < TAPS; k++) t[k] /= sum;
    phases.push(t);
  }
  return { phases, taps: TAPS };
}

class TruePeak {
  constructor(design) { this.ph = design.phases; this.n = design.taps; this.hist = new Float64Array(design.taps); this.pos = 0; }
  // returns the max |interpolated| for this input sample (4 sub-samples)
  push(x) {
    this.hist[this.pos] = x;
    this.pos = (this.pos + 1) % this.n;
    let peak = 0;
    for (let p = 0; p < this.ph.length; p++) {
      const t = this.ph[p]; let acc = 0;
      // hist is a ring: newest at pos-1
      for (let k = 0; k < this.n; k++) {
        const idx = (this.pos - 1 - k + this.n * 2) % this.n;
        acc += t[k] * this.hist[idx];
      }
      const a = Math.abs(acc); if (a > peak) peak = a;
    }
    return peak;
  }
}

class LoudnessMeterProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    const fs = sampleRate;
    const sh = highShelf(fs, 1681.974450955533, 0.7071752369554196, 3.99984385397);
    const hp = highPass(fs, 38.13547087602444, 0.5003270373238773);
    this.kL = [new Biquad(sh), new Biquad(hp)];
    this.kR = [new Biquad(sh), new Biquad(hp)];
    const tpd = designTruePeak();
    this.tpL = new TruePeak(tpd); this.tpR = new TruePeak(tpd);
    this.hopLen = Math.round(fs * HOP_S);
    this.hopPos = 0;
    // per-hop accumulators
    this.sqL = 0; this.sqR = 0;              // K-weighted energy this hop
    this.pkL = 0; this.pkR = 0; this.tpkL = 0; this.tpkR = 0;
    this.cLL = 0; this.cRR = 0; this.cLR = 0; // raw correlation sums
    // hop history (energy per hop, per channel summed) for M / S / I
    this.hops = [];      // mean-square (L+R) per 100 ms hop
    this.blocks = [];    // 400 ms block loudness (LUFS) for integrated gating
    this.shorts = [];    // 3 s short-term loudness for LRA
    this.port.onmessage = (e) => { if (e.data === 'reset') this.reset(); };
  }
  reset() { this.blocks = []; this.shorts = []; this.hops = []; }

  process(inputs) {
    const inp = inputs[0];
    if (!inp || inp.length === 0) return true;
    const L = inp[0], R = inp[1] || inp[0];
    const n = L.length;
    for (let i = 0; i < n; i++) {
      const l = L[i], r = R[i];
      const al = Math.abs(l), ar = Math.abs(r);
      if (al > this.pkL) this.pkL = al; if (ar > this.pkR) this.pkR = ar;
      const tl = this.tpL.push(l), tr = this.tpR.push(r);
      if (tl > this.tpkL) this.tpkL = tl; if (tr > this.tpkR) this.tpkR = tr;
      this.cLL += l * l; this.cRR += r * r; this.cLR += l * r;
      const kl = this.kL[1].run(this.kL[0].run(l));
      const kr = this.kR[1].run(this.kR[0].run(r));
      this.sqL += kl * kl; this.sqR += kr * kr;
      if (++this.hopPos >= this.hopLen) this.endHop();
    }
    return true;
  }

  endHop() {
    const N = this.hopLen;
    const ms = (this.sqL + this.sqR) / N;   // channel weights 1 + 1
    this.hops.push(ms); if (this.hops.length > 30) this.hops.shift();
    const lufs = (m) => (m > 0 ? -0.691 + 10 * Math.log10(m) : -Infinity);
    const mean = (a, from) => { let s = 0; for (let i = from; i < a.length; i++) s += a[i]; return s / (a.length - from); };
    const mVal = this.hops.length >= 4 ? lufs(mean(this.hops, this.hops.length - 4)) : -Infinity;
    const sVal = this.hops.length >= 30 ? lufs(mean(this.hops, 0)) : (this.hops.length ? lufs(mean(this.hops, 0)) : -Infinity);
    // integrated: every 400 ms block (100 ms hop) above the absolute gate
    if (this.hops.length >= 4) {
      const blockMs = mean(this.hops, this.hops.length - 4);
      if (lufs(blockMs) > -70) this.blocks.push(blockMs);
      if (this.hops.length >= 30 && sVal > -70) this.shorts.push(sVal);
    }
    let iVal = -Infinity, lra = 0;
    if (this.blocks.length) {
      const absMean = mean(this.blocks, 0);
      const rel = lufs(absMean) - 10;
      let s = 0, c = 0;
      for (const b of this.blocks) { if (lufs(b) > rel) { s += b; c++; } }
      iVal = c ? lufs(s / c) : -Infinity;
    }
    if (this.shorts.length >= 2) {
      // relative gate −20 LU below the (absolute-gated) mean of short-term power
      let p = 0; for (const v of this.shorts) p += Math.pow(10, (v + 0.691) / 10);
      const relS = lufs(p / this.shorts.length) - 20;
      const kept = this.shorts.filter((v) => v > relS).sort((a, b) => a - b);
      if (kept.length >= 2) {
        const q = (f) => kept[Math.min(kept.length - 1, Math.max(0, Math.floor(f * (kept.length - 1))))];
        lra = Math.max(0, q(0.95) - q(0.10));
      }
    }
    const corr = (this.cLL > 0 && this.cRR > 0) ? this.cLR / Math.sqrt(this.cLL * this.cRR) : 1;
    this.port.postMessage({
      m: mVal, s: sVal, i: iVal, lra,
      peakL: this.pkL, peakR: this.pkR, tpL: this.tpkL, tpR: this.tpkR,
      corr, hops: this.blocks.length,
    });
    this.hopPos = 0; this.sqL = this.sqR = 0; this.pkL = this.pkR = 0; this.tpkL = this.tpkR = 0;
    this.cLL = this.cRR = this.cLR = 0;
    // keep short-term history bounded (LRA over the last ~10 min is plenty)
    if (this.shorts.length > 6000) this.shorts.splice(0, this.shorts.length - 6000);
  }
}

registerProcessor('loudness-meter', LoudnessMeterProcessor);
