import { MixerFX, FxParamValue, clamp, clamp01, WetDry, setParam } from './base';
import { oversampleLatencySec, oversampleLatencyKnown } from '../../renderer/audio/compressorLatency';

/** MB SAT — three-band saturation. Drive the lows, mids or highs separately:
 *  fatten a kick without fizzing the hats, or add air to the top while the
 *  low end stays clean.
 *
 *  LOW / MID / HIGH (drive %, 0 = that band passes untouched),
 *  LO X (Hz, low/mid crossover), HI X (Hz, mid/high crossover), DRY/WET (%).
 *
 *  Crossovers are Linkwitz-Riley 4th-order (two cascaded Butterworth biquads),
 *  so with all drives at 0 the three bands sum back to a flat magnitude
 *  response — the split itself is inaudible. NOTE Web Audio's lowpass/highpass
 *  biquads take Q in dB (allpass/peaking take it linear): Butterworth is
 *  Q = −3.01 dB there, and 0.707 "dB" would peak +7 dB at every crossover
 *  (measured). Verified flat to 0.00 dB across the band with these values. Each band's shaper is a
 *  4096-point tanh at 4x oversampling with 12 dB of headroom above 0 dBFS
 *  (pre-gain ¼, curve spans ±4), unity slope at zero so quiet material is
 *  untouched, and a gentle √(1+drive) makeup so driving a band reads as
 *  "fatter", not "quieter". */
export class MbSatFX implements MixerFX {
  readonly inputNode: AudioNode;
  readonly outputNode: AudioNode;
  params: Record<string, FxParamValue> = { LOW: 0, MID: 0, HIGH: 0, LO_X: 200, HI_X: 3000, WET: 100 };
  private wd: WetDry;
  // Crossover network.
  private lowLp1: BiquadFilterNode; private lowLp2: BiquadFilterNode;
  private lowAp: BiquadFilterNode;   // phase-matches the low band to the hi-X split so the sum stays flat
  private restHp1: BiquadFilterNode; private restHp2: BiquadFilterNode;
  private midLp1: BiquadFilterNode; private midLp2: BiquadFilterNode;
  private highHp1: BiquadFilterNode; private highHp2: BiquadFilterNode;
  // Per-band shaping.
  private pre: GainNode[];      // ¼ headroom scaler into the curve
  private shapers: WaveShaperNode[];
  private post: GainNode[];     // makeup
  private lastDrive = [-1, -1, -1];
  private primed = false;
  // DRY leg matched to the wet leg: the three bands sum to AP(loX)·AP(hiX)
  // (phase-rotated, magnitude-flat) and every band sits behind a 4x-oversampled
  // shaper (192 frames late). An untreated dry leg blended in at WET < 100
  // notched around each crossover and combed at 4 ms — so the dry leg gets the
  // same two allpasses and an identity shaper with the same oversampling.
  private dryAp1: BiquadFilterNode; private dryAp2: BiquadFilterNode; private dryPre: GainNode; private dryShaper: WaveShaperNode;
  private latency = 0;
  readonly ready: Promise<void>;

  constructor(private ctx: BaseAudioContext) {
    this.wd = new WetDry(ctx);
    const BUTTERWORTH_DB = -3.0103;   // 20·log10(1/√2): LP/HP Q is in dB
    const bq = (type: BiquadFilterType) => {
      const f = ctx.createBiquadFilter(); f.type = type;
      f.Q.value = type === 'allpass' ? Math.SQRT1_2 : BUTTERWORTH_DB;
      return f;
    };
    this.lowLp1 = bq('lowpass'); this.lowLp2 = bq('lowpass'); this.lowAp = bq('allpass');
    this.restHp1 = bq('highpass'); this.restHp2 = bq('highpass');
    this.midLp1 = bq('lowpass'); this.midLp2 = bq('lowpass');
    this.highHp1 = bq('highpass'); this.highHp2 = bq('highpass');

    this.pre = [0, 1, 2].map(() => { const g = ctx.createGain(); g.gain.value = 0.25; return g; });
    this.shapers = [0, 1, 2].map(() => { const w = ctx.createWaveShaper(); w.oversample = '4x'; return w; });
    this.post = [0, 1, 2].map(() => ctx.createGain());

    // low  = LR4-LP(loX) → AP(hiX)   (LR4-LP+HP at hiX sums to that 2nd-order allpass,
    //                                 so the low band gets the same phase and all three sum flat)
    // rest = LR4-HP(loX) → mid = LR4-LP(hiX) ; high = LR4-HP(hiX)
    const inp = this.wd.wetIn;
    inp.connect(this.lowLp1); this.lowLp1.connect(this.lowLp2); this.lowLp2.connect(this.lowAp);
    inp.connect(this.restHp1); this.restHp1.connect(this.restHp2);
    this.restHp2.connect(this.midLp1); this.midLp1.connect(this.midLp2);
    this.restHp2.connect(this.highHp1); this.highHp1.connect(this.highHp2);
    const bandOuts = [this.lowAp, this.midLp2, this.highHp2];
    for (let b = 0; b < 3; b++) {
      bandOuts[b].connect(this.pre[b]);
      this.pre[b].connect(this.shapers[b]);
      this.shapers[b].connect(this.post[b]);
      this.post[b].connect(this.wd.wetOut);
    }
    this.dryAp1 = bq('allpass'); this.dryAp2 = bq('allpass');
    // Same ¼ pre-gain the bands get: curve(0) is X = 4x, so ¼ · 4x = x exactly.
    this.dryPre = ctx.createGain(); this.dryPre.gain.value = 0.25;
    this.dryShaper = ctx.createWaveShaper(); this.dryShaper.oversample = '4x';
    this.dryShaper.curve = MbSatFX.curve(0);
    this.dryAp1.connect(this.dryAp2); this.dryAp2.connect(this.dryPre); this.dryPre.connect(this.dryShaper);
    this.wd.setDryPath({ input: this.dryAp1, output: this.dryShaper });
    this.latency = oversampleLatencyKnown(ctx.sampleRate, '4x');
    this.ready = oversampleLatencySec(ctx.sampleRate, '4x').then(sec => { this.latency = sec; });
    this.inputNode = this.wd.input;
    this.outputNode = this.wd.output;
    this.update();
    this.wd.setMix(clamp01(Number(this.params.WET) / 100));
    this.primed = true;
  }
  latencySec(): number { return this.latency; }

  setParam(key: string, value: FxParamValue): void {
    this.params[key] = Number(value);
    this.update();
    this.wd.setMix(clamp01(Number(this.params.WET) / 100));
  }
  bypass(on: boolean): void { this.wd.setBypassed(on); }
  dispose(): void {
    for (const n of [this.lowLp1, this.lowLp2, this.lowAp, this.restHp1, this.restHp2, this.midLp1, this.midLp2, this.highHp1, this.highHp2,
      this.dryAp1, this.dryAp2, this.dryPre, this.dryShaper, ...this.pre, ...this.shapers, ...this.post]) {
      try { n.disconnect(); } catch { /* */ }
    }
    this.wd.disconnect();
  }

  private update(): void {
    const instant = !this.primed;
    const set = (p: AudioParam, v: number) => setParam(this.ctx, p, v, 0.01, instant);
    let loX = clamp(Number(this.params.LO_X), 40, 2000);
    let hiX = clamp(Number(this.params.HI_X), 500, 16000);
    if (hiX < loX * 1.5) hiX = loX * 1.5;   // keep a real mid band
    for (const f of [this.lowLp1, this.lowLp2, this.restHp1, this.restHp2, this.dryAp1]) set(f.frequency, loX);
    for (const f of [this.midLp1, this.midLp2, this.highHp1, this.highHp2, this.lowAp, this.dryAp2]) set(f.frequency, hiX);

    const drives = [Number(this.params.LOW), Number(this.params.MID), Number(this.params.HIGH)]
      .map(d => clamp01(d / 100));
    for (let b = 0; b < 3; b++) {
      const d = drives[b];
      if (d !== this.lastDrive[b]) { this.shapers[b].curve = MbSatFX.curve(d); this.lastDrive[b] = d; }
      set(this.post[b].gain, Math.sqrt(1 + d * 4));
    }
  }

  /** tanh(a·X)/a over X ∈ [−4, 4] (input is pre-scaled by ¼): unity slope at
   *  0 for every drive, so 0 % is a straight line ×4 (exact identity after the
   *  ¼ pre-gain) and 100 % (a = 4) squashes anything past ~−12 dBFS. */
  private static curve(drive01: number): Float32Array<ArrayBuffer> {
    const N = 4096;
    const c: Float32Array<ArrayBuffer> = new Float32Array(N);
    const a = drive01 * 4;
    for (let i = 0; i < N; i++) {
      const X = ((i / (N - 1)) * 2 - 1) * 4;
      c[i] = a < 1e-4 ? X : Math.tanh(a * X) / a;
    }
    return c;
  }
}
