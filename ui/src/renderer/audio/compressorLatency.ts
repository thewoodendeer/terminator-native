/** DynamicsCompressorNode look-ahead latency, MEASURED.
 *
 *  Chromium and WebKit implement the compressor with a fixed pre-delay (about
 *  6 ms — 256 frames at 44.1 k) that the node does not report. It matters in
 *  two places: a dry signal mixed against the compressed one (parallel / NY
 *  compression) comb-filters unless the dry leg is delayed by the same amount,
 *  and an offline master render that ends in a compressor-limiter lands that
 *  many frames later than stems rendered without one.
 *
 *  We don't hard-code the number: an impulse is rendered once per sample rate
 *  through a transparent compressor (ratio 1) in a tiny OfflineAudioContext
 *  and the peak offset is the latency. Cached; ~1 ms of work. */

const pending = new Map<number, Promise<number>>();
const known = new Map<number, number>();

export function compressorLatencySec(sampleRate: number): Promise<number> {
  const sr = Math.round(sampleRate);
  let p = pending.get(sr);
  if (p) return p;
  p = (async () => {
    try {
      if (typeof OfflineAudioContext === 'undefined') return 0;
      const len = Math.ceil(sr * 0.05);
      const off = new OfflineAudioContext(1, len, sr);
      const buf = off.createBuffer(1, len, sr);
      const AT = 64;
      buf.getChannelData(0)[AT] = 1;
      const src = off.createBufferSource();
      src.buffer = buf;
      const comp = off.createDynamicsCompressor();
      comp.threshold.value = 0; comp.knee.value = 0; comp.ratio.value = 1;
      comp.attack.value = 0.001; comp.release.value = 0.05;
      src.connect(comp); comp.connect(off.destination);
      src.start(0);
      const out = await off.startRendering();
      const d = out.getChannelData(0);
      let best = 0, bi = AT;
      for (let i = 0; i < d.length; i++) { const a = Math.abs(d[i]); if (a > best) { best = a; bi = i; } }
      const sec = best > 0 ? Math.max(0, (bi - AT) / sr) : 0;
      known.set(sr, sec);
      return sec;
    } catch {
      known.set(sr, 0);
      return 0;
    }
  })();
  pending.set(sr, p);
  return p;
}

/** Last measured value for this rate, or 0 if not measured yet (kick off
 *  compressorLatencySec early — the engine does at construction). */
export function compressorLatencyKnown(sampleRate: number): number {
  return known.get(Math.round(sampleRate)) ?? 0;
}

// ── WaveShaper oversampling latency ─────────────────────────────────────────
// A WaveShaperNode with oversample '2x'/'4x' runs its curve through an up/down
// sampler pair whose FIR kernels are NOT compensated: measured 128 frames at
// 2x and 192 frames at 4x (4.35 ms @ 44.1 k), and reported by nothing. Same
// impulse-render measurement as the compressor, cached per (rate, mode).

const osPending = new Map<string, Promise<number>>();
const osKnown = new Map<string, number>();

export function oversampleLatencySec(sampleRate: number, mode: '2x' | '4x' = '4x'): Promise<number> {
  const sr = Math.round(sampleRate);
  const key = `${sr}:${mode}`;
  let p = osPending.get(key);
  if (p) return p;
  p = (async () => {
    try {
      if (typeof OfflineAudioContext === 'undefined') return 0;
      const len = Math.ceil(sr * 0.05);
      const off = new OfflineAudioContext(1, len, sr);
      const buf = off.createBuffer(1, len, sr);
      const AT = 64;
      buf.getChannelData(0)[AT] = 1;
      const src = off.createBufferSource();
      src.buffer = buf;
      const ws = off.createWaveShaper();
      const id = new Float32Array(1024);
      for (let i = 0; i < id.length; i++) id[i] = -1 + (2 * i) / (id.length - 1);
      ws.curve = id; ws.oversample = mode;
      src.connect(ws); ws.connect(off.destination);
      src.start(0);
      const out = await off.startRendering();
      const d = out.getChannelData(0);
      let best = 0, bi = AT;
      for (let i = 0; i < d.length; i++) { const a = Math.abs(d[i]); if (a > best) { best = a; bi = i; } }
      const sec = best > 0 ? Math.max(0, (bi - AT) / sr) : 0;
      osKnown.set(key, sec);
      return sec;
    } catch {
      osKnown.set(key, 0);
      return 0;
    }
  })();
  osPending.set(key, p);
  return p;
}

/** Last measured oversampling latency, or 0 if not measured yet. */
export function oversampleLatencyKnown(sampleRate: number, mode: '2x' | '4x' = '4x'): number {
  return osKnown.get(`${Math.round(sampleRate)}:${mode}`) ?? 0;
}
