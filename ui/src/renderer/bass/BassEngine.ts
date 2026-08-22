// BASS ENGINE — the third peer engine next to ChopperEngine (chops) and
// DrumEngine (drums). Owns the bass-synth AudioWorklet (voice/DSP lives in
// public/worklets/bass-synth-worklet.js), the PATCH (a Model-D-shaped synth),
// the note PATTERNS the piano roll edits, the KEY/SCALE lock, a look-ahead
// scheduler that runs off the same ctx anchor as the drum loop (started by the
// chopper's transport hook), live MIDI/keyboard note input with optional
// scale-locked recording into the pattern, and the OFFLINE render every export
// uses (same worklet file, same patch, sample-accurate note times).
//
// Time inside a pattern is BEATS (float, quantised by the roll's grid at edit
// time). Scheduling walks a 96-PPQ tick map exactly like the drum engine walks
// its 1/32 steps — incremental `nextTickTime += tickDur` so BPM changes and
// live edits apply on the next tick with no re-anchor.

import { KeyLock, snapToScale, ScaleId, scaleDef, mpcPadNote } from './theory.mts';
import { startClock, LookAhead, type ClockHandle } from '../lib/audioClock';

export const PPQ = 96;
export const BASS_LOW = 24;   // C1 — the roll's floor
export const BASS_HIGH = 72;  // C5 — the roll's ceiling (bass lives well below)
export const BASS_MAX_PATTERNS = 16;

export type OscWave = 'tri' | 'shark' | 'saw' | 'square' | 'pulse' | 'narrow' | 'sine' | 'morph';
/** SHAPE morph order — full-left TRIANGLE … full-right SINE (see the worklet). */
export const MORPH_ORDER: OscWave[] = ['tri', 'shark', 'saw', 'square', 'pulse', 'narrow', 'sine'];
export type FilterModel = 'ladder' | 'ota' | 'diode';
export type LfoWave = 'tri' | 'square' | 'saw' | 'ramp' | 'sine' | 'sh';
export type ModSource = 'lfo1' | 'lfo2' | 'lfo3' | 'trigA' | 'trigB';
export const MOD_SOURCES: Array<{ id: ModSource; label: string }> = [
  { id: 'lfo1', label: 'LFO 1' }, { id: 'lfo2', label: 'LFO 2' }, { id: 'lfo3', label: 'LFO 3' },
  { id: 'trigA', label: 'TRIG A' }, { id: 'trigB', label: 'TRIG B' },
];
export interface ModLfo { rate: number; wave: LfoWave; key: boolean }
export interface ModTrig { ramp: number; fall: number; shape: 'exp' | 'lin' }
/** One matrix entry: source → knob path (e.g. 'filter.cutoff'), depth -1..1. */
export interface ModAssign { src: ModSource; target: string; depth: number }

export interface OscPatch { on: boolean; wave: OscWave; octave: number; semi: number; fine: number; level: number; pw: number; /** SHAPE knob position (0 = tri … 1 = sine) used when wave === 'morph'; optional so factory/old presets fill from the default */ morph?: number }
export interface EnvPatch { a: number; d: number; s: number; r: number }
export interface BassPatch {
  osc: [OscPatch, OscPatch, OscPatch];
  sub: { level: number; wave: 'sine' | 'square'; octave: 1 | 2 };
  noise: { level: number; color: 'white' | 'pink' };
  mixerDrive: number;
  filter: { model: FilterModel; mode: 'lp' | 'bp' | 'hp'; cutoff: number; reso: number; envAmt: number; kbd: number; poles: number; drive: number };
  filtEnv: EnvPatch;
  ampEnv: EnvPatch;
  /** Legacy single LFO (pre-MOD-matrix patches). The engine still honours it;
   *  the UI no longer shows it. */
  lfo: { rate: number; wave: LfoWave; toCutoff: number; toPitch: number };
  /** MOD sources: three free LFOs (KEY = restart on every note) and two
   *  trigger envelopes that fire on every note-on — RAMP up, then FALL back. */
  modSrc: { lfo: [ModLfo, ModLfo, ModLfo]; trig: [ModTrig, ModTrig] };
  /** The matrix — any knob can take several sources, each with its own depth. */
  mods: ModAssign[];
  glide: number;
  legato: boolean;
  voices: number;
  drift: number;
  velAmp: number;
  velFilt: number;
  post: { drive: number; tone: number; glue: number; gain: number };
}

/** `slide` = an FL-style SLIDE note: it triggers nothing — whatever is sounding
 *  when it starts bends to its pitch over its length and stays there. */
export interface BassNote { id: number; note: number; start: number; dur: number; vel: number; slide?: boolean }
/** One breakpoint of the PITCH BEND lane: semitones at a beat. Linear
 *  between points; flat before the first and after the last. */
export interface BendPoint { beat: number; semis: number }
export interface BassPattern { bars: number; notes: BassNote[]; bend?: BendPoint[] }

/** Bend (semitones) of a lane at `beat` — linear interpolation. */
export function bendAt(points: BendPoint[] | undefined, beat: number): number {
  if (!points || !points.length) return 0;
  if (beat <= points[0].beat) return points[0].semis;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], b = points[i];
    if (beat <= b.beat) { const t = b.beat > a.beat ? (beat - a.beat) / (b.beat - a.beat) : 1; return a.semis + (b.semis - a.semis) * t; }
  }
  return points[points.length - 1].semis;
}
/** Sample a lane over `sectionBeats` (the pattern loop tiled) into a sparse
 *  list of (beat, semis) that reproduces it when played as stepwise-linear
 *  bends at `perBeat` points per beat — the export/arranger form. Emits a point
 *  at every loop start so each repeat re-enters the lane where it begins. */
export function sampleBend(points: BendPoint[] | undefined, loopBeats: number, sectionBeats: number, perBeat = PPQ): Array<{ beat: number; semis: number }> {
  if (!points || !points.length) return [];
  const out: Array<{ beat: number; semis: number }> = [];
  let last = NaN;
  const step = 1 / perBeat;
  for (let base = 0; base < sectionBeats; base += loopBeats) {
    last = NaN;   // force a point at each loop start
    for (let b = 0; b < loopBeats && base + b < sectionBeats; b += step) {
      const v = bendAt(points, b);
      if (Number.isNaN(last) || Math.abs(v - last) > 0.002) { out.push({ beat: base + b, semis: v }); last = v; }
    }
  }
  return out;
}

export interface BassPreset {
  patch: BassPatch;
  patterns: BassPattern[];
  currentIdx: number;
  key: KeyLock;
  lock: boolean;
  grid: number;          // grid divisions per BEAT (1 = 1/4, 2 = 1/8, 4 = 1/16, 3 = 1/8T, 6 = 1/16T); 0 = OFF (no snap, no record quantise)
  presetName?: string;
  /** BEND lane range in semitones (2 or 12) — drawing + the wheel both use it. */
  bendRange?: number;
}

export interface BassState extends BassPreset {
  playing: boolean;
  playingIdx: number;
  recording: boolean;
  midiIn: boolean;       // MIDI notes steer the bass (instead of the pads)
  ready: boolean;
  level: number;         // output meter 0..1+
  voicesOn: number;
}

export function defaultBassPatch(): BassPatch {
  return {
    osc: [
      { on: true, wave: 'saw', octave: 0, semi: 0, fine: 0, level: 0.8, pw: 0.5, morph: 0.33 },
      { on: true, wave: 'square', octave: 0, semi: 0, fine: 7, level: 0.55, pw: 0.5, morph: 0.5 },
      { on: false, wave: 'saw', octave: -1, semi: 0, fine: -5, level: 0.4, pw: 0.5, morph: 0.33 },
    ],
    sub: { level: 0.5, wave: 'sine', octave: 1 },
    noise: { level: 0, color: 'white' },
    mixerDrive: 0.15,
    filter: { model: 'ladder', mode: 'lp', cutoff: 420, reso: 0.25, envAmt: 0.45, kbd: 0.3, poles: 4, drive: 0.2 },
    filtEnv: { a: 0.003, d: 0.28, s: 0.15, r: 0.2 },
    ampEnv: { a: 0.004, d: 0.3, s: 0.85, r: 0.12 },
    lfo: { rate: 4.5, wave: 'tri', toCutoff: 0, toPitch: 0 },
    modSrc: {
      lfo: [
        { rate: 4.5, wave: 'tri', key: false },
        { rate: 0.5, wave: 'sine', key: false },
        { rate: 8, wave: 'sh', key: true },
      ],
      trig: [
        { ramp: 0.005, fall: 0.35, shape: 'exp' },
        { ramp: 0.12, fall: 0.6, shape: 'exp' },
      ],
    },
    mods: [],
    glide: 0.04,
    legato: true,
    voices: 1,
    drift: 0.35,
    velAmp: 0.5,
    velFilt: 0.4,
    post: { drive: 0.15, tone: 20000, glue: 0.2, gain: 0.8 },
  };
}

/** Factory patches — every one built to sit under a beat. Names are the vibe. */
export const BASS_FACTORY: Array<{ name: string; patch: Partial<BassPatch> }> = [
  { name: 'MODEL D', patch: {} },
  { name: 'FAT SUB', patch: {
    osc: [{ on: true, wave: 'sine', octave: 0, semi: 0, fine: 0, level: 0.9, pw: 0.5 }, { on: true, wave: 'tri', octave: 0, semi: 0, fine: 3, level: 0.35, pw: 0.5 }, { on: false, wave: 'saw', octave: -1, semi: 0, fine: 0, level: 0.3, pw: 0.5 }],
    sub: { level: 0.7, wave: 'sine', octave: 1 }, mixerDrive: 0.3,
    filter: { model: 'ladder', mode: 'lp', cutoff: 180, reso: 0.1, envAmt: 0.25, kbd: 0.2, poles: 4, drive: 0.1 },
    filtEnv: { a: 0.002, d: 0.18, s: 0.3, r: 0.2 }, ampEnv: { a: 0.006, d: 0.4, s: 0.9, r: 0.18 },
    post: { drive: 0.25, tone: 6000, glue: 0.35, gain: 0.85 }, drift: 0.2,
  } },
  { name: 'REESE', patch: {
    osc: [{ on: true, wave: 'saw', octave: 0, semi: 0, fine: -12, level: 0.7, pw: 0.5 }, { on: true, wave: 'saw', octave: 0, semi: 0, fine: 12, level: 0.7, pw: 0.5 }, { on: true, wave: 'saw', octave: -1, semi: 0, fine: 0, level: 0.5, pw: 0.5 }],
    sub: { level: 0.3, wave: 'sine', octave: 1 }, mixerDrive: 0.4,
    filter: { model: 'ladder', mode: 'lp', cutoff: 520, reso: 0.2, envAmt: 0.1, kbd: 0.4, poles: 4, drive: 0.4 },
    filtEnv: { a: 0.01, d: 0.5, s: 0.7, r: 0.3 }, ampEnv: { a: 0.01, d: 0.3, s: 1, r: 0.25 },
    post: { drive: 0.35, tone: 20000, glue: 0.3, gain: 0.7 }, drift: 0.5, glide: 0.08,
  } },
  { name: 'ACID', patch: {
    osc: [{ on: true, wave: 'saw', octave: 0, semi: 0, fine: 0, level: 0.9, pw: 0.5 }, { on: false, wave: 'square', octave: 0, semi: 0, fine: 0, level: 0.5, pw: 0.5 }, { on: false, wave: 'saw', octave: -1, semi: 0, fine: 0, level: 0.3, pw: 0.5 }],
    sub: { level: 0, wave: 'sine', octave: 1 }, mixerDrive: 0.1,
    filter: { model: 'diode', mode: 'lp', cutoff: 300, reso: 0.72, envAmt: 0.6, kbd: 0.1, poles: 4, drive: 0.5 },
    filtEnv: { a: 0.001, d: 0.22, s: 0.05, r: 0.15 }, ampEnv: { a: 0.002, d: 0.25, s: 0.7, r: 0.08 },
    post: { drive: 0.4, tone: 20000, glue: 0.2, gain: 0.75 }, drift: 0.2, glide: 0.06, legato: true,
  } },
  { name: 'MOOG PLUCK', patch: {
    osc: [{ on: true, wave: 'square', octave: 0, semi: 0, fine: 0, level: 0.75, pw: 0.5 }, { on: true, wave: 'saw', octave: 0, semi: 0, fine: 5, level: 0.6, pw: 0.5 }, { on: true, wave: 'pulse', octave: -1, semi: 0, fine: -4, level: 0.45, pw: 0.5 }],
    sub: { level: 0.25, wave: 'sine', octave: 1 }, mixerDrive: 0.25,
    filter: { model: 'ladder', mode: 'lp', cutoff: 260, reso: 0.35, envAmt: 0.7, kbd: 0.3, poles: 4, drive: 0.3 },
    filtEnv: { a: 0.001, d: 0.16, s: 0.0, r: 0.12 }, ampEnv: { a: 0.002, d: 0.35, s: 0.55, r: 0.1 },
    post: { drive: 0.2, tone: 20000, glue: 0.25, gain: 0.8 }, drift: 0.4,
  } },
  { name: 'SEM WARM', patch: {
    osc: [{ on: true, wave: 'shark', octave: 0, semi: 0, fine: 0, level: 0.8, pw: 0.5 }, { on: true, wave: 'tri', octave: -1, semi: 0, fine: 4, level: 0.5, pw: 0.5 }, { on: false, wave: 'saw', octave: 0, semi: 0, fine: 0, level: 0.3, pw: 0.5 }],
    sub: { level: 0.4, wave: 'sine', octave: 1 }, mixerDrive: 0.2,
    filter: { model: 'ota', mode: 'lp', cutoff: 380, reso: 0.3, envAmt: 0.35, kbd: 0.4, poles: 4, drive: 0.2 },
    filtEnv: { a: 0.004, d: 0.3, s: 0.25, r: 0.2 }, ampEnv: { a: 0.006, d: 0.3, s: 0.85, r: 0.15 },
    post: { drive: 0.15, tone: 12000, glue: 0.3, gain: 0.85 }, drift: 0.3,
  } },
  { name: 'GROWL', patch: {
    osc: [{ on: true, wave: 'saw', octave: 0, semi: 0, fine: 0, level: 0.8, pw: 0.5 }, { on: true, wave: 'square', octave: 0, semi: 7, fine: 0, level: 0.5, pw: 0.5 }, { on: true, wave: 'narrow', octave: -1, semi: 0, fine: 9, level: 0.5, pw: 0.12 }],
    sub: { level: 0.35, wave: 'square', octave: 1 }, noise: { level: 0.03, color: 'pink' }, mixerDrive: 0.6,
    filter: { model: 'ladder', mode: 'lp', cutoff: 700, reso: 0.45, envAmt: 0.3, kbd: 0.3, poles: 4, drive: 0.7 },
    filtEnv: { a: 0.01, d: 0.4, s: 0.4, r: 0.2 }, ampEnv: { a: 0.005, d: 0.3, s: 0.9, r: 0.15 },
    modSrc: { lfo: [{ rate: 5.5, wave: 'tri', key: false }, { rate: 0.5, wave: 'sine', key: false }, { rate: 8, wave: 'sh', key: true }], trig: [{ ramp: 0.005, fall: 0.35, shape: 'exp' }, { ramp: 0.12, fall: 0.6, shape: 'exp' }] },
    mods: [{ src: 'lfo1', target: 'filter.cutoff', depth: 0.12 }],
    post: { drive: 0.55, tone: 9000, glue: 0.4, gain: 0.7 }, drift: 0.4,
  } },
  { name: '808 SINE', patch: {
    osc: [{ on: true, wave: 'sine', octave: 0, semi: 0, fine: 0, level: 1, pw: 0.5 }, { on: false, wave: 'square', octave: 0, semi: 0, fine: 0, level: 0.5, pw: 0.5 }, { on: false, wave: 'saw', octave: 0, semi: 0, fine: 0, level: 0.3, pw: 0.5 }],
    sub: { level: 0, wave: 'sine', octave: 1 }, mixerDrive: 0.5,
    filter: { model: 'ladder', mode: 'lp', cutoff: 900, reso: 0.0, envAmt: 0.6, kbd: 0.5, poles: 2, drive: 0.2 },
    filtEnv: { a: 0.001, d: 0.06, s: 0.0, r: 0.1 }, ampEnv: { a: 0.002, d: 1.2, s: 0.0, r: 0.3 },
    post: { drive: 0.45, tone: 4000, glue: 0.3, gain: 0.9 }, drift: 0.05, glide: 0.09, legato: true, velAmp: 0.3, velFilt: 0.6,
  } },
];

type Listener = (s: BassState) => void;

// One worklet module load per BaseAudioContext (live ctx + every offline ctx).
const moduleLoads = new WeakMap<BaseAudioContext, Promise<void>>();
export function loadBassModule(ctx: BaseAudioContext): Promise<void> {
  let p = moduleLoads.get(ctx);
  if (!p) {
    p = ctx.audioWorklet.addModule('./worklets/bass-synth-worklet.js');
    moduleLoads.set(ctx, p);
  }
  return p;
}

function deepMerge<T>(base: T, over: any): T {
  if (!over || typeof over !== 'object') return base;
  const out: any = Array.isArray(base) ? [...(base as any)] : { ...(base as any) };
  for (const k of Object.keys(over)) {
    const v = over[k];
    if (Array.isArray(v)) out[k] = v.map((item, i) => (item && typeof item === 'object' && !Array.isArray(item)) ? deepMerge(out[k]?.[i] ?? {}, item) : item);
    else if (v && typeof v === 'object') out[k] = deepMerge(out[k] ?? {}, v);
    else if (v !== undefined) out[k] = v;
  }
  return out;
}

export interface BassRenderNote { time: number; note: number; vel: number; dur: number; slide?: boolean }
/** A timed pitch bend for the arranger / exports (absolute seconds). */
export interface BassRenderBend { time: number; semis: number }

/** Offline render of absolute-time notes through the same worklet + patch —
 *  the export path. Standalone so renderArrangementDAW can call it without an
 *  engine instance. */
export async function renderBassOffline(patch: BassPatch, notes: BassRenderNote[], lengthSec: number, sampleRate: number, bends: BassRenderBend[] = []): Promise<AudioBuffer> {
  const len = Math.max(1, Math.ceil(lengthSec * sampleRate));
  const off = new OfflineAudioContext(2, len, sampleRate);
  await loadBassModule(off);
  const node = new AudioWorkletNode(off, 'bass-synth', { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2] });
  node.connect(off.destination);
  node.port.postMessage({ type: 'patch', patch });
  const list: any[] = [];
  for (const n of notes) {
    if (n.slide) { list.push({ on: true, slide: true, note: n.note, dur: Math.max(0.005, n.dur), at: Math.max(0.0001, n.time), tag: 'x' }); continue; }
    list.push({ on: true, note: n.note, vel: n.vel, at: Math.max(0.0001, n.time), tag: 'x' });
    list.push({ on: false, note: n.note, at: Math.max(0.0002, n.time + Math.max(0.005, n.dur)), tag: 'x' });
  }
  node.port.postMessage({ type: 'notes', list });
  if (bends.length) node.port.postMessage({ type: 'bends', list: bends.map((b) => ({ semis: b.semis, at: Math.max(0.0001, b.time), tag: 'x' })) });
  return off.startRendering();
}

export class BassEngine {
  readonly ctx: AudioContext;
  readonly outputNode: GainNode;
  readonly ready: Promise<void>;
  private node: AudioWorkletNode | null = null;
  private getBpm: () => number;
  private listeners = new Set<Listener>();
  private nextId = 1;

  private patch: BassPatch = defaultBassPatch();
  private patterns: BassPattern[] = [{ bars: 2, notes: [] }];
  private currentIdx = 0;
  private playingIdx = 0;
  private key: KeyLock = { root: 0, scale: 'minor' };
  private lock = true;
  private grid = 4;
  private bendRange = 2;
  private presetName = 'MODEL D';
  private midiIn = false;
  private recording = false;
  private isReady = false;
  private level = 0;
  private voicesOn = 0;

  // scheduler
  private timer: ClockHandle | null = null;
  private startTime = 0;      // ctx time of absolute tick 0
  private nextTick = 0;       // absolute tick to schedule next
  private nextTickTime = 0;   // ctx time of nextTick
  private startClaim = false;
  private readonly look = new LookAhead(0.25, 0.5, 25); // see lib/audioClock — was a fixed 0.12 s
  private readonly INTERVAL = 25;
  private sounding: Array<{ note: number; offAt: number; id: number }> = [];
  // live-recording note starts (note → {tick, vel})
  private recStarts = new Map<number, { tick: number; vel: number; at: number }>();
  private liveHeld = new Set<number>();
  private mutedByArranger = false;

  constructor(ctx: AudioContext, getBpm: () => number) {
    this.ctx = ctx;
    this.getBpm = getBpm;
    this.outputNode = ctx.createGain();
    this.outputNode.gain.value = 1;
    this.ready = loadBassModule(ctx).then(() => {
      const node = new AudioWorkletNode(ctx, 'bass-synth', { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2] });
      node.connect(this.outputNode);
      node.port.onmessage = (e) => {
        const m = e.data;
        if (m && m.type === 'meter') { this.level = m.level; this.voicesOn = m.voices; this.emitMeter(); }
      };
      this.node = node;
      this.isReady = true;
      node.port.postMessage({ type: 'patch', patch: this.patch });
      this.emit();
    }).catch((err) => { console.warn('[bass] worklet failed to load', err); });
  }

  // ── state ──
  getState(): BassState {
    return {
      patch: this.patch, patterns: this.patterns, currentIdx: this.currentIdx, key: this.key, lock: this.lock, grid: this.grid,
      presetName: this.presetName, bendRange: this.bendRange, playing: this.timer !== null, playingIdx: this.playingIdx, recording: this.recording,
      midiIn: this.midiIn, ready: this.isReady, level: this.level, voicesOn: this.voicesOn,
    };
  }
  subscribe(fn: Listener): () => void { this.listeners.add(fn); fn(this.getState()); return () => { this.listeners.delete(fn); }; }
  private emit(): void { const s = this.getState(); for (const l of this.listeners) l(s); }
  // Notes lit on the roll's key column: what the player is HOLDING right now
  // (MIDI / computer keyboard / pads) plus what the sequencer is sounding.
  private liveListeners = new Set<() => void>();
  onLive(fn: () => void): () => void { this.liveListeners.add(fn); return () => { this.liveListeners.delete(fn); }; }
  private emitLive(): void { for (const l of this.liveListeners) l(); }
  /** Held live notes (bright) — MIDI, computer keyboard, pads. */
  heldNotes(): ReadonlySet<number> { return this.liveHeld; }
  /** Notes the sequencer is sounding right now (dim). */
  soundingNotes(): number[] { return this.sounding.map((s) => s.note); }
  private meterListeners = new Set<(level: number, voices: number) => void>();
  onMeter(fn: (level: number, voices: number) => void): () => void { this.meterListeners.add(fn); return () => { this.meterListeners.delete(fn); }; }
  private emitMeter(): void { for (const l of this.meterListeners) l(this.level, this.voicesOn); }

  get currentPattern(): BassPattern { return this.patterns[this.currentIdx] ?? this.patterns[0]; }
  get keyLock(): KeyLock { return this.key; }
  get scaleLocked(): boolean { return this.lock; }
  get playing(): boolean { return this.timer !== null; }

  // ── patch ──
  setPatch(partial: Partial<BassPatch> | any, opts?: { name?: string; replace?: boolean }): void {
    this.patch = opts?.replace ? deepMerge(defaultBassPatch(), partial) : deepMerge(this.patch, partial);
    if (opts?.name) this.presetName = opts.name;
    this.pushPatch();
    this.emit();
  }
  /** Dotted-path set, e.g. setParam('filter.cutoff', 300) / setParam('osc.1.wave', 'saw'). */
  setParam(path: string, value: any): void {
    const parts = path.split('.');
    const next: any = deepMerge(this.patch, {});
    let cur: any = next;
    for (let i = 0; i < parts.length - 1; i++) {
      const k = parts[i];
      const key: any = Array.isArray(cur) ? Number(k) : k;
      cur[key] = Array.isArray(cur[key]) ? [...cur[key]] : { ...cur[key] };
      cur = cur[key];
    }
    const last = parts[parts.length - 1];
    cur[Array.isArray(cur) ? Number(last) : last] = value;
    this.patch = next;
    this.presetName = this.presetName.endsWith('*') ? this.presetName : `${this.presetName}*`;
    this.pushPatch();
    this.emit();
  }
  loadFactory(name: string): void {
    const f = BASS_FACTORY.find((x) => x.name === name);
    if (!f) return;
    this.setPatch(f.patch, { name: f.name, replace: true });
  }
  private pushPatch(): void { this.node?.port.postMessage({ type: 'patch', patch: this.patch }); }
  /** MOD matrix edits. `mods` is replaced wholesale (the worklet's merge does
   *  the same), so the list is always exactly what the UI shows. */
  private setMods(mods: ModAssign[]): void { this.setPatch({ mods }); }
  addMod(src: ModSource, target: string, depth = 0.5): void {
    const mods = this.patch.mods.filter((m) => !(m.src === src && m.target === target));
    mods.push({ src, target, depth: Math.max(-1, Math.min(1, depth)) });
    this.setMods(mods);
  }
  removeMod(src: ModSource, target: string): void { this.setMods(this.patch.mods.filter((m) => !(m.src === src && m.target === target))); }
  setModDepth(src: ModSource, target: string, depth: number): void {
    this.setMods(this.patch.mods.map((m) => (m.src === src && m.target === target) ? { ...m, depth: Math.max(-1, Math.min(1, depth)) } : m));
  }
  modsFor(target: string): ModAssign[] { return this.patch.mods.filter((m) => m.target === target); }

  // ── key / grid / modes ──
  setKey(root: number, scale: ScaleId): void { this.key = { root: ((root % 12) + 12) % 12, scale }; this.emit(); }
  setLock(on: boolean): void { this.lock = on; this.emit(); }
  /** 0 = OFF: notes land where you click / play them, nothing snaps. */
  setGrid(div: number): void { this.grid = div <= 0 ? 0 : Math.max(1, Math.min(12, div)); this.emit(); }
  setMidiIn(on: boolean): void { this.midiIn = on; if (!on) this.releaseAllLive(); this.emit(); }
  setRecording(on: boolean): void { this.recording = on; if (!on) this.recStarts.clear(); this.emit(); }
  /** Snap through the lock if it's on — the one place MIDI/roll input agrees on. */
  quantizeNote(n: number): number { return this.lock ? snapToScale(n, this.key) : n; }

  // ── live notes (MIDI / keyboard / roll audition) ──
  noteOn(note: number, vel = 1, when?: number, opts?: { raw?: boolean }): void {
    if (!this.node) return;
    let n = Math.max(0, Math.min(127, Math.round(note)));
    if (!opts?.raw) n = this.quantizeNote(n);
    const at = when && when > this.ctx.currentTime ? when : 0;
    this.node.port.postMessage({ type: 'note', on: true, note: n, vel: Math.max(0.05, Math.min(1, vel)), at, tag: 'live' });
    this.liveHeld.add(n);
    this.emitLive();
    if (this.recording && this.timer !== null) {
      const t = at || this.ctx.currentTime;
      this.recStarts.set(n, { tick: this.tickAt(t), vel: Math.max(0.05, Math.min(1, vel)), at: t });
    }
  }
  noteOff(note: number, when?: number, opts?: { raw?: boolean }): void {
    if (!this.node) return;
    let n = Math.max(0, Math.min(127, Math.round(note)));
    if (!opts?.raw) n = this.quantizeNote(n);
    const at = when && when > this.ctx.currentTime ? when : 0;
    this.node.port.postMessage({ type: 'note', on: false, note: n, at, tag: 'live' });
    this.liveHeld.delete(n);
    this.emitLive();
    const rec = this.recStarts.get(n);
    if (rec) {
      this.recStarts.delete(n);
      const endTick = this.tickAt(at || this.ctx.currentTime);
      this.commitRecorded(n, rec.tick, endTick, rec.vel);
    }
  }
  // ── pads as a keyboard ──
  // With the LOCK on, the 16 pads are FOLDED to the key: pad 1 = the root (in
  // octave 2), pad 2 = the next scale note, and so on — every pad a different
  // in-key note, no two pads landing on the same pitch (a chromatic layout
  // snapped to the scale would double up on C#→C, D#→D…). Chromatic / lock
  // off = C2 + pad index. The note a pad sounded is remembered so its release
  // finds the same pitch even if the key or lock changed while held.
  private padHeld = new Map<number, number>();
  padNote(idx: number): number {
    const i = Math.max(0, idx | 0);
    if (!this.lock || this.key.scale === 'chromatic') return 36 + i;
    const steps = scaleDef(this.key.scale).steps;
    const base = 36 + this.key.root;              // the root in octave 2
    const oct = Math.floor(i / steps.length);
    return base + oct * 12 + steps[i % steps.length];
  }
  padOn(idx: number, vel = 1): void {
    const n = this.padNote(idx);
    this.padHeld.set(idx, n);
    this.noteOn(n, vel, undefined, { raw: true });
  }
  padOff(idx: number): void {
    const n = this.padHeld.get(idx) ?? this.padNote(idx);
    this.padHeld.delete(idx);
    this.noteOff(n, undefined, { raw: true });
  }
  // ── MPC (pad controller) as the bass keyboard ──
  // An MPC's pads send C1 (36) upward, sixteen per bank. Pad 4 is the ROOT and
  // with the LOCK on every pad is a different note of the key (see
  // mpcPadNote). The note a pad sounded is remembered so its release finds the
  // same pitch even if the key / lock changed while held.
  private mpcHeld = new Map<number, number>();
  mpcNoteOn(midiNote: number, vel = 1, when?: number): void {
    const n = mpcPadNote(midiNote, this.key, this.lock);
    this.mpcHeld.set(midiNote, n);
    this.noteOn(n, vel, when, { raw: true });
  }
  mpcNoteOff(midiNote: number, when?: number): void {
    const n = this.mpcHeld.get(midiNote) ?? mpcPadNote(midiNote, this.key, this.lock);
    this.mpcHeld.delete(midiNote);
    this.noteOff(n, when, { raw: true });
  }
  releaseAllLive(): void {
    if (!this.node) return;
    for (const n of this.liveHeld) this.node.port.postMessage({ type: 'note', on: false, note: n, at: 0, tag: 'live' });
    this.liveHeld.clear();
    this.recStarts.clear();
    this.mpcHeld.clear();
    this.emitLive();
  }
  /** Audition helper for the roll: a short blip. */
  preview(note: number, vel = 0.9, durSec = 0.22): void {
    if (!this.node) return;
    const n = Math.max(0, Math.min(127, Math.round(note)));
    const now = this.ctx.currentTime;
    this.node.port.postMessage({ type: 'notes', list: [
      { on: true, note: n, vel, at: 0, tag: 'prev' },
      { on: false, note: n, at: now + durSec, tag: 'prev' },
    ] });
  }
  panic(): void { this.node?.port.postMessage({ type: 'panic' }); this.liveHeld.clear(); this.recStarts.clear(); this.sounding = []; this.emitLive(); }
  /** The wheel: bends the synth now — and while ● REC runs with the transport,
   *  writes into the BEND lane of the current pattern (the lane plays back
   *  what you did; while recording the wheel drives and the lane stays quiet). */
  setBend(semis: number): void {
    this.node?.port.postMessage({ type: 'bend', semis });
    if (this.recording && this.timer !== null) {
      const loop = this.currentPattern.bars * 4;
      const beat = ((this.tickAt(this.ctx.currentTime) / PPQ) % loop + loop) % loop;
      this.addBendPoint(beat, semis, { silent: true });
      this.bendDirty = true;
    }
  }
  private bendDirty = false;
  setBendRange(r: number): void { this.bendRange = r >= 12 ? 12 : 2; this.emit(); }
  // ── BEND lane edits ──
  /** Put a breakpoint at `beat` (replacing any within a 1/32 beat). */
  addBendPoint(beat: number, semis: number, opts?: { silent?: boolean }): void {
    const pat = this.currentPattern;
    const loop = pat.bars * 4;
    const b = Math.max(0, Math.min(loop, beat));
    const r = this.bendRange;
    const v = Math.max(-r, Math.min(r, semis));
    const pts = (pat.bend ?? []).filter((p) => Math.abs(p.beat - b) > 1 / 32);
    pts.push({ beat: b, semis: v });
    pts.sort((a, c) => a.beat - c.beat);
    pat.bend = pts;
    if (!opts?.silent) this.onPatternEdited(); else this.rebuildTickMap();
  }
  /** Remove breakpoints in [from, to] beats (the eraser). */
  clearBend(from?: number, to?: number): void {
    const pat = this.currentPattern;
    if (from === undefined || to === undefined) { delete pat.bend; this.onPatternEdited(); return; }
    const lo = Math.min(from, to), hi = Math.max(from, to);
    pat.bend = (pat.bend ?? []).filter((p) => p.beat < lo || p.beat > hi);
    if (!pat.bend.length) delete pat.bend;
    this.onPatternEdited();
  }
  /** Replace the whole lane (a drag that redraws a run of points). */
  setBendPoints(points: BendPoint[]): void {
    const pat = this.currentPattern;
    const r = this.bendRange;
    pat.bend = points.map((p) => ({ beat: p.beat, semis: Math.max(-r, Math.min(r, p.semis)) })).sort((a, b) => a.beat - b.beat);
    if (!pat.bend.length) delete pat.bend;
    this.onPatternEdited();
  }
  setMod(v: number): void { this.node?.port.postMessage({ type: 'mod', value: v }); }

  // ── patterns ──
  /** Grid step in beats; 0 when the grid is OFF (no quantise anywhere). */
  private gridBeats(): number { return this.grid > 0 ? 1 / this.grid : 0; }
  private commitRecorded(note: number, startTick: number, endTick: number, vel: number): void {
    const pat = this.currentPattern;
    const loopTicks = pat.bars * 4 * PPQ;
    if (loopTicks <= 0) return;
    const gridTicks = PPQ * this.gridBeats();
    let qStart: number, durTicks: number;
    if (gridTicks > 0) {
      // quantise start to the grid, keep the played length (min one grid step)
      qStart = Math.round(startTick / gridTicks) * gridTicks;
      durTicks = Math.max(gridTicks * 0.5, endTick - startTick);
      durTicks = Math.max(gridTicks, Math.round(durTicks / gridTicks) * gridTicks);
    } else {
      // grid OFF: the take lands exactly where it was played, at tick (1/96 beat) resolution
      qStart = startTick;
      durTicks = Math.max(PPQ / 16, endTick - startTick);
    }
    const start = ((qStart % loopTicks) + loopTicks) % loopTicks;
    this.addNote(note, start / PPQ, Math.min(durTicks / PPQ, pat.bars * 4 - start / PPQ), vel, { raw: true });
  }
  addNote(note: number, start: number, dur: number, vel = 0.9, opts?: { raw?: boolean; slide?: boolean }): BassNote {
    const pat = this.currentPattern;
    const n = opts?.raw ? note : this.quantizeNote(note);
    const loop = pat.bars * 4;
    const s = Math.max(0, Math.min(loop - 0.001, start));
    const d = Math.max(0.05, Math.min(loop - s, dur));
    const slide = !!opts?.slide;
    // no two notes of the same pitch AND kind overlapping: trim/remove what's
    // under it (a slide note may sit on a normal note's pitch — it bends TO it)
    pat.notes = pat.notes.filter((x) => !(x.note === n && !!x.slide === slide && x.start >= s && x.start < s + d));
    for (const x of pat.notes) if (x.note === n && !!x.slide === slide && x.start < s && x.start + x.dur > s) x.dur = s - x.start;
    const nn: BassNote = { id: this.nextId++, note: n, start: s, dur: d, vel: Math.max(0.05, Math.min(1, vel)), ...(slide ? { slide: true } : {}) };
    pat.notes.push(nn);
    pat.notes.sort((a, b) => a.start - b.start || a.note - b.note);
    this.onPatternEdited();
    return nn;
  }
  updateNote(id: number, changes: Partial<Omit<BassNote, 'id'>>): void {
    const pat = this.currentPattern;
    const n = pat.notes.find((x) => x.id === id);
    if (!n) return;
    const loop = pat.bars * 4;
    if (changes.note !== undefined) n.note = Math.max(0, Math.min(127, Math.round(changes.note)));
    if (changes.start !== undefined) n.start = Math.max(0, Math.min(loop - 0.05, changes.start));
    if (changes.dur !== undefined) n.dur = Math.max(0.05, changes.dur);
    if (changes.vel !== undefined) n.vel = Math.max(0.05, Math.min(1, changes.vel));
    if (changes.slide !== undefined) { if (changes.slide) n.slide = true; else delete n.slide; }
    n.dur = Math.min(n.dur, loop - n.start);
    pat.notes.sort((a, b) => a.start - b.start || a.note - b.note);
    this.onPatternEdited();
  }
  /** Batch update (drag of a selection) — one emit. */
  updateNotes(list: Array<{ id: number; changes: Partial<Omit<BassNote, 'id'>> }>): void {
    const pat = this.currentPattern;
    const loop = pat.bars * 4;
    for (const { id, changes } of list) {
      const n = pat.notes.find((x) => x.id === id);
      if (!n) continue;
      if (changes.note !== undefined) n.note = Math.max(0, Math.min(127, Math.round(changes.note)));
      if (changes.start !== undefined) n.start = Math.max(0, Math.min(loop - 0.05, changes.start));
      if (changes.dur !== undefined) n.dur = Math.max(0.05, changes.dur);
      if (changes.vel !== undefined) n.vel = Math.max(0.05, Math.min(1, changes.vel));
      if (changes.slide !== undefined) { if (changes.slide) n.slide = true; else delete n.slide; }
      n.dur = Math.min(n.dur, loop - n.start);
    }
    pat.notes.sort((a, b) => a.start - b.start || a.note - b.note);
    this.onPatternEdited();
  }
  /** Copies of `ids` (same pitch/time/length/slide) — the ALT-drag duplicate.
   *  Returns the new notes so the roll can select + drag them. */
  duplicateNotes(ids: number[]): BassNote[] {
    const pat = this.currentPattern;
    const set = new Set(ids);
    const out: BassNote[] = [];
    for (const x of pat.notes.filter((n) => set.has(n.id))) {
      const nn: BassNote = { ...x, id: this.nextId++ };
      pat.notes.push(nn); out.push(nn);
    }
    pat.notes.sort((a, b) => a.start - b.start || a.note - b.note);
    this.onPatternEdited();
    return out;
  }
  removeNotes(ids: number[]): void {
    const pat = this.currentPattern;
    const set = new Set(ids);
    pat.notes = pat.notes.filter((x) => !set.has(x.id));
    this.onPatternEdited();
  }
  clearPattern(): void { this.currentPattern.notes = []; delete this.currentPattern.bend; this.onPatternEdited(); }
  setBars(bars: number): void {
    const pat = this.currentPattern;
    pat.bars = Math.max(1, Math.min(8, Math.round(bars)));
    const loop = pat.bars * 4;
    pat.notes = pat.notes.filter((n) => n.start < loop);
    for (const n of pat.notes) n.dur = Math.min(n.dur, loop - n.start);
    if (pat.bend) { pat.bend = pat.bend.filter((b) => b.beat <= loop); if (!pat.bend.length) delete pat.bend; }
    this.onPatternEdited();
  }
  /** Snap every note in the current pattern to the key (after changing key/lock). */
  conformToKey(): void {
    for (const n of this.currentPattern.notes) n.note = snapToScale(n.note, this.key);
    this.onPatternEdited();
  }
  transpose(semis: number, ids?: number[]): void {
    const pat = this.currentPattern;
    for (const n of pat.notes) if (!ids || ids.includes(n.id)) n.note = Math.max(0, Math.min(127, n.note + semis));
    this.onPatternEdited();
  }
  setCurrent(idx: number): void {
    if (idx < 0 || idx >= this.patterns.length) return;
    this.currentIdx = idx;
    // Like the drum sequencer: switching the edited pattern also switches what
    // plays (the arranger drives playback separately when it's in charge).
    if (!this.mutedByArranger) this.playingIdx = idx;
    this.rebuildTickMap();
    this.emit();
  }
  addPattern(dup = false): void {
    if (this.patterns.length >= BASS_MAX_PATTERNS) return;
    const src = this.currentPattern;
    const p: BassPattern = dup
      ? { bars: src.bars, notes: src.notes.map((n) => ({ ...n, id: this.nextId++ })), ...(src.bend?.length ? { bend: src.bend.map((b) => ({ ...b })) } : {}) }
      : { bars: src.bars, notes: [] };
    this.patterns.push(p);
    this.setCurrent(this.patterns.length - 1);
  }
  deletePattern(idx: number): void {
    if (this.patterns.length <= 1) return;
    this.patterns.splice(idx, 1);
    this.currentIdx = Math.min(this.currentIdx, this.patterns.length - 1);
    this.playingIdx = Math.min(this.playingIdx, this.patterns.length - 1);
    this.rebuildTickMap();
    this.emit();
  }
  private onPatternEdited(): void { this.rebuildTickMap(); this.emit(); }

  // ── scheduler ──
  /** `slideBeats` set = a SLIDE event (bend what's sounding over that many beats; no off). */
  private tickMap = new Map<number, Array<{ on: boolean; note: number; vel: number; id: number; slideBeats?: number }>>();
  private loopTicks = PPQ * 8;
  /** BEND lane sampled per tick (semitones), or null when the lane is empty. */
  private bendTicks: Float32Array | null = null;
  private lastBendSent = NaN;
  private rebuildTickMap(): void {
    const pat = this.patterns[this.playingIdx] ?? this.patterns[0];
    this.loopTicks = Math.max(PPQ, Math.round(pat.bars * 4 * PPQ));
    if (pat.bend && pat.bend.length) {
      const bt = new Float32Array(this.loopTicks);
      for (let t = 0; t < this.loopTicks; t++) bt[t] = bendAt(pat.bend, t / PPQ);
      this.bendTicks = bt;
    } else this.bendTicks = null;
    this.lastBendSent = NaN;
    const map = new Map<number, Array<{ on: boolean; note: number; vel: number; id: number; slideBeats?: number }>>();
    for (const n of pat.notes) {
      const onT = Math.round(n.start * PPQ) % this.loopTicks;
      let offT = Math.round((n.start + n.dur) * PPQ);
      if (offT <= onT) offT = onT + 1;
      const push = (t: number, ev: { on: boolean; note: number; vel: number; id: number; slideBeats?: number }) => {
        const arr = map.get(t); if (arr) arr.push(ev); else map.set(t, [ev]);
      };
      if (n.slide) { push(onT, { on: true, note: n.note, vel: n.vel, id: n.id, slideBeats: n.dur }); continue; }
      push(onT, { on: true, note: n.note, vel: n.vel, id: n.id });
      // an off past the loop end fires at the loop's wrap (the note holds into the repeat)
      push(offT >= this.loopTicks ? offT % this.loopTicks : offT, { on: false, note: n.note, vel: 0, id: n.id });
    }
    this.tickMap = map;
    // Editing while playing (transpose, move, delete, draw): the worklet already
    // holds this pattern's events for the look-ahead window at their OLD
    // pitches, and their note-offs would now be issued at the NEW pitch — the
    // old pitch never gets its off and rings forever (his +8va / -8va stuck
    // note). So: drop the queued 'seq' events (without releasing what sounds),
    // release any sounding note whose pitch changed or whose off vanished, and
    // rewind the scheduler to NOW so the window is refilled from the new map.
    if (this.timer !== null && this.node) {
      const byId = new Map<number, number>();
      for (const n of pat.notes) byId.set(n.id, n.note);
      const still = new Set<number>();
      for (const evs of map.values()) for (const e of evs) if (!e.on) still.add(e.id);
      this.node.port.postMessage({ type: 'clear', tag: 'seq', release: false });
      const keep: typeof this.sounding = [];
      for (const s of this.sounding) {
        const nowNote = byId.get(s.id);
        if (still.has(s.id) && nowNote === s.note) keep.push(s);
        else this.node.port.postMessage({ type: 'note', on: false, note: s.note, at: 0, tag: 'seq' });
      }
      this.sounding = keep;
      // Refill from the current tick (a note that began before now stays
      // sounding — only its future off is re-scheduled; ons already past are not).
      const now = this.ctx.currentTime;
      const t = this.tickAt(now) + 1;
      this.nextTick = t;
      this.nextTickTime = this.startTime + t * this.tickDur();
    }
  }
  private tickDur(): number { return (60 / Math.max(20, this.getBpm() || 90)) / PPQ; }
  private tickAt(ctxTime: number): number { return Math.round((ctxTime - this.startTime) / this.tickDur()); }
  /** Absolute beat position of the playhead inside the loop (0..bars*4), or -1. */
  getPlayheadBeats(): number {
    if (this.timer === null) return -1;
    const ticks = (this.ctx.currentTime - this.startTime) / this.tickDur();
    if (ticks < 0) return -1;
    return (ticks % this.loopTicks) / PPQ;
  }
  /** Start phase-locked at `atTime` (the chopper's transport anchor), the loop
   *  positioned at `offsetBeats`. Idempotent while running. */
  async start(atTime?: number, offsetBeats = 0, patternIdx?: number): Promise<void> {
    if (this.timer !== null || this.startClaim) return;
    this.startClaim = true;
    try {
      await this.ready;
      if (this.ctx.state !== 'running') { try { await this.ctx.resume(); } catch { /* gesture */ } }
      if (this.timer !== null) return;
      if (typeof patternIdx === 'number') { this.playingIdx = Math.max(0, Math.min(this.patterns.length - 1, patternIdx)); }
      else if (!this.mutedByArranger) this.playingIdx = this.currentIdx;
      this.rebuildTickMap();
      const now = this.ctx.currentTime;
      const anchor = typeof atTime === 'number' && atTime > now - 0.05 ? atTime : now + 0.02; // 20 ms lead (PLAY feels instant); a transport anchor up to 50 ms old is still honoured
      const offTicks = Math.round(offsetBeats * PPQ);
      this.startTime = anchor - offTicks * this.tickDur();
      this.nextTick = offTicks;
      this.nextTickTime = anchor;
      this.sounding = [];
      this.look.reset();
      this.timer = startClock(() => { this.look.beat(); this.scheduleAhead(); }, this.INTERVAL);
      this.scheduleAhead();
      this.emit();
    } finally { this.startClaim = false; }
  }
  stop(): void {
    if (this.timer !== null) { this.timer.stop(); this.timer = null; }
    this.node?.port.postMessage({ type: 'clear', tag: 'seq', release: true });
    this.node?.port.postMessage({ type: 'bend', semis: 0 });   // a lane never leaves the synth bent
    this.lastBendSent = NaN;
    this.sounding = [];
    this.recStarts.clear();
    if (this.bendDirty) { this.bendDirty = false; this.rebuildTickMap(); }
    this.emit();
  }
  private scheduleAhead(): void {
    if (!this.node) return;
    const horizon = this.ctx.currentTime + this.look.horizon();
    let guard = 0;
    while (this.nextTickTime < horizon && guard++ < 4096) {
      const tick = this.nextTick;
      const inLoop = ((tick % this.loopTicks) + this.loopTicks) % this.loopTicks;
      const evs = this.tickMap.get(inLoop);
      if (evs && evs.length && !this.mutedByArranger) {
        const at = this.nextTickTime;
        // offs first so a retrigger of the same pitch at this tick isn't eaten
        for (const e of evs) if (!e.on) {
          this.node.port.postMessage({ type: 'note', on: false, note: e.note, at, tag: 'seq' });
          this.sounding = this.sounding.filter((s) => s.id !== e.id);
        }
        for (const e of evs) if (e.on) {
          if (e.slideBeats !== undefined) {
            // SLIDE: bend what's sounding; nothing to track in `sounding`
            this.node.port.postMessage({ type: 'note', on: true, slide: true, note: e.note, dur: e.slideBeats * this.tickDur() * PPQ, at: at + 0.0002, tag: 'seq' });
            continue;
          }
          this.node.port.postMessage({ type: 'note', on: true, note: e.note, vel: e.vel, at: at + 0.0002, tag: 'seq' });
          this.sounding.push({ note: e.note, offAt: 0, id: e.id });
        }
      }
      // BEND lane: post the bend for this tick when it moved (the wheel owns
      // the bend while ● REC is armed — the lane is what it will write).
      if (this.bendTicks && !this.mutedByArranger && !this.recording) {
        const b = this.bendTicks[inLoop];
        if (Number.isNaN(this.lastBendSent) || Math.abs(b - this.lastBendSent) > 0.002) {
          this.node.port.postMessage({ type: 'bend', semis: b, at: this.nextTickTime, tag: 'seq' });
          this.lastBendSent = b;
        }
      }
      this.nextTick = tick + 1;
      this.nextTickTime += this.tickDur();
    }
    // prune the sounding list of ids no longer in the pattern (safety)
    if (this.sounding.length > 64) this.sounding = this.sounding.slice(-64);
  }

  // ── arranger drive: play absolute-time notes (Beat Finisher preview) ──
  /** Schedule a whole timeline (absolute ctx times) — used by the arranger
   *  preview. Tag 'arr'; clearTimeline() drops it. */
  playTimeline(notes: BassRenderNote[], bends: BassRenderBend[] = []): void {
    if (!this.node) return;
    if (bends.length) this.node.port.postMessage({ type: 'bends', list: bends.map((b) => ({ semis: b.semis, at: b.time, tag: 'arr' })) });
    const list: any[] = [];
    for (const n of notes) {
      if (n.slide) { list.push({ on: true, slide: true, note: n.note, dur: Math.max(0.005, n.dur), at: n.time, tag: 'arr' }); continue; }
      list.push({ on: true, note: n.note, vel: n.vel, at: n.time, tag: 'arr' });
      list.push({ on: false, note: n.note, at: n.time + Math.max(0.005, n.dur), tag: 'arr' });
    }
    this.node.port.postMessage({ type: 'notes', list });
  }
  clearTimeline(): void { this.node?.port.postMessage({ type: 'clear', tag: 'arr', release: true }); this.node?.port.postMessage({ type: 'bend', semis: 0 }); }
  /** While the arranger drives the bass, the pattern scheduler stays quiet. */
  setArrangerDriven(on: boolean): void { this.mutedByArranger = on; }

  // ── persistence ──
  serialize(): BassPreset {
    return {
      patch: deepMerge(defaultBassPatch(), this.patch),
      patterns: this.patterns.map((p) => ({ bars: p.bars, notes: p.notes.map((n) => ({ ...n })), ...(p.bend && p.bend.length ? { bend: p.bend.map((b) => ({ ...b })) } : {}) })),
      currentIdx: this.currentIdx, key: { ...this.key }, lock: this.lock, grid: this.grid, presetName: this.presetName, bendRange: this.bendRange,
    };
  }
  restore(p: BassPreset | undefined | null): void {
    if (!p) return;
    this.patch = deepMerge(defaultBassPatch(), p.patch || {});
    const pats = Array.isArray(p.patterns) && p.patterns.length ? p.patterns : [{ bars: 2, notes: [] }];
    this.patterns = pats.map((x) => ({
      bars: Math.max(1, Math.min(8, x.bars | 0 || 2)),
      notes: (x.notes || []).map((n) => ({ id: this.nextId++, note: n.note | 0, start: +n.start || 0, dur: Math.max(0.05, +n.dur || 0.25), vel: typeof n.vel === 'number' ? n.vel : 0.9, ...(n.slide ? { slide: true } : {}) })),
      ...(Array.isArray(x.bend) && x.bend.length ? { bend: x.bend.filter((b) => b && Number.isFinite(+b.beat) && Number.isFinite(+b.semis)).map((b) => ({ beat: +b.beat, semis: +b.semis })).sort((a, b) => a.beat - b.beat) } : {}),
    }));
    this.bendRange = p.bendRange === 12 ? 12 : 2;
    this.currentIdx = Math.max(0, Math.min(this.patterns.length - 1, p.currentIdx | 0));
    this.playingIdx = this.currentIdx;
    if (p.key) this.key = { root: ((p.key.root | 0) % 12 + 12) % 12, scale: p.key.scale || 'minor' };
    this.lock = p.lock !== false;
    this.grid = typeof p.grid === 'number' && p.grid >= 0 ? p.grid : 4;   // 0 = OFF is a real value
    this.presetName = p.presetName || 'MODEL D';
    this.pushPatch();
    this.rebuildTickMap();
    this.emit();
  }
  reset(): void { this.stop(); this.restore({ patch: defaultBassPatch(), patterns: [{ bars: 2, notes: [] }], currentIdx: 0, key: { root: 0, scale: 'minor' }, lock: true, grid: 4, presetName: 'MODEL D' }); }

  /** Notes of a pattern laid out over `sectionBars`, looped — for the arranger
   *  (beat offsets within the section). */
  static notesForSection(pat: BassPattern | undefined, sectionBars: number): Array<{ beat: number; note: number; dur: number; vel: number; slide?: boolean }> {
    if (!pat || !pat.notes.length) return [];
    const loopBeats = pat.bars * 4;
    const sectionBeats = sectionBars * 4;
    const out: Array<{ beat: number; note: number; dur: number; vel: number; slide?: boolean }> = [];
    for (let base = 0; base < sectionBeats; base += loopBeats) {
      for (const n of pat.notes) {
        const beat = base + n.start;
        if (beat >= sectionBeats) continue;
        out.push({ beat, note: n.note, dur: Math.min(n.dur, sectionBeats - beat), vel: n.vel, ...(n.slide ? { slide: true } : {}) });
      }
    }
    return out;
  }
  /** The BEND lane of a pattern laid over `sectionBars` (beat offsets within
   *  the section) — companion of notesForSection for the arranger / exports. */
  static bendsForSection(pat: BassPattern | undefined, sectionBars: number): Array<{ beat: number; semis: number }> {
    if (!pat || !pat.bend || !pat.bend.length) return [];
    return sampleBend(pat.bend, pat.bars * 4, sectionBars * 4);
  }
  /** 4 beat-dots for the first bar of a pattern — the Beat Finisher's cell
   *  preview (mirrors the drum rows' beatDots). */
  static beatDots(pat: BassPattern | undefined): string {
    if (!pat) return '····';
    return [0, 1, 2, 3].map((b) => (pat.notes.some((n) => n.start >= b && n.start < b + 1) ? '●' : '·')).join('');
  }
  dispose(): void { this.stop(); try { this.node?.disconnect(); } catch { /* */ } this.listeners.clear(); }
}

/** Which bass pattern a Beat Finisher section plays: its explicit `bassSeq`
 *  (-1 = off), else the historical default — pattern 0 everywhere except intro
 *  sections (arrangements saved before the bass existed carry no field). */
export function bassSeqForSection(sec: { label: string; bassSeq?: number }): number {
  if (typeof sec.bassSeq === 'number') return sec.bassSeq;
  return /intro/i.test(sec.label) ? -1 : 0;
}
