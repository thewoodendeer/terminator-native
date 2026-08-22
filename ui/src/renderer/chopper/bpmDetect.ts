/**
 * Tempogram-style BPM estimator.
 *
 *   1. Frame the audio at ~22 frames/sec and compute RMS energy per frame.
 *   2. Take the positive spectral flux (Δ-energy half-wave rectified).
 *   3. Subtract a local moving mean so the signal has no DC drift.
 *   4. For each candidate BPM, score the onset envelope's self-correlation
 *      at the beat period AND its first three multiples (the "comb").
 *      Real tempo has correlation at lag, 2*lag, 3*lag, 4*lag; half-BPM
 *      has correlation only at the even multiples, so the true BPM
 *      consistently outscores its half-and-double siblings.
 *   5. Coarse-search at 1 BPM resolution, then refine ±2 BPM around the
 *      winner at 0.1 BPM resolution for sub-integer precision.
 *
 * Capped at the first 60 seconds so long tracks don't blow out the runtime.
 * Returns an integer BPM in [60, 200] (0 if confidence too low).
 *
 * Two entry points:
 *   - estimateBPMFromChannels(): pure function, no DOM/Web Audio deps. The
 *     same code runs on the main thread and inside the worker.
 *   - estimateBPMAsync(): offloads to a worker so the main thread doesn't
 *     stall during analysis (visible jank on mobile otherwise). Falls back
 *     to a synchronous main-thread compute if Workers aren't available.
 */

export function estimateBPMFromChannels(
  ch0: Float32Array,
  ch1: Float32Array,
  sampleRate: number,
  length: number,
  durationSec: number,
): number {
  if (durationSec < 8) return 0; // need ~8s for any stable tempogram

  // ── Step 1 — energy frames ──────────────────────────────────────────────
  const HOP = 1024;
  const FRAME = 2048;
  const allFrames = Math.floor((length - FRAME) / HOP);
  if (allFrames < 50) return 0;
  // Analyse the first 60 s only — comb scoring is O(BPM * frames * 4),
  // capping keeps the call under ~50 ms even for long uploads.
  const frameRate = sampleRate / HOP;
  const maxFrames = Math.min(allFrames, Math.floor(60 * frameRate));

  const energy = new Float32Array(maxFrames);
  for (let f = 0; f < maxFrames; f++) {
    const base = f * HOP;
    let e = 0;
    for (let i = 0; i < FRAME; i++) {
      const s = (ch0[base + i] + ch1[base + i]) * 0.5;
      e += s * s;
    }
    energy[f] = Math.sqrt(e / FRAME);
  }

  // ── Step 2 — positive spectral flux ────────────────────────────────────
  const flux = new Float32Array(maxFrames);
  for (let f = 1; f < maxFrames; f++) {
    const d = energy[f] - energy[f - 1];
    flux[f] = d > 0 ? d : 0;
  }

  // ── Step 3 — subtract local mean ───────────────────────────────────────
  const WIN = 10;
  const novelty = new Float32Array(maxFrames);
  for (let f = 0; f < maxFrames; f++) {
    const a = Math.max(0, f - WIN);
    const b = Math.min(maxFrames, f + WIN + 1);
    let m = 0;
    for (let k = a; k < b; k++) m += flux[k];
    m /= (b - a);
    const v = flux[f] - m;
    novelty[f] = v > 0 ? v : 0;
  }

  // ── Step 4 — comb scoring ──────────────────────────────────────────────
  // Score(bpm) = Σ_{m=1..4} weight(m) * Σ_{f} novelty[f] * novelty[f + m*lag]
  const lagF = (bpm: number) => (60 / bpm) * frameRate;
  const combWeights = [1.0, 0.7, 0.5, 0.4]; // diminishing on higher multiples
  const scoreFor = (bpm: number): number => {
    const baseLag = lagF(bpm);
    if (baseLag < 3) return -Infinity;
    let total = 0;
    for (let m = 0; m < combWeights.length; m++) {
      const lag = Math.round(baseLag * (m + 1));
      if (lag >= maxFrames - 4) break;
      let sum = 0;
      for (let f = 0; f < maxFrames - lag; f++) sum += novelty[f] * novelty[f + lag];
      total += combWeights[m] * sum;
    }
    return total;
  };

  // ── Coarse search (1 BPM resolution across 60–200) ─────────────────────
  let bestBpm = 0;
  let bestScore = -Infinity;
  for (let bpm = 60; bpm <= 200; bpm++) {
    const s = scoreFor(bpm);
    if (s > bestScore) { bestScore = s; bestBpm = bpm; }
  }
  if (bestScore <= 0) return 0;

  // ── Refine ±2 BPM around the winner at 0.1 BPM resolution ──────────────
  let refinedBpm = bestBpm;
  let refinedScore = bestScore;
  for (let d = -20; d <= 20; d++) {
    const bpm = bestBpm + d / 10;
    if (bpm < 60 || bpm > 200) continue;
    const s = scoreFor(bpm);
    if (s > refinedScore) { refinedScore = s; refinedBpm = bpm; }
  }

  // Snap obvious double/half tempos into the musical sweet spot.
  while (refinedBpm < 75)  refinedBpm *= 2;
  while (refinedBpm > 165) refinedBpm /= 2;

  return Math.round(refinedBpm);
}

/** Synchronous main-thread compute. Kept for non-Worker environments and as
 *  a fallback when worker dispatch fails. */
export function estimateBPM(buffer: AudioBuffer): number {
  const ch0 = buffer.getChannelData(0);
  const ch1 = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : ch0;
  return estimateBPMFromChannels(ch0, ch1, buffer.sampleRate, buffer.length, buffer.duration);
}

/** Worker-backed compute. The expensive loops happen off the main thread so
 *  the UI stays responsive while a large sample is being analysed. */
export async function estimateBPMAsync(buffer: AudioBuffer): Promise<number> {
  if (typeof Worker === 'undefined') return estimateBPM(buffer);

  // Copy channel data so we can transfer ownership without detaching the
  // AudioBuffer's internal storage.
  const ch0 = new Float32Array(buffer.getChannelData(0));
  const isMono = buffer.numberOfChannels < 2;
  const ch1 = isMono ? ch0 : new Float32Array(buffer.getChannelData(1));
  const sampleRate = buffer.sampleRate;
  const length = buffer.length;
  const durationSec = buffer.duration;

  return new Promise<number>((resolve) => {
    let worker: Worker;
    try {
      worker = new Worker(new URL('./bpmDetect.worker.ts', import.meta.url), { type: 'module' });
    } catch {
      // Vite couldn't resolve the worker (Electron file:// can fail) — fall back.
      resolve(estimateBPMFromChannels(ch0, ch1, sampleRate, length, durationSec));
      return;
    }
    worker.onmessage = (e: MessageEvent<{ bpm: number }>) => {
      resolve(e.data.bpm);
      worker.terminate();
    };
    worker.onerror = () => {
      resolve(estimateBPMFromChannels(ch0, ch1, sampleRate, length, durationSec));
      worker.terminate();
    };
    // Transfer the channel buffers — main thread no longer needs them.
    const transfers: ArrayBuffer[] = [ch0.buffer];
    if (!isMono) transfers.push(ch1.buffer);
    worker.postMessage({ ch0, ch1, sampleRate, length, durationSec, isMono }, transfers);
  });
}
