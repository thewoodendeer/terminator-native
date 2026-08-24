import { MixerFX, FxParamValue, WetDry } from './base';

/**
 * TAPE ECHO — the RE-201 Space Echo. **The device is the ENGINE's** (engine/core/fx/AnalogFx.h: one tape loop read
 * by three fixed playback heads, a motor-speed TIME that glides so a move bends pitch, wow + flutter, tape
 * saturation and a head bump INSIDE the feedback loop so every repeat is darker than the last, INTENSITY that runs
 * away into self-oscillation, and the spring tank). Like the other premium devices this class is a documented
 * PASS-THROUGH — see LadderFX's header for why a Web Audio "version" would be the wrong thing to build.
 */
export class TapeEchoFX implements MixerFX {
  readonly inputNode: AudioNode;
  readonly outputNode: AudioNode;
  params: Record<string, FxParamValue> = {
    MODE: 'H1+2+3', TIME: 350, INTENSITY: 35, WOW: 25, SAT: 30, BASS: 0, TREBLE: 0, SPRING: 0, WET: 35,
  };
  private wd: WetDry;

  constructor(ctx: BaseAudioContext) {
    this.wd = new WetDry(ctx);
    this.wd.wetIn.connect(this.wd.wetOut); // the engine does the echoing
    this.inputNode = this.wd.input;
    this.outputNode = this.wd.output;
  }

  setParam(key: string, value: FxParamValue): void {
    this.params[key] = typeof value === 'string' ? value : Number(value);
  }
  bypass(on: boolean): void { this.wd.setBypassed(on); }
  dispose(): void { this.wd.disconnect(); }
}
