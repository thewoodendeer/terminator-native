import { MixerFX, FxParamValue, clamp, WetDry, setParam } from './base';
import { oversampleLatencySec, oversampleLatencyKnown } from '../../renderer/audio/compressorLatency';

/** VINYL / TAPE — the premium combined degradation effect. Single class, full
 *  chain (all params 0-10), fully native (no ScriptProcessor):
 *    input → tape saturation (DRIVE) → lowpass rolloff (AGE) → 20Hz highpass
 *          → wow pitch-drift delay (WOW) → flutter wobble delay (FLUTTER)
 *          → 200Hz warmth bell (WARMTH) → output
 *
 *  Every AudioParam is PRIMED instantly in the constructor (and set instantly
 *  inside offline renders) — see setParam in base.ts. The old constructor
 *  glided each node from its Web Audio default, so an exported stem opened
 *  with ~200 ms of "tape start": the wow LFO spinning down from 440 Hz with a
 *  1-second depth into a 100 ms delay line, the lowpass sweeping up from 350 Hz. */
export class VinylFX implements MixerFX {
  readonly inputNode: AudioNode;
  readonly outputNode: AudioNode;
  params: Record<string, FxParamValue> = { WARMTH: 4, DRIVE: 2, WOW: 3, FLUTTER: 3, AGE: 3 };
  private wd: WetDry;
  private sat: WaveShaperNode;
  private lpf: BiquadFilterNode;
  private hpf: BiquadFilterNode;
  private wowDelay: DelayNode; private wowLfo: OscillatorNode; private wowDepth: GainNode;
  private flutDelay: DelayNode; private flutLfo: OscillatorNode; private flutDepth: GainNode;
  private warmth: BiquadFilterNode;
  private started = false;
  private primed = false;
  private lastDrive = -1;

  constructor(private ctx: BaseAudioContext) {
    this.ready = oversampleLatencySec(ctx.sampleRate, '4x').then(() => undefined);
    this.wd = new WetDry(ctx);
    // 4096-point curve + 4x oversampling: the tape curve's odd harmonics stay
    // below Nyquist instead of folding back as fizz on hi-hats.
    this.sat = ctx.createWaveShaper(); this.sat.oversample = '4x';
    this.lpf = ctx.createBiquadFilter(); this.lpf.type = 'lowpass'; this.lpf.Q.value = 0.3;
    this.hpf = ctx.createBiquadFilter(); this.hpf.type = 'highpass'; this.hpf.frequency.value = 20;
    // Base delays are just deep enough for the modulation (wow swings ≤3 ms,
    // flutter ≤0.5 ms) — 4 ms + 1 ms. They were 20 ms + 20 ms, which put the
    // whole wet path 40 ms LATE: 40 ms of live latency on the strip and a
    // VINYL/TAPE stem landing 40 ms behind every other stem in an export.
    this.wowDelay = ctx.createDelay(0.1); this.wowDelay.delayTime.value = 0.004;
    this.wowLfo = ctx.createOscillator(); this.wowLfo.type = 'sine';
    this.wowDepth = ctx.createGain();
    this.flutDelay = ctx.createDelay(0.1); this.flutDelay.delayTime.value = 0.001;
    this.flutLfo = ctx.createOscillator(); this.flutLfo.type = 'sine';
    this.flutDepth = ctx.createGain();
    this.warmth = ctx.createBiquadFilter(); this.warmth.type = 'peaking'; this.warmth.frequency.value = 200; this.warmth.Q.value = 0.7;

    // Main series chain.
    this.wd.wetIn.connect(this.sat);
    this.sat.connect(this.lpf);
    this.lpf.connect(this.hpf);
    this.hpf.connect(this.wowDelay);
    this.wowDelay.connect(this.flutDelay);
    this.flutDelay.connect(this.warmth);
    this.warmth.connect(this.wd.wetOut);
    // LFO pitch modulation on the delay lines.
    this.wowLfo.connect(this.wowDepth); this.wowDepth.connect(this.wowDelay.delayTime);
    this.flutLfo.connect(this.flutDepth); this.flutDepth.connect(this.flutDelay.delayTime);

    this.inputNode = this.wd.input;
    this.outputNode = this.wd.output;
    this.update();
    this.primed = true;
    try { this.wowLfo.start(); this.flutLfo.start(); this.started = true; } catch { /* */ }
  }

  setParam(key: string, value: FxParamValue): void {
    this.params[key] = Number(value);
    this.update();
  }
  bypass(on: boolean): void { this.wd.setBypassed(on); }
  /** Wow (4 ms) + flutter (1 ms) base delays + the 4x-oversampled tape shaper. */
  latencySec(): number { return 0.005 + oversampleLatencyKnown(this.ctx.sampleRate, '4x'); }
  readonly ready: Promise<void>;
  dispose(): void {
    try { if (this.started) { this.wowLfo.stop(); this.flutLfo.stop(); } } catch { /* */ }
    for (const n of [this.sat, this.lpf, this.hpf, this.wowDelay, this.wowLfo, this.wowDepth, this.flutDelay, this.flutLfo, this.flutDepth, this.warmth]) {
      try { n.disconnect(); } catch { /* */ }
    }
    this.wd.disconnect();
  }

  private update(): void {
    const instant = !this.primed;
    const set = (p: AudioParam, v: number, tau: number) => setParam(this.ctx, p, v, tau, instant);
    const drive = clamp(Number(this.params.DRIVE), 0, 10);
    const age = clamp(Number(this.params.AGE), 0, 10);
    const wow = clamp(Number(this.params.WOW), 0, 10);
    const flutter = clamp(Number(this.params.FLUTTER), 0, 10);
    const warmthN = clamp(Number(this.params.WARMTH), 0, 10);

    if (drive !== this.lastDrive) { this.buildSatCurve(drive); this.lastDrive = drive; }
    // Old-vinyl high rolloff: 20kHz (fresh) → 8kHz (worn) as AGE rises.
    set(this.lpf.frequency, 20000 - (age / 10) * 12000, 0.02);
    // Wow: slow 0.1-0.8Hz drift, up to ~3ms.
    set(this.wowLfo.frequency, 0.1 + (wow / 10) * 0.7, 0.05);
    set(this.wowDepth.gain, (wow / 10) * 0.003, 0.05);
    // Flutter: fast 3-8Hz wobble, up to ~0.5ms.
    set(this.flutLfo.frequency, 3 + (flutter / 10) * 5, 0.05);
    set(this.flutDepth.gain, (flutter / 10) * 0.0005, 0.05);
    // Warmth bell at 200Hz: +2dB baseline up to +6dB.
    set(this.warmth.gain, 2 + (warmthN / 10) * 4, 0.02);
  }

  private buildSatCurve(drive: number): void {
    const g = 1 + (drive / 10) * 3;
    const N = 4096;
    const curve = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      let x = ((i / (N - 1)) * 2 - 1) * g;
      x = clamp(x, -1, 1);
      curve[i] = (3 * x / 2) * (1 - (x * x) / 3); // Doidic tape curve
    }
    this.sat.curve = curve;
  }
}
