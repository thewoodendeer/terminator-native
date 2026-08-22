export class BitCrusher {
  readonly input:  GainNode;
  readonly output: GainNode;
  private node:     AudioWorkletNode | null = null;
  private dryGain:  GainNode;
  private wetGain:  GainNode;

  private _bits     = 4;
  private _rate     = 8;
  private _mix      = 1;
  private _bypassed = false;

  constructor(private ctx: BaseAudioContext) {
    this.input   = ctx.createGain();
    this.output  = ctx.createGain();
    this.dryGain = ctx.createGain();
    this.wetGain = ctx.createGain();

    // Dry path is always present
    this.input.connect(this.dryGain);
    this.dryGain.connect(this.output);
    // Wet path connects after worklet loads
    this.wetGain.connect(this.output);

    this._applyGains();
  }

  async init(): Promise<void> {
    try {
      await this.ctx.audioWorklet.addModule('./worklets/bit-crusher-worklet.js');
      this.node = new AudioWorkletNode(this.ctx, 'bit-crusher', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        channelCount: 2,
        channelCountMode: 'explicit',
      });
      this.input.connect(this.node);
      this.node.connect(this.wetGain);
      this._syncParams();
    } catch (e) {
      // Fallback: wet path passes audio unprocessed
      this.input.connect(this.wetGain);
      console.warn('BitCrusher worklet failed, using passthrough:', e);
    }
  }

  setBits(v: number): void {
    this._bits = Math.max(1, Math.min(16, v));
    this.node?.parameters.get('bits')?.setTargetAtTime(this._bits, this.ctx.currentTime, 0.01);
  }

  setRate(v: number): void {
    this._rate = Math.max(1, Math.min(32, Math.round(v)));
    this.node?.parameters.get('rate')?.setTargetAtTime(this._rate, this.ctx.currentTime, 0.01);
  }

  setMix(v: number): void {
    this._mix = Math.max(0, Math.min(1, v));
    this._applyGains();
  }

  setBypassed(b: boolean): void {
    this._bypassed = b;
    this._applyGains();
  }

  private _applyGains(): void {
    this.dryGain.gain.value = this._bypassed ? 1 : 1 - this._mix;
    this.wetGain.gain.value = this._bypassed ? 0 : this._mix;
  }

  private _syncParams(): void {
    this.node?.parameters.get('bits')?.setTargetAtTime(this._bits, this.ctx.currentTime, 0.01);
    this.node?.parameters.get('rate')?.setTargetAtTime(this._rate, this.ctx.currentTime, 0.01);
  }

  get bits():     number  { return this._bits; }
  get rate():     number  { return this._rate; }
  get mix():      number  { return this._mix; }
  get bypassed(): boolean { return this._bypassed; }
}
