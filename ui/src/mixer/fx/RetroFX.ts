import { MixerFX, FxParamValue, WetDry } from './base';

/**
 * RETRO — the RC-20-shaped character box: NOISE, WOBBLE, DISTORT (eight curves), DIGITAL, SPACE and MAGNETIC.
 * **The device is the ENGINE's** (engine/core/fx/AnalogFx.h), and every random element in it is SEEDED and reset
 * with the device, so a bounce is the same take you heard. Documented PASS-THROUGH — see LadderFX's header.
 */
export class RetroFX implements MixerFX {
  readonly inputNode: AudioNode;
  readonly outputNode: AudioNode;
  params: Record<string, FxParamValue> = {
    NOISE: 0, NTYPE: 'VINYL', WOBBLE: 0, DISTORT: 0, DTYPE: 'TUBE', DIGITAL: 0, SPACE: 0, MAGNETIC: 0, WET: 100,
  };
  private wd: WetDry;

  constructor(ctx: BaseAudioContext) {
    this.wd = new WetDry(ctx);
    this.wd.wetIn.connect(this.wd.wetOut);
    this.inputNode = this.wd.input;
    this.outputNode = this.wd.output;
  }

  setParam(key: string, value: FxParamValue): void {
    this.params[key] = typeof value === 'string' ? value : Number(value);
  }
  bypass(on: boolean): void { this.wd.setBypassed(on); }
  dispose(): void { this.wd.disconnect(); }
}
