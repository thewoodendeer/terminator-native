import { MixerFX, FxParamValue, clamp, clamp01, WetDry, setParam } from './base';

/** PHASER — a cascade of 2nd-order allpass stages swept by one LFO, with
 *  feedback from the last stage into the first for resonance. Mixed against the
 *  dry signal the moving phase shifts carve the classic sweeping notches.
 *
 *  RATE (Hz), DEPTH (%), CENTER (Hz — the sweep's middle), FEEDBACK (%),
 *  STAGES (4/6/8/12 → 2/3/4/6 notches), DRY/WET (%; 50 = deepest notches).
 *
 *  Stage centres are spread ±½ octave around CENTER so the notches don't pile
 *  onto one frequency; the LFO adds a linear offset scaled by DEPTH×CENTER,
 *  clamped so a stage never sweeps below 40 Hz. */
export class PhaserFX implements MixerFX {
  readonly inputNode: AudioNode;
  readonly outputNode: AudioNode;
  params: Record<string, FxParamValue> = { RATE: 0.4, DEPTH: 70, CENTER: 900, FEEDBACK: 30, STAGES: 6, WET: 50 };
  private wd: WetDry;
  private stages: BiquadFilterNode[] = [];
  private stageIn: GainNode;
  private stageOut: GainNode;
  private fb: GainNode;
  private fbDelay: DelayNode;   // Web Audio mutes a cycle with no DelayNode; one render quantum
  private lfo: OscillatorNode;
  private lfoDepth: GainNode;
  private started = false;
  private primed = false;

  constructor(private ctx: BaseAudioContext) {
    this.wd = new WetDry(ctx);
    this.stageIn = ctx.createGain();
    this.stageOut = ctx.createGain();
    this.fb = ctx.createGain();
    this.fbDelay = ctx.createDelay(0.01);
    this.fbDelay.delayTime.value = 128 / ctx.sampleRate;
    this.lfo = ctx.createOscillator(); this.lfo.type = 'sine';
    this.lfoDepth = ctx.createGain();
    this.lfo.connect(this.lfoDepth);
    this.wd.wetIn.connect(this.stageIn);
    this.stageOut.connect(this.wd.wetOut);
    this.stageOut.connect(this.fb);
    this.fb.connect(this.fbDelay);
    this.fbDelay.connect(this.stageIn);
    this.inputNode = this.wd.input;
    this.outputNode = this.wd.output;
    this.rebuild();
    this.update();
    this.wd.setMix(clamp01(Number(this.params.WET) / 100));
    this.primed = true;
    try { this.lfo.start(); this.started = true; } catch { /* */ }
  }

  setParam(key: string, value: FxParamValue): void {
    this.params[key] = Number(value);
    if (key === 'STAGES') this.rebuild();
    this.update();
    this.wd.setMix(clamp01(Number(this.params.WET) / 100));
  }
  bypass(on: boolean): void { this.wd.setBypassed(on); }
  dispose(): void {
    try { if (this.started) this.lfo.stop(); } catch { /* */ }
    for (const n of [...this.stages, this.stageIn, this.stageOut, this.fb, this.fbDelay, this.lfo, this.lfoDepth]) {
      try { n.disconnect(); } catch { /* */ }
    }
    this.wd.disconnect();
  }

  /** (Re)build the allpass cascade for the current STAGES count. */
  private rebuild(): void {
    for (const s of this.stages) { try { s.disconnect(); } catch { /* */ } }
    try { this.stageIn.disconnect(); } catch { /* */ }
    try { this.lfoDepth.disconnect(); } catch { /* */ }
    const n = clamp(Math.round(Number(this.params.STAGES)), 2, 12);
    this.stages = [];
    let prev: AudioNode = this.stageIn;
    for (let i = 0; i < n; i++) {
      const ap = this.ctx.createBiquadFilter();
      ap.type = 'allpass';
      ap.Q.value = 0.6;
      prev.connect(ap);
      this.lfoDepth.connect(ap.frequency);
      this.stages.push(ap);
      prev = ap;
    }
    prev.connect(this.stageOut);
    // Frequencies are set in update() (it runs right after rebuild()).
  }

  private update(): void {
    const instant = !this.primed;
    const set = (p: AudioParam, v: number, tau: number) => setParam(this.ctx, p, v, tau, instant);
    const rate = clamp(Number(this.params.RATE), 0.02, 10);
    const depth = clamp01(Number(this.params.DEPTH) / 100);
    const center = clamp(Number(this.params.CENTER), 100, 8000);
    const feedback = clamp(Number(this.params.FEEDBACK), 0, 90) / 100;
    set(this.lfo.frequency, rate, 0.02);
    // Linear sweep of ±depth×center×0.9 around each stage's centre, capped so
    // the lowest-tuned stage (centre × 2^-½) never dips under 40 Hz.
    const n = this.stages.length;
    const lowestCentre = center * Math.pow(2, -0.5);
    const mod = Math.min(depth * center * 0.9, Math.max(0, lowestCentre - 40));
    set(this.lfoDepth.gain, mod, 0.02);
    for (let i = 0; i < n; i++) {
      const spread = n > 1 ? (i / (n - 1)) - 0.5 : 0;         // −0.5 … +0.5 octave
      set(this.stages[i].frequency, center * Math.pow(2, spread), 0.02);
    }
    // Feedback polarity positive: resonant peaks between the notches.
    set(this.fb.gain, feedback, 0.02);
  }
}
