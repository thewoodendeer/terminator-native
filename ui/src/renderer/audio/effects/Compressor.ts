import { setParam } from './param';

// Drive-style single-band compressor. A fixed internal threshold keeps the
// UI simple: user pushes the signal into the compressor with DRIVE instead
// of chasing a threshold knob, then compensates with MAKEUP on the way out.
export class Compressor {
  readonly input:  GainNode;
  readonly output: GainNode;

  private driveGain:  GainNode;
  private makeupGain: GainNode;
  private comp:       DynamicsCompressorNode;

  private _driveDb  = 0;
  private _ratio    = 4;
  private _attack   = 0.01;
  private _release  = 0.15;
  private _makeupDb = 0;
  private _bypassed = false;

  private static readonly THRESHOLD_DB = -18;
  private static readonly KNEE_DB      = 6;

  constructor(private ctx: BaseAudioContext) {
    this.input      = ctx.createGain();
    this.output     = ctx.createGain();
    this.driveGain  = ctx.createGain();
    this.makeupGain = ctx.createGain();

    this.comp = ctx.createDynamicsCompressor();
    this.comp.threshold.value = Compressor.THRESHOLD_DB;
    this.comp.knee.value      = Compressor.KNEE_DB;
    this.comp.ratio.value     = this._ratio;
    this.comp.attack.value    = this._attack;
    this.comp.release.value   = this._release;

    this.input.connect(this.driveGain);
    this.driveGain.connect(this.comp);
    this.comp.connect(this.makeupGain);
    this.makeupGain.connect(this.output);

    this._applyBypass();
    this._applyDrive();
    this._applyMakeup();
  }

  setDrive(db: number): void {
    this._driveDb = Math.max(0, Math.min(24, db));
    this._applyDrive();
  }

  setRatio(r: number): void {
    this._ratio = Math.max(1, Math.min(20, r));
    setParam(this.ctx, this.comp.ratio, this._ratio);
  }

  setAttack(seconds: number): void {
    this._attack = Math.max(0.001, Math.min(0.3, seconds));
    setParam(this.ctx, this.comp.attack, this._attack);
  }

  setRelease(seconds: number): void {
    this._release = Math.max(0.01, Math.min(1.0, seconds));
    setParam(this.ctx, this.comp.release, this._release);
  }

  setMakeup(db: number): void {
    this._makeupDb = Math.max(-24, Math.min(24, db));
    this._applyMakeup();
  }

  setBypassed(b: boolean): void {
    this._bypassed = b;
    this._applyBypass();
  }

  private _applyDrive(): void {
    const gain = this._bypassed ? 1 : Math.pow(10, this._driveDb / 20);
    setParam(this.ctx, this.driveGain.gain, gain);
  }

  private _applyMakeup(): void {
    const gain = this._bypassed ? 1 : Math.pow(10, this._makeupDb / 20);
    setParam(this.ctx, this.makeupGain.gain, gain);
  }

  private _applyBypass(): void {
    // Bypass by making the compressor a no-op chain (unit gain in, unit gain out,
    // and push ratio to 1 so the compressor passes signal through unchanged).
    if (this._bypassed) {
      setParam(this.ctx, this.driveGain.gain, 1, 0.005);
      setParam(this.ctx, this.makeupGain.gain, 1, 0.005);
      setParam(this.ctx, this.comp.ratio, 1, 0.005);
    } else {
      this._applyDrive();
      this._applyMakeup();
      setParam(this.ctx, this.comp.ratio, this._ratio, 0.005);
    }
  }

  get drive()    { return this._driveDb; }
  get ratio()    { return this._ratio; }
  get attack()   { return this._attack; }
  get release()  { return this._release; }
  get makeup()   { return this._makeupDb; }
  get bypassed() { return this._bypassed; }
}
