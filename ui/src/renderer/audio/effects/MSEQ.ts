export class MSEQ {
  readonly input:  GainNode;
  readonly output: GainNode;
  private dryGain: GainNode;
  private wetGain: GainNode;
  private node: AudioWorkletNode | null = null;

  private _midFreq  = 1670;
  private _midGain  = 5.5;
  private _sideFreq = 5000;
  private _sideGain = 10;
  private _mix      = 0.5;
  private _bypassed = false;

  constructor(private ctx: BaseAudioContext) {
    this.input   = ctx.createGain();
    this.output  = ctx.createGain();
    this.dryGain = ctx.createGain();
    this.wetGain = ctx.createGain();

    // Dry path is always wired; wet path is added once worklet loads
    this.input.connect(this.dryGain);
    this.dryGain.connect(this.output);

    // Wet path fallback: if worklet never loads, wet = passthrough
    this.input.connect(this.wetGain);
    this.wetGain.connect(this.output);

    this._applyMix();
  }

  async init(): Promise<void> {
    try {
      await this.ctx.audioWorklet.addModule('./worklets/ms-eq-worklet.js');
      this.node = new AudioWorkletNode(this.ctx, 'ms-eq', {
        numberOfInputs:  1,
        numberOfOutputs: 1,
        channelCount:    2,
        channelCountMode: 'explicit',
      });
      // Replace wet passthrough with worklet
      this.input.disconnect(this.wetGain);
      this.input.connect(this.node);
      this.node.connect(this.wetGain);
      this._syncParams();
    } catch (e) {
      console.warn('MSEQ worklet failed, wet path is passthrough:', e);
    }
  }

  setMidFreq(v: number): void {
    this._midFreq = Math.max(20, Math.min(20000, v));
    this.node?.parameters.get('midFreq')?.setTargetAtTime(this._midFreq, this.ctx.currentTime, 0.01);
  }

  setMidGain(v: number): void {
    this._midGain = Math.max(-24, Math.min(24, v));
    this.node?.parameters.get('midGain')?.setTargetAtTime(this._midGain, this.ctx.currentTime, 0.01);
  }

  setSideFreq(v: number): void {
    this._sideFreq = Math.max(20, Math.min(20000, v));
    this.node?.parameters.get('sideFreq')?.setTargetAtTime(this._sideFreq, this.ctx.currentTime, 0.01);
  }

  setSideGain(v: number): void {
    this._sideGain = Math.max(-24, Math.min(24, v));
    this.node?.parameters.get('sideGain')?.setTargetAtTime(this._sideGain, this.ctx.currentTime, 0.01);
  }

  setMix(v: number): void {
    this._mix = Math.max(0, Math.min(1, v));
    this._applyMix();
  }

  setBypassed(b: boolean): void {
    this._bypassed = b;
    this._applyMix();
  }

  private _applyMix(): void {
    const wet = this._bypassed ? 0 : this._mix;
    const dry = this._bypassed ? 1 : 1 - this._mix;
    this.dryGain.gain.setTargetAtTime(dry, this.ctx.currentTime, 0.01);
    this.wetGain.gain.setTargetAtTime(wet, this.ctx.currentTime, 0.01);
  }

  private _syncParams(): void {
    this.setMidFreq(this._midFreq);
    this.setMidGain(this._midGain);
    this.setSideFreq(this._sideFreq);
    this.setSideGain(this._sideGain);
  }

  get midFreq()  { return this._midFreq; }
  get midGain()  { return this._midGain; }
  get sideFreq() { return this._sideFreq; }
  get sideGain() { return this._sideGain; }
  get mix()      { return this._mix; }
  get bypassed() { return this._bypassed; }
}
