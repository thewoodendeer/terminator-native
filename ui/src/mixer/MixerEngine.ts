// MixerEngine — the audio backbone of the desktop DAW Mixer.
//
// One ChannelStrip per source (sample chops + 5 drum tracks), four send/aux
// return strips, and a master strip. Every strip:
//
//   input(stereo) ─┬─> [pre meter]                                   (PRE level)
//                  └─> chainIn ─[insert FX…]─ chainOut
//                        └─> fader ─> mute ─> pan ─> output ─┬─> [post meter]
//                                                            ├─> master.input
//                                                            └─> send taps ─> send buses
//
// `input` forces 2 channels so a mono drum is upmixed to L=R BEFORE the strip —
// that keeps the StereoPanner transparent at centre, so PRE and POST meters read
// identically when there's no FX and the fader is at unity (per the spec).
//
// Desktop-only: this never mounts on mobile / HardwareView.

import { MixerFX, FxId, createFx, FX_REGISTRY, WET_PARAM_KEYS } from './fx';
import { compressorLatencySec } from '../renderer/audio/compressorLatency';
import { buildOfflineFXChain, type SerializedFX } from './fx/buildFXChain';
import { ConsoleStage, DEFAULT_CONSOLE, normalizeConsole, type ConsoleSettings } from './ConsoleStage';
export { CONSOLE_FLAVOURS, type ConsoleFlavour, type ConsoleSettings } from './ConsoleStage';
const PDC_LS = 'terminator.mixer.pdc.v1';
const CONSOLE_LS = 'terminator.mixer.console.v1';

export const FADER_MIN_DB = -60; // anything at/below this = −∞ (silence)
export const FADER_MAX_DB = 6;
export const SEND_MIN_DB = -60;  // send −∞ = off

const dbToGain = (db: number): number => Math.pow(10, db / 20);
const faderToGain = (db: number): number => (db <= FADER_MIN_DB ? 0 : dbToGain(db));
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** Drop leading silence so baked chop one-shots keep a tight attack. Scans
 *  channel 0 for the first sample above `threshold`, then trims that many frames
 *  off every channel (kept aligned). A fully-silent buffer is returned as-is. */
function trimLeadingSilence(buffer: AudioBuffer, threshold = 0.00001): AudioBuffer {
  const ch0 = buffer.getChannelData(0);
  let start = 0;
  for (let i = 0; i < ch0.length; i++) {
    if (Math.abs(ch0[i]) > threshold) { start = i; break; }
  }
  if (start === 0) return buffer;
  const trimmed = new AudioBuffer({
    numberOfChannels: buffer.numberOfChannels,
    length: buffer.length - start,
    sampleRate: buffer.sampleRate,
  });
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    trimmed.getChannelData(c).set(buffer.getChannelData(c).subarray(start));
  }
  return trimmed;
}

/** Widened from a closed union so user-added drum lanes can own a strip. The
 *  six below are still the fixed defaults; anything else is created at runtime
 *  by MixerEngine.addChannel(). */
export type ChannelName = string;

/** Terminator 3.0 — the native shell's mirror (src/renderer/native/nativeMixerShadow.ts sets it): every strip
 *  setter reports here so the C++ mixer (engine/core/Mixer.h, Phase 4.1) follows the page's strips — the Web Audio
 *  graph below keeps running for the UI (faders, meters until 4.3) while the engine is what is heard. Null in
 *  Electron / the browser (no-op). */
export interface MixerNativeSink {
  channel(name: ChannelName, kind: 'channel' | 'send', present: boolean): void;
  fader(name: ChannelName | 'master', db: number): void;
  pan(name: ChannelName, pan: number): void;
  send(name: ChannelName, index: number, db: number): void;
  mute(name: ChannelName, on: boolean): void;
  solo(name: ChannelName, on: boolean): void;
  /** The insert chain (4.2): a device appended (with its current params) / removed / bypassed / a param / reordered /
   *  the chain cleared. `name` = 'master' for the master strip. */
  fxAdd(name: ChannelName | 'master', index: number, id: FxId, params: Record<string, number | string>): void;
  fxRemove(name: ChannelName | 'master', index: number): void;
  fxBypass(name: ChannelName | 'master', index: number, on: boolean): void;
  fxParam(name: ChannelName | 'master', index: number, id: FxId, key: string, value: number | string): void;
  fxReorder(name: ChannelName | 'master', from: number, to: number): void;
  fxClear(name: ChannelName | 'master'): void;
  /** CONSOLE (4.2c): the desk stage's global settings (on / flavour / amount) — the engine seeds every strip by its
   *  name itself (the shadow sends the seed with the strip). */
  console?(settings: ConsoleSettings): void;
  /** PDC (4.4): on / off only — the engine builds the same two-tier plan from the chain latencies it already owns. */
  pdc?(on: boolean): void;
}
let nativeSink: MixerNativeSink | null = null;
export function setMixerNativeSink(sink: MixerNativeSink | null): void { nativeSink = sink; }

/** Terminator 3.0 — the native engine's METERS (4.3): when the shadow is attached the C++ mixer is what is heard, so
 *  the strips' peaks, the master's BS.1770 loudness and the dynamics devices' gain reduction come from its snapshot
 *  (the Web Audio graph's own meters read a signal nobody hears). Null in Electron / the browser. */
export interface MixerNativeMeters {
  /** [preL, preR, postL, postR] peaks for a page channel (or 'master'), null = not known natively. */
  levels(name: ChannelName | 'master'): StripLevels | null;
  /** The master's loudness reading, null = none yet. */
  loudness(): Loudness | null;
  /** A dynamics insert's gain reduction (dB ≤ 0) at `index` on a strip, null = unknown. */
  gainReduction(name: ChannelName | 'master', index: number): number | null;
  /** The page's RESET on the loudness popup. */
  resetLoudness(): void;
}
let nativeMeters: MixerNativeMeters | null = null;
export function setMixerNativeMeters(m: MixerNativeMeters | null): void { nativeMeters = m; }

export const DEFAULT_REGULAR_CHANNELS: ChannelName[] = ['sample', 'kick', 'snare', 'hat', 'openhat', 'perc'];
/** Mutable: addChannel() appends here so every consumer that iterates the
 *  mixer (render, metering, presets, exports) picks new strips up for free. */
export const REGULAR_CHANNELS: ChannelName[] = [...DEFAULT_REGULAR_CHANNELS];
export const SEND_CHANNELS: ChannelName[] = ['send1', 'send2', 'send3', 'send4'];

export interface FxPreset { id: FxId; bypassed: boolean; params: Record<string, number | string>; }
export interface ChannelPreset {
  fader: number; pan: number; mute: boolean; solo: boolean;
  sends: number[]; fx: FxPreset[];
}
export interface MixerPreset {
  channels: Partial<Record<ChannelName, ChannelPreset>>;
  master: { fader: number; fx: FxPreset[] };
  /** CONSOLE (analog-desk separation) — optional: projects saved before it
   *  existed leave the session's current setting alone. */
  console?: ConsoleSettings;
}

export interface StripLevels { preL: number; preR: number; postL: number; postR: number; }

/** What peak-meter-worklet.js pushes: the same four peaks levels() reports plus
 *  the two gain-match RMS taps, all over its 93 ms window. */
interface PushedLevels { preL: number; preR: number; postL: number; postR: number; inRms: number; outRms: number; }

/** Master loudness readout — ITU-R BS.1770-4 / EBU R128 from the audio-thread
 *  worklet (public/worklets/loudness-meter-worklet.js). LUFS values are
 *  -Infinity while silent; peaks are LINEAR (0..1+). `hold*` are since the last
 *  reset; `worklet` says whether the exact meter is running (false = the old
 *  main-thread approximation, e.g. AudioWorklet unavailable). */
export interface Loudness {
  m: number; s: number; i: number; lra: number;
  peakL: number; peakR: number; tpL: number; tpR: number;
  holdPeak: number; holdTp: number; maxM: number; maxS: number;
  corr: number; worklet: boolean;
}

const loudnessModuleLoads = new WeakMap<BaseAudioContext, Promise<void>>();
function loadLoudnessModule(ctx: BaseAudioContext): Promise<void> {
  let p = loudnessModuleLoads.get(ctx);
  if (!p) {
    p = ctx.audioWorklet
      ? ctx.audioWorklet.addModule('./worklets/loudness-meter-worklet.js')
      : Promise.reject(new Error('AudioWorklet unavailable'));
    loudnessModuleLoads.set(ctx, p);
  }
  return p;
}

const peakMeterModuleLoads = new WeakMap<BaseAudioContext, Promise<void>>();
/** One addModule per context for the per-strip peak meter (same idiom as the
 *  loudness worklet). */
function loadPeakMeterModule(ctx: BaseAudioContext): Promise<void> {
  let p = peakMeterModuleLoads.get(ctx);
  if (!p) {
    p = ctx.audioWorklet
      ? ctx.audioWorklet.addModule('./worklets/peak-meter-worklet.js')
      : Promise.reject(new Error('AudioWorklet unavailable'));
    peakMeterModuleLoads.set(ctx, p);
  }
  return p;
}

/** Linear peak of one analyser's current time-domain window. */
function peakOf(an: AnalyserNode, scratch: Float32Array): number {
  an.getFloatTimeDomainData(scratch as Float32Array<ArrayBuffer>);
  let p = 0;
  for (let i = 0; i < scratch.length; i++) { const a = Math.abs(scratch[i]); if (a > p) p = a; }
  return p;
}

/** RMS over the analyser window. Gain matching uses RMS rather than peak because
 *  it tracks perceived loudness — peak would let one transient set the trim for
 *  the whole chain. */
function rmsOf(an: AnalyserNode, scratch: Float32Array): number {
  an.getFloatTimeDomainData(scratch as Float32Array<ArrayBuffer>);
  let sum = 0;
  for (let i = 0; i < scratch.length; i++) sum += scratch[i] * scratch[i];
  return Math.sqrt(sum / scratch.length);
}

/** Approximate inter-sample (true) peak via 4× linear interpolation. */
function truePeakOf(an: AnalyserNode, scratch: Float32Array): number {
  an.getFloatTimeDomainData(scratch as Float32Array<ArrayBuffer>);
  let p = 0;
  for (let i = 0; i < scratch.length - 1; i++) {
    const a = scratch[i], b = scratch[i + 1];
    for (let k = 0; k < 4; k++) {
      const v = Math.abs(a + (b - a) * (k / 4));
      if (v > p) p = v;
    }
  }
  return p;
}

class ChannelStrip {
  readonly input: GainNode;
  private preSplit: ChannelSplitterNode;
  private preAnL: AnalyserNode; private preAnR: AnalyserNode;
  private chainIn: GainNode; private chainOut: GainNode;
  private faderGain: GainNode;
  private muteGain: GainNode;
  private panner: StereoPannerNode;
  readonly output: GainNode; // tap point: post fader/mute/pan (feeds the sends)
  /** Plugin-delay compensation: `pdcDelay` sits after the insert chain and
   *  lines this strip up with the longest chain in its group (channels or send
   *  buses); `toMaster` is the direct-to-master leg, delayed by the longest
   *  SEND-bus chain so a dry channel and its bus return reach the master
   *  together. Both 0 when nothing in the mix has latency. */
  readonly pdcDelay: DelayNode;
  readonly toMaster: DelayNode;
  /** Fired after any insert-chain change (add/remove/reorder/bypass/SOURCE,
   *  and once an effect's async latency lands) — the engine re-runs sidechain
   *  wiring + PDC. Set by the MixerEngine. */
  onChainChanged: (() => void) | null = null;
  private postSplit: ChannelSplitterNode;
  private postAnL: AnalyserNode; private postAnR: AnalyserNode;
  readonly sendGains: GainNode[] = [];
  private scratch: Float32Array;

  // ── auto gain match ────────────────────────────────────────────────
  // Trims the insert chain back to the level it received, so switching an FX in
  // and out compares CHARACTER instead of loudness — louder reads as better,
  // which is how you end up over-processing. Taps sit either side of the chain
  // (NOT around each FX: that would need 2 analysers + a gain per slot per
  // strip, and level-matching the chain is what you actually A/B).
  private matchInAn: AnalyserNode; private matchOutAn: AnalyserNode;
  private matchGain: GainNode;
  private matchScratch: Float32Array;
  gainMatch = false;
  /** Last applied trim in dB — surfaced so the strip can show what it's doing. */
  matchTrimDb = 0;

  fx: MixerFX[] = [];
  fxIds: FxId[] = [];
  fxBypassed: boolean[] = [];

  /** CONSOLE stage between `input` and the insert chain — present only while
   *  the mixer's CONSOLE is on (off = the node is not in the graph at all, so
   *  off is bit-identical to before it existed). */
  private console: ConsoleStage | null = null;

  faderDb = 0;
  pan = 0;
  muted = false;
  soloed = false;
  sendDbs: number[] = [SEND_MIN_DB, SEND_MIN_DB, SEND_MIN_DB, SEND_MIN_DB];
  /** peak-meter worklet + its latest push (null = the analyser path is live). */
  private meterNode: AudioWorkletNode | null = null;
  private pushed: PushedLevels | null = null;

  constructor(private ctx: AudioContext, readonly name: ChannelName, readonly isSend: boolean) {
    const mk = () => ctx.createGain();
    // 4096 = ~93 ms of samples at 44.1k: the meter loop reads once per frame,
    // and a slow frame (up to ~90 ms) can no longer fall between two windows and
    // miss a peak — every sample is seen by exactly one read or more.
    const an = () => { const a = ctx.createAnalyser(); a.fftSize = 4096; a.smoothingTimeConstant = 0.8; return a; };

    this.input = mk();
    this.input.channelCountMode = 'explicit';
    this.input.channelCount = 2;
    this.input.channelInterpretation = 'speakers';
    this.preSplit = ctx.createChannelSplitter(2);
    this.preAnL = an(); this.preAnR = an();
    this.chainIn = mk(); this.chainOut = mk();
    this.pdcDelay = ctx.createDelay(0.25);
    this.toMaster = ctx.createDelay(0.25);
    this.faderGain = mk();
    this.muteGain = mk();
    this.panner = ctx.createStereoPanner();
    this.output = mk();
    this.postSplit = ctx.createChannelSplitter(2);
    this.postAnL = an(); this.postAnR = an();
    this.scratch = new Float32Array(this.preAnL.fftSize);

    this.matchInAn = an(); this.matchOutAn = an();
    this.matchGain = mk();
    this.matchScratch = new Float32Array(this.matchInAn.fftSize);

    this.input.connect(this.preSplit);
    this.preSplit.connect(this.preAnL, 0);
    this.preSplit.connect(this.preAnR, 1);
    this.input.connect(this.chainIn);
    this.chainIn.connect(this.chainOut);
    // PDC delay first, then the match trim between the chain and the fader: it
    // corrects the FX chain only, and never fights the fader the user is holding.
    this.chainOut.connect(this.pdcDelay);
    this.pdcDelay.connect(this.matchGain);
    this.matchGain.connect(this.faderGain);
    // Listen-only taps either side of the insert chain.
    this.chainIn.connect(this.matchInAn);
    this.chainOut.connect(this.matchOutAn);
    this.faderGain.connect(this.muteGain);
    this.muteGain.connect(this.panner);
    this.panner.connect(this.output);
    this.output.connect(this.toMaster);
    this.output.connect(this.postSplit);
    this.postSplit.connect(this.postAnL, 0);
    this.postSplit.connect(this.postAnR, 1);

    if (!isSend) {
      for (let i = 0; i < 4; i++) {
        const g = mk(); g.gain.value = 0;
        this.output.connect(g);
        this.sendGains.push(g);
      }
    }

    // Six analysers per strip is real audio-thread work; swap them for one
    // worklet as soon as the module loads (analysers stay if it can't).
    this.attachMeterWorklet();
  }

  // ── parameter setters ──────────────────────────────────────────────
  setFaderDb(db: number): void {
    this.faderDb = clamp(db, FADER_MIN_DB, FADER_MAX_DB);
    this.faderGain.gain.setTargetAtTime(faderToGain(this.faderDb), this.ctx.currentTime, 0.008);
    nativeSink?.fader(this.name, this.faderDb);
  }
  setPan(p: number): void {
    this.pan = clamp(p, -1, 1);
    this.panner.pan.setTargetAtTime(this.pan, this.ctx.currentTime, 0.008);
    nativeSink?.pan(this.name, this.pan);
  }
  setSend(i: number, db: number): void {
    if (i < 0 || i >= this.sendGains.length) return;
    this.sendDbs[i] = clamp(db, SEND_MIN_DB, FADER_MAX_DB);
    this.sendGains[i].gain.setTargetAtTime(faderToGain(this.sendDbs[i]), this.ctx.currentTime, 0.008);
    nativeSink?.send(this.name, i, this.sendDbs[i]);
  }
  setMuted(b: boolean): void { this.muted = b; nativeSink?.mute(this.name, b); }
  setSoloed(b: boolean): void { this.soloed = b; nativeSink?.solo(this.name, b); }

  // ── CONSOLE stage ──────────────────────────────────────────────────
  /** Put the desk's channel stage in (settings.on) or take it out. Seeded by
   *  this strip's NAME, so the same strip is the same channel live and in an
   *  export, session after session. */
  setConsole(settings: ConsoleSettings): void {
    if (settings.on) {
      if (!this.console) {
        const stage = new ConsoleStage(this.ctx, 'channel', this.name, settings);
        try { this.input.disconnect(this.chainIn); } catch { /* */ }
        this.input.connect(stage.input);
        stage.output.connect(this.chainIn);
        this.console = stage;
      } else {
        this.console.set(settings.flavour, settings.amount);
      }
    } else if (this.console) {
      const stage = this.console;
      this.console = null;
      this.input.connect(this.chainIn);
      stage.dispose();
    }
  }

  /** Engine-driven: silence this strip when muted, or when another strip is
   *  soloed and this one isn't. */
  applyMute(anySolo: boolean): void {
    const silent = this.muted || (anySolo && !this.soloed);
    this.muteGain.gain.setTargetAtTime(silent ? 0 : 1, this.ctx.currentTime, 0.008);
  }

  // ── insert FX chain ────────────────────────────────────────────────
  private tearDownEdges(): void {
    try { this.chainIn.disconnect(); } catch { /* */ }
    for (const f of this.fx) { try { f.outputNode.disconnect(); } catch { /* */ } }
  }
  private rebuildChain(): void {
    // tearDownEdges() calls chainIn.disconnect(), which drops EVERY outgoing
    // edge — including the gain-match input tap. Re-attach it here or the
    // corrector reads silence on its input after any FX add/remove/reorder and
    // silently stops trimming. Web Audio ignores a duplicate connect, so this is
    // safe to run unconditionally.
    this.chainIn.connect(this.matchInAn);
    if (this.fx.length === 0) { this.chainIn.connect(this.chainOut); return; }
    this.chainIn.connect(this.fx[0].inputNode);
    for (let i = 0; i < this.fx.length - 1; i++) this.fx[i].outputNode.connect(this.fx[i + 1].inputNode);
    this.fx[this.fx.length - 1].outputNode.connect(this.chainOut);
  }
  addFx(id: FxId): number {
    if (this.fx.length >= 8) return -1;
    if (!FX_REGISTRY[id]) return -1;   // skip removed/unknown ids (e.g. a legacy preset's GATE/BIT)
    const fx = createFx(id, this.ctx);
    // Aux/send returns are 100% wet by convention — lock any dry/wet param.
    if (this.isSend) for (const k of Object.keys(fx.params)) if (WET_PARAM_KEYS.has(k)) fx.setParam(k, 100);
    this.tearDownEdges();
    this.fx.push(fx); this.fxIds.push(id); this.fxBypassed.push(false);
    this.rebuildChain();
    this.onChainChanged?.();
    nativeSink?.fxAdd(this.name, this.fx.length - 1, id, { ...fx.params });
    // A measured latency / a worklet arriving later changes the PDC picture.
    fx.ready?.then(() => { if (this.fx.includes(fx)) this.onChainChanged?.(); }).catch(() => {});
    return this.fx.length - 1;
  }
  removeFx(i: number): void {
    if (i < 0 || i >= this.fx.length) return;
    this.tearDownEdges();
    const [rm] = this.fx.splice(i, 1);
    this.fxIds.splice(i, 1);
    this.fxBypassed.splice(i, 1);
    this.rebuildChain();
    rm.dispose();
    this.onChainChanged?.();
    nativeSink?.fxRemove(this.name, i);
  }
  toggleBypass(i: number): void {
    if (i < 0 || i >= this.fx.length) return;
    this.fxBypassed[i] = !this.fxBypassed[i];
    this.fx[i].bypass(this.fxBypassed[i]);
    this.onChainChanged?.();
    nativeSink?.fxBypass(this.name, i, this.fxBypassed[i]);
  }
  setFxParam(i: number, key: string, value: number | string): void {
    if (i < 0 || i >= this.fx.length) return;
    this.fx[i].setParam(key, value);
    if (key === 'SOURCE') this.onChainChanged?.();
    nativeSink?.fxParam(this.name, i, this.fxIds[i], key, value);
  }
  private clearFx(): void {
    this.tearDownEdges();
    for (const f of this.fx) f.dispose();
    this.fx = []; this.fxIds = []; this.fxBypassed = [];
    this.rebuildChain();
    this.onChainChanged?.();
    nativeSink?.fxClear(this.name);
  }
  /** Latency of the insert chain (non-bypassed effects), seconds. */
  chainLatencySec(): number {
    let t = 0;
    for (let i = 0; i < this.fx.length; i++) if (!this.fxBypassed[i]) t += this.fx[i].latencySec?.() ?? 0;
    return t;
  }
  /** Set the two PDC delays (seconds). Instant — a glide would pitch-bend. */
  setPdc(chainSec: number, toMasterSec: number): void {
    const t = this.ctx.currentTime;
    for (const [node, v] of [[this.pdcDelay, chainSec], [this.toMaster, toMasterSec]] as Array<[DelayNode, number]>) {
      const val = clamp(v, 0, 0.25);
      if (Math.abs(node.delayTime.value - val) < 1e-6) continue;
      node.delayTime.cancelScheduledValues(t);
      node.delayTime.setValueAtTime(val, t);
    }
  }
  /** Move a filled FX from `from` to `to` and rewire input → … → fader in the
   *  new order. The fx instance + its id + bypass state move together. */
  reorderFx(from: number, to: number): void {
    const n = this.fx.length;
    if (from < 0 || from >= n || to < 0 || to >= n || from === to) return;
    this.tearDownEdges();
    const [fx] = this.fx.splice(from, 1);
    const [id] = this.fxIds.splice(from, 1);
    const [byp] = this.fxBypassed.splice(from, 1);
    this.fx.splice(to, 0, fx);
    this.fxIds.splice(to, 0, id);
    this.fxBypassed.splice(to, 0, byp);
    this.rebuildChain();
    nativeSink?.fxReorder(this.name, from, to);
  }

  // ── auto gain match ────────────────────────────────────────────────
  setGainMatch(on: boolean): void {
    this.gainMatch = on;
    if (!on) {
      this.matchTrimDb = 0;
      this.matchGain.gain.setTargetAtTime(1, this.ctx.currentTime, 0.05);
    }
  }

  /** One control-loop step. Driven from the same rAF that paints the meters, so
   *  it costs no extra timer. Compares RMS either side of the insert chain and
   *  trims the output back toward the input level.
   *
   *  Deliberately slow and bounded: a fast corrector would duck transients and
   *  fight a compressor (chasing its gain reduction sample-by-sample), which is
   *  the opposite of the point. RMS over a full analyser window, a long
   *  smoothing time and a ±15 dB clamp make it behave like a static trim that
   *  settles, not a second compressor. Below the noise floor it holds the last
   *  trim rather than diverging on silence. */
  updateGainMatch(): void {
    if (!this.gainMatch) return;
    const inRms = this.pushed ? this.pushed.inRms : rmsOf(this.matchInAn, this.matchScratch);
    const outRms = this.pushed ? this.pushed.outRms : rmsOf(this.matchOutAn, this.matchScratch);
    const FLOOR = 1e-4;                       // ~-80 dBFS; below this it's silence
    if (inRms < FLOOR || outRms < FLOOR) return;
    const raw = inRms / outRms;
    const db = Math.max(-15, Math.min(15, 20 * Math.log10(raw)));
    this.matchTrimDb = db;
    this.matchGain.gain.setTargetAtTime(Math.pow(10, db / 20), this.ctx.currentTime, 0.25);
  }

  // ── metering ───────────────────────────────────────────────────────
  levels(): StripLevels {
    // The native engine's strip (4.3) when the shadow is attached — that is what is heard.
    const nv = nativeMeters?.levels(this.name);
    if (nv) return nv;
    // Worklet live → a cached scalar read (it pushes every ~46 ms over a 93 ms
    // window, the same window the analysers reported). Otherwise the original
    // main-thread pull.
    const p = this.pushed;
    if (p) return { preL: p.preL, preR: p.preR, postL: p.postL, postR: p.postR };
    return {
      preL: peakOf(this.preAnL, this.scratch),
      preR: peakOf(this.preAnR, this.scratch),
      postL: peakOf(this.postAnL, this.scratch),
      postR: peakOf(this.postAnR, this.scratch),
    };
  }
  /** True when this strip's meters come from the worklet (tests + diagnostics). */
  meterOnWorklet(): boolean { return !!this.meterNode; }

  // ── offline-render helpers (export FX baking) ──────────────────────
  /** Insert chain as plain data — feeds buildOfflineFXChain so the exact live
   *  effects can be rebuilt in an OfflineAudioContext. */
  serializeFXChain(): SerializedFX[] {
    return this.fx.map((f, i) => ({ type: this.fxIds[i], params: { ...f.params }, bypassed: this.fxBypassed[i] }));
  }
  /** Fader level as a linear amplitude (1.0 = unity / 0 dB). */
  getFaderLinear(): number { return faderToGain(this.faderDb); }

  // ── presets ────────────────────────────────────────────────────────
  serialize(): ChannelPreset {
    return {
      fader: this.faderDb, pan: this.pan, mute: this.muted, solo: this.soloed,
      sends: this.sendDbs.slice(),
      fx: this.fx.map((f, i) => ({ id: this.fxIds[i], bypassed: this.fxBypassed[i], params: { ...f.params } })),
    };
  }
  restore(p: ChannelPreset): void {
    this.clearFx();
    this.setFaderDb(p.fader ?? 0);
    this.setPan(p.pan ?? 0);
    this.setMuted(!!p.mute);
    this.setSoloed(!!p.solo);
    const sends = p.sends ?? [];
    for (let i = 0; i < this.sendGains.length; i++) this.setSend(i, sends[i] ?? SEND_MIN_DB);
    for (const fp of p.fx ?? []) {
      const idx = this.addFx(fp.id);
      if (idx < 0) continue;
      for (const [k, v] of Object.entries(fp.params ?? {})) this.fx[idx].setParam(k, v);
      if (fp.bypassed) this.toggleBypass(idx);
    }
  }

  /** ONE worklet instead of this strip's six analysers (peak-meter-worklet.js).
   *  Six AnalyserNodes per strip × ~11 strips is real audio-thread work, and
   *  the meter loop pulled 4 × 4096-sample windows per strip per FRAME on the
   *  main thread; the worklet measures where the samples already are and pushes
   *  scalars. Called after construction; on any failure the analysers stay and
   *  nothing changes (house style — see the loudness meter).
   *  Inputs: 0 pre-fader · 1 post-fader · 2 chain in · 3 chain out. */
  private attachMeterWorklet(): void {
    void loadPeakMeterModule(this.ctx).then(() => {
      if (this.meterNode || this.ctx.state === 'closed') return;
      const n = new AudioWorkletNode(this.ctx, 'peak-meter', {
        numberOfInputs: 4, numberOfOutputs: 0,
        channelCount: 2, channelCountMode: 'explicit', channelInterpretation: 'speakers',
      });
      n.port.onmessage = (e: MessageEvent) => { this.pushed = e.data as PushedLevels; };
      this.input.connect(n, 0, 0);
      this.output.connect(n, 0, 1);
      this.chainIn.connect(n, 0, 2);
      this.chainOut.connect(n, 0, 3);
      this.meterNode = n;
      // The analysers are now dead weight ON THE AUDIO THREAD — cut them out.
      for (const [src, an] of [[this.preSplit, this.preAnL], [this.preSplit, this.preAnR],
        [this.postSplit, this.postAnL], [this.postSplit, this.postAnR],
        [this.chainIn, this.matchInAn], [this.chainOut, this.matchOutAn]] as Array<[AudioNode, AnalyserNode]>) {
        try { src.disconnect(an); } catch { /* already gone */ }
      }
      try { this.input.disconnect(this.preSplit); } catch { /* */ }
      try { this.output.disconnect(this.postSplit); } catch { /* */ }
    }).catch((err) => {
      console.warn('[mixer] peak-meter worklet unavailable — main-thread analyser meters in use:', err);
    });
  }

  dispose(): void {
    this.clearFx();
    try { this.meterNode?.port.close(); this.meterNode?.disconnect(); } catch { /* */ }
    this.meterNode = null;
    this.console?.dispose(); this.console = null;
    for (const n of [this.input, this.preSplit, this.preAnL, this.preAnR, this.chainIn, this.chainOut, this.pdcDelay, this.toMaster,
      this.faderGain, this.muteGain, this.panner, this.output, this.postSplit, this.postAnL, this.postAnR, ...this.sendGains]) {
      try { n.disconnect(); } catch { /* */ }
    }
  }
}

/** LOUDNESS TAP — the BS.1770-4 / R128 meter + the 8192-bin spectrum as a
 *  stand-alone listener. Connect any node into `input` (it has no output — a
 *  pure tap) and read `updateLoudness()` / `spectrum`. The desktop MasterStrip
 *  owns one on its post-limiter output; the phone's HardwareView hangs one off
 *  the ChopperEngine's `outputNode` so its MIXER screen reads the same numbers
 *  and opens the same LoudnessPopup without mounting the DAW mixer. */
export class LoudnessTap {
  readonly input: GainNode;
  /** Spectrum for the loudness popup — 8192 bins ≈ 5.4 Hz per bin at 44.1k;
   *  the popup draws it on a log axis. */
  readonly spectrum: AnalyserNode;
  private kHigh: BiquadFilterNode; private kHP: BiquadFilterNode;
  private lufsAn: AnalyserNode;
  /** Exact meter (worklet). null until the module loads / if it can't. */
  private loudNode: AudioWorkletNode | null = null;
  private loud: Loudness = { m: -Infinity, s: -Infinity, i: -Infinity, lra: 0, peakL: 0, peakR: 0, tpL: 0, tpR: 0, holdPeak: 0, holdTp: 0, maxM: -Infinity, maxS: -Infinity, corr: 1, worklet: false };
  private lufsScratch: Float32Array;
  // LUFS sliding windows (approx, ~60fps frames).
  private momWin: number[] = [];   // ~400ms
  private shortWin: number[] = []; // ~3s
  private intSum = 0; private intCount = 0;

  constructor(private ctx: AudioContext) {
    this.input = ctx.createGain();
    // K-weighting pre-filters for the LUFS approximation.
    this.kHigh = ctx.createBiquadFilter(); this.kHigh.type = 'highshelf'; this.kHigh.frequency.value = 1500; this.kHigh.gain.value = 4;
    this.kHP = ctx.createBiquadFilter(); this.kHP.type = 'highpass'; this.kHP.frequency.value = 38; this.kHP.Q.value = 0.5;
    this.lufsAn = ctx.createAnalyser(); this.lufsAn.fftSize = 4096; this.lufsAn.smoothingTimeConstant = 0.8;
    this.lufsScratch = new Float32Array(this.lufsAn.fftSize);
    this.input.connect(this.kHigh);
    this.kHigh.connect(this.kHP);
    this.kHP.connect(this.lufsAn);
    this.spectrum = ctx.createAnalyser();
    this.spectrum.fftSize = 8192;
    this.spectrum.smoothingTimeConstant = 0.6;
    this.spectrum.minDecibels = -100; this.spectrum.maxDecibels = 0;
    this.input.connect(this.spectrum);
    // The exact BS.1770 meter, on the audio thread. Until it lands (or if the
    // worklet can't load) updateLoudness() serves the old approximation.
    void loadLoudnessModule(ctx).then(() => {
      if (this.loudNode || ctx.state === 'closed') return;
      const n = new AudioWorkletNode(ctx, 'loudness-meter', {
        numberOfInputs: 1, numberOfOutputs: 0, channelCount: 2, channelCountMode: 'explicit', channelInterpretation: 'speakers',
      });
      n.port.onmessage = (e: MessageEvent) => {
        const d = e.data as { m: number; s: number; i: number; lra: number; peakL: number; peakR: number; tpL: number; tpR: number; corr: number };
        const L = this.loud;
        this.loud = {
          ...d, worklet: true,
          holdPeak: Math.max(L.holdPeak, d.peakL, d.peakR),
          holdTp: Math.max(L.holdTp, d.tpL, d.tpR),
          maxM: Math.max(L.maxM, d.m), maxS: Math.max(L.maxS, d.s),
        };
      };
      this.input.connect(n);
      this.loudNode = n;
      this.loud = { ...this.loud, worklet: true };
      console.info('[mixer] BS.1770-4 loudness meter running (worklet)');
    }).catch((err) => { console.warn('[mixer] BS.1770 loudness worklet unavailable — approximate meter in use:', err); });
  }

  /** Momentary / short-term / integrated LUFS etc. — exact from the worklet
   *  when it runs, else the main-thread approximation (called per frame). */
  updateLoudness(): Loudness {
    if (this.loudNode) return this.loud;
    const a = this.approxLoudness();
    return { ...this.loud, ...a, worklet: false };
  }
  private approxLoudness(): { m: number; s: number; i: number } {
    this.lufsAn.getFloatTimeDomainData(this.lufsScratch as Float32Array<ArrayBuffer>);
    let sum = 0;
    for (let i = 0; i < this.lufsScratch.length; i++) sum += this.lufsScratch[i] * this.lufsScratch[i];
    const ms = sum / this.lufsScratch.length;
    const lufsFromMs = (m: number) => (m > 0 ? -0.691 + 10 * Math.log10(m) : -Infinity);
    this.momWin.push(ms); if (this.momWin.length > 24) this.momWin.shift();
    this.shortWin.push(ms); if (this.shortWin.length > 180) this.shortWin.shift();
    const blockLufs = lufsFromMs(ms);
    if (blockLufs > -70) { this.intSum += ms; this.intCount++; } // absolute gate
    const mean = (arr: number[]) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0);
    return {
      m: lufsFromMs(mean(this.momWin)),
      s: lufsFromMs(mean(this.shortWin)),
      i: this.intCount ? lufsFromMs(this.intSum / this.intCount) : -Infinity,
    };
  }
  resetIntegrated(): void {
    this.intSum = 0; this.intCount = 0;
    try { this.loudNode?.port.postMessage('reset'); } catch { /* */ }
    this.loud = { ...this.loud, i: -Infinity, lra: 0, holdPeak: 0, holdTp: 0, maxM: -Infinity, maxS: -Infinity };
  }
  /** Detach from the graph (phone view unmount). */
  dispose(): void {
    try { this.input.disconnect(); } catch { /* */ }
    try { this.loudNode?.disconnect(); } catch { /* */ }
    this.loudNode = null;
  }
}

/** The subset of MasterStrip the LoudnessPopup reads — MasterStrip and
 *  LoudnessTap both satisfy it. */
export interface LoudnessSource { spectrum: AnalyserNode; updateLoudness(): Loudness; resetIntegrated(): void }

class MasterStrip {
  readonly input: GainNode;
  private preSplit: ChannelSplitterNode;
  private preAnL: AnalyserNode; private preAnR: AnalyserNode;
  private chainIn: GainNode; private chainOut: GainNode;
  private faderGain: GainNode;
  private limiter: DynamicsCompressorNode;
  readonly output: GainNode;
  private postSplit: ChannelSplitterNode;
  private postAnL: AnalyserNode; private postAnR: AnalyserNode;
  /** Loudness + spectrum meter on the post-fader, post-limiter master. */
  private meter: LoudnessTap;
  private scratch: Float32Array;

  fx: MixerFX[] = [];
  fxIds: FxId[] = [];
  fxBypassed: boolean[] = [];
  faderDb = 0;
  /** CONSOLE bus stage (summing glue) between `input` and the insert chain. */
  private console: ConsoleStage | null = null;

  constructor(private ctx: AudioContext) {
    const mk = () => ctx.createGain();
    // 4096 = ~93 ms of samples at 44.1k: the meter loop reads once per frame,
    // and a slow frame (up to ~90 ms) can no longer fall between two windows and
    // miss a peak — every sample is seen by exactly one read or more.
    const an = () => { const a = ctx.createAnalyser(); a.fftSize = 4096; a.smoothingTimeConstant = 0.8; return a; };
    this.input = mk();
    this.input.channelCountMode = 'explicit';
    this.input.channelCount = 2;
    this.input.channelInterpretation = 'speakers';
    this.preSplit = ctx.createChannelSplitter(2);
    this.preAnL = an(); this.preAnR = an();
    this.chainIn = mk(); this.chainOut = mk();
    this.faderGain = mk();
    this.limiter = ctx.createDynamicsCompressor();
    this.limiter.threshold.value = -1; this.limiter.knee.value = 0;
    this.limiter.ratio.value = 20; this.limiter.attack.value = 0.001; this.limiter.release.value = 0.05;
    this.output = mk();
    this.postSplit = ctx.createChannelSplitter(2);
    this.postAnL = an(); this.postAnR = an();
    this.meter = new LoudnessTap(ctx);
    this.scratch = new Float32Array(this.preAnL.fftSize);

    this.input.connect(this.preSplit);
    this.preSplit.connect(this.preAnL, 0);
    this.preSplit.connect(this.preAnR, 1);
    this.input.connect(this.chainIn);
    this.chainIn.connect(this.chainOut);
    this.chainOut.connect(this.faderGain);
    this.faderGain.connect(this.limiter);
    this.limiter.connect(this.output);
    this.output.connect(this.postSplit);
    this.postSplit.connect(this.postAnL, 0);
    this.postSplit.connect(this.postAnR, 1);
    this.output.connect(this.meter.input);
  }

  connectToDestination(): void { this.output.connect(this.ctx.destination); }

  setFaderDb(db: number): void {
    this.faderDb = clamp(db, FADER_MIN_DB, FADER_MAX_DB);
    this.faderGain.gain.setTargetAtTime(faderToGain(this.faderDb), this.ctx.currentTime, 0.008);
    nativeSink?.fader('master', this.faderDb);
  }

  /** See ChannelStrip.setConsole — the master carries the BUS stage. */
  setConsole(settings: ConsoleSettings): void {
    if (settings.on) {
      if (!this.console) {
        const stage = new ConsoleStage(this.ctx, 'bus', 'master', settings);
        try { this.input.disconnect(this.chainIn); } catch { /* */ }
        this.input.connect(stage.input);
        stage.output.connect(this.chainIn);
        this.console = stage;
      } else {
        this.console.set(settings.flavour, settings.amount);
      }
    } else if (this.console) {
      const stage = this.console;
      this.console = null;
      this.input.connect(this.chainIn);
      stage.dispose();
    }
  }

  // FX chain (mirrors ChannelStrip, no pan/sends).
  private tearDownEdges(): void {
    try { this.chainIn.disconnect(); } catch { /* */ }
    for (const f of this.fx) { try { f.outputNode.disconnect(); } catch { /* */ } }
  }
  private rebuildChain(): void {
    if (this.fx.length === 0) { this.chainIn.connect(this.chainOut); return; }
    this.chainIn.connect(this.fx[0].inputNode);
    for (let i = 0; i < this.fx.length - 1; i++) this.fx[i].outputNode.connect(this.fx[i + 1].inputNode);
    this.fx[this.fx.length - 1].outputNode.connect(this.chainOut);
  }
  /** See ChannelStrip.onChainChanged. */
  onChainChanged: (() => void) | null = null;
  addFx(id: FxId): number {
    if (this.fx.length >= 8) return -1;
    if (!FX_REGISTRY[id]) return -1;   // skip removed/unknown ids (e.g. a legacy preset's GATE/BIT)
    const fx = createFx(id, this.ctx);
    this.tearDownEdges();
    this.fx.push(fx); this.fxIds.push(id); this.fxBypassed.push(false);
    this.rebuildChain();
    this.onChainChanged?.();
    nativeSink?.fxAdd('master', this.fx.length - 1, id, { ...fx.params });
    fx.ready?.then(() => { if (this.fx.includes(fx)) this.onChainChanged?.(); }).catch(() => {});
    return this.fx.length - 1;
  }
  removeFx(i: number): void {
    if (i < 0 || i >= this.fx.length) return;
    this.tearDownEdges();
    const [rm] = this.fx.splice(i, 1);
    this.fxIds.splice(i, 1); this.fxBypassed.splice(i, 1);
    this.rebuildChain(); rm.dispose();
    this.onChainChanged?.();
    nativeSink?.fxRemove('master', i);
  }
  toggleBypass(i: number): void {
    if (i < 0 || i >= this.fx.length) return;
    this.fxBypassed[i] = !this.fxBypassed[i];
    this.fx[i].bypass(this.fxBypassed[i]);
    this.onChainChanged?.();
    nativeSink?.fxBypass('master', i, this.fxBypassed[i]);
  }
  setFxParam(i: number, key: string, value: number | string): void {
    if (i >= 0 && i < this.fx.length) this.fx[i].setParam(key, value);
    if (key === 'SOURCE') this.onChainChanged?.();
    if (i >= 0 && i < this.fx.length) nativeSink?.fxParam('master', i, this.fxIds[i], key, value);
  }
  private clearFx(): void {
    this.tearDownEdges();
    for (const f of this.fx) f.dispose();
    this.fx = []; this.fxIds = []; this.fxBypassed = [];
    this.rebuildChain();
    this.onChainChanged?.();
  }
  reorderFx(from: number, to: number): void {
    const n = this.fx.length;
    if (from < 0 || from >= n || to < 0 || to >= n || from === to) return;
    this.tearDownEdges();
    const [fx] = this.fx.splice(from, 1);
    const [id] = this.fxIds.splice(from, 1);
    const [byp] = this.fxBypassed.splice(from, 1);
    this.fx.splice(to, 0, fx);
    this.fxIds.splice(to, 0, id);
    this.fxBypassed.splice(to, 0, byp);
    this.rebuildChain();
    nativeSink?.fxReorder('master', from, to);
  }

  levels(): StripLevels & { truePeak: number } {
    const nv = nativeMeters?.levels('master');
    if (nv) {
      const lo = nativeMeters?.loudness();
      return { ...nv, truePeak: lo ? Math.max(lo.tpL, lo.tpR) : Math.max(nv.postL, nv.postR) };
    }
    return {
      preL: peakOf(this.preAnL, this.scratch),
      preR: peakOf(this.preAnR, this.scratch),
      postL: peakOf(this.postAnL, this.scratch),
      postR: peakOf(this.postAnR, this.scratch),
      truePeak: Math.max(truePeakOf(this.postAnL, this.scratch), truePeakOf(this.postAnR, this.scratch)),
    };
  }

  /** Master loudness (the native engine's BS.1770-4 meter when the shadow is attached; else the worklet, or the
   *  approximation until it loads). */
  updateLoudness(): Loudness { return nativeMeters?.loudness() ?? this.meter.updateLoudness(); }
  resetIntegrated(): void { nativeMeters?.resetLoudness(); this.meter.resetIntegrated(); }
  /** Spectrum for the loudness popup — post-fader, post-limiter master. */
  get spectrum(): AnalyserNode { return this.meter.spectrum; }

  serializeFXChain(): SerializedFX[] {
    return this.fx.map((f, i) => ({ type: this.fxIds[i], params: { ...f.params }, bypassed: this.fxBypassed[i] }));
  }
  getFaderLinear(): number { return faderToGain(this.faderDb); }

  serialize(): MixerPreset['master'] {
    return { fader: this.faderDb, fx: this.fx.map((f, i) => ({ id: this.fxIds[i], bypassed: this.fxBypassed[i], params: { ...f.params } })) };
  }
  restore(p: MixerPreset['master']): void {
    this.clearFx();
    this.setFaderDb(p?.fader ?? 0);
    for (const fp of p?.fx ?? []) {
      const idx = this.addFx(fp.id);
      if (idx < 0) continue;
      for (const [k, v] of Object.entries(fp.params ?? {})) this.fx[idx].setParam(k, v);
      if (fp.bypassed) this.toggleBypass(idx);
    }
  }
}

export class MixerEngine {
  readonly ctx: AudioContext;
  readonly channels = new Map<ChannelName, ChannelStrip>();
  /** Display name + colour for channels that aren't one of the fixed defaults.
   *  The strip UI has a static table for those; a lane the user added has no
   *  entry there, and reading through it blindly took the whole view down. */
  readonly channelMeta = new Map<ChannelName, { label: string; color: string }>();
  setChannelMeta(name: ChannelName, label: string, color: string): void {
    this.channelMeta.set(name, { label, color });
  }
  readonly master: MasterStrip;
  private connected = false;

  constructor(ctx: AudioContext) {
    this.ctx = ctx;
    this.master = new MasterStrip(ctx);
    // REGULAR_CHANNELS is module-level and mutable (addChannel appends to it),
    // so reset it to the defaults here — otherwise a second engine would try to
    // rebuild lanes added by the previous one, before any of them exist.
    REGULAR_CHANNELS.length = 0;
    REGULAR_CHANNELS.push(...DEFAULT_REGULAR_CHANNELS);
    for (const name of REGULAR_CHANNELS) this.channels.set(name, new ChannelStrip(ctx, name, false));
    for (const name of SEND_CHANNELS) this.channels.set(name, new ChannelStrip(ctx, name, true));
    // Regular + send returns all feed the master — through each strip's
    // direct-to-master PDC leg.
    for (const name of [...REGULAR_CHANNELS, ...SEND_CHANNELS]) {
      const strip = this.channels.get(name)!;
      strip.toMaster.connect(this.master.input);
      strip.onChainChanged = this.onAnyChainChanged;
    }
    this.master.onChainChanged = this.onAnyChainChanged;
    // Each regular channel's 4 send taps feed the matching aux return's input.
    for (const name of REGULAR_CHANNELS) {
      const strip = this.channels.get(name)!;
      SEND_CHANNELS.forEach((sn, i) => strip.sendGains[i].connect(this.channels.get(sn)!.input));
    }
    try { this.pdcOn = localStorage.getItem(PDC_LS) !== '0'; } catch { /* */ }
    try {
      const raw = localStorage.getItem(CONSOLE_LS);
      if (raw) this.console = normalizeConsole(JSON.parse(raw));
    } catch { /* */ }
    this.applyConsole();
    this.applySolo();
  }

  // ── CONSOLE — analog-desk separation ─────────────────────────────────
  /** Every strip gets its own slightly different channel stage (seeded by
   *  name: sub-sonic filter, ±0.3 dB tilt, level-dependent 2nd/3rd-harmonic
   *  drive at ~0.5 % THD) and the master gets a summing-bus stage — the thing
   *  that makes sources sit apart on a desk instead of smearing into one
   *  another in the box. Zero latency (PDC untouched), level-matched within
   *  0.1 dB (scripts/console.test.mts), OFF by default, and baked into every
   *  export exactly as heard. Saved with the project and remembered as the
   *  default for the next one. */
  console: ConsoleSettings = { ...DEFAULT_CONSOLE };
  setConsole(patch: Partial<ConsoleSettings>): void {
    this.console = normalizeConsole({ ...this.console, ...patch });
    try { localStorage.setItem(CONSOLE_LS, JSON.stringify(this.console)); } catch { /* */ }
    this.applyConsole();
  }
  private applyConsole(): void {
    for (const c of this.channels.values()) c.setConsole(this.console);
    this.master.setConsole(this.console);
    nativeSink?.console?.(this.console);
  }
  /** Build the desk stage for an offline render (null when CONSOLE is off). */
  private offlineConsole(ctx: BaseAudioContext, role: 'channel' | 'bus', seed: string): ConsoleStage | null {
    return this.console.on ? new ConsoleStage(ctx, role, seed, this.console) : null;
  }

  // ── plugin-delay compensation + sidechain routing ────────────────────
  /** PDC lines every strip up on the longest insert chain (channels among
   *  themselves, send buses among themselves, and the dry-to-master leg on the
   *  longest bus) so a COMP / SAT / VINYL on one strip no longer plays it late
   *  against the others — and a compressor on a send bus no longer comb-
   *  filters against the dry channel it returns beside. Costs up to ~10 ms of
   *  monitoring latency, ONLY while such inserts are in the mix. Default on. */
  pdcOn = true;
  setPdc(on: boolean): void {
    this.pdcOn = on;
    try { localStorage.setItem(PDC_LS, on ? '1' : '0'); } catch { /* */ }
    this.recomputeRouting();
    nativeSink?.pdc?.(on);
  }
  private onAnyChainChanged = (): void => { this.recomputeRouting(); };
  private sidechainWires = new Map<MixerFX, ChannelStrip | null>();

  /** Longest chain latency among regular channels / among send buses, and the
   *  per-strip compensation that follows from it. */
  pdcPlan(): { maxChan: number; maxBus: number; chain: Map<ChannelName, number> } {
    const chain = new Map<ChannelName, number>();
    let maxChan = 0, maxBus = 0;
    for (const [name, c] of this.channels) {
      const l = c.chainLatencySec();
      chain.set(name, l);
      if (c.isSend) maxBus = Math.max(maxBus, l); else maxChan = Math.max(maxChan, l);
    }
    return { maxChan, maxBus, chain };
  }
  /** Compensation delay a channel's post-chain signal carries (live and in
   *  exports): regular strips catch up to the longest channel chain, send
   *  buses to the longest bus chain. */
  pdcChainDelaySec(name: ChannelName): number {
    if (!this.pdcOn) return 0;
    const { maxChan, maxBus, chain } = this.pdcPlan();
    const c = this.channels.get(name);
    if (!c) return 0;
    return Math.max(0, (c.isSend ? maxBus : maxChan) - (chain.get(name) ?? 0));
  }
  /** Extra delay on the dry-to-master leg of regular channels (= the longest
   *  send-bus chain), so channels and bus returns sum aligned. */
  pdcMasterShiftSec(): number {
    return this.pdcOn ? this.pdcPlan().maxBus : 0;
  }

  recomputeRouting(): void {
    // Sidechains: every SC COMP listens to the strip its SOURCE names —
    // pre-fader, pre-insert (the source's own chain must not colour the key).
    const strips: Array<ChannelStrip | MasterStrip> = [...this.channels.values(), this.master];
    const live = new Set<MixerFX>();
    for (const strip of strips) {
      for (const fx of strip.fx) {
        if (!fx.sidechainInput) continue;
        live.add(fx);
        const want = String(fx.params.SOURCE ?? 'NONE');
        const src = this.channels.get(want) ?? null;
        const cur = this.sidechainWires.get(fx);
        if (cur === src && this.sidechainWires.has(fx)) continue;
        if (cur) { try { cur.input.disconnect(fx.sidechainInput); } catch { /* */ } }
        if (src) src.input.connect(fx.sidechainInput);
        this.sidechainWires.set(fx, src);
      }
    }
    for (const [fx, src] of this.sidechainWires) {
      if (live.has(fx)) continue;
      if (src && fx.sidechainInput) { try { src.input.disconnect(fx.sidechainInput); } catch { /* */ } }
      this.sidechainWires.delete(fx);
    }
    // PDC.
    const { maxChan, maxBus, chain } = this.pdcPlan();
    for (const [name, c] of this.channels) {
      if (!this.pdcOn) { c.setPdc(0, 0); continue; }
      const l = chain.get(name) ?? 0;
      if (c.isSend) c.setPdc(Math.max(0, maxBus - l), 0);
      else c.setPdc(Math.max(0, maxChan - l), maxBus);
    }
  }

  /** Input node for a source channel — connect ChopperEngine.outputNode /
   *  DrumEngine.trackOutputNodes[track] here. */
  getChannelInput(name: ChannelName): AudioNode {
    return this.channels.get(name)!.input;
  }

  getChannel(name: ChannelName): ChannelStrip { return this.channels.get(name)!; }

  /** Create a strip for a user-added drum lane and wire it to the master, so a
   *  new sound arrives with its own fader/pan/FX/sends like any other channel.
   *  Idempotent — re-adding an existing name returns the strip already there. */
  addChannel(name: ChannelName, opts?: { after?: ChannelName }): ChannelStrip {
    const existing = this.channels.get(name);
    if (existing) return existing;
    const strip = new ChannelStrip(this.ctx, name, false);
    strip.toMaster.connect(this.master.input);
    strip.onChainChanged = this.onAnyChainChanged;
    // Same send wiring the constructor gives the defaults: each tap feeds the
    // matching aux return's input.
    SEND_CHANNELS.forEach((sn, i) => {
      const ret = this.channels.get(sn);
      if (ret) strip.sendGains[i].connect(ret.input);
    });
    strip.setGainMatch(this.gainMatchOn);   // inherit the current match setting
    strip.setConsole(this.console);          // …and the desk stage, if it's on
    this.channels.set(name, strip);
    nativeSink?.channel(name, 'channel', true);
    if (!REGULAR_CHANNELS.includes(name)) {
      // Optional placement (a SAMPLE n strip sits right after the last SAMPLE
      // strip, not at the far end); default = append.
      const at = opts?.after ? REGULAR_CHANNELS.indexOf(opts.after) : -1;
      if (at >= 0) REGULAR_CHANNELS.splice(at + 1, 0, name); else REGULAR_CHANNELS.push(name);
    }
    this.recomputeRouting();
    return strip;
  }

  /** True when the strip is untouched — unity fader, centre pan, no mute/solo,
   *  no sends, no inserts. An auto-created source strip that empties out is
   *  removed only while it is pristine (a tuned strip is never thrown away). */
  isPristine(name: ChannelName): boolean {
    const c = this.channels.get(name);
    if (!c) return true;
    const p = c.serialize();
    return Math.abs(p.fader) < 0.01 && Math.abs(p.pan) < 0.01 && !p.mute && !p.solo
      && p.fx.length === 0 && p.sends.every(v => v <= SEND_MIN_DB + 0.01);
  }

  /** Tear a user-added strip down and forget it. */
  removeChannel(name: ChannelName): void {
    if (DEFAULT_REGULAR_CHANNELS.includes(name)) return;   // defaults are permanent
    const strip = this.channels.get(name);
    if (!strip) return;
    strip.dispose();
    this.channels.delete(name);
    this.channelMeta.delete(name);
    nativeSink?.channel(name, 'channel', false);
    const i = REGULAR_CHANNELS.indexOf(name);
    if (i >= 0) REGULAR_CHANNELS.splice(i, 1);
    // Any SC COMP keyed from this lane goes quiet (its wire is dropped) and the
    // PDC picture shrinks.
    this.recomputeRouting();
  }

  /** Auto gain match across every channel strip: each insert chain is trimmed
   *  back to the level it received, so adding an effect changes the sound
   *  without changing the loudness. Master is excluded — matching the master
   *  chain would just undo whatever you set the mix level to.
   *
   *  NOTE: this is a LIVE monitoring aid only. Exports render through
   *  buildOfflineFXChain from the serialized chain, which has no match trim, so
   *  a bounce is unaffected by where this happens to be sitting. */
  gainMatchOn = false;
  setGainMatch(on: boolean): void {
    this.gainMatchOn = on;
    for (const c of this.channels.values()) c.setGainMatch(on);
  }

  /** Move a filled FX within a strip's insert chain (channel name or 'master')
   *  and rewire the chain in the new order. */
  reorderFX(channelName: string, fromIndex: number, toIndex: number): void {
    const strip = channelName === 'master' ? this.master : this.channels.get(channelName as ChannelName);
    strip?.reorderFx(fromIndex, toIndex);
  }

  /** Decay headroom (seconds) for a serialized chain's time-based effects so
   *  reverb/delay tails aren't truncated in offline renders. */
  private static fxTailSec(serializedFX: SerializedFX[]): number {
    let tailSec = 0;
    for (const fx of serializedFX) {
      if (fx.bypassed) continue;
      if (fx.type === 'reverb') tailSec = Math.max(tailSec, Number(fx.params.DECAY ?? 2) + 0.5);
      if (fx.type === 'delay') tailSec = Math.max(tailSec, (Number(fx.params.TIME ?? 500) / 1000) * 8);
      if (fx.type === 'vinyl') tailSec = Math.max(tailSec, 0.5);
      if (fx.type === 'flanger' || fx.type === 'phaser') tailSec = Math.max(tailSec, 0.25); // feedback ring-out
    }
    return tailSec;
  }

  /** Tail headroom for a strip's CURRENT insert chain (channel name or 'master'). */
  stripTailSec(channelName: string): number {
    const strip = channelName === 'master' ? this.master : this.channels.get(channelName as ChannelName);
    return strip ? MixerEngine.fxTailSec(strip.serializeFXChain()) : 0;
  }

  /** True if any source channel sends to this aux above −∞ — i.e. the send bus
   *  carries signal and deserves its own stem in a trackout export. */
  isSendActive(sendName: ChannelName): boolean {
    const idx = SEND_CHANNELS.indexOf(sendName);
    if (idx < 0) return false;
    return REGULAR_CHANNELS.some(n => (this.channels.get(n)?.sendDbs[idx] ?? SEND_MIN_DB) > SEND_MIN_DB);
  }

  /** Linear gain of `channelName`'s send tap into send index `sendIdx` (0 = off). */
  getSendLinear(channelName: ChannelName, sendIdx: number): number {
    const db = this.channels.get(channelName)?.sendDbs[sendIdx] ?? SEND_MIN_DB;
    return faderToGain(db);
  }

  /** Whether a strip sounds under the current mute/solo state — the exact rule
   *  applyMute drives the live graph with. */
  isChannelAudible(name: ChannelName): boolean {
    const c = this.channels.get(name);
    if (!c) return false;
    const anySolo = [...this.channels.values()].some(s => s.soloed);
    return !(c.muted || (anySolo && !c.soloed));
  }

  /** Render `sourceBuffer` through a strip's insert FX chain + fader in an
   *  OfflineAudioContext, so the live mixer colour can be BAKED into exports.
   *  No FX + unity fader → the source is returned unchanged. A reverb/delay/
   *  vinyl tail is appended so the effect doesn't get cut off. */
  async renderWithMixerFX(sourceBuffer: AudioBuffer, channelName: string, onProgress?: () => void): Promise<AudioBuffer> {
    const strip = channelName === 'master' ? this.master : this.channels.get(channelName as ChannelName);
    if (!strip) { onProgress?.(); return trimLeadingSilence(sourceBuffer); }

    const serializedFX = strip.serializeFXChain();
    const faderGain = strip.getFaderLinear();
    const anyFx = serializedFX.some(f => !f.bypassed);
    // Nothing to bake → pass through (still trim any leading silence from the
    // chop slice so the one-shot starts tight).
    if (!anyFx && faderGain === 1 && !this.console.on) { onProgress?.(); return trimLeadingSilence(sourceBuffer); }

    // Tail estimate for time-based effects so their decay isn't truncated.
    const tailSec = MixerEngine.fxTailSec(serializedFX);

    const sr = sourceBuffer.sampleRate;
    const renderLength = sourceBuffer.length + Math.ceil(tailSec * sr);
    const offline = new OfflineAudioContext(2, Math.max(1, renderLength), sr);

    const src = offline.createBufferSource();
    src.buffer = sourceBuffer;
    const chain = buildOfflineFXChain(offline, serializedFX);
    const fader = offline.createGain();
    fader.gain.value = faderGain;
    // The desk stage sits where it does live: before the inserts.
    const desk = this.offlineConsole(offline, channelName === 'master' ? 'bus' : 'channel', channelName);
    if (desk) { src.connect(desk.input); desk.output.connect(chain.input); }
    else src.connect(chain.input);
    chain.output.connect(fader);
    fader.connect(offline.destination);
    src.start(0);

    await chain.ready;
    await desk?.ready;
    const rendered = await offline.startRendering();
    chain.dispose(); desk?.dispose();
    onProgress?.();
    return trimLeadingSilence(rendered);
  }

  // ── full-arrangement offline rendering (DAW-style export) ────────────────
  // The unified export pipeline decomposes the live graph linearly:
  //   channel post  = dry source → insert FX → fader → pan        (= trackout stem)
  //   send return   = Σ(channel post × send gain) → send strip    (= send stem)
  //   master        = Σ(all posts) → master FX → fader → limiter  (= mixdown)
  // Each helper renders ONE strip in its own OfflineAudioContext at full song
  // length — no leading-silence trim (arrangement timing must stay aligned).

  /** `sourceBuffer` (the strip's live input signal over the whole song) through
   *  this channel's insert FX + fader + pan. Mute/solo is the CALLER's job
   *  (skip inaudible channels via isChannelAudible). */
  async renderChannelPostOffline(
    sourceBuffer: AudioBuffer, channelName: ChannelName, lengthSec: number,
    /** Dry source buffers of the OTHER channels (same length/rate) — the keys
     *  any SC COMP on this strip listens to. Absent = no ducking. */
    keySources?: Partial<Record<ChannelName, AudioBuffer>>,
  ): Promise<AudioBuffer> {
    const strip = this.channels.get(channelName);
    if (!strip) return sourceBuffer;
    return this.renderStripOffline([{ buffer: sourceBuffer, gain: 1 }],
      strip.serializeFXChain(), strip.getFaderLinear(), strip.pan, lengthSec, sourceBuffer.sampleRate,
      this.pdcChainDelaySec(channelName), keySources, channelName);
  }

  /** A send/aux return: the listed channel posts, each scaled by its live send
   *  level, mixed into the send strip's FX + fader + pan. 100% wet by the send
   *  convention (wet params are locked to 100 on send strips). */
  async renderSendReturnOffline(
    inputs: Array<{ buffer: AudioBuffer; gain: number }>,
    sendName: ChannelName,
    lengthSec: number,
    sampleRate: number,
  ): Promise<AudioBuffer> {
    const strip = this.channels.get(sendName)!;
    return this.renderStripOffline(inputs, strip.serializeFXChain(), strip.getFaderLinear(), strip.pan, lengthSec, sampleRate,
      this.pdcChainDelaySec(sendName), undefined, sendName);
  }

  /** The master bus: every post buffer summed through the master strip's insert
   *  FX + fader + the same −1 dBFS/20:1 brickwall the live MasterStrip runs. */
  async renderMasterBusOffline(inputs: AudioBuffer[], lengthSec: number, sampleRate: number): Promise<AudioBuffer> {
    const len = Math.max(1, Math.ceil(lengthSec * sampleRate));
    // The brickwall is a DynamicsCompressor with ~6 ms of look-ahead, so the
    // master used to land that many frames AFTER the stems (which have no
    // limiter). Render the extra frames and drop them from the head so master
    // and stems line up sample-for-sample.
    const latFrames = Math.round((await compressorLatencySec(sampleRate)) * sampleRate);
    const offline = new OfflineAudioContext(2, len + latFrames, sampleRate);
    const chain = buildOfflineFXChain(offline, this.master.serializeFXChain());
    const fader = offline.createGain();
    fader.gain.value = this.master.getFaderLinear();
    const limiter = offline.createDynamicsCompressor();
    limiter.threshold.value = -1; limiter.knee.value = 0;
    limiter.ratio.value = 20; limiter.attack.value = 0.001; limiter.release.value = 0.05;
    chain.output.connect(fader);
    fader.connect(limiter);
    limiter.connect(offline.destination);
    // CONSOLE bus stage: the sum passes through the desk's summing glue before
    // the master inserts, exactly as live.
    const desk = this.offlineConsole(offline, 'bus', 'master');
    const sumIn: AudioNode = desk ? desk.input : chain.input;
    if (desk) desk.output.connect(chain.input);
    for (const buf of inputs) {
      const src = offline.createBufferSource();
      src.buffer = buf;
      src.connect(sumIn);
      src.start(0);
    }
    await chain.ready;
    await desk?.ready;
    const rendered = await offline.startRendering();
    chain.dispose(); desk?.dispose();
    if (latFrames <= 0) return rendered;
    const aligned = new AudioBuffer({ numberOfChannels: 2, length: len, sampleRate });
    for (let c = 0; c < 2; c++) aligned.copyToChannel(rendered.getChannelData(c).subarray(latFrames, latFrames + len), c);
    return aligned;
  }

  private async renderStripOffline(
    inputs: Array<{ buffer: AudioBuffer; gain: number }>,
    serializedFX: SerializedFX[],
    faderGain: number,
    pan: number,
    lengthSec: number,
    sampleRate: number,
    pdcSec = 0,
    keySources?: Partial<Record<ChannelName, AudioBuffer>>,
    /** Strip name — seeds the CONSOLE channel stage (when CONSOLE is on). */
    consoleName?: ChannelName,
  ): Promise<AudioBuffer> {
    const len = Math.max(1, Math.ceil(lengthSec * sampleRate));
    const offline = new OfflineAudioContext(2, len, sampleRate);
    const chain = buildOfflineFXChain(offline, serializedFX);
    // The desk's channel stage sits before the inserts, as live. Sources feed
    // `stripIn`; it is the stage when CONSOLE is on, else the chain directly.
    const desk = consoleName ? this.offlineConsole(offline, 'channel', consoleName) : null;
    const stripIn: AudioNode = desk ? desk.input : chain.input;
    if (desk) desk.output.connect(chain.input);
    const fader = offline.createGain();
    fader.gain.value = faderGain;
    const panner = offline.createStereoPanner();
    panner.pan.value = clamp(pan, -1, 1);
    // Same PDC delay the live strip carries, so stems line up with each other
    // (and with what you heard) sample-for-sample.
    const pdc = offline.createDelay(0.25);
    pdc.delayTime.value = clamp(pdcSec, 0, 0.25);
    chain.output.connect(pdc);
    pdc.connect(fader);
    fader.connect(panner);
    panner.connect(offline.destination);
    // Sidechain keys: feed each SC COMP the dry source of the strip it names.
    for (const fx of chain.fx) {
      if (!fx.sidechainInput) continue;
      const key = keySources?.[String(fx.params.SOURCE ?? 'NONE')];
      if (!key) continue;
      const ks = offline.createBufferSource();
      ks.buffer = key;
      ks.connect(fx.sidechainInput);
      ks.start(0);
    }
    for (const inp of inputs) {
      if (inp.gain <= 0) continue;
      const src = offline.createBufferSource();
      src.buffer = inp.buffer;
      const g = offline.createGain();
      g.gain.value = inp.gain;
      src.connect(g);
      g.connect(stripIn);
      src.start(0);
    }
    await chain.ready;
    await desk?.ready;
    const rendered = await offline.startRendering();
    chain.dispose(); desk?.dispose();
    return rendered;
  }

  connectToDestination(): void {
    if (this.connected) return;
    this.master.connectToDestination();
    this.connected = true;
  }

  /** Recompute every strip's effective mute from the current solo state. */
  applySolo(): void {
    const anySolo = [...this.channels.values()].some(c => c.soloed);
    for (const c of this.channels.values()) c.applyMute(anySolo);
  }

  /** Solo a single channel exclusively (Alt+click) — un-solos all others. */
  soloExclusive(name: ChannelName): void {
    for (const [n, c] of this.channels) c.setSoloed(n === name ? !c.soloed : false);
    this.applySolo();
  }

  serialize(): MixerPreset {
    const channels: Partial<Record<ChannelName, ChannelPreset>> = {};
    for (const [name, c] of this.channels) channels[name] = c.serialize();
    return { channels, master: this.master.serialize(), console: { ...this.console } };
  }
  restore(p: MixerPreset): void {
    if (!p) return;
    // Strips the project knows that this session doesn't have yet (a source
    // strip 'sampleN', a user drum lane) are created so their settings land;
    // the view's route/lane sync wires and labels them right after.
    for (const name of Object.keys(p.channels ?? {})) {
      if (this.channels.has(name) || SEND_CHANNELS.includes(name)) continue;
      if (/^sample\d+$/.test(name)) { const last = REGULAR_CHANNELS.filter(n => /^sample\d*$/.test(n)).pop() ?? 'sample'; this.addChannel(name, { after: last }); }
    }
    for (const [name, c] of this.channels) { if (p.channels?.[name]) c.restore(p.channels[name]!); }
    if (p.master) this.master.restore(p.master);
    if (p.console) this.setConsole(normalizeConsole(p.console));
    this.applySolo();
  }

  dispose(): void {
    for (const c of this.channels.values()) c.dispose();
    this.master.setConsole({ ...this.console, on: false });
  }
}

export type { ChannelStrip, MasterStrip };
