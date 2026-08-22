export class Reverb {
  readonly input: GainNode;
  readonly output: GainNode;
  private convolver: ConvolverNode;
  private preHPF: BiquadFilterNode;
  private dryGain: GainNode;
  private wetGain: GainNode;
  private _mix = 0.3;
  private _preHPFFreq = 200;
  private _decay = 2.0;
  private _bypassed = false;

  constructor(private ctx: BaseAudioContext) {
    this.input = ctx.createGain();
    this.output = ctx.createGain();
    this.convolver = ctx.createConvolver();
    this.preHPF = ctx.createBiquadFilter();
    this.preHPF.type = 'highpass';
    this.preHPF.frequency.value = this._preHPFFreq;
    this.preHPF.Q.value = 0.5;
    this.dryGain = ctx.createGain();
    this.wetGain = ctx.createGain();

    this.input.connect(this.dryGain);
    this.dryGain.connect(this.output);
    this.input.connect(this.preHPF);
    this.preHPF.connect(this.convolver);
    this.convolver.connect(this.wetGain);
    this.wetGain.connect(this.output);

    this.setMix(this._mix);
    this.rebuildIR();
  }

  /** Synthesised stereo IR: exponential decay (−60 dB at DECAY) with air
   *  absorption — a one-pole lowpass whose cutoff falls along the tail, so the
   *  onset is bright and the tail darkens like a real room (the old fixed
   *  0.4/0.6 smoother left a constant, slightly metallic colour). Seeded LCG so
   *  the two channels decorrelate (wide) yet an offline export builds the SAME
   *  IR you auditioned live. */
  private rebuildIR(): void {
    const sr = this.ctx.sampleRate;
    const len = Math.max(1, Math.floor(sr * this._decay * 1.2));
    const ir = this.ctx.createBuffer(2, len, sr);
    const k = -6.9078 / this._decay;   // ln(1e-3)
    const fcStart = 12000, fcEnd = 1600;
    let seed = 0x1234567;
    const rnd = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296 * 2 - 1; };
    for (let ch = 0; ch < 2; ch++) {
      const d = ir.getChannelData(ch);
      let y = 0;
      for (let i = 0; i < len; i++) {
        const t = i / sr;
        const fc = fcStart + (fcEnd - fcStart) * Math.sqrt(i / len);
        const a = 1 - Math.exp(-6.2832 * fc / sr);
        y += a * (rnd() - y);
        d[i] = y * Math.exp(k * t) * 0.2;
      }
    }
    this.convolver.buffer = ir;
  }

  setDecay(v: number) {
    this._decay = Math.max(0.1, Math.min(10, v));
    this.rebuildIR();
  }

  setPreHPF(freq: number) {
    this._preHPFFreq = Math.max(20, Math.min(2000, freq));
    this.preHPF.frequency.value = this._preHPFFreq;
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

  get mix() { return this._mix; }
  get decay() { return this._decay; }
  get preHPFFreq() { return this._preHPFFreq; }
  get bypassed() { return this._bypassed; }
}
