export class EQ3 {
  readonly input: GainNode;
  readonly output: GainNode;
  private dryGain: GainNode;
  private wetGain: GainNode;
  private lowShelf: BiquadFilterNode;
  private midPeak: BiquadFilterNode;
  private highShelf: BiquadFilterNode;
  private _lowGain = 0;
  private _midGain = 0;
  private _highGain = 0;
  private _bypassed = false;

  constructor(ctx: BaseAudioContext) {
    this.input = ctx.createGain();
    this.output = ctx.createGain();
    this.dryGain = ctx.createGain();
    this.wetGain = ctx.createGain();

    this.lowShelf = ctx.createBiquadFilter();
    this.lowShelf.type = 'lowshelf';
    this.lowShelf.frequency.value = 60;
    this.lowShelf.gain.value = 0;

    this.midPeak = ctx.createBiquadFilter();
    this.midPeak.type = 'peaking';
    this.midPeak.frequency.value = 2000;
    this.midPeak.Q.value = 1;
    this.midPeak.gain.value = 0;

    this.highShelf = ctx.createBiquadFilter();
    this.highShelf.type = 'highshelf';
    this.highShelf.frequency.value = 12000;
    this.highShelf.gain.value = 0;

    // Dry bypass path
    this.input.connect(this.dryGain);
    this.dryGain.connect(this.output);
    // Wet EQ path
    this.input.connect(this.lowShelf);
    this.lowShelf.connect(this.midPeak);
    this.midPeak.connect(this.highShelf);
    this.highShelf.connect(this.wetGain);
    this.wetGain.connect(this.output);

    // Default: fully wet (EQ active)
    this.dryGain.gain.value = 0;
    this.wetGain.gain.value = 1;
  }

  setLow(gainDB: number) {
    this._lowGain = Math.max(-24, Math.min(24, gainDB));
    this.lowShelf.gain.value = this._lowGain;
  }

  setMid(gainDB: number) {
    this._midGain = Math.max(-24, Math.min(24, gainDB));
    this.midPeak.gain.value = this._midGain;
  }

  setHigh(gainDB: number) {
    this._highGain = Math.max(-24, Math.min(24, gainDB));
    this.highShelf.gain.value = this._highGain;
  }

  setBypassed(b: boolean) {
    this._bypassed = b;
    this.dryGain.gain.value = b ? 1 : 0;
    this.wetGain.gain.value = b ? 0 : 1;
  }

  get lowGain() { return this._lowGain; }
  get midGain() { return this._midGain; }
  get highGain() { return this._highGain; }
  get bypassed() { return this._bypassed; }
}
