export type GridDiv =
  | '1/4' | '1/8' | '1/16' | '1/32' | '1/64' | '1/128'
  | '1/4t' | '1/8t' | '1/16t' | '1/32t';

const GRID_SUBDIVISIONS: Record<GridDiv, number> = {
  '1/4':   1,
  '1/8':   2,
  '1/16':  4,
  '1/32':  8,
  '1/64':  16,
  '1/128': 32,
  '1/4t':  1.5,
  '1/8t':  3,
  '1/16t': 6,
  '1/32t': 12,
};

export class Quantizer {
  bpm: number;
  swing: number; // 50 (straight) → 75 (heavy swing)

  constructor(bpm = 120, swing = 50) {
    this.bpm = bpm;
    this.swing = swing;
  }

  beatDuration(): number {
    return 60 / this.bpm;
  }

  gridDuration(div: GridDiv): number {
    return this.beatDuration() / GRID_SUBDIVISIONS[div];
  }

  /** Snap time to nearest grid division */
  quantize(rawTime: number, div: GridDiv): number {
    const grid = this.gridDuration(div);
    return Math.round(rawTime / grid) * grid;
  }

  /**
   * Apply MPC-style swing: delay every other grid hit.
   * swingAmount 50 = straight, 75 = maximum.
   */
  applySwing(gridIndex: number, div: GridDiv): number {
    const grid = this.gridDuration(div);
    const isOdd = gridIndex % 2 === 1;
    if (!isOdd) return gridIndex * grid;
    const swingDelay = ((this.swing - 50) / 50) * grid;
    return gridIndex * grid + swingDelay;
  }

  /**
   * Post-record quantize: move each onset in a buffer to the nearest grid.
   * Returns a new AudioBuffer with silence gaps re-timed.
   * (Simplified: returns original buffer if no onset detection available.)
   */
  quantizeBuffer(
    ctx: AudioContext | OfflineAudioContext,
    buf: AudioBuffer,
    div: GridDiv
  ): AudioBuffer {
    const grid = this.gridDuration(div);
    const sr = buf.sampleRate;
    const gridSamples = Math.round(grid * sr);
    const outLen = Math.ceil(buf.length / gridSamples) * gridSamples;
    const out = ctx.createBuffer(buf.numberOfChannels, outLen, sr);

    for (let ch = 0; ch < buf.numberOfChannels; ch++) {
      const src = buf.getChannelData(ch);
      const dst = out.getChannelData(ch);
      // Copy + pad; onset detection would live here in a full impl
      dst.set(src.subarray(0, Math.min(src.length, outLen)));
    }
    return out;
  }

  loopDuration(bars: number, beatsPerBar = 4): number {
    return bars * beatsPerBar * this.beatDuration();
  }
}
