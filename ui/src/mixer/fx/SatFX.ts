import { MixerFX, FxParamValue, clamp, WetDry } from './base';
import { oversampleLatencySec, oversampleLatencyKnown } from '../../renderer/audio/compressorLatency';

/** SAT — tape saturation using the Doidic soft-saturation curve
 *  y = (3x/2)(1 − x²/3), clamped to ±1. Even-harmonic, low-end preserving.
 *  DRIVE (0-100) pre-gains the input into the curve. */
export class SatFX implements MixerFX {
  readonly inputNode: AudioNode;
  readonly outputNode: AudioNode;
  params: Record<string, FxParamValue> = { DRIVE: 0 };
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
    const drive = clamp(Number(this.params.DRIVE), 0, 100) / 100;
    const g = 1 + drive * 2; // pre-gain into the Doidic curve
    const N = 4096;
    const curve = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      let x = ((i / (N - 1)) * 2 - 1) * g;
      x = clamp(x, -1, 1);
      curve[i] = (3 * x / 2) * (1 - (x * x) / 3);
    }
    this.shaper.curve = curve;
  }
}
