import { setParam } from './param';

export class AutoPan {
  readonly input: GainNode;
  readonly output: GainNode;
  private panner:  StereoPannerNode;
  private lfo:     OscillatorNode;
  private lfoGain: GainNode;
  private dryGain: GainNode;
  private wetGain: GainNode;

  private _rate     = 1;
  private _depth    = 0.7;
  private _mix      = 1;
  private _bypassed = false;
  private _shape: OscillatorType = 'sine';

  constructor(private ctx: BaseAudioContext) {
    this.input   = ctx.createGain();
    this.output  = ctx.createGain();
    this.panner  = ctx.createStereoPanner();
    this.lfo     = ctx.createOscillator();
    this.lfoGain = ctx.createGain();
    this.dryGain = ctx.createGain();
    this.wetGain = ctx.createGain();

    // LFO → lfoGain → panner.pan
    this.lfo.connect(this.lfoGain);
    this.lfoGain.connect(this.panner.pan);

    // Dry path: input → dryGain → output
    this.input.connect(this.dryGain);
    this.dryGain.connect(this.output);

    // Wet path: input → panner → wetGain → output
    this.input.connect(this.panner);
    this.panner.connect(this.wetGain);
    this.wetGain.connect(this.output);

    this.lfo.type      = this._shape;
    this.lfo.frequency.value = this._rate;
    this.lfoGain.gain.value  = this._depth;

    this.lfo.start();
    this.setMix(this._mix);
  }

  setRate(v: number): void {
    this._rate = Math.max(0.01, Math.min(20, v));
    setParam(this.ctx, this.lfo.frequency, this._rate);
  }

  setDepth(v: number): void {
    this._depth = Math.max(0, Math.min(1, v));
    setParam(this.ctx, this.lfoGain.gain, this._depth);
  }

  setShape(s: OscillatorType): void {
    this._shape = s;
    this.lfo.type = s;
  }

  setMix(v: number): void {
    this._mix = Math.max(0, Math.min(1, v));
    if (!this._bypassed) {
      const t = this.ctx.currentTime;
      this.dryGain.gain.setTargetAtTime(1 - this._mix, t, 0.01);
      this.wetGain.gain.setTargetAtTime(this._mix,     t, 0.01);
    }
  }

  setBypassed(b: boolean): void {
    this._bypassed = b;
    const t = this.ctx.currentTime;
    this.dryGain.gain.setTargetAtTime(b ? 1 : 1 - this._mix, t, 0.01);
    this.wetGain.gain.setTargetAtTime(b ? 0 : this._mix,     t, 0.01);
  }

  dispose(): void {
    this.lfo.stop();
    this.lfo.disconnect();
    this.lfoGain.disconnect();
    this.panner.disconnect();
    this.dryGain.disconnect();
    this.wetGain.disconnect();
    this.input.disconnect();
    this.output.disconnect();
  }

  get rate():     number        { return this._rate; }
  get depth():    number        { return this._depth; }
  get mix():      number        { return this._mix; }
  get bypassed(): boolean       { return this._bypassed; }
  get shape():    OscillatorType { return this._shape; }
}
