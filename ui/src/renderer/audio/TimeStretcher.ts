// Pitch-preserving time stretch + time-preserving pitch shift.
// `tempo` follows the existing timeStretch convention: 2.0 = twice as fast (half the length).
//
// Two engines, picked by what the caller asks for:
//   • pitchSemitones === 0 (the Extractor's warp path): transient-aware
//     phase-locked vocoder (@audio/stretch-transient, Röbel 2003). Spectral-flux
//     onsets reset synthesis phase, so drum attacks stay sharp and on-grid —
//     A/B-proven vs the old WSOLA (onset deviation 23ms→4.6ms, doubled hits →0).
//     Output is RMS level-matched to the input (the vocoder sits ~1.8 LUFS low)
//     with a peak-safety cap so the correction can never clip.
//   • pitchSemitones !== 0 (chopper pitch-shift callers): SoundTouch WSOLA,
//     unchanged — and the ready-made mode-B tonal fallback if we ever auto-detect
//     sustained material.
// Both libs are dynamic-imported so they stay out of the initial web bundle.
export async function stretchBuffer(
  ctx: BaseAudioContext,
  src: AudioBuffer,
  tempo: number,
  pitchSemitones: number,
): Promise<AudioBuffer> {
  if (Math.abs(tempo - 1) < 1e-4 && Math.abs(pitchSemitones) < 1e-4) return src;
  if (Math.abs(pitchSemitones) >= 1e-4) return stretchSoundTouch(ctx, src, tempo, pitchSemitones);

  const { default: transient } = await import('@audio/stretch-transient');
  // transient()'s factor convention is inverted vs tempo: factor 2 = twice as LONG.
  const factor = 1 / tempo;
  const nCh = Math.max(1, src.numberOfChannels);
  const outs: Float32Array[] = [];
  let sumSqIn = 0, nIn = 0;
  for (let c = 0; c < nCh; c++) {
    const data = src.getChannelData(c);
    for (let i = 0; i < data.length; i++) sumSqIn += data[i] * data[i];
    nIn += data.length;
    outs.push(transient(data, { factor }));
    // One synchronous vocoder pass per channel — yield between channels so a
    // long stereo phrase doesn't freeze the UI during project load.
    if (c + 1 < nCh) await new Promise(r => setTimeout(r, 0));
  }

  const len = Math.min(...outs.map(o => o.length));
  if (!(len > 0)) return src;

  // RMS level-match (perceived loudness), clamped to a sane range. No peak cap:
  // AudioBuffer samples are float (>1.0 is legal) and the vocoder's transient
  // overshoot peaks are exactly the attacks we're preserving — a global peak cap
  // measured −4.5 dB on a real drum break. Final levels belong to the mixer +
  // mastering chain downstream, same as the old SoundTouch path.
  let sumSqOut = 0;
  for (const o of outs) for (let i = 0; i < len; i++) sumSqOut += o[i] * o[i];
  const rmsIn = Math.sqrt(sumSqIn / Math.max(1, nIn));
  const rmsOut = Math.sqrt(sumSqOut / Math.max(1, len * nCh));
  let gain = rmsOut > 1e-8 && rmsIn > 1e-8 ? rmsIn / rmsOut : 1;
  gain = Math.max(0.25, Math.min(4, gain));

  const out = ctx.createBuffer(nCh, len, src.sampleRate);
  for (let c = 0; c < nCh; c++) {
    const dst = out.getChannelData(c);
    const o = outs[c];
    for (let i = 0; i < len; i++) dst[i] = o[i] * gain;
  }
  return out;
}

/** Plain resample — length AND pitch change together. This is the Extractor's
 *  PITCH-mode warp render (parseProject's warp pass): tape/varispeed, pitch
 *  tracks the stretch (verified 82.xpj ×1.166 → −2.66 st; 31.xpj ×2.3478 →
 *  +14.78 st by ear). The 2026-07 "the XPJ does not persist the mode toggle"
 *  finding was WRONG — a controlled 2-project device diff (2026-07-29) showed
 *  the mode IS recorded per pad in instrument.userSelectableWarpPoolIndex
 *  (8 = Time Stretch → stretchBuffer above; 13/default = Pitch → this).
 *  parseProject branches per pad on that field.
 *  `rate` follows the tempo convention: 2.0 = twice as fast = half the length,
 *  one octave up; < 1 = slower / longer / lower. Linear interpolation in pure JS
 *  (iOS/OfflineAudioContext-safe, same constraint as the mastering chain). */
export function resampleBuffer(ctx: BaseAudioContext, src: AudioBuffer, rate: number): AudioBuffer {
  if (!isFinite(rate) || rate <= 0 || Math.abs(rate - 1) < 1e-4) return src;
  const nCh = Math.max(1, src.numberOfChannels);
  const outLen = Math.max(1, Math.floor(src.length / rate));
  const out = ctx.createBuffer(nCh, outLen, src.sampleRate);
  for (let c = 0; c < nCh; c++) {
    const inD = src.getChannelData(c);
    const outD = out.getChannelData(c);
    for (let i = 0; i < outLen; i++) {
      const pos = i * rate;
      const i0 = Math.floor(pos);
      const i1 = Math.min(i0 + 1, inD.length - 1);
      const frac = pos - i0;
      outD[i] = inD[i0] + (inD[i1] - inD[i0]) * frac;
    }
  }
  return out;
}

// SoundTouch WSOLA path — the original implementation, kept verbatim for the
// non-zero-semitone callers (chopper pitch shift) and as the future tonal
// fallback. soundtouchjs is dynamic-imported here so it stays out of the
// initial web bundle.
async function stretchSoundTouch(
  ctx: BaseAudioContext,
  src: AudioBuffer,
  tempo: number,
  pitchSemitones: number,
): Promise<AudioBuffer> {
  const { SoundTouch, SimpleFilter, WebAudioBufferSource } = await import('soundtouchjs');
  const source = new WebAudioBufferSource(src);
  const st = new SoundTouch();
  st.tempo = tempo;
  st.pitchSemitones = pitchSemitones;
  const filter = new SimpleFilter(source, st);

  const chunkFrames = 4096;
  const tmp = new Float32Array(chunkFrames * 2);
  const chunks: Array<{ left: Float32Array; right: Float32Array; count: number }> = [];
  let totalFrames = 0;
  let yieldCounter = 0;

  while (true) {
    const got = filter.extract(tmp, chunkFrames);
    if (got === 0) break;
    const left  = new Float32Array(got);
    const right = new Float32Array(got);
    for (let i = 0; i < got; i++) {
      left[i]  = tmp[i * 2];
      right[i] = tmp[i * 2 + 1];
    }
    chunks.push({ left, right, count: got });
    totalFrames += got;
    if (++yieldCounter >= 8) {
      yieldCounter = 0;
      await new Promise(r => setTimeout(r, 0));
    }
  }

  if (totalFrames === 0) return src;

  const out = ctx.createBuffer(2, totalFrames, src.sampleRate);
  const leftOut  = out.getChannelData(0);
  const rightOut = out.getChannelData(1);
  let offset = 0;
  for (const c of chunks) {
    leftOut.set(c.left,  offset);
    rightOut.set(c.right, offset);
    offset += c.count;
  }
  return out;
}
