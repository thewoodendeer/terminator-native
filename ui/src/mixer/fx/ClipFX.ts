import { MixerFX, FxParamValue, WetDry, clamp } from './base';
import { oversampleLatencySec, oversampleLatencyKnown } from '../../renderer/audio/compressorLatency';

/** CLIP — soft clipper. AMT (0-100) lowers the soft-knee threshold so more of
 *  the waveform is rounded over. 4x oversampled WaveShaper. */
export class ClipFX implements MixerFX {
  readonly inputNode: AudioNode;
  readonly outputNode: AudioNode;
  params: Record<string, FxParamValue> = { AMT: 0 };
  private wd: WetDry;
  private shaper: WaveShaperNode;

  constructor(private ctx: BaseAudioContext) {
    this.ready = oversampleLatencySec(ctx.sampleRate, '4x').then(() => undefined);
    this.wd = new WetDry(ctx);
    this.shaper = ctx.createWaveShaper();
    this.shaper.oversample = '4x';
    this.wd.wetIn.connect(this.shaper);
    this.shaper.connect(this.wd.wetOut);
    this.inputNode = this.wd.input;
    this.outputNode = this.wd.output;
    this.update();
  }

  setParam(key: string, value: FxParamValue): void {
    this.params[key] = Number(value);
    this.update();
  }
  bypass(on: boolean): void { this.wd.setBypassed(on); }
  /** 4x-oversampled WaveShaper: measured 192 frames of up/down-sampler latency. */
  latencySec(): number { return oversampleLatencyKnown(this.ctx.sampleRate, '4x'); }
  readonly ready: Promise<void>;
  dispose(): void { try { this.shaper.disconnect(); } catch { /* */ } this.wd.disconnect(); }

  private update(): void {
    const amt = clamp(Number(this.params.AMT), 0, 100) / 100;
    const t = 1 - amt * 0.9; // threshold 1 → 0.1
    const ceiling = 0.9886;  // −0.1 dBFS — never reaches 0 dBFS, so the clipper
                             // alone can't trip the meter's clip indicator.
    const N = 4096;
    const curve = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      const x = (i / (N - 1)) * 2 - 1;
      const s = Math.sign(x);
      const ax = Math.abs(x);
      let y = ax;
      if (t < 1 && ax > t) {
        const o = ax - t;
        const d = 1 - t;
        y = t + o / (1 + Math.pow(o / d, 2));
      }
      curve[i] = s * Math.min(ceiling, y);
    }
    this.shaper.curve = curve;
  }
}
