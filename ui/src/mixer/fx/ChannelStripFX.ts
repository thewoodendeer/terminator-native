import { MixerFX, FxParamValue, WetDry } from './base';

/**
 * CHANNEL — the SSL 4000 G channel strip. **The device is the ENGINE's** (engine/core/fx/AnalogFx.h: the filters,
 * the four-band EQ with its E and G curves — on the G the Q follows the gain — and a dynamics section that can sit
 * before or after the EQ). Documented PASS-THROUGH: see LadderFX's header.
 *
 * `gainReductionDb` is mirrored from the engine's snapshot by the native mixer shadow.
 */
export class ChannelStripFX implements MixerFX {
  readonly inputNode: AudioNode;
  readonly outputNode: AudioNode;
  params: Record<string, FxParamValue> = {
    HPF: 16, LPF: 22000,
    LF: 0, 'LF HZ': 80, 'LF BELL': 'SHELF',
    LMF: 0, 'LMF HZ': 400, 'LMF Q': 1,
    HMF: 0, 'HMF HZ': 3000, 'HMF Q': 1,
    HF: 0, 'HF HZ': 8000, 'HF BELL': 'SHELF',
    CURVE: 'G',
    'C THRESH': 0, 'C RATIO': 2, 'C REL': 300, 'C ATK': 'SLOW',
    'G THRESH': -80, 'G RANGE': 0, 'G REL': 300,
    DYN: 'POST EQ', OUT: 0,
  };
  /** Gain reduction in dB (<= 0), mirrored from the engine. */
  gainReductionDb = 0;
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
