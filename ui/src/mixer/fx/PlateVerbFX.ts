import { MixerFX, FxParamValue, WetDry } from './base';

/**
 * HALL 224 — the Lexicon 224's programs on a Dattorro tank. **The device is the ENGINE's**
 * (engine/core/fx/AnalogFx.h: input diffusion into two cross-coupled modulated half-loops, DECAY solved in SECONDS
 * from the tank's own round trip, a bass decay MULTIPLIER and treble damping inside the loop). Like the other
 * premium devices this class is a documented PASS-THROUGH — see LadderFX's header.
 */
export class PlateVerbFX implements MixerFX {
  readonly inputNode: AudioNode;
  readonly outputNode: AudioNode;
  params: Record<string, FxParamValue> = {
    PROGRAM: 'HALL', PREDELAY: 0, DECAY: 2, SIZE: 70, DIFFUSION: 70, BASS: 1, DAMP: 40, MOD: 50, WET: 30,
  };
  private wd: WetDry;

  constructor(ctx: BaseAudioContext) {
    this.wd = new WetDry(ctx);
    this.wd.wetIn.connect(this.wd.wetOut); // the engine builds the room
    this.inputNode = this.wd.input;
    this.outputNode = this.wd.output;
  }

  setParam(key: string, value: FxParamValue): void {
    this.params[key] = typeof value === 'string' ? value : Number(value);
  }
  bypass(on: boolean): void { this.wd.setBypassed(on); }
  dispose(): void { this.wd.disconnect(); }
}
