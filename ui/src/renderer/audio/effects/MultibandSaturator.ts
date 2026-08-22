export class MultibandSaturator {
  readonly input: GainNode;
  readonly output: GainNode;
  private dryGain: GainNode;
  private wetGain: GainNode;
  private lp: BiquadFilterNode;
  private bp1: BiquadFilterNode;
  private bp2: BiquadFilterNode;
  private hp: BiquadFilterNode;
  private shapes: WaveShaperNode[];
  private _drive = 0.14;
  private _mix = 0.5;
  private _lowFreq = 60;
  private _highFreq = 16000;
  private _bypassed = false;

  constructor(ctx: BaseAudioContext) {
    this.input = ctx.createGain();
    this.output = ctx.createGain();
    this.dryGain = ctx.createGain();
    this.wetGain = ctx.createGain();

    this.lp = ctx.createBiquadFilter();
    this.lp.type = 'lowpass';
    this.lp.frequency.value = this._lowFreq;

    this.bp1 = ctx.createBiquadFilter();
    this.bp1.type = 'highpass';
    this.bp1.frequency.value = this._lowFreq;

    this.bp2 = ctx.createBiquadFilter();
    this.bp2.type = 'lowpass';
    this.bp2.frequency.value = this._highFreq;

    this.hp = ctx.createBiquadFilter();
    this.hp.type = 'highpass';
    this.hp.frequency.value = this._highFreq;

    this.shapes = [0, 1, 2].map(() => {
      const ws = ctx.createWaveShaper();
      ws.oversample = '4x';
      return ws;
    });

    this.input.connect(this.dryGain);
    this.dryGain.connect(this.output);

    this.input.connect(this.lp);
    this.input.connect(this.bp1);
    this.bp1.connect(this.bp2);
    this.input.connect(this.hp);

    this.lp.connect(this.shapes[0]);
    this.bp2.connect(this.shapes[1]);
    this.hp.connect(this.shapes[2]);

    for (const s of this.shapes) s.connect(this.wetGain);
    this.wetGain.connect(this.output);

    this.setDrive(this._drive);
    this.setMix(this._mix);
  }

  setDrive(v: number) {
    this._drive = Math.max(0, Math.min(1, v));
    // Per-band multipliers pulled in (was 1.0 / 1.3 / 1.6) so the high band
    // doesn't fizz the moment you turn drive up. Each band's curve k is
    // also less steep now (see makeSatCurve).
    this.shapes[0].curve = makeSatCurve(this._drive);
    this.shapes[1].curve = makeSatCurve(this._drive * 1.1);
    this.shapes[2].curve = makeSatCurve(this._drive * 1.2);
  }

  setMix(v: number) {
    this._mix = Math.max(0, Math.min(1, v));
    if (!this._bypassed) {
      this.dryGain.gain.value = 1 - this._mix;
      this.wetGain.gain.value = this._mix * 0.33;
    }
  }

  setLowFreq(freq: number) {
    this._lowFreq = Math.max(60, Math.min(this._highFreq - 100, freq));
    this.lp.frequency.value = this._lowFreq;
    this.bp1.frequency.value = this._lowFreq;
  }

  setHighFreq(freq: number) {
    this._highFreq = Math.max(this._lowFreq + 100, Math.min(16000, freq));
    this.bp2.frequency.value = this._highFreq;
    this.hp.frequency.value = this._highFreq;
  }

  setBypassed(b: boolean) {
    this._bypassed = b;
    this.dryGain.gain.value = b ? 1 : 1 - this._mix;
    this.wetGain.gain.value = b ? 0 : this._mix * 0.33;
  }

  get drive() { return this._drive; }
  get mix() { return this._mix; }
  get lowFreq() { return this._lowFreq; }
  get highFreq() { return this._highFreq; }
  get bypassed() { return this._bypassed; }
}

function makeSatCurve(drive: number): Float32Array<ArrayBuffer> {
  // Higher resolution + softer slope. k was 50× — three bands stacking that
  // gave aggressive harmonic mush at default; pulled to 15× for a warmer
  // analog-style saturation.
  const n = 4096;
  const c: Float32Array<ArrayBuffer> = new Float32Array(n);
  const k = drive * 15 + 1;
  for (let i = 0; i < n; i++) {
    const x = (i * 2) / n - 1;
    c[i] = Math.tanh(k * x) / Math.tanh(k);
  }
  return c;
}
