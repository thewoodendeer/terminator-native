import { MixerFX, FxParamValue, clamp, clamp01, WetDry, setParam } from './base';

/** PAN — auto-pan / tremolo-pan. A sine LFO (RATE 0.1-10 Hz) modulates a
 *  StereoPanner; DEPTH (0-100%) scales the sweep. */
export class PanFX implements MixerFX {
  readonly inputNode: AudioNode;
  readonly outputNode: AudioNode;
  params: Record<string, FxParamValue> = { RATE: 1, DEPTH: 50 };
  private wd: WetDry;
  private panner: StereoPannerNode;
  private lfo: OscillatorNode;
  private depth: GainNode;
  private started = false;
  private primed = false;

  constructor(private ctx: BaseAudioContext) {
    this.wd = new WetDry(ctx);
    this.panner = ctx.createStereoPanner();
    this.lfo = ctx.createOscillator();
    this.lfo.type = 'sine';
    this.depth = ctx.createGain();
    this.lfo.connect(this.depth);
    this.depth.connect(this.panner.pan);
    this.wd.wetIn.connect(this.panner);
    this.panner.connect(this.wd.wetOut);
    this.inputNode = this.wd.input;
    this.outputNode = this.wd.output;
    this.update();
    this.primed = true;
    try { this.lfo.start(); this.started = true; } catch { /* */ }
  }

  setParam(key: string, value: FxParamValue): void {
    this.params[key] = Number(value);
    this.update();
  }
  bypass(on: boolean): void { this.wd.setBypassed(on); }
  dispose(): void {
    try { if (this.started) this.lfo.stop(); } catch { /* */ }
    for (const n of [this.lfo, this.depth, this.panner]) { try { n.disconnect(); } catch { /* */ } }
    this.wd.disconnect();
  }

  private update(): void {
    const instant = !this.primed;
    setParam(this.ctx, this.lfo.frequency, clamp(Number(this.params.RATE), 0.1, 10), 0.01, instant);
    setParam(this.ctx, this.depth.gain, clamp01(Number(this.params.DEPTH) / 100), 0.01, instant);
  }
}
