// Build target — flips behavior between Electron desktop (false) and the
// standalone web build (true). Set at module load by Vite's `--mode` flag.
const __isWeb = (import.meta as any).env?.MODE === 'web';

import { Filter } from '../audio/effects/Filter';
import { startClock, LookAhead, type ClockHandle } from '../lib/audioClock';
import { EQ3 } from '../audio/effects/EQ3';
import { Compressor } from '../audio/effects/Compressor';
import { Delay } from '../audio/effects/Delay';
import { Reverb } from '../audio/effects/Reverb';
import { Clipper } from '../audio/effects/Clipper';
import { Waveshaper } from '../audio/effects/Waveshaper';
import { MultibandSaturator } from '../audio/effects/MultibandSaturator';
import { StereoWidener } from '../audio/effects/StereoWidener';
import { MSEQ } from '../audio/effects/MSEQ';
import { BitCrusher } from '../audio/effects/BitCrusher';
import { AutoPan } from '../audio/effects/AutoPan';
import { TranceGate } from '../audio/effects/TranceGate';
import { Chorus } from '../audio/effects/Chorus';
import { encodeWAV, WAVBitDepth } from '../audio/StemExporter';
import { StemName, StemMask, MASK_ALL, STEM_ORDER, normalizeMask, spanReady, addReadyRange, normalizeRanges, ReadyRange } from './stemMask';
import { swingOffsetSec } from '../lib/swing';

/** Per-cell velocity range: never fully silent (a placed note always sounds). */
const clampVel = (v: number): number => (Number.isFinite(v) ? Math.max(0.05, Math.min(1, v)) : 1);
import { TrimRegion, TrimChop, fileToEff, effToFile, addTrimRegion, buildEffectiveBuffer, cutTimes, mapFileRangesToEff, mapTimesFileToEff, sameTrims, cloneTrims, totalTrimmedSec } from './trimRegions';
import { compressorLatencySec, compressorLatencyKnown } from '../audio/compressorLatency';
import { estimateBPMAsync } from './bpmDetect';
import type { DrumPreset } from '../drums/DrumEngine';
import { applyDrumAttack, drumHeadLevel, DRUM_CHOKE_S } from '../drums/DrumEngine';
import type { MixerEngine, MixerPreset } from '../../mixer/MixerEngine';

// Lazy SoundTouch loader. The library is ~40 KB gz and only used by the
// desktop-only STRETCH feature, so we dynamic-import it on first toggle —
// it never enters the web bundle's initial chunk.
let _stretchLib: { SoundTouch: any; SimpleFilter: any; WebAudioBufferSource: any } | null = null;
let _stretchLoading: Promise<void> | null = null;
function loadStretchLib(): Promise<void> {
  if (_stretchLib) return Promise.resolve();
  if (_stretchLoading) return _stretchLoading;
  _stretchLoading = import('soundtouchjs').then((mod: any) => {
    _stretchLib = {
      SoundTouch: mod.SoundTouch,
      SimpleFilter: mod.SimpleFilter,
      WebAudioBufferSource: mod.WebAudioBufferSource,
    };
  });
  return _stretchLoading;
}

const tick = () => new Promise<void>(resolve => setTimeout(resolve, 0));

/** `videoId` of a project saved with NO sample loaded (drums + bass + mixer
 *  only). Loaders skip the audio fetch for it and just restore the engines. */
export const NO_SAMPLE_ID = 'none';

export interface ChopPreset {
  videoId: string;
  savedAt: string;
  name?: string;
  trackTitle?: string;
  chops: Array<{ id: number; start: number; end: number; free?: boolean }>;
  pads: Array<{ index: number; chopId: number | null; mode: string; pitch: number; gate?: boolean; fadeIn?: number; fadeOut?: number; stems?: number; reverse?: boolean }>;
  padBufferMeta?: Record<string, { videoId: string; title: string; start: number; end: number }>;
  /** MIXER ROUTING (2026-08-19): which mixer strip each pad plays through.
   *  `sourceRoutes` = the default strip per SOURCE key ('src:<videoId>' →
   *  'sample2'…); `padRoutes` = per-pad overrides; `nextSampleTrack` keeps the
   *  numbering stable ("SAMPLE 3" stays SAMPLE 3 when 2 is gone). */
  sourceRoutes?: Record<string, string>;
  /** GROUP overrides: pad index → group key (a pad moved into another group, or
   *  a duplicated / user-made group). Absent = the pad's own source is its group. */
  padGroups?: Record<string, string>;
  padRoutes?: Record<string, string>;
  nextSampleTrack?: number;
  /** MUTE GROUPS (2026-08-19): per-pad choke-group overrides. Default = the
   *  pad's source (chops of one sample cut each other, sources don't cut each
   *  other); 'none' = polyphonic; 'grpN' = a custom group. */
  padChoke?: Record<string, string>;
  nextChokeGroup?: number;
  /** Per-source ATTACK / PITCH / REV (pad sources; the main track lives in master/reverseSample). */
  sourceFx?: Record<string, { attack?: number; pitch?: number; fine?: number; reverse?: boolean }>;
  bpm: number;
  nextChopId: number;
  timeline?: Array<{ padIdx: number; time: number; duration: number }>;
  timelineLength?: number;
  seqBars?: number;
  seqResolution?: number;
  seqGrid?: number[][];
  seqLoop?: boolean;
  sequences?: SeqPattern[];
  currentSeqIdx?: number;
  // NORM — non-destructive peak normalize of the loaded sample (−1 dBFS).
  // `normalize` is the toggle; `normalizeGain` is the scalar applied to chopGain.
  normalize?: boolean;
  normalizeGain?: number;
  /** NORM per pad source: `src:<videoId>` → gain. Older builds ignore it. */
  sourceNorm?: Record<string, number>;
  // Master FX chain + extra FX rack — the whole mix/FX state so a reload sounds
  // identical. All optional so older presets (without them) load unchanged.
  master?: ChopperState['master'];
  extraFX?: ChopperState['extraFX'];
  masterClip?: number;      // master soft-clipper drive (0..1)
  stretchEnabled?: boolean; // time-stretch on/off
  targetBpm?: number;       // stretch target tempo
  chopOffsetMs?: number;    // global chop timing offset
  reverseSample?: boolean;  // global reverse toggle
  chopVolume?: number;      // SAMPLE channel level (0..1) — mobile SAMPLE fader; baked into chopGain + exports
  metronomeBpm?: number;    // transport/session tempo (getMasterBpm) — drives the sequencer + drum engine; distinct from the detected `bpm`
  /** INPUT Q (0..100) — the ONE control over how hard live-recorded hits pull
   *  onto the grid, shared by BOTH sequencers (his rule 2026-08-20). Older
   *  projects carry it inside `drums._inputQuantize`; loadPreset migrates. */
  inputQuantize?: number;
  // Full drum-sequencer state (kit, per-track samples, mixer, patterns). Attached
  // by ChopperView since the drum engine lives outside the chopper engine.
  drums?: DrumPreset;
  // Full BASS engine state (synth patch, note patterns, key/scale lock). Attached
  // by ChopperView; optional so older presets load unchanged.
  bass?: import('../bass/BassEngine').BassPreset;
  // Full DAW Mixer state (per-channel fader/pan/mute/solo/sends + insert FX +
  // master). Attached by ChopperView since the mixer engine lives outside the
  // chopper engine. Optional so older presets load unchanged.
  mixer?: MixerPreset;
  /** TRIM — sections cut out of the sample, in the ORIGINAL's time (see
   *  trimRegions.ts). Chops/pads below are in the TRIMMED timeline; loadPreset
   *  re-applies the cuts over the freshly loaded original first. */
  trims?: TrimRegion[];
  /** STEMS (per-pad stem masks over the main track). `assets` point at the
   *  local asset store; `readyRanges` = which spans of those assets are REAL,
   *  in the ORIGINAL's time (a trim cuts them too). Pads carry
   *  their masks in pads[].stems. Older builds ignore this field. */
  stems?: {
    quality: 'fast' | 'fine';
    assets: Partial<Record<StemName, string>>;
    readyRanges: Array<[number, number]>;
  };
  /** STEMS PER SOURCE: the stems of each pad's own sample, keyed by the
   *  videoId its pads carry (padBufferMeta). Same shape as `stems`. Older
   *  builds ignore this field. */
  sourceStems?: Record<string, { quality: 'fast' | 'fine'; assets: Partial<Record<StemName, string>>; readyRanges: Array<[number, number]> }>;
}

/** The stems of one pad SOURCE (a pad's own sample, shared by every pad
 *  chopped from it), keyed by that source's AudioBuffer in sourceStems. Like
 *  the main track's: full-length, the source's own time, partial by design. */
interface StemSet {
  file: Record<StemName, AudioBuffer>;
  ranges: ReadyRange[];
  meta: { quality: 'fast' | 'fine'; assets: Partial<Record<StemName, string>> };
}

interface PadBuffer {
  buffer: AudioBuffer;
  videoId: string;
  title: string;
  start: number;
  end: number;
}

/** What one pad slot holds — its own SOURCE (a per-pad buffer, trimmed) or a
 *  chop of the main track — used by every rearrangement (move / swap / block
 *  move / push-aside / chop-into-next-pads). */
type PadSlot =
  | { kind: 'buffer'; buffer: AudioBuffer; videoId: string; title: string; start: number; end: number; play?: PadPlay; group?: string; stems?: number }
  | { kind: 'chop'; chopId: number; pitch: number; mode: PadMode; play?: PadPlay; group?: string; stems?: number }
  | null;

/** The LOOP crossfade render, pure (see ChopperEngine.loopBufferFor). Input: the
 *  source channels, the region [s0, s0+n) in frames, fade-in / fade-out lengths
 *  in frames. The fades may INTERSECT: fade-in up to the whole region, fade-out
 *  down to the whole region (the loop period, region − fadeOut, keeps a small
 *  floor). Model = overlap-add: pass k starts at k·period, each pass is the
 *  region under env = fadeIn(equal-power sin) × fadeOut(cos). Output =
 *  `[warm-up | periodic]`: the warm-up is the first ceil(n / period) periods
 *  from silence (passes stacking up one by one), the last period is the
 *  steady state — loop that. Seamless: the loop point continues every pass
 *  that is still sounding. No fades = period n, raw copy. */
export const LOOP_MIN_PERIOD_FRAMES = 64;
export function renderCrossfadeLoop(chans: Float32Array[], s0: number, n: number, fadeInFrames: number, fadeOutFrames: number): { frames: Float32Array[]; period: number; loopStart: number } {
  const fi = Math.max(0, Math.min(n, fadeInFrames | 0));
  const fo = Math.max(0, Math.min(Math.max(0, n - LOOP_MIN_PERIOD_FRAMES), fadeOutFrames | 0));
  const period = Math.max(1, n - fo);
  const env = (j: number) => {
    const a = fi > 0 && j < fi ? Math.sin((Math.PI / 2) * (j / fi)) : 1;
    const b = fo > 0 && j >= n - fo ? Math.cos((Math.PI / 2) * ((j - (n - fo)) / fo)) : 1;
    return a * b;
  };
  const M = Math.ceil(n / period);          // passes sounding at once in steady state
  const total = (M + 1) * period;           // warm-up (M periods) + one steady period
  // Power normalisation: crossed fades stack many passes — scale so the
  // steady state carries the power of ONE pass (Σ env² over the stack ≤ 1).
  // Plain equal-power fades already sum to 1, so they are left alone.
  let maxPow = 0;
  for (let i = 0; i < period; i++) {
    let p = 0;
    for (let j = i; j < n; j += period) { const e = env(j); p += e * e; }
    if (p > maxPow) maxPow = p;
  }
  const norm = maxPow > 1 ? 1 / Math.sqrt(maxPow) : 1;
  const frames = chans.map(src => {
    const dst = new Float32Array(total);
    for (let k = 0; k <= M; k++) {          // pass k starts at k·period
      const at = k * period;
      const len = Math.min(n, total - at);
      for (let j = 0; j < len; j++) dst[at + j] += (src[s0 + j] ?? 0) * env(j) * norm;
    }
    return dst;
  });
  return { frames, period, loopStart: M * period };
}

/** How a pad PLAYS its sound — travels with the pad through every rearrangement.
 *  mode 'loop' = round and round between the chop's start and end (a rendered
 *  crossfade loop when fades are set); gate (NOTE ON) = sounds only while the
 *  pad is held; both may be on. fadeIn / fadeOut are seconds inside the chop:
 *  in LOOP mode they are the loop crossfade (the tail fades into the next pass —
 *  a pad / synth out of a sample), in one-shot mode a plain in/out envelope. */
export interface PadPlay { mode: PadMode; gate: boolean; fadeIn: number; fadeOut: number; pitch: number }
const padPlayOf = (p: { mode: PadMode; gate?: boolean; fadeIn?: number; fadeOut?: number; pitch: number }): PadPlay =>
  ({ mode: p.mode, gate: !!p.gate, fadeIn: p.fadeIn ?? 0, fadeOut: p.fadeOut ?? 0, pitch: p.pitch ?? 0 });

/** A resolved pad source for playback/rendering: which buffer, and the region
 *  of it this pad plays. `isPad` = the pad's own source (vs a main-track chop). */
export interface PadSource { buffer: AudioBuffer; start: number; end: number; isPad: boolean }

export type PadMode = 'oneshot' | 'loop';
export type CompressorStyle = 'off' | 'light' | 'punchy' | 'ny' | 'aggressive';
export type MetronomeSound = 'click' | 'hihat' | 'rimshot' | 'kick' | 'clap';

/** How chop boundaries get snapped when the user adjusts or drops them.
 *  - 'off'        : no snap, free placement
 *  - 'transient'  : nearest detected onset (original behaviour, many candidates)
 *  - '1/4'..'1/16': nearest grid line of that subdivision at the detected BPM
 *                   — fewer candidates, locked to the beat. Falls back to
 *                   'transient' if BPM hasn't been detected yet. */
export type SnapMode = 'off' | 'transient' | '1/4' | '1/8' | '1/16';

export interface Chop {
  id: number;
  start: number;
  end: number;
  // `free` chops are NOT part of the contiguous slice chain — they're independent
  // regions (created by pad DUPLICATE via cloneChop). Their boundary drags move
  // only themselves (no shared-boundary coupling), and clearing them never merges
  // a neighbour. Omitted/false for ordinary sliced chops.
  free?: boolean;
}

export interface Pad {
  index: number;
  chopId: number | null;
  mode: PadMode;
  color: string;
  pitch: number; // semitones -24..+24
  gate?: boolean;   // NOTE ON: sounds only while held (release cuts it with the RELEASE fade)
  fadeIn?: number;  // seconds — loop crossfade in (LOOP) / fade-in envelope (one-shot)
  fadeOut?: number; // seconds — loop crossfade out (LOOP) / fade-out envelope (one-shot)
  /** STEM mask (bit 0 drums, 1 bass, 2 other, 3 vocals — see stemMask.ts).
   *  Absent / 0b1111 = the ORIGINAL audio, bit-exact. Only meaningful for
   *  main-track chops after a STEMS split; travels with copy/paste/undo. */
  stems?: StemMask;
  /** PER-PAD REVERSE — overrides the source's REV for THIS pad only, so one
   *  chop can play backwards while its neighbours stay forward (his ask
   *  2026-08-22; per-step reverse used to live in the sequencer's revGrid and
   *  was dropped on 2026-08-18 when REV became a live source-wide state).
   *  undefined = follow the source. Travels with copy/paste/undo/save. */
  reverse?: boolean;
}

export interface SeqPattern {
  bars: number;
  resolution: number;
  grid: number[][];
  // Per-cell reverse flag, aligned positionally with `grid[step][i]`. When the
  // reverse-sample toggle is on at the moment a pad gets placed, that cell is
  // marked true and plays reversed at sequencer playback time. Older presets
  // without this field just play everything forward.
  revGrid?: boolean[][];
  /** Per-cell VELOCITY 0.05..1, aligned with grid[step][i] (absent = 1 — full).
   *  Live record stores the hit's velocity; alt-click a cell cycles it. */
  velGrid?: number[][];
  loop: boolean;
  /** The grid the user is LOOKING at (steps per bar). `resolution` is what the
   *  notes are STORED at — always an integer multiple of this, refit on every
   *  grid change so notes keep their musical time (the grid is a lens, not the
   *  tape). Absent on old presets = same as `resolution`. */
  viewResolution?: number;
}

interface PatternEvent {
  padIdx: number;
  time: number;
  maxDur: number;
  /** Per-cell reverse (the sequencer's revGrid) — read from the mirrored buffer. */
  reverse?: boolean;
  /** Per-cell velocity (the sequencer's velGrid), 1 when absent. */
  velocity?: number;
}

// What an undo step captures. The loaded sample (buffer + its derived caches)
// is captured too so that loading a NEW sample is undoable — Cmd/Ctrl+Z brings
// back the previous sample with its chops. AudioBuffers / typed arrays are
// immutable once built, so we store references (no copies); restore only swaps
// them back when the buffer actually changed, so ordinary chop-edit undos pay
// nothing. The stretch cache is rebuilt lazily, so it's left out.
interface HistorySnapshot {
  chops: Chop[];
  pads: Pad[];
  nextChopId: number;
  sequences: SeqPattern[];
  currentSeqIdx: number;
  bpm: number;
  targetBpm: number;
  // Loaded-sample state (lets undo restore a replaced sample).
  /** The ORIGINAL decoded audio (pre-trim). Effective buffer = buildEffectiveBuffer(buffer, trims). */
  buffer: AudioBuffer | null;
  trims?: TrimRegion[];
  trackTitle: string;
  transients: Float32Array;
  transientStrengths: Float32Array;
  broadbandTransients: Float32Array;
  broadbandStrengths: Float32Array;
  drumTransients: Float32Array;
  drumStrengths: Float32Array;
  reverseBuffer: AudioBuffer | null;
  // SOURCES + BLOCKS state (2026-08-19): every pad's own audio (references —
  // AudioBuffers are immutable) with its trim, and the per-pad / per-source
  // routing, mute-group and waveform settings — so undo/redo covers chopping
  // a source (✂ ×n / HITS), moving blocks, re-routing, resets, all of it.
  padBuffers: Array<[number, PadBuffer]>;
  padRoutes: Array<[number, string]>;
  padChoke: Array<[number, string]>;
  sourceRoutes: Array<[string, string]>;
  padGroups: Array<[number, string]>;
  sourceFx: Array<[string, { attack?: number; pitch?: number; fine?: number; reverse?: boolean }]>;
  nextSampleTrack: number;
  nextChokeGroup: number;
  reverseSample: boolean;
  /** INPUT Q — it rides undo like the SWING fader it moved out of. */
  inputQuantize: number;
  // Full drum-engine state (serialize()) captured alongside the chop state so a
  // single unified stack covers BOTH engines in true chronological order. Null
  // when no drum engine is attached. DrumPreset holds only indices/arrays (no
  // audio buffers), so it's cheap to keep one per snapshot.
  drums: DrumPreset | null;
}

// The slice of DrumEngine the unified history stack drives — snapshot via
// serialize(), restore via restoreForUndo() (a playback-preserving restore).
// Kept structural so ChopperEngine doesn't hard-depend on the DrumEngine class.
interface DrumHistoryTarget {
  serialize(): DrumPreset;
  restoreForUndo(preset: DrumPreset): void;
}

export interface TimelineEvent {
  padIdx: number;
  time: number;
  duration: number;
}

// Golden-angle hue spacing gives distinct colors for any number of pads
const padColor = (i: number): string => `hsl(${Math.round((i * 137.508) % 360)}, 100%, 60%)`;

const COMP_PRESETS: Record<CompressorStyle, { drive: number; ratio: number; attack: number; release: number; makeup: number; mix: number }> = {
  off:        { drive: 0,  ratio: 1,  attack: 0.01,  release: 0.15, makeup: 0, mix: 0 },
  light:      { drive: 3,  ratio: 2,  attack: 0.030, release: 0.20, makeup: 2, mix: 1.0 },
  punchy:     { drive: 6,  ratio: 4,  attack: 0.010, release: 0.08, makeup: 4, mix: 1.0 },
  ny:         { drive: 12, ratio: 8,  attack: 0.001, release: 0.05, makeup: 6, mix: 0.5 },
  aggressive: { drive: 18, ratio: 12, attack: 0.001, release: 0.03, makeup: 8, mix: 1.0 },
};

interface PadVoice {
  src: AudioBufferSourceNode;
  gain: GainNode;
  startCtxTime: number;
  chopStart: number;
  originalChopStart?: number; // original buffer position when stretch is active
  stretchRatio?: number;      // targetBpm / bpm when stretch is active
  reverseOrigEnd?: number;    // when reverse-sample is active, the original-buffer end time —
                              // playhead reads as `reverseOrigEnd - elapsed`
  playbackRate?: number;      // 2^(semitones/12) from pitch/detune — playhead advances at this rate
  loopPeriod?: number;        // LOOP: buffer-seconds of one pass (chop length − fadeOut); the playhead wraps on it
  loopWarmup?: number;        // LOOP: buffer-seconds before the periodic half starts (passes stacking up)
  gate?: boolean;             // NOTE ON: releasePad fades this voice out
  velocity?: number;          // trigger velocity — restemVoice re-anchors envelopes with it
  stemBase?: AudioBuffer;     // main-chop voices: the mask-resolved buffer this voice reads
                              // (pre-reverse/stretch/loop) — restemVoice's change detector
  posOffset?: number;         // main-track seconds − buffer seconds. A stem SLICE plays in its own
                              // coordinates (0 = the chop start); the playhead adds this back.
}

/** The slice of state that changes on every pad hit. Published on its own
 *  channel (`subscribeActivity`) so triggering a pad doesn't push a whole new
 *  ChopperState — see the note above `subscribeActivity`. */
export interface ChopperActivity {
  activePads: number[];
  lastTriggeredPad: number | null;
  playing: boolean;          // any pad voice currently ringing
}

export interface ChopperState {
  hasBuffer: boolean;
  bufferDuration: number;
  /** TRIM: how many sections are cut out of the sample and how many seconds they add up to. */
  trimCount: number;
  trimmedSec: number;
  normalizeOn: boolean;   // NORM engaged on the loaded sample
  normalizeGain: number;  // multiplier applied to chopGain (1 = unity)
  sourceNorm: Record<string, number>; // NORM per pad source: `src:<videoId>` → gain (absent = off)
  trackTitle: string;
  bpm: number;
  chops: Chop[];
  pads: Pad[];
  padBufferMeta: Record<number, { videoId: string; title: string; start: number; end: number }>;
  /** Mixer strip per occupied pad ('sample' = the main SAMPLE strip; 'sample2'…
   *  = per-source strips). The view creates/prunes strips from this. */
  padRoutes: Record<number, string>;
  /** Every route name a source defaults to (so a strip can exist for a
   *  source whose pads are all elsewhere for the moment). */
  sourceRoutes: Record<string, string>;
  /** pad index → group key override (see padSourceKey / GROUPS). */
  padGroups: Record<number, string>;
  /** Every group in play, with a label + colour key, for the pad menu. */
  groups: Array<{ key: string; label: string; pads: number[] }>;
  /** Mute group per occupied pad (source key, 'none', or 'grpN'). */
  padChoke: Record<number, string>;
  /** Per-source ATTACK / PITCH / REV for pad sources (main = master.attack / master.pitch / reverseSample). */
  sourceFx: Record<string, { attack?: number; pitch?: number; fine?: number; reverse?: boolean }>;
  selectedPad: number | null;
  selectedChopStart: number; // 0..1 fraction; start point of selected pad's chop
  activePads: number[];
  chopMode: boolean;
  snapMode: SnapMode;
  transients: Float32Array; // detected onset times in seconds
  transientCount: number; // total detected transients (for UI display)
  transientSensitivity: number; // 0..1, drives autoSliceTransients
  acDrumsOnly: boolean;         // when true, autoSliceTransients uses banded kick/snare onsets only
  lastTriggeredPad: number | null;
  lastSlicedChopId: number | null;
  playbackPos: number; // current playback position in buffer seconds (-1 = nothing playing)
  master: {
    volume: number;
    pitch: number; // semitones, global — shifts all pads (also shifts tempo)
    fine?: number; // cents, −50..50 — FINE tune on top of pitch (optional: old saves have none = 0)
    filterFreq: number;
    filterEnabled: boolean;
    eqLow: number;
    eqMid: number;
    eqHigh: number;
    compStyle: CompressorStyle;
    compMix: number;
    delayTime: number;
    delayFeedback: number;
    delayMix: number;
    reverbMix: number;
    reverbDecay: number;
    attack: number; // seconds, 0–0.5 (was 0–0.05 — inaudible as a shaping tool)
    release: number; // seconds, tail fade after chop end, 0–0.5
  };
  metronome: {
    enabled: boolean;
    bpm: number;
    sound: MetronomeSound;
    beat: number; // current beat count (for accent on beat 1)
  };
  stretchEnabled: boolean;
  targetBpm: number;
  chopOffsetMs: number;
  isLoaded: boolean;
  isLoading: boolean;
  recording: boolean;     // STEP-input record: each pad hit fills the next cell
  liveRecording: boolean; // LIVE record: pad hits quantize to the nearest grid line while the loop plays
  countInBeat: number;     // LIVE count-in: current beat to display (N..1); -1 when idle
  countInEnabled: boolean; // user setting: play a count-in before LIVE arms
  inputQuantize: number;   // 0..100 — INPUT Q, the only input-quantize control (both sequencers)
  // Legacy timeline fields kept for old preset compatibility — no longer used
  // for playback. The step sequencer below is the canonical pattern store.
  timeline: TimelineEvent[];
  timelinePlaying: boolean;
  timelineLoop: boolean;
  timelineLength: number;
  // Step sequencer state
  seqBars: number;            // 1..4
  seqResolution: number;      // STORED steps per bar (16 = 1/16, 32 = 1/32) — seqGrid's unit
  seqViewResolution: number;  // the grid on screen / live-record quantize; seqResolution % this === 0
  seqGrid: number[][];        // seqGrid[step] = pad indices to fire at that step (stored steps)
  seqRevGrid: boolean[][];    // aligned per-cell reverse flags
  seqVelGrid: number[][];     // aligned per-cell velocity (absent = 1)
  seqSwing: number;           // 0..1 16T swing on the chop seq (mirrors the drum SWING knob)
  seqPlaying: boolean;
  seqPaused: boolean;         // loop frozen mid-flight; cursor sits still, no audio fires
  seqLoop: boolean;
  seqStep: number;            // current playback step (-1 if stopped)
  recordStep: number;         // step-input cursor (next cell to fill while ARMed)
  sequences: SeqPattern[];    // all stored patterns; current = sequences[currentSeqIdx]
  currentSeqIdx: number;
  playingSeqIdx: number;      // sequence currently producing audio (may differ from currentSeqIdx)
  queuedSeqIdx: number | null;// pattern scheduled to take over at the next loop boundary
  arpEnabled: boolean;
  arpRate: number; // note divisor: 1 = 1/4, 2 = 1/8, 4 = 1/16, 8 = 1/32
  arpDirection: 'up' | 'down';
  arpRandom: boolean;
  arpHoldPad: number | null; // currently held pad driving the arp (for highlighting)
  reverseSample: boolean;
  // Extra FX panel — same effects as a Looper track strip. Each block has a
  // `bypassed` flag plus its own knob values. UI: a second FX panel rendered
  // to the left of the master FX panel.
  extraFX: {
    clipper:    { amount: number; drive: number; mix: number; bypassed: boolean };
    waveshaper: { drive: number; mix: number; bypassed: boolean };
    saturator:  { drive: number; mix: number; lowFreq: number; highFreq: number; bypassed: boolean };
    widener:    { width: number; mix: number; bypassed: boolean };
    mseq:       { midFreq: number; midGain: number; sideFreq: number; sideGain: number; mix: number; bypassed: boolean };
    bitcrusher: { bits: number; rate: number; mix: number; bypassed: boolean };
    autopan:    { rate: number; depth: number; mix: number; bypassed: boolean };
    trancegate: { rate: number; depth: number; attack: number; release: number; mix: number; bypassed: boolean };
    chorus:     { rate: number; depth: number; mix: number; bypassed: boolean };
  };
}

// Cap the time-stretch cache. It's cleared on track load / targetBpm change, but
// during a session with stretch ON, unique (chop, ratio) combos accumulate
// unbounded — a slow heap climb toward WKWebView's tab-kill on iOS. 128 MB (vs the
// drum cache's 64 MB) because stretched phrase buffers are much larger than drum hits.
const STRETCH_CACHE_MAX_BYTES = 128 * 1024 * 1024; // 128 MB

/** Hard ceiling on steps in one sequence. 4 bars × 1/128 = 512 — every
 *  bars/resolution combination the UI offers fits. (Was 128: 1/64 × 4 bars
 *  looped after 2 bars, 1/128T × 1 bar after two-thirds of a bar, and the
 *  live-record quantize wrapped at the same wrong count.) */
/** Cap on STORED steps per pattern: 4 bars × 384/bar (384 = every allowed grid,
 *  straight and triplet, up to 1/128 — the finest a refit can ever need). */
export const SEQ_MAX_STEPS = 1536;
/** Cap on VISIBLE columns (bars × view resolution) — what the UI can draw. */
export const SEQ_MAX_VIEW_STEPS = 512;
/** Every grid the sequencer can show / quantize to: straight 1/2 … 1/128 plus
 *  their triplets (×1.5). All divide 384. */
export const SEQ_RESOLUTIONS = new Set([2, 3, 4, 6, 8, 12, 16, 24, 32, 48, 64, 96, 128, 192]);
/** Where a live-recorded hit LANDS, in STORED steps since the loop start.
 *
 *  INPUT Q (`strength`, 0..1) is the only thing that quantizes input: the hit
 *  is pulled toward the nearest line of THIS sequencer's grid by that fraction
 *  — 1 lands on the line, 0 keeps the played time, 0.5 goes halfway. The
 *  sequencer stores notes on steps and has no sub-step timing, so the pulled
 *  time is snapped to the nearest STORED step and THAT instant is what both
 *  the ear and the pattern get: what you hear while recording is what plays
 *  back. (Storage is refit finer while recording with INPUT Q below 100 —
 *  see ensureRecordStorage — so the snap is a few ms, not a whole grid line.)
 */
export function liveLanding(elapsed: number, stepDur: number, stride: number, strength: number): { step: number; at: number } {
  if (!(stepDur > 0) || !(stride >= 1)) return { step: 0, at: 0 };
  const s = Math.max(0, Math.min(1, Number.isFinite(strength) ? strength : 1));
  const gridDur = stepDur * stride;
  const line = Math.round(elapsed / gridDur) * gridDur;
  const corrected = elapsed + s * (line - elapsed);
  const step = Math.round(corrected / stepDur);
  return { step, at: step * stepDur };
}

const gcd = (a: number, b: number): number => { while (b) { [a, b] = [b, a % b]; } return a; };
const lcm = (a: number, b: number): number => (a / gcd(a, b)) * b;

/** Estimated heap footprint of a decoded buffer: Float32 per sample per channel. */
function bufferBytes(buf: AudioBuffer): number {
  return buf.numberOfChannels * buf.length * 4;
}

/** Insertion-ordered LRU cache of AudioBuffers, capped by estimated byte size — a
 *  copy of the DrumEngine pattern (kept local so neither file imports the other).
 *  A Map's insertion order IS the LRU order: a hit delete+re-inserts the key to
 *  move it to the most-recently-used end; eviction drops from the front (oldest)
 *  until the total is back under the cap. Exposes only the get/set/clear subset of
 *  Map that the engine uses, so it's a drop-in for the cache it replaces. */
class LruBufferCache {
  private map = new Map<string, AudioBuffer>();
  private sizes = new Map<string, number>();
  private total = 0;
  constructor(private maxBytes: number) {}

  get(key: string): AudioBuffer | undefined {
    const buf = this.map.get(key);
    if (buf === undefined) return undefined;
    // Touch → most-recently-used end.
    this.map.delete(key);
    this.map.set(key, buf);
    return buf;
  }

  set(key: string, buf: AudioBuffer): void {
    if (this.map.has(key)) {
      // Replacing: drop the old size + position so re-insert lands at the end.
      this.total -= this.sizes.get(key) ?? 0;
      this.map.delete(key);
      this.sizes.delete(key);
    }
    const bytes = bufferBytes(buf);
    this.map.set(key, buf);
    this.sizes.set(key, bytes);
    this.total += bytes;
    // Evict least-recently-used (front) until under cap. Keep at least the entry
    // just inserted (size > 1), so a single oversized buffer still caches.
    while (this.total > this.maxBytes && this.map.size > 1) {
      const oldestKey = this.map.keys().next().value;
      if (oldestKey === undefined) break;
      this.total -= this.sizes.get(oldestKey) ?? 0;
      this.map.delete(oldestKey);
      this.sizes.delete(oldestKey);
    }
  }

  clear(): void {
    this.map.clear();
    this.sizes.clear();
    this.total = 0;
  }
}

export class ChopperEngine {
  readonly ctx: AudioContext;
  /** Public handle to the pad bus so other engines (e.g. the drum sequencer)
   *  can route their output through Terminator's master FX chain. */
  get drumBusInput(): GainNode { return this.padBus; }
  /** Current BPM for tempo-synced satellites (drum sequencer, etc.).
   *  Prefers the metronome BPM since that's what the user actively dials. */
  getMasterBpm(): number {
    const m = this.metronomeBpm;
    if (m > 0) return m;
    if (this.bpm > 0) return this.bpm;
    return 120;
  }
  private masterGain: GainNode;
  private masterLimiter: DynamicsCompressorNode;
  // Final output node of the whole chop FX chain (post master limiter). By
  // default it feeds ctx.destination; the desktop DAW Mixer peels it off the
  // destination and routes it into the mixer's "sample" channel so chops get a
  // mixer strip of their own (drums get their own per-track channels). Public so
  // ChopperView can re-route it.
  readonly outputNode: GainNode;
  // Set by ChopperView once the desktop mixer is wired. When present, exports
  // bake the Sample channel's mixer FX into chop WAVs (the old internal FX
  // chain is now vestigial — its UI moved to the mixer). Optional so non-mixer
  // callers / tests fall back to the legacy internal chain.
  mixerEngine?: MixerEngine;
  private filter: Filter;
  private eq: EQ3;
  private compressor: Compressor;
  private compDryGain: GainNode;
  private compWetGain: GainNode;
  private compMixIn: GainNode;
  /** Dry-leg delay for PARALLEL compression: the DynamicsCompressor has ~6 ms
   *  of look-ahead, so an undelayed dry leg summed with the wet one comb-
   *  filtered (hollow, phasey NY preset). Spliced in ONLY while 0 < mix < 1 —
   *  at mix 0 the dry leg is direct so the live chain gains no latency. */
  private compDryDelay: DelayNode;
  private compDryDelayed = false;
  private compLatencySec = 0;
  private compMixOut: GainNode;
  private delay: Delay;
  private reverb: Reverb;
  private padBus: GainNode;
  // Chop-only gain in front of padBus so a Beat Finisher knob can set the chop
  // level independently of the drums (which also feed padBus) — Phase 2A.
  private chopGain!: GainNode;
  private chopVolume = 1;
  // NORM — non-destructive peak normalize of the loaded sample. When on,
  // `normalizeGain` (0.891 / peak → −1 dBFS) is multiplied into chopGain so the
  // loaded sample's chops play back at full level; the Float32Array is never
  // rewritten. Affects chops only (drums bypass chopGain). Persisted in presets.
  private normalizeOn = false;
  private normalizeGain = 1;
  // NORM PER SOURCE: a pad's own sample (a link, a file, a recording) has its
  // own peak — `src:<videoId>` → 0.891/peak, applied per VOICE (its pads may
  // sit on any mixer strip). The main track's NORM stays on its own bus.
  private sourceNorm = new Map<string, number>();
  // Post-master analyser tap for the Beat Finisher peak/clip meter — Phase 2A.
  private meterAnalyser!: AnalyserNode;
  private meterBuf!: Float32Array;
  // Master clipper (Phase 3A-mod): soft limiter on the master bus. 0 = off (null
  // curve = passthrough); 1 = caps the master at ~-1 dBFS.
  private masterClip!: WaveShaperNode;
  private clipAmount = 0;
  // Extra FX chain, ported from the looper's per-track strip. Wired between
  // padBus and filter; all default to bypassed so the dry sound is unchanged
  // until the user opts in.
  private clipper: Clipper;
  private waveshaper: Waveshaper;
  private saturator: MultibandSaturator;
  private widener: StereoWidener;
  private mseq: MSEQ;
  private bitcrusher: BitCrusher;
  private autopan: AutoPan;
  private trancegate: TranceGate;
  private chorus: Chorus;

  buffer: AudioBuffer | null = null;
  trackTitle = '';
  bpm = 0;
  private chops: Chop[] = [];
  private pads: Pad[] = [];
  private nextChopId = 1;
  private voices: Map<number, PadVoice> = new Map();
  private activePadSet = new Set<number>();
  /** NATIVE ENGINE SHADOW (Terminator 3.0, ui/src/renderer/native/nativeEngineShadow.ts): when set, every live
   *  pad voice this engine starts / stops / releases is mirrored to the C++ engine, and the Web Audio voices of
   *  the LIVE-HIT path (startVoice / restemVoice) are routed into a silent bus so the native engine is what you
   *  hear — while the voice records, LEDs, playhead, chokes and the sequencer's own scheduled voices keep
   *  working unchanged. Null (Electron / web) = no-op. The sequencer's scheduled voices (scheduleSeqStepAudio)
   *  are NOT muted: the chop sequencer stays Web Audio until the native transport lands (Phase 3). */
  voiceSink: { start(padIdx: number, velocity: number, when: number | undefined, reverseOverride: boolean | undefined, nativeOwned: boolean): void; stop(padIdx: number): void; release(padIdx: number): void } | null = null;
  /** Route live-hit voices into a silent bus (the native engine sounds instead). Set with voiceSink. */
  mutePadVoices = false;
  /** NATIVE TRANSPORT (Terminator 3.0, Phase 3.2 — nativeEngineShadow.ts): when set, the chop sequencer RUNS IN THE
   *  C++ ENGINE on its sample clock: PLAY/STOP/PAUSE/RESUME go through this sink, the TS look-ahead scheduler does
   *  not run (no Web Audio sequencer voices), and the shadow pushes the native position back at 20 Hz
   *  (nativeSeqUpdate) so the cursor, the live-record landing, the metronome and the pattern-switch bookkeeping keep
   *  reading the same fields as before (seqCurrentLoopStart / seqStepDuration / playingSeqIdx). Null (Electron /
   *  web) = the Web Audio scheduler below, unchanged. */
  seqSink: { play(anchorCtxTime: number): void; stop(): void; pause(): void; resume(): void; leadSec?(): number } | null = null;
  /** NATIVE (3.3): the cursor's elapsed seconds since the audible loop start, AT THE EAR, from the engine's own clock
   *  (NativeClock + performance.now) — independent of this AudioContext's clock quality. null = use the ctx anchor. */
  nativeCursorHook: (() => number | null) | null = null;
  private nativeSeqCmdAt = 0; // performance.now() of the last play/pause/resume sent — older snapshots are ignored
  /** Satellite phase nudge (drums/bass/MIDI clock): the shadow measures native-vs-ctx drift (setTransportHooks). */
  private seqNudgeHook: ((deltaSec: number) => void) | null = null;
  private mutedBus: GainNode | null = null;
  /** Where a LIVE-HIT voice's gain connects: the pad's bus, or the silent bus under the native shadow. */
  private padVoiceOut(padIdx: number): AudioNode {
    if (!this.mutePadVoices) return this.busFor(padIdx);
    if (!this.mutedBus) { this.mutedBus = this.ctx.createGain(); this.mutedBus.gain.value = 0; this.mutedBus.connect(this.ctx.destination); }
    return this.mutedBus;
  }
  private selectedPad: number | null = null;
  private lockedPadFrom: number | null = null; // free-tier: pads at/after this index are gated off (null = unlocked)
  private chopMode = true;
  private snapMode: SnapMode = 'off'; // default to free placement; user can turn snap on
  private transients: Float32Array = new Float32Array(0);
  private transientStrengths: Float32Array = new Float32Array(0); // parallel to transients
  // Detection runs in two flavors per buffer: broadband (every onset, the
  // original) and drum-only (banded LF/HF flux that ignores melodic onsets
  // and hi-hats). We keep both around so the user can toggle without
  // re-analysing the audio.
  private broadbandTransients: Float32Array = new Float32Array(0);
  private broadbandStrengths: Float32Array = new Float32Array(0);
  private drumTransients: Float32Array = new Float32Array(0);
  private drumStrengths: Float32Array = new Float32Array(0);
  private acDrumsOnly = false;
  // Web build defaults to 0 so the AC (auto-chop) control starts OFF. Desktop
  // keeps the historical 0.3 so the SLICE knob shows "30%" out of the box.
  private transientSensitivity = __isWeb ? 0 : 0.3;

  private arpEnabled = false;
  private arpRate = 4; // sixteenths
  private arpDirection: 'up' | 'down' = 'up';
  private arpRandom = false;
  private arpHoldPad: number | null = null;
  private arpStep = 0;
  private arpStartCtxTime = 0;
  private arpTimer: ReturnType<typeof setTimeout> | null = null;

  private reverseSample = false;
  private reverseBuffer: AudioBuffer | null = null;

  // Undo/redo. `historyUndo` is past states (newest last); `historyRedo` is
  // future states (cleared on any new edit). pushHistory() coalesces rapid
  // edits of the same kind (drag boundary, etc.) within COALESCE_MS so a
  // continuous gesture lands as one undo step.
  private historyUndo: HistorySnapshot[] = [];
  private historyRedo: HistorySnapshot[] = [];
  private readonly HISTORY_MAX = 100;
  // Cap how many distinct loaded sample buffers undo keeps alive, so loading
  // lots of (possibly large) samples can't balloon memory — especially on
  // phones. You can undo the last 2 sample loads; snapshots older than that
  // drop their buffer reference (their chops still restore onto the current
  // sample, but the old audio is freed).
  private readonly MAX_HISTORY_SAMPLES = 2;
  private readonly COALESCE_MS = 500;
  private lastPushTimeByGroup = new Map<string, number>();
  // Optional drum engine whose state rides in every snapshot (set by the view).
  private drumEngine: DrumHistoryTarget | null = null;
  // >0 while a composite edit is in flight (pad paste/duplicate/move): the one
  // pre-edit snapshot is taken in beginHistoryBatch(), and the inner sub-edits'
  // pushHistory() calls no-op so the whole composite collapses to one undo step.
  private historyBatchDepth = 0;
  private lastTriggeredPad: number | null = null;
  private lastSlicedChopId: number | null = null;
  private padBuffers = new Map<number, PadBuffer>();

  private stretchEnabled = false;
  private targetBpm = 0;
  private stretchCache = new LruBufferCache(STRETCH_CACHE_MAX_BYTES);
  private chopOffsetMs = 0;

  private recording = false;
  private liveRecording = false; // real-time quantized record (looper-style)
  // INPUT Q — 0..100, the ONE thing that decides how hard a live-recorded hit
  // is pulled onto the grid (his rule 2026-08-20: "input quantization should be
  // controlled by the input q fader and nothing else"). Setting a GRID no
  // longer implies quantizing the input; the grid only says WHERE the lines
  // are, and each sequencer uses its OWN grid at this one strength. Lives here
  // because it is global — the drum engine reads it through a source callback.
  private inputQuantize = 100;
  private recordStart = 0;
  private timeline: TimelineEvent[] = [];
  private timelinePlaying = false;
  private timelineLoop = false;
  private timelinePlayStart = 0;
  private timelineDuration = 0;
  private timelineLength = 0;
  private scheduledSources: AudioBufferSourceNode[] = [];
  private loopTimers: ReturnType<typeof setTimeout>[] = [];

  // ── Step sequencer ─────────────────────────────────────────────────────────
  // Pattern is a sparse array indexed by step. seqGrid[s] = [pad, pad, ...]
  private seqBars = 2;
  private seqResolution = 4; // STORED steps per bar (start on a 1/4-note grid)
  private seqViewResolution = 4; // the grid on screen; storage refits around it
  private seqGrid: number[][] = [];
  // Aligned with seqGrid: seqRevGrid[step][i] === true means grid[step][i]
  // should be played reversed during sequencer playback.
  private seqRevGrid: boolean[][] = [];
  // Aligned with seqGrid: per-cell VELOCITY (absent = 1). Live record keeps the
  // hit's dynamics; the drum seq had this (stepVelocity), the chop seq did not.
  private seqVelGrid: number[][] = [];
  /** 16T swing for the chop seq, 0..1 — ChopperView mirrors the drum SWING
   *  knob into it so one knob swings both sequencers. */
  private seqSwing = 0;
  /** Is there ANYTHING the sequencer could play? The main track's chops, or a
   *  pad holding its own sample. PLAY and live REC used to demand a MAIN TRACK
   *  (`!this.buffer`), so a kit built entirely from pad samples — a link on a
   *  pad, GET SAMPLE onto the next empty pad, DRUM PADS — had a dead transport:
   *  PLAY did nothing, REC never armed, and only STEP record (which just writes
   *  cells) worked. His report 2026-08-22. The scheduler itself never needed the
   *  main buffer: it resolves every pad through resolvePadSource. */
  private hasSequenceableAudio(): boolean { return !!this.buffer || this.padBuffers.size > 0; }

  private seqPlaying = false;
  private seqLoop = true;
  private seqStep = -1;
  private seqPlayStart = 0;
  private seqStepDuration = 0;
  private seqTimer: ReturnType<typeof setTimeout> | null = null;
  private recordStep = 0; // step-input cursor — advances on each ARM-recorded hit
  // Multi-sequence storage. The "current" sequence's data lives in
  // seqBars/seqResolution/seqGrid/seqLoop above as working state; the array
  // below stores all sequences including the current one. Switching swaps the
  // working state in and out.
  private sequences: SeqPattern[] = [{ bars: 2, resolution: 16, grid: [], loop: true }];
  private currentSeqIdx = 0;       // sequence shown / edited in UI
  private playingSeqIdx = 0;       // sequence currently producing audio
  private queuedSeqIdx: number | null = null; // change scheduled for the next loop boundary
  private seqCurrentLoopStart = 0; // ctx time when the AUDIBLE loop iteration began (for cursor/quantize)
  /** Hits played during a live-record COUNT-IN (see _doTrigger / flushEarlyHits). */
  private earlyHits: Array<{ padIdx: number; at: number }> = [];
  private countInPending = false;
  private seqPaused = false;       // true while paused; seqPlaying stays true so the rAF keeps running but the getters read the frozen phase
  private seqPausedElapsed = 0;    // ctx.currentTime - seqCurrentLoopStart captured at pause (seconds into the current loop)
  // Look-ahead STEP scheduler. A single interval schedules the sequence ONE
  // STEP AT A TIME into a tight horizon (~one tick + safety), so the queue is
  // only ever a step or two ahead — a BPM change, retrigger, clear or sequence
  // swap takes effect within one tick, just like the drum engine (which also
  // advances a per-step cursor by a fresh stepDur each step). The audible anchor
  // (seqCurrentLoopStart) is advanced separately as ctx.currentTime crosses each
  // scheduled loop boundary, so the playhead + live-record quantize always track
  // what's actually sounding. The audio for each step is queued sample-accurately
  // via src.start, so a main-thread stall up to the horizon can't gap a step.
  private seqSchedulerTimer: ClockHandle | null = null;
  private seqScheduledUpTo = 0;    // ctx time of the NEXT step the scheduler will queue
  private seqScheduleStep = 0;     // step index within the loop the scheduler queues NEXT
  private seqScheduleIdx = 0;      // sequence the scheduler fills NEXT (vs playingSeqIdx = audible)
  private seqStopAt = 0;           // >0 when a non-loop pattern is scheduled to end at this ctx time
  private seqBoundaries: Array<{ time: number; stepDur: number; seqIdx: number }> = [];
  // Tails of the most-recently-scheduled ACTIVE step, kept so the next active
  // step can hard-cut them (mono) if it arrives earlier than their natural fade
  // — i.e. when BPM is raised mid-loop. At constant BPM the natural fade already
  // ends exactly at the next hit, so the cut is a no-op (guarded).
  private seqTailVoices: Array<{ gain: GainNode; naturalEnd: number; startAt: number; group: string }> = [];
  // Transport hooks — let a satellite (the drum engine) start/stop in lock-step
  // with the chop sequencer, anchored to the EXACT same ctx time so they never
  // drift (Phase 2C). Both already share the BPM + the audio clock.
  private seqStartHook: ((atTime: number) => void) | null = null;
  private seqStopHook: ((restart: boolean) => void) | null = null;
  /** True while playSeq() is stopping the old run to start a new one — the
   *  stop hook passes it on so the satellites keep their REC arm. */
  private seqRestarting = false;
  private readonly SEQ_INTERVAL = 25; // scheduler tick interval (ms)
  // ~100 ms horizon (matches the drum engine's). Was one tick + 20 ms = 45 ms,
  // and any main-thread stall longer than that — a full-view React commit, a
  // stretch warm, a transient re-detect — silently DROPPED chop steps while
  // the drums (100 ms) kept going. Tempo/clear/retrigger changes still apply
  // at the next unscheduled step, i.e. within ~100 ms.
  // 2026-08-18: 0.25 s at rest, 0.5 s for a few seconds after any late tick
  // (see lib/audioClock LookAhead) — the tick itself now comes from a Worker.
  // Ticks were main-thread setInterval; iOS holds those during a scroll and a
  // heavy React commit delays them, and 0.1 s of queued audio didn't survive
  // either ("the audio jumps when I scroll the tabs").
  private readonly seqLook = new LookAhead(0.25, 0.5, 25);
  /** How far ahead of "now" PLAY puts the downbeat — see playSeq. */
  static readonly TRANSPORT_LEAD_S = 0.02;
  private readonly metroLook = new LookAhead(0.25, 0.5, 25);
  private masterState: ChopperState['master'];
  private isLoading = false;
  private listeners = new Set<(s: ChopperState) => void>();
  private activityListeners = new Set<(a: ChopperActivity) => void>();
  private lastActivity: ChopperActivity | null = null;

  // Metronome
  private metronomeEnabled = false;
  private metronomeBpm = 120;
  private metronomeSound: MetronomeSound = 'click';
  private metronomeBeat = 0;
  private metronomeTimer: ClockHandle | null = null;
  private nextBeatTime = 0;
  // True while a drum-only LIVE record is running the click train (drumEngine
  // started without playSeq, so seqPlaying is false). Lets the scheduler gate
  // pass even though the chop sequencer isn't playing.
  private drumMetronomeActive = false;
  // LIVE count-in: a metronome lead-in (default 1 bar) clicks before recording
  // arms, so the user can catch the tempo before the "1". countInBeat is the
  // number shown in the on-screen countdown (counts down N..1); -1 when idle.
  private countInEnabled = true;
  private countInBeats = 4;
  private countInBeat = -1;
  private countInTimers: ReturnType<typeof setTimeout>[] = [];
  // Noise buffer shared for all noise-based sounds
  private noiseBuffer: AudioBuffer | null = null;
  // Bound handler that resumes the AudioContext when the page comes back to
  // the foreground (see constructor). Stored so dispose() can unbind it.
  private onVisibility: (() => void) | null = null;
  // Preferred output sink ('' = system default) + the devicechange handler that
  // re-points the context at it. See reopenOutput().
  private outputDeviceId = '';
  private onDeviceChange: (() => void) | null = null;
  private deviceChangeTimer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    // AUDIO ENGINE prefs (Preferences → AUDIO) are CONSTRUCTOR-only in Web
    // Audio, so they're read SYNCHRONOUSLY from the desktop settings before
    // the context exists (an async read loses the first-render race). No
    // bridge / no explicit choice = system defaults: 'interactive' latency
    // at the hardware rate. `sampleRateHz` / `bufferFrames` are the HONEST
    // keys (0/absent = auto) — the old audio.sampleRate/bufferSize selects
    // were never applied anywhere (decorative since birth, found 2026-08-20),
    // and silently activating values users never really chose would change
    // their rigs overnight, so those legacy keys stay ignored.
    const opts: AudioContextOptions = { latencyHint: 'interactive' };
    try {
      const a = typeof window !== 'undefined' ? (window as any)?.terminator?.getSettingsSync?.()?.audio : undefined;
      if (a?.sampleRateHz === 44100 || a?.sampleRateHz === 48000) opts.sampleRate = a.sampleRateHz;
      if ([128, 256, 512, 1024].includes(a?.bufferFrames)) {
        // latencyHint in seconds ≈ requested buffer / the rate we'll run at.
        opts.latencyHint = a.bufferFrames / (opts.sampleRate ?? 48000);
      }
    } catch { /* defaults */ }
    this.ctx = new AudioContext(opts);

    // iOS Safari (and Chrome on Android) suspend the AudioContext when the
    // tab is backgrounded — switch apps / tabs and come back and audio is
    // dead until a full reload. iOS ALSO uses a WebKit-only 'interrupted'
    // state when the screen locks/sleeps, which is NOT 'suspended' — so we
    // resume on any state that isn't 'running'. (A full resume from an
    // interruption may still need a user gesture; the pad-tap path below
    // handles that.) pageshow covers the bfcache restore path.
    // Guarded by typeof document so the Electron/SSR paths don't throw.
    if (typeof document !== 'undefined') {
      this.onVisibility = () => {
        if (document.visibilityState === 'visible' && this.ctx.state !== 'running') {
          this.ctx.resume().catch(() => {});
        }
      };
      document.addEventListener('visibilitychange', this.onVisibility);
      window.addEventListener('pageshow', this.onVisibility);
      // iOS fires statechange when an interruption ends; resume then too.
      this.ctx.addEventListener('statechange', () => {
        if (document.visibilityState === 'visible' && this.ctx.state !== 'running') {
          this.ctx.resume().catch(() => {});
        }
      });
    }

    // Output device swaps: Chrome pins an AudioContext to the endpoint it
    // opened with. Plug in an interface, connect Bluetooth, let a device sleep,
    // or have Windows move the default output, and the context keeps running —
    // clock advancing, meters moving — while the audio goes to a dead endpoint.
    // There is no way to detect that from inside Web Audio (the graph still
    // renders), so re-point the sink whenever the device list changes.
    // Debounced: a single plug event fires devicechange several times, and
    // inputs raise it too.
    if (typeof navigator !== 'undefined' && navigator.mediaDevices?.addEventListener) {
      this.onDeviceChange = () => {
        if (this.deviceChangeTimer) clearTimeout(this.deviceChangeTimer);
        this.deviceChangeTimer = setTimeout(() => { void this.reopenOutput(); }, 250);
      };
      navigator.mediaDevices.addEventListener('devicechange', this.onDeviceChange);
    }
    this.masterGain = this.ctx.createGain();
    this.masterGain.gain.value = 0.85;

    this.masterLimiter = this.ctx.createDynamicsCompressor();
    this.masterLimiter.threshold.value = -1;
    this.masterLimiter.knee.value = 0;
    this.masterLimiter.ratio.value = 20;
    this.masterLimiter.attack.value = 0.001;
    this.masterLimiter.release.value = 0.05;

    this.filter = new Filter(this.ctx);
    this.eq = new EQ3(this.ctx);
    this.compressor = new Compressor(this.ctx);
    this.delay = new Delay(this.ctx);
    this.reverb = new Reverb(this.ctx);

    // Extra FX (ported from the looper). Each defaults to bypassed below so
    // the chopper sounds identical to before until the user turns one on.
    this.clipper    = new Clipper(this.ctx);
    this.waveshaper = new Waveshaper(this.ctx);
    this.saturator  = new MultibandSaturator(this.ctx);
    this.widener    = new StereoWidener(this.ctx);
    this.mseq       = new MSEQ(this.ctx);
    this.bitcrusher = new BitCrusher(this.ctx);
    this.autopan    = new AutoPan(this.ctx);
    this.trancegate = new TranceGate(this.ctx);
    this.chorus     = new Chorus(this.ctx);
    [this.clipper, this.waveshaper, this.saturator, this.widener, this.mseq,
     this.bitcrusher, this.autopan, this.trancegate, this.chorus]
      .forEach(fx => fx.setBypassed(true));
    // NOT wired into the live path here — see ensureExtraFxWired(). Nothing in
    // the shipped UI reaches these nine (the desktop mixer is the FX system),
    // yet they used to sit in the master path on every device: five 4x-
    // oversampled WaveShapers, three worklets and a convolver-free chorus all
    // processing silence-through-dry-path for zero sound. They splice in the
    // first time one is actually switched on (toggle*/preset restore).

    this.compMixIn  = this.ctx.createGain();
    this.compMixOut = this.ctx.createGain();
    this.compDryGain = this.ctx.createGain();
    this.compWetGain = this.ctx.createGain();
    this.compDryDelay = this.ctx.createDelay(0.05);
    this.compDryDelay.delayTime.value = 0;
    void compressorLatencySec(this.ctx.sampleRate).then(sec => {
      this.compLatencySec = sec;
      this.compDryDelay.delayTime.value = sec;
    });
    this.compMixIn.connect(this.compDryGain);          // direct dry leg (mix 0 / 1)
    this.compMixIn.connect(this.compressor.input);
    this.compDryGain.connect(this.compMixOut);
    this.compressor.output.connect(this.compWetGain);
    this.compWetGain.connect(this.compMixOut);

    this.filter.setBypassed(false);
    this.filter.setType('lowpass');
    this.filter.setFreq(20000);
    this.filter.setQ(6);
    this.filter.setMix(1);
    this.eq.setBypassed(false);
    this.eq.setLow(0); this.eq.setMid(0); this.eq.setHigh(0);
    this.delay.setBypassed(true);
    this.reverb.setBypassed(true);

    this.padBus = this.ctx.createGain();
    // Chops route pad voices → chopGain → padBus; drums feed padBus directly
    // (drumBusInput === padBus), so the two levels are independent (Phase 2A).
    this.chopGain = this.ctx.createGain();
    this.chopGain.gain.value = this.chopVolume;
    this.chopGain.connect(this.padBus);
    // Live FX chain: padBus → filter/eq/comp/delay/reverb → master. The nine
    // extra FX splice in between padBus and the filter on first use
    // (ensureExtraFxWired).
    this.padBus.connect(this.filter.input);
    this.filter.output.connect(this.eq.input);
    this.eq.output.connect(this.compMixIn);
    this.compMixOut.connect(this.delay.input);
    this.delay.output.connect(this.reverb.input);
    this.reverb.output.connect(this.masterGain);
    // Master clipper sits between the master gain and the safety limiter. Off by
    // default (null curve = passthrough); setMasterClip() installs the soft-clip.
    this.masterClip = this.ctx.createWaveShaper();
    // Oversampling is switched on WITH the curve (setMasterClip): with a null
    // curve the node is a pass-through, but Blink still runs the 4x up/down
    // resamplers — CPU + a few samples of latency on the master bus for nothing.
    this.masterClip.oversample = 'none';
    this.masterGain.connect(this.masterClip);
    this.masterClip.connect(this.masterLimiter);
    // Insert the public outputNode between the limiter and the speakers so the
    // mixer can intercept the whole chop bus without touching the FX chain.
    this.outputNode = this.ctx.createGain();
    this.masterLimiter.connect(this.outputNode);
    this.outputNode.connect(this.ctx.destination);
    // Parallel meter tap on outputNode — END of the chain (post-clip, post-limiter),
    // so the peak/clip meter reads what actually leaves the chop bus. outputNode is
    // the last node in both configs (limiter→outputNode live, clip→outputNode with
    // the desktop mixer attached), so the tap never needs rewiring.
    this.meterAnalyser = this.ctx.createAnalyser();
    this.meterAnalyser.fftSize = 1024;
    this.meterBuf = new Float32Array(this.meterAnalyser.fftSize);
    this.outputNode.connect(this.meterAnalyser);

    this.pads = [];

    this.masterState = {
      // 3 ms attack by default — short enough that hits still feel punchy,
      // long enough to suppress click artifacts from chop edges that don't
      // land on a zero-crossing.
      volume: 0.85, pitch: 0, filterFreq: 20000, filterEnabled: false, attack: 0.003, release: 0,
      eqLow: 0, eqMid: 0, eqHigh: 0,
      compStyle: 'off', compMix: 0,
      delayTime: 0.25, delayFeedback: 0.3, delayMix: 0,
      reverbMix: 0, reverbDecay: 2,
    };
    this.applyCompPreset('off');
    this.buildNoiseBuffer();
  }

  /** Desktop: hand the chop bus to the DAW mixer. The mixer's master strip
   *  runs its own −1 dBFS/20:1 brickwall, so the internal masterLimiter (a
   *  DynamicsCompressor with ~6 ms of look-ahead) is taken OUT of the live
   *  path here — one limiter instead of two identical ones in series, and 6 ms
   *  less pad-to-speaker latency. Offline renders mirror this (buildOfflineChain). */
  attachMixer(mixer: MixerEngine): void {
    this.mixerEngine = mixer;
    try { this.masterClip.disconnect(this.masterLimiter); } catch { /* */ }
    try { this.masterLimiter.disconnect(this.outputNode); } catch { /* */ }
    this.masterClip.connect(this.outputNode);
  }

  /** Splice the extra-FX rack into the live path (padBus → 9 FX → filter) and
   *  load its worklets. Idempotent; called by every toggle / restore that can
   *  switch one on. Each FX has internal dry/wet routing, so a bypassed block
   *  in the chain passes audio unchanged. */
  private extraFxWired = false;
  private ensureExtraFxWired(): void {
    if (this.extraFxWired) return;
    this.extraFxWired = true;
    try { this.padBus.disconnect(this.filter.input); } catch { /* */ }
    this.padBus.connect(this.clipper.input);
    this.clipper.output.connect(this.waveshaper.input);
    this.waveshaper.output.connect(this.saturator.input);
    this.saturator.output.connect(this.widener.input);
    this.widener.output.connect(this.mseq.input);
    this.mseq.output.connect(this.bitcrusher.input);
    this.bitcrusher.output.connect(this.autopan.input);
    this.autopan.output.connect(this.trancegate.input);
    this.trancegate.output.connect(this.chorus.input);
    this.chorus.output.connect(this.filter.input);
    // The worklet-backed four need their modules before audio flows through
    // their wet path (BIT/GATE go silent otherwise; M/S EQ + WIDENER fall back
    // to passthrough).
    void this.bitcrusher.init();
    void this.mseq.init();
    void this.trancegate.init();
    void this.widener.init();
  }
  /** Wire the rack if any block is currently on. */
  private syncExtraFxWiring(): void {
    const any = [this.clipper, this.waveshaper, this.saturator, this.widener, this.mseq,
      this.bitcrusher, this.autopan, this.trancegate, this.chorus].some(fx => !fx.bypassed);
    if (any) this.ensureExtraFxWired();
  }

  private buildNoiseBuffer() {
    const len = this.ctx.sampleRate * 0.2;
    this.noiseBuffer = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const d = this.noiseBuffer.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
  }

  /** Make sure at least `count` pads exist (DRUM PADS mode: one pad per drum
   *  lane — forty lanes, forty pads). New pads are empty; nothing else changes. */
  growPadsTo(count: number): void {
    if (count <= this.pads.length) return;
    this.ensurePad(count - 1);
    this.emit();
  }
  private ensurePad(upToIdx: number): void {
    while (this.pads.length <= upToIdx) {
      const i = this.pads.length;
      this.pads.push({ index: i, chopId: null, mode: 'oneshot', color: padColor(i), pitch: 0 });
    }
  }

  // ── Per-pad sample buffers ─────────────────────────────────────────────────

  loadPadBuffer(padIdx: number, buffer: AudioBuffer, videoId: string, title: string, start?: number, end?: number): void {
    this.ensurePad(padIdx);
    this.stopVoice(padIdx);
    // A different source landing on this pad takes the pad with it: drop any
    // per-pad routing override; the source gets its own strip if new.
    const prev = this.padBuffers.get(padIdx);
    // Undoable, like loading a new main sample is.
    this.pushHistory();
    if (!prev || prev.videoId !== videoId) this.forgetPadRoute(padIdx);
    this.ensureSourceRoute(`src:${videoId}`);
    this.padBuffers.set(padIdx, {
      buffer,
      videoId,
      title,
      start: start ?? 0,
      end: end ?? buffer.duration,
    });
    // Keep chopId — pad still shows its chop region on the waveform.
    // startVoice already prefers padBuffer over main buffer+chop.
    this.emit();
  }

  /** Load new audio over the existing chop layout — keeps all chops and pad assignments intact. */
  async loadAudioKeepChops(ab: ArrayBuffer, title: string): Promise<void> {
    if (this.ctx.state !== 'running') await this.ctx.resume();
    const decoded = await this.decodeAudio(ab);
    // Snapshot the outgoing sample so swapping audio is undoable too.
    if (this.buffer) this.pushHistory();
    this.stopSeq();      // flush old scheduled chop audio + choke timers before the swap
    this.stopAllPads();
    this.buffer = decoded;
    this.fileBuffer = decoded; // a NEW sample starts untrimmed
    this.trims = [];
    this.refreshNormalize();
    this.trackTitle = title;
    this.transients = new Float32Array(0);
    this.transientStrengths = new Float32Array(0);
    this.broadbandTransients = new Float32Array(0);
    this.broadbandStrengths = new Float32Array(0);
    this.drumTransients = new Float32Array(0);
    this.drumStrengths = new Float32Array(0);
    this.bpm = 0;
    this.stretchCache.clear();
    this.targetBpm = 0;
    this.reverseBuffer = null;
    this.clearStems(true); // new audio under the same chops — old stems are wrong
    const dur = decoded.duration;
    for (const c of this.chops) {
      c.end   = Math.min(c.end,   dur);
      c.start = Math.min(c.start, c.end - 0.01);
    }
    this.emit(); // waveform visible immediately

    await tick();
    if (this.fileBuffer !== decoded) return; // a trim mid-analysis keeps the same source
    const det = this.detectTransients(decoded);
    this.broadbandTransients = det.times;
    this.broadbandStrengths = det.strengths;
    const drum = this.detectDrumTransients(decoded);
    this.drumTransients = drum.times;
    this.drumStrengths = drum.strengths;
    this.mapDetectedTransientsToTrims(); // detection ran on the ORIGINAL
    this.applyActiveTransients();
    this.emit();

    await tick();
    if (this.fileBuffer !== decoded) return; // a trim mid-analysis keeps the same source
    const bpm = await estimateBPMAsync(decoded);
    if (this.fileBuffer !== decoded) return; // a trim mid-analysis keeps the same source
    if (bpm > 0) {
      this.bpm = bpm;
      this.targetBpm = bpm;
      if (this.metronomeBpm === 0 || this.metronomeBpm === 120) this.metronomeBpm = bpm;
      this.emit();
    }
  }

  getPadBuffer(padIdx: number): PadBuffer | null {
    return this.padBuffers.get(padIdx) ?? null;
  }

  setPadTrim(padIdx: number, start: number, end: number): void {
    const pb = this.padBuffers.get(padIdx);
    if (!pb) return;
    pb.start = Math.max(0, Math.min(pb.buffer.duration - 0.01, start));
    pb.end = Math.max(pb.start + 0.01, Math.min(pb.buffer.duration, end));
    this.emit();
  }

  removePadBuffer(padIdx: number): void {
    this.stopVoice(padIdx);
    this.padBuffers.delete(padIdx);
    this.forgetPadRoute(padIdx);
    this.emit();
  }

  /** Move — or swap — a pad's full content (its per-pad buffer OR its chop
   *  assignment + pitch/mode) between two slots, and remap every sequencer step
   *  that referenced the source so the pattern follows the sample to its new
   *  pad. If `dest` already holds content the two pads SWAP; if `dest` is empty,
   *  `src` moves to it and `src` is left empty. Non-destructive to chops — only
   *  the pad pointer / per-pad buffer moves, the underlying chop region stays. */
  movePad(src: number, dest: number): void {
    if (src === dest || src < 0 || dest < 0) return;
    this.ensurePad(Math.max(src, dest));
    type Slot = PadSlot;
    const snap = (i: number): Slot => {
      const pb = this.padBuffers.get(i);
      const p = this.pads[i];
      if (pb) return { kind: 'buffer', buffer: pb.buffer, videoId: pb.videoId, title: pb.title, start: pb.start, end: pb.end, play: p ? padPlayOf(p) : undefined, stems: p?.stems };
      if (p && p.chopId != null) return { kind: 'chop', chopId: p.chopId, pitch: p.pitch ?? 0, mode: p.mode, play: padPlayOf(p) };
      return null;
    };
    const place = (i: number, s: Slot): void => {
      this.stopVoice(i);
      this.padBuffers.delete(i);
      if (this.pads[i]) this.pads[i].chopId = null;
      if (!s) return;
      if (s.kind === 'buffer') {
        this.padBuffers.set(i, { buffer: s.buffer, videoId: s.videoId, title: s.title, start: s.start, end: s.end });
      } else if (this.pads[i]) {
        this.pads[i].chopId = s.chopId;
        this.pads[i].pitch = s.pitch;
        this.pads[i].mode = s.mode;
      }
      if (s.play && this.pads[i]) this.applyPadPlay(this.pads[i], s.play);
    };
    this.pushHistory();
    const a = snap(src);
    const b = snap(dest);
    const swap = b !== null;
    place(dest, a);
    place(src, swap ? b : null);
    const ra = this.padRoutes.get(src), rb = this.padRoutes.get(dest);
    this.padRoutes.delete(src); this.padRoutes.delete(dest);
    if (ra) this.padRoutes.set(dest, ra);
    if (swap && rb) this.padRoutes.set(src, rb);
    const ca = this.padChoke.get(src), cb = this.padChoke.get(dest);
    this.padChoke.delete(src); this.padChoke.delete(dest);
    if (ca) this.padChoke.set(dest, ca);
    if (swap && cb) this.padChoke.set(src, cb);
    // Remap step references in the active grid + every stored sequence so the
    // moved sample keeps triggering on the same steps from its new pad index.
    const remapRow = (row: number[] | undefined): void => {
      if (!row) return;
      for (let i = 0; i < row.length; i++) {
        if (row[i] === src) row[i] = dest;
        else if (swap && row[i] === dest) row[i] = src;
      }
    };
    this.seqGrid.forEach(remapRow);
    for (const seq of this.sequences) seq.grid?.forEach(remapRow);
    this.syncCurrentToArray();
    this.emit();
  }

  // ── SOURCES + BLOCKS ───────────────────────────────────────────────────────
  // Every pad comes from a SOURCE: the main track (a chop pad) or its own audio
  // (a per-pad buffer — a file, a YouTube pull, a recording). Chops of one
  // pad-source are pad buffers that SHARE the AudioBuffer with different
  // trims. A BLOCK is a contiguous run of pads of one source; blocks move as a
  // unit and PUSH other blocks aside instead of overwriting them.

  /** Identity of the source behind a pad — same key ⇒ same source. */
  /** The pad's GROUP key. Automatic: a pad's own source ('src:<videoId>', or
   *  'main' for a main-track chop) — every new sample on a pad is its own group,
   *  with its own block, colour stripe, default mixer strip and mute group. A
   *  pad can be MOVED into another group (padGroups override): duplicate to a
   *  new group, add to an existing one, leave. Chops cut from a pad stay in its
   *  group. null = empty pad. */
  padSourceKey(padIdx: number): string | null {
    const own = this.padGroups.get(padIdx);
    const pb = this.padBuffers.get(padIdx);
    if (pb) return own ?? `src:${pb.videoId}`;
    const p = this.pads[padIdx];
    if (p && p.chopId != null) return own ?? 'main';
    return null;
  }
  /** GROUP overrides (pad → group key). Carried by rearrange, chops, presets. */
  private padGroups = new Map<number, string>();
  private nextGroupNo = 2;
  /** Groups in play: the automatic ones (each source, the main track) plus the
   *  user-made ones that still hold a pad. Labelled by the source title. */
  groups(): Array<{ key: string; label: string; pads: number[] }> {
    const map = new Map<string, number[]>();
    const hi = this.lastOccupiedPad();
    for (let i = 0; i <= hi; i++) { const k = this.padSourceKey(i); if (!k) continue; const a = map.get(k); if (a) a.push(i); else map.set(k, [i]); }
    const out: Array<{ key: string; label: string; pads: number[] }> = [];
    for (const [key, pads] of map) out.push({ key, label: this.groupLabel(key, pads), pads });
    return out;
  }
  groupLabel(key: string, pads?: number[]): string {
    if (key === 'main') return this.trackTitle ? `main · ${this.trackTitle}` : 'main sample';
    const m = /^grp:(\d+)$/.exec(key);
    if (m) { const p = pads ?? this.padsInGroup(key); const t = p.length ? this.padBuffers.get(p[0])?.title : undefined; return `GROUP ${m[1]}${t ? ' · ' + t : ''}`; }
    const p = pads ?? this.padsInGroup(key);
    const t = p.length ? this.padBuffers.get(p[0])?.title : undefined;
    return t ?? key.replace(/^src:/, '');
  }
  private padsInGroup(key: string): number[] {
    const out: number[] = [];
    const hi = this.lastOccupiedPad();
    for (let i = 0; i <= hi; i++) if (this.padSourceKey(i) === key) out.push(i);
    return out;
  }
  /** Put a pad (or its whole block) into `key` ('new' = a fresh GROUP n that
   *  starts with this pad's current mixer strip; null = back to its own
   *  source). The group's default strip + mute group apply from now on; a
   *  per-pad routing override is dropped so the pad really takes the group's. */
  setPadGroup(padIdx: number, key: string | null, wholeBlock = false): string | null {
    const range = wholeBlock ? this.blockRange(padIdx) : null;
    const [lo, hi] = range ?? [padIdx, padIdx];
    const list: number[] = [];
    for (let i = lo; i <= hi; i++) list.push(i);
    // Seed a 'new' group from the pad the user CLICKED — on a whole-block
    // apply from a mid-block pad, the clicked pad's strip (it may carry a
    // per-pad override) is the one the user is standing on.
    return this.setPadsGroup(list, key, padIdx);
  }
  /** Multi-pad GROUP assign (shift-selected pads): same as setPadGroup, but
   *  'new' resolves ONCE so every pad lands in the SAME fresh group. `seedIdx`
   *  names the pad whose strip/FX seed the fresh group (default: first loaded). */
  setPadsGroup(padIdxs: number[], key: string | null, seedIdx?: number): string | null {
    const first = (seedIdx !== undefined && this.padSourceKey(seedIdx) !== null ? seedIdx : undefined)
      ?? padIdxs.find(i => this.padSourceKey(i) !== null);
    if (first === undefined) return null;
    this.pushHistory();
    let k = key;
    if (k === 'new') {
      k = `grp:${this.nextGroupNo++}`;
      this.sourceRoutes.set(k, this.padRoute(first));
      const fx = this.sourceSettings(this.padSourceKey(first) ?? 'main');
      this.sourceFx.set(k, { attack: fx.attack, pitch: fx.pitch, fine: fx.fine, reverse: fx.reverse });
    }
    for (const i of padIdxs) {
      if (!this.padSourceKey(i)) continue;
      if (k === null) this.padGroups.delete(i); else this.padGroups.set(i, k);
      this.padRoutes.delete(i);
      this.padChoke.delete(i);
    }
    if (k && k !== 'main' && !this.sourceRoutes.has(k)) this.ensureSourceRoute(k);
    this.onRoutesChanged?.();
    this.emit();
    return k;
  }
  /** DUPLICATE INTO A NEW GROUP: the copy plays the same audio from `destIdx`,
   *  but as its own group — own block + colour + mute group, and a default
   *  strip that starts as the original pad's. Chops cut from the copy follow
   *  the copy; the original is untouched. */
  duplicatePadToNewGroup(padIdx: number, destIdx: number): boolean {
    const slot = this.snapSlot(padIdx);
    if (!slot) return false;
    this.pushHistory();
    const k = `grp:${this.nextGroupNo++}`;
    this.sourceRoutes.set(k, this.padRoute(padIdx));
    // The new group starts with the original's ATTACK / PITCH / FINE / REV, then goes its own way.
    const fromKey = this.padSourceKey(padIdx) ?? 'main';
    const fx = this.sourceSettings(fromKey);
    this.sourceFx.set(k, { attack: fx.attack, pitch: fx.pitch, fine: fx.fine, reverse: fx.reverse });
    this.unassignPad(destIdx);
    const copy: PadSlot = slot.kind === 'chop' ? { ...slot, chopId: this.cloneChop(slot.chopId), group: k } : { ...slot, group: k };
    this.placeSlot(destIdx, copy);
    this.onRoutesChanged?.();
    this.emit();
    return true;
  }
  /** The block around a pad: [lo, hi] of the contiguous run sharing its source key. */
  blockRange(padIdx: number): [number, number] | null {
    const key = this.padSourceKey(padIdx);
    if (!key) return null;
    let lo = padIdx, hi = padIdx;
    while (lo > 0 && this.padSourceKey(lo - 1) === key) lo--;
    while (this.padSourceKey(hi + 1) === key) hi++;
    return [lo, hi];
  }
  /** Highest pad index that holds anything. -1 when the grid is empty. */
  private lastOccupiedPad(): number {
    let hi = -1;
    for (let i = 0; i < this.pads.length; i++) if (this.pads[i]?.chopId != null) hi = i;
    for (const i of this.padBuffers.keys()) if (i > hi) hi = i;
    return hi;
  }
  private snapSlot(i: number): PadSlot {
    const pb = this.padBuffers.get(i);
    const p = this.pads[i];
    const group = this.padGroups.get(i);
    if (pb) return { kind: 'buffer', buffer: pb.buffer, videoId: pb.videoId, title: pb.title, start: pb.start, end: pb.end, play: p ? padPlayOf(p) : undefined, group, stems: p?.stems };
    // The stem mask travels WITH the chop (it used to stay pinned to the pad
    // index, so a push-aside silently swapped masks between pads).
    if (p && p.chopId != null) return { kind: 'chop', chopId: p.chopId, pitch: p.pitch ?? 0, mode: p.mode, play: padPlayOf(p), group, stems: p.stems };
    return null;
  }
  /** Copy a PadPlay onto a pad (mode / gate / fades / pitch). */
  private applyPadPlay(p: Pad, play: PadPlay): void {
    p.mode = play.mode; p.gate = play.gate || undefined; p.pitch = play.pitch;
    p.fadeIn = play.fadeIn || undefined; p.fadeOut = play.fadeOut || undefined;
  }
  private placeSlot(i: number, s: PadSlot): void {
    this.ensurePad(i);
    // Only silence a pad whose CONTENT changes. rearrange() re-places every
    // slot, and stopping them all meant chopping a pad source while it played
    // (MIDI pad → slice) cut the sample dead at the new chop point — the very
    // pad that was sounding got its voice killed for no change at all. A
    // trimmed end (the cut pad) still counts as the same content: the voice
    // already owns its play length and just rings to where it was going.
    const cur = this.padBuffers.get(i);
    const p0 = this.pads[i];
    const same = s
      ? (s.kind === 'buffer'
          ? !!cur && cur.buffer === s.buffer && cur.videoId === s.videoId && cur.start === s.start
          : !cur && p0.chopId === s.chopId)
      : (!cur && p0.chopId === null);
    if (!same) this.stopVoice(i);
    this.padBuffers.delete(i);
    this.padGroups.delete(i);
    const p = this.pads[i];
    p.chopId = null;
    p.stems = undefined;
    if (!s) return;
    if (s.group) this.padGroups.set(i, s.group);
    if (s.kind === 'buffer') { this.padBuffers.set(i, { buffer: s.buffer, videoId: s.videoId, title: s.title, start: s.start, end: s.end }); p.stems = s.stems; }
    else { p.chopId = s.chopId; p.pitch = s.pitch; p.mode = s.mode; p.stems = s.stems; }
    if (s.play) this.applyPadPlay(p, s.play);
  }
  /** Rearrange the grid through a plan over a slot array. `origin[n]` = the old
   *  index of whatever now sits at n (-1 = new content) — the sequencer's step
   *  references are remapped from it so every pattern keeps playing the same
   *  sound from its new pad. The plan may grow the arrays (push null first). */
  private rearrange(plan: (slots: PadSlot[], origin: number[]) => void): void {
    const n = Math.max(this.pads.length, this.lastOccupiedPad() + 1);
    const slots: PadSlot[] = Array.from({ length: n }, (_, i) => this.snapSlot(i));
    const origin: number[] = Array.from({ length: n }, (_, i) => i);
    plan(slots, origin);
    // old index → new index (an old index that vanished maps to -1: its steps are dropped)
    const map = new Map<number, number>();
    for (let i = 0; i < origin.length; i++) if (origin[i] >= 0) map.set(origin[i], i);
    // Per-pad routing + mute-group overrides follow their pads.
    const routes = new Map<number, string>();
    for (const [i, r] of this.padRoutes) { const to = map.get(i); if (to !== undefined) routes.set(to, r); }
    this.padRoutes = routes;
    const chokes = new Map<number, string>();
    for (const [i, g] of this.padChoke) { const to = map.get(i); if (to !== undefined) chokes.set(to, g); }
    this.padChoke = chokes;
    for (let i = 0; i < slots.length; i++) this.placeSlot(i, slots[i]);
    // Slots beyond the new length that used to hold something are emptied.
    for (let i = slots.length; i < n; i++) this.placeSlot(i, null);
    const remapRow = (row: number[] | undefined): void => {
      if (!row) return;
      for (let i = row.length - 1; i >= 0; i--) {
        const to = map.get(row[i]);
        if (to === undefined) { if (row[i] < n) row.splice(i, 1); }
        else row[i] = to;
      }
    };
    this.seqGrid.forEach(remapRow);
    for (const seq of this.sequences) seq.grid?.forEach(remapRow);
    this.syncCurrentToArray();
    this.emit();
  }
  /** Put `items` at pos, pos+1, … pushing the occupied run that starts there
   *  to the right (the first empty pad absorbs it) — nothing is overwritten. */
  private static insertPushing(slots: PadSlot[], origin: number[], pos: number, items: PadSlot[]): void {
    for (let k = 0; k < items.length; k++) {
      const at = pos + k;
      while (slots.length <= at) { slots.push(null); origin.push(-1); }
      let q = at;
      while (q < slots.length && slots[q] !== null) q++;
      if (q === slots.length) { slots.push(null); origin.push(-1); }
      for (let i = q; i > at; i--) { slots[i] = slots[i - 1]; origin[i] = origin[i - 1]; }
      slots[at] = items[k]; origin[at] = -1;
    }
  }
  /** Where a NEW chop of this source goes: right after its block; a source
   *  with no block yet takes the first empty pad. */
  nextSlotForSource(key: string): number {
    let hi = -1;
    for (let i = 0; i <= this.lastOccupiedPad(); i++) if (this.padSourceKey(i) === key) hi = i;
    if (hi >= 0) return hi + 1;
    for (let i = 0; ; i++) if (!this.padSourceKey(i)) return i;
  }
  /** Make pad `idx` empty by pushing whatever occupies it (and the run after
   *  it) one to the right. No-op when it is already empty. */
  makeRoomAt(idx: number): void {
    if (!this.padSourceKey(idx)) { this.ensurePad(idx); return; }
    this.rearrange((slots, origin) => ChopperEngine.insertPushing(slots, origin, idx, [null]));
  }
  /** Move a whole BLOCK (Julienne-style drop): the run of pads sharing the
   *  dragged pad's source lands with its first pad on `to`; whatever sits there
   *  is pushed along. Two single pads swap (that is what pushing a one-wide
   *  block onto another one-wide block reads as, and it is what people expect). */
  moveBlock(from: number, to: number): void {
    const range = this.blockRange(from);
    if (!range) return;
    const [lo, hi] = range;
    if (to >= lo && to <= hi) return;
    const len = hi - lo + 1;
    const destRange = this.blockRange(to);
    if (len === 1 && destRange && destRange[0] === destRange[1]) { this.movePad(from, to); return; }
    if (len === 1 && !destRange) { this.movePad(from, to); return; }
    this.pushHistory();
    this.rearrange((slots, origin) => {
      const items = slots.slice(lo, hi + 1);
      const origins = origin.slice(lo, hi + 1);
      for (let i = lo; i <= hi; i++) { slots[i] = null; origin[i] = -1; }
      // insertPushing marks origin -1; restore the moved pads' origins so their
      // sequencer steps follow them.
      ChopperEngine.insertPushing(slots, origin, to, items);
      for (let k = 0; k < items.length; k++) origin[to + k] = origins[k];
    });
  }
  /** DRY-RUN of moveBlock for the drag preview: which pads would end up
   *  where if `from`'s block were dropped on `to`. Returns old → new index for
   *  every pad that moves (the block itself and everything it pushes) plus the
   *  landing run. Nothing is mutated. */
  planMoveBlock(from: number, to: number): { moves: Array<[number, number]>; landing: number[] } | null {
    const range = this.blockRange(from);
    if (!range) return null;
    const [lo, hi] = range;
    if (to >= lo && to <= hi) return null;
    const len = hi - lo + 1;
    const destRange = this.blockRange(to);
    const n = Math.max(this.pads.length, this.lastOccupiedPad() + 1, to + len);
    // Singles swap (same rule as moveBlock).
    if (len === 1 && (!destRange || destRange[0] === destRange[1])) {
      const moves: Array<[number, number]> = [[from, to]];
      if (destRange) moves.push([to, from]);
      return { moves, landing: [to] };
    }
    const slots: PadSlot[] = [];
    const origin: number[] = [];
    for (let i = 0; i < n; i++) { const k = this.padSourceKey(i); slots.push(k ? ({ kind: 'chop', chopId: -1, pitch: 0, mode: 'oneshot' } as PadSlot) : null); origin.push(i); }
    const items = slots.slice(lo, hi + 1);
    const origins = origin.slice(lo, hi + 1);
    for (let i = lo; i <= hi; i++) { slots[i] = null; origin[i] = -1; }
    ChopperEngine.insertPushing(slots, origin, to, items);
    for (let k = 0; k < items.length; k++) origin[to + k] = origins[k];
    const moves: Array<[number, number]> = [];
    for (let i = 0; i < origin.length; i++) if (origin[i] >= 0 && origin[i] !== i) moves.push([origin[i], i]);
    return { moves, landing: Array.from({ length: len }, (_, k) => to + k) };
  }
  /** Resolve what a pad plays: its own source (trimmed) or its main-track chop. */
  resolvePadSource(padIdx: number): PadSource | null {
    const pb = this.padBuffers.get(padIdx);
    // A pad's OWN sample goes through its per-source stem mask too — the
    // sequencer and the exports used to take the raw sample here while a live
    // hit (startVoice → bufferForPadSource) played the masked stems, so a
    // drums-only pad sounded like the whole song from the SEQ (his report
    // 2026-08-22: "it's not the same sound as when I hit the pad").
    if (pb) { const m = this.bufferForPadSource(padIdx); return { buffer: m.buffer, start: m.start, end: m.end, isPad: true }; }
    const pad = this.pads[padIdx];
    if (!pad || pad.chopId === null || !this.buffer) return null;
    const chop = this.chops.find(c => c.id === pad.chopId);
    if (!chop) return null;
    // STEMS: resolve through the pad's mask — every consumer of this method
    // (sequencer scheduling, offline exports, per-pad stem export) hears the
    // same audio a live hit plays. ALL/unready resolves to the original.
    const m = this.bufferForPadChop(padIdx, chop.start, chop.end);
    return { buffer: m.buffer, start: m.start, end: m.end, isPad: false };
  }
  /** RESAMPLE — what a pad PLAYS, as a plan (pure; gate: test:resample-pad):
   *  its source slice through the stem mask (resolvePadSource), its pitch in
   *  cents (pad PITCH + source PITCH/FINE — what a hit detunes by), whether it
   *  plays reversed, and its attack. Dry: no mixer strip, no limiter — the same
   *  sound as hitting the pad with the fader at unity. null = empty pad. */
  padRenderPlan(padIdx: number): { buffer: AudioBuffer; start: number; end: number; detuneCents: number; reverse: boolean; attackS: number; isPad: boolean } | null {
    const psrc = this.resolvePadSource(padIdx);
    if (!psrc) return null;
    const pad = this.pads[padIdx];
    const detuneCents = ((pad?.pitch ?? 0) + this.pitchFor(padIdx)) * 100;
    return { buffer: psrc.buffer, start: psrc.start, end: psrc.end, detuneCents, reverse: this.reversedFor(padIdx), attackS: this.attackFor(padIdx), isPad: psrc.isPad };
  }
  /** Render the plan offline → the pad's sound as an AudioBuffer (its own
   *  length at its pitch — a chop pitched up comes out shorter, exactly as it
   *  sounds). Used by RESAMPLE; the project keeps the result as an asset. */
  async renderPadAsPlayed(padIdx: number): Promise<AudioBuffer | null> {
    const plan = this.padRenderPlan(padIdx);
    if (!plan) return null;
    const { buffer, start, end, detuneCents, reverse, attackS } = plan;
    const sr = buffer.sampleRate;
    const rate = Math.pow(2, detuneCents / 1200);
    const srcDur = Math.max(0.001, end - start);
    const outFrames = Math.max(1, Math.ceil((srcDur / rate) * sr));
    const off = new OfflineAudioContext(Math.max(1, buffer.numberOfChannels), outFrames, sr);
    const src = off.createBufferSource();
    // Reverse reads the mirrored buffer from the mirrored offset — the same
    // maths startVoice and the sequencer use.
    src.buffer = reverse ? this.reversedOf(buffer) : buffer;
    src.detune.value = detuneCents;
    const g = off.createGain();
    if (attackS > 0) { g.gain.setValueAtTime(0, 0); g.gain.linearRampToValueAtTime(1, attackS); } else g.gain.value = 1;
    src.connect(g); g.connect(off.destination);
    src.start(0, reverse ? buffer.duration - end : start, srcDur);
    return off.startRendering();
  }
  // ── STEMS — per-pad stem masks over the main track (stemMask.ts) ───────────
  // The buffers are DERIVED state (never in undo snapshots; masks ride the
  // pads). All stems are full-track-length, sample-aligned with `buffer`;
  // spans outside `stemReadyRanges` are silent in them, so an unready pad
  // plays the ORIGINAL instead (bufferForPadChop).
  private stemBuffers: Record<StemName, AudioBuffer> | null = null;
  private stemsMetaState: { quality: 'fast' | 'fine'; assets: Partial<Record<StemName, string>> } | null = null;
  private stemReadyRanges: ReadyRange[] = [];
  // CHOP-LENGTH stem mixes (maskSlice), keyed mask:firstFrame:lastFrame, bounded
  // LRU. (The old cache held FULL-TRACK combos: ~100 MB and ~90 ms of main-thread
  // adds PER COMBO, rendered on the hit path — that was the per-pad-stems lag.)
  private stemSliceCache = new Map<string, AudioBuffer>();
  private static readonly STEM_SLICE_CACHE_MAX = 96;
  // The waveform's per-chop composite (see waveformBuffer). Allocated ONCE per
  // source as a copy of the original, then patched IN PLACE span by span — its
  // identity is stable, so the waveform re-buckets only the spans that changed
  // (waveformRev / takeWaveformDirty) instead of the whole track per toggle.
  private waveformComposite: {
    src: AudioBuffer; buf: AudioBuffer; key: string;
    painted: Map<number, { start: number; end: number; mask: StemMask; stale?: boolean }>;
  } | null = null;
  private waveformRevN = 0;
  private waveformDirtyRanges: Array<[number, number]> = [];
  // A chop boundary is being DRAGGED: the composite holds still (no slice
  // re-render / repaint per mid-drag commit) and catches up on release.
  private waveformLive = false;
  setWaveformLive(on: boolean): void { this.waveformLive = on; }
  private stemsRev = 0;
  /** STEMS PER SOURCE (his workflow 2026-08-22: sample → stems → chops on
   *  pads, then the next sample the same way, all in one kit): every pad's
   *  own sample can carry its four layers, keyed by the source buffer. */
  private sourceStems = new Map<AudioBuffer, StemSet>();
  private sourceComposites = new Map<AudioBuffer, { buf: AudioBuffer; key: string }>();
  // TRIM (non-destructive, trimRegions.ts): `fileBuffer` is the decoded
  // ORIGINAL; `buffer` — what everything plays / draws / exports — is its kept
  // ranges concatenated. Stems are held full-length in FILE time
  // (stemFileBuffers / stemFileRanges: the controller, the split worker and
  // the split-once cache all live there) and cut to the effective timeline
  // here, exactly like the sample.
  private fileBuffer: AudioBuffer | null = null;
  private trims: TrimRegion[] = [];
  private stemFileBuffers: Record<StemName, AudioBuffer> | null = null;
  /** LAZY STEMS: set when a saved split is known but not yet decoded. */
  private stemsPending: { load: () => Promise<Record<StemName, AudioBuffer> | null>; started: boolean } | null = null;
  private stemFileRanges: ReadyRange[] = [];

  /** True once a split is KNOWN for this audio — decoded, or restored lazily
   *  and not yet decoded (see setStemsPending). The chips, the pad Stems menu
   *  and REMOVE all key off this, so a lazy restore must look identical. */
  hasStems(): boolean { return !!this.stemBuffers || !!this.stemsPending; }
  /** LAZY STEMS: a saved split is known (meta + ready ranges) but its four
   *  FLACs have NOT been decoded. Opening a project with stems used to pay ~1 s
   *  of decoding and hold ~140 MB of AudioBuffers whether or not the stems were
   *  ever used; now the audio is fetched the first time a pad actually asks for
   *  a masked slice. Until then every pad plays the ORIGINAL — the exact
   *  fallback an un-ready span already takes, so nothing stalls or goes silent.
   *  `load` resolves the four buffers (or null if the assets are gone). */
  setStemsPending(
    meta: { quality: 'fast' | 'fine'; assets: Partial<Record<StemName, string>> },
    ranges: ReadyRange[],
    load: () => Promise<Record<StemName, AudioBuffer> | null>,
  ): void {
    this.stemFileBuffers = null;
    this.stemBuffers = null;
    this.stemsMetaState = meta;
    this.stemFileRanges = normalizeRanges(ranges);
    this.stemReadyRanges = [];
    this.stemsPending = { load, started: false };
    this.stemSliceCache.clear();
    this.waveformComposite = null;
    this.stemsRev++;
    this.emit();
  }
  /** Kick the deferred decode, once. Safe to call from the hit path: it never
   *  blocks — the caller keeps playing the original and the voices re-stem
   *  when the buffers land. */
  ensureStemsDecoded(): void {
    const p = this.stemsPending;
    if (!p || p.started) return;
    p.started = true;
    void p.load().then(stems => {
      if (this.stemsPending !== p) return;      // dropped/replaced while decoding
      this.stemsPending = null;
      if (stems) this.setStemBuffers(stems, this.stemsMetaState ?? undefined, this.stemFileRanges);
      else { this.stemsMetaState = null; this.stemFileRanges = []; this.stemsRev++; this.emit(); }
    }).catch(() => {
      if (this.stemsPending === p) { this.stemsPending = null; this.stemsMetaState = null; this.stemFileRanges = []; this.stemsRev++; this.emit(); }
    });
  }
  /** Are this track's stems known but still undecoded? (tests + diagnostics) */
  stemsArePending(): boolean { return !!this.stemsPending; }
  stemsMeta(): { quality: 'fast' | 'fine'; assets: Partial<Record<StemName, string>>; readyRanges: ReadyRange[] } | null {
    // readyRanges are in the ORIGINAL's time (what the controller, the split
    // worker and the project file speak); bufferForPadChop uses the derived
    // effective ranges.
    return this.stemsMetaState ? { ...this.stemsMetaState, readyRanges: this.stemFileRanges.map(r => [...r] as ReadyRange) } : null;
  }
  /** Install (or drop) the decoded stem buffers. Meta identifies the split so
   *  projects can restore it; ranges say which spans are real. Dropping keeps
   *  every pad's MASK (needs-resplit state) but plays originals everywhere. */
  setStemBuffers(
    stems: Record<StemName, AudioBuffer> | null,
    meta?: { quality: 'fast' | 'fine'; assets: Partial<Record<StemName, string>> },
    ranges?: ReadyRange[],
  ): void {
    // Stems arrive FULL-LENGTH in the ORIGINAL's time (the controller / worker /
    // cache never see a trim); the effective copies are derived below.
    this.stemsPending = null;   // a real install supersedes any deferred decode
    this.stemFileBuffers = stems;
    this.stemsMetaState = stems ? (meta ?? this.stemsMetaState) : null;
    this.stemFileRanges = stems ? normalizeRanges(ranges ?? this.stemFileRanges) : [];
    this.rederiveStems();
    this.stemSliceCache.clear();
    this.waveformComposite = null;
    this.stemsRev++;
    this.restemAllVoices(); // ringing masked voices fall back / pick up live
    this.emit();
  }
  /** The effective (trimmed-timeline) stems + ready ranges from the file-time
   *  originals. No trims → the very same buffers (zero copy). */
  private rederiveStems(): void {
    if (!this.stemFileBuffers) { this.stemBuffers = null; this.stemReadyRanges = []; return; }
    if (!this.trims.length) {
      this.stemBuffers = this.stemFileBuffers;
      this.stemReadyRanges = this.stemFileRanges.map(r => [r[0], r[1]] as ReadyRange);
      return;
    }
    const cut = {} as Record<StemName, AudioBuffer>;
    for (const n of STEM_ORDER) cut[n] = buildEffectiveBuffer(this.ctx, this.stemFileBuffers[n], this.trims);
    this.stemBuffers = cut;
    this.stemReadyRanges = mapFileRangesToEff(this.stemFileRanges, this.trims).map(r => [r[0], r[1]] as ReadyRange);
  }
  /** A split chunk landed — extend the ready set (ChopperView calls this as
   *  stems:chunk events arrive; the PCM is already written into the buffers). */
  addStemReadyRange(startSec: number, endSec: number): void {
    // FILE time (the worker splits the original). With trims the effective
    // stems are COPIES, so re-cut them to pick up the PCM the chunk wrote.
    this.stemFileRanges = addReadyRange(this.stemFileRanges, [startSec, endSec]);
    if (this.trims.length) this.rederiveStems();
    else this.stemReadyRanges = this.stemFileRanges.map(r => [r[0], r[1]] as ReadyRange);
    this.stemsRev++;
    // Chunks overlap-add, so PCM under the chunk may have changed beneath a
    // cached slice or an already-painted composite span: drop the slices
    // (re-rendered in ~1 ms each) and mark those spans (effective time) stale
    // so the next waveformBuffer() repaints them (restore original → repaint).
    this.stemSliceCache.clear();
    const comp = this.waveformComposite;
    if (comp) {
      const spans = mapFileRangesToEff([[startSec, endSec]], this.trims);
      for (const j of comp.painted.values()) if (spans.some(([a, b]) => j.start < b && a < j.end)) { j.stale = true; comp.key = ''; }
    }
    // A ringing masked voice whose span just turned ready upgrades mid-note.
    this.restemAllVoices();
    this.emit();
  }
  padStems(padIdx: number): StemMask { return normalizeMask(this.pads[padIdx]?.stems); }
  setPadStems(padIdx: number, mask: StemMask): void { this.setPadsStems([padIdx], mask); }
  /** One undo step, one emit — multi-select sets the whole selection. */
  setPadsStems(padIdxs: number[], mask: StemMask): void {
    const m = normalizeMask(mask);
    const hit = padIdxs.filter(i => this.pads[i] && this.padStems(i) !== m);
    if (!hit.length) return;
    this.pushHistory();
    for (const i of hit) this.pads[i].stems = m === MASK_ALL ? undefined : m;
    // LIVE: a ringing voice on any of these pads swaps to the new mix at the
    // current playhead — no restart needed to hear the toggle.
    for (const i of hit) this.restemVoice(i);
    this.emit();
  }
  /** A CHOP-LENGTH buffer holding the summed stems of `mask` over
   *  [startSec, endSec) — the slice's frame 0 is floor(startSec·sr) of the track.
   *  Rendered on first use (~1 ms for a bar: channels × lit stems × frames of
   *  plain adds) and cached by identity, so the reverse/loop/stretch caches keyed
   *  on the buffer stay warm across hits. Single-bit masks are sliced too: a
   *  reversed or looped stem then costs chop-length work, never a full track. */
  private maskSlice(mask: StemMask, startSec: number, endSec: number): AudioBuffer {
    return this.maskSliceFrom(this.stemBuffers!, 'm', mask, startSec, endSec);
  }
  private maskSliceFrom(stems: Record<StemName, AudioBuffer>, tag: string, mask: StemMask, startSec: number, endSec: number): AudioBuffer {
    const ref = stems[STEM_ORDER[0]];
    const sr = ref.sampleRate;
    const a = Math.max(0, Math.min(ref.length - 1, Math.floor(startSec * sr)));
    const b = Math.max(a + 1, Math.min(ref.length, Math.ceil(endSec * sr)));
    const key = `${tag}:${mask}:${a}:${b}`;
    const hit = this.stemSliceCache.get(key);
    if (hit) { this.stemSliceCache.delete(key); this.stemSliceCache.set(key, hit); return hit; } // LRU touch
    const chans = Math.min(2, ref.numberOfChannels);
    const out = this.ctx.createBuffer(chans, b - a, sr);
    for (let c = 0; c < chans; c++) {
      const d = out.getChannelData(c);
      let first = true;
      for (let i = 0; i < STEM_ORDER.length; i++) {
        if (!((mask >> i) & 1)) continue;
        const sb = stems[STEM_ORDER[i]];
        const src = sb.getChannelData(Math.min(c, sb.numberOfChannels - 1));
        const end = Math.min(b, src.length);
        if (first) { d.set(src.subarray(a, end)); first = false; continue; } // memcpy, then adds
        for (let k = a, j = 0; k < end; k++, j++) d[j] += src[k];
      }
    }
    this.stemSliceCache.set(key, out);
    if (this.stemSliceCache.size > ChopperEngine.STEM_SLICE_CACHE_MAX) {
      const oldest = this.stemSliceCache.keys().next().value;
      if (oldest !== undefined) this.stemSliceCache.delete(oldest);
    }
    return out;
  }
  /** What a main-track chop PLAYS for a pad, as a positioned source: the
   *  ORIGINAL in main-track coordinates when the mask is ALL or the span isn't
   *  ready (never silence, never a block — STEM-SPLIT-PLAN.md latency design),
   *  otherwise its chop-length stem slice in the SLICE's coordinates (start is
   *  the sub-sample remainder, so playback is sample-exact). Every consumer
   *  positions with start/end; the playhead maps back with chop.start − start. */
  bufferForPadChop(padIdx: number, chopStart: number, chopEnd: number): { buffer: AudioBuffer; start: number; end: number } {
    const mask = this.padStems(padIdx);
    // A masked pad is the first REAL demand for the audio — start the deferred
    // decode and play the original for now (it re-stems when the buffers land).
    if (mask !== MASK_ALL && this.stemsPending) this.ensureStemsDecoded();
    if (!this.buffer || !this.stemBuffers || mask === MASK_ALL) return { buffer: this.buffer!, start: chopStart, end: chopEnd };
    if (!spanReady(this.stemReadyRanges, chopStart, chopEnd)) return { buffer: this.buffer, start: chopStart, end: chopEnd };
    const slice = this.maskSlice(mask, chopStart, chopEnd);
    const off = Math.floor(chopStart * slice.sampleRate) / slice.sampleRate;
    return { buffer: slice, start: chopStart - off, end: chopEnd - off };
  }
  // ── STEMS PER SOURCE ──────────────────────────────────────────────────────
  /** What a pad's stems are about: a chop of the MAIN track, the pad's OWN
   *  sample ('source'), or nothing (empty pad). */
  stemTargetKind(padIdx: number): 'main' | 'source' | null {
    if (this.padBuffers.has(padIdx)) return 'source';
    return this.pads[padIdx]?.chopId != null && this.buffer ? 'main' : null;
  }
  /** The source buffer behind a pad's own sample (null for main-track pads). */
  padSourceBuffer(padIdx: number): AudioBuffer | null { return this.padBuffers.get(padIdx)?.buffer ?? null; }
  /** Every pad that plays from this source buffer. */
  padsOnSource(buf: AudioBuffer): number[] {
    const out: number[] = [];
    for (const [i, pb] of this.padBuffers) if (pb.buffer === buf) out.push(i);
    return out.sort((a, b) => a - b);
  }
  hasSourceStems(buf: AudioBuffer | null): boolean { return !!buf && this.sourceStems.has(buf); }
  /** Stems exist for what this pad plays (main track or its own source). */
  hasStemsForPad(padIdx: number): boolean {
    const k = this.stemTargetKind(padIdx);
    return k === 'main' ? this.hasStems() : k === 'source' ? this.sourceStems.has(this.padBuffers.get(padIdx)!.buffer) : false;
  }
  sourceStemsMeta(buf: AudioBuffer): { quality: 'fast' | 'fine'; assets: Partial<Record<StemName, string>>; readyRanges: ReadyRange[] } | null {
    const set = this.sourceStems.get(buf);
    return set ? { ...set.meta, readyRanges: set.ranges.map(r => [...r] as ReadyRange) } : null;
  }
  /** Install (or drop) a source's stems — the per-source twin of setStemBuffers. */
  setSourceStemBuffers(buf: AudioBuffer, stems: Record<StemName, AudioBuffer> | null, meta?: { quality: 'fast' | 'fine'; assets: Partial<Record<StemName, string>> }, ranges?: ReadyRange[]): void {
    if (!stems) this.sourceStems.delete(buf);
    else {
      const prev = this.sourceStems.get(buf);
      this.sourceStems.set(buf, { file: stems, meta: meta ?? prev?.meta ?? { quality: 'fast', assets: {} }, ranges: normalizeRanges(ranges ?? prev?.ranges ?? []) });
    }
    this.sourceComposites.delete(buf);
    this.stemSliceCache.clear();
    this.stemsRev++;
    for (const i of this.padsOnSource(buf)) this.restemVoice(i);
    this.emit();
  }
  addSourceStemReadyRange(buf: AudioBuffer, startSec: number, endSec: number): void {
    const set = this.sourceStems.get(buf);
    if (!set) return;
    set.ranges = addReadyRange(set.ranges, [startSec, endSec]);
    this.stemSliceCache.clear();
    this.sourceComposites.delete(buf);
    this.stemsRev++;
    for (const i of this.padsOnSource(buf)) this.restemVoice(i);
    this.emit();
  }
  /** Persistence: every source's stems, keyed by the videoId its pads carry. */
  sourceStemsSnapshot(): Record<string, { quality: 'fast' | 'fine'; assets: Partial<Record<StemName, string>>; readyRanges: Array<[number, number]> }> {
    const out: Record<string, { quality: 'fast' | 'fine'; assets: Partial<Record<StemName, string>>; readyRanges: Array<[number, number]> }> = {};
    for (const [, pb] of this.padBuffers) {
      const set = this.sourceStems.get(pb.buffer);
      if (set && !out[pb.videoId]) out[pb.videoId] = { ...set.meta, readyRanges: set.ranges.map(r => [r[0], r[1]] as [number, number]) };
    }
    return out;
  }
  /** Drop stem sets no pad plays from any more (a source left the kit). */
  private pruneSourceStems(): void {
    if (!this.sourceStems.size) return;
    const live = new Set<AudioBuffer>();
    for (const [, pb] of this.padBuffers) live.add(pb.buffer);
    for (const buf of [...this.sourceStems.keys()]) if (!live.has(buf)) { this.sourceStems.delete(buf); this.sourceComposites.delete(buf); }
  }
  /** What an OWN-SAMPLE pad plays, as a positioned source — the per-source
   *  twin of bufferForPadChop: the original over [start, end) when the mask is
   *  ALL or the span isn't ready, else its chop-length stem slice. */
  bufferForPadSource(padIdx: number): { buffer: AudioBuffer; start: number; end: number } {
    const pb = this.padBuffers.get(padIdx)!;
    const mask = this.padStems(padIdx);
    const set = this.sourceStems.get(pb.buffer);
    if (!set || mask === MASK_ALL || !spanReady(set.ranges, pb.start, pb.end)) return { buffer: pb.buffer, start: pb.start, end: pb.end };
    const slice = this.maskSliceFrom(set.file, `s${this.padSourceKey(padIdx) ?? ''}`, mask, pb.start, pb.end);
    const off = Math.floor(pb.start * slice.sampleRate) / slice.sampleRate;
    return { buffer: slice, start: pb.start - off, end: pb.end - off };
  }
  /** What the WAVEFORM should draw for a pad-source view: the source with
   *  every masked, ready pad span painted in its stem mix (full rebuild on
   *  change — pad sources are short next to a song). */
  padSourceWaveformBuffer(padIdx: number): AudioBuffer | null {
    const pb = this.padBuffers.get(padIdx);
    if (!pb) return null;
    const set = this.sourceStems.get(pb.buffer);
    if (!set) return pb.buffer;
    // Mid-drag (a pad's trim handle moving at ≤20 Hz commits): keep showing the
    // composite we have — the key below carries every pad's start/end, so each
    // commit would otherwise rebuild the whole source (new buffer → the view
    // re-buckets every peak) and the drag stutters. Same rule as the main
    // track's waveformBuffer (2b7a5c7); the release commit repaints once.
    if (this.waveformLive) return this.sourceComposites.get(pb.buffer)?.buf ?? pb.buffer;
    const jobs: Array<{ start: number; end: number; mask: StemMask }> = [];
    for (const i of this.padsOnSource(pb.buffer)) {
      const o = this.padBuffers.get(i)!;
      const mask = this.padStems(i);
      if (mask === MASK_ALL || !spanReady(set.ranges, o.start, o.end)) continue;
      jobs.push({ start: o.start, end: o.end, mask });
    }
    if (!jobs.length) return pb.buffer;
    const key = jobs.map(j => `${j.start.toFixed(4)}:${j.end.toFixed(4)}:${j.mask}`).join('|');
    const hit = this.sourceComposites.get(pb.buffer);
    if (hit && hit.key === key) return hit.buf;
    const src = pb.buffer, sr = src.sampleRate, chans = Math.min(2, src.numberOfChannels);
    const buf = this.ctx.createBuffer(chans, src.length, sr);
    for (let c = 0; c < chans; c++) buf.copyToChannel(src.getChannelData(c) as Float32Array<ArrayBuffer>, c);
    for (const j of jobs) {
      const slice = this.maskSliceFrom(set.file, 'w', j.mask, j.start, j.end);
      const at = Math.floor(j.start * sr);
      for (let c = 0; c < chans; c++) buf.copyToChannel(slice.getChannelData(Math.min(c, slice.numberOfChannels - 1)) as Float32Array<ArrayBuffer>, c, at);
    }
    this.sourceComposites.set(pb.buffer, { buf, key });
    return buf;
  }
  /** What the WAVEFORM should draw: a per-chop COMPOSITE — each chop's span
   *  is painted with the stem mix of the pad that plays it, everything else
   *  stays the original (his call 2026-08-21: drums off on chop 1 thins out
   *  ONLY chop 1 on screen — per-pad stemming you can SEE). Rebuilt only when
   *  the key changes (masks, chop edits, stem audio/ranges, a new sample);
   *  the cached object keeps its identity so WaveformView's per-buffer peak
   *  cache stays warm across unrelated re-renders and pad hits. */
  waveformBuffer(): AudioBuffer | null {
    const src = this.buffer;
    // Drawing a masked chop is a real demand too — kick the deferred decode and
    // paint the plain original this pass (the repaint comes with the emit).
    if (src && this.stemsPending && this.pads.some(p => p.chopId !== null && this.padStems(p.index) !== MASK_ALL)) this.ensureStemsDecoded();
    if (!src || !this.stemBuffers) return src;
    const sr = src.sampleRate;
    // The paint list: every pad whose chop plays a non-ALL, READY stem mix.
    const jobs: Array<{ pad: number; start: number; end: number; mask: StemMask }> = [];
    for (const p of this.pads) {
      if (p.chopId === null) continue;
      const mask = this.padStems(p.index);
      if (mask === MASK_ALL) continue;
      const chop = this.chops.find(c => c.id === p.chopId);
      if (!chop || !spanReady(this.stemReadyRanges, chop.start, chop.end)) continue;
      jobs.push({ pad: p.index, start: chop.start, end: chop.end, mask });
    }
    let comp = this.waveformComposite;
    if (comp && comp.src !== src) { comp = null; this.waveformComposite = null; }
    // Mid-drag: hand back what's drawn; the diff runs on the release commit.
    // (Each mid-drag commit moved a span → a fresh slice render + repaint +
    // re-bucket per tick — that was the choppy chop drag on stemmed songs.)
    if (this.waveformLive) return comp ? comp.buf : src;
    if (!jobs.length && !comp) return src; // nothing masked = the original, bit-exact
    jobs.sort((a, b) => a.pad - b.pad);
    // Two masked pads on OVERLAPPING spans (dup pads over one chop): the
    // focused pad paints LAST so the span shows the pad being edited. Focus
    // enters the key only then — otherwise pad hits never force a rebuild.
    let focusTag = '';
    if (jobs.some((j, i) => jobs.some((k, m) => m !== i && j.start < k.end && k.start < j.end))) {
      const f = this.focusedPad();
      if (f !== null && jobs.some(j => j.pad === f)) {
        const mine = jobs.filter(j => j.pad === f);
        const rest = jobs.filter(j => j.pad !== f);
        jobs.length = 0; jobs.push(...rest, ...mine);
        focusTag = `f${f}`;
      }
    }
    const key = `${focusTag}#` + jobs.map(j => `${j.pad}:${j.start.toFixed(4)}:${j.end.toFixed(4)}:${j.mask}`).join('|');
    if (!comp) {
      // First masked pad on this source: ONE full copy of the original, patched
      // in place from here on (identity stable for the waveform's peak cache).
      const chans = Math.min(2, src.numberOfChannels);
      const buf = this.ctx.createBuffer(chans, src.length, sr);
      for (let c = 0; c < chans; c++) buf.copyToChannel(src.getChannelData(c) as Float32Array<ArrayBuffer>, c);
      comp = { src, buf, key: '\u0000', painted: new Map() };
      this.waveformComposite = comp;
    }
    if (comp.key === key) return comp.buf;
    // DIFF against what is painted: a pad's span is dirty when it was removed,
    // added, stale (audio changed under it) or its span/mask moved. Where
    // spans overlap and the focus order moved, every overlapping span is dirty.
    const dirty: Array<[number, number]> = []; // frames
    const push = (st: number, en: number) => {
      const a = Math.max(0, Math.floor(st * sr)), b = Math.min(src.length, Math.ceil(en * sr));
      if (b > a) dirty.push([a, b]);
    };
    const next = new Map(jobs.map(j => [j.pad, j]));
    for (const [pad, old] of comp.painted) {
      const nj = next.get(pad);
      if (!nj || old.stale || nj.start !== old.start || nj.end !== old.end || nj.mask !== old.mask) push(old.start, old.end);
    }
    for (const j of jobs) {
      const old = comp.painted.get(j.pad);
      if (!old || old.stale || old.start !== j.start || old.end !== j.end || old.mask !== j.mask) push(j.start, j.end);
    }
    if (comp.key.split('#')[0] !== focusTag) {
      for (const j of jobs) if (jobs.some(k => k !== j && j.start < k.end && k.start < j.end)) push(j.start, j.end);
    }
    dirty.sort((x, y) => x[0] - y[0]);
    const merged: Array<[number, number]> = [];
    for (const r of dirty) {
      const last = merged[merged.length - 1];
      if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]); else merged.push([r[0], r[1]]);
    }
    const chans = comp.buf.numberOfChannels;
    for (const [a, b] of merged) {
      // The original back over the span, then every job touching it, in paint order.
      for (let c = 0; c < chans; c++) {
        comp.buf.getChannelData(c).set(src.getChannelData(Math.min(c, src.numberOfChannels - 1)).subarray(a, b), a);
      }
      for (const j of jobs) {
        const ja = Math.max(a, Math.floor(j.start * sr)), jb = Math.min(b, Math.ceil(j.end * sr));
        if (jb <= ja) continue;
        const mix = this.maskSlice(j.mask, j.start, j.end);
        const m0 = Math.floor(j.start * sr); // slice frame 0 == track frame m0
        for (let c = 0; c < chans; c++) {
          const mc = mix.getChannelData(Math.min(c, mix.numberOfChannels - 1));
          comp.buf.getChannelData(c).set(mc.subarray(ja - m0, jb - m0), ja);
        }
      }
    }
    comp.painted = new Map(jobs.map(j => [j.pad, { start: j.start, end: j.end, mask: j.mask }]));
    comp.key = key;
    if (merged.length) { this.waveformDirtyRanges.push(...merged); this.waveformRevN++; }
    return comp.buf;
  }
  /** Bumps every time the composite was patched IN PLACE (same buffer identity);
   *  WaveformView re-buckets only takeWaveformDirty()'s frame ranges. */
  waveformRev(): number { return this.waveformRevN; }
  takeWaveformDirty(): Array<[number, number]> {
    const d = this.waveformDirtyRanges;
    this.waveformDirtyRanges = [];
    return d;
  }
  // ── TRIM — cut sections out of the sample, non-destructively (trimRegions.ts) ──
  /** The decoded ORIGINAL (pre-trim). What the stems controller, the split
   *  worker and the split-once cache work on; null when nothing is loaded. */
  get sourceBuffer(): AudioBuffer | null { return this.fileBuffer; }
  /** Trimmed-timeline seconds → original's seconds, and back. */
  effToFile(t: number, end = false): number { return effToFile(this.trims, t, end); }
  fileToEff(t: number): number { return fileToEff(this.trims, t); }
  trimsInfo(): { count: number; seconds: number } { return { count: this.trims.length, seconds: totalTrimmedSec(this.trims) }; }
  /** Cut [t0, t1) — trimmed-timeline seconds — out of the sample (his ask
   *  2026-08-21, julienne's model). The original is never touched; the playable
   *  buffer is rebuilt from the kept ranges with a 3 ms ramp at each seam.
   *  Chops after the cut slide left, chops across it are clipped, chops inside
   *  it are SWALLOWED into the trim (their pads emptied) so RESTORE TRIM can
   *  bring them back. Stems are cut the same way. One undo step. */
  addTrim(t0: number, t1: number): boolean {
    const file = this.fileBuffer;
    if (!this.buffer || !file) return false;
    const dur = this.buffer.duration;
    const a = Math.max(0, Math.min(dur, Math.min(t0, t1)));
    const b = Math.max(0, Math.min(dur, Math.max(t0, t1)));
    if (b - a < 0.02) return false;
    if (b - a >= dur - 0.02) return false; // never trim the whole sample away
    this.stopAllPads();
    this.stopSeq();
    this.pushHistory();
    const removed = b - a;
    const f0 = this.effToFile(a), f1 = this.effToFile(b, true);
    const swallowed: TrimChop[] = [];
    const keep: Chop[] = [];
    const swallow = (c: Chop) => {
      const pad = this.padIdxForChop(c.id);
      swallowed.push({ id: c.id, startSec: this.effToFile(c.start), endSec: this.effToFile(c.end, true), padIdx: pad ?? undefined, stems: pad !== null ? this.pads[pad].stems : undefined });
    };
    for (const c of this.chops) {
      if (c.end <= a) { keep.push(c); continue; }
      if (c.start >= b) { keep.push({ ...c, start: c.start - removed, end: c.end - removed }); continue; }
      if (c.start >= a && c.end <= b) { swallow(c); continue; }
      // straddles an edge (or both): keep what sits outside the cut; the part
      // inside rides the trim under the SAME id so RESTORE extends it back.
      const ns = c.start < a ? c.start : a;
      const ne = c.end > b ? c.end - removed : a;
      if (ne - ns >= 0.01) {
        keep.push({ ...c, start: ns, end: ne });
        const pad = this.padIdxForChop(c.id);
        swallowed.push({ id: c.id, startSec: this.effToFile(Math.max(c.start, a)), endSec: this.effToFile(Math.min(c.end, b), true), padIdx: pad ?? undefined, stems: pad !== null ? this.pads[pad].stems : undefined });
      } else swallow(c);
    }
    const kept = new Set(keep.map(c => c.id));
    for (const p of this.pads) {
      if (p && p.chopId !== null && !kept.has(p.chopId)) { this.stopVoice(p.index); this.forgetPadRoute(p.index); p.chopId = null; p.stems = undefined; }
    }
    this.chops = keep;
    if (this.lastSlicedChopId !== null && !kept.has(this.lastSlicedChopId)) this.lastSlicedChopId = null;
    this.trims = addTrimRegion(this.trims, f0, f1, swallowed);
    // transients live in the trimmed timeline: drop the cut, slide the rest
    const tb = cutTimes(this.broadbandTransients, this.broadbandStrengths, a, b);
    this.broadbandTransients = tb.times; this.broadbandStrengths = tb.strengths;
    const td = cutTimes(this.drumTransients, this.drumStrengths, a, b);
    this.drumTransients = td.times; this.drumStrengths = td.strengths;
    this.applyActiveTransients();
    this.rebuildEffective();
    this.emit();
    return true;
  }
  /** RESTORE TRIM: every cut comes back, with the chops it swallowed — on
   *  their old pads when those are still empty, else on the next free pads.
   *  One undo step. */
  restoreTrims(): boolean {
    if (!this.fileBuffer || !this.trims.length) return false;
    this.stopAllPads();
    this.stopSeq();
    this.pushHistory();
    const prev = this.trims;
    const swallowed = prev.flatMap(t => t.chops).sort((x, y) => x.startSec - y.startSec);
    // surviving chops + transients: trimmed timeline → the original's
    this.chops = this.chops.map(c => ({ ...c, start: effToFile(prev, c.start), end: effToFile(prev, c.end, true) }));
    const back = (arr: Float32Array): Float32Array => { const out = new Float32Array(arr.length); for (let i = 0; i < arr.length; i++) out[i] = effToFile(prev, arr[i]); return out; };
    this.broadbandTransients = back(this.broadbandTransients);
    this.drumTransients = back(this.drumTransients);
    this.applyActiveTransients();
    this.trims = [];
    for (const sc of swallowed) {
      // A clipped survivor (same id still on the grid) grows back to cover
      // the part the cut took; a swallowed chop comes back whole on a pad.
      const alive = this.chops.find(c => c.id === sc.id);
      if (alive) { alive.start = Math.min(alive.start, sc.startSec); alive.end = Math.max(alive.end, sc.endSec); continue; }
      const id = sc.id;
      if (id >= this.nextChopId) this.nextChopId = id + 1;
      this.chops.push({ id, start: sc.startSec, end: sc.endSec });
      const home = sc.padIdx !== undefined && this.pads[sc.padIdx] && this.pads[sc.padIdx].chopId === null && !this.padBuffers.has(sc.padIdx)
        ? sc.padIdx : this.nextSlotForSource('main');
      this.ensurePad(home);
      this.pads[home].chopId = id;
      this.pads[home].stems = sc.stems;
    }
    this.chops.sort((x, y) => x.start - y.start);
    this.rebuildEffective();
    this.emit();
    return true;
  }
  /** The playable buffer (and the stems) from the original + the trim list;
   *  every per-buffer cache goes with the old buffer. */
  private rebuildEffective(): void {
    if (!this.fileBuffer) return;
    this.buffer = buildEffectiveBuffer(this.ctx, this.fileBuffer, this.trims);
    this.reverseBuffer = null;
    this.stretchCache.clear();
    this.stemSliceCache.clear();
    this.waveformComposite = null;
    this.rederiveStems();
    this.stemsRev++;
    this.refreshNormalize();
    this._kickWarmAllChops();
  }
  /** Detection results were computed on the ORIGINAL; with trims in place they
   *  need to move to the trimmed timeline (entries inside a cut drop). */
  private mapDetectedTransientsToTrims(): void {
    if (!this.trims.length) return;
    const b = mapTimesFileToEff(this.broadbandTransients, this.broadbandStrengths, this.trims);
    this.broadbandTransients = b.times; this.broadbandStrengths = b.strengths;
    const d = mapTimesFileToEff(this.drumTransients, this.drumStrengths, this.trims);
    this.drumTransients = d.times; this.drumStrengths = d.strengths;
  }

  /** New/changed main audio — stems belong to the sample, so drop them AND
   *  every pad's mask (a needs-resplit ghost mask on a new song is a trap). */
  private clearStems(resetMasks: boolean): void {
    this.stemBuffers = null;
    this.stemsMetaState = null;
    this.stemReadyRanges = [];
    this.stemFileBuffers = null;
    this.stemFileRanges = [];
    this.stemSliceCache.clear();
    this.waveformComposite = null;
    this.stemsRev++;
    if (resetMasks) for (const p of this.pads) p.stems = undefined;
  }

  /** Reversed copy of any source buffer, built once per buffer. The main
   *  track keeps its own `reverseBuffer` field (it rides in undo snapshots). */
  private reverseCache = new WeakMap<AudioBuffer, AudioBuffer>();
  reversedOf(buf: AudioBuffer): AudioBuffer {
    if (this.buffer === buf) {
      if (!this.reverseBuffer) this.reverseBuffer = this.buildReverseBuffer(buf);
      return this.reverseBuffer;
    }
    let r = this.reverseCache.get(buf);
    if (!r) { r = this.buildReverseBuffer(buf); this.reverseCache.set(buf, r); }
    return r;
  }
  /** Chop a pad's OWN source at `times` (buffer seconds, inside its trim): the
   *  pad keeps the first piece, the rest go into the pads right after its block
   *  as new pads of the same source (a BLOCK), pushing other blocks aside. */
  /** How many EMPTY pads sit right after a pad's block — the room its source
   *  has to keep chopping into (his rule, 2026-08-19: chopping never pushes
   *  another block; when the next pad is taken, chopping is BLOCKED until you
   *  move that block away). */
  roomAfterBlock(padIdx: number): { at: number; free: number } {
    const range = this.blockRange(padIdx);
    const at = range ? range[1] + 1 : this.nextSlotForSource(this.padSourceKey(padIdx) ?? 'main');
    let free = 0;
    while (!this.padSourceKey(at + free) && free < 64) free++;
    return { at, free };
  }
  chopPadSource(padIdx: number, times: number[]): number {
    const pb = this.padBuffers.get(padIdx);
    if (!pb) return 0;
    const cuts = [...new Set(times.filter(t => t > pb.start + 0.01 && t < pb.end - 0.01))].sort((a, b) => a - b);
    if (cuts.length === 0) return 0;
    // Only into the empty pads right after the block — never push a neighbour.
    const room = this.roomAfterBlock(padIdx);
    if (room.free < cuts.length) return -1;
    this.pushHistory();
    this.stopAllPads();
    const edges = [pb.start, ...cuts, pb.end];
    const pieces = edges.slice(0, -1).map((st, i) => ({ start: st, end: edges[i + 1] }));
    const insertAt = room.at;
    const first = pieces[0];
    pb.start = first.start; pb.end = first.end;
    const group = this.padGroups.get(padIdx);
    const stems = this.pads[padIdx]?.stems; // a new piece starts with the SAME layers (as main-track chops do)
    const items: PadSlot[] = pieces.slice(1).map(pc => ({ kind: 'buffer', buffer: pb.buffer, videoId: pb.videoId, title: pb.title, start: pc.start, end: pc.end, group, stems }));
    this.rearrange((slots, origin) => ChopperEngine.insertPushing(slots, origin, insertAt, items));
    return items.length;
  }
  /** Cut a pad's own source at `time` and put the tail piece on `targetPadIdx`
   *  (the pad the user aimed at — pushed free if something sits there). */
  chopPadSourceTo(padIdx: number, time: number, targetPadIdx: number): boolean {
    const pb = this.padBuffers.get(padIdx);
    if (!pb || time <= pb.start + 0.01 || time >= pb.end - 0.01) return false;
    this.pushHistory();
    const tail = { start: time, end: pb.end };
    pb.end = time;
    const item: PadSlot = { kind: 'buffer', buffer: pb.buffer, videoId: pb.videoId, title: pb.title, start: tail.start, end: tail.end, group: this.padGroups.get(padIdx), stems: this.pads[padIdx]?.stems };
    this.rearrange((slots, origin) => ChopperEngine.insertPushing(slots, origin, targetPadIdx, [item]));
    this.lastTriggeredPad = padIdx;
    return true;
  }
  /** Auto-chop a pad's own source: `n` equal pieces, or at its transients. The
   *  pad's current trim is the region that gets chopped. */
  autoChopPadSource(padIdx: number, mode: number | 'transients'): number {
    const pb = this.padBuffers.get(padIdx);
    if (!pb) return 0;
    let times: number[] = [];
    if (mode === 'transients') {
      const det = this.detectTransients(pb.buffer);
      times = Array.from(det.times).filter(t => t > pb.start && t < pb.end);
    } else {
      const step = (pb.end - pb.start) / mode;
      times = Array.from({ length: mode - 1 }, (_, i) => pb.start + (i + 1) * step);
    }
    // Transients: take as many as there is room for (from the start).
    if (mode === 'transients') { const room = this.roomAfterBlock(padIdx); times = times.slice(0, Math.max(0, room.free)); if (times.length === 0) return -1; }
    return this.chopPadSource(padIdx, times);
  }
  /** Every pad that plays from the same source as `padIdx` (its own buffer),
   *  with each one's trim — what the waveform draws in a pad-source view. */
  padSourceChops(padIdx: number): Array<{ padIdx: number; start: number; end: number }> {
    const pb = this.padBuffers.get(padIdx);
    if (!pb) return [];
    const out: Array<{ padIdx: number; start: number; end: number }> = [];
    for (const [i, o] of this.padBuffers) if (o.videoId === pb.videoId && o.buffer === pb.buffer) out.push({ padIdx: i, start: o.start, end: o.end });
    return out.sort((a, b) => a.start - b.start);
  }
  /** Clear a whole block (every pad of the run). Chop pads go through clearPad
   *  so the main track's regions merge as they always did. */
  clearBlock(padIdx: number): void {
    const range = this.blockRange(padIdx);
    if (!range) return;
    this.beginHistoryBatch();
    try { for (let i = range[1]; i >= range[0]; i--) this.clearPad(i); } finally { this.endHistoryBatch(); }
  }

  // ── MIXER ROUTING — one mixer strip per SOURCE ─────────────────────────────
  // The main track plays through the SAMPLE strip ('sample'). Every other
  // source (a recording, a file, a link on a pad) gets its own strip the
  // moment it appears — 'sample2', 'sample3'… (label "SAMPLE n", numbering
  // never reused) — and all its pads/chops play through it. A pad can be
  // re-routed to any strip (padRoutes) or to a fresh one. Voices connect to
  // the route's bus; the desktop view wires each bus into its mixer strip
  // (routeOutput). Without a mixer (the phone) everything stays on chopGain.
  private sourceRoutes = new Map<string, string>();
  private padRoutes = new Map<number, string>();
  private nextSampleTrack = 2;
  private routeBuses = new Map<string, GainNode>();
  /** Fires when a route is created / dropped / a pad is re-routed — the view
   *  syncs mixer strips from it (also runs on emit, this is the eager path). */
  onRoutesChanged: (() => void) | null = null;
  /** A one-line note for the status bar (the view wires it to flash): the
   *  engine REFUSED something the player expected to land — say why. */
  onNote: ((msg: string) => void) | null = null;

  /** Where a pad plays: its own route, else its source's default, else SAMPLE. */
  padRoute(padIdx: number): string {
    const own = this.padRoutes.get(padIdx);
    if (own) return own;
    const key = this.padSourceKey(padIdx);
    if (key && key !== 'main') return this.sourceRoutes.get(key) ?? 'sample';
    return 'sample';
  }
  /** Strips at least one occupied pad plays through — live truth for pruning. */
  routesInUse(): Set<string> { return new Set(Object.values(this.occupiedPadRoutes())); }
  /** Occupied pads playing through a strip (cheap — no state clone). */
  padsOnRoute(route: string): number[] {
    return Object.entries(this.occupiedPadRoutes()).filter(([, r]) => r === route).map(([i]) => Number(i));
  }
  private occupiedPadRoutes(): Record<number, string> {
    const out: Record<number, string> = {};
    const hi = this.lastOccupiedPad();
    for (let i = 0; i <= hi; i++) if (this.padSourceKey(i)) out[i] = this.padRoute(i);
    return out;
  }
  /** Give a source its default strip if it has none yet. */
  private ensureSourceRoute(key: string): string {
    if (key === 'main') return 'sample';
    let r = this.sourceRoutes.get(key);
    if (!r) { r = `sample${this.nextSampleTrack++}`; this.sourceRoutes.set(key, r); this.onRoutesChanged?.(); }
    return r;
  }
  /** A brand-new strip name (right-click → New mixer track). */
  newRouteName(): string { return `sample${this.nextSampleTrack++}`; }
  /** Route one pad (or its whole block) to a strip. `route` = 'sample',
   *  'sampleN', or 'new' for a fresh strip. */
  setPadRoute(padIdx: number, route: string, wholeBlock = false): void {
    const range = wholeBlock ? this.blockRange(padIdx) : null;
    const [lo, hi] = range ?? [padIdx, padIdx];
    const list: number[] = [];
    for (let i = lo; i <= hi; i++) list.push(i);
    this.setPadsRoute(list, route);
  }
  /** Multi-pad routing (shift-selected pads): same as setPadRoute, but 'new'
   *  resolves ONCE so every pad lands on the SAME fresh strip. */
  setPadsRoute(padIdxs: number[], route: string): void {
    this.pushHistory();
    const r = route === 'new' ? this.newRouteName() : route;
    const picked = new Set<number>(padIdxs);
    for (const i of padIdxs) {
      const key = this.padSourceKey(i);
      // The pick covers the WHOLE group (a fresh duplicate alone in its group,
      // or a block that is the group) → it becomes the GROUP's strip, so every
      // chop cut from these pads afterwards follows it (his grouping rule).
      if (key && key !== 'main' && this.padsInGroup(key).every(p => picked.has(p))) {
        this.sourceRoutes.set(key, r);
        this.padRoutes.delete(i);
        continue;
      }
      // Back on the group's own default → drop the override rather than pin it.
      const def = key && key !== 'main' ? this.sourceRoutes.get(key) : 'sample';
      if (def === r) this.padRoutes.delete(i); else this.padRoutes.set(i, r);
    }
    this.onRoutesChanged?.();
    this.emit();
  }
  /** Every strip name in play: sources' defaults + pad overrides. */
  routeNames(): string[] {
    const set = new Set<string>(['sample']);
    for (const r of this.sourceRoutes.values()) set.add(r);
    for (const r of this.padRoutes.values()) set.add(r);
    return [...set].sort((a, b) => (a === 'sample' ? -1 : b === 'sample' ? 1 : Number(a.slice(6)) - Number(b.slice(6))));
  }
  /** Which sources default to a route (for the strip's colour/title). */
  sourcesOnRoute(route: string): string[] {
    const out: string[] = [];
    for (const [k, r] of this.sourceRoutes) if (r === route) out.push(k);
    return out;
  }
  /** The bus a route's voices sum into. Created on demand; carries chop level ×
   *  NORM exactly like chopGain so a re-routed pad keeps its level. The view
   *  connects it to the matching mixer strip. */
  routeOutput(route: string): GainNode {
    let g = this.routeBuses.get(route);
    if (!g) {
      g = this.ctx.createGain();
      g.gain.value = this.chopVolume * this.normalizeGain;
      this.routeBuses.set(route, g);
    }
    return g;
  }
  /** Where a pad's voice connects: SAMPLE (the internal chain → 'sample'
   *  strip) or its route's bus. No mixer attached (phone) → everything on
   *  chopGain, so the phone hears every source. */
  private busFor(padIdx: number): AudioNode {
    if (!this.mixerEngine) return this.chopGain;
    const r = this.padRoute(padIdx);
    return r === 'sample' ? this.chopGain : this.routeOutput(r);
  }
  /** Forget the source defaults that point at a strip the view just removed
   *  (unused + pristine) so nothing re-creates it; a source that comes back
   *  later gets a fresh number. */
  dropRoute(route: string): void {
    let changed = false;
    for (const [k, r] of [...this.sourceRoutes]) if (r === route) { this.sourceRoutes.delete(k); changed = true; }
    for (const [i, r] of [...this.padRoutes]) if (r === route) { this.padRoutes.delete(i); changed = true; }
    if (this.routeBuses.has(route)) { try { this.routeBuses.get(route)!.disconnect(); } catch { /* */ } this.routeBuses.delete(route); }
    if (changed) this.onRoutesChanged?.();
  }
  /** Drop route bookkeeping for a pad whose content is gone / replaced. */
  private forgetPadRoute(padIdx: number): void { if (this.padRoutes.delete(padIdx)) this.onRoutesChanged?.(); this.padChoke.delete(padIdx); }

  // ── MUTE GROUPS — who cuts whom ────────────────────────────────────────────
  // Default = one group per SOURCE: chops of the same sample choke each other
  // (they must — that is how chopping sounds right), different sources leave
  // each other alone. A pad can be moved to another source's group, a fresh
  // group ('grpN'), or 'none' (polyphonic — nothing cuts it, it cuts nothing).
  // The live pads and the sequencer both honour it; drums choke on their own.
  private padChoke = new Map<number, string>();
  private nextChokeGroup = 1;
  chokeGroupOf(padIdx: number): string {
    const own = this.padChoke.get(padIdx);
    if (own) return own;
    return this.padSourceKey(padIdx) ?? 'none';
  }
  private occupiedPadChoke(): Record<number, string> {
    const out: Record<number, string> = {};
    const hi = this.lastOccupiedPad();
    for (let i = 0; i <= hi; i++) if (this.padSourceKey(i)) out[i] = this.chokeGroupOf(i);
    return out;
  }
  /** Groups currently in play (a pad is in each), with a display label. */
  chokeGroups(): Array<{ id: string; label: string }> {
    const ids = new Set<string>();
    const hi = this.lastOccupiedPad();
    for (let i = 0; i <= hi; i++) { const g = this.chokeGroupOf(i); if (g !== 'none' && this.padSourceKey(i)) ids.add(g); }
    return [...ids].map(id => ({ id, label: this.chokeGroupLabel(id) }))
      .sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true }));
  }
  chokeGroupLabel(id: string): string {
    if (id === 'none') return 'No group (polyphonic)';
    if (id === 'main') return 'SAMPLE 1 (main)';
    // Named after the SOURCE (its title), never its mixer route: routes move,
    // two sources can share a strip, and the main strip has no number to slice.
    if (id.startsWith('src:')) { const t = this.groupLabel(id); return t.length > 28 ? t.slice(0, 27) + '…' : t; }
    if (id.startsWith('grp:')) return `GROUP ${id.slice(4)}`;   // a pad GROUP (setPadGroup / duplicate to new group)
    if (id.startsWith('grp')) return `GROUP ${id.slice(3)}`;    // a custom mute group (setPadChoke 'new')
    return id;
  }
  /** Put a pad (or its whole block) in a group: an id from chokeGroups(),
   *  'new' for a fresh custom group, or 'none' for polyphonic. Choosing the
   *  pad's own source group drops the override. */
  setPadChoke(padIdx: number, group: string, wholeBlock = false): void {
    const range = wholeBlock ? this.blockRange(padIdx) : null;
    const [lo, hi] = range ?? [padIdx, padIdx];
    const list: number[] = [];
    for (let i = lo; i <= hi; i++) list.push(i);
    this.setPadsChoke(list, group);
  }
  /** Multi-pad mute-group assign (shift-selected pads): 'new' resolves ONCE so
   *  every pad joins the SAME fresh group — they choke each other. */
  setPadsChoke(padIdxs: number[], group: string): void {
    this.pushHistory();
    const g = group === 'new' ? `grp${this.nextChokeGroup++}` : group;
    for (const i of padIdxs) {
      const def = this.padSourceKey(i) ?? 'none';
      if (g === def) this.padChoke.delete(i); else this.padChoke.set(i, g);
    }
    this.emit();
  }
  // ── PER-SOURCE waveform settings — ATTACK · PITCH · REV · RESET ───────────
  // The waveform bar acts on the source ON SCREEN (his call, 2026-08-19): the
  // main track uses masterState (attack/pitch/reverseSample) as always; every
  // pad source carries its own trio, keyed by source, that all of its pads
  // and chops play with — live, in the sequencer and in exports.
  private sourceFx = new Map<string, { attack?: number; pitch?: number; fine?: number; reverse?: boolean }>();
  /** `pitch` = semitones (the PITCH/TEMPO knob), `fine` = cents (the FINE knob,
   *  ±50). Playback uses pitch + fine/100 — see pitchFor. */
  sourceSettings(key: string): { attack: number; pitch: number; fine: number; reverse: boolean } {
    if (key === 'main') return { attack: this.masterState.attack, pitch: this.masterState.pitch, fine: this.masterState.fine ?? 0, reverse: this.reverseSample };
    const f = this.sourceFx.get(key);
    return { attack: f?.attack ?? this.masterState.attack, pitch: f?.pitch ?? 0, fine: f?.fine ?? 0, reverse: f?.reverse ?? false };
  }
  private padSourceFx(padIdx: number): { attack: number; pitch: number; fine: number; reverse: boolean } {
    // Per GROUP: the pad's group key (its own source, or the group it was moved
    // into) owns ATTACK / PITCH / FINE / REV — 'main' only for the main track's
    // own block.
    const key = this.padSourceKey(padIdx) ?? 'main';
    return this.sourceSettings(key);
  }
  attackFor(padIdx: number): number { return this.padSourceFx(padIdx).attack; }
  /** Effective pitch in semitones for playback/export: PITCH + FINE/100. */
  pitchFor(padIdx: number): number { const f = this.padSourceFx(padIdx); return f.pitch + f.fine / 100; }
  /** REV for playback/export: the pad's own override if it has one, else its
   *  SOURCE's REV. Single choke point — live voices, the sequencer, offline
   *  renders, patternToEvents and per-pad exports all read this. */
  reversedFor(padIdx: number): boolean { return this.pads[padIdx]?.reverse ?? this.padSourceFx(padIdx).reverse; }
  /** The pad's own REV override, or undefined when it follows its source. */
  padReverse(padIdx: number): boolean | undefined { return this.pads[padIdx]?.reverse; }
  /** True when this pad is flipped the opposite way to its source (what the
   *  pad badge shows). */
  padReverseOverridden(padIdx: number): boolean {
    const own = this.pads[padIdx]?.reverse;
    return own !== undefined && own !== this.padSourceFx(padIdx).reverse;
  }
  /** Set/clear the per-pad REV override — one undo step, one emit, whatever the
   *  selection size (mirrors setPadsStems). `rev === null` clears the override
   *  so the pad follows its source again. A ringing voice keeps its direction;
   *  the next hit plays the new one (reverse is baked into the buffer). */
  setPadsReverse(padIdxs: number[], rev: boolean | null): void {
    // Asking for the direction the pad's SOURCE already plays clears the
    // override instead of freezing a duplicate of it — so flipping a pad back
    // makes it follow the source again (and a later source-wide REV moves it).
    const want = (i: number): boolean | undefined =>
      rev === null || rev === this.padSourceFx(i).reverse ? undefined : rev;
    const hit = padIdxs.filter(i => this.pads[i] && this.pads[i].reverse !== want(i));
    if (!hit.length) return;
    this.pushHistory();
    for (const i of hit) this.pads[i].reverse = want(i);
    this.emit();
  }
  /** Flip the pads' effective direction: each lands on the opposite of what it
   *  plays right now, as an explicit override. */
  togglePadsReverse(padIdxs: number[]): boolean | null {
    const live = padIdxs.filter(i => this.pads[i]);
    if (!live.length) return null;
    // One shared target so a mixed selection ends up consistent, not scrambled.
    const next = !this.reversedFor(live[0]);
    this.setPadsReverse(live, next);
    return next;
  }
  setSourceAttack(key: string, s: number): void {
    if (key === 'main') { this.setAttack(s); return; }
    this.sourceFx.set(key, { ...this.sourceFx.get(key), attack: Math.max(0, Math.min(0.5, s)) }); this.emit();
  }
  setSourcePitch(key: string, semis: number): void {
    if (key === 'main') { this.setMasterPitch(semis); return; }
    this.sourceFx.set(key, { ...this.sourceFx.get(key), pitch: Math.max(-24, Math.min(24, semis)) }); this.emit();
  }
  /** FINE tune in cents (−50..50) on top of PITCH — main sample or a pad source. */
  setSourceFine(key: string, cents: number): void {
    const c = Math.max(-50, Math.min(50, Math.round(cents)));
    if (key === 'main') { this.masterState.fine = c; this.emit(); return; }
    this.sourceFx.set(key, { ...this.sourceFx.get(key), fine: c }); this.emit();
  }
  toggleSourceReverse(key: string): void {
    if (key === 'main') { this.toggleReverseSample(); return; }
    this.pushHistory();
    const cur = this.sourceFx.get(key)?.reverse ?? false;
    this.sourceFx.set(key, { ...this.sourceFx.get(key), reverse: !cur }); this.emit();
  }
  /** RESET for a pad source: back to ONE pad holding the whole audio — the
   *  lowest pad of the source keeps it (full trim), its other pads empty. */
  resetPadSource(padIdx: number): number | null {
    const pb = this.padBuffers.get(padIdx);
    if (!pb) return null;
    const pads = this.padSourceChops(padIdx).map(c => c.padIdx);
    if (pads.length === 0) return null;
    this.pushHistory();
    this.stopAllPads();
    const keep = Math.min(...pads);
    for (const i of pads) if (i !== keep) { this.padBuffers.delete(i); this.forgetPadRoute(i); }
    const k = this.padBuffers.get(keep)!;
    k.start = 0; k.end = k.buffer.duration;
    this.pads.length = Math.max(this.lastOccupiedPad() + 1, 1);
    this.emit();
    return keep;
  }
  /** Stop every ringing voice in this pad's group (mono choke within a
   *  group). A polyphonic pad ('none') chokes nothing but itself. */
  private chokeGroup(padIdx: number): void {
    const g = this.chokeGroupOf(padIdx);
    if (this.voices.size === 0) return;
    for (const idx of [...this.voices.keys()]) {
      if (idx === padIdx || (g !== 'none' && this.chokeGroupOf(idx) === g)) this.stopVoice(idx);
    }
    this.emitActivity();
  }

  // ── Subscriptions ──────────────────────────────────────────────────────────

  subscribe(handler: (s: ChopperState) => void): () => void {
    this.listeners.add(handler);
    handler(this.getState());
    return () => { this.listeners.delete(handler); };
  }

  /** Coalesced: the full-state push (a deep clone of pads/chops/grids/all
   *  sequences + a whole-view React commit, 12–46 ms measured) is flushed at
   *  most ONCE per animation frame, keep-latest. Every setter used to emit
   *  synchronously — a knob or boundary drag on a 120 Hz mouse was 100+ full
   *  clones + renders a second, and every live-recorded hit paid one too. The
   *  audio side is already applied before any setter emits, so sound is
   *  unaffected; the UI just stops re-rendering faster than it can paint. */
  private emit(): void {
    // The activity channel stays synchronous — it's cheap, change-gated, and
    // is what pad LEDs / the waveform overlay read.
    this.emitActivity();
    if (this.listeners.size === 0 || this.emitScheduled) return;
    this.emitScheduled = true;
    const flush = () => {
      this.emitScheduled = false;
      const s = this.getState();
      for (const h of this.listeners) h(s);
    };
    // rAF pauses in a hidden tab / minimised window; fall back to a task so a
    // background export or MIDI-driven change still reaches the view.
    if (typeof requestAnimationFrame === 'function' && typeof document !== 'undefined' && !document.hidden) {
      requestAnimationFrame(flush);
    } else {
      setTimeout(flush, 0);
    }
  }
  private emitScheduled = false;

  // ── Pad activity (hot path) ────────────────────────────────────────────────
  // Which pads are ringing / which was hit last changes on EVERY pad trigger.
  // Pushing that through `emit()` meant one full ChopperState clone + a whole-
  // app React re-render per note (measured 12–46ms of main-thread block), and
  // Web MIDI messages are delivered on that same main thread — so a fast roll
  // queued up behind renders and every hit landed late and uneven. This channel
  // carries only the per-hit bits, so a note re-renders the pad LEDs and the
  // waveform overlay instead of the entire view.

  subscribeActivity(handler: (a: ChopperActivity) => void): () => void {
    this.activityListeners.add(handler);
    handler(this.getActivity());
    return () => { this.activityListeners.delete(handler); };
  }

  getActivity(): ChopperActivity {
    return {
      activePads: [...this.activePadSet],
      lastTriggeredPad: this.lastTriggeredPad,
      playing: this.voices.size > 0,
    };
  }

  private emitActivity(): void {
    if (this.activityListeners.size === 0) return;
    const a = this.getActivity();
    // Only push on a real change. `emit()` funnels through here too, so without
    // this every unrelated state push (a knob move, a preset load) would also
    // re-render the pad grid and waveform overlay for nothing.
    const p = this.lastActivity;
    if (p
      && p.playing === a.playing
      && p.lastTriggeredPad === a.lastTriggeredPad
      && p.activePads.length === a.activePads.length
      && p.activePads.every((v, i) => v === a.activePads[i])) return;
    this.lastActivity = a;
    for (const h of this.activityListeners) h(a);
  }

  /** Graph→speaker delay in SECONDS — the one definition.
   *
   *  `outputLatency` is the FULL graph→speaker delay and already INCLUDES
   *  `baseLatency`; summing the two double-counts baseLatency and pulls the
   *  playhead/chop systematically early. So: use outputLatency alone when the
   *  browser reports it, and fall back to a ~20ms device buffer + baseLatency
   *  when it doesn't (Safari returns 0/undefined).
   *
   *  Both the playhead and the latency readout read this, so what the meter
   *  claims and what the playhead compensates for can never drift apart. */
  private hwLatencySec(): number {
    const outLat = this.ctx.outputLatency ?? 0;
    return outLat > 0 ? outLat : (0.02 + (this.ctx.baseLatency ?? 0));
  }

  /** True when the browser actually reported outputLatency, rather than us
   *  falling back to the 20ms estimate — the readout says which it is, because
   *  an estimate presented as a measurement is worse than no number. */
  private hwLatencyMeasured(): boolean {
    return (this.ctx.outputLatency ?? 0) > 0;
  }

  // ── Input→handler lag instrumentation ──────────────────────────────────────
  // A MIDI note-on carries the timestamp of when the message actually arrived.
  // The gap between that and the moment our handler runs is time the hit spent
  // queued behind whatever else the main thread was doing — waveform repaints,
  // React renders, the sequencer tick. It is the half of "latency" that IS
  // ours to fix, as opposed to the output buffer, which mostly is not.
  private inputLagSamples: number[] = [];
  private static readonly LAG_WINDOW = 48;

  /** Record how long an input event waited before its handler ran. Called on
   *  MIDI note-on; harmless to call with an undefined timestamp. */
  recordInputLag(eventTimestamp?: number): void {
    if (eventTimestamp === undefined || !(eventTimestamp > 0)) return;
    const lag = (performance.now() - eventTimestamp) / 1000;
    // Discard nonsense: a negative delta (clock skew / a different time origin)
    // or an implausible one. Better to report nothing than to report a lie.
    if (!Number.isFinite(lag) || lag < 0 || lag > 0.5) return;
    this.inputLagSamples.push(lag);
    if (this.inputLagSamples.length > ChopperEngine.LAG_WINDOW) this.inputLagSamples.shift();
  }

  /** What the player is actually up against, in milliseconds.
   *
   *  `input` is the MEDIAN of recent hits, not the mean — one 80ms stall while
   *  a big sample decoded should not brand the whole rig as laggy. `worst` is
   *  reported alongside precisely so that stall is still visible. */
  getLatencyReport(): {
    outputMs: number; inputMs: number; worstMs: number;
    totalMs: number; samples: number; outputMeasured: boolean;
  } {
    const outputMs = this.hwLatencySec() * 1000;
    const s = this.inputLagSamples;
    let inputMs = 0, worstMs = 0;
    if (s.length > 0) {
      const sorted = [...s].sort((a, b) => a - b);
      inputMs = sorted[Math.floor(sorted.length / 2)] * 1000;
      worstMs = sorted[sorted.length - 1] * 1000;
    }
    return {
      outputMs, inputMs, worstMs,
      totalMs: outputMs + inputMs,
      samples: s.length,
      outputMeasured: this.hwLatencyMeasured(),
    };
  }

  /** Drop the collected samples — used when the readout is reset so a figure
   *  from an old session/device is never shown against a new one. */
  resetInputLag(): void { this.inputLagSamples = []; }

  /** Current playback position (seconds into the original buffer) of the first
   *  active voice, or -1 if nothing is playing. Subtracts output + buffer
   *  latency so the value tracks what the user is actually HEARING.
   *
   *  This is the SINGLE source of truth for both the drawn playhead (getState)
   *  and chop-at-playhead placement (sliceAtCurrentPosition), so a dropped chop
   *  lands exactly where the playhead is shown — no formula drift between them. */
  private getPlaybackPos(): number {
    const hwLatency = this.hwLatencySec();
    // With mute groups several voices can ring at once (two sources): the
    // playhead follows the LAST pad you hit — the one whose source the
    // waveform is showing — not whichever voice happens to be first in the map.
    const preferred = this.lastTriggeredPad !== null ? this.voices.get(this.lastTriggeredPad) : undefined;
    const list: Array<[number, PadVoice]> = preferred ? [[this.lastTriggeredPad!, preferred]] : [...this.voices];
    for (const [, v] of list) {
      // Advance at the voice's true playback rate (pitch = varispeed). Folding
      // the rate into elapsed keeps all three branches correct: a pad pitched
      // +12 semitones (rate 2) sweeps its chop in half the time.
      const rate = v.playbackRate ?? 1;
      let elapsed = Math.max(0, this.ctx.currentTime - v.startCtxTime - hwLatency) * rate;
      // LOOP: after the intro pass the playhead goes round on the loop period.
      if (v.loopPeriod !== undefined && v.loopPeriod > 0) {
        // Follow the NEWEST pass: warm-up passes start every period from 0.
        elapsed = elapsed % v.loopPeriod;
      }
      const off = v.posOffset ?? 0; // stem slices play in their own coordinates
      if (v.reverseOrigEnd !== undefined) {
        // Reversed playback — playhead sweeps backwards through the original buffer
        return v.reverseOrigEnd - elapsed;
      } else if (v.originalChopStart !== undefined && v.stretchRatio !== undefined) {
        return v.originalChopStart + off + elapsed * v.stretchRatio;
      }
      return v.chopStart + off + elapsed;
    }
    return -1;
  }

  /** Predicted DISPLAY position of the playhead: the true playback position led
   *  forward ~1 frame to cancel render lag, so the drawn dot tracks the sound.
   *  Read every frame by the waveform's own rAF (no React state / no array
   *  cloning). Chop placement uses getPlaybackPos() — the un-led TRUE position —
   *  so chops stay accurate while the dot stays visually locked. Returns -1 when
   *  nothing is playing. */
  getPlayheadPos(): number {
    const raw = this.getPlaybackPos();
    return raw >= 0 ? raw + 0.016 : -1; // ~1 frame @ 60fps display lead; tune to taste
  }

  getState(): ChopperState {
    const playbackPos = this.getPlayheadPos();

    return {
      hasBuffer: this.buffer !== null,
      trimCount: this.trims.length,
      trimmedSec: totalTrimmedSec(this.trims),
      bufferDuration: this.buffer?.duration ?? 0,
      normalizeOn: this.normalizeOn,
      normalizeGain: this.normalizeGain,
      sourceNorm: Object.fromEntries(this.sourceNorm),
      trackTitle: this.trackTitle,
      bpm: this.bpm,
      chops: [...this.chops],
      pads: this.pads.map(p => ({ ...p })),
      padBufferMeta: Object.fromEntries(
        Array.from(this.padBuffers.entries()).map(([idx, pb]) => [
          idx, { videoId: pb.videoId, title: pb.title, start: pb.start, end: pb.end }
        ])
      ),
      padRoutes: this.occupiedPadRoutes(),
      sourceRoutes: Object.fromEntries(this.sourceRoutes),
      padGroups: Object.fromEntries(this.padGroups),
      groups: this.groups(),
      padChoke: this.occupiedPadChoke(),
      sourceFx: Object.fromEntries(Array.from(this.sourceFx.entries()).map(([k, v]) => [k, { ...v }])),
      selectedPad: this.selectedPad,
      selectedChopStart: (() => {
        if (!this.buffer || this.selectedPad === null) return 0;
        const p = this.pads[this.selectedPad];
        if (!p || p.chopId === null) return 0;
        const c = this.chops.find(ch => ch.id === p.chopId);
        return c ? c.start / this.buffer.duration : 0;
      })(),
      activePads: [...this.activePadSet],
      chopMode: this.chopMode,
      snapMode: this.snapMode,
      transients: this.transients,
      transientCount: this.transients.length,
      transientSensitivity: this.transientSensitivity,
      acDrumsOnly: this.acDrumsOnly,
      lastTriggeredPad: this.lastTriggeredPad,
      lastSlicedChopId: this.lastSlicedChopId,
      playbackPos,
      master: { ...this.masterState },
      metronome: {
        enabled: this.metronomeEnabled,
        bpm: this.metronomeBpm,
        sound: this.metronomeSound,
        beat: this.metronomeBeat,
      },
      stretchEnabled: this.stretchEnabled,
      targetBpm: this.targetBpm,
      chopOffsetMs: this.chopOffsetMs,
      isLoaded: this.buffer !== null,
      isLoading: this.isLoading,
      recording: this.recording,
      liveRecording: this.liveRecording,
      countInBeat: this.countInBeat,
      countInEnabled: this.countInEnabled,
      inputQuantize: this.inputQuantize,
      timeline: [...this.timeline],
      timelinePlaying: this.timelinePlaying,
      timelineLoop: this.timelineLoop,
      timelineLength: this.timelineLength,
      seqBars: this.seqBars,
      seqResolution: this.seqResolution,
      seqViewResolution: this.seqViewResolution,
      seqGrid: this.seqGrid.map(row => row ? [...row] : []),
      seqRevGrid: this.seqRevGrid.map(row => row ? [...row] : []),
      seqVelGrid: this.seqVelGrid.map(row => row ? [...row] : []),
      seqSwing: this.seqSwing,
      seqPlaying: this.seqPlaying,
      seqPaused: this.seqPaused,
      seqLoop: this.seqLoop,
      seqStep: this.seqStep,
      recordStep: this.recordStep,
      sequences: this.snapshotSequences(),
      currentSeqIdx: this.currentSeqIdx,
      playingSeqIdx: this.playingSeqIdx,
      queuedSeqIdx: this.queuedSeqIdx,
      arpEnabled: this.arpEnabled,
      arpRate: this.arpRate,
      arpDirection: this.arpDirection,
      arpRandom: this.arpRandom,
      arpHoldPad: this.arpHoldPad,
      reverseSample: this.reverseSample,
      extraFX: {
        clipper:    { amount: this.clipper.amount, drive: this.clipper.drive, mix: this.clipper.mix, bypassed: this.clipper.bypassed },
        waveshaper: { drive: this.waveshaper.drive, mix: this.waveshaper.mix, bypassed: this.waveshaper.bypassed },
        saturator:  { drive: this.saturator.drive, mix: this.saturator.mix, lowFreq: this.saturator.lowFreq, highFreq: this.saturator.highFreq, bypassed: this.saturator.bypassed },
        widener:    { width: this.widener.width, mix: this.widener.mix, bypassed: this.widener.bypassed },
        mseq:       { midFreq: this.mseq.midFreq, midGain: this.mseq.midGain, sideFreq: this.mseq.sideFreq, sideGain: this.mseq.sideGain, mix: this.mseq.mix, bypassed: this.mseq.bypassed },
        bitcrusher: { bits: this.bitcrusher.bits, rate: this.bitcrusher.rate, mix: this.bitcrusher.mix, bypassed: this.bitcrusher.bypassed },
        autopan:    { rate: this.autopan.rate, depth: this.autopan.depth, mix: this.autopan.mix, bypassed: this.autopan.bypassed },
        trancegate: { rate: this.trancegate.rate, depth: this.trancegate.depth, attack: this.trancegate.attack, release: this.trancegate.release, mix: this.trancegate.mix, bypassed: this.trancegate.bypassed },
        chorus:     { rate: this.chorus.rate, depth: this.chorus.depth, mix: this.chorus.mix, bypassed: this.chorus.bypassed },
      },
    };
  }

  // ── Loading ────────────────────────────────────────────────────────────────

  setLoading(b: boolean): void { this.isLoading = b; this.emit(); }

  /** Decode audio bytes into an AudioBuffer robustly. Resumes a suspended /
   *  iOS-"interrupted" context first (a parked context makes decodeAudioData
   *  fail intermittently), always decodes a COPY so the caller's ArrayBuffer
   *  can't be detached/reused into a failure, and surfaces a clear, actionable
   *  message instead of the browser's bare "decoding failed". */
  async decodeAudio(ab: ArrayBuffer): Promise<AudioBuffer> {
    if (this.ctx.state !== 'running') { try { await this.ctx.resume(); } catch { /* */ } }
    if (!ab || ab.byteLength === 0) throw new Error('Empty audio — the download may have failed. Try again.');
    try {
      return await this.ctx.decodeAudioData(ab.slice(0));
    } catch {
      throw new Error('Could not decode this audio — it may be an unsupported format or a partial download. Try again, or use a WAV/MP3.');
    }
  }

  async loadFromArrayBuffer(ab: ArrayBuffer, title: string): Promise<void> {
    if (this.ctx.state !== 'running') await this.ctx.resume();
    const decoded = await this.decodeAudio(ab);
    await this.installMainBuffer(decoded, title);
  }
  /** An already-decoded buffer as the MAIN track — the pad-menu ↥ MAKE MAIN
   *  TRACK (a pad's own sample, e.g. a YouTube link, promoted so STEMS can
   *  split it). Byte-identical to a file load from here on. */
  async loadFromAudioBuffer(buffer: AudioBuffer, title: string): Promise<void> {
    if (this.ctx.state !== 'running') await this.ctx.resume();
    await this.installMainBuffer(buffer, title);
  }
  private async installMainBuffer(decoded: AudioBuffer, title: string): Promise<void> {
    // Snapshot the outgoing sample first so undo can bring it (and its chops)
    // back if the user doesn't like the new one. Only when there's actually a
    // previous sample to return to.
    if (this.buffer) this.pushHistory();
    this.buffer = decoded;
    this.fileBuffer = decoded; // a NEW sample starts untrimmed
    this.trims = [];
    this.refreshNormalize();
    this.trackTitle = title;
    this.transients = new Float32Array(0);
    this.transientStrengths = new Float32Array(0);
    this.broadbandTransients = new Float32Array(0);
    this.broadbandStrengths = new Float32Array(0);
    this.drumTransients = new Float32Array(0);
    this.drumStrengths = new Float32Array(0);
    this.bpm = 0;
    this.stretchCache.clear();
    this.targetBpm = 0;
    this.reverseBuffer = null;
    this.clearStems(true); // stems belong to the sample — masks reset with it
    this.stopSeq();          // flush old scheduled chop audio + choke timers before the swap
    this.stopAllPads();
    // A new MAIN track keeps the pads' own sources (recordings, files, links
    // on pads) — autoChop lays the main block and pushes them aside. Loading a
    // PROJECT replaces them: loadPreset clears, restorePadSamples refills.
    this.autoChop(1, this.detectSilenceEnd(decoded));
    this.emit(); // waveform visible immediately

    // Defer CPU-heavy analysis so the UI renders first
    await tick();
    if (this.fileBuffer !== decoded) return; // a trim mid-analysis keeps the same source
    const det = this.detectTransients(decoded);
    this.broadbandTransients = det.times;
    this.broadbandStrengths = det.strengths;
    const drum = this.detectDrumTransients(decoded);
    this.drumTransients = drum.times;
    this.drumStrengths = drum.strengths;
    this.mapDetectedTransientsToTrims(); // detection ran on the ORIGINAL
    this.applyActiveTransients();
    this.emit(); // transient markers appear

    await tick();
    if (this.fileBuffer !== decoded) return; // a trim mid-analysis keeps the same source
    const bpm = await estimateBPMAsync(decoded);
    if (this.fileBuffer !== decoded) return; // a trim mid-analysis keeps the same source
    if (bpm > 0) {
      this.bpm = bpm;
      this.targetBpm = bpm;
      if (this.metronomeBpm === 0 || this.metronomeBpm === 120) this.metronomeBpm = bpm;
      this.emit(); // BPM shown
    }
  }

  private detectSilenceEnd(buf: AudioBuffer, threshold = 0.015, windowFrames = 256): number {
    const ch0 = buf.getChannelData(0);
    const ch1 = buf.numberOfChannels > 1 ? buf.getChannelData(1) : ch0;
    for (let i = 0; i < ch0.length - windowFrames; i += windowFrames) {
      let rms = 0;
      for (let j = 0; j < windowFrames; j++) {
        const s = (ch0[i + j] + ch1[i + j]) * 0.5;
        rms += s * s;
      }
      if (Math.sqrt(rms / windowFrames) > threshold) return i / buf.sampleRate;
    }
    return 0;
  }

  // ── Chops ──────────────────────────────────────────────────────────────────

  clearAllChops(): void {
    this.pushHistory();
    this.stopAllPads();
    // DEL ALL clears the MAIN track's chops. Pads that carry their own source
    // (a recording, a file, a link) are not chops of it — they stay.
    this.chops = [];
    for (const p of this.pads) if (p) p.chopId = null;
    this.pads.length = Math.max(0, this.lastOccupiedPad() + 1);
    this.lastSlicedChopId = null;
    this.emit();
  }

  /** Wipe the whole chopper session back to empty — used by File → New Project.
   *  Drops the loaded sample/buffer, every chop + pad + per-pad buffer, and the
   *  step sequence, and stops the transport + any ringing voices. Drums and the
   *  DAW mixer live in separate engines, so the view resets those alongside. */
  clearAll(): void {
    this.pushHistory();
    this.stopSeq();
    this.stopAllPads();
    this.buffer = null;
    this.fileBuffer = null;
    this.trims = [];
    this.clearStems(true);
    this.trackTitle = '';
    this.chops = [];
    this.pads = [];
    this.padBuffers.clear();
    this.sourceNorm.clear();
    this.sourceRoutes.clear(); this.padRoutes.clear(); this.padGroups.clear(); this.nextSampleTrack = 2; this.nextGroupNo = 2;
    this.padChoke.clear(); this.nextChokeGroup = 1; this.sourceFx.clear();
    this.onRoutesChanged?.();
    this.lastSlicedChopId = null;
    this.seqGrid = [];
    this.seqRevGrid = [];
    this.seqVelGrid = [];
    this.syncCurrentToArray();
    this.emit();
  }

  autoChop(n: number, startOffset = 0): void {
    if (!this.buffer) return;
    this.pushHistory();
    this.stopAllPads();
    this.lastSlicedChopId = null;
    const dur = this.buffer.duration;
    const usable = dur - startOffset;
    const step = usable / n;
    const oldChops = this.chops;
    const oldMask = new Map<number, number | undefined>();
    for (const p of this.pads) if (p?.chopId != null) oldMask.set(p.chopId, p.stems);
    this.chops = Array.from({ length: n }, (_, i) => ({
      id: this.nextChopId++,
      start: startOffset + i * step,
      end: startOffset + (i + 1) * step,
    }));
    // The main track's chops form ITS block: they land where its chops sat
    // (or the first empty pad), and any pad-source blocks in the way are
    // pushed right — never overwritten. Sequencer steps that pointed at the
    // k-th chop pad keep pointing at the k-th chop pad.
    const oldChopIdx: number[] = [];
    for (let i = 0; i < this.pads.length; i++) if (this.pads[i]?.chopId != null && !this.padBuffers.has(i)) oldChopIdx.push(i);
    const lo = oldChopIdx.length ? oldChopIdx[0] : this.nextSlotForSource('main');
    // Each new chop inherits the stem mask of the OLD chop its start fell in
    // (stems carry over, his rule) — re-chopping never silently brings layers back.
    const maskAt = (t: number): number | undefined => {
      const old = oldChops.find(c => t >= c.start && t < c.end);
      return old ? oldMask.get(old.id) : undefined;
    };
    const items: PadSlot[] = this.chops.map(c => ({ kind: 'chop', chopId: c.id, pitch: 0, mode: 'oneshot', stems: maskAt(c.start) }));
    this.rearrange((slots, origin) => {
      for (const i of oldChopIdx) { slots[i] = null; origin[i] = -1; }
      ChopperEngine.insertPushing(slots, origin, lo, items);
      for (let k = 0; k < items.length; k++) origin[lo + k] = oldChopIdx[k] ?? -1;
    });
    // Trim trailing empty pads (the old behaviour left exactly n pads).
    this.pads.length = Math.max(this.lastOccupiedPad() + 1, 1);
    // New chop set → pre-warm stretched buffers in the background if stretch is on.
    this._kickWarmAllChops();
    this.emit();
  }

  /** Toggle drum-only auto-chop. Swaps the active transient set between the
   *  broadband detector and the banded kick/snare detector. Both sets are
   *  cached on load so this is instant — no re-analysis. */
  toggleAcDrumsOnly(): void {
    this.acDrumsOnly = !this.acDrumsOnly;
    this.applyActiveTransients();
    this.emit();
  }

  setTransientSensitivity(sens: number): void {
    this.transientSensitivity = Math.max(0, Math.min(1, sens));
    this.emit();
  }

  /**
   * Simpler-style "Slice by Transient". Picks the top-strength transients,
   * keeping them in time order, and builds a chop between each cut. The
   * sensitivity knob (0..1) controls how many of the detected transients to
   * use — 0 keeps the whole sample as one pad, 1 cuts at every detected onset.
   */
  autoSliceTransients(sensitivity?: number): void {
    if (!this.buffer) return;
    // Live drag of the sensitivity knob fires many calls — coalesce them.
    this.pushHistory('auto-slice');
    if (sensitivity !== undefined) {
      this.transientSensitivity = Math.max(0, Math.min(1, sensitivity));
    }
    const N = this.transients.length;
    if (N === 0) {
      // Nothing detected yet (still analyzing or silent buffer) — fall back to 1 pad
      this.autoChop(1);
      return;
    }

    const sens = this.transientSensitivity;
    // Power curve so the lower half of the knob still produces useful counts.
    // Web build caps at 256 because each pad row adds React + Web Audio
    // overhead in the browser. Desktop has no cap.
    const MAX_AUTO_SLICE = __isWeb ? 256 : Infinity;
    // Scale to the EFFECTIVE max (min of detected onsets and the cap) so the
    // knob ramps smoothly up to its true max at 100% — instead of saturating
    // early when a busy sample has more onsets than the cap can hold.
    const effMax = Math.min(N, MAX_AUTO_SLICE);
    const wantCount = Math.max(
      0,
      Math.min(effMax, Math.round(effMax * Math.pow(sens, 0.7))),
    );

    // Pick the strongest `wantCount` transients, then re-sort by time
    const order = Array.from({ length: N }, (_, i) => i)
      .sort((a, b) => this.transientStrengths[b] - this.transientStrengths[a])
      .slice(0, wantCount);
    const cuts = order.map(i => this.transients[i]).sort((a, b) => a - b);

    this.stopAllPads();
    this.lastSlicedChopId = null;
    const dur = this.buffer.duration;
    const boundaries = [0, ...cuts, dur];

    const newChops: Chop[] = [];
    for (let i = 0; i < boundaries.length - 1; i++) {
      const start = boundaries[i];
      const end = boundaries[i + 1];
      if (end - start < 0.02) continue; // skip slivers
      newChops.push({ id: this.nextChopId++, start, end });
    }
    const oldChops = this.chops;
    const oldMask = new Map<number, number | undefined>();
    for (const p of this.pads) if (p?.chopId != null) oldMask.set(p.chopId, p.stems);
    this.chops = newChops;

    const nChops = this.chops.length;
    this.ensurePad(Math.max(0, nChops - 1));
    this.pads.length = nChops;
    this.pads.forEach((p, i) => {
      p.chopId = this.chops[i].id;
      // stems carry over from the old chop this one starts in
      const old = oldChops.find(c => this.chops[i].start >= c.start && this.chops[i].start < c.end);
      p.stems = old ? oldMask.get(old.id) : undefined;
    });

    // New chop set → pre-warm stretched buffers in the background if stretch is on.
    this._kickWarmAllChops();
    this.emit();
  }

  getPresetData(videoId: string): ChopPreset {
    return {
      videoId,
      savedAt: new Date().toISOString(),
      trackTitle: this.trackTitle,
      chops: this.chops.map(c => ({ id: c.id, start: c.start, end: c.end, free: c.free })),
      pads: this.pads.map(p => ({ index: p.index, chopId: p.chopId, mode: p.mode, pitch: p.pitch, ...(p.gate ? { gate: true } : {}), ...(p.fadeIn ? { fadeIn: p.fadeIn } : {}), ...(p.fadeOut ? { fadeOut: p.fadeOut } : {}), ...(p.stems !== undefined && p.stems !== MASK_ALL ? { stems: p.stems } : {}), ...(p.reverse !== undefined ? { reverse: p.reverse } : {}) })),
      padBufferMeta: Object.fromEntries(
        Array.from(this.padBuffers.entries()).map(([idx, pb]) => [
          String(idx), { videoId: pb.videoId, title: pb.title, start: pb.start, end: pb.end }
        ])
      ),
      sourceRoutes: Object.fromEntries(this.sourceRoutes),
      padGroups: Object.fromEntries(Array.from(this.padGroups.entries()).map(([k, v]) => [String(k), v])),
      padRoutes: Object.fromEntries(Array.from(this.padRoutes.entries()).map(([i, r]) => [String(i), r])),
      nextSampleTrack: this.nextSampleTrack,
      padChoke: Object.fromEntries(Array.from(this.padChoke.entries()).map(([i, g]) => [String(i), g])),
      nextChokeGroup: this.nextChokeGroup,
      sourceFx: Object.fromEntries(Array.from(this.sourceFx.entries()).map(([k, v]) => [k, { ...v }])),
      bpm: this.bpm,
      nextChopId: this.nextChopId,
      timeline: this.timeline.map(e => ({ padIdx: e.padIdx, time: e.time, duration: e.duration })),
      timelineLength: this.timelineLength,
      seqBars: this.seqBars,
      seqResolution: this.seqResolution,
      seqGrid: this.seqGrid.map(row => row ? [...row] : []),
      seqLoop: this.seqLoop,
      sequences: this.snapshotSequences(),
      currentSeqIdx: this.currentSeqIdx,
      normalize: this.normalizeOn,
      sourceNorm: Object.fromEntries(this.sourceNorm),
      normalizeGain: this.normalizeGain,
      master: { ...this.masterState },
      extraFX: {
        clipper:    { amount: this.clipper.amount, drive: this.clipper.drive, mix: this.clipper.mix, bypassed: this.clipper.bypassed },
        waveshaper: { drive: this.waveshaper.drive, mix: this.waveshaper.mix, bypassed: this.waveshaper.bypassed },
        saturator:  { drive: this.saturator.drive, mix: this.saturator.mix, lowFreq: this.saturator.lowFreq, highFreq: this.saturator.highFreq, bypassed: this.saturator.bypassed },
        widener:    { width: this.widener.width, mix: this.widener.mix, bypassed: this.widener.bypassed },
        mseq:       { midFreq: this.mseq.midFreq, midGain: this.mseq.midGain, sideFreq: this.mseq.sideFreq, sideGain: this.mseq.sideGain, mix: this.mseq.mix, bypassed: this.mseq.bypassed },
        bitcrusher: { bits: this.bitcrusher.bits, rate: this.bitcrusher.rate, mix: this.bitcrusher.mix, bypassed: this.bitcrusher.bypassed },
        autopan:    { rate: this.autopan.rate, depth: this.autopan.depth, mix: this.autopan.mix, bypassed: this.autopan.bypassed },
        trancegate: { rate: this.trancegate.rate, depth: this.trancegate.depth, attack: this.trancegate.attack, release: this.trancegate.release, mix: this.trancegate.mix, bypassed: this.trancegate.bypassed },
        chorus:     { rate: this.chorus.rate, depth: this.chorus.depth, mix: this.chorus.mix, bypassed: this.chorus.bypassed },
      },
      masterClip: this.clipAmount,
      stretchEnabled: this.stretchEnabled,
      targetBpm: this.targetBpm,
      chopOffsetMs: this.chopOffsetMs,
      reverseSample: this.reverseSample,
      chopVolume: this.chopVolume,
      metronomeBpm: this.metronomeBpm,
      inputQuantize: this.inputQuantize,
      ...(this.trims.length ? { trims: cloneTrims(this.trims) } : {}),
      ...(this.stemsMetaState ? { stems: { ...this.stemsMetaState, readyRanges: this.stemFileRanges.map(r => [...r] as [number, number]) } } : {}),
    };
  }

  loadPreset(preset: ChopPreset): void {
    // No main track is NOT a reason to drop the project: a kit of pad samples
    // (links, GET SAMPLE, recordings) with no main track used to lose its pads,
    // sequences, routes and groups here ("full beat from chopped samples", his
    // ask 2026-08-22). The buffer-dependent parts below already guard on
    // fileBuffer / buffer themselves.
    if (!this.buffer && !preset.padBufferMeta && !(preset.sequences?.length) && !(preset.seqGrid?.length)) return;
    this.stopAllPads();
    // TRIM: the loader brought back the ORIGINAL audio — re-apply the project's
    // cuts FIRST, so the chops/pads/transients below (trimmed timeline) land on
    // the right buffer. Detection results that already ran on the original get
    // mapped; ones still pending map themselves when they arrive.
    this.trims = cloneTrims(preset.trims ?? []);
    if (this.fileBuffer && (this.trims.length || this.buffer !== this.fileBuffer)) {
      this.buffer = buildEffectiveBuffer(this.ctx, this.fileBuffer, this.trims);
      this.reverseBuffer = null;
      this.stretchCache.clear();
      this.mapDetectedTransientsToTrims();
      this.applyActiveTransients();
      this.refreshNormalize();
    }
    // The project defines every pad: drop this session's pad sources (the
    // preset's own come back through restorePadSamples from padBufferMeta).
    this.padBuffers.clear();
    // Mixer routing rides in the project. Older projects: sources default to
    // fresh strips as they are restored (ensureSourceRoute).
    this.sourceRoutes = new Map(Object.entries(preset.sourceRoutes ?? {}));
    this.padRoutes = new Map(Object.entries(preset.padRoutes ?? {}).map(([k, v]) => [Number(k), v]));
    this.padGroups = new Map(Object.entries(preset.padGroups ?? {}).map(([k, v]) => [Number(k), v]));
    this.nextGroupNo = Math.max(2, ...[...this.padGroups.values(), ...this.sourceRoutes.keys()].map(k => { const m = /^grp:(\d+)$/.exec(k); return m ? Number(m[1]) + 1 : 2; }));
    this.nextSampleTrack = Math.max(preset.nextSampleTrack ?? 2, 2, ...[...this.sourceRoutes.values(), ...this.padRoutes.values()].map(r => Number(r.slice(6)) + 1).filter(n => Number.isFinite(n)));
    this.onRoutesChanged?.();
    this.padChoke = new Map(Object.entries(preset.padChoke ?? {}).map(([k, v]) => [Number(k), v]));
    this.sourceFx = new Map(Object.entries(preset.sourceFx ?? {}).map(([k, v]) => [k, { ...v }]));
    this.nextChokeGroup = Math.max(preset.nextChokeGroup ?? 1, 1, ...[...this.padChoke.values()].filter(g => g.startsWith('grp')).map(g => Number(g.slice(3)) + 1).filter(n => Number.isFinite(n)));
    this.chops = preset.chops.map(c => ({ id: c.id, start: c.start, end: c.end, free: c.free }));
    this.nextChopId = preset.nextChopId;
    this.bpm = preset.bpm;
    this.pads = preset.pads.map(saved => {
      const mask = normalizeMask(saved.stems);
      return {
        index: saved.index,
        chopId: saved.chopId,
        mode: saved.mode as PadMode,
        color: padColor(saved.index),
        pitch: saved.pitch,
        ...(saved.gate ? { gate: true } : {}),
        ...(saved.fadeIn ? { fadeIn: saved.fadeIn } : {}),
        ...(saved.fadeOut ? { fadeOut: saved.fadeOut } : {}),
        ...(mask !== MASK_ALL ? { stems: mask } : {}),
        ...(typeof saved.reverse === 'boolean' ? { reverse: saved.reverse } : {}),
      };
    });
    // STEMS meta: masks apply once the stem AUDIO is back. The view decodes
    // the assets (local store) and calls setStemBuffers; missing assets =
    // needs-resplit state — masks kept, originals play (never silence).
    this.stemBuffers = null;
    this.stemFileBuffers = null;
    this.stemSliceCache.clear();
    this.waveformComposite = null;
    this.stemsRev++;
    this.stemsMetaState = preset.stems ? { quality: preset.stems.quality === 'fine' ? 'fine' : 'fast', assets: { ...preset.stems.assets } } : null;
    this.stemFileRanges = preset.stems ? normalizeRanges(preset.stems.readyRanges) : [];
    this.stemReadyRanges = mapFileRangesToEff(this.stemFileRanges, this.trims).map(r => [r[0], r[1]] as ReadyRange);
    if (preset.timeline) {
      this.timeline = preset.timeline.map(e => ({ padIdx: e.padIdx, time: e.time, duration: e.duration }));
    }
    this.timelineLength = preset.timelineLength ?? 0;
    // Step sequencer state — prefer multi-sequence payload when present;
    // fall back to the legacy single-pattern fields for old presets.
    if (preset.sequences && preset.sequences.length > 0) {
      this.sequences = preset.sequences.map(p => {
        // Any stored resolution the refit can produce is valid (a 1/16T or 1/64
        // pattern used to be forced back to 16 here and its notes displaced).
        const resolution = SEQ_RESOLUTIONS.has(p.resolution) || (Number.isInteger(p.resolution) && 384 % p.resolution === 0) ? p.resolution : 16;
        const view = p.viewResolution && SEQ_RESOLUTIONS.has(p.viewResolution) && resolution % p.viewResolution === 0 ? p.viewResolution : resolution;
        return {
          bars: p.bars,
          resolution,
          viewResolution: view,
          grid: (p.grid ?? []).map(row => row ? [...row] : []),
          revGrid: (p.revGrid ?? []).map(row => row ? [...row] : []),
          velGrid: (p.velGrid ?? []).map(row => row ? [...row] : []),
          loop: p.loop ?? true,
        };
      });
      this.currentSeqIdx = Math.max(0, Math.min(this.sequences.length - 1, preset.currentSeqIdx ?? 0));
      this.loadFromArray(this.currentSeqIdx);
    } else {
      this.seqBars = preset.seqBars ?? 1;
      this.seqResolution = SEQ_RESOLUTIONS.has(preset.seqResolution ?? 16) ? (preset.seqResolution as number) : 16;
      this.seqViewResolution = this.seqResolution;
      this.seqGrid = (preset.seqGrid ?? []).map(row => row ? [...row] : []);
      this.seqRevGrid = [];
      this.seqVelGrid = [];
      this.seqLoop = preset.seqLoop ?? true;
      this.sequences = [{
        bars: this.seqBars,
        resolution: this.seqResolution,
        viewResolution: this.seqViewResolution,
        grid: this.seqGrid.map(row => [...row]),
        revGrid: [],
        velGrid: [],
        loop: this.seqLoop,
      }];
      this.currentSeqIdx = 0;
    }
    // NORM — restore the toggle, then recompute the multiplier for THIS buffer
    // (same sample re-decodes identically; recomputing is robust if it differs).
    this.normalizeOn = !!preset.normalize && this.buffer !== null;
    this.sourceNorm = new Map(Object.entries(preset.sourceNorm ?? {}).filter(([, g]) => typeof g === 'number' && g > 0 && Number.isFinite(g)) as Array<[string, number]>);
    this.normalizeGain = this.normalizeOn
      ? (preset.normalizeGain ?? this.computeNormalizeGain())
      : 1;
    // Master FX chain — each setter updates both masterState and its audio node.
    // compStyle MUST come before compMix (applyCompPreset can overwrite compMix).
    if (preset.master) {
      const m = preset.master;
      this.setMasterVolume(m.volume);
      this.setMasterPitch(m.pitch);
      this.setFilterFreq(m.filterFreq);
      this.setFilterEnabled(m.filterEnabled);
      this.setEQ('low', m.eqLow); this.setEQ('mid', m.eqMid); this.setEQ('high', m.eqHigh);
      this.setCompStyle(m.compStyle); this.setCompMix(m.compMix);
      this.setDelayTime(m.delayTime); this.setDelayFeedback(m.delayFeedback); this.setDelayMix(m.delayMix);
      this.setReverbDecay(m.reverbDecay); this.setReverbMix(m.reverbMix);
      this.setAttack(m.attack); this.setRelease(m.release);
    }
    // Extra FX rack — restore each block's knobs, then its bypass, directly on
    // the FX node (setBypassed sets absolutely, unlike the toggle* methods).
    if (preset.extraFX) {
      const fx = preset.extraFX;
      this.clipper.setAmount(fx.clipper.amount); this.clipper.setDrive(fx.clipper.drive); this.clipper.setMix(fx.clipper.mix); this.clipper.setBypassed(fx.clipper.bypassed);
      this.waveshaper.setDrive(fx.waveshaper.drive); this.waveshaper.setMix(fx.waveshaper.mix); this.waveshaper.setBypassed(fx.waveshaper.bypassed);
      this.saturator.setDrive(fx.saturator.drive); this.saturator.setMix(fx.saturator.mix); this.saturator.setLowFreq(fx.saturator.lowFreq); this.saturator.setHighFreq(fx.saturator.highFreq); this.saturator.setBypassed(fx.saturator.bypassed);
      this.widener.setWidth(fx.widener.width); this.widener.setMix(fx.widener.mix); this.widener.setBypassed(fx.widener.bypassed);
      this.mseq.setMidFreq(fx.mseq.midFreq); this.mseq.setMidGain(fx.mseq.midGain); this.mseq.setSideFreq(fx.mseq.sideFreq); this.mseq.setSideGain(fx.mseq.sideGain); this.mseq.setMix(fx.mseq.mix); this.mseq.setBypassed(fx.mseq.bypassed);
      this.bitcrusher.setBits(fx.bitcrusher.bits); this.bitcrusher.setRate(fx.bitcrusher.rate); this.bitcrusher.setMix(fx.bitcrusher.mix); this.bitcrusher.setBypassed(fx.bitcrusher.bypassed);
      this.autopan.setRate(fx.autopan.rate); this.autopan.setDepth(fx.autopan.depth); this.autopan.setMix(fx.autopan.mix); this.autopan.setBypassed(fx.autopan.bypassed);
      this.trancegate.setRate(fx.trancegate.rate); this.trancegate.setDepth(fx.trancegate.depth); this.trancegate.setAttack(fx.trancegate.attack); this.trancegate.setRelease(fx.trancegate.release); this.trancegate.setMix(fx.trancegate.mix); this.trancegate.setBypassed(fx.trancegate.bypassed);
      this.chorus.setRate(fx.chorus.rate); this.chorus.setDepth(fx.chorus.depth); this.chorus.setMix(fx.chorus.mix); this.chorus.setBypassed(fx.chorus.bypassed);
      this.syncExtraFxWiring();
    }
    if (typeof preset.masterClip === 'number') this.setMasterClip(preset.masterClip);
    if (typeof preset.chopOffsetMs === 'number') this.setChopOffset(preset.chopOffsetMs);
    if (preset.stretchEnabled !== undefined) {
      this.stretchEnabled = preset.stretchEnabled;
      this.stretchCache.clear();
      if (this.stretchEnabled) void loadStretchLib();
    }
    if (typeof preset.targetBpm === 'number') this.setTargetBpm(preset.targetBpm);
    this.reverseSample = !!preset.reverseSample;
    if (this.reverseSample && this.buffer && !this.reverseBuffer) {
      this.reverseBuffer = this.buildReverseBuffer(this.buffer);
    }
    // SAMPLE level (mobile SAMPLE fader). Set the field directly so the final
    // applyChopGain() below applies chopVolume × normalizeGain in one shot. Old
    // presets (no chopVolume) keep the live value → no silent regression.
    if (typeof preset.chopVolume === 'number') {
      this.chopVolume = Math.max(0, Math.min(1, preset.chopVolume));
    }
    // Transport/session tempo — the BPM the user actively dialled, distinct from
    // the detected `bpm`. setMetronomeBpm emits so the BPM readouts re-sync in
    // both views. Guard >0 so old presets (undefined) leave the live tempo alone.
    if (typeof preset.metronomeBpm === 'number' && preset.metronomeBpm > 0) {
      this.setMetronomeBpm(preset.metronomeBpm);
    }
    // INPUT Q. Projects saved before it went global carry it on the drum
    // preset — migrate that value rather than silently resetting his feel.
    const iq = typeof preset.inputQuantize === 'number' ? preset.inputQuantize
      : typeof (preset.drums as { _inputQuantize?: number } | undefined)?._inputQuantize === 'number'
        ? (preset.drums as { _inputQuantize?: number })._inputQuantize
        : undefined;
    if (typeof iq === 'number') this.inputQuantize = Math.max(0, Math.min(100, Math.round(iq)));
    this.applyChopGain();
    this.emit();
  }

  /** Step a chop boundary to the previous or next detected transient.
   *  Used by the keyboard arrows so the user can "walk" a chop edge along
   *  the onsets without dragging. Snaps regardless of the current snap
   *  mode — the user is explicitly asking for transient navigation. */
  stepChopBoundaryToTransient(chopId: number, side: 'start' | 'end', direction: 1 | -1): boolean {
    const c = this.chops.find(x => x.id === chopId);
    if (!c) return false;
    if (this.transients.length === 0) return false;
    const current = side === 'start' ? c.start : c.end;
    // Find the strict-next or strict-previous transient. Add a small
    // epsilon so a boundary that already lives ON a transient steps fully
    // off rather than getting stuck on the same value.
    const EPS = 1e-3;
    let target: number | null = null;
    if (direction > 0) {
      for (let i = 0; i < this.transients.length; i++) {
        if (this.transients[i] > current + EPS) { target = this.transients[i]; break; }
      }
    } else {
      for (let i = this.transients.length - 1; i >= 0; i--) {
        if (this.transients[i] < current - EPS) { target = this.transients[i]; break; }
      }
    }
    if (target === null) return false;
    this.setChopBoundary(chopId, side, target, true);
    return true;
  }

  adjustChopBoundary(chopId: number, side: 'start' | 'end', delta: number): void {
    const c = this.chops.find(x => x.id === chopId);
    if (!c) return;
    // Arrow-key nudges are precise edits — bypass transient snap so the small
    // delta isn't pulled back to the nearest onset.
    this.setChopBoundary(chopId, side, (side === 'start' ? c.start : c.end) + delta, true);
  }

  setChopBoundary(chopId: number, side: 'start' | 'end', value: number, freeMove = false): void {
    const idx = this.chops.findIndex(x => x.id === chopId);
    if (idx < 0 || !this.buffer) return;
    // Boundary drag fires many calls — coalesce into one undo step.
    this.pushHistory(`chop-boundary-${chopId}-${side}`);
    const c = this.chops[idx];
    let v = Math.max(0, Math.min(this.buffer.duration, value));
    // When SNAP is on, drags snap the boundary to the nearest transient.
    // Hold Shift while dragging to bypass snap and move freely.
    if (!freeMove) v = this.applySnap(v);
    if (c.free) {
      // Independent (duplicate clone): move ONLY this boundary, clamped within the
      // buffer and its own opposite edge. Never touches neighbours — it's not part
      // of the contiguous chain, so dragging it can't disturb the original.
      if (side === 'start') c.start = Math.max(0, Math.min(c.end - 0.01, v));
      else c.end = Math.min(this.buffer.duration, Math.max(c.start + 0.01, v));
      this.emit();
      return;
    }
    if (side === 'start') {
      // Shared boundary with previous chop — move both together (unless the
      // neighbour is a `free` clone, which must stay decoupled).
      const prev = idx > 0 ? this.chops[idx - 1] : null;
      const couple = prev != null && !prev.free;
      const min = couple ? prev!.start + 0.01 : 0;
      const max = c.end - 0.01;
      const t = Math.max(min, Math.min(max, v));
      c.start = t;
      if (couple) prev!.end = t;
    } else {
      // Shared boundary with next chop — move both together (unless it's `free`).
      const next = idx < this.chops.length - 1 ? this.chops[idx + 1] : null;
      const couple = next != null && !next.free;
      const min = c.start + 0.01;
      const max = couple ? next!.end - 0.01 : this.buffer.duration;
      const t = Math.max(min, Math.min(max, v));
      c.end = t;
      if (couple) next!.start = t;
    }
    this.emit();
  }

  // ── Chop-while-playing ────────────────────────────────────────────────────

  toggleChopMode(): void {
    this.chopMode = !this.chopMode;
    this.emit();
  }

  setSnapMode(mode: SnapMode): void {
    this.snapMode = mode;
    this.emit();
  }

  /** Dispatch to whichever snap algorithm matches the current mode. Called
   *  from every place that wants to land a chop boundary at a "nice" spot
   *  (drag, double-click, slice-at-position). Returns posSec unchanged when
   *  snapping is off, or when a beat mode is selected but BPM is unknown. */
  /** Transients of ANY source buffer (a pad's own audio), analysed once per
   *  buffer and cached — the main track's are analysed on load; pad sources
   *  never were, so SNAP on a dragged-in break was snapping to the MAIN
   *  track's onsets. Honours the drum-only toggle like the main track. */
  private transientCache = new WeakMap<AudioBuffer, { broad: Float32Array; drum: Float32Array }>();
  transientsFor(buffer: AudioBuffer): Float32Array {
    if (buffer === this.buffer) return this.transients;
    let c = this.transientCache.get(buffer);
    if (!c) {
      c = { broad: this.detectTransients(buffer).times, drum: this.detectDrumTransients(buffer).times };
      this.transientCache.set(buffer, c);
    }
    return this.acDrumsOnly ? c.drum : c.broad;
  }
  /** Snap a position inside a pad-source buffer to its own nearest onset. */
  private snapInBuffer(posSec: number, buffer: AudioBuffer): number {
    if (this.snapMode === 'off') return posSec;
    const tr = this.transientsFor(buffer);
    if (tr.length === 0) return posSec;
    let lo = 0, hi = tr.length - 1;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (tr[mid] < posSec) lo = mid + 1; else hi = mid; }
    let best = posSec, bestDist = 0.25;
    for (const idx of [lo - 1, lo, lo + 1]) {
      if (idx < 0 || idx >= tr.length) continue;
      const d = Math.abs(tr[idx] - posSec);
      if (d < bestDist) { bestDist = d; best = tr[idx]; }
    }
    return best;
  }
  private applySnap(posSec: number): number {
    switch (this.snapMode) {
      case 'off':       return posSec;
      case 'transient': return this.snapToTransient(posSec);
      case '1/4':       return this.bpm > 0 ? this.snapToBeat(posSec, 4)  : this.snapToTransient(posSec);
      case '1/8':       return this.bpm > 0 ? this.snapToBeat(posSec, 8)  : this.snapToTransient(posSec);
      case '1/16':      return this.bpm > 0 ? this.snapToBeat(posSec, 16) : this.snapToTransient(posSec);
    }
  }

  /** Snap to the nearest beat-grid position. `div` is the subdivision
   *  (4=quarter, 8=eighth, 16=sixteenth). Grid is spaced by (60/bpm)*(4/div)
   *  seconds and anchored at `gridAnchor()` — typically the first detected
   *  drum hit, so a track that starts with silence or pickup notes still
   *  gets the grid lined up with the actual downbeat. */
  private snapToBeat(posSec: number, div: number): number {
    if (this.bpm <= 0) return posSec;
    const step = (60 / this.bpm) * (4 / div);
    if (step <= 0) return posSec;
    const anchor = this.gridAnchor();
    const idx = Math.round((posSec - anchor) / step);
    return anchor + idx * step;
  }

  /** Where beat-1 lives. Prefers the first drum hit, falls back to the
   *  first broadband transient, then 0. Keeps the result inside one beat
   *  of t=0 so the anchor doesn't accidentally jump to the second beat
   *  when the sample has a noisy lead-in. */
  private gridAnchor(): number {
    const candidate = this.drumTransients.length > 0
      ? this.drumTransients[0]
      : (this.broadbandTransients.length > 0 ? this.broadbandTransients[0] : 0);
    if (this.bpm <= 0) return candidate;
    const beat = 60 / this.bpm;
    // Fold the anchor back into [0, beat) — the grid is periodic so a
    // first-onset at "beat 3" produces the same grid as folding it to the
    // matching position in beat 0.
    return ((candidate % beat) + beat) % beat;
  }

  /** Find the nearest precomputed transient within windowSec of posSec.
   *  If nothing found within the window, returns the absolute nearest transient. */
  private snapToTransient(posSec: number, windowSec = 0.25): number {
    if (this.transients.length === 0) return posSec;
    let lo = 0, hi = this.transients.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.transients[mid] < posSec) lo = mid + 1; else hi = mid;
    }
    let best = posSec, bestDist = windowSec;
    for (const idx of [lo - 1, lo, lo + 1]) {
      if (idx < 0 || idx >= this.transients.length) continue;
      const dist = Math.abs(this.transients[idx] - posSec);
      if (dist < bestDist) { bestDist = dist; best = this.transients[idx]; }
    }
    return best;
  }

  /** Detect onsets across the entire buffer and return their times in seconds. */
  /** Banded onset detector tuned for kicks (40-200 Hz lowband flux) and
   *  snares (1.5-8 kHz highband flux). Hi-hats get suppressed by requiring
   *  non-trivial low/mid energy at the candidate frame. Returns merged +
   *  de-duped hits, sorted by time. */
  private detectDrumTransients(buf: AudioBuffer): { times: Float32Array; strengths: Float32Array } {
    const sr = buf.sampleRate;
    const ch0 = buf.getChannelData(0);
    const ch1 = buf.numberOfChannels > 1 ? buf.getChannelData(1) : ch0;
    const N = buf.length;
    if (N < 1024) return { times: new Float32Array(0), strengths: new Float32Array(0) };

    // Mono sum for the band-split pass.
    const mono = new Float32Array(N);
    for (let i = 0; i < N; i++) mono[i] = (ch0[i] + ch1[i]) * 0.5;

    // One-pole IIR lowpass for kick band (fc ≈ 200 Hz) and a separate one
    // for HP-by-subtraction at fc ≈ 1500 Hz (high band = mono − LP(mono)).
    const alphaKick = 1 - Math.exp(-2 * Math.PI * 200 / sr);
    const alphaSnareLp = 1 - Math.exp(-2 * Math.PI * 1500 / sr);
    const low = new Float32Array(N);
    const high = new Float32Array(N);
    let pk = 0, ps = 0;
    for (let i = 0; i < N; i++) {
      const s = mono[i];
      pk = pk + alphaKick * (s - pk);
      ps = ps + alphaSnareLp * (s - ps);
      low[i] = pk;
      high[i] = s - ps;
    }

    const HOP = 256, FRAME = 512;
    const numFrames = Math.floor((N - FRAME) / HOP);
    if (numFrames < 2) return { times: new Float32Array(0), strengths: new Float32Array(0) };

    const eLow = new Float32Array(numFrames);
    const eHigh = new Float32Array(numFrames);
    for (let f = 0; f < numFrames; f++) {
      const base = f * HOP;
      let el = 0, eh = 0;
      for (let i = 0; i < FRAME; i++) {
        const l = low[base + i]; el += l * l;
        const h = high[base + i]; eh += h * h;
      }
      eLow[f] = el / FRAME;
      eHigh[f] = eh / FRAME;
    }

    const fluxLow = new Float32Array(numFrames);
    const fluxHigh = new Float32Array(numFrames);
    for (let f = 1; f < numFrames; f++) {
      fluxLow[f]  = Math.max(0, eLow[f]  - eLow[f - 1]);
      fluxHigh[f] = Math.max(0, eHigh[f] - eHigh[f - 1]);
    }

    const stat = (a: Float32Array) => {
      let m = 0; for (let i = 0; i < a.length; i++) m += a[i]; m /= a.length;
      let v = 0; for (let i = 0; i < a.length; i++) v += (a[i] - m) * (a[i] - m);
      return { mean: m, sigma: Math.sqrt(v / a.length) };
    };
    const sl = stat(fluxLow);
    const sh = stat(fluxHigh);
    // mean + 0.5σ is permissive — the sensitivity knob still trims further
    // at apply time. Lower threshold = wider net for soft kicks/snares.
    const thrLow  = sl.mean + 0.5 * sl.sigma;
    const thrHigh = sh.mean + 0.5 * sh.sigma;

    const MIN_GAP_F = Math.max(1, Math.floor(0.05 * sr / HOP)); // 50 ms

    type Hit = { f: number; strength: number };
    const hits: Hit[] = [];
    let lastL = -MIN_GAP_F, lastH = -MIN_GAP_F;
    for (let f = 1; f < numFrames - 1; f++) {
      // Kick candidate: lowband flux peak, with the low band not totally
      // washed out by simultaneous highs (kicks have far more LF than HF).
      const lowPeak = fluxLow[f] > thrLow
                    && fluxLow[f] > fluxLow[f - 1]
                    && fluxLow[f] >= fluxLow[f + 1];
      if (lowPeak && f - lastL >= MIN_GAP_F) {
        const ratio = eLow[f] / (eHigh[f] + 1e-9);
        if (ratio > 0.4) { hits.push({ f, strength: fluxLow[f] }); lastL = f; }
      }
      // Snare candidate: highband flux peak that ALSO has some lowband body.
      // The eLow/eHigh ratio kills hi-hats (which are HF-only) without
      // killing rim shots / claps (which still have low-mid thump).
      const highPeak = fluxHigh[f] > thrHigh
                     && fluxHigh[f] > fluxHigh[f - 1]
                     && fluxHigh[f] >= fluxHigh[f + 1];
      if (highPeak && f - lastH >= MIN_GAP_F) {
        const bodyRatio = eLow[f] / (eHigh[f] + 1e-9);
        if (bodyRatio > 0.15) { hits.push({ f, strength: fluxHigh[f] }); lastH = f; }
      }
    }

    // Sort + dedupe so a hit picked by both bands within MIN_GAP becomes one.
    hits.sort((a, b) => a.f - b.f);
    const out: Hit[] = [];
    let lastF = -MIN_GAP_F;
    for (const h of hits) {
      if (h.f - lastF >= MIN_GAP_F) { out.push(h); lastF = h.f; }
      else if (h.strength > out[out.length - 1].strength) {
        out[out.length - 1] = h; lastF = h.f;
      }
    }

    const times = new Float32Array(out.length);
    const strengths = new Float32Array(out.length);
    for (let i = 0; i < out.length; i++) {
      times[i] = (out[i].f * HOP) / sr;
      strengths[i] = out[i].strength;
    }
    return { times, strengths };
  }

  /** Swap the active transients/strengths to either the broadband or
   *  drum-only set depending on `acDrumsOnly`. Called whenever either the
   *  underlying analysis or the toggle changes. */
  private applyActiveTransients(): void {
    if (this.acDrumsOnly) {
      this.transients = this.drumTransients;
      this.transientStrengths = this.drumStrengths;
    } else {
      this.transients = this.broadbandTransients;
      this.transientStrengths = this.broadbandStrengths;
    }
  }

  private detectTransients(buf: AudioBuffer): { times: Float32Array; strengths: Float32Array } {
    const sr = buf.sampleRate;
    const ch0 = buf.getChannelData(0);
    const ch1 = buf.numberOfChannels > 1 ? buf.getChannelData(1) : ch0;
    const HOP = 256, FRAME = 512;
    const numFrames = Math.floor((buf.length - FRAME) / HOP);
    if (numFrames < 2) return { times: new Float32Array(0), strengths: new Float32Array(0) };

    // RMS energy per frame
    const energy = new Float32Array(numFrames);
    for (let f = 0; f < numFrames; f++) {
      const base = f * HOP;
      let e = 0;
      for (let i = 0; i < FRAME; i++) {
        const s = (ch0[base + i] + ch1[base + i]) * 0.5;
        e += s * s;
      }
      energy[f] = e / FRAME;
    }

    // Positive spectral flux (onset strength)
    const flux = new Float32Array(numFrames);
    for (let f = 1; f < numFrames; f++) flux[f] = Math.max(0, energy[f] - energy[f - 1]);

    // Permissive threshold: mean + 0.1σ — capture many candidates; the
    // sensitivity knob filters down to the strongest at apply time.
    let mean = 0;
    for (let f = 0; f < numFrames; f++) mean += flux[f];
    mean /= numFrames;
    let variance = 0;
    for (let f = 0; f < numFrames; f++) variance += (flux[f] - mean) ** 2;
    const threshold = mean + 0.1 * Math.sqrt(variance / numFrames);

    // Collect local peaks above threshold, enforcing min 30ms gap
    const MIN_GAP = Math.floor(0.03 * sr / HOP);
    const times: number[] = [];
    const strengths: number[] = [];
    let lastPeak = -MIN_GAP;
    for (let f = 1; f < numFrames - 1; f++) {
      if (flux[f] > threshold && flux[f] > flux[f - 1] && flux[f] >= flux[f + 1] && f - lastPeak >= MIN_GAP) {
        times.push((f * HOP) / sr);
        strengths.push(flux[f]);
        lastPeak = f;
      }
    }
    return { times: new Float32Array(times), strengths: new Float32Array(strengths) };
  }

  /** The pad that plays a main-track chop (first match), or null. */
  private padIdxForChop(chopId: number): number | null {
    for (let i = 0; i < this.pads.length; i++) if (this.pads[i]?.chopId === chopId && !this.padBuffers.has(i)) return i;
    return null;
  }
  /** STEMS carry-over (his rule 2026-08-21): a chop cut out of a chop whose pad
   *  has stems turned off starts with that SAME mask — turn layers back on per
   *  pad if you want them. Writes the field directly: the slice already pushed
   *  its one undo step, setPadsStems would push a second. */
  private inheritStems(fromChopId: number, toPadIdx: number): void {
    const from = this.padIdxForChop(fromChopId);
    this.pads[toPadIdx].stems = from !== null ? this.pads[from].stems : undefined;
  }
  /** Slice at an explicit time position (e.g. from a double-click on the waveform). */
  sliceAtTime(timeSec: number, targetPadIdx: number): void {
    if (!this.buffer) return;
    this.pushHistory();
    timeSec = this.applySnap(timeSec);
    const srcIdx = this.chops.findIndex(c => timeSec >= c.start && timeSec < c.end);
    if (srcIdx < 0) return;
    const src = this.chops[srcIdx];
    if (timeSec - src.start < 0.01 || src.end - timeSec < 0.01) return;
    const newChop: Chop = { id: this.nextChopId++, start: timeSec, end: src.end };
    src.end = timeSec;
    this.chops.splice(srcIdx + 1, 0, newChop);
    this.ensurePad(targetPadIdx);
    this.pads[targetPadIdx].chopId = newChop.id;
    this.inheritStems(src.id, targetPadIdx);
    this.lastSlicedChopId = newChop.id;
    this.emit();
  }

  /** Slice at current playback position and assign new chop to targetPadIdx. */
  /** Public wrapper: slice at the current playhead position. Returns true on
   *  success, false if nothing is playing (caller can fall back). */
  slicePlayheadAt(targetPadIdx: number, eventTimestamp?: number): boolean {
    if (!this.buffer || this.voices.size === 0) return false;
    this.sliceAtCurrentPosition(targetPadIdx);
    return true;
  }

  private sliceAtCurrentPosition(targetPadIdx: number): void {
    if (this.voices.size === 0) return;
    // The voice that is sounding decides WHICH source gets cut — and when more
    // than one rings (the main track under PLAY + a pad with its own sample),
    // it is the pad you LAST HIT, the same rule the playhead follows
    // (getPlaybackPos). His case 2026-08-22: link on pad 1, hit pad 1, hit
    // empty pad 2 → the main track (first in the map) got cut instead of pad 1.
    const playingPad = (this.lastTriggeredPad !== null && this.voices.has(this.lastTriggeredPad))
      ? this.lastTriggeredPad
      : (this.voices.keys().next().value as number | undefined);
    if (playingPad !== undefined && this.padBuffers.has(playingPad)) {
      let pos = this.getPlaybackPos();
      if (pos < 0) return;
      pos = Math.max(0, pos + this.chopOffsetMs / 1000);
      pos = this.snapInBuffer(pos, this.padBuffers.get(playingPad)!.buffer);
      // A refused cut used to vanish silently (his report 2026-08-22 "it's not
      // adding chops") — say why: within 10 ms of the pad's own edges.
      if (!this.chopPadSourceTo(playingPad, pos, targetPadIdx)) this.onNote?.('CHOP NOT ADDED — too close to the start or end of that pad');
      return;
    }
    if (!this.buffer) return;
    this.pushHistory();

    // Read the EXACT same playhead value the canvas is drawing (getPlaybackPos),
    // so the chop lands where the user sees the playhead. We deliberately do NOT
    // back-date by the event→handler lag here: the visual playhead isn't
    // back-dated either, and subtracting it dropped the chop slightly behind the
    // line. Both now share one formula, so they agree by construction.
    let pos = this.getPlaybackPos();
    if (pos < 0) return;
    // Land the chop at the EXACT heard playback position — no artificial lead.
    // The on-screen playhead is a render-delayed visual, so the accurate
    // reference is the audio clock here, not the dot. Chop by ear; fine-tune
    // globally with the CHOP OFFSET control.
    pos = Math.max(0, pos + this.chopOffsetMs / 1000);

    pos = this.applySnap(pos);

    // Find which chop contains this position
    const srcIdx = this.chops.findIndex(c => pos >= c.start && pos < c.end);
    if (srcIdx < 0) { this.onNote?.('CHOP NOT ADDED — the playhead is outside every chop'); return; }
    const src = this.chops[srcIdx];

    // Minimum slice size: 10ms on each side
    if (pos - src.start < 0.01 || src.end - pos < 0.01) { this.onNote?.('CHOP NOT ADDED — too close to the edge of the chop that is playing'); return; }

    const newChop: Chop = { id: this.nextChopId++, start: pos, end: src.end };
    src.end = pos;
    this.chops.splice(srcIdx + 1, 0, newChop);

    // Assign new chop to target pad — grow pad array if needed
    this.ensurePad(targetPadIdx);
    this.pads[targetPadIdx].chopId = newChop.id;
    this.inheritStems(src.id, targetPadIdx); // stems carry over from the chop it was cut from
    // A chop cut from a grouped pad stays in that pad's group.
    const g = playingPad !== undefined ? this.padGroups.get(playingPad) : undefined;
    if (g) this.padGroups.set(targetPadIdx, g); else this.padGroups.delete(targetPadIdx);
    this.lastSlicedChopId = newChop.id;
    this.emit();
  }

  // ── Pads ───────────────────────────────────────────────────────────────────

  selectPad(idx: number | null): void {
    this.selectedPad = idx;
    this.emit();
  }

  /** THE pad an edit acts on — the single source of truth for "which chop am I
   *  editing", shared by the waveform (what you SEE highlighted) and the
   *  keyboard (arrows / [ ] / delete). An explicit selection wins; otherwise the
   *  pad you last hit.
   *
   *  Deliberately does NOT consider which pads are RINGING. It used to: the
   *  keyboard read `activePads[0]` first while the waveform read this rule, so
   *  the two disagreed whenever a pad was still sounding — worst with NOTE ON,
   *  where a held pad stays active for as long as you hold it, so nudging a
   *  chop point moved a DIFFERENT chop than the highlighted one, and the target
   *  changed as pads started and stopped ("it jumps around"). A held pad is
   *  already `lastTriggeredPad`, so the normal case is unchanged. */
  focusedPad(): number | null {
    return this.selectedPad ?? this.lastTriggeredPad;
  }

  assignChopToPad(padIdx: number, chopId: number): void {
    this.ensurePad(padIdx);          // allocate lazily-created pads (paste/dup/move into an untouched slot)
    const pad = this.pads[padIdx];
    if (!pad) return;
    pad.chopId = chopId;
    this.emit();
  }

  /** Make an INDEPENDENT copy of a chop: a new chop with a fresh unique id but the
   *  SAME start/end, marked `free` so its boundary drags + its removal stay
   *  decoupled from the contiguous slice chain. Returns the new id (or the source
   *  id unchanged if it doesn't exist). Used by pad DUPLICATE so the copy gets its
   *  own editable region over the SHARED sample buffer — editing/clearing the copy
   *  never touches the original. No pushHistory/emit: it's a composable primitive,
   *  snapshotted by the caller's history batch and emitted by the assign that
   *  follows it. */
  cloneChop(sourceChopId: number): number {
    const src = this.chops.find(c => c.id === sourceChopId);
    if (!src) return sourceChopId;
    const id = this.nextChopId++;
    this.chops.push({ id, start: src.start, end: src.end, free: true });
    return id;
  }

  /** Light per-pad read for the clipboard ops — no getState() deep clone
   *  (getState copies every pad, chop, seq grid and sequence; calling it per
   *  pad per probe slot turned a multi-pad paste into hundreds of clones). */
  padLite(idx: number): { chopId: number | null; pitch: number; mode: PadMode; gate: boolean; fadeIn: number; fadeOut: number; stems: StemMask; reverse?: boolean } | null {
    const p = this.pads[idx];
    if (!p) return null;
    return { chopId: p.chopId, pitch: p.pitch ?? 0, mode: (p.mode ?? 'oneshot') as PadMode, gate: !!p.gate, fadeIn: p.fadeIn ?? 0, fadeOut: p.fadeOut ?? 0, stems: normalizeMask(p.stems), reverse: p.reverse };
  }
  /** Does the pad hold anything (a chop or its own buffer)? O(1), no clone. */
  hasPadContent(idx: number): boolean {
    return this.pads[idx]?.chopId != null || this.padBuffers.has(idx);
  }
  /** A chop's region right now, or null when the id no longer exists. */
  chopRegion(chopId: number): { start: number; end: number } | null {
    const c = this.chops.find(x => x.id === chopId);
    return c ? { start: c.start, end: c.end } : null;
  }
  /** The chop if it still exists, else a fresh FREE chop rebuilt from the
   *  remembered region — how a clipboard reference survives its source being
   *  CLEARED after copy (clearPad splices the chop out of the waveform; a
   *  paste of that id would otherwise land a silent, dead pad). Composable
   *  primitive like cloneChop: no pushHistory/emit of its own. */
  reviveChop(chopId: number, start: number, end: number): number {
    if (this.chops.some(c => c.id === chopId)) return chopId;
    const id = this.nextChopId++;
    this.chops.push({ id, start, end, free: true });
    return id;
  }
  /** Multi-pad LOOP / NOTE ON (shift-selected pads): one undo step, one emit —
   *  the per-pad setters each emit, which is 20 re-renders for a 20-pad set. */
  setPadsLoop(padIdxs: number[], on: boolean): void {
    const hit = padIdxs.filter(i => { const p = this.pads[i]; return p && (p.mode === 'loop') !== on; });
    if (!hit.length) return;
    this.pushHistory();
    for (const i of hit) {
      this.pads[i].mode = on ? 'loop' : 'oneshot';
      if (!on) this.stopVoice(i);
    }
    this.emit();
  }
  setPadsGate(padIdxs: number[], on: boolean): void {
    const hit = padIdxs.filter(i => { const p = this.pads[i]; return p && !!p.gate !== on; });
    if (!hit.length) return;
    this.pushHistory();
    for (const i of hit) this.pads[i].gate = on || undefined;
    this.emit();
  }

  /** Empty a pad's slot — drop its per-pad buffer if it has one, else null its
   *  chop pointer — WITHOUT deleting/merging the underlying chop. Unlike
   *  clearPad (which splices the chop and merges its region into a neighbour),
   *  this is non-destructive, so the hardware pad menu's copy/paste/duplicate/
   *  clear/swap can reassign pads freely without mangling the chop layout. */
  unassignPad(padIdx: number): void {
    const pad = this.pads[padIdx];
    if (!pad) return;
    this.stopVoice(padIdx);
    if (this.padBuffers.has(padIdx)) this.padBuffers.delete(padIdx);
    pad.chopId = null;
    this.forgetPadRoute(padIdx);
    this.emit();
  }

  clearPad(padIdx: number): void {
    const pad = this.pads[padIdx];
    if (!pad) return;
    this.pushHistory();
    this.stopVoice(padIdx);
    this.forgetPadRoute(padIdx);

    // Remove per-pad buffer if present
    if (this.padBuffers.has(padIdx)) {
      this.padBuffers.delete(padIdx);
      pad.stems = undefined;
      this.pruneSourceStems();
      this.emit();
      return;
    }

    if (pad.chopId === null) return;

    const chopId = pad.chopId;
    // Always empty ONLY the targeted pad's slot.
    pad.chopId = null;

    // Duplicated pads share a chopId. Splice the underlying chop out of the
    // waveform (merging its region into a neighbour) ONLY when no OTHER pad still
    // references it — otherwise clearing the copy would delete the chop the
    // original still points at, blanking the original too.
    const sharedByOther = this.pads.some((p, i) => i !== padIdx && p?.chopId === chopId);
    if (!sharedByOther) {
      const idx = this.chops.findIndex(c => c.id === chopId);
      if (idx >= 0) {
        const removed = this.chops[idx];
        // A `free` chop (a duplicate clone) isn't part of the contiguous chain, so
        // removing it leaves no gap — splice it out without merging a neighbour
        // (merging would distort an unrelated chop's region).
        if (!removed.free) {
          if (idx > 0) {
            // Extend previous chop to absorb this region
            this.chops[idx - 1].end = removed.end;
          } else if (idx < this.chops.length - 1) {
            // First chop — extend next chop backwards
            this.chops[idx + 1].start = removed.start;
          }
        }
        this.chops.splice(idx, 1);
      }
    }

    this.emit();
  }

  setPadMode(padIdx: number, mode: PadMode): void {
    const pad = this.pads[padIdx];
    if (!pad) return;
    pad.mode = mode;
    this.emit();
  }

  togglePadMode(padIdx: number): void {
    const pad = this.pads[padIdx];
    if (!pad) return;
    this.setPadLoop(padIdx, pad.mode !== 'loop');
  }
  /** LOOP: the pad plays round and round between its start and end. With fades
   *  set the loop is a rendered crossfade (see loopBufferFor). Undoable. */
  setPadLoop(padIdx: number, on: boolean): void {
    const pad = this.pads[padIdx];
    if (!pad || (pad.mode === 'loop') === on) return;
    this.pushHistory();
    pad.mode = on ? 'loop' : 'oneshot';
    if (!on) this.stopVoice(padIdx); // a loop that has no LOOP any more stops
    this.emit();
  }
  /** NOTE ON (gate): the pad sounds only while held — release fades it out over
   *  the RELEASE time. Combines with LOOP (loop while held). Undoable. */
  setPadGate(padIdx: number, on: boolean): void {
    const pad = this.pads[padIdx];
    if (!pad || !!pad.gate === on) return;
    this.pushHistory();
    pad.gate = on || undefined;
    this.emit();
  }
  /** Fades inside the pad's region, seconds. LOOP: the loop crossfade — the tail
   *  (fadeOut) overlaps and fades into the head (fadeIn) of the next pass so a
   *  chop loops like a pad. One-shot: a plain in/out envelope. Each is capped at
   *  half the region. Drag-coalesced into one undo step per pad. */
  setPadFades(padIdx: number, fadeIn: number, fadeOut: number): void {
    const pad = this.pads[padIdx];
    if (!pad) return;
    const src = this.padSourceOf(padIdx);
    // The fades may cross: fade-in up to the whole region, fade-out down to it
    // (the loop period keeps a small floor so a pass is never zero-length).
    const len = src ? Math.max(0, src.end - src.start) : Infinity;
    const minPeriod = src ? LOOP_MIN_PERIOD_FRAMES / src.buffer.sampleRate : 0;
    const fi = Math.max(0, Math.min(len, fadeIn || 0));
    const fo = Math.max(0, Math.min(Math.max(0, len - minPeriod), fadeOut || 0));
    if ((pad.fadeIn ?? 0) === fi && (pad.fadeOut ?? 0) === fo) return;
    this.pushHistory(`pad-fade-${padIdx}`);
    pad.fadeIn = fi || undefined;
    pad.fadeOut = fo || undefined;
    this.emit();
  }
  /** Where a pad's sound lives — its own source's region or its chop of the main
   *  track (buffer seconds). null when the pad is empty. */
  padSourceOf(padIdx: number): { buffer: AudioBuffer; start: number; end: number } | null {
    const pb = this.padBuffers.get(padIdx);
    if (pb) return { buffer: pb.buffer, start: pb.start, end: pb.end };
    const pad = this.pads[padIdx];
    if (!pad || pad.chopId === null || !this.buffer) return null;
    const chop = this.chops.find(c => c.id === pad.chopId);
    return chop ? { buffer: this.buffer, start: chop.start, end: chop.end } : null;
  }

  setPadPitch(padIdx: number, semitones: number): void {
    const pad = this.pads[padIdx];
    if (!pad) return;
    // Coalesce continuous drag/wheel changes on the same pad.
    this.pushHistory(`pad-pitch-${padIdx}`);
    pad.pitch = Math.max(-24, Math.min(24, semitones));
    this.emit();
  }

  adjustPadPitch(padIdx: number, delta: number): void {
    const pad = this.pads[padIdx];
    if (!pad) return;
    pad.pitch = Math.max(-24, Math.min(24, pad.pitch + delta));
    this.emit();
  }

  /** Free-tier gate: lock pads at/after `from` (null = no lock). Every trigger
   *  source (keyboard, mouse, MIDI, arp, chop-click) funnels through
   *  triggerPad, so this single check enforces the limit everywhere — CSS
   *  pointer-events alone only stopped the mouse. */
  setPadLock(from: number | null): void { this.lockedPadFrom = from; }

  /** Set the START point of the selected pad's chop, as a 0..1 fraction of the
   *  full sample. Used by the START knob (mouse + MIDI CC). Keeps the chop end
   *  fixed; clamps so start stays at least 20ms before end. No-op without a
   *  selected pad that has a chop. */
  setSelectedChopStart(t: number): void {
    if (!this.buffer || this.selectedPad === null) return;
    const pad = this.pads[this.selectedPad];
    if (!pad || pad.chopId === null) return;
    const chop = this.chops.find(c => c.id === pad.chopId);
    if (!chop) return;
    const dur = this.buffer.duration;
    const newStart = Math.max(0, Math.min(chop.end - 0.02, t * dur));
    chop.start = newStart;
    this.emit();
  }

  triggerPad(padIdx: number, velocity = 1, eventTimestamp?: number, opts?: { reverse?: boolean; nativeOwned?: boolean }): void {
    if (this.lockedPadFrom !== null && padIdx >= this.lockedPadFrom) return;
    // Context not running? Could be 'suspended' (backgrounded) or iOS's
    // 'interrupted' (screen locked/slept). This tap IS the user gesture iOS
    // needs to clear an interruption — resume, then replay once it's actually
    // running. Guarding the retry on 'running' avoids any resume loop.
    if (this.ctx.state !== 'running') {
      this.ctx.resume().then(() => {
        if (this.ctx.state === 'running') this.triggerPad(padIdx, velocity, eventTimestamp, opts);
      }).catch(() => {});
      return;
    }
    if (this.arpEnabled && this.pads.length > 0) {
      // Arp mode: holding the pad steps through the pad bank at tempo.
      this.startArp(padIdx, velocity);
      return;
    }
    this._doTrigger(padIdx, velocity, eventTimestamp, opts);
  }

  /** Schedule a pad hit at an absolute context time — the Beat Finisher's
   *  chops go through this so they are SAMPLE-ACCURATE against the drum and
   *  bass timelines. The live triggerPad starts "now": fired from the
   *  arranger's 25 ms interval it landed 0–25 ms late plus any main-thread
   *  stall, while drums kept perfect time (his report: the finisher's chops
   *  fall out of sync, then pick back up). The chokes run on a timer at
   *  `when` — a few ms of timer jitter on a 3 ms fade is inaudible; the
   *  audio start itself is exact. */
  triggerPadAt(padIdx: number, when: number, velocity = 1, opts?: { reverse?: boolean; nativeOwned?: boolean }): void {
    if (this.lockedPadFrom !== null && padIdx >= this.lockedPadFrom) return;
    const pad = this.pads[padIdx];
    if (!pad) return;
    if (!this.padBuffers.has(padIdx) && (pad.chopId === null || !this.buffer)) return;
    // startVoice overwrites this pad's map entry NOW even though the new voice
    // only sounds at `when` — capture the ringing voice so the choke timer can
    // still cut it (chokeGroup couldn't find it in the map any more).
    const prev = this.voices.get(padIdx);
    const g = this.chokeGroupOf(padIdx);
    const delay = Math.max(0, (when - this.ctx.currentTime) * 1000);
    const timer = setTimeout(() => {
      const tNow = this.ctx.currentTime;
      if (prev) {
        try {
          prev.gain.gain.cancelScheduledValues(tNow);
          prev.gain.gain.setValueAtTime(prev.gain.gain.value, tNow);
          prev.gain.gain.linearRampToValueAtTime(0, tNow + 0.003);
          prev.src.stop(tNow + 0.004);
        } catch { /* already stopped */ }
      }
      // Choke the rest of the mute group — but never the pad's own NEW voice.
      for (const idx of [...this.voices.keys()]) {
        if (idx !== padIdx && g !== 'none' && this.chokeGroupOf(idx) === g) this.stopVoice(idx);
      }
      const i = this.loopTimers.indexOf(timer);
      if (i >= 0) this.loopTimers.splice(i, 1);
    }, delay);
    this.loopTimers.push(timer);
    this.startVoice(padIdx, velocity, opts?.reverse, when, opts?.nativeOwned);
  }

  private _doTrigger(padIdx: number, velocity: number, eventTimestamp?: number, opts?: { reverse?: boolean; nativeOwned?: boolean }): void {
    // Chop-while-playing: slice silently — current audio continues uninterrupted.
    // This comes FIRST: whatever else the kit looks like, an empty-pad tap while
    // something rings is a chop-tap. (His report 2026-08-22: "hitting pads to
    // chop but it's not adding chops" — the main track had ZERO chops (DEL ALL
    // / its last pad cleared, buffer still loaded) and a link sat on a pad, so
    // the empty-chop recovery below returned before this branch ever ran.)
    if (this.chopMode && this.voices.size > 0 && !this.padBuffers.has(padIdx) && (this.pads[padIdx] === undefined || this.pads[padIdx].chopId === null)) {
      this.sliceAtCurrentPosition(padIdx);
      return;
    }

    // Empty-chop recovery: no chops + buffer loaded → reset to full sample on
    // pad 0 — unless the pad hit has its OWN source, which plays regardless
    // (this used to hijack a recorded/loaded pad and play the main track).
    if (this.chops.length === 0 && this.buffer && !this.padBuffers.has(padIdx)) {
      // Pads already carry their OWN samples (a link, a file, a recording):
      // an empty-pad tap with nothing playing is a mis-hit — never resurrect
      // the main track onto "the first free pad" (his report 2026-08-22: link
      // on pad 1, tap empty pad 3 → the playlist song appeared on pad 2).
      if (this.padBuffers.size > 0) return;
      this.autoChop(1);
      this._doTrigger(0, velocity);
      return;
    }

    // A LOOP pad that isn't gated is a toggle: hit it again while it's going
    // round to stop it (otherwise nothing but STOP could end it).
    {
      const p = this.pads[padIdx];
      const v = this.voices.get(padIdx);
      if (p && p.mode === 'loop' && !p.gate && v && v.loopPeriod !== undefined) {
        this.stopVoice(padIdx);
        this.emitActivity();
        return;
      }
    }

    const pad = this.pads[padIdx];
    if (!pad) return;
    const hasPadBuf = this.padBuffers.has(padIdx);
    if (!hasPadBuf && (pad.chopId === null || !this.buffer)) return;

    // The hit's MUSICAL time: back-date the handler lag (event.timeStamp is
    // when the input physically fired, clamped to 50ms) AND the output
    // latency — the player is locked to what they HEAR, which trails the
    // schedule by the output buffer. Without the second term every recorded
    // hit landed late by ~the buffer (10-30ms; more on Bluetooth).
    const eventLagSec = eventTimestamp !== undefined
      ? Math.max(0, Math.min(0.05, (performance.now() - eventTimestamp) / 1000))
      : 0;
    const hitTime = this.ctx.currentTime - eventLagSec - this.hwLatencySec();

    // LIVE record (looper): each hit lands on the nearest grid line for the
    // current resolution — and the AUDIBLE hit snaps too (his ask 2026-08-20:
    // "quantize what I hear"): a slightly-early hit is SCHEDULED on its line
    // (triggerPadAt — chokes ride the same schedule), a late one sounds now;
    // both record exactly on the line. GATE (NOTE ON) pads and the ARP keep
    // playing live — delaying a held pad breaks press/release pairing — and
    // still quantize only the WRITE.
    if (this.liveRecording && this.seqPlaying && !this.seqPaused) {
      const gridDur = this.seqStepDuration * this.seqColumnStride;
      if (gridDur > 0 && this.getSeqStepCount() > 0 && !pad.gate && !this.arpEnabled) {
        // INPUT Q decides the pull (nothing else — a grid alone never
        // quantizes input); this sequencer's OWN grid decides the lines.
        const { step: landStep, at: lineT } = this.liveLandingFor(hitTime);
        // Write FIRST: if the pad was ALREADY on this step (overdubbing along
        // with the playing pattern) and the scheduler has booked that firing
        // (cursor past the line), the pattern's copy sounds at ~our time —
        // playing ours too is the double-trigger whose group choke cuts the
        // chop short. One owner per hit; the reverse case (ours plays, the
        // scheduler's copy is skipped) is covered by lastLivePadHit below.
        const { wasOn } = this.writeLiveStep(padIdx, landStep, velocity);
        // NATIVE transport: the C++ sequencer fires the pattern's copy itself and its one-owner rule (a live hit
        // within 120 ms of the step owns it) lives in RT code — a pad already on the step is always "booked".
        const booked = wasOn && (this.seqSink ? true : lineT <= this.seqScheduledUpTo);
        if (!booked) {
          if (lineT > this.ctx.currentTime + 0.002) {
            this.triggerPadAt(padIdx, lineT, velocity, opts);
            this.lastLivePadHit.set(padIdx, lineT);
          } else {
            this.chokeGroup(padIdx);
            this.startVoice(padIdx, velocity, opts?.reverse, undefined, opts?.nativeOwned);
            this.lastLivePadHit.set(padIdx, this.ctx.currentTime);
          }
        }
        this.emit();
        return;
      }
      this.chokeGroup(padIdx);
      this.startVoice(padIdx, velocity, opts?.reverse, undefined, opts?.nativeOwned);
      this.lastLivePadHit.set(padIdx, this.ctx.currentTime);
      this.writeLiveHit(padIdx, hitTime);
      this.emit();
      return;
    }

    // Choke within the pad's MUTE GROUP (was: stop every pad — global mono).
    this.chokeGroup(padIdx);
    this.startVoice(padIdx, velocity, opts?.reverse, undefined, opts?.nativeOwned);
    // COUNT-IN: REC is armed but the loop has not started — keep the hit; the
    // downbeat flush lands anything within half a grid step of the "1" on step
    // 1 (the first hit of a take is played ON the one, and lands a few ms early).
    if (this.countInPending) {
      this.earlyHits.push({ padIdx, at: hitTime });
      if (this.earlyHits.length > 32) this.earlyHits.shift();
    }

    if (this.recording) {
      // Step-input recording: each pad hit fills the next empty cell. If the
      // cursor is on a filled cell (e.g. user cleared one earlier and we're
      // overdubbing), we skip past filled cells to reach the next empty one.
      // If the grid is fully filled, we wrap to step 0 and overwrite from the
      // start.
      const totalSteps = this.getSeqStepCount();
      if (totalSteps > 0) {
        this.advanceRecordToEmpty();
        this.seqGrid[this.recordStep] = [padIdx];
        // Mirror the global reverse flag into the recorded cell so REV-armed
        // step input gets per-note reverse.
        this.seqRevGrid[this.recordStep] = [this.reverseSample];
        this.seqVelGrid[this.recordStep] = [clampVel(velocity)];
        // The cursor walks COLUMNS of the visible grid (stride stored steps).
        const stride = this.seqColumnStride;
        this.recordStep = (this.recordStep + stride) % totalSteps;
        this.advanceRecordToEmpty();
      }
      this.emit();
    }
  }

  /** @param reverseOverride per-hit reverse (a Beat Finisher preview replaying
   *  a reversed cell); undefined = the global REVERSE toggle. */
  /** @param nativeOwned Terminator 3.0: the native engine already played this hit itself (a MIDI note on the direct
   *  MidiHub → engine path) — the shadow must not trigger it again; everything else (voice record, LEDs, chokes,
   *  recording) runs as usual. */
  private startVoice(padIdx: number, velocity: number, reverseOverride?: boolean, when?: number, nativeOwned = false): void {
    if (this.ctx.state === 'closed') return;
    this.lastTriggeredPad = padIdx;
    const pad = this.pads[padIdx];
    if (!pad) return;

    // Resolve source: per-pad buffer takes priority over main buffer + chop
    const padBuf = this.padBuffers.get(padIdx);
    let srcBuf: AudioBuffer;
    let startSec: number;
    let durSec: number;
    // Track the original-buffer end so the playhead can sweep backwards through
    // the waveform when reverse-sample is active.
    let reverseOrigEnd: number | undefined;
    let stemBase: AudioBuffer | undefined; // main-chop voices only (restemVoice)
    let posOffset = 0;                     // main-track secs − buffer secs (stem slices)

    if (padBuf) {
      durSec = padBuf.end - padBuf.start;
      // STEMS PER SOURCE: the pad's mask picks its layers of its OWN sample —
      // same region, different audio; ALL / unready = the original. Mirrored
      // in restemVoice (a live toggle swaps a ringing voice in place).
      const base = this.bufferForPadSource(padIdx);
      stemBase = base.buffer;
      posOffset = padBuf.start - base.start;
      if (reverseOverride ?? this.reversedFor(padIdx)) {
        // Pad sources reverse too — mirrored into their own reversed copy.
        srcBuf = this.reversedOf(base.buffer);
        startSec = base.buffer.duration - base.end;
        reverseOrigEnd = padBuf.end;
      } else {
        srcBuf = base.buffer;
        startSec = base.start;
      }
    } else {
      if (pad.chopId === null || !this.buffer) return;
      const chop = this.chops.find(c => c.id === pad.chopId);
      if (!chop) return;
      durSec = chop.end - chop.start;
      // STEMS: the pad's mask picks which buffer this chop reads — same chop
      // region, different audio. ALL / unready spans resolve to the original.
      // This resolution (incl. reverse/stretch below) is MIRRORED in
      // restemVoice, which re-runs it on a RINGING voice when the mask
      // changes — keep the two in step.
      const base = this.bufferForPadChop(padIdx, chop.start, chop.end);
      stemBase = base.buffer;
      posOffset = chop.start - base.start; // 0 for the original; the chop start for a slice
      if (reverseOverride ?? this.reverseSample) {
        srcBuf = this.reversedOf(base.buffer); // main buffer keeps its reverseBuffer field inside reversedOf
        // Mirror the chop into the reversed buffer.
        startSec = base.buffer.duration - base.end;
        reverseOrigEnd = chop.end;
      } else {
        srcBuf = base.buffer;
        startSec = base.start;
      }
    }


    // Time-stretch chop via SoundTouch when enabled and ratio is meaningful.
    // The hot path NEVER runs SoundTouch synchronously: it only does a cache
    // LOOKUP (zero compute). On a miss we play the chop dry this hit and warm
    // the stretched buffer off the call stack (_warmOneChop), so the NEXT hit of
    // this (chop, ratio) plays stretched. The background sweep (_warmAllChops,
    // armed when stretch/targetBpm/chops change) usually fills the cache before
    // the producer has played through every chop once.
    let playStart = startSec;
    let playDur = durSec;
    let usedStretchBuf = false; // true only when THIS hit plays a stretched buffer
    if (this.stretchEnabled && this.bpm > 0 && this.targetBpm > 0) {
      const ratio = this.targetBpm / this.bpm;
      if (Math.abs(ratio - 1) > 0.005) {
        const endSec = startSec + durSec;
        const cached = this.stretchCache.get(this.stretchKey(srcBuf, startSec, endSec, ratio));
        if (cached) {
          // Cache hit — play the pre-stretched buffer (fast path, no compute).
          srcBuf = cached;
          playStart = 0;
          playDur = cached.duration;
          usedStretchBuf = true;
        } else {
          // Cache miss — leave srcBuf/playStart/playDur dry so this hit fires
          // immediately, and warm THIS exact slice (same srcBuf, incl. reverse)
          // async so the next hit is cache-warm.
          void this._warmOneChop(srcBuf, startSec, endSec, ratio);
        }
      }
    }

    // LOOP: pick the buffer BEFORE it is assigned — AudioBufferSourceNode.buffer
    // may be set exactly once (a second set throws and the voice dies silent).
    // With fades this is the rendered crossfade loop; without, the raw region.
    const looping = pad.mode === 'loop';
    const fadeIn = Math.max(0, Math.min(playDur, pad.fadeIn ?? 0));
    const fadeOut = Math.max(0, Math.min(playDur, pad.fadeOut ?? 0));
    const lb = looping ? this.loopBufferFor(srcBuf, playStart, playDur, fadeIn, fadeOut) : null;
    const src = this.ctx.createBufferSource();
    src.buffer = lb ? lb.buffer : srcBuf;
    // Pitch is varispeed (detune → playbackRate). Capture the resulting rate so
    // getPlaybackPos advances the playhead at the true speed — otherwise a
    // pitched pad's buffer outruns the playhead and reads as "cut short".
    const playbackRate = Math.pow(2, (pad.pitch + this.pitchFor(padIdx)) / 12);
    src.detune.value = (pad.pitch + this.pitchFor(padIdx)) * 100;

    const gain = this.ctx.createGain();
    // `when` (triggerPadAt — the Beat Finisher's lookahead) starts the voice at
    // an absolute context time; everything below — envelope, fades, release —
    // is already keyed off `t`, so scheduling ahead is this one line.
    const t = Math.max(this.ctx.currentTime, when ?? 0);
    // The pad's own fades (BUFFER seconds inside the region). LOOP renders them
    // into the loop buffer; a one-shot plays them as its envelope, where the
    // fade-in simply lengthens the source ATTACK (context seconds → ÷ rate).
    const atk = Math.max(this.attackFor(padIdx), looping ? 0 : fadeIn / playbackRate);
    const rel = this.masterState.release;
    // NORM per source rides the voice (a pad's own sample normalised to its OWN peak).
    const vel = padBuf ? velocity * this.normGainFor(padIdx) : velocity;
    if (atk > 0) {
      gain.gain.setValueAtTime(0, t);
      gain.gain.linearRampToValueAtTime(vel, t + atk);
    } else {
      gain.gain.setValueAtTime(vel, t);
    }
    src.connect(gain);
    gain.connect(this.padVoiceOut(padIdx));

    const startCtxTime = t;

    let loopPeriod: number | undefined;
    if (lb) {
      // Rendered crossfade loop: [intro pass | periodic pass]; the source loops
      // the periodic half. With no fades this is the raw region looped.
      src.loop = true;
      src.loopStart = lb.loopStart;
      src.loopEnd = lb.loopEnd;
      loopPeriod = lb.period;
      const loopWarmup = lb.warmup;
      try { src.start(t, lb.startAt); }
      catch { try { src.disconnect(); } catch { /* */ } try { gain.disconnect(); } catch { /* */ } return; }
      src.onended = () => {
        try { gain.disconnect(); } catch { /* */ }
        if (this.voices.get(padIdx)?.src === src) {
          this.voices.delete(padIdx);
          this.activePadSet.delete(padIdx);
          this.emitActivity();
        }
      };
      const lv: PadVoice = { src, gain, startCtxTime, chopStart: playStart, playbackRate, loopPeriod, loopWarmup, gate: !!pad.gate, velocity: vel, stemBase };
      if (posOffset) lv.posOffset = posOffset;
      if (usedStretchBuf) { lv.originalChopStart = startSec; lv.stretchRatio = this.targetBpm / this.bpm; }
      if (reverseOrigEnd !== undefined) lv.reverseOrigEnd = reverseOrigEnd;
      this.voices.set(padIdx, lv);
      this.activePadSet.add(padIdx);
      this.emitActivity();
      this.voiceSink?.start(padIdx, velocity, when, reverseOverride, nativeOwned);
      return;
    }

    src.loop = false;
    // src.start throws on invalid offset/duration (NaN, negative, past the
    // buffer end). The nodes are already wired to padBus at this point, so
    // bail out cleanly — disconnect both so a bad chop can't leak a node.
    // The release fade runs on the CONTEXT clock (real seconds) while playDur
    // is BUFFER seconds — under varispeed they differ by playbackRate. Read
    // `rel` real seconds = rel×rate buffer seconds past the chop, and fade at
    // the real end. (Before: at +12 st a 1 s chop ended at 0.5 s real, the
    // fade never ran — hard cut, then rel/2 s of the neighbouring chop.)
    const realDur = playDur / playbackRate;
    try {
      src.start(t, playStart, playDur + rel * playbackRate);
    } catch {
      try { src.disconnect(); } catch { /* */ }
      try { gain.disconnect(); } catch { /* */ }
      return;
    }
    if (rel > 0) {
      gain.gain.setValueAtTime(velocity, t + realDur);
      gain.gain.linearRampToValueAtTime(0.0001, t + realDur + rel);
    }
    // One-shot fade-out: the pad's own tail envelope, ending AT the region end
    // (RELEASE, if any, then runs from ~silence — harmless).
    if (fadeOut > 0) {
      const foReal = fadeOut / playbackRate;
      gain.gain.setValueAtTime(velocity, Math.max(t + atk, t + realDur - foReal));
      gain.gain.linearRampToValueAtTime(0.0001, t + realDur);
    }
    src.onended = () => {
      try { gain.disconnect(); } catch { /* */ }
      if (this.voices.get(padIdx)?.src === src) {
        this.voices.delete(padIdx);
        this.activePadSet.delete(padIdx);
        this.emitActivity();
      }
    };

    const voice: PadVoice = { src, gain, startCtxTime, chopStart: playStart, playbackRate, gate: !!pad.gate, velocity: vel, stemBase };
    if (posOffset) voice.posOffset = posOffset;
    // Only tag the voice as stretched when it actually played the stretched
    // buffer this hit. On a cache-miss DRY hit the buffer advances at real speed,
    // so the playhead math (originalChopStart + elapsed*ratio) must NOT apply.
    if (usedStretchBuf) {
      voice.originalChopStart = startSec;
      voice.stretchRatio = this.targetBpm / this.bpm;
    }
    if (reverseOrigEnd !== undefined) voice.reverseOrigEnd = reverseOrigEnd;
    this.voices.set(padIdx, voice);
    this.activePadSet.add(padIdx);
    this.emitActivity();
    this.voiceSink?.start(padIdx, velocity, when, reverseOverride, nativeOwned);
  }

  /** LIVE stem toggle (his ask 2026-08-20: hear the chips without restarting
   *  the chop). A RINGING main-chop voice swaps its audio to the pad's newly
   *  resolved mask at the CURRENT playhead — every stem mix is sample-aligned
   *  with the original, and loop/stretch renders are deterministic for equal
   *  args, so the new source starts at the exact same position; a ~12ms
   *  equal-gain crossfade hides the seam. The PadVoice record keeps its
   *  startCtxTime, so playhead math and the waveform dot stay continuous by
   *  construction. Mirrors startVoice's resolution — keep the two in step.
   *  Skipped: pad-source voices (no masks), voices scheduled but not yet
   *  started (the next scheduled hit resolves the new mask anyway). */
  private restemVoice(padIdx: number, noRetry = false): void {
    if (this.ctx.state === 'closed') return;
    const v = this.voices.get(padIdx);
    const pad = this.pads[padIdx];
    if (!v || !pad || v.stemBase === undefined) return;
    // The region this voice plays + the buffer its mask resolves to now:
    // a main-track chop, or the pad's own sample (STEMS PER SOURCE).
    const own = this.padBuffers.get(padIdx);
    let chop: { start: number; end: number };
    let base: { buffer: AudioBuffer; start: number; end: number };
    if (own) { chop = { start: own.start, end: own.end }; base = this.bufferForPadSource(padIdx); }
    else {
      if (pad.chopId === null || !this.buffer) return;
      const c = this.chops.find(x => x.id === pad.chopId);
      if (!c) return;
      chop = c;
      base = this.bufferForPadChop(padIdx, chop.start, chop.end);
    }
    if (base.buffer === v.stemBase) return; // same audio — nothing to swap
    const now = this.ctx.currentTime;
    if (now < v.startCtxTime - 0.001) return; // scheduled ahead — not started yet

    // ── re-run startVoice's resolution against the NEW base ──
    const rate = v.playbackRate ?? 1;
    const reversed = v.reverseOrigEnd !== undefined;
    let srcBuf: AudioBuffer = reversed ? this.reversedOf(base.buffer) : base.buffer;
    let startSec = reversed ? base.buffer.duration - base.end : base.start;
    const durSec = chop.end - chop.start;
    let playStart = startSec;
    let playDur = durSec;
    if (v.stretchRatio !== undefined) {
      // The old voice plays a STRETCHED render — the new mask's render of the
      // same slice must exist before we can swap. Warm it and come back once.
      const ratio = v.stretchRatio;
      const cached = this.stretchCache.get(this.stretchKey(srcBuf, startSec, startSec + durSec, ratio));
      if (!cached) {
        if (!noRetry) void this._warmOneChop(srcBuf, startSec, startSec + durSec, ratio).then(() => this.restemVoice(padIdx, true));
        return;
      }
      srcBuf = cached;
      playStart = 0;
      playDur = cached.duration;
    }

    const elapsedBuf = Math.max(0, now - v.startCtxTime) * rate;
    const fadeIn = Math.max(0, Math.min(playDur, pad.fadeIn ?? 0));
    const fadeOut = Math.max(0, Math.min(playDur, pad.fadeOut ?? 0));
    const looping = v.loopPeriod !== undefined;
    const rel = this.masterState.release;
    const XF = 0.012; // crossfade seconds

    const src = this.ctx.createBufferSource();
    src.detune.value = Math.log2(rate) * 1200; // the rate the voice's timing math runs at
    const gain = this.ctx.createGain();
    // Pick up at the CURRENT level (mid-attack/fade included), fade the seam.
    const level = Math.max(0.0001, v.gain.gain.value);
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(level, now + XF);
    src.connect(gain);
    gain.connect(this.padVoiceOut(padIdx));

    if (looping) {
      const lb = this.loopBufferFor(srcBuf, playStart, playDur, fadeIn, fadeOut);
      // Same numeric args ⇒ same geometry as the ringing source's loop render:
      // walk elapsed into the [warm-up | periodic] timeline and wrap.
      let pos = lb.startAt + elapsedBuf;
      if (pos > lb.loopEnd) pos = lb.loopStart + ((pos - lb.loopStart) % Math.max(1e-6, lb.period));
      src.loop = true;
      src.loopStart = lb.loopStart;
      src.loopEnd = lb.loopEnd;
      src.buffer = lb.buffer;
      try { src.start(now, pos); }
      catch { try { src.disconnect(); } catch { /* */ } try { gain.disconnect(); } catch { /* */ } return; }
    } else {
      // Position in the NEW buffer's coordinates (the old voice may have been
      // reading the original while this one reads a chop-length slice).
      const pos = playStart + elapsedBuf;
      const total = playDur + rel * rate;           // buffer-secs the original start() covered
      const remaining = total - (pos - playStart);
      if (remaining <= 0.02 || pos >= srcBuf.duration) { // tail's over — let it ring out
        try { src.disconnect(); } catch { /* */ } try { gain.disconnect(); } catch { /* */ }
        return;
      }
      src.buffer = srcBuf;
      try { src.start(now, pos, remaining); }
      catch { try { src.disconnect(); } catch { /* */ } try { gain.disconnect(); } catch { /* */ } return; }
      // Re-anchor the remaining envelope on the new gain at the ORIGINAL
      // absolute times (past anchors clamp to the crossfade's end).
      const vel = v.velocity ?? 1;
      const realDur = playDur / rate;
      const endT = v.startCtxTime + realDur;
      const after = now + XF;
      if (rel > 0 && endT + rel > after) {
        gain.gain.setValueAtTime(level, Math.max(after, Math.min(endT, after)));
        if (endT > after) gain.gain.setValueAtTime(vel, endT);
        gain.gain.linearRampToValueAtTime(0.0001, Math.max(after + 0.01, endT + rel));
      }
      if (fadeOut > 0) {
        const foStart = endT - fadeOut / rate;
        if (endT > after) {
          gain.gain.setValueAtTime(foStart > after ? vel : level, Math.max(after, foStart));
          gain.gain.linearRampToValueAtTime(0.0001, endT);
        }
      }
    }

    // Fade + retire the old nodes. The old src's onended guard compares
    // against the RECORD's src — which is about to become the new one — so
    // it won't delete the voice when the old source stops.
    const oldSrc = v.src, oldGain = v.gain;
    try {
      oldGain.gain.cancelScheduledValues(now);
      oldGain.gain.setValueAtTime(level, now);
      oldGain.gain.linearRampToValueAtTime(0.0001, now + XF);
    } catch { /* */ }
    try { oldSrc.stop(now + XF + 0.02); } catch { /* already stopped */ }
    src.onended = () => {
      try { gain.disconnect(); } catch { /* */ }
      if (this.voices.get(padIdx)?.src === src) {
        this.voices.delete(padIdx);
        this.activePadSet.delete(padIdx);
        this.emitActivity();
      }
    };
    v.src = src;
    v.gain = gain;
    v.stemBase = base.buffer;
    // The swapped voice reads in the NEW buffer's coordinates from here on.
    v.chopStart = playStart;
    v.posOffset = chop.start - base.start || undefined;
    if (v.stretchRatio !== undefined) v.originalChopStart = startSec;
  }

  /** Every ringing main-chop voice re-resolves its mask (stems installed,
   *  removed, or a span turned ready mid-split). */
  private restemAllVoices(): void {
    for (const idx of [...this.voices.keys()]) this.restemVoice(idx);
  }

  releasePad(padIdx: number): void {
    if (this.arpEnabled && this.arpHoldPad === padIdx) {
      this.stopArp();
    }
    // NOTE ON (gate) pads stop on release — a fade over the RELEASE time (never
    // a hard cut). Every other pad is one-shot: release does nothing, the voice
    // tails out on its own.
    const v = this.voices.get(padIdx);
    if (v && v.gate) {
      this.voiceSink?.release(padIdx);
      const rel = Math.max(0.005, this.masterState.release || 0);
      const t = this.ctx.currentTime;
      try {
        v.gain.gain.cancelScheduledValues(t);
        v.gain.gain.setValueAtTime(v.gain.gain.value, t);
        v.gain.gain.linearRampToValueAtTime(0.0001, t + rel);
        v.src.stop(t + rel + 0.005);
      } catch { /* already stopped */ }
      // The voice stays registered until onended so the LED / playhead follow the fade.
    }
  }

  /** Rendered LOOP buffer for a region: `[intro | periodic]`. The intro is the
   *  first pass from the region's true start (fading in over fadeIn); the
   *  periodic half is one loop period (region − fadeOut) where the region's
   *  tail — fading out over fadeOut — is laid UNDER its head, so the loop point
   *  is a crossfade and every pass sounds identical. loopStart/loopEnd bracket
   *  the periodic half. Equal-power curves. No fades = the raw region looped
   *  (no render, no copy). Cached per source buffer + region + fades. */
  private loopCache = new WeakMap<AudioBuffer, Map<string, { buffer: AudioBuffer; startAt: number; loopStart: number; loopEnd: number; period: number; warmup: number }>>();
  private loopBufferFor(srcBuf: AudioBuffer, start: number, dur: number, fadeIn: number, fadeOut: number): { buffer: AudioBuffer; startAt: number; loopStart: number; loopEnd: number; period: number; warmup: number } {
    if (fadeIn <= 0 && fadeOut <= 0) return { buffer: srcBuf, startAt: start, loopStart: start, loopEnd: start + dur, period: dur, warmup: 0 };
    let m = this.loopCache.get(srcBuf);
    if (!m) { m = new Map(); this.loopCache.set(srcBuf, m); }
    const key = `${start.toFixed(5)}|${dur.toFixed(5)}|${fadeIn.toFixed(4)}|${fadeOut.toFixed(4)}`;
    const hit = m.get(key);
    if (hit) return hit;
    const sr = srcBuf.sampleRate;
    const s0 = Math.max(0, Math.round(start * sr));
    const n = Math.max(2, Math.min(srcBuf.length - s0, Math.round(dur * sr)));
    const chans: Float32Array[] = [];
    for (let c = 0; c < srcBuf.numberOfChannels; c++) chans.push(srcBuf.getChannelData(c));
    const r = renderCrossfadeLoop(chans, s0, n, Math.round(fadeIn * sr), Math.round(fadeOut * sr));
    const out = this.ctx.createBuffer(srcBuf.numberOfChannels, r.frames[0].length, sr);
    for (let c = 0; c < srcBuf.numberOfChannels; c++) out.getChannelData(c).set(r.frames[c]);
    const period = r.period;
    const res = { buffer: out, startAt: 0, loopStart: r.loopStart / sr, loopEnd: (r.loopStart + period) / sr, period: period / sr, warmup: r.loopStart / sr };
    if (m.size > 24) m.delete(m.keys().next().value as string);
    m.set(key, res);
    return res;
  }

  private stopVoice(padIdx: number): void {
    const v = this.voices.get(padIdx);
    if (!v) return;
    this.voiceSink?.stop(padIdx);
    const t = this.ctx.currentTime;
    try {
      v.gain.gain.cancelScheduledValues(t);
      v.gain.gain.setValueAtTime(v.gain.gain.value, t);
      v.gain.gain.linearRampToValueAtTime(0, t + 0.003);
      v.src.stop(t + 0.004);
    } catch { /* already stopped */ }
    this.voices.delete(padIdx);
    this.activePadSet.delete(padIdx);
  }

  stopAllPads(): void {
    if (this.voices.size === 0) return;   // nothing ringing — don't wake subscribers
    for (const idx of [...this.voices.keys()]) this.stopVoice(idx);
    this.emitActivity();
  }

  /** Cut any manually-triggered pad voices still ringing — used by the
   *  sequencer so each scheduled note chokes background pads. Cheap no-op when
   *  nothing is ringing (avoids needless re-renders on dense patterns). */
  private chokeVoices(): void {
    if (this.voices.size === 0) return;
    for (const idx of [...this.voices.keys()]) this.stopVoice(idx);
    this.emitActivity();
  }
  /** Choke only the live voices whose mute group is firing (sequencer step). */
  private chokeVoicesInGroups(groups: Set<string>): void {
    if (this.voices.size === 0) return;
    let any = false;
    for (const idx of [...this.voices.keys()]) { if (groups.has(this.seqTailGroup(idx))) { this.stopVoice(idx); any = true; } }
    if (any) this.emitActivity();
  }

  // ── Arp ────────────────────────────────────────────────────────────────────

  toggleArp(): void {
    this.arpEnabled = !this.arpEnabled;
    if (!this.arpEnabled) this.stopArp();
    this.emit();
  }
  setArpRate(rate: number): void {
    this.arpRate = Math.max(1, rate);
    this.emit();
  }
  toggleArpDirection(): void {
    this.arpDirection = this.arpDirection === 'up' ? 'down' : 'up';
    this.emit();
  }
  toggleArpRandom(): void {
    this.arpRandom = !this.arpRandom;
    this.emit();
  }

  private arpTempo(): number {
    // Metronome BPM is the project tempo — it's editable in the toolbar
    // (drag / type / tap) and reflects what the user wants regardless of
    // whether the click is currently playing. Sample BPM is only a fallback
    // for the case where no project tempo has been set.
    if (this.metronomeBpm > 0) return this.metronomeBpm;
    if (this.bpm > 0) return this.bpm;
    return 120;
  }

  private startArp(padIdx: number, velocity: number): void {
    this.stopArp();
    if (this.pads.length === 0) return;
    this.arpHoldPad = padIdx;
    this.arpStep = 0;
    this.arpStartCtxTime = this.ctx.currentTime;
    this.emit();
    this.arpFire(velocity);
  }

  private arpFire(velocity: number): void {
    if (this.arpHoldPad === null) return;
    const padCount = this.pads.length;
    if (padCount === 0) { this.stopArp(); return; }

    let nextPad: number;
    if (this.arpRandom) {
      nextPad = Math.floor(Math.random() * padCount);
    } else if (this.arpDirection === 'up') {
      nextPad = (this.arpHoldPad + this.arpStep) % padCount;
    } else {
      nextPad = ((this.arpHoldPad - this.arpStep) % padCount + padCount) % padCount;
    }
    this._doTrigger(nextPad, velocity);
    this.arpStep++;

    // Drift-free scheduling: target time is start + step*interval, so jitter
    // doesn't accumulate over many steps.
    const interval = 60 / this.arpTempo() / this.arpRate;
    const target = this.arpStartCtxTime + this.arpStep * interval;
    const delayMs = Math.max(0, (target - this.ctx.currentTime) * 1000);
    this.arpTimer = setTimeout(() => this.arpFire(velocity), delayMs);
  }

  private stopArp(): void {
    if (this.arpTimer) clearTimeout(this.arpTimer);
    this.arpTimer = null;
    const wasHeld = this.arpHoldPad !== null;
    this.arpHoldPad = null;
    this.arpStep = 0;
    if (wasHeld) this.emit();
  }

  // ── Reverse sample ─────────────────────────────────────────────────────────

  toggleReverseSample(): void {
    this.pushHistory();
    this.reverseSample = !this.reverseSample;
    if (this.reverseSample && this.buffer && !this.reverseBuffer) {
      this.reverseBuffer = this.buildReverseBuffer(this.buffer);
    }
    this.emit();
  }

  private buildReverseBuffer(orig: AudioBuffer): AudioBuffer {
    const rev = this.ctx.createBuffer(orig.numberOfChannels, orig.length, orig.sampleRate);
    for (let ch = 0; ch < orig.numberOfChannels; ch++) {
      const o = orig.getChannelData(ch);
      const r = rev.getChannelData(ch);
      const n = orig.length;
      for (let i = 0; i < n; i++) r[i] = o[n - 1 - i];
    }
    return rev;
  }

  // ── Metronome ──────────────────────────────────────────────────────────────

  toggleMetronome(): void {
    this.metronomeEnabled = !this.metronomeEnabled;
    if (this.metronomeEnabled) {
      // The METRO button only toggles the flag — the clicks are gated on the
      // transport. If the sequencer is already playing, phase-lock the click to
      // the loop's beat grid off the same anchor the audio is scheduled from
      // (so it can't land off-grid) and start the click train now; otherwise we
      // just hold the flag and playSeq() starts the clicks in sync on PLAY.
      if (this.seqPlaying && !this.seqPaused) {
        const beatDur = 60 / this.seqTempo();
        const elapsed = this.ctx.currentTime - this.seqCurrentLoopStart;
        const nextBeatIdx = Math.ceil(elapsed / beatDur - 1e-9);
        this.metronomeBeat = ((nextBeatIdx % 4) + 4) % 4;
        this.nextBeatTime = this.seqCurrentLoopStart + nextBeatIdx * beatDur;
        this.startMetronomeTimer();
      }
    } else {
      this.stopMetronomeTimer();
    }
    this.emit();
  }

  /** Start the look-ahead click scheduler. No-op if already running. Clicks are
   *  only ever produced while the sequencer is playing, so this is driven by the
   *  transport (playSeq/resumeSeq + a mid-play METRO toggle), never by the METRO
   *  button alone while stopped. */
  private startMetronomeTimer(): void {
    if (this.metronomeTimer) return;
    if (this.ctx.state !== 'running') this.ctx.resume().catch(() => {});
    this.metroLook.reset();
    this.metronomeTimer = startClock(() => { this.metroLook.beat(); this.metronomeSchedulerTick(); }, 25);
  }

  private stopMetronomeTimer(): void {
    if (this.metronomeTimer) this.metronomeTimer.stop();
    this.metronomeTimer = null;
    this.drumMetronomeActive = false;
  }

  /** Start the metronome click train for drum-only live recording,
   *  phase-locked to `atTime` as beat 0.  Called by HardwareView's
   *  armDrumRec when drumEngine starts without playSeq().
   *  No-op if metronome is disabled. */
  startMetronomeForDrums(atTime: number): void {
    if (!this.metronomeEnabled) return;
    this.drumMetronomeActive = true;
    this.metronomeBeat = 0;
    this.nextBeatTime = atTime;
    this.startMetronomeTimer();
  }

  /** INPUT Q as the engines use it: 0..1. */
  inputQuantizeStrength(): number {
    const v = this.inputQuantize;
    return Math.max(0, Math.min(100, Number.isFinite(v) ? v : 100)) / 100;
  }
  getInputQuantize(): number { return this.inputQuantize; }
  /** Set INPUT Q (0..100). Shapes FUTURE recorded hits only — never the audio
   *  already playing — so the view snapshots history once per drag (SWING's
   *  pattern) rather than per move. */
  setInputQuantize(v: number): void {
    const iq = Math.max(0, Math.min(100, Math.round(v)));
    if (iq === this.inputQuantize) return;
    this.inputQuantize = iq;
    if (this.liveRecording) this.ensureRecordStorage(); // dropped mid-take
    this.emit();
  }

  setMetronomeBpm(bpm: number): void {
    this.metronomeBpm = Math.max(20, Math.min(300, bpm));
    // No re-anchor needed: the step scheduler queues only ~one step ahead and
    // advances seqScheduledUpTo by a fresh stepDur each step, so the new tempo
    // takes effect on the very next scheduled step (within one ~25ms tick) — the
    // same way the drum engine adapts. The single in-flight step plays out at the
    // old spacing; its tail is hard-cut by the next hit (seqTailVoices) if a
    // speed-up would otherwise overlap.
    this.emit();
  }

  setMetronomeSound(sound: MetronomeSound): void {
    this.metronomeSound = sound;
    this.emit();
  }

  private metronomeSchedulerTick(): void {
    if (this.ctx.state === 'closed') {
      if (this.metronomeTimer) this.metronomeTimer.stop();
      return;
    }
    // Clicks are gated on the transport — only produce them while the sequencer
    // is actually playing (never when stopped or paused). The drum-only live-rec
    // metronome (drumMetronomeActive) is exempt: it clicks while the drum engine
    // plays without the chop sequencer.
    if ((!this.seqPlaying || this.seqPaused) && !this.drumMetronomeActive) return;
    // While a LIVE count-in is running, ITS clicks are the count — don't also
    // schedule metronome clicks or you'd hear two click trains at once. playSeq
    // re-aligns the metronome when the loop starts (count-in ends).
    if (this.countInBeat >= 0) return;
    const lookahead = this.metroLook.horizon();
    const beatDur = 60 / this.metronomeBpm;
    while (this.nextBeatTime < this.ctx.currentTime + lookahead) {
      // A stall longer than the look-ahead leaves beats in the past — skip
      // them (advance the count, schedule nothing) instead of machine-gunning
      // the backlog "now". The beat COUNT still advances so the accent stays
      // on the true downbeat.
      if (this.nextBeatTime >= this.ctx.currentTime - 0.05) {
        this.scheduleMetronomeClick(this.nextBeatTime, this.metronomeBeat);
      }
      this.metronomeBeat = (this.metronomeBeat + 1) % 4;
      this.nextBeatTime += beatDur;
    }
  }

  private scheduleMetronomeClick(time: number, beat: number): void {
    if (this.ctx.state === 'closed') return;
    const ctx = this.ctx;
    const accent = beat === 0; // downbeat accent

    switch (this.metronomeSound) {
      case 'click': {
        const osc = ctx.createOscillator();
        const env = ctx.createGain();
        osc.frequency.value = accent ? 1400 : 900;
        osc.connect(env); env.connect(ctx.destination);
        env.gain.setValueAtTime(0, time);
        env.gain.linearRampToValueAtTime(accent ? 0.6 : 0.4, time + 0.001);
        env.gain.exponentialRampToValueAtTime(0.001, time + 0.06);
        osc.start(time); osc.stop(time + 0.07);
        break;
      }
      case 'hihat': {
        if (!this.noiseBuffer) break;
        const src = ctx.createBufferSource();
        src.buffer = this.noiseBuffer;
        const hpf = ctx.createBiquadFilter();
        hpf.type = 'highpass'; hpf.frequency.value = accent ? 9000 : 7000;
        const env = ctx.createGain();
        env.gain.setValueAtTime(accent ? 0.4 : 0.25, time);
        env.gain.exponentialRampToValueAtTime(0.001, time + (accent ? 0.08 : 0.05));
        src.connect(hpf); hpf.connect(env); env.connect(ctx.destination);
        src.start(time); src.stop(time + 0.1);
        break;
      }
      case 'rimshot': {
        if (!this.noiseBuffer) break;
        // Noise burst + short sine
        const noise = ctx.createBufferSource();
        noise.buffer = this.noiseBuffer;
        const bpf = ctx.createBiquadFilter();
        bpf.type = 'bandpass'; bpf.frequency.value = 1200; bpf.Q.value = 0.5;
        const nEnv = ctx.createGain();
        nEnv.gain.setValueAtTime(accent ? 0.5 : 0.35, time);
        nEnv.gain.exponentialRampToValueAtTime(0.001, time + 0.05);
        noise.connect(bpf); bpf.connect(nEnv); nEnv.connect(ctx.destination);
        noise.start(time); noise.stop(time + 0.06);

        const osc = ctx.createOscillator();
        const oEnv = ctx.createGain();
        osc.frequency.value = 200;
        oEnv.gain.setValueAtTime(accent ? 0.3 : 0.2, time);
        oEnv.gain.exponentialRampToValueAtTime(0.001, time + 0.04);
        osc.connect(oEnv); oEnv.connect(ctx.destination);
        osc.start(time); osc.stop(time + 0.05);
        break;
      }
      case 'kick': {
        const osc = ctx.createOscillator();
        const env = ctx.createGain();
        osc.frequency.setValueAtTime(accent ? 180 : 140, time);
        osc.frequency.exponentialRampToValueAtTime(40, time + 0.25);
        env.gain.setValueAtTime(accent ? 0.8 : 0.6, time);
        env.gain.exponentialRampToValueAtTime(0.001, time + 0.3);
        osc.connect(env); env.connect(ctx.destination);
        osc.start(time); osc.stop(time + 0.35);
        break;
      }
      case 'clap': {
        if (!this.noiseBuffer) break;
        // 3 staggered noise bursts
        const delays = [0, 0.008, 0.016];
        for (const d of delays) {
          const src = ctx.createBufferSource();
          src.buffer = this.noiseBuffer;
          const hpf = ctx.createBiquadFilter();
          hpf.type = 'bandpass'; hpf.frequency.value = 1800; hpf.Q.value = 0.8;
          const env = ctx.createGain();
          const t = time + d;
          env.gain.setValueAtTime(accent ? 0.45 : 0.3, t);
          env.gain.exponentialRampToValueAtTime(0.001, t + 0.06);
          src.connect(hpf); hpf.connect(env); env.connect(ctx.destination);
          src.start(t); src.stop(t + 0.07);
        }
        break;
      }
    }
  }

  // ── Undo / redo ────────────────────────────────────────────────────────────

  private buildSnapshot(): HistorySnapshot {
    this.syncCurrentToArray();
    return {
      chops: this.chops.map(c => ({ id: c.id, start: c.start, end: c.end, free: c.free })),
      pads: this.pads.map(p => ({ index: p.index, chopId: p.chopId, mode: p.mode, color: p.color, pitch: p.pitch, gate: p.gate, fadeIn: p.fadeIn, fadeOut: p.fadeOut, stems: p.stems, reverse: p.reverse })),
      nextChopId: this.nextChopId,
      sequences: this.sequences.map(s => ({
        bars: s.bars,
        resolution: s.resolution,
        viewResolution: s.viewResolution,
        grid: s.grid.map(row => row ? [...row] : []),
        revGrid: (s.revGrid ?? []).map(row => row ? [...row] : []),
        velGrid: (s.velGrid ?? []).map(row => row ? [...row] : []),
        loop: s.loop,
      })),
      currentSeqIdx: this.currentSeqIdx,
      bpm: this.bpm,
      targetBpm: this.targetBpm,
      buffer: this.fileBuffer,         // the ORIGINAL; the playable buffer is rebuilt from it + trims
      trims: cloneTrims(this.trims),
      trackTitle: this.trackTitle,
      transients: this.transients,
      transientStrengths: this.transientStrengths,
      broadbandTransients: this.broadbandTransients,
      broadbandStrengths: this.broadbandStrengths,
      drumTransients: this.drumTransients,
      drumStrengths: this.drumStrengths,
      reverseBuffer: this.reverseBuffer,
      padBuffers: Array.from(this.padBuffers.entries()).map(([i, pb]) => [i, { ...pb }]),
      padRoutes: Array.from(this.padRoutes.entries()),
      padChoke: Array.from(this.padChoke.entries()),
      sourceRoutes: Array.from(this.sourceRoutes.entries()),
      padGroups: Array.from(this.padGroups.entries()),
      sourceFx: Array.from(this.sourceFx.entries()).map(([k, v]) => [k, { ...v }]),
      nextSampleTrack: this.nextSampleTrack,
      nextChokeGroup: this.nextChokeGroup,
      reverseSample: this.reverseSample,
      inputQuantize: this.inputQuantize,
      drums: this.drumEngine?.serialize() ?? null,
    };
  }
  private applySnapshot(s: HistorySnapshot): void {
    this.stopAllPads();
    this.stopSeq();
    // Restore the loaded sample only when it actually differs from what's
    // loaded now (so undoing a chop edit doesn't needlessly thrash the buffer
    // or the stretch cache). When the sample DOES change, swap in its derived
    // caches and clear the stretch cache (its entries belong to the old buffer).
    // `s.buffer` is the ORIGINAL audio of that moment; the playable buffer is
    // its kept ranges. Rebuild when the source OR the trim list differs (a
    // pruned snapshot has buffer null → skip, as before).
    const sTrims = s.trims ?? [];
    const fileChanged = !!s.buffer && s.buffer !== this.fileBuffer;
    const trimsChanged = !sameTrims(sTrims, this.trims);
    if (s.buffer && (fileChanged || trimsChanged)) {
      this.fileBuffer = s.buffer;
      this.trims = cloneTrims(sTrims);
      this.buffer = buildEffectiveBuffer(this.ctx, s.buffer, this.trims);
      this.trackTitle = s.trackTitle;
      this.transients = s.transients;
      this.transientStrengths = s.transientStrengths;
      this.broadbandTransients = s.broadbandTransients;
      this.broadbandStrengths = s.broadbandStrengths;
      this.drumTransients = s.drumTransients;
      this.drumStrengths = s.drumStrengths;
      this.reverseBuffer = s.reverseBuffer;
      this.stretchCache.clear();
      this.stemSliceCache.clear();
      this.waveformComposite = null;
      // Stems belong to the sample that was split — an undo that swaps the
      // sample drops them (masks ride the snapshot pads; needs-resplit state).
      // A trim undo keeps them: they re-cut to the restored timeline.
      if (fileChanged) this.clearStems(false); else { this.rederiveStems(); this.stemsRev++; }
      this.refreshNormalize();
    }
    this.chops = s.chops.map(c => ({ id: c.id, start: c.start, end: c.end, free: c.free }));
    this.pads = s.pads.map(p => ({ index: p.index, chopId: p.chopId, mode: p.mode, color: p.color, pitch: p.pitch, gate: p.gate, fadeIn: p.fadeIn, fadeOut: p.fadeOut, stems: p.stems, reverse: p.reverse }));
    this.nextChopId = s.nextChopId;
    this.sequences = s.sequences.map(p => ({
      bars: p.bars,
      resolution: p.resolution,
      viewResolution: p.viewResolution,
      grid: p.grid.map(row => row ? [...row] : []),
      revGrid: (p.revGrid ?? []).map(row => row ? [...row] : []),
      velGrid: (p.velGrid ?? []).map(row => row ? [...row] : []),
      loop: p.loop,
    }));
    this.currentSeqIdx = Math.max(0, Math.min(this.sequences.length - 1, s.currentSeqIdx));
    this.loadFromArray(this.currentSeqIdx);
    this.bpm = s.bpm;
    this.targetBpm = s.targetBpm;
    // Sources + blocks: pad audio, routing, mute groups, per-source settings.
    // Older snapshots (taken before these fields existed) leave them as-is.
    if (s.padBuffers) {
      this.padBuffers = new Map(s.padBuffers.map(([i, pb]) => [i, { ...pb }]));
      this.padRoutes = new Map(s.padRoutes);
      this.padChoke = new Map(s.padChoke);
      this.sourceRoutes = new Map(s.sourceRoutes);
      this.padGroups = new Map(s.padGroups ?? []);
      this.sourceFx = new Map(s.sourceFx.map(([k, v]) => [k, { ...v }]));
      this.nextSampleTrack = s.nextSampleTrack;
      this.nextChokeGroup = s.nextChokeGroup;
      this.reverseSample = s.reverseSample;
      this.onRoutesChanged?.();
    }
    if (typeof s.inputQuantize === 'number') this.inputQuantize = s.inputQuantize;
    // Restore the drum side too. restoreForUndo keeps playback going (no stop)
    // when the kit's samples are unchanged — the common case for an undo — and
    // is a near no-op when the drums didn't change at this point in history.
    if (s.drums && this.drumEngine) this.drumEngine.restoreForUndo(s.drums);
    this.emit();
  }
  /** Take a snapshot before a mutating action. `group` coalesces continuous
   *  gestures (e.g. boundary drag) so they collapse into one undo step. Any
   *  new edit clears the redo stack. */
  private pushHistory(group?: string): void {
    // Inside a composite edit (pad paste/duplicate/move) the single pre-edit
    // snapshot was already taken in beginHistoryBatch(); swallow the inner pushes.
    if (this.historyBatchDepth > 0) return;
    if (group) {
      const now = performance.now();
      const last = this.lastPushTimeByGroup.get(group) ?? 0;
      this.lastPushTimeByGroup.set(group, now);
      if (now - last < this.COALESCE_MS) return;
    }
    this.historyUndo.push(this.buildSnapshot());
    if (this.historyUndo.length > this.HISTORY_MAX) this.historyUndo.shift();
    this.historyRedo.length = 0;
    this.pruneHistorySamples();
  }

  // Free buffers held by snapshots beyond the MAX_HISTORY_SAMPLES most recent
  // distinct samples. Snapshots that share a still-live buffer are untouched;
  // chop-only edit snapshots therefore never get pruned while their sample is.
  private pruneHistorySamples(): void {
    const seen = new Set<AudioBuffer>();
    for (let i = this.historyUndo.length - 1; i >= 0; i--) {
      const snap = this.historyUndo[i];
      if (!snap.buffer) continue;
      if (seen.has(snap.buffer) || seen.size < this.MAX_HISTORY_SAMPLES) {
        seen.add(snap.buffer);
      } else {
        const empty = new Float32Array(0);
        snap.buffer = null;
        snap.reverseBuffer = null;
        snap.transients = empty;
        snap.transientStrengths = empty;
        snap.broadbandTransients = empty;
        snap.broadbandStrengths = empty;
        snap.drumTransients = empty;
        snap.drumStrengths = empty;
      }
    }
  }
  undo(): void {
    const prev = this.historyUndo.pop();
    if (!prev) return;
    this.historyRedo.push(this.buildSnapshot());
    if (this.historyRedo.length > this.HISTORY_MAX) this.historyRedo.shift();
    this.applySnapshot(prev);
  }
  redo(): void {
    const next = this.historyRedo.pop();
    if (!next) return;
    this.historyUndo.push(this.buildSnapshot());
    if (this.historyUndo.length > this.HISTORY_MAX) this.historyUndo.shift();
    this.applySnapshot(next);
  }
  canUndo(): boolean { return this.historyUndo.length > 0; }
  canRedo(): boolean { return this.historyRedo.length > 0; }

  /** Drop all undo/redo history. Used after on-mount initialization (default kit
   *  randomize + generate) so a fresh session starts with nothing to undo. */
  clearHistory(): void {
    this.historyUndo.length = 0;
    this.historyRedo.length = 0;
    this.lastPushTimeByGroup.clear();
  }

  /** Pop the newest undo entry. Used by the drum sample-browser session to
   *  discard its pre-browse snapshot when the browser is closed WITHOUT a LOAD
   *  (auditions were reverted to baseline → no net change, so no dead undo step). */
  dropLastHistory(): void { this.historyUndo.pop(); }

  /** Register the drum engine so its full state rides in every snapshot and is
   *  restored on undo/redo. Call once on mount. */
  attachDrumEngine(d: DrumHistoryTarget): void { this.drumEngine = d; }

  /** Snapshot the unified (chop + drum) state before an external source mutates.
   *  Used by the drum engine's history sink (setHistorySink → recordHistory) so a
   *  drum edit lands in the same chronological stack as chop edits. `group`
   *  coalesces a continuous gesture into one undo step (same rules as chop). */
  recordHistory(group?: string): void { this.pushHistory(group); }

  /** Bracket a composite view edit (pad paste/duplicate/move) so it collapses to
   *  ONE undo step: one pre-edit snapshot here, inner pushes suppressed until
   *  endHistoryBatch(). Depth-counted so nested/re-entrant brackets are safe. */
  beginHistoryBatch(): void {
    if (this.historyBatchDepth === 0) this.pushHistory();
    this.historyBatchDepth++;
  }
  endHistoryBatch(): void {
    this.historyBatchDepth = Math.max(0, this.historyBatchDepth - 1);
  }

  // ── Step sequencer ─────────────────────────────────────────────────────────

  // Snapshot active working state into the sequences array, so what we see in
  // `this.sequences[currentSeqIdx]` always reflects the latest edits.
  private syncCurrentToArray(): void {
    if (!this.sequences[this.currentSeqIdx]) {
      this.sequences[this.currentSeqIdx] = { bars: 1, resolution: 16, viewResolution: 16, grid: [], revGrid: [], velGrid: [], loop: true };
    }
    const cur = this.sequences[this.currentSeqIdx];
    cur.bars = this.seqBars;
    cur.resolution = this.seqResolution;
    cur.viewResolution = this.seqViewResolution;
    cur.grid = this.seqGrid.map(row => row ? [...row] : []);
    cur.revGrid = this.seqRevGrid.map(row => row ? [...row] : []);
    cur.velGrid = this.seqVelGrid.map(row => row ? [...row] : []);
    cur.loop = this.seqLoop;
  }
  private loadFromArray(idx: number): void {
    const src = this.sequences[idx];
    if (!src) return;
    this.seqBars = src.bars;
    this.seqResolution = src.resolution;
    this.seqViewResolution = src.viewResolution && src.resolution % src.viewResolution === 0 ? src.viewResolution : src.resolution;
    this.seqGrid = src.grid.map(row => row ? [...row] : []);
    this.seqRevGrid = (src.revGrid ?? []).map(row => row ? [...row] : []);
    this.seqVelGrid = (src.velGrid ?? []).map(row => row ? [...row] : []);
    this.seqLoop = src.loop;
  }
  private snapshotSequences(): SeqPattern[] {
    this.syncCurrentToArray();
    return this.sequences.map(p => ({
      bars: p.bars,
      resolution: p.resolution,
      viewResolution: p.viewResolution,
      grid: p.grid.map(row => row ? [...row] : []),
      revGrid: (p.revGrid ?? []).map(row => row ? [...row] : []),
      velGrid: (p.velGrid ?? []).map(row => row ? [...row] : []),
      loop: p.loop,
    }));
  }

  addSequence(): void {
    this.pushHistory();
    this.syncCurrentToArray();
    // Inherit bars + resolution from the current sequence so the grid feel
    // stays consistent when the user adds a new pattern. Loop on by default.
    const prev = this.sequences[this.currentSeqIdx];
    this.sequences.push({
      bars: prev?.bars ?? 1,
      // An empty pattern needs no finer storage than its view.
      resolution: prev?.viewResolution ?? prev?.resolution ?? 16,
      viewResolution: prev?.viewResolution ?? prev?.resolution ?? 16,
      grid: [],
      revGrid: [],
      velGrid: [],
      loop: true,
    });
    // Phase 3A.4: keep STEP-record armed (and its step cursor) across adding a
    // sequence so the user can keep dropping pads without re-clicking STEP.
    // selectSequence() clears these for plain tab-switches; restore them here.
    // The new sequence inherits bars + resolution, so the cursor stays in range.
    const wasRecording = this.recording;
    const keepStep = this.recordStep;
    this.selectSequence(this.sequences.length - 1);
    if (wasRecording) {
      this.recording = true;
      this.recordStep = keepStep;
      this.emit();
    }
  }
  selectSequence(idx: number): void {
    if (idx < 0 || idx >= this.sequences.length) return;
    if (idx === this.currentSeqIdx) return;
    // Flush current edits before switching the editing focus.
    this.syncCurrentToArray();
    this.currentSeqIdx = idx;
    this.loadFromArray(idx);

    if (this.seqPlaying) {
      const playingPattern = this.sequences[this.playingSeqIdx];
      if (playingPattern && playingPattern.loop) {
        // Queue — the swap happens at the next loop boundary so playback
        // never has a cut. Clicking the currently-playing tab cancels any
        // pending queue.
        this.queuedSeqIdx = (idx === this.playingSeqIdx) ? null : idx;
        this.emit();
        return;
      }
      // Not looping (or somehow playing without a pattern): stop and switch
      // immediately, since there's nothing to chain into.
      this.stopSeq();
    }
    this.recording = false;
    this.recordStep = 0;
    this.emit();
  }
  duplicateSequence(idx?: number): void {
    this.pushHistory();
    this.syncCurrentToArray();
    const i = idx ?? this.currentSeqIdx;
    const src = this.sequences[i];
    if (!src) return;
    const copy: SeqPattern = {
      bars: src.bars,
      resolution: src.resolution,
      viewResolution: src.viewResolution,
      grid: src.grid.map(row => row ? [...row] : []),
      revGrid: (src.revGrid ?? []).map(row => row ? [...row] : []),
      velGrid: (src.velGrid ?? []).map(row => row ? [...row] : []),
      loop: src.loop,
    };
    this.sequences.splice(i + 1, 0, copy);
    // Phase 3A.4: same STEP-record persistence as addSequence — duplicating is
    // also "adding a sequence", so the user can keep step-inputting uninterrupted.
    const wasRecording = this.recording;
    const keepStep = this.recordStep;
    this.selectSequence(i + 1);
    if (wasRecording) {
      this.recording = true;
      this.recordStep = keepStep;
      this.emit();
    }
  }
  deleteSequence(idx: number): void {
    if (this.sequences.length <= 1) return; // always keep at least one
    if (idx < 0 || idx >= this.sequences.length) return;
    this.pushHistory();
    this.stopSeq();
    this.syncCurrentToArray();
    this.sequences.splice(idx, 1);
    if (this.currentSeqIdx >= this.sequences.length) this.currentSeqIdx = this.sequences.length - 1;
    else if (this.currentSeqIdx > idx) this.currentSeqIdx -= 1;
    this.loadFromArray(this.currentSeqIdx);
    this.emit();
  }

  getSeqStepCount(): number {
    return Math.min(SEQ_MAX_STEPS, this.seqBars * this.seqResolution);
  }

  private seqTempo(): number {
    if (this.metronomeBpm > 0) return this.metronomeBpm;
    if (this.bpm > 0) return this.bpm;
    return 120;
  }

  getSeqStepDuration(): number {
    // One step = a note of the selected resolution. resolution counts how many
    // notes fit per bar (16 = 1/16 note, 32 = 1/32 note); a bar is 4 beats.
    return (60 / this.seqTempo()) * (4 / this.seqResolution);
  }

  setSeqBars(n: number): void {
    this.pushHistory();
    this.seqBars = Math.max(1, Math.min(4, Math.floor(n)));
    const cap = this.getSeqStepCount();
    if (this.seqGrid.length > cap) this.seqGrid.length = cap;
    if (this.seqRevGrid.length > cap) this.seqRevGrid.length = cap;
    if (this.seqVelGrid.length > cap) this.seqVelGrid.length = cap;
    this.emit();
  }

  /** Pick the grid on screen (steps per bar: straight 1/2 (2) … 1/128 (128),
   *  plus their triplets ×1.5: 3,6,12,24,48,96,192). This is a VIEW + the
   *  live-record quantize — the notes never move. Storage is refit around it:
   *  the coarsest resolution that is a multiple of the view AND lands every
   *  existing note on an integer step (so 1/16 → 1/8 keeps the off-beat 16ths
   *  as ghosts, 1/8 → 1/16 → 1/16T upscales losslessly, and going back down
   *  drops to the view again once every note fits). Anything else → 1/16. */
  setSeqResolution(n: number): void {
    this.pushHistory();
    const view = SEQ_RESOLUTIONS.has(n) ? n : 16;
    this.refitSeqStorage(view);
    // The scheduler reads this.sequences — publish the refit before its next
    // tick, in the same turn as the cursor rescale below.
    this.syncCurrentToArray();
    this.emit();
  }

  /** Stored steps per visible column (1/16 view over 1/32 storage → 2). */
  get seqColumnStride(): number { return Math.max(1, Math.round(this.seqResolution / this.seqViewResolution)); }
  /** Stored step index under a visible column. */
  seqStepForColumn(col: number): number { return col * this.seqColumnStride; }
  /** Visible columns in the loop. */
  getSeqViewStepCount(): number { return Math.min(SEQ_MAX_VIEW_STEPS, this.seqBars * this.seqViewResolution); }

  /** Re-store the current pattern at the coarsest resolution that (a) is a
   *  multiple of `view` and (b) keeps every note on an integer step. Lossless
   *  both ways. If the loop is running on this pattern the scheduler cursor,
   *  audible step length and pending loop boundaries are rescaled in place so
   *  the change is inaudible. */
  private refitSeqStorage(view: number, floor = 0): void {
    const old = this.seqResolution;
    const C = lcm(old, view);            // finest grid both fit on
    const up = C / old;                  // old step → C step
    let g = C / view;                    // largest divisor that keeps C/g a multiple of view
    this.seqGrid.forEach((row, s) => { if (row && row.length) g = gcd(g, s * up); });
    let next = C / g;                    // new stored resolution
    // A recording floor (INPUT Q below 100 needs somewhere to PUT an off-line
    // hit): raise storage to a real grid that is a multiple of `next`, so every
    // existing note keeps its integer step, and that still fits the step cap.
    if (floor > next) {
      const base = next;   // every candidate must be a MULTIPLE of this (notes stay integral)
      for (const r of SEQ_RESOLUTIONS) {
        if (r <= next || r > floor || r % base !== 0) continue;
        if (this.seqBars * r > SEQ_MAX_STEPS) continue;
        next = r;          // keep the finest that qualifies
      }
    }
    if (next !== old) {
      const grid: number[][] = [];
      const rev: boolean[][] = [];
      const vel: number[][] = [];
      this.seqGrid.forEach((row, s) => {
        if (!row || !row.length) return;
        const ns = (s * up) / g;
        grid[ns] = [...row];
        rev[ns] = this.seqRevGrid[s] ? [...this.seqRevGrid[s]] : [];
        vel[ns] = this.seqVelGrid[s] ? [...this.seqVelGrid[s]] : [];
      });
      this.seqGrid = grid;
      this.seqRevGrid = rev;
      this.seqVelGrid = vel;
      const ratio = next / old;
      // Step-input cursor keeps its place in time (and lands on a column).
      const stride = Math.max(1, Math.round(next / view));
      this.recordStep = Math.round((this.recordStep * ratio) / stride) * stride;
      if (this.seqPlaying) {
        const oldDur = (60 / this.seqTempo()) * (4 / old);
        const newDur = (60 / this.seqTempo()) * (4 / next);
        if (this.seqScheduleIdx === this.currentSeqIdx) {
          // Everything before seqScheduledUpTo is already queued. Continue from
          // the first NEW step at/after that instant — when that sits later than
          // the old cursor (a downscale over empty old steps) advance the
          // schedule point with it, so audio never doubles up or drifts.
          const exact = this.seqScheduleStep * ratio;
          const ns = Math.ceil(exact - 1e-9);
          this.seqScheduledUpTo += (ns / ratio - this.seqScheduleStep) * oldDur;
          this.seqScheduleStep = ns;
        }
        if (this.playingSeqIdx === this.currentSeqIdx) this.seqStepDuration = newDur;
        for (const b of this.seqBoundaries) if (b.seqIdx === this.currentSeqIdx) b.stepDur = newDur;
      }
      this.seqResolution = next;
    }
    this.seqViewResolution = view;
    const cap = this.getSeqStepCount();
    if (this.seqGrid.length > cap) this.seqGrid.length = cap;
    if (this.seqRevGrid.length > cap) this.seqRevGrid.length = cap;
    if (this.seqVelGrid.length > cap) this.seqVelGrid.length = cap;
    const vcap = this.getSeqViewStepCount();
    if (this.recordStep >= vcap * this.seqColumnStride) this.recordStep = 0;
  }

  toggleSeqStep(step: number, padIdx: number): void {
    if (step < 0 || step >= this.getSeqStepCount()) return;
    this.pushHistory();
    const row = this.seqGrid[step] ? [...this.seqGrid[step]] : [];
    const rev = this.seqRevGrid[step] ? [...this.seqRevGrid[step]] : [];
    const vel = this.seqVelGrid[step] ? [...this.seqVelGrid[step]] : [];
    const i = row.indexOf(padIdx);
    if (i >= 0) {
      row.splice(i, 1);
      rev.splice(i, 1);
      vel.splice(i, 1);
    } else {
      row.push(padIdx);
      // Capture the global reverse state at placement time — this is what makes
      // "REV on" record reversed notes into the sequence.
      rev.push(this.reverseSample);
      vel.push(1);
    }
    this.seqGrid[step] = row;
    this.seqRevGrid[step] = rev;
    this.seqVelGrid[step] = vel;
    this.emit();
  }
  /** Per-cell VELOCITY (0.05..1) for a placed note; absent = 1. */
  seqStepVelocity(step: number, padIdx: number): number {
    const i = this.seqGrid[step]?.indexOf(padIdx) ?? -1;
    if (i < 0) return 1;
    return clampVel(this.seqVelGrid[step]?.[i] ?? 1);
  }
  setSeqStepVelocity(step: number, padIdx: number, v: number): void {
    const row = this.seqGrid[step];
    const i = row ? row.indexOf(padIdx) : -1;
    if (i < 0) return;
    const vel = this.seqVelGrid[step] ? [...this.seqVelGrid[step]] : [];
    while (vel.length < row!.length) vel.push(1);
    const nv = clampVel(v);
    if (vel[i] === nv) return;
    this.pushHistory();
    vel[i] = nv;
    this.seqVelGrid[step] = vel;
    this.syncCurrentToArray();
    this.emit();
  }
  /** 16T swing on the chop seq (0..1) — mirrored from the drum SWING knob. */
  setSeqSwing(v: number): void {
    const s = Math.max(0, Math.min(1, Number(v) || 0));
    if (s === this.seqSwing) return;
    this.seqSwing = s;
    this.emit();
  }
  getSeqSwing(): number { return this.seqSwing; }
  /** The swing offset (seconds) for a STORED step of a pattern at `resolution`
   *  steps per bar — steps inside an odd 16th all shift with that 16th, the
   *  same rule the drum lanes use. */
  seqSwingOffsetSec(step: number, resolution: number): number {
    if (this.seqSwing <= 0) return 0;
    const idx16 = Math.floor((step * 16) / Math.max(1, resolution));
    return swingOffsetSec(idx16, this.seqTempo(), this.seqSwing);
  }

  /** Flip the per-cell reverse flag for a specific (step, pad) hit. */
  toggleSeqStepReverse(step: number, padIdx: number): void {
    if (step < 0 || step >= this.getSeqStepCount()) return;
    const row = this.seqGrid[step];
    if (!row) return;
    const i = row.indexOf(padIdx);
    if (i < 0) return;
    this.pushHistory();
    const rev = this.seqRevGrid[step] ? [...this.seqRevGrid[step]] : new Array(row.length).fill(false);
    while (rev.length < row.length) rev.push(false);
    rev[i] = !rev[i];
    this.seqRevGrid[step] = rev;
    this.emit();
  }

  clearSeqStep(step: number): void {
    if (step < 0 || step >= this.getSeqStepCount()) return;
    this.pushHistory();
    this.seqGrid[step] = [];
    this.seqRevGrid[step] = [];
    this.seqVelGrid[step] = [];
    this.emit();
  }

  /** Move a single pad-hit from one step to another. No-op when src == dst,
   *  or when the destination already contains that pad. */
  moveSeqNote(fromStep: number, padIdx: number, toStep: number): void {
    const total = this.getSeqStepCount();
    if (fromStep < 0 || fromStep >= total || toStep < 0 || toStep >= total) return;
    if (fromStep === toStep) return;
    this.pushHistory();
    const src = this.seqGrid[fromStep] ? [...this.seqGrid[fromStep]] : [];
    const srcRev = this.seqRevGrid[fromStep] ? [...this.seqRevGrid[fromStep]] : [];
    const srcVel = this.seqVelGrid[fromStep] ? [...this.seqVelGrid[fromStep]] : [];
    const at = src.indexOf(padIdx);
    if (at < 0) return;
    src.splice(at, 1);
    const moveRev = srcRev.splice(at, 1)[0] ?? false;
    const moveVel = srcVel.splice(at, 1)[0] ?? 1;
    const dst = this.seqGrid[toStep] ? [...this.seqGrid[toStep]] : [];
    const dstRev = this.seqRevGrid[toStep] ? [...this.seqRevGrid[toStep]] : [];
    const dstVel = this.seqVelGrid[toStep] ? [...this.seqVelGrid[toStep]] : [];
    if (!dst.includes(padIdx)) {
      dst.push(padIdx);
      dstRev.push(moveRev);
      while (dstVel.length < dst.length - 1) dstVel.push(1);
      dstVel.push(moveVel);
    }
    this.seqGrid[fromStep] = src;
    this.seqRevGrid[fromStep] = srcRev;
    this.seqVelGrid[fromStep] = srcVel;
    this.seqGrid[toStep] = dst;
    this.seqRevGrid[toStep] = dstRev;
    this.seqVelGrid[toStep] = dstVel;
    this.emit();
  }

  clearSeq(): void {
    this.pushHistory();
    // Clear ONLY the pattern data. Clearing must NEVER stop the transport or
    // disarm recording — if the sequencer is running (step-input or live-record
    // included) it keeps rolling straight into the now-empty pattern with no
    // interruption. So we do NOT call stopSeq() here.
    const wasPlaying = this.seqPlaying && !this.seqPaused;
    this.seqGrid = [];
    this.seqRevGrid = [];
    this.seqVelGrid = [];
    // Flush the emptied grid into the active sequence so the look-ahead
    // scheduler reads the cleared pattern on its next pass.
    this.syncCurrentToArray();
    if (wasPlaying) {
      // Kill the chop audio already queued by the look-ahead (and its pending
      // chokes) so the clear is heard immediately — but leave the scheduler, the
      // playhead anchor, seqPlaying and the recording flags untouched, so
      // playback (and any armed recording) rolls straight on over empty steps.
      for (const t of this.loopTimers) clearTimeout(t);
      this.loopTimers = [];
      for (const src of this.scheduledSources) {
        try { src.stop(); } catch { /* */ }
        try { src.disconnect(); } catch { /* */ }
      }
      this.scheduledSources = [];
      this.seqTailVoices = [];
    }
    this.emit();
  }

  toggleSeqLoop(): void { this.seqLoop = !this.seqLoop; this.emit(); }

  startRecordingSeq(): void {
    // Step-input mode: each pad hit fills the next EMPTY cell in sequence.
    // Cursor jumps to step 0 then skips forward past any already-filled cells.
    // Snapshot here so a whole recording session is one undo step — the user
    // can ARM, fill the pattern, then Cmd+Z to wipe just the recording.
    this.pushHistory();
    this.liveRecording = false; // never both at once
    this.recording = true;
    this.recordStep = 0;
    this.advanceRecordToEmpty();
    this.emit();
  }

  private advanceRecordToEmpty(): void {
    const stride = this.seqColumnStride;
    const cols = this.getSeqViewStepCount();
    if (cols === 0) return;
    // Skip filled COLUMNS (stored steps under the visible grid).
    let scanned = 0;
    while (
      scanned < cols &&
      this.seqGrid[this.recordStep] &&
      this.seqGrid[this.recordStep].length > 0
    ) {
      this.recordStep = (this.recordStep + stride) % (cols * stride);
      scanned++;
    }
  }
  stopRecordingSeq(): void {
    this.recording = false;
    this.emit();
  }

  /** LIVE record — looper style. Arms real-time recording: the loop starts (if
   *  not already running), and from here every pad hit is quantized to the
   *  nearest grid line and written into the pattern, so it loops back. Mutually
   *  exclusive with step-input recording. One pushHistory so the whole session
   *  is a single undo. */
  /** Write one live hit into the playing loop, quantised to the grid ON SCREEN
   *  (a column), at that column's stored step — storage may be finer than the view. */
  // ctx time each pad was last HAND-played while live-recording — the step
  // scheduler skips a pattern firing of that pad within 120ms of it: the hand
  // hit IS that step's audio (see scheduleSeqStepAudio's fireRow filter).
  private lastLivePadHit = new Map<number, number>();

  /** Where a hit at `hitTime` lands (see liveLanding) — in stored steps and in
   *  ctx time, both measured from the audible loop start. */
  private liveLandingFor(hitTime: number): { step: number; at: number } {
    const r = liveLanding(hitTime - this.seqCurrentLoopStart, this.seqStepDuration,
      this.seqColumnStride, this.inputQuantizeStrength());
    return { step: r.step, at: this.seqCurrentLoopStart + r.at };
  }
  private writeLiveHit(padIdx: number, hitTime: number): void {
    if (this.seqStepDuration <= 0) return;
    this.writeLiveStep(padIdx, this.liveLandingFor(hitTime).step);
  }
  /** Stamp a hit on STORED step `step` (unwrapped — negatives and next-loop
   *  overshoot wrap into the pattern). The record path writes the exact instant
   *  it scheduled, so write and sound can't drift. Returns whether the pad was
   *  ALREADY on that step (overdubbing along with the playing pattern — the
   *  caller uses it to avoid double-firing). */
  private writeLiveStep(padIdx: number, step: number, velocity = 1): { wasOn: boolean } {
    const stepCount = this.getSeqStepCount();
    if (stepCount <= 0) return { wasOn: false };
    step = ((step % stepCount) + stepCount) % stepCount; // wrap into the loop
    const row = this.seqGrid[step] ? [...this.seqGrid[step]] : [];
    if (row.includes(padIdx)) return { wasOn: true };
    const rev = this.seqRevGrid[step] ? [...this.seqRevGrid[step]] : [];
    const vel = this.seqVelGrid[step] ? [...this.seqVelGrid[step]] : [];
    while (vel.length < row.length) vel.push(1);
    row.push(padIdx);
    rev.push(this.reverseSample);
    vel.push(clampVel(velocity));   // the take keeps the hit's dynamics
    this.seqGrid[step] = row;
    this.seqRevGrid[step] = rev;
    this.seqVelGrid[step] = vel;
    this.syncCurrentToArray(); // so the next loop iteration schedules it
    return { wasOn: false };
  }
  /** Downbeat of a count-in: hits within half a grid step before the "1" ARE
   *  the one; earlier ones were practice. */
  private flushEarlyHits(): void {
    const hits = this.earlyHits; this.earlyHits = [];
    if (!hits.length || !this.seqPlaying) return;
    const window = this.seqStepDuration * this.seqColumnStride / 2;
    for (const h of hits) if (h.at >= this.seqPlayStart - window) this.writeLiveHit(h.padIdx, Math.max(h.at, this.seqPlayStart));
  }

  /** INPUT Q below 100 means hits land BETWEEN grid lines — the pattern needs
   *  a fine enough storage grid to hold them, or "record my feel" would still
   *  snap to the line. Storage is a lens change: the view, the notes and the
   *  running loop are untouched (refitSeqStorage rescales the cursor), so this
   *  is inaudible. At INPUT Q 100 nothing moves. */
  private ensureRecordStorage(): void {
    if (this.inputQuantizeStrength() >= 0.999) return;
    const target = 192; // the finest grid the sequencer stores (~7ms at 90 BPM)
    if (this.seqResolution >= target) return;
    this.refitSeqStorage(this.seqViewResolution, target);
    this.syncCurrentToArray();
  }

  startLiveRecord(): void {
    if (!this.hasSequenceableAudio()) return;
    this.recording = false; // never both at once
    this.ensureRecordStorage();
    this.seqLoop = true;     // a looper must loop
    // If the loop is already running, just arm — no count-in, the user is
    // already hearing the beat. Start playback FIRST otherwise (playSeq() calls
    // stopSeq(), which clears the liveRecording flag) then arm.
    if (this.seqPlaying) {
      this.pushHistory();
      this.liveRecording = true;
      this.emit();
      return;
    }
    if (!this.countInEnabled) {
      this.pushHistory();
      this.playSeq();
      this.liveRecording = true;
      this.emit();
      return;
    }
    // Count-in: click a bar of beats first, then start the loop + arm recording
    // exactly on the downbeat that follows.
    this.beginCountIn();
  }

  /** Click `countInBeats` metronome beats at the loop tempo, then start the
   *  loop and arm live-record on the downbeat. Visual countdown via countInBeat. */
  private beginCountIn(): void {
    this.cancelCountIn();
    this.pushHistory();
    this.countInPending = true;
    this.earlyHits = [];
    this.scheduleCountIn(() => {
      // playSeq() → stopSeq() → cancelCountIn() wipes earlyHits: take them first.
      const early = this.earlyHits; this.earlyHits = []; this.countInPending = false;
      this.playSeq();
      this.liveRecording = true;
      this.earlyHits = early; this.flushEarlyHits();
      this.emit();
    });
  }

  /** Schedule the count-in clicks + visual countdown, then run `onDownbeat` a hair
   *  before the downbeat (so playSeq()'s internal +0.02 look-ahead — or a matching
   *  drum start — lands the "1" on the beat). PURE timing/click/visual: the caller
   *  decides what starts on the downbeat. Shared by the chop live-record count-in
   *  (beginCountIn) and LIVE drum-mode recording (runCountIn). Does NOT cancel a
   *  pending count-in or push history — callers handle that. */
  private scheduleCountIn(onDownbeat: () => void): void {
    if (this.ctx.state !== 'running') this.ctx.resume().catch(() => {});
    const beats = Math.max(1, this.countInBeats);
    const beatDur = 60 / this.seqTempo();
    const startAt = this.ctx.currentTime + 0.12; // small lead so the first click isn't clipped
    for (let i = 0; i < beats; i++) {
      const at = startAt + i * beatDur;
      // Accent the very first beat of the count so the "1" stands out.
      this.scheduleMetronomeClick(at, i === 0 ? 0 : 1);
      const delayMs = Math.max(0, (at - this.ctx.currentTime) * 1000);
      this.countInTimers.push(setTimeout(() => { this.countInBeat = beats - i; this.emit(); }, delayMs));
    }
    const downbeat = startAt + beats * beatDur;
    const startDelayMs = Math.max(0, (downbeat - 0.02 - this.ctx.currentTime) * 1000);
    this.countInTimers.push(setTimeout(() => {
      this.countInTimers = [];
      this.countInBeat = -1;
      onDownbeat();
      this.emit();
    }, startDelayMs));
    this.countInBeat = beats; // show the full count immediately
    this.emit();
  }

  /** LIVE drum mode: run the SAME count-in the chop live-record uses (identical
   *  clicks, bar count and visual countInBeat), then call `onDownbeat` on the
   *  downbeat INSTEAD of starting the chop loop — the caller starts the drum
   *  sequencer + arms drum recording there. Cancels any pending count-in first;
   *  stopLiveRecord()/stopSeq() aborts it (both call cancelCountIn). */
  runCountIn(onDownbeat: () => void): void {
    this.cancelCountIn();
    this.scheduleCountIn(onDownbeat);
  }

  private cancelCountIn(): void {
    for (const t of this.countInTimers) clearTimeout(t);
    this.countInTimers = [];
    this.countInBeat = -1;
    this.countInPending = false;
    this.earlyHits = [];
  }

  stopLiveRecord(): void {
    this.cancelCountIn(); // abort a pending count-in if it hasn't started yet
    this.liveRecording = false;
    this.emit(); // leave the loop playing so the user hears what they recorded
  }

  setCountInEnabled(on: boolean): void { this.countInEnabled = on; this.emit(); }
  toggleCountIn(): void { this.countInEnabled = !this.countInEnabled; this.emit(); }
  toggleLiveRecord(): void {
    if (this.liveRecording || this.countInBeat >= 0) this.stopLiveRecord();
    else this.startLiveRecord();
  }
  /** Park the step-input cursor on a stored step (snapped to a visible column). */
  setRecordStep(step: number): void {
    const stride = this.seqColumnStride;
    const cap = this.getSeqViewStepCount() * stride;
    if (cap <= 0) { this.recordStep = 0; return; }
    const st = ((Math.floor(step) % cap) + cap) % cap;
    this.recordStep = Math.floor(st / stride) * stride;
    this.emit();
  }

  playSeq(): void {
    if (!this.hasSequenceableAudio()) return;
    this.seqRestarting = true;
    try { this.stopSeq(); } finally { this.seqRestarting = false; }
    // Flush any pending edits into the active pattern so playback sees the
    // latest grid.
    this.syncCurrentToArray();
    this.playingSeqIdx = this.currentSeqIdx;
    this.seqScheduleIdx = this.currentSeqIdx;
    this.queuedSeqIdx = null;
    // PLAY should feel instant. The scheduler is primed SYNCHRONOUSLY below
    // (seqSchedulerTick runs in this same call), so the downbeat only needs to
    // sit a hair in the future — 20 ms covers the prime + Web Audio's "start
    // time must not be in the past". The old 60 ms was audible as a lag on
    // PLAY (his report 2026-08-22); the drums and bass take this same anchor.
    // NATIVE: the sink may ask for more lead — the engine must RENDER the anchor's sample before it is heard (its
    // device's output latency + a block + the bridge); the satellites take the same anchor, so nothing is out of phase
    const lead = Math.max(ChopperEngine.TRANSPORT_LEAD_S, this.seqSink?.leadSec?.() ?? 0);
    this.seqPlayStart = this.ctx.currentTime + lead;
    this.seqCurrentLoopStart = this.seqPlayStart;
    this.seqScheduledUpTo = this.seqPlayStart;
    this.seqScheduleStep = 0;
    this.seqTailVoices = [];
    this.seqBoundaries = [];
    this.seqStopAt = 0;
    this.seqPlaying = true;
    this.seqPaused = false;
    this.seqStep = 0;
    // Metronome stays under explicit user control — don't auto-enable it
    // here. If it's already on, lock its phase to step 0 of the loop so the
    // click and the pattern stay aligned.
    if (this.ctx.state !== 'running') this.ctx.resume().catch(() => {});
    const initialPattern = this.sequences[this.playingSeqIdx];
    if (initialPattern) {
      this.seqStepDuration = (60 / this.seqTempo()) * (4 / initialPattern.resolution);
    }
    if (this.metronomeEnabled) {
      this.metronomeBeat = 0;
      this.nextBeatTime = this.seqPlayStart;
      this.startMetronomeTimer();
    }
    if (this.seqSink) {
      // NATIVE: the C++ ChopSequencer runs from this anchor (the shadow maps it to an engine sample) — no TS voices.
      this.nativeSeqCmdAt = performance.now();
      this.seqSink.play(this.seqPlayStart);
    } else {
      // Prime the scheduler immediately (no initial-latency gap), then keep it
      // filling the look-ahead horizon on a 25ms interval.
      this.seqSchedulerTick();
      this.startSeqScheduler();
    }
    // Start the synced satellite (drums) at the SAME anchor so they're phase-locked.
    this.seqStartHook?.(this.seqPlayStart);
    this.emit();
  }

  /** Register start/stop hooks so a satellite engine (the drum sequencer) runs in
   *  lock-step with the chop sequencer. onStart receives the exact ctx anchor. */
  setTransportHooks(onStart: (atTime: number) => void, onStop: (restart: boolean) => void, onNudge?: (deltaSec: number) => void): void {
    this.seqStartHook = onStart;
    this.seqStopHook = onStop;
    this.seqNudgeHook = onNudge ?? null;
  }

  togglePlaySeq(): void {
    if (this.seqPlaying) this.stopSeq();
    else this.playSeq();
  }

  pauseSeq(): void {
    if (!this.seqPlaying || this.seqPaused) return;
    // Make sure the audible anchor is current (a boundary may have passed since
    // the last scheduler tick) so the frozen phase is exact.
    const now = this.ctx.currentTime;
    while (this.seqBoundaries.length > 0 && this.seqBoundaries[0].time <= now) {
      const b = this.seqBoundaries.shift()!;
      this.seqCurrentLoopStart = b.time;
      this.seqStepDuration = b.stepDur;
      this.playingSeqIdx = b.seqIdx;
    }
    // Freeze where the cursor sits right now, then tear down the scheduler and
    // all scheduled audio so nothing fires while paused. seqPlaying stays true
    // so the rAF keeps spinning and the cursor stays visible but stationary
    // (both getters short-circuit to seqPausedElapsed).
    this.seqPausedElapsed = now - this.seqCurrentLoopStart;
    this.stopSeqScheduler();
    this.stopMetronomeTimer(); // freeze the click with the transport
    for (const t of this.loopTimers) clearTimeout(t);
    this.loopTimers = [];
    for (const src of this.scheduledSources) {
      try { src.stop(); } catch { /* */ }
      try { src.disconnect(); } catch { /* */ }
    }
    this.scheduledSources = [];
    this.seqTailVoices = [];
    this.seqBoundaries = [];
    this.seqStopAt = 0;
    this.seqPaused = true;
    if (this.seqSink) { this.nativeSeqCmdAt = performance.now(); this.seqSink.pause(); }
    this.emit();
  }

  resumeSeq(): void {
    if (!this.seqPlaying || !this.seqPaused) return;
    const pattern = this.sequences[this.playingSeqIdx];
    if (!pattern) { this.seqPaused = false; return; }
    const now = this.ctx.currentTime + 0.02; // same look-ahead as playSeq
    // Re-anchor the SINGLE source of truth so the cursor, the integer step, the
    // scheduled audio and the metronome all resume from the frozen phase
    // together — none can jump because they all derive from seqCurrentLoopStart.
    const oldLoopStart = this.seqCurrentLoopStart;
    this.seqCurrentLoopStart = now - this.seqPausedElapsed;
    this.seqPlayStart += (this.seqCurrentLoopStart - oldLoopStart);
    if (this.metronomeEnabled) {
      // Re-anchor the click to the next on-grid beat off the same loop anchor.
      const beatDur = 60 / this.seqTempo();
      const nextBeatIdx = Math.ceil(this.seqPausedElapsed / beatDur - 1e-9);
      this.metronomeBeat = ((nextBeatIdx % 4) + 4) % 4;
      this.nextBeatTime = this.seqCurrentLoopStart + nextBeatIdx * beatDur;
      this.startMetronomeTimer();
    }
    this.seqPaused = false;
    // Re-prime the look-ahead STEP cursor at the next step boundary at/after the
    // resumed phase, within the CURRENT loop. No boundary is queued here — the
    // audible anchor (seqCurrentLoopStart) is already set above; the tick queues
    // boundaries for subsequent loops once the cursor wraps. The note that was
    // mid-play at pause is not resumed (it was stopped) — playback picks up at
    // the next step, matching the previous behaviour.
    const stepCount = Math.min(SEQ_MAX_STEPS, pattern.bars * pattern.resolution);
    const stepDur = (60 / this.seqTempo()) * (4 / pattern.resolution);
    this.seqStepDuration = stepDur;
    this.seqScheduleIdx = this.playingSeqIdx;
    this.seqBoundaries = [];
    this.seqTailVoices = [];
    this.seqStopAt = 0;
    if (stepCount > 0 && stepDur > 0) {
      let nextStep = Math.ceil(this.seqPausedElapsed / stepDur - 1e-9);
      if (nextStep < 0) nextStep = 0;
      if (nextStep >= stepCount) {
        // Resumed at/after the loop end → the cursor starts a fresh next loop
        // (the tick pushes that loop's boundary when it schedules step 0).
        this.seqScheduleStep = 0;
        this.seqScheduledUpTo = this.seqCurrentLoopStart + stepCount * stepDur;
      } else {
        this.seqScheduleStep = nextStep;
        this.seqScheduledUpTo = this.seqCurrentLoopStart + nextStep * stepDur;
      }
    } else {
      this.seqScheduleStep = 0;
    }
    if (this.seqSink) { this.nativeSeqCmdAt = performance.now(); this.seqSink.resume(); }
    else { this.seqSchedulerTick(); this.startSeqScheduler(); }
    this.emit();
  }

  /** Hard-cut the previously-scheduled active step's tails at `atTime` so the
   *  arriving note takes over cleanly (mono). At constant BPM the natural fade
   *  already ends at the next hit, so this is a no-op — it only engages when the
   *  next hit lands earlier than a tail's natural end (BPM raised mid-loop),
   *  which would otherwise leave the old chop ringing under the new one. */
  /** Cut the ringing tails of earlier steps at `atTime` — only those in the
   *  MUTE GROUPS firing now (a break's tail is not cut by the sample's next
   *  chop). Tails in other groups stay listed until they end on their own. */
  private cutSeqTails(atTime: number, groups: Set<string>): void {
    if (this.seqTailVoices.length === 0) return;
    const FADE = 0.005;
    const keep: typeof this.seqTailVoices = [];
    for (const v of this.seqTailVoices) {
      if (atTime >= v.naturalEnd - FADE) continue;          // already over
      if (!groups.has(v.group)) { keep.push(v); continue; }  // another group — leave it
      // Skip tails that haven't started (scheduled ahead) — nothing to cut yet.
      if (atTime <= v.startAt) { keep.push(v); continue; }
      const cutFrom = Math.max(v.startAt, atTime - FADE);
      try {
        v.gain.gain.cancelScheduledValues(cutFrom);
        v.gain.gain.setValueAtTime(1, cutFrom); // still on the sustain plateau (=1)
        v.gain.gain.linearRampToValueAtTime(0.0001, atTime);
      } catch { /* node already finished */ }
    }
    this.seqTailVoices = keep;
  }
  /** Tail key of a pad for the sequencer: its group, or the pad itself when
   *  polyphonic (a pad re-hitting still cuts its own previous note). */
  private seqTailGroup(padIdx: number): string {
    const g = this.chokeGroupOf(padIdx);
    return g === 'none' ? `pad:${padIdx}` : g;
  }

  /** Schedule ONE step's note audio at absolute ctx time `startAt`. Pure audio +
   *  per-note background-choke + mono tail-cut; does NOT touch the audible anchor
   *  or re-arm anything — the look-ahead step scheduler owns those. No-op for an
   *  inactive (empty) step. */
  private scheduleSeqStepAudio(pattern: SeqPattern, step: number, startAt: number, stepCount: number, stepDur: number): void {
    const row = pattern.grid[step];
    if (!row || row.length === 0) return;               // inactive step
    // A step the scheduler reached LATE (a stall longer than the look-ahead)
    // is not dropped: it starts now, `late` seconds into the chop, for the rest
    // of its slot — the groove keeps its place instead of losing a note. Only
    // a step whose whole slot has already passed is skipped.
    const now = this.ctx.currentTime;
    const late = Math.max(0, now - startAt);
    if (late >= stepDur - 0.005) return;
    if (late > 0) startAt = now;

    // One owner per hit: a pad HAND-played onto this very step while live-
    // recording already IS this step's audio — firing the pattern's copy too
    // would choke the ringing hand voice (the group choke below) and restart
    // the chop from its head (his "cut short" report, chop side). Filter such
    // pads out BEFORE the choke set is built, so their live voices ring on.
    const fireRow = row.filter(p => {
      const lv = this.lastLivePadHit.get(p);
      return lv === undefined || Math.abs(startAt - lv) >= 0.12;
    });
    if (fireRow.length === 0) return;

    // Choke any pad still ringing in the background (manual hits / live-record
    // taps) right as this sequencer note fires, so the sequence stays clean and
    // mono — the note "takes over" from whatever was playing.
    const chokeDelay = Math.max(0, (startAt - now) * 1000);
    // Which mute groups fire at this step — they choke their live voices and
    // cut their earlier tails; other groups ring on.
    const stepGroups = new Set<string>(fireRow.map(p => this.seqTailGroup(p)));
    const chokeTimer = setTimeout(() => {
      this.chokeVoicesInGroups(stepGroups);
      const i = this.loopTimers.indexOf(chokeTimer);
      if (i >= 0) this.loopTimers.splice(i, 1);   // don't hold a fired timer for the whole session
    }, chokeDelay);
    this.loopTimers.push(chokeTimer);

    // Where does this note stop? At the NEXT active step (wrapping into the next
    // loop when looping is on), otherwise the end of the pattern. The distance is
    // pattern-based; multiplied by the CURRENT stepDur so at constant BPM the
    // fade ends exactly when the next hit starts (no overlap, no gap).
    // Where does a note stop? At the next step where a pad of the SAME mute
    // group fires (wrapping into the next loop when looping), else the end of
    // the pattern. Per group, so a break's hit is not cut short by the
    // sample's next chop.
    const nextStepFor = (group: string): number => {
      const hits = (s: number) => !!pattern.grid[s] && pattern.grid[s].some(p => this.seqTailGroup(p) === group);
      for (let s = step + 1; s < stepCount; s++) if (hits(s)) return s;
      if (pattern.loop) for (let s = 0; s <= step; s++) if (hits(s)) return s + stepCount;
      return -1;
    };
    const maxDurFor = (group: string): number => { const next = nextStepFor(group); return (next < 0 ? stepCount - step : next - step) * stepDur; };

    // The step's groups take over from their earlier notes — cut those tails
    // first (no-op unless they'd overlap), then track this step's tails.
    this.cutSeqTails(startAt, stepGroups);
    const newTails: Array<{ gain: GainNode; naturalEnd: number; startAt: number; group: string }> = [];

    const revRow = pattern.revGrid?.[step];
    const velRow = pattern.velGrid?.[step];
    for (let r = 0; r < fireRow.length; r++) {
      // per-cell velocity — indexed in the STORED row (fireRow is a filter of it)
      const vel = clampVel(velRow?.[row.indexOf(fireRow[r])] ?? 1);
      const padIdx = fireRow[r];
      // REV is GLOBAL at playback (2026-08-18, his call): the sequencer plays
      // pads, and the pads play whatever the waveform's REV says right now —
      // flip it after recording and the whole take flips. The per-cell flag
      // recorded into revGrid is kept as data but no longer read here.
      void revRow;
      const pad = this.pads[padIdx];
      if (!pad) continue;
      const reverse = this.reversedFor(padIdx);
      // The pad's SOURCE — its own audio (trimmed) or its main-track chop. Pad
      // sources never played from the sequencer before this (only chop pads did).
      const psrc = this.resolvePadSource(padIdx);
      if (!psrc) continue;
      const chop = { start: psrc.start, end: psrc.end };
      const chopDur = chop.end - chop.start;
      // Pitch is varispeed: detune → playbackRate r = 2^(semitones/12). The
      // start() `duration` arg is measured in BUFFER seconds (un-rate-adjusted),
      // so to keep a chop sounding until the next step — maxDur REAL seconds — we
      // must read maxDur*r buffer-seconds, clamped to the chop's content. Without
      // the *r a pitched-up chop (r>1) ends at maxDur/r real and gets cut short.
      const rate = Math.pow(2, (pad.pitch + this.pitchFor(padIdx)) / 12);
      // A late step has already "played" `late` real seconds of its slot: skip
      // that much of the chop (buffer seconds = late × rate) and shorten the
      // slot to what's left, so it lands where the ear expects it.
      const skipBuf = late * rate;
      const maxDur = maxDurFor(this.seqTailGroup(padIdx));
      const bufDur = Math.min(chopDur - skipBuf, (maxDur - late) * rate); // buffer seconds to read
      const realDur = bufDur / rate;                   // real seconds it sounds
      if (bufDur <= 0.005) continue;

      // Per-cell reverse: read from the mirrored buffer at the chop's mirrored
      // offset. Falls back to the forward buffer otherwise.
      let srcBuf: AudioBuffer = psrc.buffer;
      let startSec = chop.start + skipBuf;
      if (reverse) {
        srcBuf = this.reversedOf(psrc.buffer);
        startSec = psrc.buffer.duration - chop.end + skipBuf;
      }

      const src = this.ctx.createBufferSource();
      src.buffer = srcBuf;
      src.detune.value = (pad.pitch + this.pitchFor(padIdx)) * 100;

      // Brief fade-out at the cut to suppress clicks when chops get truncated by
      // the next step. Timed in REAL seconds (realDur) since the gain envelope
      // runs on the context clock.
      const gain = this.ctx.createGain();
      const FADE = 0.005;
      // ATTACK from the waveform bar — the SAME envelope live pads get
      // (startVoice). It never applied here, so with the sequencer running the
      // knob did nothing. Clamped so it can't outlast the slot.
      const atk = Math.min(Math.max(this.attackFor(padIdx), 0.0005), Math.max(0.0005, realDur - FADE));
      gain.gain.setValueAtTime(0, startAt);
      gain.gain.linearRampToValueAtTime(vel, startAt + atk);
      if (realDur > FADE + atk) {
        gain.gain.setValueAtTime(vel, startAt + realDur - FADE);
        gain.gain.linearRampToValueAtTime(0.0001, startAt + realDur);
      }
      src.connect(gain);
      gain.connect(this.busFor(padIdx));
      src.start(startAt, startSec, bufDur);
      // Self-prune when the voice finishes so finished scheduled sources don't
      // stay wired into the graph across loop iterations (the array is only
      // cleared on pause/stop). The `scheduledSources` entry stays for the
      // pause/stop sweep, but the node is disconnected here.
      src.onended = () => {
        try { src.disconnect(); gain.disconnect(); } catch (_) { /* */ }
        // Drop the finished node from the pause/stop sweep list — it used to be
        // kept for the whole play session (tens of thousands of dead nodes on
        // a long jam).
        const i = this.scheduledSources.indexOf(src);
        if (i >= 0) this.scheduledSources.splice(i, 1);
      };
      this.scheduledSources.push(src);
      newTails.push({ gain, naturalEnd: startAt + realDur, startAt, group: this.seqTailGroup(padIdx) });
    }
    // Earlier tails in other groups keep ringing alongside this step's.
    this.seqTailVoices = [...this.seqTailVoices, ...newTails];
  }

  private startSeqScheduler(): void {
    if (this.seqSchedulerTimer) return;
    this.seqLook.reset();
    this.seqSchedulerTimer = startClock(() => { this.seqLook.beat(); this.seqSchedulerTick(); }, this.SEQ_INTERVAL);
  }

  private stopSeqScheduler(): void {
    if (this.seqSchedulerTimer) { this.seqSchedulerTimer.stop(); this.seqSchedulerTimer = null; }
  }

  /** The robust loop heartbeat (replaces the one-shot re-arm setTimeout). Each
   *  tick: (1) advance the audible anchor as scheduled boundaries are reached,
   *  (2) handle a non-loop end, (3) fill the ~150ms look-ahead horizon with whole
   *  loop iterations. A main-thread stall up to the horizon can't gap the seam
   *  because the audio is already queued sample-accurately via src.start. */
  private seqSchedulerTick(): void {
    if (this.ctx.state === 'closed') { this.stopSeqScheduler(); return; }
    if (!this.seqPlaying || this.seqPaused) return;
    const now = this.ctx.currentTime;

    // (1) Advance the AUDIBLE anchor as crossed boundaries pass, so the playhead
    //     + live-record quantize reflect what's sounding (NOT the look-ahead).
    const prevPlayingIdx = this.playingSeqIdx;
    while (this.seqBoundaries.length > 0 && this.seqBoundaries[0].time <= now) {
      const b = this.seqBoundaries.shift()!;
      this.seqCurrentLoopStart = b.time;
      this.seqStepDuration = b.stepDur;
      this.playingSeqIdx = b.seqIdx;
    }

    // (2) Non-loop pattern finished playing through → stop cleanly.
    if (this.seqStopAt > 0 && now >= this.seqStopAt) {
      this.seqPlaying = false;
      this.seqStep = -1;
      this.stopSeqScheduler();
      this.emit();
      return;
    }

    // (3) Fill the tight horizon ONE STEP AT A TIME. stepDur is re-read every
    //     step from the live tempo, so a BPM change applies on the next step (no
    //     re-anchor); a queued sequence swap / clear is picked up at the next
    //     loop boundary. `guard` is a runaway backstop only.
    const horizon = now + this.seqLook.horizon();
    let guard = 0;
    while (this.seqStopAt === 0 && this.seqScheduledUpTo < horizon && guard++ < 512) {
      // At a loop boundary (step 0): adopt a queued sequence change and record
      // the boundary so the audible anchor flips to this loop when it sounds.
      if (this.seqScheduleStep === 0 && this.queuedSeqIdx !== null && this.queuedSeqIdx !== this.seqScheduleIdx) {
        this.seqScheduleIdx = this.queuedSeqIdx;
      }
      if (this.seqScheduleStep === 0) this.queuedSeqIdx = null;
      const pattern = this.sequences[this.seqScheduleIdx];
      if (!pattern) break;
      const stepCount = Math.min(SEQ_MAX_STEPS, pattern.bars * pattern.resolution);
      const stepDur = (60 / this.seqTempo()) * (4 / pattern.resolution);
      if (stepCount <= 0 || stepDur <= 0) break;
      if (this.seqScheduleStep >= stepCount) this.seqScheduleStep = 0; // pattern shrank under the cursor
      if (this.seqScheduleStep === 0) {
        this.seqBoundaries.push({ time: this.seqScheduledUpTo, stepDur, seqIdx: this.seqScheduleIdx });
      }
      this.scheduleSeqStepAudio(pattern, this.seqScheduleStep, this.seqScheduledUpTo, stepCount, stepDur);
      this.seqScheduledUpTo += stepDur;
      this.seqScheduleStep++;
      if (this.seqScheduleStep >= stepCount) {
        this.seqScheduleStep = 0;
        if (!pattern.loop) { this.seqStopAt = this.seqScheduledUpTo; break; }
      }
    }

    if (this.playingSeqIdx !== prevPlayingIdx) this.emit();
  }

  stopSeq(): void {
    this.cancelCountIn(); // a STOP during the count-in aborts it
    this.stopSeqScheduler();
    for (const t of this.loopTimers) clearTimeout(t);
    this.loopTimers = [];
    for (const src of this.scheduledSources) {
      try { src.stop(); } catch { /* */ }
      try { src.disconnect(); } catch { /* */ }
    }
    this.scheduledSources = [];
    this.seqTailVoices = [];
    this.seqPlaying = false;
    this.seqStep = -1;
    this.liveRecording = false; // stopping the loop disarms live record
    this.queuedSeqIdx = null;
    this.seqPaused = false;      // clear any frozen phase so a fresh play never reads stale state
    this.seqPausedElapsed = 0;
    this.lastLivePadHit.clear();
    this.seqBoundaries = [];
    this.seqScheduledUpTo = 0;
    this.seqScheduleStep = 0;
    this.seqStopAt = 0;
    this.seqSink?.stop();
    // Stop the synced satellite (drums) together with the chop sequencer.
    this.seqStopHook?.(this.seqRestarting);
    // Clicks are gated on the transport — stop them with it, but keep the METRO
    // flag so the next PLAY clicks again in sync.
    this.stopMetronomeTimer();
    this.emit();
  }

  getSeqCursorStep(): number {
    if (!this.seqPlaying) return -1;
    const pattern = this.sequences[this.playingSeqIdx];
    if (!pattern || this.seqStepDuration === 0) return -1;
    const stepCount = Math.min(SEQ_MAX_STEPS, pattern.bars * pattern.resolution);
    if (stepCount === 0) return -1;
    // While paused, report the frozen phase so the integer step agrees with the
    // visual cursor even as ctx.currentTime keeps advancing.
    if (this.seqPaused) {
      const raw = this.seqStepDuration ? this.seqPausedElapsed / this.seqStepDuration : 0;
      if (pattern.loop) {
        const w = ((raw % stepCount) + stepCount) % stepCount;
        return Math.floor(w);
      }
      return Math.min(Math.floor(raw), stepCount - 1);
    }
    const elapsed = this.nativeElapsed() ?? (this.ctx.currentTime - this.seqCurrentLoopStart);
    if (elapsed < 0) return 0;
    const stepIdx = Math.floor(elapsed / this.seqStepDuration);
    if (pattern.loop) return ((stepIdx % stepCount) + stepCount) % stepCount;
    return Math.min(stepIdx, stepCount - 1);
  }

  // Render-only fractional sibling of getSeqCursorStep — the continuous phase
  // (elapsed / step duration) WITHOUT the floor, so the playhead can interpolate
  // smoothly between cells. Never drives audio, highlight or quantize. Reads
  // stepCount/seqStepDuration live each call so a queued resolution/bars change
  // at the loop boundary is tracked frame-accurately. Allocates nothing.
  getSeqCursorPhase(): number {
    if (!this.seqPlaying) return -1;
    const pattern = this.sequences[this.playingSeqIdx];
    if (!pattern || this.seqStepDuration === 0) return -1;
    const stepCount = Math.min(SEQ_MAX_STEPS, pattern.bars * pattern.resolution);
    if (stepCount === 0) return -1;
    const elapsed = this.seqPaused
      ? this.seqPausedElapsed
      : (this.nativeElapsed() ?? (this.ctx.currentTime - this.seqCurrentLoopStart));
    if (elapsed < 0) return 0;
    const raw = elapsed / this.seqStepDuration;
    // LOOP: float modulo. raw legitimately exceeds stepCount during the last
    // ~300ms of each loop (the next loop is scheduled early but
    // seqCurrentLoopStart only re-anchors at the boundary), so it must wrap
    // exactly as getSeqCursorStep's integer wrap does.
    if (pattern.loop) return ((raw % stepCount) + stepCount) % stepCount;
    // NON-LOOP: clamp to the far edge (right edge of the last cell), NOT
    // stepCount-1, so the cursor sweeps the full last cell. seqPlaying flips
    // false at the loop end, which hides the cursor before it parks here.
    return Math.min(raw, stepCount);
  }

  // ── NATIVE TRANSPORT (Phase 3.2) ───────────────────────────────────────────

  /** The native cursor position when the shadow can give one (playing, not paused, clock calibrated). */
  private nativeElapsed(): number | null {
    if (!this.seqSink || !this.nativeCursorHook) return null;
    const e = this.nativeCursorHook();
    return e !== null && Number.isFinite(e) && e >= 0 ? e : null;
  }

  /** The shadow's 20 Hz position push (engine snapshot → ctx time through NativeClock). Re-anchors the audible loop
   *  start, the step duration, the audible pattern and the paused phase — the fields every cursor getter above,
   *  the live-record landing and the metronome already read — and ends a non-loop run when the engine stopped
   *  itself. Snapshots that predate the last play/pause/resume command (+400 ms) are ignored when they disagree
   *  (the engine has not applied it yet). */
  nativeSeqUpdate(u: { playing: boolean; paused: boolean; loopStartCtx: number; stepDur: number; playingIdx: number; pausedElapsed: number; receivedAt: number }): void {
    if (!this.seqSink || !this.seqPlaying) return;
    const settling = u.receivedAt < this.nativeSeqCmdAt + 400;
    if (u.paused !== this.seqPaused) return;           // transient (a pause/resume in flight)
    if (!u.playing) {
      if (settling || this.seqPaused) return;
      // the engine stopped itself (loop off → ran through the last slot): the TS non-loop end
      this.seqPlaying = false;
      this.seqStep = -1;
      this.stopMetronomeTimer();
      this.emit();
      return;
    }
    let changed = false;
    if (u.playingIdx >= 0 && u.playingIdx < this.sequences.length && u.playingIdx !== this.playingSeqIdx) {
      this.playingSeqIdx = u.playingIdx;
      if (this.queuedSeqIdx === u.playingIdx) this.queuedSeqIdx = null; // the queued switch happened (step 0)
      changed = true;
    }
    if (u.stepDur > 0 && Number.isFinite(u.stepDur)) this.seqStepDuration = u.stepDur;
    if (u.paused) {
      if (Number.isFinite(u.pausedElapsed) && u.pausedElapsed >= 0) this.seqPausedElapsed = u.pausedElapsed;
    } else if (Number.isFinite(u.loopStartCtx)) {
      this.seqCurrentLoopStart = u.loopStartCtx;
    }
    if (changed) this.emit();
  }
  /** The shadow measured the native grid `deltaSec` later (+) / earlier (−) than the ctx-clocked satellites
   *  expect — shift the metronome's next click and the satellites (drums/bass/MIDI clock) by it. Phase-preserving:
   *  nothing restarts, already-booked hits keep their times, the next bookings land on the corrected grid. */
  nudgeSatellites(deltaSec: number): void {
    if (!Number.isFinite(deltaSec) || deltaSec === 0) return;
    this.nextBeatTime += deltaSec;
    this.seqNudgeHook?.(deltaSec);
  }
  /** The stored pattern `idx` as the engine holds it (the live object after a sync of the edited one — read only). */
  peekSequence(idx: number): SeqPattern | null { this.syncCurrentToArray(); return this.sequences[idx] ?? null; }
  getPlayingSeqIdx(): number { return this.playingSeqIdx; }
  getQueuedSeqIdx(): number | null { return this.queuedSeqIdx; }
  isSeqPlaying(): boolean { return this.seqPlaying; }
  isSeqPaused(): boolean { return this.seqPaused; }

  // ── Master FX ──────────────────────────────────────────────────────────────

  setMasterVolume(v: number): void {
    this.masterState.volume = Math.max(0, Math.min(1, v));
    this.masterGain.gain.setTargetAtTime(this.masterState.volume, this.ctx.currentTime, 0.01);
    this.emit();
  }

  /** Chop-only level (0..1) — independent of drums (Phase 2A). */
  setChopVolume(v: number): void {
    this.chopVolume = Math.max(0, Math.min(1, v));
    this.applyChopGain();
  }
  getChopVolume(): number { return this.chopVolume; }

  /** chopGain carries BOTH the chop level and the NORM multiplier so the two
   *  are independent and never fight. Smoothed to avoid zipper noise. */
  private applyChopGain(): void {
    this.chopGain.gain.setTargetAtTime(this.chopVolume * this.normalizeGain, this.ctx.currentTime, 0.01);
    // Route buses carry pad SOURCES — the main track's NORM gain (its peak) is
    // not theirs; each source has its own NORM, applied per voice (normGainFor).
    for (const g of this.routeBuses.values()) g.gain.setTargetAtTime(this.chopVolume, this.ctx.currentTime, 0.01);
  }

  /** Peak-scan the loaded buffer (all channels) and return the −1 dBFS
   *  normalize multiplier (0.891 / peak). Returns 1 when nothing is loaded or
   *  the buffer is silent. Reads getChannelData directly — no copy. */
  private computeNormalizeGain(): number {
    if (!this.buffer) return 1;
    let peak = 0;
    for (let ch = 0; ch < this.buffer.numberOfChannels; ch++) {
      const data = this.buffer.getChannelData(ch);
      for (let i = 0; i < data.length; i++) {
        const a = data[i] < 0 ? -data[i] : data[i];
        if (a > peak) peak = a;
      }
    }
    return peak > 0 ? 0.891 / peak : 1;
  }

  /** NORM toggle. ON → scan the loaded buffer's peak and apply 0.891/peak to
   *  chopGain (−1 dBFS, non-destructive). OFF → reset the multiplier to 1.
   *  A peak already ≥ 0.891 yields a gain ≤ 1 (attenuates to normalize). */
  setNormalize(on: boolean): void {
    this.normalizeOn = on && this.buffer !== null;
    this.normalizeGain = this.normalizeOn ? this.computeNormalizeGain() : 1;
    this.applyChopGain();
    this.emit();
  }
  getNormalize(): { on: boolean; gain: number } {
    return { on: this.normalizeOn, gain: this.normalizeGain };
  }
  /** The NORM key of a pad that plays its OWN sample (null for main-track chops). */
  sourceNormKeyFor(padIdx: number): string | null { const pb = this.padBuffers.get(padIdx); return pb ? `src:${pb.videoId}` : null; }
  /** The per-voice NORM multiplier for a pad-source voice (1 = off / main chop). */
  private normGainFor(padIdx: number): number { const k = this.sourceNormKeyFor(padIdx); return k ? (this.sourceNorm.get(k) ?? 1) : 1; }
  /** NORM on a pad's own sample: scan THAT buffer's peak, apply 0.891/peak to
   *  every voice of every pad playing from it (non-destructive; next hits). */
  setSourceNormalize(padIdx: number, on: boolean): void {
    const pb = this.padBuffers.get(padIdx); if (!pb) return;
    const key = `src:${pb.videoId}`;
    if (on) this.sourceNorm.set(key, ChopperEngine.peakNormGain(pb.buffer)); else this.sourceNorm.delete(key);
    this.emit();
  }
  static peakNormGain(buffer: AudioBuffer): number {
    let peak = 0;
    for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
      const data = buffer.getChannelData(ch);
      for (let i = 0; i < data.length; i++) { const a = data[i] < 0 ? -data[i] : data[i]; if (a > peak) peak = a; }
    }
    return peak > 0 ? 0.891 / peak : 1;
  }

  /** Recompute the NORM multiplier for the CURRENT buffer when NORM is engaged
   *  (the previous gain was scanned from the old sample). Called after a new
   *  sample loads. No-op when NORM is off. */
  private refreshNormalize(): void {
    this.normalizeGain = this.normalizeOn ? this.computeNormalizeGain() : 1;
    this.applyChopGain();
  }

  /** Master clipper DRIVE (0..1). 0 = off (master peaks normally). Any value > 0
   *  engages a hard ceiling at -0.1 dBFS; the knob drives input gain INTO that
   *  ceiling (1% ≈ unity → 100% ≈ +15.6 dB), so more of the signal squares off
   *  while the output never exceeds -0.1 dBFS (Phase 3A.2). */
  setMasterClip(amount: number): void {
    this.clipAmount = Math.max(0, Math.min(1, amount));
    if (this.clipAmount <= 0) { this.masterClip.curve = null; this.masterClip.oversample = 'none'; return; } // off
    this.masterClip.oversample = '4x';
    const C = Math.pow(10, -0.1 / 20);   // ceiling -0.1 dBFS ≈ 0.9886
    const drive = 1 + this.clipAmount * 5; // 1%→~1.05× … 100%→6× input gain
    const n = 2048;
    const curve = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const x = (i / (n - 1)) * 2 - 1;                    // -1..1
      curve[i] = Math.max(-C, Math.min(C, x * drive));    // drive into a hard -0.1 dB ceiling
    }
    this.masterClip.curve = curve;
  }
  getMasterClip(): number { return this.clipAmount; }

  /** Point the context at an output device ('' = the system default) and
   *  remember it, so a later device swap can be recovered against the same
   *  preference. Desktop drives this from the Preferences window; the web build
   *  never calls it and just rides the system default. */
  async setOutputDevice(id: string): Promise<void> {
    this.outputDeviceId = id ?? '';
    await this.reopenOutput();
  }

  /** Re-open the output stream against the CURRENT endpoint for the preferred
   *  sink. Per spec, setSinkId aborts when the id is unchanged — and after a
   *  device swap the id usually IS unchanged ('' for "system default", which
   *  now resolves somewhere else), so re-applying it alone would do nothing.
   *  Detaching to the null sink first makes the value genuinely change, which
   *  forces the re-open. */
  private async reopenOutput(): Promise<void> {
    const ctx = this.ctx as AudioContext & { setSinkId?: (id: unknown) => Promise<void> };
    if (typeof ctx.setSinkId !== 'function') return;   // pre-Chrome-110 / Safari
    try {
      await ctx.setSinkId({ type: 'none' });
      await ctx.setSinkId(this.outputDeviceId);
    } catch {
      // Never leave the graph parked on the null sink — that would be the
      // silence we're here to fix. Fall back to the system default.
      try { await ctx.setSinkId(''); } catch { /* no sink available at all */ }
    }
  }

  /** Current master peak level (0..~1+), read off the meter analyser at the END
   *  of the chain (post-clip/limiter) — what's actually going out. With the CLIP
   *  knob up it pins at ≤ -0.1 dBFS by design. Cheap — for a ref-based meter rAF. */
  getPeakLevel(): number {
    this.meterAnalyser.getFloatTimeDomainData(this.meterBuf as Float32Array<ArrayBuffer>);
    let peak = 0;
    for (let i = 0; i < this.meterBuf.length; i++) {
      const a = Math.abs(this.meterBuf[i]);
      if (a > peak) peak = a;
    }
    return peak;
  }
  setMasterPitch(semitones: number): void {
    this.masterState.pitch = Math.max(-24, Math.min(24, semitones));
    this.emit();
  }

  adjustMasterPitch(delta: number): void {
    this.masterState.pitch = Math.max(-24, Math.min(24, this.masterState.pitch + delta));
    this.emit();
  }
  setFilterFreq(hz: number): void { this.masterState.filterFreq = hz; this.filter.setFreq(hz); this.emit(); }
  setFilterEnabled(b: boolean): void { this.masterState.filterEnabled = b; this.filter.setBypassed(!b); this.emit(); }
  setEQ(band: 'low' | 'mid' | 'high', gainDB: number): void {
    if (band === 'low')  { this.masterState.eqLow  = gainDB; this.eq.setLow(gainDB); }
    if (band === 'mid')  { this.masterState.eqMid  = gainDB; this.eq.setMid(gainDB); }
    if (band === 'high') { this.masterState.eqHigh = gainDB; this.eq.setHigh(gainDB); }
    this.emit();
  }
  setCompStyle(style: CompressorStyle): void { this.masterState.compStyle = style; this.applyCompPreset(style); this.emit(); }
  setCompMix(mix: number): void {
    this.masterState.compMix = Math.max(0, Math.min(1, mix));
    this.compDryGain.gain.setTargetAtTime(1 - this.masterState.compMix, this.ctx.currentTime, 0.01);
    this.compWetGain.gain.setTargetAtTime(this.masterState.compMix, this.ctx.currentTime, 0.01);
    this.syncCompDryRouting();
    this.emit();
  }
  /** Route the dry leg through the latency-matching delay only while the two
   *  legs are actually being blended. */
  private syncCompDryRouting(): void {
    const m = this.masterState.compMix;
    const want = m > 0.001 && m < 0.999;
    if (want === this.compDryDelayed) return;
    this.compDryDelayed = want;
    try { this.compMixIn.disconnect(this.compDryGain); } catch { /* */ }
    try { this.compMixIn.disconnect(this.compDryDelay); } catch { /* */ }
    try { this.compDryDelay.disconnect(); } catch { /* */ }
    if (want) {
      this.compMixIn.connect(this.compDryDelay);
      this.compDryDelay.connect(this.compDryGain);
    } else {
      this.compMixIn.connect(this.compDryGain);
    }
  }

  private applyCompPreset(style: CompressorStyle): void {
    const p = COMP_PRESETS[style];
    this.compressor.setDrive(p.drive);
    this.compressor.setRatio(p.ratio);
    this.compressor.setAttack(p.attack);
    this.compressor.setRelease(p.release);
    this.compressor.setMakeup(p.makeup);
    const targetMix = style === 'off' ? 0 : p.mix;
    if (style === 'off' || this.masterState.compMix === 0) this.masterState.compMix = targetMix;
    this.compDryGain.gain.setTargetAtTime(1 - this.masterState.compMix, this.ctx.currentTime, 0.01);
    this.compWetGain.gain.setTargetAtTime(this.masterState.compMix, this.ctx.currentTime, 0.01);
    this.syncCompDryRouting();
  }
  setDelayTime(s: number): void { this.masterState.delayTime = s; this.delay.setTimeL(s); this.delay.setTimeR(s * 1.5); this.emit(); }
  setDelayFeedback(v: number): void { this.masterState.delayFeedback = v; this.delay.setFeedback(v); this.emit(); }
  setDelayMix(v: number): void {
    this.masterState.delayMix = v; this.delay.setMix(v); this.delay.setBypassed(v <= 0.001); this.emit();
  }
  setReverbMix(v: number): void {
    this.masterState.reverbMix = v; this.reverb.setMix(v); this.reverb.setBypassed(v <= 0.001); this.emit();
  }
  setReverbDecay(s: number): void { this.masterState.reverbDecay = s; this.reverb.setDecay(s); this.emit(); }
  setAttack(s: number): void { this.masterState.attack = Math.max(0, Math.min(0.5, s)); this.emit(); }
  setRelease(s: number): void { this.masterState.release = Math.max(0, Math.min(0.5, s)); this.emit(); }

  // ── Extra FX (ported from looper) ──────────────────────────────────────────
  // Each setter routes to the underlying FX node and emits, so the UI knobs
  // get live state back through getState(). Bypass toggles use each FX's own
  // dry/wet routing so they're click-free.
  // Behaviour split between builds: the web UI removed mix knobs and uses
  // toggle=100% wet semantics; desktop keeps the mix knobs and toggle is
  // just bypass on/off (the FX's internal mix value is whatever the user
  // last set it to). `__isWeb` resolved once below.
  setClipperAmount(v: number)   : void { this.clipper.setAmount(v);    this.emit(); }
  setClipperDrive(v: number)    : void { this.clipper.setDrive(v);     this.emit(); }
  setClipperMix(v: number)      : void { this.clipper.setMix(v);       this.emit(); }
  toggleClipper()               : void { if (__isWeb) this.clipper.setMix(1); this.clipper.setBypassed(!this.clipper.bypassed); this.syncExtraFxWiring(); this.emit(); }

  setWaveshaperDrive(v: number) : void { this.waveshaper.setDrive(v);  this.emit(); }
  setWaveshaperMix(v: number)   : void { this.waveshaper.setMix(v);    this.emit(); }
  toggleWaveshaper()            : void { if (__isWeb) this.waveshaper.setMix(1); this.waveshaper.setBypassed(!this.waveshaper.bypassed); this.syncExtraFxWiring(); this.emit(); }

  setSaturatorDrive(v: number)  : void { this.saturator.setDrive(v);   this.emit(); }
  setSaturatorMix(v: number)    : void { this.saturator.setMix(v);     this.emit(); }
  setSaturatorLowFreq(v: number): void { this.saturator.setLowFreq(v); this.emit(); }
  setSaturatorHighFreq(v: number): void { this.saturator.setHighFreq(v); this.emit(); }
  toggleSaturator()             : void { if (__isWeb) this.saturator.setMix(1); this.saturator.setBypassed(!this.saturator.bypassed); this.syncExtraFxWiring(); this.emit(); }

  setWidenerWidth(v: number)    : void { this.widener.setWidth(v);     this.emit(); }
  setWidenerMix(v: number)      : void { this.widener.setMix(v);       this.emit(); }
  toggleWidener()               : void { if (__isWeb) this.widener.setMix(1); this.widener.setBypassed(!this.widener.bypassed); this.syncExtraFxWiring(); this.emit(); }

  setMSEQMidFreq(v: number)     : void { this.mseq.setMidFreq(v);      this.emit(); }
  setMSEQMidGain(v: number)     : void { this.mseq.setMidGain(v);      this.emit(); }
  setMSEQSideFreq(v: number)    : void { this.mseq.setSideFreq(v);     this.emit(); }
  setMSEQSideGain(v: number)    : void { this.mseq.setSideGain(v);     this.emit(); }
  setMSEQMix(v: number)         : void { this.mseq.setMix(v);          this.emit(); }
  toggleMSEQ()                  : void { if (__isWeb) this.mseq.setMix(1); this.mseq.setBypassed(!this.mseq.bypassed); this.syncExtraFxWiring(); this.emit(); }

  setBitCrusherBits(v: number)  : void { this.bitcrusher.setBits(v);   this.emit(); }
  setBitCrusherRate(v: number)  : void { this.bitcrusher.setRate(v);   this.emit(); }
  setBitCrusherMix(v: number)   : void { this.bitcrusher.setMix(v);    this.emit(); }
  toggleBitCrusher()            : void { if (__isWeb) this.bitcrusher.setMix(1); this.bitcrusher.setBypassed(!this.bitcrusher.bypassed); this.syncExtraFxWiring(); this.emit(); }

  setAutoPanRate(v: number)     : void { this.autopan.setRate(v);      this.emit(); }
  setAutoPanDepth(v: number)    : void { this.autopan.setDepth(v);     this.emit(); }
  setAutoPanMix(v: number)      : void { this.autopan.setMix(v);       this.emit(); }
  toggleAutoPan()               : void { if (__isWeb) this.autopan.setMix(1); this.autopan.setBypassed(!this.autopan.bypassed); this.syncExtraFxWiring(); this.emit(); }

  setTranceGateRate(v: number)    : void { this.trancegate.setRate(v);    this.emit(); }
  setTranceGateDepth(v: number)   : void { this.trancegate.setDepth(v);   this.emit(); }
  setTranceGateAttack(v: number)  : void { this.trancegate.setAttack(v);  this.emit(); }
  setTranceGateRelease(v: number) : void { this.trancegate.setRelease(v); this.emit(); }
  setTranceGateMix(v: number)     : void { this.trancegate.setMix(v);     this.emit(); }
  toggleTranceGate()              : void { if (__isWeb) this.trancegate.setMix(1); this.trancegate.setBypassed(!this.trancegate.bypassed); this.syncExtraFxWiring(); this.emit(); }

  setChorusRate(v: number)      : void { this.chorus.setRate(v);       this.emit(); }
  setChorusDepth(v: number)     : void { this.chorus.setDepth(v);      this.emit(); }
  setChorusMix(v: number)       : void { this.chorus.setMix(v);        this.emit(); }
  toggleChorus()                : void { if (__isWeb) this.chorus.setMix(1); this.chorus.setBypassed(!this.chorus.bypassed); this.syncExtraFxWiring(); this.emit(); }

  setBpm(bpm: number): void { this.bpm = bpm; this.emit(); }

  toggleStretch(): void {
    this.stretchEnabled = !this.stretchEnabled;
    this.stretchCache.clear();
    // Kick the dynamic import as soon as the user arms stretch — by the time
    // they pick a target BPM, the lib is ready. First-trigger fallback in
    // getStretchedBuffer covers the rare race.
    if (this.stretchEnabled) void loadStretchLib();
    // Cache was just cleared — pre-warm all chops in the background so the first
    // hit of each plays stretched (no-op when no target BPM is set yet).
    this._kickWarmAllChops();
    this.emit();
  }

  setTargetBpm(bpm: number): void {
    this.targetBpm = Math.max(20, Math.min(300, bpm));
    this.stretchCache.clear();
    // Ratio changed → the cache is stale; pre-warm all chops at the new ratio in
    // the background (cancels any in-flight sweep at the old ratio).
    this._kickWarmAllChops();
    this.emit();
  }

  setChopOffset(ms: number): void {
    this.chopOffsetMs = Math.max(-200, Math.min(200, ms));
    this.emit();
  }

  /** Cache key for one stretched chop slice. ONE definition so the hot-path
   *  lookup and getStretchedBuffer can never drift apart. The buffer TOKEN is
   *  load-bearing since STEMS: two pads can stretch the same region from
   *  DIFFERENT buffers (stem mixes) — a times-only key would collide and one
   *  pad would play the other's stems (STEM-SPLIT-PLAN.md, the stretchKey trap). */
  private bufTokens = new WeakMap<AudioBuffer, number>();
  private nextBufToken = 1;
  private bufToken(buf: AudioBuffer): number {
    let t = this.bufTokens.get(buf);
    if (!t) { t = this.nextBufToken++; this.bufTokens.set(buf, t); }
    return t;
  }
  private stretchKey(srcBuf: AudioBuffer, startSec: number, endSec: number, ratio: number): string {
    return `b${this.bufToken(srcBuf)}_${startSec.toFixed(4)}_${endSec.toFixed(4)}_${ratio.toFixed(4)}`;
  }

  /** Warm ONE chop slice's stretched buffer asynchronously. Yields off the
   *  trigger call stack first (setTimeout 0) so it never blocks a hit or rAF,
   *  then runs the (cache-checked) stretch. Skips if stretch was disabled or the
   *  ratio moved on while it was queued — stale work. Takes the exact srcBuf the
   *  hot path used (forward OR reverse buffer) so the cached audio matches the
   *  key, which is buffer-agnostic. */
  private async _warmOneChop(srcBuf: AudioBuffer, startSec: number, endSec: number, ratio: number): Promise<void> {
    await new Promise<void>(r => setTimeout(r, 0));
    if (!this.stretchEnabled || this.bpm <= 0 || this.targetBpm <= 0) return;
    if (Math.abs(this.targetBpm / this.bpm - ratio) > 0.001) return;
    // getStretchedBuffer checks the cache internally — a no-op if another warm
    // (or the all-chops sweep) already filled this key.
    this.getStretchedBuffer(srcBuf, startSec, endSec, ratio);
  }

  /** Pre-compute stretched buffers for every current chop at `ratio`, yielding
   *  between chops so the main thread stays free for triggers + rAF. Aborts
   *  early if stretch turns off, the ratio changes, or the chop set is replaced
   *  mid-sweep (stale work). Warms FORWARD slices on this.buffer — the common
   *  case; reverse-mode hits warm lazily via _warmOneChop. */
  private async _warmAllChops(ratio: number): Promise<void> {
    if (!this.buffer || !this.stretchEnabled) return;
    const chops = this.chops; // snapshot — bail if re-chopped to a new array
    for (const chop of chops) {
      if (this.chops !== chops) return;                                   // re-chopped
      if (!this.stretchEnabled || this.bpm <= 0 || this.targetBpm <= 0) return;
      if (Math.abs(this.targetBpm / this.bpm - ratio) > 0.001) return;    // ratio moved on
      await new Promise<void>(r => setTimeout(r, 0));                     // yield between chops
      if (!this.buffer || this.chops !== chops) return;
      this.getStretchedBuffer(this.buffer, chop.start, chop.end, ratio);
    }
  }

  /** Arm a background pre-warm of all chops at the current ratio. No-op unless
   *  stretch is on with a meaningful ratio. Waits for the SoundTouch lib to load
   *  first so the sweep isn't a dry no-op, then runs _warmAllChops. */
  private _kickWarmAllChops(): void {
    if (!this.stretchEnabled || this.bpm <= 0 || this.targetBpm <= 0) return;
    const ratio = this.targetBpm / this.bpm;
    if (Math.abs(ratio - 1) <= 0.005) return;
    void loadStretchLib().then(() => { void this._warmAllChops(ratio); });
  }

  /** Offline SoundTouch time-stretch — returns a cached AudioBuffer at target tempo. */
  private getStretchedBuffer(srcBuf: AudioBuffer, startSec: number, endSec: number, ratio: number): AudioBuffer {
    // Lib not loaded yet (first trigger right after toggleStretch) — play
    // unstretched once; subsequent triggers will hit the loaded path.
    if (!_stretchLib) { void loadStretchLib(); return srcBuf; }

    const cacheKey = this.stretchKey(srcBuf, startSec, endSec, ratio);
    const hit = this.stretchCache.get(cacheKey);
    if (hit) return hit;

    const sr = srcBuf.sampleRate;
    const startSample = Math.round(startSec * sr);
    const numSamples = Math.round((endSec - startSec) * sr);
    if (numSamples <= 0) return srcBuf;

    // Slice the chop into a fresh stereo buffer for WebAudioBufferSource
    const sliceBuf = this.ctx.createBuffer(2, numSamples, sr);
    const leftSrc = srcBuf.getChannelData(0);
    sliceBuf.copyToChannel(leftSrc.slice(startSample, startSample + numSamples), 0);
    const rightSrc = srcBuf.numberOfChannels > 1 ? srcBuf.getChannelData(1) : leftSrc;
    sliceBuf.copyToChannel(rightSrc.slice(startSample, startSample + numSamples), 1);

    const source = new _stretchLib.WebAudioBufferSource(sliceBuf);
    const st = new _stretchLib.SoundTouch();
    st.tempo = ratio; // > 1 = faster playback, < 1 = slower
    const filter = new _stretchLib.SimpleFilter(source, st);

    const CHUNK = 4096;
    const interleaved = new Float32Array(CHUNK * 2);
    const leftOut: number[] = [];
    const rightOut: number[] = [];
    const maxFrames = numSamples * 4; // safety: never more than 4× slower

    while (leftOut.length < maxFrames) {
      const n = filter.extract(interleaved, CHUNK);
      if (n === 0) break;
      for (let i = 0; i < n; i++) {
        leftOut.push(interleaved[i * 2]);
        rightOut.push(interleaved[i * 2 + 1]);
      }
    }

    if (leftOut.length === 0) return srcBuf;
    const outLen = leftOut.length;
    const outBuf = this.ctx.createBuffer(2, outLen, sr);
    outBuf.copyToChannel(new Float32Array(leftOut), 0);
    outBuf.copyToChannel(new Float32Array(rightOut), 1);

    this.stretchCache.set(cacheKey, outBuf);
    return outBuf;
  }

  // ── Export ─────────────────────────────────────────────────────────────────

  /** Export the loaded track as-is — no chopping, no sequencing, no master
   *  FX. Just the raw audio buffer that's in memory. Useful when the user
   *  wants to keep a clean WAV of whatever they loaded into Terminator. */
  exportOriginal(bitDepth: WAVBitDepth = 24): { name: string; data: ArrayBuffer } {
    if (!this.buffer) throw new Error('No track loaded');
    const safeTitle = (this.trackTitle || 'original')
      .replace(/[/\\:*?"<>|\0]/g, '-').slice(0, 80);
    return { name: safeTitle, data: encodeWAV(this.buffer, bitDepth) };
  }

  /** Render a single seq pattern as one loop. */
  async exportSeq(bitDepth: WAVBitDepth = 24): Promise<{ name: string; data: ArrayBuffer }> {
    if (!this.hasSequenceableAudio()) throw new Error('No track loaded');
    this.syncCurrentToArray();
    const pattern = this.sequences[this.currentSeqIdx];
    if (!pattern) throw new Error('No active sequence');
    const events = this.patternToEvents(pattern, 0);
    if (events.length === 0) throw new Error('Pattern is empty');
    const sr = this.buffer?.sampleRate ?? this.ctx.sampleRate;
    const patternDur = this.patternDuration(pattern);
    const data = await this.renderEventsToWav(events, patternDur + 0.5, sr, bitDepth);
    return { name: this.exportNameSeq(this.currentSeqIdx + 1), data };
  }

  /** Render each sequence as its own WAV, one entry per non-empty pattern.
   *  Useful when the user wants per-sequence stems instead of the
   *  concatenated master bounce. */
  async exportSequences(bitDepth: WAVBitDepth = 24): Promise<Array<{ name: string; data: ArrayBuffer }>> {
    if (!this.hasSequenceableAudio()) throw new Error('No track loaded');
    this.syncCurrentToArray();
    if (this.sequences.length === 0) throw new Error('No sequences');
    const sr = this.buffer?.sampleRate ?? this.ctx.sampleRate;
    const out: Array<{ name: string; data: ArrayBuffer }> = [];
    for (let i = 0; i < this.sequences.length; i++) {
      const pattern = this.sequences[i];
      const events = this.patternToEvents(pattern, 0);
      if (events.length === 0) continue;            // skip empty sequences
      const dur = this.patternDuration(pattern);
      const data = await this.renderEventsToWav(events, dur + 0.5, sr, bitDepth);
      out.push({ name: this.exportNameSeq(i + 1), data });
    }
    if (out.length === 0) throw new Error('All sequences are empty');
    return out;
  }

  /** Render every sequence concatenated in order as one big WAV. */
  async exportMaster(bitDepth: WAVBitDepth = 24): Promise<{ name: string; data: ArrayBuffer }> {
    if (!this.hasSequenceableAudio()) throw new Error('No track loaded');
    this.syncCurrentToArray();
    if (this.sequences.length === 0) throw new Error('No sequences');
    const sr = this.buffer?.sampleRate ?? this.ctx.sampleRate;
    const events: PatternEvent[] = [];
    let cursor = 0;
    for (const pattern of this.sequences) {
      const dur = this.patternDuration(pattern);
      if (dur <= 0) continue;
      events.push(...this.patternToEvents(pattern, cursor));
      cursor += dur;
    }
    if (events.length === 0) throw new Error('All sequences are empty');
    return {
      name: this.exportNameMaster(),
      data: await this.renderEventsToWav(events, cursor + 0.5, sr, bitDepth),
    };
  }

  private patternDuration(p: SeqPattern): number {
    const stepCount = Math.min(SEQ_MAX_STEPS, p.bars * p.resolution);
    const stepDur = (60 / this.seqTempo()) * (4 / p.resolution);
    return stepCount * stepDur;
  }

  private patternToEvents(p: SeqPattern, offsetSec: number): PatternEvent[] {
    const out: PatternEvent[] = [];
    const stepCount = Math.min(SEQ_MAX_STEPS, p.bars * p.resolution);
    const stepDur = (60 / this.seqTempo()) * (4 / p.resolution);
    const active: number[] = [];
    for (let s = 0; s < stepCount; s++) {
      if (p.grid[s] && p.grid[s].length > 0) active.push(s);
    }
    for (let i = 0; i < active.length; i++) {
      const step = active[i];
      const row = p.grid[step];
      const startAt = offsetSec + step * stepDur + this.seqSwingOffsetSec(step, p.resolution);
      const revRow = p.revGrid?.[step];
      const velRow = p.velGrid?.[step];
      for (let r = 0; r < row.length; r++) {
        void revRow;
        // A note stops at the next step where its MUTE GROUP fires again (or
        // the pattern end) — the same rule the live sequencer plays.
        const group = this.seqTailGroup(row[r]);
        let endStep = stepCount;
        for (let j = i + 1; j < active.length; j++) {
          const s2 = active[j];
          if (p.grid[s2].some(q => this.seqTailGroup(q) === group)) { endStep = s2; break; }
        }
        const maxDur = (endStep - step) * stepDur;
        out.push({ padIdx: row[r], time: startAt, maxDur, reverse: this.reversedFor(row[r]), velocity: clampVel(velRow?.[r] ?? 1) }); // REV = the pad's setting at playback
      }
    }
    return out;
  }

  /** ONE offline chop voice, shared by every export path so they all resolve
   *  a pad exactly alike: pad → chop, varispeed pitch, per-cell REVERSE from
   *  the mirrored buffer, cut at the next step, 5 ms guards. Returns false if
   *  the pad has nothing to play. */
  private scheduleOfflineChop(off: OfflineAudioContext, dest: AudioNode, e: PatternEvent): boolean {
    const pad = this.pads[e.padIdx];
    if (!pad) return false;
    // The pad's SOURCE (own audio or main-track chop) — exports render pad
    // sources now, same as the sequencer.
    const psrc = this.resolvePadSource(e.padIdx);
    if (!psrc) return false;
    const chop = { start: psrc.start, end: psrc.end };
    // duration is BUFFER seconds; scale the real-time step budget by the
    // varispeed rate so pitched chops aren't cut short (see scheduleSeqStepAudio).
    const rate = Math.pow(2, (pad.pitch + this.pitchFor(e.padIdx)) / 12);
    const bufDur = Math.min(chop.end - chop.start, e.maxDur * rate);
    const realDur = bufDur / rate;
    if (bufDur <= 0) return false;
    let srcBuf: AudioBuffer = psrc.buffer;
    let startSec = chop.start;
    if (e.reverse) {
      srcBuf = this.reversedOf(psrc.buffer);
      startSec = psrc.buffer.duration - chop.end;
    }
    const src = off.createBufferSource();
    src.buffer = srcBuf;
    src.detune.value = (pad.pitch + this.pitchFor(e.padIdx)) * 100;
    const g = off.createGain();
    const FADE = 0.005;
    // ATTACK from the waveform bar — same envelope as live pads + the sequencer
    // (was a fixed 5 ms here: exports ignored the knob).
    const atk = Math.min(Math.max(this.attackFor(e.padIdx), 0.0005), Math.max(0.0005, realDur - FADE));
    const vel = clampVel(e.velocity ?? 1);
    g.gain.setValueAtTime(0, e.time);
    g.gain.linearRampToValueAtTime(vel, e.time + atk);
    if (realDur > FADE + atk) {
      g.gain.setValueAtTime(vel, e.time + realDur - FADE);
      g.gain.linearRampToValueAtTime(0.0001, e.time + realDur);
    }
    src.connect(g); g.connect(dest);
    src.start(e.time, startSec, bufDur);
    return true;
  }

  private async renderEventsToWav(events: PatternEvent[], totalSec: number, sr: number, bitDepth: WAVBitDepth): Promise<ArrayBuffer> {
    // Desktop (mixer wired): the bounce continues through the mixer's SAMPLE
    // strip (insert FX + fader + pan) and the MASTER strip (FX + fader +
    // limiter) — the same path the stems take — so EXPORT SEQ / MASTER carry
    // every effect you hear. Mobile keeps the internal chain only.
    const mixer = this.mixerEngine;
    if (mixer) {
      // One dry render per mixer route the events touch (SAMPLE through the
      // internal chain, source strips dry), each through its own strip, then
      // the master bus — pad sources on their own strips bounce like they play.
      const routes = this.routesForEvents(events);
      let tail = mixer.stripTailSec('master');
      for (const r of routes) tail = Math.max(tail, mixer.channels.has(r) ? mixer.stripTailSec(r) : 0);
      const posts: AudioBuffer[] = [];
      for (const r of routes) {
        const dry = await this.renderArrangementChopSource({ chopEvents: events, totalSec: totalSec + tail, sampleRate: sr, route: r });
        posts.push(mixer.channels.has(r) ? await mixer.renderChannelPostOffline(dry, r, totalSec + tail) : dry);
      }
      let rendered: AudioBuffer | null = await mixer.renderMasterBusOffline(posts, totalSec + tail, sr);
      const wav = encodeWAV(rendered, bitDepth);
      rendered = null;
      return wav;
    }
    const tail = 0;
    const len = Math.ceil((totalSec + tail) * sr);
    const off = new OfflineAudioContext(2, len, sr);
    const { padBus } = this.buildOfflineChain(off, { withMasterClip: false });

    // Voices → chopGain (chop level × NORM, exactly like the live chopGain) →
    // padBus. This path used to feed padBus directly, so with NORM engaged the
    // bounce came out up to ~10 dB under what you heard.
    const chopGain = off.createGain();
    chopGain.gain.value = this.chopVolume * this.normalizeGain;
    chopGain.connect(padBus);
    for (const e of events) this.scheduleOfflineChop(off, chopGain, e);

    let rendered: AudioBuffer | null = await off.startRendering();
    void (off as { close?: () => Promise<void> }).close?.()?.catch(() => {}); // free the offline ctx where supported
    const wav = encodeWAV(rendered, bitDepth);
    rendered = null; // drop the full-length render buffer ref promptly (iOS export heap pressure)
    return wav;
  }

  /**
   * Phase 4A — render a Beat Finisher arrangement (chops and/or drums) through
   * the master FX chain to a WAV. Chops feed a chopGain (chop master level) into
   * the padBus; drum hits feed a drumGain (drum master level) into the SAME
   * padBus — matching the live graph where the drum bus is the padBus, so both
   * get the master filter/EQ/comp/delay/reverb. Pass only chopEvents for a chop
   * stem, only drumHits for a drum stem, or both for the master mix.
   */
  async renderArrangementMix(opts: {
    chopEvents?: PatternEvent[];
    drumHits?: Array<{ buffer: AudioBuffer; time: number; gain: number; pan?: number; chokeAt?: number; groupCutAt?: number }>;
    totalSec: number;
    chopGain?: number;
    drumGain?: number;
    bitDepth?: WAVBitDepth;
    /** A pre-rendered BASS pass (BassEngine.renderBassOffline at this render's
     *  sample rate) — summed into the pad bus from t=0 like the live mobile
     *  graph, so it wears the same master chain as chops + drums. */
    bassBuffer?: AudioBuffer;
    bassGain?: number;
  }): Promise<ArrayBuffer> {
    const bitDepth = opts.bitDepth ?? 16;
    const sr = this.buffer?.sampleRate ?? 44100;
    const len = Math.max(1, Math.ceil(opts.totalSec * sr));
    const off = new OfflineAudioContext(2, len, sr);
    const { padBus } = this.buildOfflineChain(off);

    // Chops → chopGain → padBus (chop master level), cut at the next chop so the
    // sequence plays like the sequencer (mirrors patternToEvents / live preview).
    const chopEvents = opts.chopEvents ?? [];
    if (chopEvents.length && this.buffer) {
      const chopGain = off.createGain();
      // Caller passes the chop LEVEL; NORM is applied here like the live chopGain.
      chopGain.gain.value = (opts.chopGain ?? 1) * this.normalizeGain;
      chopGain.connect(padBus);
      for (const e of chopEvents) this.scheduleOfflineChop(off, chopGain, e);
    }

    // Drum hits → drumGain → padBus (drum master level). Mirror the LIVE engine
    // (DrumEngine.playHit) EXACTLY so mobile exports match playback: the punch-
    // preserving attack (applyDrumAttack — no fade for the silent-head MP3s, else
    // a 3 ms click guard) plus the 4 ms retrigger choke (DRUM_CHOKE_S). Hits
    // are grouped by buffer (= per drum track; each track resolves to one sample)
    // so a voice only chokes the PREVIOUS voice of the SAME sample, like the live
    // per-track activeGain choke. Hit times already carry the baked-in swing.
    const drumHits = opts.drumHits ?? [];
    if (drumHits.length) {
      const drumGain = off.createGain();
      drumGain.gain.value = opts.drumGain ?? 1;
      drumGain.connect(padBus);
      type H = { time: number; gain: number; pan?: number; chokeAt?: number; groupCutAt?: number };
      const byBuffer = new Map<AudioBuffer, H[]>();
      for (const h of drumHits) {
        if (!h.buffer || h.gain <= 0) continue;
        const list = byBuffer.get(h.buffer) ?? [];
        list.push({ time: h.time, gain: h.gain, pan: h.pan, chokeAt: h.chokeAt, groupCutAt: h.groupCutAt });
        byBuffer.set(h.buffer, list);
      }
      for (const [buffer, group] of byBuffer) {
        const headAbs = drumHeadLevel(buffer);
        const attackS = headAbs < 0.02 ? 0 : 0.003;
        const voice = (h: H) => {
          const src = off.createBufferSource();
          src.buffer = buffer;
          const g = off.createGain();
          applyDrumAttack(g.gain, h.time, h.gain, headAbs);
          src.connect(g);
          if (h.pan && typeof off.createStereoPanner === 'function') { const p = off.createStereoPanner(); p.pan.value = Math.max(-1, Math.min(1, h.pan)); g.connect(p); p.connect(drumGain); }
          else g.connect(drumGain);
          src.start(h.time); // start() MUST precede stop() — an unstarted source throws on stop()
          return { src, g };
        };
        // full hits chain-choke in time order; note-repeat sub-hits self-choke (as live)
        const full = group.filter(h => h.chokeAt === undefined).sort((a, b) => a.time - b.time);
        for (let i = 0; i < full.length; i++) {
          const h = full[i];
          const { src, g } = voice(h);
          const next = full[i + 1];
          // The lane's own retrigger OR a MUTE-GROUP mate — whichever is first
          // (groupCutAt comes from muteGroups.annotateGroupCuts, as live).
          const cut = Math.min(next ? next.time : Infinity, h.groupCutAt ?? Infinity);
          if (cut < h.time + buffer.duration) {
            g.gain.setValueAtTime(Math.max(0.0001, h.gain), cut);
            g.gain.linearRampToValueAtTime(0, cut + DRUM_CHOKE_S);
            src.stop(cut + DRUM_CHOKE_S + 0.002);
          }
        }
        for (const h of group) {
          if (h.chokeAt === undefined) continue;
          const { src, g } = voice(h);
          const ch = Math.max(h.time + attackS + DRUM_CHOKE_S, h.chokeAt);
          g.gain.setValueAtTime(Math.max(0.0001, h.gain), Math.max(h.time + attackS, ch - DRUM_CHOKE_S));
          g.gain.linearRampToValueAtTime(0, ch);
          src.stop(ch + 0.01);
        }
      }
    }

    // Bass → bassGain → padBus.
    if (opts.bassBuffer) {
      const bg = off.createGain();
      bg.gain.value = opts.bassGain ?? 1;
      bg.connect(padBus);
      const src = off.createBufferSource();
      src.buffer = opts.bassBuffer;
      src.connect(bg);
      src.start(0);
    }

    const rendered = await off.startRendering();
    return encodeWAV(rendered, bitDepth);
  }

  /**
   * Unified DAW export — render ONLY the arrangement's chop events through the
   * chop bus exactly as live playback feeds the desktop mixer's Sample channel:
   * voices → chopGain (chop level × NORM) → padBus → internal filter/EQ/comp/
   * delay/reverb → masterGain → masterClip → limiter. Returns the rendered
   * AudioBuffer (the Sample strip's input signal over the whole song), NOT a
   * WAV — the mixer strips (renderArrangementDAW) render downstream of this.
   */
  async renderArrangementChopSource(opts: {
    chopEvents: PatternEvent[];
    totalSec: number;
    sampleRate?: number;
    /** Mixer route to render: 'sample' (default — the main SAMPLE strip's dry
     *  source, through the internal chain like live) or 'sampleN' (a source
     *  strip: its pads' voices, dry, exactly what its strip hears live). Only
     *  the events whose pad routes there are rendered. */
    route?: string;
  }): Promise<AudioBuffer> {
    const sr = opts.sampleRate ?? this.buffer?.sampleRate ?? this.ctx.sampleRate;
    const len = Math.max(1, Math.ceil(opts.totalSec * sr));
    const off = new OfflineAudioContext(2, len, sr);
    const route = opts.route ?? 'sample';
    const events = opts.chopEvents.filter(e => this.padRoute(e.padIdx) === route);
    const chopGain = off.createGain();
    chopGain.gain.value = this.chopVolume * this.normalizeGain; // live chopGain incl. NORM
    if (route === 'sample') {
      const { padBus } = this.buildOfflineChain(off, { withMasterClip: true });
      chopGain.connect(padBus);
    } else {
      chopGain.connect(off.destination); // route buses are dry (the strip is the chain)
    }
    for (const e of events) this.scheduleOfflineChop(off, chopGain, e);
    return off.startRendering();
  }
  /** Routes that carry at least one of these events (in strip order). */
  routesForEvents(events: PatternEvent[]): string[] {
    const set = new Set<string>();
    for (const e of events) set.add(this.padRoute(e.padIdx));
    return this.routeNames().filter(r => set.has(r));
  }

  async exportChops(
    bitDepth: WAVBitDepth = 24,
    onProgress?: (pct: number) => void,
  ): Promise<Array<{ name: string; data: ArrayBuffer; padIndex: number }>> {
    // Every pad that plays something — main-track chops AND pad sources (own
    // audio, trimmed) — each rendered from its own buffer.
    const assigned = this.pads.filter(p => this.resolvePadSource(p.index) !== null);
    if (assigned.length === 0 && !this.buffer) throw new Error('No track loaded');
    const total = assigned.length || 1;
    let done = 0;
    const out: Array<{ name: string; data: ArrayBuffer; padIndex: number }> = [];
    for (const pad of assigned) {
      const psrc = this.resolvePadSource(pad.index)!;
      const chop = { id: pad.chopId ?? -1, start: psrc.start, end: psrc.end };
      // renderChopThroughMaster adds the master pitch itself; hand it the pad's
      // source pitch relative to that so a pad source exports at ITS pitch.
      const data = await this.renderChopThroughMaster(chop, pad.pitch + this.pitchFor(pad.index) - this.masterState.pitch - (this.masterState.fine ?? 0) / 100, bitDepth, psrc.buffer);
      done++;
      onProgress?.(Math.round((done / total) * 100));
      out.push({ name: this.exportNameChop(pad.index + 1), data, padIndex: pad.index });
    }
    return out;
  }

  private buildOfflineChain(off: OfflineAudioContext, opts?: { withMasterClip?: boolean }) {
    const oFilter = new Filter(off);
    const oEq = new EQ3(off);
    const oComp = new Compressor(off);
    const oDelay = new Delay(off);
    const oReverb = new Reverb(off);

    oFilter.setType('lowpass');
    oFilter.setFreq(this.masterState.filterFreq);
    oFilter.setBypassed(!this.masterState.filterEnabled);
    oFilter.setMix(1);
    oEq.setLow(this.masterState.eqLow);
    oEq.setMid(this.masterState.eqMid);
    oEq.setHigh(this.masterState.eqHigh);
    const cp = COMP_PRESETS[this.masterState.compStyle];
    oComp.setDrive(cp.drive); oComp.setRatio(cp.ratio);
    oComp.setAttack(cp.attack); oComp.setRelease(cp.release); oComp.setMakeup(cp.makeup);
    oDelay.setTimeL(this.masterState.delayTime);
    oDelay.setTimeR(this.masterState.delayTime * 1.5);
    oDelay.setFeedback(this.masterState.delayFeedback);
    oDelay.setMix(this.masterState.delayMix);
    oDelay.setBypassed(this.masterState.delayMix <= 0.001);
    oReverb.setMix(this.masterState.reverbMix);
    oReverb.setDecay(this.masterState.reverbDecay);
    oReverb.setBypassed(this.masterState.reverbMix <= 0.001);

    const oCompMixIn = off.createGain();
    const oCompMixOut = off.createGain();
    const oCompDry = off.createGain();
    const oCompWet = off.createGain();
    oCompDry.gain.value = 1 - this.masterState.compMix;
    oCompWet.gain.value = this.masterState.compMix;
    // Same latency-matched dry leg as live (see compDryDelay).
    const m = this.masterState.compMix;
    if (m > 0.001 && m < 0.999 && compressorLatencyKnown(off.sampleRate) > 0) {
      const d = off.createDelay(0.05);
      d.delayTime.value = compressorLatencyKnown(off.sampleRate);
      oCompMixIn.connect(d); d.connect(oCompDry);
    } else {
      oCompMixIn.connect(oCompDry);
    }
    oCompMixIn.connect(oComp.input);
    oCompDry.connect(oCompMixOut);
    oComp.output.connect(oCompWet);
    oCompWet.connect(oCompMixOut);

    const oMasterGain = off.createGain();
    oMasterGain.gain.value = this.masterState.volume;
    const oLimiter = off.createDynamicsCompressor();
    oLimiter.threshold.value = -1; oLimiter.knee.value = 0;
    oLimiter.ratio.value = 20; oLimiter.attack.value = 0.001; oLimiter.release.value = 0.05;

    const padBus = off.createGain();
    padBus.connect(oFilter.input);
    oFilter.output.connect(oEq.input);
    oEq.output.connect(oCompMixIn);
    oCompMixOut.connect(oDelay.input);
    oDelay.output.connect(oReverb.input);
    oReverb.output.connect(oMasterGain);
    // Live-parity option: clone the master soft-clip between master gain and the
    // limiter (exactly where the live masterClip sits). Off by default so the
    // legacy export paths stay byte-identical.
    let preLimiter: AudioNode = oMasterGain;
    if (opts?.withMasterClip && this.masterClip.curve) {
      const oClip = off.createWaveShaper();
      oClip.curve = this.masterClip.curve;
      oClip.oversample = this.masterClip.oversample;
      oMasterGain.connect(oClip);
      preLimiter = oClip;
    }
    // Desktop (mixer attached): the internal safety limiter is OUT of the live
    // path (attachMixer — the mixer master strip runs the same brickwall), so
    // the offline chain skips it too. Mobile keeps it.
    if (this.mixerEngine) preLimiter.connect(off.destination);
    else { preLimiter.connect(oLimiter); oLimiter.connect(off.destination); }

    return { oFilter, oEq, oComp, oDelay, oReverb, oCompMixIn, oCompMixOut, oMasterGain, oLimiter, padBus };
  }

  private async renderChopThroughMaster(chop: Chop, pitch: number, bitDepth: WAVBitDepth, buffer: AudioBuffer | null = this.buffer): Promise<ArrayBuffer> {
    if (!buffer) throw new Error('No buffer');
    const dur = chop.end - chop.start;
    const sr = buffer.sampleRate;

    // Legacy fallback (no mixer wired): the old internal master chain.
    if (!this.mixerEngine) {
      const tail = Math.max(0.3, this.masterState.reverbMix > 0 ? this.masterState.reverbDecay : 0.3);
      const off = new OfflineAudioContext(2, Math.ceil((dur + tail) * sr), sr);
      const { padBus } = this.buildOfflineChain(off);
      const src = off.createBufferSource();
      src.buffer = buffer;
      src.detune.value = (pitch + this.masterState.pitch + (this.masterState.fine ?? 0) / 100) * 100;
      src.connect(padBus);
      src.start(0, chop.start, dur);
      return encodeWAV(await off.startRendering(), bitDepth);
    }

    // New path: render the PITCHED dry slice, bake the Sample channel's mixer FX
    // + fader, then a safety limiter — replacing the (vestigial) internal FX
    // chain. Pitch and the limiter are preserved exactly as before.
    const sliceLen = Math.max(1, Math.ceil(dur * sr));
    const offDry = new OfflineAudioContext(2, sliceLen, sr);
    const src = offDry.createBufferSource();
    src.buffer = buffer;
    src.detune.value = (pitch + this.masterState.pitch + (this.masterState.fine ?? 0) / 100) * 100;
    src.connect(offDry.destination);
    src.start(0, chop.start, dur);
    const dryBuf = await offDry.startRendering();

    const fxBuf = await this.mixerEngine.renderWithMixerFX(dryBuf, 'sample');
    const limited = await this.applySafetyLimiter(fxBuf);
    return encodeWAV(limited, bitDepth);
  }

  /** Run a rendered buffer through the same −1 dBFS safety limiter the export
   *  chain has always used (kept after the mixer-FX bake). */
  private async applySafetyLimiter(buf: AudioBuffer): Promise<AudioBuffer> {
    // The compressor-limiter's look-ahead would put ~6 ms of dead air at the
    // head of every chop WAV (late on a DAW grid) — render the extra frames
    // and cut them off the front.
    const latFrames = Math.round((await compressorLatencySec(buf.sampleRate)) * buf.sampleRate);
    const off = new OfflineAudioContext(buf.numberOfChannels, buf.length + latFrames, buf.sampleRate);
    const src = off.createBufferSource();
    src.buffer = buf;
    const lim = off.createDynamicsCompressor();
    lim.threshold.value = -1; lim.knee.value = 0;
    lim.ratio.value = 20; lim.attack.value = 0.001; lim.release.value = 0.05;
    src.connect(lim);
    lim.connect(off.destination);
    src.start(0);
    const rendered = await off.startRendering();
    if (latFrames <= 0) return rendered;
    const out = new AudioBuffer({ numberOfChannels: buf.numberOfChannels, length: buf.length, sampleRate: buf.sampleRate });
    for (let c = 0; c < buf.numberOfChannels; c++) out.copyToChannel(rendered.getChannelData(c).subarray(latFrames, latFrames + buf.length), c);
    return out;
  }

  private defaultPlaybackEvents(): TimelineEvent[] {
    const events: TimelineEvent[] = [];
    let t = 0;
    for (const pad of this.pads) {
      if (pad.chopId === null) continue;
      const chop = this.chops.find(c => c.id === pad.chopId);
      if (!chop) continue;
      const dur = chop.end - chop.start;
      events.push({ padIdx: pad.index, time: t, duration: dur });
      t += dur;
    }
    return events;
  }

  private exportNameMaster(): string { return `${this.safeTitle()}_master`; }
  private exportNameSeq(n: number): string { return `${this.safeTitle()}_seq${String(n).padStart(2, '0')}`; }
  private exportNameChop(n: number): string {
    return `${this.safeTitle()}${this.bpm ? `_${Math.round(this.bpm)}BPM` : ''}_pad${String(n).padStart(2, '0')}`;
  }
  private safeTitle(): string {
    return (this.trackTitle || 'untitled').replace(/[^a-z0-9]+/gi, '_').replace(/^_|_$/g, '').slice(0, 40);
  }

  dispose(): void {
    this.stopAllPads();
    this.stopArp();
    if (this.metronomeTimer) this.metronomeTimer.stop();
    for (const t of this.loopTimers) clearTimeout(t);
    this.loopTimers = [];
    if (this.onVisibility && typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', this.onVisibility);
      window.removeEventListener('pageshow', this.onVisibility);
    }
    if (this.deviceChangeTimer) { clearTimeout(this.deviceChangeTimer); this.deviceChangeTimer = null; }
    if (this.onDeviceChange && typeof navigator !== 'undefined') {
      navigator.mediaDevices?.removeEventListener?.('devicechange', this.onDeviceChange);
    }
    this.ctx.close().catch(() => {});
  }
}
