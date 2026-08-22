import { MixerFX, FxParamValue, clamp, WetDry, setParam } from './base';

/** M/S EQ — independent peaking EQ on the Mid and Side channels.
 *  MID_HZ / MID_dB and SIDE_HZ / SIDE_dB. */
export class MseqFX implements MixerFX {
  readonly inputNode: AudioNode;
  readonly outputNode: AudioNode;
  params: Record<string, FxParamValue> = { MID_HZ: 1000, MID_DB: 0, SIDE_HZ: 4000, SIDE_DB: 0 };
  private wd: WetDry;
  private split: ChannelSplitterNode;
  private merge: ChannelMergerNode;
  private lToMid: GainNode; private rToMid: GainNode;
  private lToSide: GainNode; private rToSide: GainNode;
  private mid: GainNode; private side: GainNode;
  private midEq: BiquadFilterNode; private sideEq: BiquadFilterNode;
  private sideNeg: GainNode;
  private primed = false;

  constructor(private ctx: BaseAudioContext) {
    this.wd = new WetDry(ctx);
    this.split = ctx.createChannelSplitter(2);
    this.merge = ctx.createChannelMerger(2);
    this.lToMid = ctx.createGain(); this.lToMid.gain.value = 0.5;
    this.rToMid = ctx.createGain(); this.rToMid.gain.value = 0.5;
    this.lToSide = ctx.createGain(); this.lToSide.gain.value = 0.5;
    this.rToSide = ctx.createGain(); this.rToSide.gain.value = -0.5;
    this.mid = ctx.createGain();
    this.side = ctx.createGain();
    this.midEq = ctx.createBiquadFilter(); this.midEq.type = 'peaking'; this.midEq.Q.value = 1;
    this.sideEq = ctx.createBiquadFilter(); this.sideEq.type = 'peaking'; this.sideEq.Q.value = 1;
    this.sideNeg = ctx.createGain(); this.sideNeg.gain.value = -1;

    this.wd.wetIn.connect(this.split);
    this.split.connect(this.lToMid, 0); this.split.connect(this.rToMid, 1);
    this.split.connect(this.lToSide, 0); this.split.connect(this.rToSide, 1);
    this.lToMid.connect(this.mid); this.rToMid.connect(this.mid);
    this.lToSide.connect(this.side); this.rToSide.connect(this.side);
    this.mid.connect(this.midEq);
    this.side.connect(this.sideEq);
    this.sideEq.connect(this.sideNeg);
    // L' = midEq + sideEq ; R' = midEq − sideEq
    this.midEq.connect(this.merge, 0, 0);
    this.sideEq.connect(this.merge, 0, 0);
    this.midEq.connect(this.merge, 0, 1);
    this.sideNeg.connect(this.merge, 0, 1);
    this.merge.connect(this.wd.wetOut);
    this.inputNode = this.wd.input;
    this.outputNode = this.wd.output;
    this.update();
    this.primed = true;
  }

  setParam(key: string, value: FxParamValue): void {
    this.params[key] = Number(value);
    this.update();
  }
  bypass(on: boolean): void { this.wd.setBypassed(on); }
  dispose(): void {
    for (const n of [this.split, this.merge, this.lToMid, this.rToMid, this.lToSide, this.rToSide, this.mid, this.side, this.midEq, this.sideEq, this.sideNeg]) {
      try { n.disconnect(); } catch { /* */ }
    }
    this.wd.disconnect();
  }

  private update(): void {
    const instant = !this.primed;
    const set = (p: AudioParam, v: number) => setParam(this.ctx, p, v, 0.01, instant);
    set(this.midEq.frequency, clamp(Number(this.params.MID_HZ), 20, 20000));
    set(this.midEq.gain, clamp(Number(this.params.MID_DB), -18, 18));
    set(this.sideEq.frequency, clamp(Number(this.params.SIDE_HZ), 20, 20000));
    set(this.sideEq.gain, clamp(Number(this.params.SIDE_DB), -18, 18));
  }
}
