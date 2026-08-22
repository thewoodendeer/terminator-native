import { MixerFX, FxParamValue, clamp, dbToGain, WetDry, setParam } from './base';

type UtilMode = 'STEREO' | 'MONO' | 'MONO-L' | 'MONO-R';

/** UTILITY — GAIN (-20..+20 dB), MODE (stereo/mono/mono-L/mono-R downmix) and
 *  PHASE (normal / inverted). Built from a splitter+merger so each mode just
 *  re-patches which input channel feeds which output channel. */
export class UtilityFX implements MixerFX {
  readonly inputNode: AudioNode;
  readonly outputNode: AudioNode;
  params: Record<string, FxParamValue> = { GAIN: 0, MODE: 'STEREO', PHASE: 'normal' };
  private wd: WetDry;
  private gain: GainNode;
  private split: ChannelSplitterNode;
  private merge: ChannelMergerNode;
  private lHalf: GainNode; // 0.5 taps for the mono sum
  private rHalf: GainNode;
  private phase: GainNode; // ±1
  private primed = false;

  constructor(private ctx: BaseAudioContext) {
    this.wd = new WetDry(ctx);
    this.gain = ctx.createGain();
    this.split = ctx.createChannelSplitter(2);
    this.merge = ctx.createChannelMerger(2);
    this.lHalf = ctx.createGain(); this.lHalf.gain.value = 0.5;
    this.rHalf = ctx.createGain(); this.rHalf.gain.value = 0.5;
    this.phase = ctx.createGain();
    this.wd.wetIn.connect(this.gain);
    this.gain.connect(this.split);
    this.merge.connect(this.phase);
    this.phase.connect(this.wd.wetOut);
    this.inputNode = this.wd.input;
    this.outputNode = this.wd.output;
    this.rebuild();
    this.update();
    this.primed = true;
  }

  setParam(key: string, value: FxParamValue): void {
    this.params[key] = key === 'GAIN' ? Number(value) : String(value);
    if (key === 'MODE') this.rebuild();
    this.update();
  }
  bypass(on: boolean): void { this.wd.setBypassed(on); }
  dispose(): void {
    for (const n of [this.gain, this.split, this.merge, this.lHalf, this.rHalf, this.phase]) {
      try { n.disconnect(); } catch { /* */ }
    }
    this.wd.disconnect();
  }

  private rebuild(): void {
    try { this.split.disconnect(); } catch { /* */ }
    try { this.lHalf.disconnect(); } catch { /* */ }
    try { this.rHalf.disconnect(); } catch { /* */ }
    const mode = String(this.params.MODE) as UtilMode;
    if (mode === 'STEREO') {
      this.split.connect(this.merge, 0, 0);
      this.split.connect(this.merge, 1, 1);
    } else if (mode === 'MONO') {
      this.split.connect(this.lHalf, 0);
      this.split.connect(this.rHalf, 1);
      this.lHalf.connect(this.merge, 0, 0);
      this.rHalf.connect(this.merge, 0, 0);
      this.lHalf.connect(this.merge, 0, 1);
      this.rHalf.connect(this.merge, 0, 1);
    } else if (mode === 'MONO-L') {
      this.split.connect(this.merge, 0, 0);
      this.split.connect(this.merge, 0, 1);
    } else { // MONO-R
      this.split.connect(this.merge, 1, 0);
      this.split.connect(this.merge, 1, 1);
    }
  }

  private update(): void {
    setParam(this.ctx, this.gain.gain, dbToGain(clamp(Number(this.params.GAIN), -20, 20)), 0.01, !this.primed);
    this.phase.gain.value = String(this.params.PHASE) === 'inverted' ? -1 : 1;
  }
}
