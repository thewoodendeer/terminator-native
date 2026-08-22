import { MixerFX, FxParamValue, WetDry, clamp } from './base';
import { oversampleLatencySec, oversampleLatencyKnown } from '../../renderer/audio/compressorLatency';

/** WAVE — warm overdrive waveshaper. DRIVE (0-100) pushes a tanh sigmoid harder
 *  for richer harmonics than the soft clipper. 4x oversampled. */
export class WaveFX implements MixerFX {
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
    const k = 1 + drive * 24; // 1 (clean) → 25 (hot)
    const norm = Math.tanh(k); // keep the peak near ±1 across the drive range
    const N = 2048;
    const curve = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      const x = (i / (N - 1)) * 2 - 1;
      curve[i] = Math.tanh(x * k) / norm;
    }
    this.shaper.curve = curve;
  }
}
