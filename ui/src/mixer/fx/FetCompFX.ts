import { MixerFX, FxParamValue, WetDry } from './base';

/**
 * FET COMP — the aggressive FET compressor. **The device is the ENGINE's** (engine/core/fx/AnalogFx.h: a RATIO
 * switch instead of a threshold knob, a filtered detector, program-dependent release, the DIST 2 / DIST 3 harmonic
 * modes and BRITISH mode, all on a bounded output stage with a DC blocker). Like the ANALOG FILTER this class is a
 * documented PASS-THROUGH — see LadderFX's header for why a Web Audio "version" would be the wrong thing to build.
 *
 * `gainReductionDb` is written by the native mixer shadow from the engine's snapshot, which is what the panel's GR
 * readout displays. It stays 0 outside the shell, where nothing is compressing.
 */
export class FetCompFX implements MixerFX {
  readonly inputNode: AudioNode;
  readonly outputNode: AudioNode;
  params: Record<string, FxParamValue> = {
    RATIO: '4:1', INPUT: 0, ATTACK: 3, RELEASE: 150, DETECT: 'FLAT', MODE: 'CLEAN', OUTPUT: 0, WET: 100,
  };
  /** Gain reduction in dB (≤ 0), mirrored from the engine. */
  gainReductionDb = 0;
  private wd: WetDry;

  constructor(ctx: BaseAudioContext) {
    this.wd = new WetDry(ctx);
    this.wd.wetIn.connect(this.wd.wetOut); // the engine does the compressing
    this.inputNode = this.wd.input;
    this.outputNode = this.wd.output;
  }

  setParam(key: string, value: FxParamValue): void {
    this.params[key] = typeof value === 'string' ? value : Number(value);
  }
  bypass(on: boolean): void { this.wd.setBypassed(on); }
  dispose(): void { this.wd.disconnect(); }
}
