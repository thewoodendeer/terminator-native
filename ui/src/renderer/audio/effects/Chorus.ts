import { setParam } from './param';

export class Chorus {
  readonly input: GainNode;
  readonly output: GainNode;
  private delay: DelayNode;
  private lfo: OscillatorNode;
  private lfoGain: GainNode;
  private dryGain: GainNode;
  private wetGain: GainNode;
  private _rate = 0.35;
  // User-facing depth is 0..1 (the slider). Internally that maps to the
  // physical LFO delay-modulation depth in seconds (max ≈ 0.02s = 20ms
  // for a musical chorus/tape sound).
  private _depth = 0.02;
  private _mix = 0.35;
  private _bypassed = false;

  constructor(private ctx: BaseAudioContext) {
    this.input = ctx.createGain();
    this.output = ctx.createGain();
    this.delay = ctx.createDelay(0.1);
    this.delay.delayTime.value = 0.025;
    this.lfo = ctx.createOscillator();
    this.lfo.type = 'sine';
    this.lfo.frequency.value = this._rate;
    this.lfoGain = ctx.createGain();
    this.lfoGain.gain.value = this._depth * 0.02;
    this.dryGain = ctx.createGain();
    this.wetGain = ctx.createGain();

    this.lfo.connect(this.lfoGain);
    this.lfoGain.connect(this.delay.delayTime);

    this.input.connect(this.dryGain);
    this.dryGain.connect(this.output);
    this.input.connect(this.delay);
    this.delay.connect(this.wetGain);
    this.wetGain.connect(this.output);

    this.setMix(this._mix);
    this.lfo.start();
  }

  setRate(v: number) {
    this._rate = Math.max(0.1, Math.min(10, v));
    setParam(this.ctx, this.lfo.frequency, this._rate);
  }

  setDepth(v: number) {
    // v is the user-facing 0..1 depth (slider position). LFO mod amount
    // is clamped to a musical 0..20ms internally so the slider sweeps the
    // whole useful range instead of being stuck at the bottom 2%.
    this._depth = Math.max(0, Math.min(1, v));
    setParam(this.ctx, this.lfoGain.gain, this._depth * 0.02);
  }

  setMix(v: number) {
    this._mix = Math.max(0, Math.min(1, v));
    if (!this._bypassed) {
      this.dryGain.gain.value = 1 - this._mix;
      this.wetGain.gain.value = this._mix;
    }
  }

  setBypassed(b: boolean) {
    this._bypassed = b;
    this.dryGain.gain.value = b ? 1 : 1 - this._mix;
    this.wetGain.gain.value = b ? 0 : this._mix;
  }

  dispose() {
    try { this.lfo.stop(); } catch (_) {}
  }

  get rate() { return this._rate; }
  get depth() { return this._depth; }
  get mix() { return this._mix; }
  get bypassed() { return this._bypassed; }
}
