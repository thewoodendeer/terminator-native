import { MixerFX, FxParamValue, clamp, WetDry } from './base';

/** WIDE — Mid/Side stereo widener. WIDTH (0-200, 100 = untouched). Splits to
 *  M=(L+R)/2 and S=(L−R)/2, scales S by WIDTH/100, recombines. 0 = mono. */
export class WideFX implements MixerFX {
  readonly inputNode: AudioNode;
  readonly outputNode: AudioNode;
  params: Record<string, FxParamValue> = { WIDTH: 100 };
  private wd: WetDry;
  private split: ChannelSplitterNode;
  private merge: ChannelMergerNode;
  private lToMid: GainNode; private rToMid: GainNode;
  private lToSide: GainNode; private rToSide: GainNode;
  private mid: GainNode; private side: GainNode;
  private sideScaled: GainNode; private sideNeg: GainNode;

  constructor(ctx: BaseAudioContext) {
    this.wd = new WetDry(ctx);
    this.split = ctx.createChannelSplitter(2);
    this.merge = ctx.createChannelMerger(2);
    this.lToMid = ctx.createGain(); this.lToMid.gain.value = 0.5;
    this.rToMid = ctx.createGain(); this.rToMid.gain.value = 0.5;
    this.lToSide = ctx.createGain(); this.lToSide.gain.value = 0.5;
    this.rToSide = ctx.createGain(); this.rToSide.gain.value = -0.5;
    this.mid = ctx.createGain();
    this.side = ctx.createGain();
    this.sideScaled = ctx.createGain();
    this.sideNeg = ctx.createGain(); this.sideNeg.gain.value = -1;

    this.wd.wetIn.connect(this.split);
    this.split.connect(this.lToMid, 0); this.split.connect(this.rToMid, 1);
    this.split.connect(this.lToSide, 0); this.split.connect(this.rToSide, 1);
    this.lToMid.connect(this.mid); this.rToMid.connect(this.mid);
    this.lToSide.connect(this.side); this.rToSide.connect(this.side);
    this.side.connect(this.sideScaled);
    this.sideScaled.connect(this.sideNeg);
    // L' = M + S ; R' = M − S
    this.mid.connect(this.merge, 0, 0);
    this.sideScaled.connect(this.merge, 0, 0);
    this.mid.connect(this.merge, 0, 1);
    this.sideNeg.connect(this.merge, 0, 1);
    this.merge.connect(this.wd.wetOut);
    this.inputNode = this.wd.input;
    this.outputNode = this.wd.output;
    this.update();
  }

  setParam(key: string, value: FxParamValue): void {
    this.params[key] = Number(value);
    this.update();
  }
  bypass(on: boolean): void { this.wd.setBypassed(on); }
  dispose(): void {
    for (const n of [this.split, this.merge, this.lToMid, this.rToMid, this.lToSide, this.rToSide, this.mid, this.side, this.sideScaled, this.sideNeg]) {
      try { n.disconnect(); } catch { /* */ }
    }
    this.wd.disconnect();
  }

  private update(): void {
    this.sideScaled.gain.value = clamp(Number(this.params.WIDTH), 0, 200) / 100;
  }
}
