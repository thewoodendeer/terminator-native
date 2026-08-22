export class StereoWidener {
  readonly input: GainNode;
  readonly output: GainNode;
  private node: AudioWorkletNode | null = null;
  private _width = 1;
  private _mix = 0.5;
  private _bypassed = false;

  constructor(private ctx: BaseAudioContext) {
    this.input = ctx.createGain();
    this.output = ctx.createGain();
    this.input.connect(this.output); // fallback passthrough until worklet loads
  }

  async init(): Promise<void> {
    try {
      await this.ctx.audioWorklet.addModule('./worklets/stereo-widener-worklet.js');
      this.node = new AudioWorkletNode(this.ctx, 'stereo-widener', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        channelCount: 2,
        channelCountMode: 'explicit',
      });
      this.input.disconnect(this.output);
      this.input.connect(this.node);
      this.node.connect(this.output);
      this.setWidth(this._width);
      this.setMix(this._mix);
    } catch (e) {
      console.warn('StereoWidener worklet failed, using passthrough:', e);
    }
  }

  setWidth(v: number) {
    this._width = Math.max(0, Math.min(3, v));
    this.node?.parameters.get('width')?.setTargetAtTime(this._width, this.ctx.currentTime, 0.01);
  }

  setMix(v: number) {
    this._mix = Math.max(0, Math.min(1, v));
    if (!this._bypassed) {
      this.node?.parameters.get('mix')?.setTargetAtTime(this._mix, this.ctx.currentTime, 0.01);
    }
  }

  setBypassed(b: boolean) {
    this._bypassed = b;
    this.node?.parameters.get('mix')?.setTargetAtTime(b ? 0 : this._mix, this.ctx.currentTime, 0.01);
  }

  get width() { return this._width; }
  get mix() { return this._mix; }
  get bypassed() { return this._bypassed; }
}
