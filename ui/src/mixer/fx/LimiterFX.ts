import { MixerFX, FxParamValue, WetDry } from './base';

/**
 * LIMITER — the mastering limiter. **The device is the ENGINE's** (engine/core/fx/AnalogFx.h: styles, look-ahead
 * with a sliding-minimum anticipation, TRUE-peak detection, and a hard clamp that makes exceeding the ceiling
 * impossible rather than unlikely). Documented PASS-THROUGH — see LadderFX's header.
 *
 * `gainReductionDb` is mirrored from the engine's snapshot by the native mixer shadow.
 */
export class LimiterFX implements MixerFX {
  readonly inputNode: AudioNode;
  readonly outputNode: AudioNode;
  params: Record<string, FxParamValue> = {
    STYLE: 'ALLROUND', GAIN: 0, CEILING: -0.3, RELEASE: 120, LOOKAHEAD: 3, TP: 'OFF', LINK: 100,
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

  /** The look-ahead the engine reports as latency — PDC lines the strip up from it. */
  latencySec(): number { return Number(this.params.LOOKAHEAD) / 1000; }

  setParam(key: string, value: FxParamValue): void {
    this.params[key] = typeof value === 'string' ? value : Number(value);
  }
  bypass(on: boolean): void { this.wd.setBypassed(on); }
  dispose(): void { this.wd.disconnect(); }
}
