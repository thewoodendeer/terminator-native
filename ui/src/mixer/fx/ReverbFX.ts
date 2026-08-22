import { MixerFX, FxParamValue, clamp, clamp01, WetDry, setParam } from './base';

/** REVERB — ConvolverNode fed a procedurally generated impulse response.
 *  ROOM_SIZE (0-100), PRE_DELAY (0-100ms), DECAY (0.1-10s), DRY/WET (0-100%). */
export class ReverbFX implements MixerFX {
  readonly inputNode: AudioNode;
  readonly outputNode: AudioNode;
  params: Record<string, FxParamValue> = { ROOM: 50, PREDELAY: 10, DECAY: 2, WET: 30 };
  private wd: WetDry;
  private pre: DelayNode;
  // Two convolvers, A/B. A ROOM/DECAY change builds the new impulse into the
  // IDLE one and crossfades to it (~60 ms) — swapping the buffer on the live
  // convolver restarted the tail with a click, and rebuilding on every knob
  // tick stalled the main thread (a 10 s IR is ~900k samples of exp/lowpass).
  // Live contexts also debounce the rebuild while the knob is moving; offline
  // (export) contexts build immediately so the render matches what was heard.
  private convs: [ConvolverNode, ConvolverNode];
  private fades: [GainNode, GainNode];
  private active = 0;
  private rebuildTimer: ReturnType<typeof setTimeout> | null = null;
  private primed = false;

  constructor(private ctx: BaseAudioContext) {
    this.wd = new WetDry(ctx);
    this.pre = ctx.createDelay(0.5);
    const mk = (): [ConvolverNode, GainNode] => {
      const c = ctx.createConvolver(); c.normalize = true;
      const g = ctx.createGain(); g.gain.value = 0;
      this.pre.connect(c); c.connect(g); g.connect(this.wd.wetOut);
      return [c, g];
    };
    const [cA, gA] = mk(); const [cB, gB] = mk();
    this.convs = [cA, cB]; this.fades = [gA, gB];
    this.wd.wetIn.connect(this.pre);
    this.inputNode = this.wd.input;
    this.outputNode = this.wd.output;
    this.convs[0].buffer = this.buildIR();
    this.fades[0].gain.value = 1;
    this.update();
    this.primed = true;
  }

  setParam(key: string, value: FxParamValue): void {
    this.params[key] = Number(value);
    if (key === 'ROOM' || key === 'DECAY') this.scheduleRebuild();
    this.update();
    this.wd.setMix(clamp01(Number(this.params.WET) / 100));
  }
  bypass(on: boolean): void { this.wd.setBypassed(on); }
  dispose(): void {
    if (this.rebuildTimer) { clearTimeout(this.rebuildTimer); this.rebuildTimer = null; }
    for (const n of [this.pre, ...this.convs, ...this.fades]) { try { n.disconnect(); } catch { /* */ } }
    this.wd.disconnect();
  }

  /** Live: coalesce knob ticks (one build ~60 ms after the last move); offline
   *  or not yet primed: build now. */
  private scheduleRebuild(): void {
    const live = typeof AudioContext !== 'undefined' && this.ctx instanceof AudioContext;
    if (!live || !this.primed) { this.swapIR(this.buildIR()); return; }
    if (this.rebuildTimer) clearTimeout(this.rebuildTimer);
    this.rebuildTimer = setTimeout(() => { this.rebuildTimer = null; this.swapIR(this.buildIR()); }, 60);
  }
  /** Load the new IR into the idle convolver and crossfade over to it. */
  private swapIR(ir: AudioBuffer): void {
    const next = 1 - this.active;
    this.convs[next].buffer = ir;
    const t = this.ctx.currentTime;
    const gOut = this.fades[this.active].gain, gIn = this.fades[next].gain;
    if (!this.primed || !(this.ctx instanceof AudioContext)) {
      gOut.value = 0; gIn.value = 1;
    } else {
      // Equal-power-ish linear crossfade, 60 ms — no gap, no click.
      gOut.cancelScheduledValues(t); gIn.cancelScheduledValues(t);
      gOut.setValueAtTime(gOut.value, t); gIn.setValueAtTime(gIn.value, t);
      gOut.linearRampToValueAtTime(0, t + 0.06);
      gIn.linearRampToValueAtTime(1, t + 0.06);
      // Once faded out, unload the old impulse so only ONE convolution runs
      // (a 10 s IR is real CPU) — unless another swap already reclaimed it.
      const old = this.active;
      setTimeout(() => { if (this.active !== old) this.convs[old].buffer = null; }, 120);
    }
    this.active = next;
  }

  /** Synthesised stereo IR. Exponential decay to −60 dB at DECAY, with air
   *  absorption: a one-pole lowpass whose cutoff falls over the tail (bright
   *  onset, dark tail — what a room does). ROOM shapes the onset: bigger rooms
   *  build up over a few ms instead of a slap, and start a touch darker.
   *  The old IR was undamped white noise on a polynomial curve — metallic. */
  private buildIR(): AudioBuffer {
    const decay = clamp(Number(this.params.DECAY), 0.1, 10);
    const room = clamp(Number(this.params.ROOM), 0, 100) / 100;
    const sr = this.ctx.sampleRate;
    const length = Math.max(1, Math.floor(sr * decay));
    const ir = this.ctx.createBuffer(2, length, sr);
    const buildUp = Math.max(1, Math.floor(sr * (0.002 + room * 0.03)));  // 2–32 ms onset
    const fcStart = 14000 - room * 6000;                                    // 14k → 8k
    const fcEnd = 1800;
    const k = -6.9078 / decay;                                              // ln(1e-3)
    // Seeded LCG: the two channels are independent (decorrelated → wide), and
    // an offline export renders the SAME IR the user auditioned live.
    let seed = 0x9e3779b9;
    const rnd = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296 * 2 - 1; };
    for (let c = 0; c < 2; c++) {
      const data = ir.getChannelData(c);
      let y = 0;
      for (let i = 0; i < length; i++) {
        const t = i / sr;
        const frac = i / length;
        const fc = fcStart + (fcEnd - fcStart) * Math.sqrt(frac);
        const a = 1 - Math.exp(-6.2832 * fc / sr);
        y += a * (rnd() - y);
        const onset = i < buildUp ? i / buildUp : 1;
        data[i] = y * Math.exp(k * t) * onset;
      }
    }
    return ir;
  }

  private update(): void {
    setParam(this.ctx, this.pre.delayTime, clamp(Number(this.params.PREDELAY), 0, 100) / 1000, 0.01, !this.primed);
  }
}
