import { MixerFX, FxParamValue, clamp, WetDry, setParam } from './base';

/** EQ — 3-band: low shelf @80Hz, mid peak @1kHz, high shelf @12kHz, each ±12dB. */
export class EqFX implements MixerFX {
  readonly inputNode: AudioNode;
  readonly outputNode: AudioNode;
  params: Record<string, FxParamValue> = { LOW: 0, MID: 0, HIGH: 0 };
  private wd: WetDry;
  private low: BiquadFilterNode;
  private mid: BiquadFilterNode;
  private high: BiquadFilterNode;
  private primed = false;

  constructor(private ctx: BaseAudioContext) {
    this.wd = new WetDry(ctx);
    this.low = ctx.createBiquadFilter();
    this.low.type = 'lowshelf'; this.low.frequency.value = 80;
    this.mid = ctx.createBiquadFilter();
    this.mid.type = 'peaking'; this.mid.frequency.value = 1000; this.mid.Q.value = 0.8;
    this.high = ctx.createBiquadFilter();
    this.high.type = 'highshelf'; this.high.frequency.value = 12000;
    this.wd.wetIn.connect(this.low);
    this.low.connect(this.mid);
    this.mid.connect(this.high);
    this.high.connect(this.wd.wetOut);
    this.inputNode = this.wd.input;
    this.outputNode = this.wd.output;
    this.update();
    this.primed = true;
  }

  setParam(key: string, value: FxParamValue): void {
    this.params[key] = Number(value);
    this.update();
  }
  bypass(on: boolean): void { this.wd.setBypassed(on); }
  dispose(): void {
    for (const n of [this.low, this.mid, this.high]) { try { n.disconnect(); } catch { /* */ } }
    this.wd.disconnect();
  }

  private update(): void {
    const instant = !this.primed;
    setParam(this.ctx, this.low.gain, clamp(Number(this.params.LOW), -12, 12), 0.01, instant);
    setParam(this.ctx, this.mid.gain, clamp(Number(this.params.MID), -12, 12), 0.01, instant);
    setParam(this.ctx, this.high.gain, clamp(Number(this.params.HIGH), -12, 12), 0.01, instant);
  }
}
