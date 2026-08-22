import { setParam } from './param';

export type FilterType = 'lowpass' | 'highpass' | 'bandpass';

export class Filter {
  readonly input:  GainNode;
  readonly output: GainNode;
  private node:     BiquadFilterNode;
  private dryGain:  GainNode;
  private wetGain:  GainNode;

  private _type: FilterType = 'lowpass';
  private _freq = 1000;
  private _q    = 6;
  private _mix  = 1;
  private _bypassed = false;

  constructor(private ctx: BaseAudioContext) {
    this.input   = ctx.createGain();
    this.output  = ctx.createGain();
    this.node    = ctx.createBiquadFilter();
    this.dryGain = ctx.createGain();
    this.wetGain = ctx.createGain();

    this.node.type            = this._type;
    this.node.frequency.value = this._freq;
    this.node.Q.value         = this._q;

    this.input.connect(this.dryGain);
    this.dryGain.connect(this.output);
    this.input.connect(this.node);
    this.node.connect(this.wetGain);
    this.wetGain.connect(this.output);

    this._applyMix();
  }

  setType(t: FilterType) {
    this._type = t;
    this.node.type = t;
  }

  setFreq(v: number) {
    this._freq = Math.max(20, Math.min(20000, v));
    setParam(this.ctx, this.node.frequency, this._freq);
  }

  setQ(v: number) {
    this._q = v;
    setParam(this.ctx, this.node.Q, this._q);
  }

  setMix(v: number) {
    this._mix = Math.max(0, Math.min(1, v));
    this._applyMix();
  }

  setBypassed(b: boolean) {
    this._bypassed = b;
    this._applyMix();
  }

  private _applyMix() {
    this.dryGain.gain.value = this._bypassed ? 1 : 1 - this._mix;
    this.wetGain.gain.value = this._bypassed ? 0 : this._mix;
  }

  get type()     { return this._type; }
  get freq()     { return this._freq; }
  get q()        { return this._q; }
  get mix()      { return this._mix; }
  get bypassed() { return this._bypassed; }
}
