import { MixerFX, FxParamValue, WetDry } from './base';

/**
 * SATURATOR — five analogue flavours on one stage (tube / germanium / British console / transformer / punish).
 * **The device is the ENGINE's** (engine/core/fx/AnalogFx.h: bounded curves, 4x oversampled, DC-blocked, with an
 * auto-gain that asks the curve itself what it did rather than guessing a power law). Documented PASS-THROUGH —
 * see LadderFX's header.
 */
export class SaturatorFX implements MixerFX {
  readonly inputNode: AudioNode;
  readonly outputNode: AudioNode;
  params: Record<string, FxParamValue> = {
    STYLE: 'A TUBE', DRIVE: 0, TONE: 0, LOWCUT: 20, HIGHCUT: 20000, PUNISH: 'OFF', OUTPUT: 0, WET: 100,
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
