// Shared scaffolding for the DAW Mixer insert effects.
//
// Every effect exposes the SAME minimal surface so the MixerEngine and the
// device-panel UI can treat them uniformly:
//   - inputNode  : connect the upstream signal here
//   - outputNode : the chain continues from here
//   - params     : current values (numbers or string enums)
//   - setParam   : update one param live
//   - bypass     : true = signal passes through dry (effect removed from sound)
//   - dispose    : disconnect every node so the effect can be GC'd
//
// All of these are DESKTOP-ONLY (the mixer never mounts on mobile/HardwareView),
// so deprecated-but-universal ScriptProcessorNode is fair game where a worklet
// would only add async-init fragility.

export type FxParamValue = number | string;

export interface MixerFX {
  readonly inputNode: AudioNode;
  readonly outputNode: AudioNode;
  params: Record<string, FxParamValue>;
  setParam(key: string, value: FxParamValue): void;
  bypass(on: boolean): void;
  dispose(): void;
  /** Processing latency this effect adds to the strip when NOT bypassed, in
   *  seconds (DynamicsCompressor look-ahead, WaveShaper oversampling, a fixed
   *  pre-delay). The MixerEngine's plugin-delay compensation lines every strip
   *  up on the longest one. Omit / 0 = latency-free. */
  latencySec?(): number;
  /** Resolves once anything asynchronous inside the effect (a measured
   *  latency, an AudioWorklet module) is in place. Offline renders await it
   *  before startRendering; live graphs just carry on. */
  ready?: Promise<void>;
  /** External key input (sidechain). The MixerEngine feeds the chosen source
   *  strip's signal in here; `params.SOURCE` names that strip. */
  readonly sidechainInput?: AudioNode;
}

export const clamp = (v: number, lo: number, hi: number): number =>
  Math.max(lo, Math.min(hi, v));
export const clamp01 = (v: number): number => clamp(v, 0, 1);
/** dB → linear amplitude. */
export const dbToGain = (db: number): number => Math.pow(10, db / 20);

/** True for an OfflineAudioContext (export render). */
export const isOfflineCtx = (ctx: BaseAudioContext): boolean =>
  typeof OfflineAudioContext !== 'undefined' && ctx instanceof OfflineAudioContext;

/** Set an AudioParam either instantly or with a short smoothing glide.
 *
 *  Live tweaks want the glide (no zipper noise under a knob). But the FIRST
 *  set — the constructor priming a node from its Web Audio default — and EVERY
 *  set inside an offline render must be instant: a `setTargetAtTime` from the
 *  default (delayTime 0, gain 1, oscillator 440 Hz, lowpass 350 Hz…) at t=0
 *  is a 50–250 ms parameter sweep at the head of every exported stem. That was
 *  the "tape start" whoosh on VINYL/TAPE stems (wow depth gliding from a
 *  1-second delay swing down to 3 ms). */
export function setParam(ctx: BaseAudioContext, p: AudioParam, v: number, tau: number, instant: boolean): void {
  const t = ctx.currentTime;
  if (instant || isOfflineCtx(ctx)) {
    p.cancelScheduledValues(t);
    p.setValueAtTime(v, t);
    return;
  }
  p.setTargetAtTime(v, t, tau);
}

/** Dry/wet bracket shared by all effects.
 *
 *  Graph:  input ─┬─> dry ─────────────────> output
 *                 └─> wetIn ─[effect]─ wetOut ─> output
 *
 *  Build the effect's processing between `wetIn` and `wetOut`. `setMix(1)` is a
 *  pure-wet series effect (the common case for EQ/FILTER/COMP/etc.), lower mix
 *  crossfades toward the dry path (DELAY/REVERB/PHASER/FLANGER/MB SAT DRY/WET,
 *  COMP NY-PARALLEL). Bypass forces full dry. */
export class WetDry {
  readonly input: GainNode;
  readonly output: GainNode;
  readonly wetIn: GainNode;
  readonly wetOut: GainNode;
  private dry: GainNode;
  private _mix = 1;
  private _bypassed = false;
  // Optional processing on the DRY leg so it matches the wet leg's latency /
  // phase (see setDryPath / setDryLatency). null = input → dry directly.
  private dryPath: { input: AudioNode; output: AudioNode } | null = null;
  private dryDelay: DelayNode | null = null;

  constructor(private ctx: BaseAudioContext) {
    this.input = ctx.createGain();
    this.output = ctx.createGain();
    this.wetIn = ctx.createGain();
    this.wetOut = ctx.createGain();
    this.dry = ctx.createGain();
    this.input.connect(this.dry);
    this.dry.connect(this.output);
    this.input.connect(this.wetIn);
    this.wetOut.connect(this.output);
    this.apply();
  }

  /** Route the dry leg through `input … output` instead of straight to the
   *  mix. Use it when the wet leg is LATE (a compressor's look-ahead, an
   *  oversampled shaper) or PHASE-ROTATED (a crossover) — an untreated dry leg
   *  summed with it comb-filters at any partial mix. Pass null to go direct. */
  setDryPath(path: { input: AudioNode; output: AudioNode } | null): void {
    if (this.dryPath) {
      try { this.input.disconnect(this.dryPath.input); } catch { /* */ }
      try { this.dryPath.output.disconnect(this.dry); } catch { /* */ }
    } else {
      try { this.input.disconnect(this.dry); } catch { /* */ }
    }
    this.dryPath = path;
    if (path) { this.input.connect(path.input); path.output.connect(this.dry); }
    else this.input.connect(this.dry);
  }

  /** Delay the dry leg by `sec` (0 = direct). A DelayNode is created on first
   *  use; the change is instant (a glide on delayTime would pitch-bend). */
  setDryLatency(sec: number): void {
    const s = Math.max(0, sec);
    if (s === 0 && !this.dryDelay) return;
    if (!this.dryDelay) {
      this.dryDelay = this.ctx.createDelay(0.1);
      this.setDryPath({ input: this.dryDelay, output: this.dryDelay });
    }
    const p = this.dryDelay.delayTime;
    p.cancelScheduledValues(this.ctx.currentTime);
    p.setValueAtTime(Math.min(0.1, s), this.ctx.currentTime);
  }

  setMix(m: number): void { this._mix = clamp01(m); this.apply(); }
  setBypassed(b: boolean): void { this._bypassed = b; this.apply(); }
  get mix(): number { return this._mix; }

  private apply(): void {
    // A real crossfade: dry = 1−mix, wet = mix. (It used to leave the wet leg
    // at 1 and only turn the dry down, so DRY/WET 0 % was dry + FULL reverb /
    // echoes / notches, and 50 % on a phaser was never the deepest setting.)
    this.dry.gain.value = this._bypassed ? 1 : 1 - this._mix;
    this.wetOut.gain.value = this._bypassed ? 0 : this._mix;
  }

  /** Disconnect the bracket nodes. Effects call this from dispose() after
   *  tearing down their own processing nodes. */
  disconnect(): void {
    for (const n of [this.input, this.output, this.wetIn, this.wetOut, this.dry, this.dryDelay, this.dryPath?.input, this.dryPath?.output]) {
      if (!n) continue;
      try { n.disconnect(); } catch { /* */ }
    }
  }
}
