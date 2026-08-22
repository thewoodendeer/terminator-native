import { MixerFX, FxParamValue, clamp, clamp01, WetDry, setParam } from './base';

/** DELAY — stereo feedback delay with an optional ping-pong bounce.
 *  TIME (ms), FEEDBACK (%), DRY/WET (%), PINGPONG (0/1).
 *
 *  Each side has its OWN feedback loop (the old build summed L+R into one gain,
 *  so stereo material collapsed to mono on the first repeat), and each loop is
 *  damped — a gentle lowpass so repeats darken like tape/BBD echoes instead of
 *  stacking digital brightness, and a highpass so sub-bass never builds up. */
export class DelayFX implements MixerFX {
  readonly inputNode: AudioNode;
  readonly outputNode: AudioNode;
  params: Record<string, FxParamValue> = { TIME: 300, FEEDBACK: 35, WET: 30, PINGPONG: 0 };
  private wd: WetDry;
  private delayL: DelayNode;
  private delayR: DelayNode;
  private fbL: GainNode;
  private fbR: GainNode;
  private dampL: { lp: BiquadFilterNode; hp: BiquadFilterNode };
  private dampR: { lp: BiquadFilterNode; hp: BiquadFilterNode };
  private merger: ChannelMergerNode;
  private primed = false;

  constructor(private ctx: BaseAudioContext) {
    this.wd = new WetDry(ctx);
    this.delayL = ctx.createDelay(2.0);
    this.delayR = ctx.createDelay(2.0);
    this.fbL = ctx.createGain();
    this.fbR = ctx.createGain();
    this.dampL = DelayFX.makeDamp(ctx);
    this.dampR = DelayFX.makeDamp(ctx);
    // fb → lp → hp is permanent; rebuild() wires the loop ends.
    this.fbL.connect(this.dampL.lp); this.dampL.lp.connect(this.dampL.hp);
    this.fbR.connect(this.dampR.lp); this.dampR.lp.connect(this.dampR.hp);
    this.merger = ctx.createChannelMerger(2);
    this.merger.connect(this.wd.wetOut);
    this.inputNode = this.wd.input;
    this.outputNode = this.wd.output;
    this.rebuild();
    this.update();
    this.primed = true;
  }

  private static makeDamp(ctx: BaseAudioContext) {
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 7500; lp.Q.value = 0.5;
    const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 90; hp.Q.value = 0.5;
    return { lp, hp };
  }

  setParam(key: string, value: FxParamValue): void {
    this.params[key] = Number(value);
    if (key === 'PINGPONG') this.rebuild();
    this.update();
    this.wd.setMix(clamp01(Number(this.params.WET) / 100));
  }
  bypass(on: boolean): void { this.wd.setBypassed(on); }
  dispose(): void {
    for (const n of [this.delayL, this.delayR, this.fbL, this.fbR, this.dampL.lp, this.dampL.hp, this.dampR.lp, this.dampR.hp, this.merger]) {
      try { n.disconnect(); } catch { /* */ }
    }
    this.wd.disconnect();
  }

  /** Re-wire the wet topology between ping-pong (bounce L→R→L) and dual mono. */
  private rebuild(): void {
    try { this.wd.wetIn.disconnect(); } catch { /* */ }
    try { this.delayL.disconnect(); } catch { /* */ }
    try { this.delayR.disconnect(); } catch { /* */ }
    try { this.dampL.hp.disconnect(); } catch { /* */ }
    try { this.dampR.hp.disconnect(); } catch { /* */ }
    // Always feed both delays to the merger.
    this.delayL.connect(this.merger, 0, 0);
    this.delayR.connect(this.merger, 0, 1);
    if (Number(this.params.PINGPONG) >= 0.5) {
      // input → L → R → (feedback) → L : the echo bounces across the stereo field.
      this.wd.wetIn.connect(this.delayL);
      this.delayL.connect(this.delayR);
      this.delayR.connect(this.fbL);
      this.dampL.hp.connect(this.delayL);
    } else {
      // Truly independent L/R feedback taps.
      this.wd.wetIn.connect(this.delayL);
      this.wd.wetIn.connect(this.delayR);
      this.delayL.connect(this.fbL);
      this.dampL.hp.connect(this.delayL);
      this.delayR.connect(this.fbR);
      this.dampR.hp.connect(this.delayR);
    }
  }

  private update(): void {
    const instant = !this.primed;
    const time = clamp(Number(this.params.TIME), 1, 2000) / 1000;
    setParam(this.ctx, this.delayL.delayTime, time, 0.01, instant);
    // A hair of L/R offset gives the non-ping-pong mode a wider image.
    setParam(this.ctx, this.delayR.delayTime, Math.min(2, time * 1.02), 0.01, instant);
    const fb = clamp(Number(this.params.FEEDBACK), 0, 95) / 100;
    setParam(this.ctx, this.fbL.gain, fb, 0.01, instant);
    setParam(this.ctx, this.fbR.gain, fb, 0.01, instant);
  }
}
