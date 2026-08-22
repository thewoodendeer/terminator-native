import { setParam } from './param';

export class Delay {
  readonly input: GainNode;
  readonly output: GainNode;
  private merger: ChannelMergerNode;
  private delayL: DelayNode;
  private delayR: DelayNode;
  private feedbackL: GainNode;
  private feedbackR: GainNode;
  private dryGain: GainNode;
  private wetGainL: GainNode;
  private wetGainR: GainNode;
  private _timeL = 0.375;
  private _timeR = 0.5;
  private _feedback = 0.35;
  private _mix = 0.3;
  private _pingPong = false;
  private _bypassed = false;

  constructor(private ctx: BaseAudioContext) {
    this.input = ctx.createGain();
    this.output = ctx.createGain();
    this.merger = ctx.createChannelMerger(2);
    this.delayL = ctx.createDelay(4);
    this.delayR = ctx.createDelay(4);
    this.delayL.delayTime.value = this._timeL;
    this.delayR.delayTime.value = this._timeR;
    this.feedbackL = ctx.createGain();
    this.feedbackR = ctx.createGain();
    this.feedbackL.gain.value = this._feedback;
    this.feedbackR.gain.value = this._feedback;
    this.dryGain = ctx.createGain();
    this.wetGainL = ctx.createGain();
    this.wetGainR = ctx.createGain();

    this.input.connect(this.dryGain);
    this.dryGain.connect(this.output);
    this.merger.connect(this.output);

    this.buildWetRouting();
    this.setMix(this._mix);
  }

  private buildWetRouting(): void {
    try { this.input.disconnect(this.delayL); } catch (_) {}
    try { this.input.disconnect(this.delayR); } catch (_) {}
    try { this.delayL.disconnect(); } catch (_) {}
    try { this.delayR.disconnect(); } catch (_) {}
    try { this.feedbackL.disconnect(); } catch (_) {}
    try { this.feedbackR.disconnect(); } catch (_) {}
    try { this.wetGainL.disconnect(); } catch (_) {}
    try { this.wetGainR.disconnect(); } catch (_) {}

    if (this._pingPong) {
      this.input.connect(this.delayL);
      this.delayL.connect(this.feedbackL);
      this.feedbackL.connect(this.delayR);
      this.delayR.connect(this.feedbackR);
      this.feedbackR.connect(this.delayL);
    } else {
      this.input.connect(this.delayL);
      this.input.connect(this.delayR);
      this.delayL.connect(this.feedbackL);
      this.feedbackL.connect(this.delayL);
      this.delayR.connect(this.feedbackR);
      this.feedbackR.connect(this.delayR);
    }

    this.delayL.connect(this.wetGainL);
    this.delayR.connect(this.wetGainR);
    this.wetGainL.connect(this.merger, 0, 0);
    this.wetGainR.connect(this.merger, 0, 1);
  }

  setTimeL(v: number) {
    this._timeL = Math.max(0.001, Math.min(4, v));
    setParam(this.ctx, this.delayL.delayTime, this._timeL);
  }

  setTimeR(v: number) {
    this._timeR = Math.max(0.001, Math.min(4, v));
    setParam(this.ctx, this.delayR.delayTime, this._timeR);
  }

  setFeedback(v: number) {
    this._feedback = Math.max(0, Math.min(0.95, v));
    setParam(this.ctx, this.feedbackL.gain, this._feedback);
    setParam(this.ctx, this.feedbackR.gain, this._feedback);
  }

  setMix(v: number) {
    this._mix = Math.max(0, Math.min(1, v));
    if (!this._bypassed) {
      this.dryGain.gain.value = 1 - this._mix;
      this.wetGainL.gain.value = this._mix;
      this.wetGainR.gain.value = this._mix;
    }
  }

  setPingPong(v: boolean) {
    if (this._pingPong === v) return;
    this._pingPong = v;
    this.buildWetRouting();
    if (!this._bypassed) {
      this.wetGainL.gain.value = this._mix;
      this.wetGainR.gain.value = this._mix;
    }
  }

  setBypassed(b: boolean) {
    this._bypassed = b;
    this.dryGain.gain.value = b ? 1 : 1 - this._mix;
    this.wetGainL.gain.value = b ? 0 : this._mix;
    this.wetGainR.gain.value = b ? 0 : this._mix;
  }

  get timeL() { return this._timeL; }
  get timeR() { return this._timeR; }
  get feedback() { return this._feedback; }
  get mix() { return this._mix; }
  get pingPong() { return this._pingPong; }
  get bypassed() { return this._bypassed; }
}
