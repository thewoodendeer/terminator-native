/**
 * PEAK METER — one worklet per mixer strip, replacing six AnalyserNodes.
 *
 * WHY: every ChannelStrip used to carry 6 analysers (preL/preR, postL/postR and
 * two gain-match taps). With ~11 strips that is ~66 analysers all doing work on
 * the AUDIO thread, plus the meter loop pulling 4 × 4096-sample windows per
 * strip per frame on the MAIN thread. This node does the same measurement where
 * the samples already are and PUSHES scalars out, like the loudness meter.
 *
 * INPUTS (all stereo, listen-only — numberOfOutputs is 0):
 *   0 = pre-fader   → peak per channel
 *   1 = post-fader  → peak per channel
 *   2 = chain IN    → RMS (gain match)
 *   3 = chain OUT   → RMS (gain match)
 *
 * WINDOW: the analysers it replaces reported max/RMS over their last
 * fftSize (4096) samples — ~93 ms — so a slow frame could not fall between two
 * reads and miss a peak. That is reproduced exactly with a ring of per-block
 * (128-sample) partials covering 4096 samples; the reported value is the max
 * (or the RMS) across the ring, block-quantised.
 *
 * POST RATE: every POST_BLOCKS blocks (~46 ms). The values are already
 * windowed over 93 ms, so the main thread reading a cached scalar at 60 fps
 * looks the same as it did pulling the window itself.
 */
const WINDOW_SAMPLES = 4096;
const BLOCK = 128;
const RING = WINDOW_SAMPLES / BLOCK;   // 32 blocks ≈ 93 ms at 44.1k
const POST_BLOCKS = 16;                // ≈46 ms

class Ring {
  constructor() { this.buf = new Float32Array(RING); this.i = 0; }
  push(v) { this.buf[this.i] = v; this.i = (this.i + 1) % RING; }
  max() { let m = 0; for (let k = 0; k < RING; k++) { const v = this.buf[k]; if (v > m) m = v; } return m; }
  /** Mean of the stored per-block MEAN-SQUARES → RMS over the whole window,
   *  identical to the analyser's rmsOf over its window. */
  rms() { let s = 0; for (let k = 0; k < RING; k++) s += this.buf[k]; return Math.sqrt(s / RING); }
}

class PeakMeter extends AudioWorkletProcessor {
  constructor() {
    super();
    this.preL = new Ring(); this.preR = new Ring();
    this.postL = new Ring(); this.postR = new Ring();
    this.inSq = new Ring(); this.outSq = new Ring();
    this.n = 0;
    this.port.onmessage = (e) => { if (e.data === 'reset') this.reset(); };
  }
  reset() {
    for (const r of [this.preL, this.preR, this.postL, this.postR, this.inSq, this.outSq]) r.buf.fill(0);
  }
  /** Peak of one channel of one input; 0 when that input isn't rendering. */
  static peak(ch) {
    if (!ch) return 0;
    let p = 0;
    for (let i = 0; i < ch.length; i++) { const a = ch[i] < 0 ? -ch[i] : ch[i]; if (a > p) p = a; }
    return p;
  }
  /** Mean square of a whole (mono-summed) input block. */
  static meanSq(input) {
    if (!input || !input.length) return 0;
    let s = 0, n = 0;
    for (let c = 0; c < input.length; c++) {
      const ch = input[c];
      for (let i = 0; i < ch.length; i++) { s += ch[i] * ch[i]; }
      n += ch.length;
    }
    return n ? s / n : 0;
  }
  process(inputs) {
    const pre = inputs[0] || [], post = inputs[1] || [];
    this.preL.push(PeakMeter.peak(pre[0]));
    this.preR.push(PeakMeter.peak(pre[1] || pre[0]));
    this.postL.push(PeakMeter.peak(post[0]));
    this.postR.push(PeakMeter.peak(post[1] || post[0]));
    this.inSq.push(PeakMeter.meanSq(inputs[2]));
    this.outSq.push(PeakMeter.meanSq(inputs[3]));
    if (++this.n >= POST_BLOCKS) {
      this.n = 0;
      this.port.postMessage({
        preL: this.preL.max(), preR: this.preR.max(),
        postL: this.postL.max(), postR: this.postR.max(),
        inRms: this.inSq.rms(), outRms: this.outSq.rms(),
      });
    }
    return true; // listen-only: keep running even when the strip is silent
  }
}
registerProcessor('peak-meter', PeakMeter);
