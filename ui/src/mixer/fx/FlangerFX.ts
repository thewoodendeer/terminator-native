import { MixerFX, FxParamValue, clamp, clamp01, WetDry, setParam } from './base';

/** FLANGER — a very short delay (0.3–12 ms) swept by an LFO and fed back on
 *  itself, mixed with the dry signal: the comb filter's teeth sweep up and down
 *  the spectrum (the "jet" sound). Negative FEEDBACK flips the comb polarity for
 *  the hollower, through-zero-style flavour.
 *
 *  RATE (Hz), DEPTH (%), DELAY (ms — the sweep's centre), FEEDBACK (−95…95 %),
 *  DRY/WET (%; 50 = deepest comb).
 *
 *  Sweep = DELAY ± DEPTH×DELAY×0.9 (never below ~0.03 ms). The feedback path is
 *  damped with a gentle lowpass so high resonance sings instead of shrieking. */
export class FlangerFX implements MixerFX {
  readonly inputNode: AudioNode;
  readonly outputNode: AudioNode;
  params: Record<string, FxParamValue> = { RATE: 0.25, DEPTH: 60, DELAY: 3, FEEDBACK: 40, WET: 50 };
  private wd: WetDry;
  private delay: DelayNode;
  private fb: GainNode;
  private fbLp: BiquadFilterNode;
  private lfo: OscillatorNode;
  private lfoDepth: GainNode;
  private started = false;
  private primed = false;

  constructor(private ctx: BaseAudioContext) {
    this.wd = new WetDry(ctx);
    this.delay = ctx.createDelay(0.05);
    this.fb = ctx.createGain();
    this.fbLp = ctx.createBiquadFilter(); this.fbLp.type = 'lowpass'; this.fbLp.frequency.value = 9000; this.fbLp.Q.value = 0.5;
    this.lfo = ctx.createOscillator(); this.lfo.type = 'triangle';
    this.lfoDepth = ctx.createGain();
    this.lfo.connect(this.lfoDepth);
    this.lfoDepth.connect(this.delay.delayTime);
    this.wd.wetIn.connect(this.delay);
    this.delay.connect(this.wd.wetOut);
    // Feedback loop (contains the DelayNode, so Web Audio allows the cycle).
    this.delay.connect(this.fb);
    this.fb.connect(this.fbLp);
    this.fbLp.connect(this.delay);
    this.inputNode = this.wd.input;
    this.outputNode = this.wd.output;
    this.update();
    this.wd.setMix(clamp01(Number(this.params.WET) / 100));
    this.primed = true;
    try { this.lfo.start(); this.started = true; } catch { /* */ }
  }

  setParam(key: string, value: FxParamValue): void {
    this.params[key] = Number(value);
    this.update();
    this.wd.setMix(clamp01(Number(this.params.WET) / 100));
  }
  bypass(on: boolean): void { this.wd.setBypassed(on); }
  dispose(): void {
    try { if (this.started) this.lfo.stop(); } catch { /* */ }
    for (const n of [this.delay, this.fb, this.fbLp, this.lfo, this.lfoDepth]) { try { n.disconnect(); } catch { /* */ } }
    this.wd.disconnect();
  }

  private update(): void {
    const instant = !this.primed;
    const set = (p: AudioParam, v: number, tau: number) => setParam(this.ctx, p, v, tau, instant);
    const rate = clamp(Number(this.params.RATE), 0.02, 8);
    const depth = clamp01(Number(this.params.DEPTH) / 100);
    const base = clamp(Number(this.params.DELAY), 0.3, 12) / 1000;
    const feedback = clamp(Number(this.params.FEEDBACK), -95, 95) / 100;
    set(this.lfo.frequency, rate, 0.02);
    set(this.delay.delayTime, base, 0.02);
    // ±depth×base×0.9 keeps the delay ≥ 0.1×base > 0 at the trough.
    set(this.lfoDepth.gain, depth * base * 0.9, 0.02);
    set(this.fb.gain, feedback, 0.02);
  }
}
