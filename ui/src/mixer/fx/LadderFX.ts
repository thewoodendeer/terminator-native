import { MixerFX, FxParamValue, WetDry } from './base';

/**
 * ANALOG FILTER — the Moog transistor ladder. **The device is the ENGINE's** (engine/core/fx/AnalogFx.h: four
 * nonlinear one-pole stages with the resonant feedback path, 4× oversampled, the stage taps mixed for the 24/18/12/6
 * dB lowpass and the 24/12 dB highpass and bandpass, a saturating input stage for DRIVE, and self-oscillation at
 * RESO 100). Nothing of it is reimplemented here, and nothing should be: a second version in Web Audio would be a
 * different filter wearing the same name, and it is exactly the drift the native build exists to end.
 *
 * So this class is a documented PASS-THROUGH, which is correct in the shell: the page's Web Audio graph runs for the
 * UI while the C++ engine is what is heard, and the export renders in the engine too (Phase 4.7). The one place it
 * shows is the MPC Project / Drum Rack export, which bakes the page's mixer chain into one-shot WAVs — a native-only
 * device is not in those files. That is called out in the registry entry and in Help.
 */
export class LadderFX implements MixerFX {
  readonly inputNode: AudioNode;
  readonly outputNode: AudioNode;
  params: Record<string, FxParamValue> = { MODE: 'LP24', CUTOFF: 20000, RESO: 0, DRIVE: 0, WET: 100 };
  private wd: WetDry;

  constructor(ctx: BaseAudioContext) {
    this.wd = new WetDry(ctx);
    this.wd.wetIn.connect(this.wd.wetOut); // the engine does the filtering; here the signal just passes
    this.inputNode = this.wd.input;
    this.outputNode = this.wd.output;
  }

  setParam(key: string, value: FxParamValue): void {
    this.params[key] = typeof value === 'string' ? value : Number(value);
  }
  bypass(on: boolean): void { this.wd.setBypassed(on); }
  dispose(): void { this.wd.disconnect(); }
}
