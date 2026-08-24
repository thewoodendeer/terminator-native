import { MixerFX, FxParamValue, WetDry } from './base';

/**
 * EQ 6 — the multi-band parametric. **The device is the ENGINE's** (engine/core/fx/AnalogFx.h: six bands of
 * bell / shelf / cut / notch / tilt with real cascaded Butterworth slopes to 96 dB/oct, and a band set to OFF
 * costing nothing at all). Documented PASS-THROUGH — see LadderFX's header.
 */
export class Eq6FX implements MixerFX {
  readonly inputNode: AudioNode;
  readonly outputNode: AudioNode;
  params: Record<string, FxParamValue> = (() => {
    const p: Record<string, FxParamValue> = {};
    const freqs = [60, 200, 800, 2500, 6000, 12000];
    for (let b = 1; b <= 6; b++) {
      p[`TYPE${b}`] = 'OFF';
      p[`FREQ${b}`] = freqs[b - 1];
      p[`GAIN${b}`] = 0;
      p[`Q${b}`] = 1;
      p[`SLOPE${b}`] = '24';
    }
    p.OUT = 0;
    return p;
  })();
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
