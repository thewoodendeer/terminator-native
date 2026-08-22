import { MixerFX, FxParamValue, clamp, dbToGain, WetDry, setParam } from './base';
import { compressorLatencySec, compressorLatencyKnown } from '../../renderer/audio/compressorLatency';

type CompStyle = 'OFF' | 'LIGHT' | 'PUNCHY' | 'NY-PARALLEL' | 'AGGRESSIVE';

const PRESETS: Record<CompStyle, { threshold: number; ratio: number; attack: number; release: number; makeup: number; mix: number }> = {
  'OFF':         { threshold: 0,   ratio: 1,  attack: 10,  release: 150, makeup: 0, mix: 1 },
  'LIGHT':       { threshold: -18, ratio: 2,  attack: 30,  release: 200, makeup: 2, mix: 1 },
  'PUNCHY':      { threshold: -20, ratio: 4,  attack: 10,  release: 80,  makeup: 4, mix: 1 },
  'NY-PARALLEL': { threshold: -32, ratio: 8,  attack: 1,   release: 50,  makeup: 6, mix: 0.5 },
  'AGGRESSIVE':  { threshold: -28, ratio: 12, attack: 1,   release: 30,  makeup: 8, mix: 1 },
};

/** COMP — DynamicsCompressor with style presets. STYLE picks a starting point;
 *  the individual knobs (THRESHOLD/RATIO/ATTACK/RELEASE/MAKEUP) override live.
 *  NY-PARALLEL blends 50% dry via the WetDry bracket — and the dry leg is
 *  delayed by the compressor's measured look-ahead (~6 ms), otherwise the two
 *  legs comb-filter into a hollow, phasey blend. */
export class CompFX implements MixerFX {
  readonly inputNode: AudioNode;
  readonly outputNode: AudioNode;
  params: Record<string, FxParamValue> = {
    STYLE: 'PUNCHY', THRESHOLD: -20, RATIO: 4, ATTACK: 10, RELEASE: 80, MAKEUP: 4,
  };
  private wd: WetDry;
  private comp: DynamicsCompressorNode;
  private makeup: GainNode;
  private primed = false;
  private latency = 0;
  readonly ready: Promise<void>;

  constructor(private ctx: BaseAudioContext) {
    this.wd = new WetDry(ctx);
    // Line the dry leg up with the compressor's look-ahead. The value is
    // measured once per sample rate and cached; the first CompFX on a fresh
    // rate applies it as soon as the measurement lands (offline renders await
    // `ready` before they start, so a stem never renders un-aligned).
    const known = compressorLatencyKnown(ctx.sampleRate);
    this.latency = known;
    this.ready = compressorLatencySec(ctx.sampleRate).then(sec => { this.latency = sec; this.wd.setDryLatency(sec); });
    if (known > 0) this.wd.setDryLatency(known);
    this.comp = ctx.createDynamicsCompressor();
    this.comp.knee.value = 6;
    this.makeup = ctx.createGain();
    this.wd.wetIn.connect(this.comp);
    this.comp.connect(this.makeup);
    this.makeup.connect(this.wd.wetOut);
    this.inputNode = this.wd.input;
    this.outputNode = this.wd.output;
    this.update();
    this.primed = true;
  }

  setParam(key: string, value: FxParamValue): void {
    if (key === 'STYLE') {
      const p = PRESETS[String(value) as CompStyle] ?? PRESETS.PUNCHY;
      this.params = { STYLE: String(value), THRESHOLD: p.threshold, RATIO: p.ratio, ATTACK: p.attack, RELEASE: p.release, MAKEUP: p.makeup };
      this.wd.setMix(p.mix);
    } else {
      this.params[key] = Number(value);
    }
    this.update();
  }
  bypass(on: boolean): void { this.wd.setBypassed(on); }
  latencySec(): number { return this.latency; }
  dispose(): void {
    for (const n of [this.comp, this.makeup]) { try { n.disconnect(); } catch { /* */ } }
    this.wd.disconnect();
  }

  private update(): void {
    const instant = !this.primed;
    const set = (p: AudioParam, v: number) => setParam(this.ctx, p, v, 0.01, instant);
    set(this.comp.threshold, clamp(Number(this.params.THRESHOLD), -100, 0));
    set(this.comp.ratio, clamp(Number(this.params.RATIO), 1, 20));
    set(this.comp.attack, clamp(Number(this.params.ATTACK) / 1000, 0, 1));
    set(this.comp.release, clamp(Number(this.params.RELEASE) / 1000, 0, 1));
    set(this.makeup.gain, dbToGain(clamp(Number(this.params.MAKEUP), 0, 24)));
  }
}
