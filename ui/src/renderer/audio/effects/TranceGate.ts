export type TranceGateSyncDiv =
  | '1/2' | '1/4' | '1/8' | '1/16' | '1/32' | '1/64' | '1/128';

const DIV_FACTORS: Record<TranceGateSyncDiv, number> = {
  '1/2': 2, '1/4': 4, '1/8': 8, '1/16': 16, '1/32': 32, '1/64': 64, '1/128': 128,
};

export class TranceGate {
  readonly input:  GainNode;
  readonly output: GainNode;

  private node:    AudioWorkletNode | null = null;
  private dryGain: GainNode;
  private wetGain: GainNode;

  private _rate     = 12.10;
  private _depth    = 1;
  private _attack   = 0.005;
  private _release  = 0.08;
  private _mix      = 1;
  private _bypassed = false;
  private _synced   = false;
  private _syncDiv: TranceGateSyncDiv = '1/8';
  private _bpm      = 140;

  constructor(private ctx: BaseAudioContext) {
    this.input   = ctx.createGain();
    this.output  = ctx.createGain();
    this.dryGain = ctx.createGain();
    this.wetGain = ctx.createGain();

    // Dry path always present; wet path connects after worklet loads
    this.input.connect(this.dryGain);
    this.dryGain.connect(this.output);
    this.wetGain.connect(this.output);

    this._applyGains();
  }

  async init(): Promise<void> {
    try {
      await this.ctx.audioWorklet.addModule('./worklets/trance-gate-worklet.js');
      this.node = new AudioWorkletNode(this.ctx, 'trance-gate', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        channelCount: 2,
        channelCountMode: 'explicit',
      });
      this.input.connect(this.node);
      this.node.connect(this.wetGain);
      this._syncParams();
    } catch (e) {
      // Fallback: wet path passes audio unprocessed so the track stays audible
      this.input.connect(this.wetGain);
      console.warn('TranceGate worklet failed, using passthrough:', e);
    }
  }

  setRate(v: number): void {
    this._rate = Math.max(0.1, Math.min(40, v));
    if (!this._synced) this._pushRate();
  }

  setDepth(v: number): void {
    this._depth = Math.max(0, Math.min(1, v));
    this.node?.parameters.get('depth')?.setTargetAtTime(this._depth, this.ctx.currentTime, 0.01);
  }

  setAttack(v: number): void {
    this._attack = Math.max(0.001, Math.min(0.5, v));
    this.node?.parameters.get('attack')?.setTargetAtTime(this._attack, this.ctx.currentTime, 0.01);
  }

  setRelease(v: number): void {
    this._release = Math.max(0.001, Math.min(0.5, v));
    this.node?.parameters.get('release')?.setTargetAtTime(this._release, this.ctx.currentTime, 0.01);
  }

  setMix(v: number): void {
    this._mix = Math.max(0, Math.min(1, v));
    this._applyGains();
  }

  setBypassed(b: boolean): void {
    this._bypassed = b;
    this._applyGains();
  }

  setBPM(bpm: number): void {
    this._bpm = bpm;
    if (this._synced) this._pushRate();
  }

  setSynced(v: boolean): void {
    this._synced = v;
    this._pushRate();
  }

  setSyncDiv(v: TranceGateSyncDiv): void {
    this._syncDiv = v;
    if (this._synced) this._pushRate();
  }

  private _effectiveRate(): number {
    if (this._synced) return (this._bpm / 60) * (DIV_FACTORS[this._syncDiv] / 4);
    return this._rate;
  }

  private _pushRate(): void {
    this.node?.parameters.get('rate')?.setTargetAtTime(this._effectiveRate(), this.ctx.currentTime, 0.01);
  }

  private _applyGains(): void {
    this.dryGain.gain.value = this._bypassed ? 1 : 1 - this._mix;
    this.wetGain.gain.value = this._bypassed ? 0 : this._mix;
  }

  private _syncParams(): void {
    if (!this.node) return;
    const t = this.ctx.currentTime;
    this.node.parameters.get('rate')?.setTargetAtTime(this._effectiveRate(), t, 0.01);
    this.node.parameters.get('depth')?.setTargetAtTime(this._depth,   t, 0.01);
    this.node.parameters.get('attack')?.setTargetAtTime(this._attack,  t, 0.01);
    this.node.parameters.get('release')?.setTargetAtTime(this._release, t, 0.01);
  }

  dispose(): void {
    try { this.node?.disconnect(); } catch (_) {}
    this.node = null;
  }

  get rate()     { return this._rate; }
  get depth()    { return this._depth; }
  get attack()   { return this._attack; }
  get release()  { return this._release; }
  get mix()      { return this._mix; }
  get bypassed() { return this._bypassed; }
  get synced()   { return this._synced; }
  get syncDiv()  { return this._syncDiv; }
}
