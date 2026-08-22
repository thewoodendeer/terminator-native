import { MixerFX, FxParamValue, clamp, WetDry, setParam } from './base';

type FilterKind = 'lowpass' | 'highpass' | 'bandpass' | 'notch';

/** FILTER — single biquad. TYPE (LP/HP/BP/Notch), CUTOFF (20-20k, log knob),
 *  RESO → Q (0-30). */
export class FilterFX implements MixerFX {
  readonly inputNode: AudioNode;
  readonly outputNode: AudioNode;
  params: Record<string, FxParamValue> = { TYPE: 'lowpass', CUTOFF: 20000, RESO: 1 };
  private wd: WetDry;
  private node: BiquadFilterNode;
  private primed = false;

  constructor(private ctx: BaseAudioContext) {
    this.wd = new WetDry(ctx);
    this.node = ctx.createBiquadFilter();
    this.wd.wetIn.connect(this.node);
    this.node.connect(this.wd.wetOut);
    this.inputNode = this.wd.input;
    this.outputNode = this.wd.output;
    this.update();
    this.primed = true;
  }

  setParam(key: string, value: FxParamValue): void {
    this.params[key] = key === 'TYPE' ? String(value) : Number(value);
    this.update();
  }
  bypass(on: boolean): void { this.wd.setBypassed(on); }
  dispose(): void { try { this.node.disconnect(); } catch { /* */ } this.wd.disconnect(); }

  private update(): void {
    this.node.type = String(this.params.TYPE) as FilterKind;
    const instant = !this.primed;
    setParam(this.ctx, this.node.frequency, clamp(Number(this.params.CUTOFF), 20, 20000), 0.01, instant);
    setParam(this.ctx, this.node.Q, clamp(Number(this.params.RESO), 0.0001, 30), 0.01, instant);
  }
}
