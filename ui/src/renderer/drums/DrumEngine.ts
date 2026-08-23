/**
 * Drum sequencer engine — ported from the Drum Dojo Next.js app, trimmed to
 * the essentials for Phase 1 integration into Terminator:
 *   - 5 fixed tracks (kick / snare / hihat / openhat / perc)
 *   - 16 steps per pattern
 *   - One global BPM (driven by Terminator's chopper engine)
 *   - Lazy per-sample loading: a sample's MP3 isn't fetched until first hit
 *   - Mute + per-track volume + per-track sample swap
 *   - Looping playback that schedules ahead with a ~25 ms look-ahead window
 *
 * What's NOT in this phase: swing, soft clipper, NY compressor, multi-kit
 * switcher, drag-to-paint, MIDI generator. Those land in phase 2+.
 */

import manifest from './samples.json';
import { startClock, LookAhead, type ClockHandle } from '../lib/audioClock';
import { generateBoomBapFromMidi, generateTrap } from './generate';
import { aliasMap, drumAlias } from './drumAliases';
import { drumR2Url, drumSampleUrls, drumIdFromUrl, userDrumUrl } from './drumR2';
import { libFileUrl } from '../chopper/libraryBridge';
import { swingOffsetSec } from '../lib/swing';
/** The playable URL behind a lane's userPath — the Drums folder route, or a
 *  Sample Library node (USER SAMPLES / linked folder) by id. */
const userSampleUrl = (ref: string): string => ref.startsWith('lib:') ? libFileUrl(ref.slice(4)) : userDrumUrl(ref);

// Drum samples live on R2 under opaque ids (drumR2Url) — nothing is bundled and
// no real filename exists anywhere in the client.

/** A drum lane's id. The five defaults below are still the built-in kit slots,
 *  but this is a plain string so a user can add lanes beyond them — a closed
 *  union made a 6th sound impossible to represent anywhere in the chain
 *  (pattern rows, step graphs, mixer channels, exports). */

/** Pin a gain at `held` from time `t` so a ramp scheduled after it starts AT t
 *  — never from the voice's own start.
 *
 *  MEASURED 2026-08-22 (OfflineAudioContext, Chrome): `cancelAndHoldAtTime(t)`
 *  followed by `linearRampToValueAtTime(0, t+4ms)` does NOT hold when no
 *  automation event spans t — the ramp attaches to the PREVIOUS event (the
 *  voice's attack, at its start), so the voice fades linearly over the whole
 *  gap to the next hit (0.93 @ 50 ms, 0.62 @ 200 ms, 0.31 @ 350 ms, 0 at the
 *  hit) and, because the scheduler runs ~100 ms ahead, the gain STEPS down onto
 *  that line the instant the next hit is scheduled — a random-size click on a
 *  loud 808 and "the sample never plays all the way through". The explicit
 *  cancel + setValue form holds at exactly `held` until t (measured 1.000 →
 *  0.500 @ t+2 ms → 0 @ t+4 ms). The export renderers always used the
 *  explicit form, which is why exports never had this. */
function holdGainAt(p: AudioParam, held: number, t: number): void {
  p.cancelScheduledValues(t);
  p.setValueAtTime(Math.max(0.0001, held), t);
}

export type TrackKey = string;

/** One sounding drum voice (see DrumEngine.emitVoice). */
interface LaneVoice {
  src: AudioBufferSourceNode; g: GainNode; pan: StereoPannerNode | null;
  startAt: number;    // ctx time the source starts
  target: number;     // its plateau gain (volume × velocity)
  attackS: number;    // 0 = instant (silent head), else the click-guard ramp length
  chokeAt?: number;   // ctx time its gain is ramped to 0 (set once a later hit cuts it)
  ended: boolean;
}

/** Phase 3.3 — THE NATIVE DRUM SEQUENCER (Terminator 3.0, native/nativeDrumShadow.ts).
 *  When a sink is set this engine books NO Web Audio voices: PLAY/STOP, every hit
 *  (sequenced or hand-played), arranged pattern swaps and the lanes' state go to the
 *  C++ DrumSequencer + Sampler (lane L = pad 64+L, on the chop sequencer's clock) and
 *  the playhead reads the native position. The TS keeps owning the state, the UI,
 *  recording, the graphs and undo — unchanged. */
export interface DrumSink {
  play(anchorCtxTime: number, stepOffset: number): void;
  stop(): void;
  /** One hit (a hand-played lane / the header preview) — `whenCtx` undefined = now. */
  hit(track: TrackKey, volume: number, whenCtx: number | undefined, pan: number): void;
  schedulePattern(pattern: Record<TrackKey, boolean[]>, atCtxTime: number): void;
  clearScheduledPatterns(): void;
  /** Seconds since the audible loop start, at the ear, from the engine's own clock (null = unknown). */
  elapsedSec(): number | null;
  /** The lead a standalone PLAY needs so the engine renders the anchor in time (default 20 ms). */
  leadSec?(): number;
}

/** The five built-in slots — the ones the sample manifest is keyed by. Kept as a
 *  narrow literal union (unlike TrackKey) so everything that indexes the KITS
 *  manifest or the alias tables stays type-checked. */
export const BUILTIN_TRACK_KEYS = ['kick', 'snare', 'hihat', 'openhat', 'perc', 'clapsnap', 'rim'] as const;
export type BuiltinTrackKey = typeof BUILTIN_TRACK_KEYS[number];

export interface DrumTrack {
  key: TrackKey;
  name: string;
  color: string;
  /** Which BUILT-IN kit slot this lane draws its sample list from. Added lanes
   *  have their own key but borrow a slot's samples (a user perc lane browses
   *  the perc kit), so cycling / randomize / preview / aliasing all keep
   *  working unchanged. Absent on the five defaults, where key IS the slot. */
  kitKey?: TrackKey;
  /** True for a lane the user added — drives the row's remove control, and
   *  keeps the defaults undeletable. */
  added?: boolean;
  sampleIndex: number;   // index into kit[track] list
  sampleGenre: Genre;    // which kit THIS track's current sample comes from —
                         // lets you mix e.g. a boombap kick with a trap snare
  /** MY DRUMS: the lane plays the user's OWN file instead of the kit sample —
   *  a relative path inside <Sample Library>/Drums, or `lib:<node id>` for a
   *  file from the Sample Library (USER SAMPLES / a linked folder).
   *  sampleIndex/sampleGenre stay as the fallback an older build (or the web
   *  app) plays. */
  userPath?: string;
  userName?: string;     // the filename, for the row + the browser
  userMissing?: boolean; // the file could not be loaded — the row says so, nothing is swapped in silently
  muted: boolean;
  solo: boolean;
  volume: number;        // 0..1
  /** MUTE GROUP (muteGroups.ts): lanes sharing a group cut each other — the
   *  closed/open hat pair. 0/undefined = off, the default: lanes ring on. */
  muteGroup?: number;
}

export interface DrumState {
  tracks: DrumTrack[];
  pattern: Record<TrackKey, boolean[]>;       // the ACTIVE sequence (mirror of sequences[seqIndex])
  sequences: Array<Record<TrackKey, boolean[]>>; // all stored sequences (Seq 1, Seq 2, …)
  seqIndex: number;        // which sequence is active (0-based)
  bars: number;            // 1..4 (shared across all sequences)
  step: number;            // current playback step (-1 if stopped)
  playing: boolean;
  masterVolume: number;    // 0..1 overall drum level (Phase 2A)
  genre: Genre;            // active sample-kit folder: boombap | trap (Phase 2B.2)
  drumSwing: number;       // 0..1 16T swing (0 = straight, 1 = full triplet feel)
  stepDivision: number;    // steps per bar: 8 (1/8) | 16 (1/16) | 32 (1/32)
  gridOff: boolean;        // true = no grid quantization (freeform live recording)
  /** LEGACY: INPUT Q lives on the chopper engine now (one fader, both
   *  sequencers). Kept as the fallback + the migration source for projects
   *  saved before the move — see inputQuantizeStrength. */
  inputQuantize: number;
  triplet: boolean;        // true = triplet subdivision (1/8T, 1/16T, 1/32T)
  stepRecording: boolean;  // step-input record armed (each pad hit fills the next step)
  liveRecording: boolean;  // REC armed — pad hits stamp the nearest step while playing
  drumRecordStep: number;  // step cursor — next step a pad hit fills (0-indexed)
  ppq: number;             // scheduler micro-timing snap resolution: 960 | 96
  // Per-step bar-graph editor state (length MAX_STEPS, indexed by absolute step).
  // Engine-level (shared across sequences) — matches Drum Dojo's single-pattern model.
  stepVelocity: Record<TrackKey, number[]>; // 0..1 velocity multiplier (default 1)
  stepShift: Record<TrackKey, number[]>;    // ms timing offset -50..50 (default 0)
  stepPan: Record<TrackKey, number[]>;      // stereo pan -1..1 (default 0)
  stepRepeat: Record<TrackKey, number[]>;   // index into REPEAT_RATES (default 0 = off)
}

/** Serialisable drum state for presets — everything that changes how the kit
 *  SOUNDS, minus transport runtime (playing/step) which must never persist. */
export interface DrumPreset {
  /** `name`/`color`/`kitKey`/`added` are only present for user-added lanes —
   *  the five defaults take theirs from TRACK_DEFS, so old presets restore
   *  exactly as before. */
  tracks: Array<{
    key: TrackKey; sampleIndex: number; sampleGenre: Genre; muted: boolean; solo: boolean; volume: number;
    name?: string; color?: string; kitKey?: TrackKey; added?: boolean;
    /** MUTE GROUP — omitted when off, so old presets restore unchanged. */
    muteGroup?: number;
    /** MY DRUMS — the user's own file on this lane (see DrumTrack.userPath). */
    userPath?: string; userName?: string;
  }>;
  sequences: Array<Record<TrackKey, boolean[]>>;
  seqIndex: number;
  bars: number;
  masterVolume: number;
  genre: Genre;
  drumSwing: number;
  stepDivision?: number;   // optional — old presets default to 16 (1/16)
  /** Resolution the step rows below are stored AT. Absent = written before
   *  storage was decoupled from the view, so the rows are at `stepDivision` and
   *  get upscaled to INTERNAL_SPB on load. */
  gridRes?: number;
  _gridOff?: boolean;      // optional — old presets default to false (grid on)
  _inputQuantize?: number; // optional — old presets default to 100 (full snap)
  _triplet?: boolean;      // optional — old presets default to false (straight)
  ppq?: number;            // optional — old presets default to 960
  // Persisted as _stepShift / _stepPan / _stepRepeat (+ velocity) in the preset
  // pattern JSON — see ChopperView's buildPreset/applyPreset. Optional so old
  // presets (which predate the graph editor) load with defaults.
  stepVelocity?: Record<TrackKey, number[]>;
  stepShift?: Record<TrackKey, number[]>;
  stepPan?: Record<TrackKey, number[]>;
  stepRepeat?: Record<TrackKey, number[]>;
}

/** THE FIVE DEFAULT LANES. Deliberately NOT every slot: this array builds the
 *  sequencer's rows, so adding to it would give every user (and every saved
 *  project) new lanes they never asked for. CLAPS & SNAPS and RIM are slots you
 *  BROWSE — picking one with ADD NEW grafts it on as its own lane. */
export const TRACK_DEFS: Array<{ key: BuiltinTrackKey; name: string; color: string; defaultVolume: number }> = [
  { key: 'kick',    name: 'Kick',     color: '#ef4444', defaultVolume: 1.0 },
  { key: 'snare',   name: 'Snare',    color: '#f97316', defaultVolume: 1.0 },
  { key: 'hihat',   name: 'Hi-Hat',   color: '#eab308', defaultVolume: 0.25 },
  { key: 'openhat', name: 'Open Hat', color: '#22c55e', defaultVolume: 0.25 },
  { key: 'perc',    name: 'Perc',     color: '#3b82f6', defaultVolume: 0.50 },
];

export type Genre = 'boombap' | 'trap' | 'westcoast';
export const GENRES: readonly Genre[] = ['boombap', 'trap', 'westcoast'];
export const GENRE_LABELS: Record<Genre, string> = { boombap: 'BOOM BAP', trap: 'TRAP', westcoast: 'WEST COAST' };
// All sample kits, keyed by genre. Entries are OPAQUE R2 ids (see drumR2Url);
// samples.json is the only list, in a fixed order — presets store sampleIndex.
const KITS = manifest as unknown as Record<Genre, Record<TrackKey, string[]>>;
// Back-compat default export (boombap). Prefer the genre-aware lookups in the engine.
export const KIT: Record<TrackKey, string[]> = KITS.boombap;
export const KIT_NAME = 'boombap';

const STEPS_PER_BAR = 16;            // default VIEW grid resolution (1/16)
// Storage resolution. Patterns, the four step graphs and the scheduler all run
// at this; stepDivision (+ triplet) only controls what the user sees and
// quantizes to. 96 = the lcm of every offered view — 1/8, 1/16, 1/32 (12/6/3
// internal steps per column) AND their triplets 1/8T, 1/16T, 1/32T (8/4/2) — so
// every view is an exact lens and an old preset (saved at 32) upscales ×3.
// Before 2026-08-19 this was 32 and TRIPLET scaled the step DURATION by 2/3
// with the same 32 steps in the bar — the whole pattern played 1.5× faster
// (his report). A bar is a bar: only the number of columns changes now.
const INTERNAL_SPB = 96;
// Resolution the PATTERN GENERATORS speak (generate.ts, the built-in bank, and
// the Drum Dojo MIDI parser) — a 16th-note grid, ported verbatim and deliberately
// left that way. Storage moved to INTERNAL_SPB, so every generated row has to be
// spread onto the internal grid (upscaleFromGen) before it is stored. Writing a
// 16th row straight into 32nd slots plays the bar in half the time — that is
// exactly the double-time bug this constant exists to prevent.
const GEN_SPB = 16;
// Selectable step divisions (steps per bar): 1/8, 1/16, 1/32. A "1/N note" gives
// N steps per 4/4 bar, so stepsPerBar === the division denominator.
export const STEP_DIVISIONS = [8, 16, 32] as const;
export type StepDivision = typeof STEP_DIVISIONS[number];
// PPQ (pulses per quarter) the scheduler snaps micro-timing to. Now a GLOBAL
// preference (Preferences → Audio), spanning vintage to modern grids: 24 (SP-1200)
// … 960 (MPC 4000, near-continuous). Default = 960.
export const PPQ_VALUES = [24, 48, 96, 192, 480, 960] as const;
// Max grid length = max bars (4) × max division (32). The per-step graph arrays
// (velocity/shift/pan/repeat) are always allocated to this length so changing
// `bars` or the step division never has to refit them.
const MAX_STEPS = 4 * INTERNAL_SPB;

// ── Per-step bar-graph editor (ported from Drum Dojo) ──────────────────────
// Four editable parameters, one focused track at a time.
export type GraphParam = 'VELOCITY' | 'SHIFT' | 'PAN' | 'REPEAT';
export const GRAPH_DEFAULTS: Record<GraphParam, number> = { VELOCITY: 1, SHIFT: 0, PAN: 0, REPEAT: 0 };

// Note-repeat subdivisions for the graph editor. `beats` = fraction of a whole
// note; interval in seconds = beats * (60 / BPM). Index 0 = off. Verbatim from
// Drum Dojo so a roll sounds identical between the two apps.
export const REPEAT_RATES: Array<{ label: string; beats: number }> = [
  { label: '—',     beats: 0      },
  { label: '1/2',   beats: 2      },
  { label: '1/2T',  beats: 4 / 3  },
  { label: '1/4',   beats: 1      },
  { label: '1/4T',  beats: 2 / 3  },
  { label: '1/8',   beats: 0.5    },
  { label: '1/8T',  beats: 1 / 3  },
  { label: '1/16',  beats: 0.25   },
  { label: '1/16T', beats: 1 / 6  },
  { label: '1/32',  beats: 0.125  },
  { label: '1/32T', beats: 1 / 12 },
  { label: '1/64',  beats: 0.0625 },
  { label: '1/64T', beats: 1 / 24 },
];

/** Clamp a graph value into its parameter's range (REPEAT rounds to an index). */
export function clampGraph(p: GraphParam, v: number): number {
  return p === 'VELOCITY' ? Math.max(0, Math.min(1, v))
    : p === 'SHIFT' ? Math.max(-50, Math.min(50, v))
    : p === 'PAN' ? Math.max(-1, Math.min(1, v))
    : Math.max(0, Math.min(REPEAT_RATES.length - 1, Math.round(v)));
}

type StepGraph = Record<TrackKey, number[]>;

/** A fresh per-step graph array (all 5 tracks), filled to MAX_STEPS with `def`. */
function makeStepGraph(def: number, keys: readonly TrackKey[] = BUILTIN_TRACK_KEYS): StepGraph {
  const out: StepGraph = {};
  for (const k of keys) out[k] = Array(MAX_STEPS).fill(def);
  return out;
}

/** Refit a (possibly old/partial) saved graph to MAX_STEPS, default-filling gaps.
 *  `upscale` > 1 spreads a graph saved at a coarser storage resolution onto the
 *  internal grid (index i → i·upscale), for presets written before storage was
 *  decoupled from the view. Only the occupied slots move; the gaps keep the
 *  parameter default, which is what an untouched step means anyway. */
function fitStepGraph(p: GraphParam, src?: Partial<Record<TrackKey, number[]>>, upscale = 1, keys?: readonly TrackKey[]): StepGraph {
  const def = GRAPH_DEFAULTS[p];
  const out = makeStepGraph(def, keys ?? BUILTIN_TRACK_KEYS);
  // Iterate the SOURCE, not the output: a preset carrying added lanes has rows
  // the built-in list doesn't, and they'd be dropped on restore.
  if (src) for (const k of Object.keys(src)) {
    const row = src[k];
    if (!row) continue;
    if (!out[k]) out[k] = Array(MAX_STEPS).fill(def);
    for (let i = 0; i < row.length; i++) {
      const dst = i * upscale;
      if (dst >= MAX_STEPS) break;
      out[k][dst] = clampGraph(p, row[i]);
    }
  }
  return out;
}

// Punch-preserving attack for drum hits. The OLD path used a 25 ms EXPONENTIAL
// ramp (0.0001 → volume) which sat below ~0.01 gain for its first ~12 ms — that
// muted the kick/snare transient and made the sequencer sound softer than a raw
// audition. We instead:
//   - if the sample already starts at silence (these are MP3s; they decode with
//     leading encoder-delay silence, so buf[0] ≈ 0), set full gain at `when` with
//     NO ramp — the transient front is 100% intact;
//   - otherwise apply a 0.5 ms LINEAR fade from 0 — a pure click guard, far too
//     short to soften the hit.
const DRUM_ATTACK_S = 0.003;             // 3 ms linear click-guard — ONLY for samples that don't start at silence
const DRUM_HEAD_SILENCE = 0.02;          // head level below this ⇒ no ramp, full transient (~-34 dBFS)
const DRUM_HEAD_MS = 1;                  // "head" = the first millisecond, not just sample 0

/** Bake the click guard into the BUFFER, once, at decode time. About a quarter
 *  of the library was cut mid-waveform (first sample up to −19 dBFS); the old
 *  guard was a 0.5 ms GAIN ramp at the voice's start time — but a live hit is
 *  scheduled at ctx.currentTime, which the audio thread has already passed by
 *  the time it reads the automation, and past automation is treated as done:
 *  the ramp was skipped and the voice started at full gain → an intermittent
 *  click (live pads / MIDI / step auditions; sequencer hits only when the main
 *  thread stalled past the look-ahead). Sample data can't be late. Same 22
 *  samples the ramp covered; the drum's own transient peaks 2–8 ms in, untouched.
 *  Buffers whose head is already (near) silent are left byte-for-byte alone. */
export function declickHead(buf: AudioBuffer): void {
  let n = Math.min(buf.length, Math.max(8, Math.round(buf.sampleRate * DRUM_ATTACK_S)));
  let head = 0;
  for (let c = 0; c < buf.numberOfChannels; c++) head = Math.max(head, Math.abs(buf.getChannelData(c)[0] ?? 0));
  if (head < 0.002) return; // −54 dBFS: nothing to guard
  // A hit that starts ON its transient (some claps/rims peak within 0.2 ms):
  // end the fade at the first sample that reaches −6 dBFS so the peak itself
  // is never touched — only the cut-off head before it.
  for (let i = 1; i < n; i++) {
    let a = 0;
    for (let c = 0; c < buf.numberOfChannels; c++) a = Math.max(a, Math.abs(buf.getChannelData(c)[i]));
    if (a >= 0.5) { n = Math.max(4, i); break; }
  }
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < n; i++) d[i] *= i / n;
  }
}

/** The other end. 14 of the 250 kicks (measured 2026-08-18) end with the
 *  last sample still ≥ −40 dBFS — three of them at −12…−14 dBFS. A buffer
 *  that stops mid-swing clicks at its END every time it plays out, which only
 *  happens when the next hit doesn't choke it first: a "random" kick click
 *  that comes and goes with the pattern. Fade the final 5 ms with a raised
 *  cosine to zero — inaudible on a drum tail, and buffers that already end
 *  silent are left byte-for-byte alone. */
const DRUM_TAIL_S = 0.005;
export function declickTail(buf: AudioBuffer): void {
  const n = Math.min(buf.length, Math.max(8, Math.round(buf.sampleRate * DRUM_TAIL_S)));
  const L = buf.length;
  let last = 0;
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const d = buf.getChannelData(c);
    for (let i = L - 8; i < L; i++) last = Math.max(last, Math.abs(d[i] ?? 0));
  }
  if (last < 0.002) return; // −54 dBFS: already lands on silence
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < n; i++) {
      const t = (i + 1) / n;                       // 0 → 1 across the fade
      d[L - n + i] *= 0.5 * (1 + Math.cos(Math.PI * t)); // 1 → 0, raised cosine
    }
  }
}

/** Peak CEILING at decode. Measured 2026-08-19 across all 193 kick MP3s: 134
 *  decode above 0 dBFS and 17 above +3 dBFS (MP3 has no hard ceiling; the
 *  packs were mastered hot). Anything past 1.0 hard-clips at the output — and
 *  a clipped kick transient IS a click, on the kick specifically (his report,
 *  still there after the head/tail declick). Scale hot buffers DOWN to
 *  −0.2 dBFS; never boost, so kit balance among the quiet ones is untouched.
 *  Buffers already under the ceiling are left byte-for-byte alone. */
const DRUM_PEAK_CEILING = 0.977; // −0.2 dBFS
export function ceilPeak(buf: AudioBuffer): number {
  let peak = 0;
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < d.length; i++) { const a = Math.abs(d[i]); if (a > peak) peak = a; }
  }
  if (peak <= DRUM_PEAK_CEILING) return 1;
  const k = DRUM_PEAK_CEILING / peak;
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < d.length; i++) d[i] *= k;
  }
  return k;
}

/** Apply the punch-preserving attack envelope to a gain param. Pure + module-level
 *  so the live engine, the ?debug=1 A/B capture AND the offline arrangement
 *  renderer (renderArrangementDAW) share the EXACT same envelope and can never
 *  drift. `headAbs` = |first sample| of the buffer. */
/** Retrigger choke on a lane: the previous voice ramps to 0 over this (linear —
 *  a hard cut mid-cycle of a sub-bass pops, 4 ms does not), then stops. */
export const DRUM_CHOKE_S = 0.004;
/** Re-route crossfade: a lane moving between buses fades over this, not a hard cut. */
export const ROUTE_XFADE_S = 0.005;
/** How loud a sample is in its first millisecond — the thing that decides
 *  whether it needs a click guard. Sample 0 alone lied: an 808 trimmed one
 *  sample before a steep rise read "silent" and started with a tick. */
export function drumHeadLevel(buf: AudioBuffer): number {
  const n = Math.min(buf.length, Math.max(1, Math.round(buf.sampleRate * DRUM_HEAD_MS / 1000)));
  let peak = 0;
  for (let c = 0; c < buf.numberOfChannels; c++) {   // every channel — a stereo file hot on R only still needs the guard
    const d = buf.getChannelData(c);
    for (let i = 0; i < n; i++) { const a = Math.abs(d[i]); if (a > peak) peak = a; }
  }
  return peak;
}
/** Attack envelope: a sample that starts from silence starts INSTANTLY (every
 *  kick, snare, hat — full transient); one that starts mid-wave (an 808 trimmed
 *  hot) gets a 3 ms linear guard. Measured 2026-08-22 on a mid-cycle 55 Hz
 *  808: >3 kHz onset energy −25 dBFS at 0.5 ms (an audible tick), −41 at 3 ms,
 *  −47 at the pads' 6 ms. The old 0.5 ms guard was the click he heard on the
 *  drum lane but not on the pads. */
export function applyDrumAttack(param: AudioParam, when: number, volume: number, headAbs: number): void {
  const target = Math.max(0.0001, volume);
  if (headAbs < DRUM_HEAD_SILENCE) {
    param.setValueAtTime(target, when);            // silent head → no fade, full transient
  } else {
    param.setValueAtTime(0, when);
    param.linearRampToValueAtTime(target, when + DRUM_ATTACK_S); // tiny click guard only
  }
}

/** 16T swing + 96-PPQ snap offset (SECONDS) for one 0-indexed step at `bpm`,
 *  given a swing amount `drumSwing` (0..1). Pushes the off-beat 16ths — odd
 *  steps (1,3,5…) — later by `drumSwing · stepDur/2`, then crossfades in a
 *  96-PPQ quantize of that offset as the amount rises; even steps (downbeats)
 *  never move (returns 0). Pure + module-level so the LIVE look-ahead scheduler
 *  (DrumEngine.swingOffset) AND the OFFLINE arrangement exporters share the
 *  EXACT same groove and can never drift — identical intent to applyDrumAttack. */
export function drumSwingOffsetSec(stepIdx: number, bpm: number, drumSwing: number): number {
  // One formula for both sequencers — src/renderer/lib/swing.ts.
  return swingOffsetSec(stepIdx, bpm, drumSwing);
}

type Pattern = Record<TrackKey, boolean[]>;

/** `keys` defaults to the five built-ins so every existing call site is
 *  unchanged; added lanes get their row grafted on by addTrack(). */
function makeEmptyPattern(len: number, keys: readonly TrackKey[] = BUILTIN_TRACK_KEYS): Pattern {
  const out: Pattern = {};
  for (const k of keys) out[k] = Array(len).fill(false);
  return out;
}

/** Clones whatever rows the pattern actually has, rather than a fixed five —
 *  a hardcoded list would silently drop every added lane on any copy (undo
 *  snapshots, sequence duplication, serialize). */
function clonePattern(p: Pattern): Pattern {
  const out: Pattern = {};
  for (const k of Object.keys(p)) out[k] = [...p[k]];
  return out;
}

// Cap the decoded-sample cache. Unbounded growth (every randomize / genre swap /
// browser preview decodes another buffer) was a slow leak toward WKWebView's
// tab-kill on iOS — see the mobile-crash diagnostic.
const MAX_CACHE_BYTES = 64 * 1024 * 1024; // 64 MB

/** Estimated heap footprint of a decoded buffer: Float32 per sample per channel. */
function bufferBytes(buf: AudioBuffer): number {
  return buf.numberOfChannels * buf.length * 4;
}

/** Insertion-ordered LRU cache of decoded AudioBuffers, capped by estimated byte
 *  size. A Map's insertion order IS the LRU order: a hit delete+re-inserts the key
 *  to move it to the most-recently-used end; eviction drops from the front (oldest)
 *  until the total is back under the cap. Exposes only the get/set/clear subset of
 *  Map that DrumEngine uses, so it's a drop-in for `this.buffers`. */
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

export class DrumEngine {
  readonly ctx: AudioContext;
  readonly output: GainNode;
  // Drum master gain — all hits route through this so a single knob controls the
  // overall drum level independently of the chops (Phase 2A).
  private masterGain: GainNode;

  // Per-track output taps (desktop DAW Mixer). Each hit feeds its track's tap
  // node, which by DEFAULT connects to the drum masterGain — so standalone /
  // HardwareView playback sounds IDENTICAL (one extra unity gain in the path).
  // The desktop ChopperView calls routeTrackOutput() to peel a track's tap off
  // the masterGain and into its own mixer channel, giving the mixer a clean,
  // independent per-track signal BEFORE the drum master fader.
  readonly trackOutputNodes: Record<TrackKey, GainNode>;

  private state: DrumState;
  private listeners = new Set<(s: DrumState) => void>();

  // Undo/redo lives in ONE unified stack owned by the ChopperEngine. The view
  // wires this sink (record → engine.recordHistory, dropLast → engine
  // .dropLastHistory) so a drum edit snapshots the combined chop+drum state into
  // that stack BEFORE it mutates — exactly when chop methods call pushHistory.
  // Null when unattached (no-op). dropLast backs the browse-session discard.
  private historySink: { record: (group?: string) => void; dropLast: () => void } | null = null;
  // Sample-browser session: one undo snapshot for a whole open→close browse,
  // kept only if a LOAD committed (else discarded — see beginBrowseSession).
  private browseSessionActive = false;
  private browseSessionCommitted = false;

  // Per-track sample buffer cache. Loaded lazily on first hit. LRU-capped at
  // 64 MB so a long session that browses many kits can't grow without bound.
  private buffers = new LruBufferCache(MAX_CACHE_BYTES);
  private loading = new Set<string>();

  // Scheduler state
  private nextStepTime = 0;
  private nextStepIdx = 0;
  private playStartTime = 0; // ctx time step 0 is heard — drives the ref playhead
  private timer: ClockHandle | null = null;
  private look = new LookAhead(0.25, 0.5, 25); // see lib/audioClock — was a fixed 0.1 s
  private getBpm: () => number;
  /** INPUT Q, owned by the chopper engine (global fader by the BPM). */
  private getInputQuantize?: () => number;

  // Page-lifecycle: when the tab is backgrounded / the phone locks, iOS suspends
  // (or 'interrupted's) the AudioContext. We PARK the 25 ms scheduler while hidden
  // so it can't keep firing createBufferSource()/start() onto a dead context
  // (every such call throws → repeated unhandled rejections that can get the
  // embedding iframe killed on iOS), then resume + restart it on return.
  private onVisibility?: () => void;
  private onCtxState?: () => void;
  private parkedByVisibility = false;

  // For the 808-pop fix: store the active gain + source per track so we can
  // tail the previous one out before the next hit lands.
  // The voices of each lane, in the order they were STARTED. A voice is cut
  // only by a hit that lands AFTER it in time (see emitVoice) — so a hit
  // booked 200 ms ahead by the scheduler is never wiped by a hand hit that
  // lands before it, and the hand hit is cut when the booked one starts.
  private laneVoices: Partial<Record<TrackKey, LaneVoice[]>> = {};
  /** The level each active voice's envelope holds after its attack — what a
   *  choke should ramp DOWN FROM. Reading `gain.value` on the main thread is
   *  wrong for a voice that is scheduled but not yet started (it returns the
   *  GainNode default 1.0), which stepped a hat at 0.25 up to 1.0 (+12 dB
   *  click) before tailing it. */

  // Phase 3A.5: timeline of pattern swaps for arranged playback (Beat Finisher).
  // Each entry says "for any step whose PLAY time is >= `at`, use this pattern".
  // The look-ahead scheduler resolves the active pattern PER STEP from this list
  // (see patternFor), so a section boundary never drops its first hit (the old
  // setPattern-at-the-boundary approach lost the downbeat because the scheduler
  // had already queued that step ~100 ms earlier under the previous pattern), and
  // a live edit re-schedules the list so it lands on the next scheduled hit with
  // no transport restart. Empty during standalone drum play (falls back to
  // this.state.pattern).
  private pendingPatterns: Array<{ at: number; pattern: Pattern }> = [];

  // Live-recording (recordLiveHit) stamps steps straight into the internal
  // pattern WITHOUT emitting — emitting per hit re-renders the whole grid on the
  // audio thread and skips the 25 ms scheduler. Instead we mark the sequence
  // dirty and let the scheduler tick flush ONE emit every ~100 ms (see
  // flushSequence / scheduleAhead). _lastSeqFlush is the ctx time of the last
  // flush; SEQ_FLUSH_SEC throttles the visual update to ~10 fps.
  private _sequenceDirty = false;
  private _lastSeqFlush = 0;
  private static readonly SEQ_FLUSH_SEC = 0.1;

  /** The native drum sequencer binding (see DrumSink). Null = Web Audio (the Electron/web app). */
  drumSink: DrumSink | null = null;
  private bufferReadyListeners = new Set<(track: TrackKey) => void>();

  constructor(ctx: AudioContext, output: GainNode, getBpm: () => number, getInputQuantize?: () => number) {
    this.ctx = ctx;
    this.output = output;
    this.getBpm = getBpm;
    this.getInputQuantize = getInputQuantize;
    this.masterGain = ctx.createGain();
    this.masterGain.gain.value = 1;
    this.masterGain.connect(this.output);

    // One unity tap per track, wired into the drum master by default. The mixer
    // re-routes these (see routeTrackOutput); until then they're transparent.
    this.trackOutputNodes = {
      kick: ctx.createGain(), snare: ctx.createGain(), hihat: ctx.createGain(),
      openhat: ctx.createGain(), perc: ctx.createGain(),
    };
    for (const k of Object.keys(this.trackOutputNodes) as TrackKey[]) this.wireRoute(k, this.masterGain);

    // DrumEngine owns its OWN 25 ms scheduler interval, so it needs its own
    // lifecycle handling — ChopperEngine resumes the SHARED context but can't
    // restart this engine's loop. Mirror its visibility/statechange pattern.
    // Guarded by typeof document so non-DOM (test/SSR) paths don't throw.
    if (typeof document !== 'undefined') {
      this.onVisibility = () => {
        if (document.visibilityState === 'hidden') {
          // Park the look-ahead loop ONLY when the context is already off
          // (iOS suspends it on hide); on desktop the context keeps running
          // when the window is minimised, so keep the worker clock going — the
          // drums play on in the background like the chop sequencer does, and
          // there is no pile of missed steps to come back to (audit #14).
          // scheduleAhead itself refuses to book onto a non-running context.
          if (this.timer && this.ctx.state !== 'running') {
            this.timer.stop();
            this.timer = null;
            this.parkedByVisibility = this.state.playing;
          }
        } else {
          if (this.ctx.state !== 'running') this.ctx.resume().catch(() => {});
          // Restart the loop only if we parked it mid-playback.
          if (this.parkedByVisibility && this.state.playing && !this.timer) {
            this.parkedByVisibility = false;
            this.scheduleAhead();
            this.look.reset(); this.timer = startClock(() => { this.look.beat(); this.scheduleAhead(); }, 25);
          }
        }
      };
      document.addEventListener('visibilitychange', this.onVisibility);
      // iOS fires statechange when an interruption ends; resume the ctx then too.
      // Stored in a field (not an inline arrow) so dispose() can remove it.
      this.onCtxState = () => {
        if (document.visibilityState === 'visible' && this.ctx.state !== 'running') {
          this.ctx.resume().catch(() => {});
        }
      };
      this.ctx.addEventListener('statechange', this.onCtxState);
    }

    const pattern0 = makeEmptyPattern(2 * INTERNAL_SPB); // bars: 2 below, stored-length rows
    this.state = {
      tracks: TRACK_DEFS.map(d => ({
        key: d.key,
        name: d.name,
        color: d.color,
        sampleIndex: 0,
        sampleGenre: 'trap',
        muted: false,
        solo: false,
        volume: d.defaultVolume,
      })),
      pattern: pattern0,
      sequences: [pattern0],
      seqIndex: 0,
      bars: 2,
      step: -1,
      playing: false,
      masterVolume: 1,
      genre: 'trap',
      drumSwing: 0,
      stepDivision: STEPS_PER_BAR,
      gridOff: false,
      inputQuantize: 100,
      triplet: false,
      stepRecording: false,
      liveRecording: false,
      drumRecordStep: 0,
      ppq: 960,
      stepVelocity: makeStepGraph(GRAPH_DEFAULTS.VELOCITY),
      stepShift: makeStepGraph(GRAPH_DEFAULTS.SHIFT),
      stepPan: makeStepGraph(GRAPH_DEFAULTS.PAN),
      stepRepeat: makeStepGraph(GRAPH_DEFAULTS.REPEAT),
    };
  }

  /** The kit genre THIS track's current sample is drawn from (per-track, so a
   *  boombap kick can sit next to a trap snare). Falls back to the global groove
   *  genre for any track that predates the field (HMR / old preset). */
  private genreOf(track: TrackKey): Genre {
    return this.state.tracks.find(x => x.key === track)?.sampleGenre ?? this.state.genre;
  }

  /** Sample list for a track in ITS OWN kit genre. */
  /** The built-in kit slot a lane's samples come from — its own key for the
   *  five defaults, the borrowed `kitKey` for a user-added lane. */
  /** Public: the UI needs it too, to open the browser on the right category
   *  for an added lane. */
  kitSlot(track: TrackKey): BuiltinTrackKey { return this.slotOf(track); }

  private slotOf(track: TrackKey): BuiltinTrackKey {
    const k = this.state.tracks.find(t => t.key === track)?.kitKey ?? track;
    // Always one of the five in practice: defaults ARE slots, and addTrack only
    // ever stores a built-in as kitKey. Fall back rather than trust it blindly.
    return (BUILTIN_TRACK_KEYS as readonly string[]).includes(k) ? k as BuiltinTrackKey : 'perc';
  }

  private kitList(track: TrackKey): string[] {
    return KITS[this.genreOf(track)]?.[this.slotOf(track)] ?? [];
  }

  /** Switch the active sample-kit folder (boombap ↔ trap). With `reroll` (the
   *  default — header genre tab) every track jumps to a random sample in the new
   *  kit so the sounds actually change. With `reroll=false` (the Drum Browser kit
   *  switch + cancel-restore) each track keeps its slot, clamped into range, so
   *  the swap is predictable and reversible. The pattern is untouched either way. */
  setGenre(genre: Genre, reroll = true): void {
    // The header tab resets the WHOLE kit to one genre — even if the groove genre
    // already matches, pull any per-track overrides (set via the browser) back in
    // line so the tab reads as "make me a clean <genre> kit".
    if (genre === this.state.genre && this.state.tracks.every(t => t.sampleGenre === genre)) return;
    this.pushDrumHistory();
    const tracks = this.state.tracks.map(t => {
      const list = KITS[genre]?.[t.key] ?? [];
      const sampleIndex = reroll
        ? (list.length ? Math.floor(Math.random() * list.length) : 0)
        : Math.max(0, Math.min(t.sampleIndex, list.length - 1));
      return { ...t, sampleGenre: genre, sampleIndex };
    });
    // Switch the kit first so loadSample() resolves URLs against the new genre,
    // then preload the freshly-selected samples.
    this.state = { ...this.state, genre, tracks };
    for (const t of this.state.tracks) void this.loadSample(t.key, t.sampleIndex);
    this.emit();
  }

  /** Overall drum level (0..1). Routes through the drum master gain. */
  setMasterVolume(v: number): void {
    this.pushDrumHistory('drum-master'); // coalesce a fader drag into one undo
    const vol = Math.max(0, Math.min(1, v));
    this.masterGain.gain.setTargetAtTime(vol, this.ctx.currentTime, 0.01);
    this.state = { ...this.state, masterVolume: vol };
    this.emit();
  }

  /** 16T swing amount (0 = straight, 1 = full 16th-triplet feel ≈ 66.7% MPC
   *  swing). Pushes the off-beat 16ths late + crossfades in a 96-PPQ snap; read
   *  live by the look-ahead scheduler (see swingOffset), so no node to update. */
  setSwing(v: number): void {
    const swing = Math.max(0, Math.min(1, v));
    this.state = { ...this.state, drumSwing: swing };
    this.emit();
  }

  /** Live swing update during a fader drag. Updates the value the look-ahead
   *  scheduler reads on its very next step (swingOffset reads this.state.drumSwing
   *  live) WITHOUT emitting — so the host (ChopperView) doesn't re-render on every
   *  pointermove, which would block the main thread and starve the 25 ms scheduler
   *  → audio glitches. Commit with setSwing() on pointerup to publish the final
   *  value to React state + presets. Mirrors the CLIP fader's live/commit split. */
  setSwingLive(v: number): void {
    const swing = Math.max(0, Math.min(1, v));
    this.state = { ...this.state, drumSwing: swing };
  }

  // ── Per-step bar-graph editor ─────────────────────────────────────────
  /** The DrumState field name backing a graph parameter. */
  private graphField(p: GraphParam): 'stepVelocity' | 'stepShift' | 'stepPan' | 'stepRepeat' {
    return p === 'VELOCITY' ? 'stepVelocity' : p === 'SHIFT' ? 'stepShift' : p === 'PAN' ? 'stepPan' : 'stepRepeat';
  }

  /** Read a track's graph row for a parameter (always length MAX_STEPS). */
  graphRow(p: GraphParam, track: TrackKey): number[] {
    return this.state[this.graphField(p)][track];
  }

  private writeGraphRow(p: GraphParam, track: TrackKey, arr: number[]): void {
    const field = this.graphField(p);
    this.state = { ...this.state, [field]: { ...this.state[field], [track]: arr } };
    this.emit();
  }

  /** Set one step's graph value (clamped). */
  setStepGraphValue(p: GraphParam, track: TrackKey, step: number, value: number): void {
    if (step < 0 || step >= MAX_STEPS) return;
    const arr = [...this.state[this.graphField(p)][track]];
    arr[step] = clampGraph(p, value);
    this.writeGraphRow(p, track, arr);
  }

  /** Replace a track's whole graph row (clamped) — used by Cmd-drag (apply to all
   *  steps) + reset-all. Padded/truncated to MAX_STEPS. */
  setStepGraphRow(p: GraphParam, track: TrackKey, values: number[]): void {
    const arr = new Array<number>(MAX_STEPS);
    for (let i = 0; i < MAX_STEPS; i++) arr[i] = clampGraph(p, values[i] ?? GRAPH_DEFAULTS[p]);
    this.writeGraphRow(p, track, arr);
  }

  /** Reset every step in a track to the parameter default. */
  resetStepGraph(p: GraphParam, track: TrackKey): void {
    this.writeGraphRow(p, track, Array(MAX_STEPS).fill(GRAPH_DEFAULTS[p]));
  }

  /** LIVE (no-emit) update of one step during a bar-graph drag. Mutates the array
   *  the look-ahead scheduler reads on its next tick, but does NOT emit — so the
   *  host (ChopperView) doesn't re-render every pointermove and starve the 25 ms
   *  scheduler → audio glitches. Commit once with commitStepGraph() on pointerup.
   *  Mirrors setSwingLive's live/commit split. */
  setStepGraphValueLive(p: GraphParam, track: TrackKey, step: number, value: number): void {
    if (step < 0 || step >= MAX_STEPS) return;
    this.state[this.graphField(p)][track][step] = clampGraph(p, value);
  }

  /** LIVE (no-emit) update of a whole row — Cmd-drag (apply delta to all steps). */
  setStepGraphRowLive(p: GraphParam, track: TrackKey, values: number[]): void {
    const arr = this.state[this.graphField(p)][track];
    for (let i = 0; i < MAX_STEPS; i++) arr[i] = clampGraph(p, values[i] ?? GRAPH_DEFAULTS[p]);
  }

  /** Commit the live-edited row to React state + presets with a SINGLE emit
   *  (pointerup). Snapshots the live-mutated array into a fresh reference so the
   *  host re-renders once and dirty-tracking sees the change. */
  commitStepGraph(p: GraphParam, track: TrackKey): void {
    const field = this.graphField(p);
    this.state = { ...this.state, [field]: { ...this.state[field], [track]: [...this.state[field][track]] } };
    this.emit();
  }

  /** Desktop DAW Mixer: peel a track's output tap off the internal drum master
   *  and feed it into an external node (its mixer channel input) instead. The
   *  per-hit gain + mute/solo still apply (they happen upstream of the tap); the
   *  mixer just adds its own fader/FX/metering on top. Idempotent enough — a
   *  fresh disconnect()+connect() re-points cleanly. Pass `null` to restore the
   *  default routing back to the drum master. */
  /** Every lane has an output tap or it has nowhere to play from. addTrack
   *  makes one; a lane that arrives through RESTORE (a saved project with
   *  added lanes) must get one too — without it `connect(undefined)` threw
   *  inside the hit's catch-all and the lane was silently dead after reload. */
  private ensureTap(track: TrackKey): GainNode {
    let tap = this.trackOutputNodes[track];
    if (!tap) { tap = this.ctx.createGain(); this.trackOutputNodes[track] = tap; this.wireRoute(track, this.masterGain); }
    return tap;
  }
  // A lane's tap reaches its destination THROUGH a route gain (tap → route →
  // dest). Re-routing a lane that is ringing (assign it to another mixer strip,
  // a strip created mid-bar) used to be a hard disconnect/connect — a step in
  // both buses = a click (audit #13). Now the old route fades out and the new
  // one fades in over ROUTE_XFADE_S; the old gain is unplugged once it is down.
  private trackRoute: Partial<Record<TrackKey, { gain: GainNode; dest: AudioNode }>> = {};
  private wireRoute(track: TrackKey, dest: AudioNode, fadeIn = false): GainNode {
    const tap = this.trackOutputNodes[track];
    const g = this.ctx.createGain();
    if (fadeIn) { const t = this.ctx.currentTime; g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(1, t + ROUTE_XFADE_S); }
    else g.gain.value = 1;
    tap.connect(g); g.connect(dest);
    this.trackRoute[track] = { gain: g, dest };
    return g;
  }
  routeTrackOutput(track: TrackKey, dest: AudioNode | null): void {
    const tap = this.ensureTap(track);
    const to = dest ?? this.masterGain;
    const cur = this.trackRoute[track];
    if (cur && cur.dest === to) return;
    this.wireRoute(track, to, !!cur);
    if (cur) {
      const t = this.ctx.currentTime;
      try {
        cur.gain.gain.cancelScheduledValues(t);
        cur.gain.gain.setValueAtTime(cur.gain.gain.value, t);
        cur.gain.gain.linearRampToValueAtTime(0, t + ROUTE_XFADE_S);
      } catch { /* */ }
      setTimeout(() => { try { tap.disconnect(cur.gain); cur.gain.disconnect(); } catch { /* */ } }, ROUTE_XFADE_S * 1000 + 30);
    }
  }

  subscribe(fn: (s: DrumState) => void): () => void {
    this.listeners.add(fn);
    fn(this.state);
    return () => { this.listeners.delete(fn); };
  }

  private emit(): void {
    for (const l of this.listeners) l(this.state);
  }

  // ── Undo/redo hook (drives the ChopperEngine's unified stack) ──────────────
  /** Wire the history sink. The view passes record → chopperEngine.recordHistory
   *  and dropLast → chopperEngine.dropLastHistory, so every drum edit snapshots
   *  the combined chop+drum state. Null to detach. */
  setHistorySink(sink: { record: (group?: string) => void; dropLast: () => void } | null): void {
    this.historySink = sink;
  }

  /** Snapshot the pre-edit state. Called at the TOP of every mutating method
   *  (before state changes) and from markHistory() for view-driven gestures. */
  private pushDrumHistory(group?: string): void { this.historySink?.record(group); }

  /** Public gesture-start snapshot for the bar-graph + swing drags (the view
   *  calls this once on pointer-down; the per-move Live setters do NOT push). */
  markHistory(group?: string): void { this.pushDrumHistory(group); }

  /** Begin a sample-browser session: take ONE pre-browse snapshot now and
   *  suppress per-audition pushes (setTrackSample no-ops its own push while a
   *  session is active). The whole open→close browse collapses to one undo. */
  beginBrowseSession(): void {
    this.pushDrumHistory();
    this.browseSessionActive = true;
    this.browseSessionCommitted = false;
  }
  /** A LOAD happened during the session — keep the snapshot on close. */
  markBrowseCommitted(): void { this.browseSessionCommitted = true; }
  /** End the session. If no LOAD committed, the auditions were reverted to the
   *  baseline (== pre-browse), so the snapshot is dead → discard it; otherwise
   *  keep it as the single undo step that reverts the loaded sample(s). */
  endBrowseSession(): void {
    // The browser is closing: whatever it was auditioning stops with it (a long
    // sample must not keep ringing under the closed window).
    this.chokePreview(this.ctx.currentTime);
    if (this.browseSessionActive && !this.browseSessionCommitted) this.historySink?.dropLast();
    this.browseSessionActive = false;
    this.browseSessionCommitted = false;
  }

  /** Steps per bar in STORAGE — always the internal resolution, never the view.
   *
   *  Patterns used to be stored at whatever division was on screen, so changing
   *  the grid rewrote the data through remapGrid(). That made every switch a
   *  lossy re-quantize: 1/32 detail viewed at 1/8 collapsed onto the coarse
   *  slots and could not be recovered by switching back. Storing at a fixed 1/32
   *  and treating stepDivision as a pure VIEW makes grid changes free and
   *  reversible — and lets 1/32 hats coexist with 1/8 ones, which is the whole
   *  point. 8, 16 and 32 all divide 32 exactly, so old presets upscale losslessly. */
  private spb(): number { return INTERNAL_SPB; }

  /** Steps per bar the USER currently sees / clicks / quantizes to. Triplet
   *  views hold 3 columns where the straight view holds 2 (1/16 → 16 columns,
   *  1/16T → 24) — same bar length, so a triplet hat is 2/3 the note. */
  private viewSpb(): number {
    const d = this.state.stepDivision || STEPS_PER_BAR;
    return this.state.triplet ? d * 3 / 2 : d;
  }
  /** Columns per bar at the current view (division × triplet) — the UI's grid width. */
  get viewStepsPerBar(): number { return this.viewSpb(); }

  /** Internal steps per visible column (1/8 view → 12, 1/16 → 6, 1/32 → 3;
   *  triplets 8 / 4 / 2). */
  private viewStride(): number { return INTERNAL_SPB / this.viewSpb(); }

  /** Internal step index for a visible column. UI-facing: the grid renders
   *  `bars · stepDivision` columns and maps each through here. */
  stepForColumn(col: number): number { return col * this.viewStride(); }

  /** How many internal steps each visible column spans — the UI needs this to
   *  find the off-grid notes hiding between columns (the ghosts). */
  get columnStride(): number { return this.viewStride(); }

  /** Total visible columns at the current view. */
  get columnCount(): number { return this.state.bars * this.viewSpb(); }

  /** Steps per bar the ENGINE counts in — the unit `start(atTime, stepOffset)`
   *  takes and every stored row is written at. Anything computing a seek offset
   *  from outside (the arranger preview) must use this, not assume 16ths. */
  get stepsPerBar(): number { return this.spb(); }

  /** Duration (seconds) of one INTERNAL step at the current bpm: one whole note
   *  (4 beats) / INTERNAL_SPB. Never depends on the view — the division and the
   *  triplet switch change how many columns a bar shows, never how long it is. */
  private stepDurSec(): number {
    const bpm = this.getBpm();
    if (bpm <= 0) return 0;
    return (60 / bpm) * 4 / this.spb();
  }

  /** Set the VIEW grid: 8 (1/8) | 16 (1/16) | 32 (1/32). Changes which columns
   *  are drawn and where new input quantizes — never the stored notes. Selecting
   *  a division also clears GRID OFF (the two are mutually exclusive). */
  setStepDivision(division: number): void {
    if (!(STEP_DIVISIONS as readonly number[]).includes(division)) return;
    if (division === this.state.stepDivision && !this.state.gridOff) return;
    // No pattern rewrite, and nothing to re-anchor: storage and the scheduler
    // both run at INTERNAL_SPB regardless of the view, so changing the grid
    // cannot move a note or shift the transport. It only changes which columns
    // are drawn and where new input quantizes to. Not undoable for the same
    // reason — there is no data change to undo.
    this.state = { ...this.state, stepDivision: division, gridOff: false };
    this.emit();
  }

  /** Toggle grid-quantization OFF (freeform live recording). When OFF, live hits
   *  record at their exact timing instead of snapping to the division grid (see
   *  recordLiveHit); existing recorded steps still play normally. Mutually
   *  exclusive with the division buttons. */
  /** INPUT Q strength as 0..1. The fader is GLOBAL now (it sits by the BPM and
   *  serves both sequencers — his rule 2026-08-20), so the value comes from the
   *  chopper engine through `getInputQuantize`; `state.inputQuantize` is only
   *  the fallback that keeps a standalone engine (and old projects, which
   *  ChopperEngine.loadPreset migrates) behaving the same. */
  private inputQuantizeStrength(): number {
    const src = this.getInputQuantize?.();
    const v = typeof src === 'number' ? src : this.state.inputQuantize;
    return Math.max(0, Math.min(100, Number.isFinite(v) ? v : 100)) / 100;
  }

  setGridOff(v: boolean): void {
    if (this.state.gridOff === v) return;
    this.pushDrumHistory();
    this.state = { ...this.state, gridOff: v };
    this.emit();
  }

  /** Toggle triplet subdivision (1/8T, 1/16T, 1/32T). A pure VIEW change like
   *  setStepDivision: the bar keeps its length and every stored note its place —
   *  the grid just shows 3 columns per beat-fraction instead of 2. Straight
   *  notes that don't land on the triplet lens show as ghosts, and vice versa.
   *  No data change → not undoable. No-op while GRID OFF (timing is freeform). */
  setTriplet(v: boolean): void {
    if (this.state.gridOff) return; // triplet has no meaning with the grid off
    if (this.state.triplet === v) return;
    this.state = { ...this.state, triplet: v };
    this.emit();
  }

  /** Set the scheduler's micro-timing snap resolution (one of PPQ_VALUES, from the
   *  global Preferences → Audio setting). Read live by scheduleStep, so it takes
   *  effect on the next step; nothing to refit. */
  setPpq(ppq: number): void {
    if (!(PPQ_VALUES as readonly number[]).includes(ppq)) return;
    this.state = { ...this.state, ppq };
    this.emit();
  }

  getState(): DrumState { return this.state; }

  /** Snapshot the full drum state for a preset (no transport runtime). */
  serialize(): DrumPreset {
    return {
      tracks: this.state.tracks.map(t => ({
        key: t.key, sampleIndex: t.sampleIndex, sampleGenre: t.sampleGenre,
        muted: t.muted, solo: t.solo, volume: t.volume,
        // Added lanes have no TRACK_DEFS entry, so their identity has to travel
        // with the preset or they come back as nothing.
        ...(t.added ? { name: t.name, color: t.color, kitKey: t.kitKey, added: true } : {}),
        ...(t.userPath ? { userPath: t.userPath, userName: t.userName } : {}),
        ...(t.muteGroup ? { muteGroup: t.muteGroup } : {}),
      })),
      sequences: this.state.sequences.map(clonePattern),
      seqIndex: this.state.seqIndex,
      bars: this.state.bars,
      masterVolume: this.state.masterVolume,
      genre: this.state.genre,
      drumSwing: this.state.drumSwing,
      stepDivision: this.state.stepDivision,
      gridRes: INTERNAL_SPB,   // rows below are internal-resolution, not view
      _gridOff: this.state.gridOff,
      _inputQuantize: this.state.inputQuantize,
      _triplet: this.state.triplet,
      ppq: this.state.ppq,
      stepVelocity: this.cloneGraph(this.state.stepVelocity),
      stepShift: this.cloneGraph(this.state.stepShift),
      stepPan: this.cloneGraph(this.state.stepPan),
      stepRepeat: this.cloneGraph(this.state.stepRepeat),
    };
  }

  private cloneGraph(g: StepGraph): StepGraph {
    // Every lane — added lanes too (the old five-key literal dropped their
    // velocity / shift / pan / repeat graphs on every save + undo snapshot).
    const out = {} as StepGraph;
    for (const k of Object.keys(g)) out[k] = [...g[k]];
    return out;
  }

  /** Restore a serialized drum state so the kit sounds identical on reload.
   *  Order matters: per-track genre + global genre are set BEFORE loadSample()
   *  so each sample resolves against the kit it was saved from. Stops playback
   *  (used by preset LOAD); undo uses restoreForUndo() to stay seamless. */
  restore(preset: DrumPreset): void {
    if (!preset) return;
    this.stop(); // halt playback before swapping the whole state out
    this.applyRestoredState(preset, true);
  }

  /** Restore for UNDO/REDO. Identical state result to restore(), but keeps drum
   *  playback running when the kit's per-track samples are unchanged — the usual
   *  case for a step/graph/swing/bars/pattern undo, so those undos are seamless.
   *  Only when a sample actually differs do we fall back to the heavy restore()
   *  (which stops + reloads buffers, briefly interrupting playback). */
  restoreForUndo(preset: DrumPreset): void {
    if (!preset) return;
    const sameSamples =
      (preset.genre ?? this.state.genre) === this.state.genre &&
      this.state.tracks.every(cur => {
        const saved = preset.tracks?.find(s => s.key === cur.key);
        return !!saved && saved.sampleGenre === cur.sampleGenre && saved.sampleIndex === cur.sampleIndex
          && (saved.userPath ?? null) === (cur.userPath ?? null);
      });
    if (!sameSamples) { this.restore(preset); return; } // sample change → safe heavy path
    this.applyRestoredState(preset, false);             // keep buffers + keep playing
  }

  /** Shared body of restore()/restoreForUndo(): rebuild DrumState from a preset
   *  in place. `reloadSamples` re-fetches every track buffer (restore + sample-
   *  changing undos); undo's light path skips it because the buffers are known
   *  unchanged. Runtime fields (playing/step/scheduler anchors) survive via the
   *  `...this.state` spread, so the light path plays on without a gap. */
  private applyRestoredState(preset: DrumPreset, reloadSamples: boolean): void {
    const bars = Math.max(1, Math.min(4, Math.floor(preset.bars ?? this.state.bars)));
    // Restore the saved grid resolution (old presets predate it → default 1/16).
    const stepDivision = (STEP_DIVISIONS as readonly number[]).includes(preset.stepDivision ?? 0)
      ? preset.stepDivision! : STEPS_PER_BAR;
    const ppq = (PPQ_VALUES as readonly number[]).includes(preset.ppq ?? 0) ? preset.ppq! : 960;
    // Storage is INTERNAL_SPB now. Presets written before that saved their rows
    // at whatever division was on screen (`gridRes` absent), so upscale those by
    // their stepDivision; anything carrying gridRes is already internal. Every
    // offered division divides 32, so the upscale is exact — no note moves.
    const savedRes = preset.gridRes ?? stepDivision;
    // ×3 for anything saved at the old 32 storage, ×6/×12 for view-resolution
    // presets. Guarded so a preset finer than internal can never produce
    // fractional indices (it would only lose off-grid hits, never corrupt).
    const upscale = savedRes > 0 && savedRes <= INTERNAL_SPB && INTERNAL_SPB % savedRes === 0 ? INTERNAL_SPB / savedRes : 1;
    const len = bars * INTERNAL_SPB;
    // Merge saved per-track fields onto the canonical track defs (keep name/color).
    // muted/solo are forced OFF on restore: the per-track mute/solo UI was removed
    // from DrumSection (muting is the mixer channel's job now), so an engine-level
    // mute is no longer user-clearable — restoring `muted:true` from an old preset
    // would leave that track permanently silent (it's skipped before reaching the
    // mixer). Dropping them keeps every restored track audible and balanceable.
    // Start from the five defaults (so a preset can't delete them), apply any
    // saved settings, then append the preset's ADDED lanes — they exist only in
    // the preset, so rebuild them from what it carried.
    const tracks: DrumTrack[] = this.state.tracks.filter(t => !t.added).map(cur => {
      const saved = preset.tracks?.find(s => s.key === cur.key);
      return saved
        ? { ...cur, sampleIndex: saved.sampleIndex, sampleGenre: saved.sampleGenre, muted: false, solo: false, volume: saved.volume,
            userPath: saved.userPath, userName: saved.userName, userMissing: undefined, muteGroup: saved.muteGroup || undefined }
        : cur;
    });
    for (const s of preset.tracks ?? []) {
      if (!s.added || tracks.some(t => t.key === s.key)) continue;
      tracks.push({
        key: s.key,
        name: s.name ?? s.key,
        color: s.color ?? '#a855f7',
        kitKey: s.kitKey ?? 'perc',
        added: true,
        sampleIndex: s.sampleIndex,
        sampleGenre: s.sampleGenre,
        userPath: s.userPath, userName: s.userName,
        muted: false, solo: false, volume: s.volume,
        muteGroup: s.muteGroup || undefined,
      });
    }
    const trackKeys = tracks.map(t => t.key);
    for (const t of tracks) this.ensureTap(t.key); // restored added lanes get their output tap
    // Refit every saved sequence to the restored bar length.
    const fit = (p?: Record<TrackKey, boolean[]>): Pattern => {
      // Built from the RESTORED track list, so added lanes get their rows.
      const out = makeEmptyPattern(len, trackKeys);
      if (p) for (const k of Object.keys(out) as TrackKey[]) {
        const row = p[k] ?? [];
        for (let i = 0; i < row.length; i++) {
          if (!row[i]) continue;
          const dst = i * upscale;          // exact: 8/16/32 all divide 96
          if (dst < len) out[k][dst] = true;
        }
      }
      return out;
    };
    const sequences = (preset.sequences?.length ? preset.sequences : [makeEmptyPattern(len, trackKeys)]).map(fit);
    const seqIndex = Math.max(0, Math.min(sequences.length - 1, preset.seqIndex ?? 0));
    const masterVolume = Math.max(0, Math.min(1, preset.masterVolume ?? this.state.masterVolume));
    const drumSwing = Math.max(0, Math.min(1, preset.drumSwing ?? 0)); // old presets predate swing → straight
    this.state = {
      ...this.state,
      tracks,
      sequences,
      seqIndex,
      pattern: sequences[seqIndex],
      bars,
      masterVolume,
      genre: preset.genre ?? this.state.genre,
      drumSwing,
      stepDivision,
      gridOff: preset._gridOff ?? false,
      inputQuantize: typeof preset._inputQuantize === 'number' ? Math.max(0, Math.min(100, preset._inputQuantize)) : 100,
      triplet: preset._triplet ?? false,
      ppq,
      // Old presets predate the graph editor → fitStepGraph default-fills them.
      // `upscale` moves each saved value onto its internal slot for rows written
      // before storage was decoupled from the view (1 = already internal).
      stepVelocity: fitStepGraph('VELOCITY', preset.stepVelocity, upscale, trackKeys),
      stepShift: fitStepGraph('SHIFT', preset.stepShift, upscale, trackKeys),
      stepPan: fitStepGraph('PAN', preset.stepPan, upscale, trackKeys),
      stepRepeat: fitStepGraph('REPEAT', preset.stepRepeat, upscale, trackKeys),
    };
    this.masterGain.gain.setTargetAtTime(masterVolume, this.ctx.currentTime, 0.01);
    // Preload each restored sample against its now-set per-track genre. The undo
    // light path skips this — the buffers it's restoring to are already loaded.
    if (reloadSamples) for (const t of this.state.tracks) void this.loadSample(t.key, t.sampleIndex);
    this.emit();
  }

  /** Currently-heard step, computed from the audio clock so the UI can render a
   *  ref-based playhead in its own rAF — NO per-step state emit, zero React
   *  churn on the audio path. Returns -1 when stopped. */
  getStep(): number {
    if (!this.state.playing) return -1;
    const stepDur = this.stepDurSec();
    if (stepDur <= 0) return 0;
    const total = this.state.bars * this.spb();
    // NATIVE: the engine's own position at the ear (independent of this context's clock); else the ctx anchor
    const native = this.drumSink?.elapsedSec();
    const elapsed = native != null && Number.isFinite(native) ? native : this.ctx.currentTime - this.playStartTime;
    if (elapsed < 0) return 0;
    return ((Math.floor(elapsed / stepDur) % total) + total) % total;
  }

  /** Current transport BPM (the value the look-ahead scheduler runs at). Public
   *  so the LIVE-mode note-repeat can size its interval. */
  currentBpm(): number { return this.getBpm(); }

  /** Display name of a track's current sample — the random-looking but STABLE
   *  alias (kick_thunder, snare_crack). It's the exact same name the Drum Browser
   *  shows for this sample, so the sequencer row and the browser always match.
   *  The real filename stays in samples.json for loading. */
  sampleName(track: TrackKey): string {
    const t = this.state.tracks.find(x => x.key === track);
    if (!t) return '—';
    // MY DRUMS: the lane plays the user's own file — its name, and a clear
    // MISSING if the file can't be found (never a silent swap to a kit sound).
    if (t.userPath) return `${t.userName ?? t.userPath.split('/').pop() ?? t.userPath}${t.userMissing ? ' ⚠ MISSING' : ''}`;
    const list = this.kitList(track);
    const file = list[t.sampleIndex];
    if (!file) return '—';
    // Alias tables are keyed by the built-in SLOT, so an added lane borrowing
    // the perc kit reads the same names the perc row does.
    return drumAlias(this.slotOf(track), list, file);
  }

  // ── Drum Browser bridge ───────────────────────────────────────────────
  // The DrumBrowser is filename/id-based; the engine is index-based. These
  // three methods bridge the two so the browser can swap, preview and snapshot
  // a track's sample without knowing about sampleIndex.

  /** Raw filename of a track's current sample, in its own kit genre (or null). */
  currentSampleFile(track: TrackKey): string | null {
    const t = this.state.tracks.find(x => x.key === track);
    if (!t || t.userPath) return null; // a user file is not a kit sample (see userSampleOf)
    return this.kitList(track)[t.sampleIndex] ?? null;
  }
  /** MY DRUMS: the user file a lane plays, if any. */
  userSampleOf(track: TrackKey): { rel: string; name: string } | null {
    const t = this.state.tracks.find(x => x.key === track);
    return t?.userPath ? { rel: t.userPath, name: t.userName ?? t.userPath } : null;
  }

  /** LOAD: commit a sample (from any kit genre) onto a track. Sets the track's
   *  per-track genre + index, so you can mix kits. The scheduler reads these live,
   *  so the sound swaps on the next hit; the pattern is untouched. */
  setTrackSample(track: TrackKey, genre: Genre, file: string): void {
    const idx = (KITS[genre]?.[track] ?? []).indexOf(file);
    if (idx < 0) return;
    // Inside a browse session the snapshot was taken once at beginBrowseSession;
    // per-audition pushes would spam history. A direct call (no session) pushes.
    if (!this.browseSessionActive) this.pushDrumHistory();
    this.state = {
      ...this.state,
      tracks: this.state.tracks.map(x => x.key === track ? { ...x, sampleGenre: genre, sampleIndex: idx, userPath: undefined, userName: undefined, userMissing: undefined } : x),
    };
    void this.loadSample(track, idx); // preload so the committed hit lands clean
    this.emit();
  }

  /** Audition a one-shot of a sample from ANY kit, WITHOUT committing it to the
   *  track (browser PREVIEW). Independent of the track's live sound. */
  async previewSample(track: TrackKey, genre: Genre, file: string): Promise<void> {
    void genre;
    const buf = await this.loadUrl(drumR2Url(file));
    if (!buf) return;
    this.playPreviewBuffer(track, buf);
  }
  // The browser's audition voice. ONE at a time: stepping through sounds chokes
  // the previous one (a 4 ms fade, no click) — they never pile up.
  private previewVoice: { src: AudioBufferSourceNode; g: GainNode } | null = null;
  private chokePreview(at: number): void {
    const v = this.previewVoice; if (!v) return;
    this.previewVoice = null;
    try {
      v.g.gain.cancelScheduledValues(at);
      v.g.gain.setValueAtTime(v.g.gain.value, at);
      v.g.gain.linearRampToValueAtTime(0, at + 0.004);
      v.src.stop(at + 0.006);
    } catch { /* already ended */ }
  }
  private playPreviewBuffer(track: TrackKey, buf: AudioBuffer): void {
    const when = this.ctx.currentTime + 0.005;
    this.chokePreview(when);
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    const g = this.ctx.createGain();
    // Same punch-preserving attack the sequencer and the pads use — the old
    // 20 ms exponential ramp made every browser audition softer than the sound
    // you'd actually get after LOAD.
    applyDrumAttack(g.gain, when, 1, drumHeadLevel(buf));
    src.connect(g);
    g.connect(this.ensureTap(track));
    src.start(when);
    const voice = { src, g };
    this.previewVoice = voice;
    // Disconnect when the audition finishes so rapid browser stepping doesn't
    // leave orphaned graph-connected nodes piling up.
    src.onended = () => { if (this.previewVoice === voice) this.previewVoice = null; try { src.disconnect(); g.disconnect(); } catch { /* */ } };
  }

  /** Full sample manifest across BOTH kits, shaped for the Drum Browser. The
   *  alias is the SAME random-looking name the sequencer shows (kick_thunder…),
   *  so a loaded sound reads identically in both places. Iterating the aliasMap
   *  gives a hash-sorted (random-looking) list order. URLs resolve against the
   *  site-root /drums/<genre>/. */
  browserManifest(): Array<{ id: string; category: BuiltinTrackKey; url: string; kit: Genre; alias: string }> {
    // Categories are the browsable SLOTS, not lane keys — an added lane browses
    // whichever slot it borrows. That is why this walks BUILTIN_TRACK_KEYS and
    // not TRACK_DEFS: CLAPS & SNAPS and RIM are slots you can browse and ADD as
    // a lane, without being lanes every project is born with.
    const out: Array<{ id: string; category: BuiltinTrackKey; url: string; kit: Genre; alias: string }> = [];
    for (const genre of GENRES) {
      for (const key of BUILTIN_TRACK_KEYS) {
        const list = KITS[genre]?.[key] ?? [];
        for (const [file, alias] of aliasMap(key, list)) {
          out.push({
            id: file,
            category: key,
            url: drumR2Url(file),
            kit: genre,
            alias,
          });
        }
      }
    }
    return out;
  }

  // ── Pattern mutations ─────────────────────────────────────────────────

  /** Write a new active pattern, keeping sequences[seqIndex] in sync. Every
   *  edit to the live grid funnels through here so the stored sequence updates
   *  with it. */
  private writePattern(pattern: Pattern): void {
    const sequences = this.state.sequences.slice();
    sequences[this.state.seqIndex] = pattern;
    this.state = { ...this.state, pattern, sequences };
    this.emit();
  }

  toggleStep(track: TrackKey, step: number): void {
    this.pushDrumHistory();
    const row = [...this.state.pattern[track]];
    row[step] = !row[step];
    this.writePattern({ ...this.state.pattern, [track]: row });
  }

  setBars(n: number): void {
    const bars = Math.max(1, Math.min(4, Math.floor(n)));
    if (bars === this.state.bars) return;
    this.pushDrumHistory();
    const len = bars * this.spb();
    // Refit EVERY stored sequence so they all share the new length.
    const refit = (p: Pattern): Pattern => {
      const out = makeEmptyPattern(len);
      for (const k of Object.keys(out) as TrackKey[]) {
        const cur = p[k];
        for (let i = 0; i < Math.min(cur.length, len); i++) out[k][i] = cur[i];
      }
      return out;
    };
    const sequences = this.state.sequences.map(refit);
    this.state = { ...this.state, bars, sequences, pattern: sequences[this.state.seqIndex] };
    this.emit();
  }

  setTrackMuted(track: TrackKey, muted: boolean): void {
    this.state = {
      ...this.state,
      tracks: this.state.tracks.map(t => t.key === track ? { ...t, muted } : t),
    };
    this.emit();
  }

  setTrackSolo(track: TrackKey, solo: boolean): void {
    this.state = {
      ...this.state,
      tracks: this.state.tracks.map(t => t.key === track ? { ...t, solo } : t),
    };
    this.emit();
  }

  setTrackVolume(track: TrackKey, volume: number): void {
    this.pushDrumHistory('drum-vol-' + track); // coalesce a fader drag into one undo
    const v = Math.max(0, Math.min(1, volume));
    this.state = {
      ...this.state,
      tracks: this.state.tracks.map(t => t.key === track ? { ...t, volume: v } : t),
    };
    this.emit();
  }

  cycleTrackSample(track: TrackKey, direction: 1 | -1): void {
    const list = this.kitList(track);
    const t = this.state.tracks.find(x => x.key === track)!;
    this.pushDrumHistory();
    const next = (t.sampleIndex + direction + list.length) % list.length;
    this.state = {
      ...this.state,
      tracks: this.state.tracks.map(x => x.key === track ? { ...x, sampleIndex: next, userPath: undefined, userName: undefined, userMissing: undefined } : x),
    };
    // Preload the new sample so the next hit lands without a buffering pop.
    void this.loadSample(track, next);
    this.emit();
  }

  /** Jump to a random (different) sample for a track. */
  randomizeSample(track: TrackKey): void {
    const list = this.kitList(track);
    if (!list || list.length <= 1) return;
    this.pushDrumHistory();
    const cur = this.state.tracks.find(x => x.key === track)!.sampleIndex;
    let next = cur;
    while (next === cur) next = Math.floor(Math.random() * list.length);
    this.state = {
      ...this.state,
      tracks: this.state.tracks.map(x => x.key === track ? { ...x, sampleIndex: next, userPath: undefined, userName: undefined, userMissing: undefined } : x),
    };
    void this.loadSample(track, next);
    this.emit();
  }

  /** Re-roll every track to a random (different) sample at once — a whole new kit.
   *  The pattern is untouched (Phase 2B "RANDOMIZE ALL"). */
  randomizeAllSamples(): void {
    this.pushDrumHistory();
    const tracks = this.state.tracks.map(t => {
      const list = this.kitList(t.key);
      if (!list || list.length <= 1) return t;
      let next = t.sampleIndex;
      while (next === t.sampleIndex) next = Math.floor(Math.random() * list.length);
      void this.loadSample(t.key, next);
      return { ...t, sampleIndex: next, userPath: undefined, userName: undefined, userMissing: undefined };
    });
    this.state = { ...this.state, tracks };
    this.emit();
  }

  /** Empty the active sequence's grid in place (stays on the same Seq). Used as
   *  the primitive by clearSequence()/deleteSequence() and by external resets. */
  clear(): void {
    this.pushDrumHistory();
    const len = this.state.bars * this.spb();
    this.writePattern(makeEmptyPattern(len));
    // CLEAR clears the bar graphs too — a free-grid take's SHIFT / a pan / a
    // velocity dip must not haunt the steps of the next take (his report: SHIFT
    // showing up on an on-grid recording was the last take's leftovers).
    const keys = this.state.tracks.map(t => t.key);
    this.state = {
      ...this.state,
      stepVelocity: makeStepGraph(GRAPH_DEFAULTS.VELOCITY, keys),
      stepShift: makeStepGraph(GRAPH_DEFAULTS.SHIFT, keys),
      stepPan: makeStepGraph(GRAPH_DEFAULTS.PAN, keys),
      stepRepeat: makeStepGraph(GRAPH_DEFAULTS.REPEAT, keys),
    };
    this.emit();
  }

  // ── Sequence management ───────────────────────────────────────────────

  /** DUPLICATE: append a deep copy of the active sequence right after it and
   *  switch to the copy (so you can tweak a variation without losing the take). */
  duplicateSequence(): void {
    this.pushDrumHistory();
    const copy = clonePattern(this.state.pattern);
    const sequences = this.state.sequences.slice();
    const at = this.state.seqIndex + 1;
    sequences.splice(at, 0, copy);
    this.state = { ...this.state, sequences, seqIndex: at, pattern: copy };
    this.emit();
  }

  /** NEW: append an EMPTY sequence (same bars) right after the active one and
   *  switch to it — the SeqPager's "+", next to DUPLICATE. */
  addSequence(): void {
    this.pushDrumHistory();
    const empty = makeEmptyPattern(this.state.bars * this.spb());
    const sequences = this.state.sequences.slice();
    const at = this.state.seqIndex + 1;
    sequences.splice(at, 0, empty);
    this.state = { ...this.state, sequences, seqIndex: at, pattern: empty };
    this.emit();
  }

  /** Switch the active sequence by index (clamped to the list). */
  selectSequence(i: number): void {
    const idx = Math.max(0, Math.min(this.state.sequences.length - 1, Math.floor(i)));
    if (idx === this.state.seqIndex) return;
    this.state = { ...this.state, seqIndex: idx, pattern: this.state.sequences[idx] };
    this.emit();
  }
  nextSequence(): void { this.selectSequence(this.state.seqIndex + 1); }
  prevSequence(): void { this.selectSequence(this.state.seqIndex - 1); }

  /** CLEAR (double tap): delete the active sequence entirely and land on the
   *  previous one. Never drops below one sequence — on the last one it just
   *  empties it. */
  deleteSequence(): void {
    if (this.state.sequences.length <= 1) { this.clear(); return; } // clear() pushes its own history
    this.pushDrumHistory();
    const sequences = this.state.sequences.slice();
    sequences.splice(this.state.seqIndex, 1);
    const seqIndex = Math.max(0, this.state.seqIndex - 1);
    this.state = { ...this.state, sequences, seqIndex, pattern: sequences[seqIndex] };
    this.emit();
  }

  /** Replace the whole pattern at once — used by the AI Arranger to load a
   *  section's drum variation. Only the tracks present in `pattern` keep hits;
   *  the rest are cleared. Each row is fit (padded/truncated) to `bars` length. */
  /** Fit a (possibly partial) pattern to `bars` × 16 steps, padding/truncating
   *  each row. Shared by setPattern and the arranged-playback scheduler. */
  private fitPattern(pattern: Partial<Record<TrackKey, boolean[]>>, bars: number): Pattern {
    const len = bars * this.spb();
    const fit = (row?: boolean[]): boolean[] => {
      const out = new Array<boolean>(len).fill(false);
      if (row) for (let i = 0; i < len; i++) out[i] = !!row[i];
      return out;
    };
    // Every lane that EXISTS must get a row — a hardcoded five dropped an added
    // lane's row entirely, and both the scheduler (pattern[t.key][stepIdx]) and
    // DrumRow (row[base]) index it without a guard, so a generate/arranger write
    // took the whole view down with it. Same reasoning as clonePattern.
    const out: Pattern = {};
    for (const t of this.state.tracks) out[t.key] = fit(pattern[t.key]);
    return out;
  }

  /** Spread a generator's 16th-note row onto the internal grid: step i lands on
   *  internal step i·(INTERNAL_SPB/GEN_SPB). Without this a generated bar is
   *  stored at 32nd spacing and plays twice as fast as it reads. */
  private upscaleFromGen(
    p: Partial<Record<TrackKey, boolean[]>>,
  ): Partial<Record<TrackKey, boolean[]>> {
    const stride = INTERNAL_SPB / GEN_SPB;
    const out: Partial<Record<TrackKey, boolean[]>> = {};
    for (const k of Object.keys(p) as TrackKey[]) {
      const row = p[k];
      if (!row) continue;
      const dst = new Array<boolean>(row.length * stride).fill(false);
      for (let i = 0; i < row.length; i++) if (row[i]) dst[i * stride] = true;
      out[k] = dst;
    }
    return out;
  }

  setPattern(pattern: Partial<Record<TrackKey, boolean[]>>, bars?: number, recordHistory = true): void {
    // recordHistory=false when an outer composite already snapshotted (generate).
    if (recordHistory) this.pushDrumHistory();
    const b = Math.max(1, Math.min(4, Math.floor(bars ?? this.state.bars)));
    const next = this.fitPattern(pattern, b);
    const sequences = this.state.sequences.slice();
    sequences[this.state.seqIndex] = next;
    this.state = { ...this.state, bars: b, pattern: next, sequences };
    this.emit();
  }

  /** Queue a pattern swap for arranged playback: any step whose play time is
   *  >= `at` (ctx seconds) uses this pattern. Fitted to the current loop length
   *  (state.bars) so step indexing is unchanged. Replaces an existing swap at the
   *  same time so a live re-edit of a section just overwrites it. The pattern is
   *  resolved per step by the scheduler — see patternFor / the field comment. */
  schedulePattern(pattern: Partial<Record<TrackKey, boolean[]>>, at: number): void {
    const next = this.fitPattern(pattern, this.state.bars);
    this.pendingPatterns = this.pendingPatterns.filter(p => Math.abs(p.at - at) > 1e-4);
    this.pendingPatterns.push({ at, pattern: next });
    this.pendingPatterns.sort((a, b) => a.at - b.at);
    this.drumSink?.schedulePattern(next, at);
  }

  /** Drop the whole arranged-playback timeline (call before re-scheduling, and
   *  on stop). With it empty the scheduler falls back to this.state.pattern. */
  clearScheduledPatterns(): void { this.pendingPatterns = []; this.drumSink?.clearScheduledPatterns(); }

  /** The pattern active at ctx time `when`: the last scheduled swap at/<= when,
   *  or the live state pattern when nothing is scheduled (standalone play). */
  private patternFor(when: number): Pattern {
    let pat = this.state.pattern;
    for (const p of this.pendingPatterns) {
      if (p.at <= when) pat = p.pattern; else break;
    }
    return pat;
  }

  /** One-tap pattern generation per genre, matching Drum Dojo: Boom Bap pulls a
   *  real MIDI file via the shared /api/midi-files endpoint (8th-hat files first)
   *  and parses it to steps; Trap uses the built-in TRAP_PATTERNS bank. Boom Bap
   *  falls back to the built-in bank when offline (e.g. dev tunnel). */
  async generate(genre: Genre = this.state.genre): Promise<void> {
    // One snapshot for the whole generate (one undo reverts it); the inner
    // setPattern/generateBuiltIn writes suppress their own pushes.
    this.pushDrumHistory();
    // Ask the generators for a 16th-note grid (the only resolution they speak)
    // and spread it onto the internal grid before storing — see GEN_SPB.
    const total = this.state.bars * GEN_SPB;
    if (genre === 'trap') {
      this.setPattern(this.upscaleFromGen(generateTrap(total)), this.state.bars, false);
      return;
    }
    // West Coast rides the boom-bap grooves (same swung 16ths, live-kit feel).
    const midi = await generateBoomBapFromMidi(total);
    if (midi) { this.setPattern(this.upscaleFromGen(midi), this.state.bars, false); return; }
    this.generateBuiltIn();
  }

  /** Built-in boom-bap fallback (no network). Picks one template per track from
   *  a small canonical bank and tiles it to the current bar length. */
  private generateBuiltIn(): void {
    const len = this.state.bars * this.spb();
    const pick = <T,>(arr: T[]): T => arr[Math.floor(Math.random() * arr.length)];
    // Each template is 16 steps. We tile to fill `len`.
    const KICKS = [
      [1,0,0,0,0,0,1,0,0,0,1,0,0,0,0,0],
      [1,0,0,0,1,0,0,0,1,0,0,0,1,0,0,0],
      [1,0,0,1,0,0,0,0,1,0,0,0,0,0,1,0],
      [1,0,0,0,0,0,0,0,1,0,0,1,0,0,0,0],
    ];
    const SNARES = [
      [0,0,0,0,1,0,0,0,0,0,0,0,1,0,0,0],
      [0,0,0,0,1,0,0,0,0,0,0,0,1,0,0,1],
      [0,0,0,0,1,0,0,1,0,0,0,0,1,0,0,0],
    ];
    const HATS = [
      [1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0],
      [1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1],
      [1,0,1,1,1,0,1,0,1,1,0,1,1,0,1,0],
    ];
    const OPENHATS = [
      [0,0,0,0,0,0,0,1,0,0,0,0,0,0,0,1],
      [0,0,0,0,0,0,1,0,0,0,0,0,0,0,1,0],
      [0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],
    ];
    const PERCS = [
      [0,0,1,0,0,1,0,0,0,0,1,0,0,0,0,1],
      [0,0,0,1,0,0,1,0,0,0,0,1,0,0,0,0],
      [0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],
    ];
    // Templates are 16 steps of a 16th-note bar; place each on its internal step
    // rather than filling consecutive internal slots (which halved the bar).
    const stride = INTERNAL_SPB / GEN_SPB;
    const tile = (tmpl: number[]): boolean[] => {
      const out = new Array<boolean>(len).fill(false);
      for (let i = 0; i < len / stride; i++) if (tmpl[i % 16] === 1) out[i * stride] = true;
      return out;
    };
    this.writePattern({
      kick: tile(pick(KICKS)),
      snare: tile(pick(SNARES)),
      hihat: tile(pick(HATS)),
      openhat: tile(pick(OPENHATS)),
      perc: tile(pick(PERCS)),
    });
  }

  // ── Transport ─────────────────────────────────────────────────────────
  /** Start the loop at `atTime` (ctx seconds). `stepOffset` begins the loop phase
   *  partway in — used to seek arranged playback so the drum loop lands on the
   *  right step at the seek point (Phase 3A.6). playStartTime is back-dated so
   *  getStep stays accurate. */
  /** NATIVE TRANSPORT (Terminator 3.0, Phase 3.2): shift the running grid by `deltaSec` (+ = later). The chop
   *  sequencer runs on the native engine's clock; the shadow measures its drift against this context and nudges the
   *  satellites so the drums stay phase-locked WITHOUT a restart — already-booked hits keep their times, the next
   *  bookings land on the corrected grid. No-op when stopped. */
  nudge(deltaSec: number): void {
    if (this.drumSink) return; // NATIVE: the drums run on the engine's own clock — nothing to nudge
    if (!this.state.playing || !Number.isFinite(deltaSec) || deltaSec === 0) return;
    this.nextStepTime += deltaSec;
    this.playStartTime += deltaSec;
  }

  async start(atTime?: number, stepOffset = 0): Promise<void> {
    if (this.state.playing) return;
    // Claim the transport SYNCHRONOUSLY, before the async resume below. The
    // unified PLAY both fires the phase-lock seqStartHook (→ start) AND calls
    // start() itself; if the ctx is suspended (e.g. a returning user whose
    // session auto-restored a buffer, first gesture = PLAY) both would await
    // ctx.resume() and then each spin up a scheduler. Claiming `playing` here
    // makes the second call a true no-op (the guard above), so there is exactly
    // one drum scheduler. Rolled back if resume rejects.
    this.state = { ...this.state, playing: true };
    if (this.ctx.state !== 'running') {
      try { await this.ctx.resume(); }
      catch { this.state = { ...this.state, playing: false }; this.emit(); return; }
      // A stop()/toggle() can land while we were parked on the resume await
      // (its timer was still null so it cleared nothing, just set playing=false).
      // Honour it instead of re-arming the scheduler the user just stopped.
      if (!this.state.playing) return;
    }
    // Pre-warm every lane's buffer (cached → instant). A hit whose buffer is
    // not decoded yet still plays — as soon as it lands (emitVoice via the
    // async path), never silently dropped — but warm caches mean the first bar
    // lands ON the anchor.
    void this.preload();
    const total = this.state.bars * this.spb();
    const stepDur = this.stepDurSec();
    // Standalone start (the DRUMS section's own ▶): 20 ms lead, like the
    // unified PLAY — scheduleAhead() runs synchronously right below.
    this.nextStepTime = atTime ?? (this.ctx.currentTime + (this.drumSink?.leadSec?.() ?? 0.02));
    this.nextStepIdx = stepOffset;
    this.playStartTime = this.nextStepTime - stepOffset * stepDur;
    this.state = { ...this.state, playing: true, step: ((stepOffset % total) + total) % total };
    this.emit();
    // Count-in hits: anything within half a grid step before the downbeat is
    // the downbeat (see recordLiveHit); earlier ones were practice.
    if (this.earlyHits.length) {
      const window = stepDur * this.viewStride() / 2;
      const late = this.earlyHits.filter(h => h.at >= this.playStartTime - window);
      this.earlyHits = [];
      for (const h of late) this.recordLiveHitAt(h.trackIndex, Math.max(h.at, this.playStartTime));
    }
    // NATIVE: the C++ DrumSequencer runs from this anchor (the shadow maps it to an engine sample) — no TS voices;
    // the 25 ms tick below still flushes live-recorded hits to the UI
    this.drumSink?.play(this.nextStepTime, stepOffset);
    this.scheduleAhead();
    // Tick at ~25 ms to keep the scheduling window full; cheaper than rAF.
    this.look.reset(); this.timer = startClock(() => { this.look.beat(); this.scheduleAhead(); }, 25);
  }

  /** `keepRec` = this stop is a transport RESTART (the chop sequencer's
   *  playSeq stops-then-starts its satellites): REC / STEP stay armed so a take
   *  armed before a count-in is still recording when the downbeat lands. A
   *  real STOP (no flag) disarms both, as before. */
  stop(opts?: { keepRec?: boolean }): void {
    if (this.timer) { this.timer.stop(); this.timer = null; }
    this.drumSink?.stop(); // NATIVE: stop scheduling + fade every lane voice (4 ms) in the engine
    this.flushSequence(); // commit any live-recorded hits not yet flushed to the UI
    this.pendingPatterns = []; // drop any arranged-playback timeline (Phase 3A.5)
    // Cut every in-flight voice the way a retrigger does (4 ms linear — the
    // pads' STOP does the same), then free the sources. This is the ONE place
    // a registered voice's source is stop()ped (chokes are gain-only), so the
    // call is always its first. A voice booked in the future stops before it
    // starts = never sounds, which is what STOP means.
    const t = this.ctx.currentTime;
    for (const key of Object.keys(this.laneVoices) as TrackKey[]) {
      for (const v of this.laneVoices[key] ?? []) {
        if (v.ended) continue;
        this.chokeVoice(v, t);
        try { v.src.stop(t + DRUM_CHOKE_S + 0.002); } catch { /* already stopped */ }
      }
    }
    this.laneVoices = {};
    this.lastLiveHit = {};
    this.chokePreview(t);
    // Disarm both record modes when the transport stops (flushSequence is
    // audio-thread only and must not touch them) — unless this is a restart.
    if (!opts?.keepRec) this.earlyHits = [];
    this.state = opts?.keepRec
      ? { ...this.state, playing: false, step: -1 }
      : { ...this.state, playing: false, step: -1, stepRecording: false, liveRecording: false, drumRecordStep: 0 };
    this.emit();
  }

  toggle(): void { this.state.playing ? this.stop() : void this.start(); }

  /** Tear down: stop the transport, free the cached buffers, and remove the
   *  page-lifecycle listener so the engine can be discarded without leaking. */
  dispose(): void {
    this.stop();
    this.buffers.clear();
    if (typeof document !== 'undefined' && this.onVisibility) {
      document.removeEventListener('visibilitychange', this.onVisibility);
    }
    if (this.onCtxState) {
      this.ctx.removeEventListener('statechange', this.onCtxState);
    }
    this.onVisibility = undefined;
    this.onCtxState = undefined;
  }

  // ── Scheduling + playback ─────────────────────────────────────────────
  private scheduleAhead(): void {
    if (this.ctx.state !== 'running') return; // never schedule onto a suspended/interrupted ctx (iOS)
    if (!this.state.playing) return;
    const horizon = this.ctx.currentTime + this.look.horizon(); // 0.25 s, 0.5 s after a late tick
    const stepDur = this.stepDurSec(); // 16ths per beat / 4 = 16th note duration
    const totalSteps = this.state.bars * this.spb();

    // Fell behind by more than a step (a long stall, a laptop lid, a parked
    // clock)? Jump the grid forward to the step due now — every missed step
    // used to be booked at a past time and fire AT ONCE (the fast-forward
    // burst, audit #14). The phase stays true: the jump is whole steps from
    // the same anchor (playStartTime / getStep are untouched), so the loop
    // comes back in step with the chop transport, not ahead or behind it.
    if (!this.drumSink) { // NATIVE: the engine schedules every step itself — nothing is booked here
      const now = this.ctx.currentTime;
      if (stepDur > 0 && now - this.nextStepTime > stepDur) {
        const missed = Math.floor((now - this.nextStepTime) / stepDur);
        this.nextStepTime += missed * stepDur;
        this.nextStepIdx += missed;
      }

      while (this.nextStepTime < horizon) {
        const stepIdx = this.nextStepIdx % totalSteps;
        this.scheduleStep(stepIdx, this.nextStepTime);
        this.nextStepTime += stepDur;
        this.nextStepIdx++;
      }
    }

    // Flush live-recorded hits to the UI at most ~10 fps (SEQ_FLUSH_SEC) so the
    // step grid lights up smoothly without re-rendering React on every hit.
    if (this._sequenceDirty && this.ctx.currentTime - this._lastSeqFlush >= DrumEngine.SEQ_FLUSH_SEC) {
      this.flushSequence();
    }

    // Playhead is read from getStep() by the UI's rAF — intentionally NO
    // per-step state emit here (that would re-render React on the audio path).
  }

  /** 16T swing + 96-PPQ snap offset (seconds) for one step. Pushes the off-beat
   *  16ths — odd 0-indexed steps (1,3,5…) — later by `drumSwing · stepDur/2`
   *  (0 = straight, 1 = full triplet feel), then blends in a 96-PPQ quantize that
   *  crossfades from 0 % (straight) to 100 % (snapped) as the amount rises. Even
   *  steps (downbeats) are never shifted → return 0. Applied to the hit's PLAY
   *  time only; the look-ahead grid (`nextStepTime`) stays straight, so swing can
   *  never accumulate drift. Note totalSteps is a multiple of 16, so `stepIdx`
   *  parity matches the absolute step parity. */
  private swingOffset(stepIdx: number): number {
    // Delegates to the shared pure helper so the offline exporters bake the
    // EXACT same groove this scheduler plays (see drumSwingOffsetSec).
    //
    // That helper is indexed in 16THS — both which steps move (odd ones) and how
    // far (half a 16th). `stepIdx` is an INTERNAL 1/32 index, so passing it raw
    // swung every other 32nd by a whole 32nd: the wrong notes, twice as far.
    // Convert to the 16th slot the step sits in; a 32nd between two 16ths moves
    // with the slot that contains it, so ghost notes stay glued to their beat.
    return drumSwingOffsetSec(
      Math.floor(stepIdx / (INTERNAL_SPB / STEPS_PER_BAR)),
      this.getBpm(),
      this.state.drumSwing,
    );
  }

  private scheduleStep(stepIdx: number, when: number): void {
    // Resolve the pattern active at this step's PLAY time (Phase 3A.5) — for
    // arranged playback this picks the right section even though we're scheduling
    // ~100 ms ahead, and it reflects live edits on the very next scheduled step.
    // Mute/solo/volume are read here too (look-ahead), so they're already live.
    // Pattern resolution uses the STRAIGHT grid time; only the audio hit is swung.
    const bpm = this.getBpm();
    const stepDur = this.stepDurSec();
    // A stall longer than the look-ahead leaves this step entirely in the
    // past. Drop it instead of clamp-firing it "now" — a burst of catch-up
    // hits after a freeze is worse than the silence (mirrors the chop seq's
    // late-step rule). A step only slightly late still fires via the clamp.
    if (this.ctx.currentTime - when >= stepDur - 0.005) return;
    // Resolve HALF A STEP late. `when` is the look-ahead grid, accumulated by
    // hundreds of `+= stepDur` additions; a section swap's `at` is computed
    // directly (anchor + bars × barDur). At a section boundary the two can
    // disagree by ~1e-13 either way, and `at <= when` then picked the PREVIOUS
    // pattern for the boundary step — a drum-less intro's silence swallowed the
    // first kick of the drop (measured: ~1 in 3 plays, depending on bpm and the
    // anchor time). Swaps always sit on step boundaries, so a half-step
    // tolerance is exact: it can never reach the next step's swap.
    const pattern = this.patternFor(when + stepDur * 0.5);
    // 16T swing nudges the off-beat 16ths late (downbeats unchanged).
    const baseTime = when + this.swingOffset(stepIdx);
    // Next step's STRAIGHT grid time bounds this step's note-repeat roll. The grid
    // (this.nextStepTime) is straight in Terminator (swing only moves the hit), so
    // a roll fills this step's slot regardless of swing — no drift.
    const nextStepTime = when + stepDur;
    // Solo wins over mute: if any track is soloed, only soloed tracks sound.
    const anySolo = this.state.tracks.some(t => t.solo);
    for (const t of this.state.tracks) {
      if (anySolo ? !t.solo : t.muted) continue;
      if (t.volume <= 0) continue;
      if (!pattern[t.key]?.[stepIdx]) continue; // a lane with no row in this pattern is silent, never a throw
      // One owner per hit: a hand-played hit on this track at ~this step's
      // time already IS this step (live-record wrote it) — skip the copy.
      const live = this.lastLiveHit[t.key];
      if (live !== undefined && Math.abs(when - live) < DrumEngine.LIVE_OWNER_WINDOW) continue;
      // Per-step graph (ported verbatim from Drum Dojo's scheduler):
      //  - SHIFT is the single timing offset (ms), on top of the swung base time;
      //  - VELOCITY multiplies the track volume;
      //  - PAN positions the voice;
      //  - REPEAT subdivides the step into a note-repeat roll.
      // SHIFT is quantized to the current PPQ grid: 960 PPQ is near-continuous
      // (sub-ms pulses), 96 PPQ snaps the micro-timing to a coarser FL-style grid.
      const shiftMs = this.state.stepShift[t.key]?.[stepIdx] ?? 0;
      const pulseSec = bpm > 0 ? (60 / bpm) / this.state.ppq : 0;
      let shiftSec = shiftMs / 1000;
      if (pulseSec > 0) shiftSec = Math.round(shiftSec / pulseSec) * pulseSec;
      const shiftedTime = Math.max(this.ctx.currentTime + 0.001, baseTime + shiftSec);
      const stepVel = this.state.stepVelocity[t.key]?.[stepIdx] ?? 1;
      const vol = t.volume * stepVel;
      if (vol <= 0) continue;
      const pan = this.state.stepPan[t.key]?.[stepIdx] ?? 0;

      const rate = REPEAT_RATES[this.state.stepRepeat[t.key]?.[stepIdx] ?? 0];
      const interval = rate && rate.beats > 0 ? rate.beats * (60 / bpm) : 0;
      const times: number[] = [];
      if (interval > 0.001) {
        for (let tt = shiftedTime; tt < nextStepTime - 0.001; tt += interval) times.push(tt);
      }
      if (times.length < 2) {
        // No real subdivision (repeat off, rate >= step, or a heavy shift pushed the
        // step past the boundary) — fire one normal full-length voice.
        void this.playHit(t.key, t.sampleIndex, vol, shiftedTime, pan);
      } else {
        // Each sub-hit self-chokes into the next (the last into the step boundary),
        // bypassing the live retrigger registry so a tight roll stays audible.
        for (let i = 0; i < times.length; i++) {
          void this.playHit(t.key, t.sampleIndex, vol, times[i], pan, i + 1 < times.length ? times[i + 1] : nextStepTime);
        }
      }
    }
  }

  /** Pre-warm every current track's sample buffer so a freshly-started
   *  transport's first hits land exactly on the anchor instead of fading in
   *  while their fetch+decode completes (Phase 3A.4 — first-section fade-in
   *  fix). Idempotent: cached buffers resolve instantly. */
  async preload(): Promise<void> {
    await Promise.all(
      this.state.tracks.map(t => this.loadSample(t.key, t.sampleIndex)),
    );
  }

  /** Phase 4A — resolve each track for offline export: its current sample buffer
   *  (loaded on demand), its volume, and whether it's audible under the current
   *  mute/solo state. Used by the Beat Finisher arrangement exporter. */
  async getExportTracks(): Promise<Array<{ key: TrackKey; buffer: AudioBuffer | null; volume: number; audible: boolean }>> {
    const anySolo = this.state.tracks.some(t => t.solo);
    const out: Array<{ key: TrackKey; buffer: AudioBuffer | null; volume: number; audible: boolean }> = [];
    for (const t of this.state.tracks) {
      const audible = anySolo ? !!t.solo : !t.muted;
      const buffer = await this.loadSample(t.key, t.sampleIndex);
      out.push({ key: t.key, buffer, volume: t.volume, audible });
    }
    return out;
  }

  /** Fetch + decode a drum sample by URL, with an in-flight + decoded cache so a
   *  given file is only ever loaded once. Shared by per-track loading and the
   *  browser's cross-kit previews. */
  private async loadUrl(url: string): Promise<AudioBuffer | null> {
    const cached = this.buffers.get(url);
    if (cached) return cached;
    if (this.loading.has(url)) {
      // Wait briefly — somebody else is loading the same buffer.
      while (this.loading.has(url)) await new Promise(r => setTimeout(r, 20));
      return this.buffers.get(url) ?? null;
    }
    this.loading.add(url);
    try {
      // A library sample (any of its URLs) resolves to its full candidate list —
      // the copy inside the desktop app, then lossless R2, then the mp3 — so a
      // sample with no WAV original, a missing local file or a half-finished
      // upload still plays instead of silently dropping out of the kit. Anything
      // else (a user's own drum file) is fetched as given.
      const id = drumIdFromUrl(url);
      const candidates = id ? drumSampleUrls(id) : [url];
      let ab: ArrayBuffer | null = null;
      let lastErr: unknown = null;
      for (const c of candidates) {
        try {
          const res = await fetch(c);
          if (!res.ok) { lastErr = new Error(`drum sample: ${res.status}`); continue; }
          ab = await res.arrayBuffer();
          break;
        } catch (e) { lastErr = e; }
      }
      if (!ab) throw lastErr ?? new Error('drum sample: unreachable');
      const buf = await this.ctx.decodeAudioData(ab);
      ceilPeak(buf);     // hot MP3 decodes (most kicks) → −0.2 dBFS, never boosted
      declickHead(buf);
      declickTail(buf);
      this.buffers.set(url, buf);
      return buf;
    } catch (e) {
      console.warn('[drums] sample load failed:', e);
      return null;
    } finally {
      this.loading.delete(url);
    }
  }

  private async loadSample(track: TrackKey, sampleIndex: number): Promise<AudioBuffer | null> {
    const t = this.state.tracks.find(x => x.key === track);
    if (t?.userPath) {
      // MY DRUMS: the user's own file. A file that won't load marks the lane
      // MISSING (visible in the row) — it is never silently replaced.
      const buf = await this.loadUrl(userSampleUrl(t.userPath));
      const missing = !buf;
      if (!!t.userMissing !== missing) {
        this.state = { ...this.state, tracks: this.state.tracks.map(x => x.key === track && x.userPath === t.userPath ? { ...x, userMissing: missing || undefined } : x) };
        this.emit();
      }
      if (buf) this.fireBufferReady(track);
      return buf;
    }
    const genre = this.genreOf(track);
    const file = (KITS[genre]?.[this.slotOf(track)] ?? [])[sampleIndex];
    if (!file) return null;
    const out = await this.loadUrl(drumR2Url(file));
    if (out) this.fireBufferReady(track);
    return out;
  }
  /** MY DRUMS — LOAD the user's own file onto a lane. The kit sample stays
   *  underneath as the fallback an older build / the web app plays. */
  setTrackUserSample(track: TrackKey, rel: string, name: string): void {
    if (!this.state.tracks.some(x => x.key === track)) return;
    if (!this.browseSessionActive) this.pushDrumHistory();
    this.state = {
      ...this.state,
      tracks: this.state.tracks.map(x => x.key === track ? { ...x, userPath: rel, userName: name, userMissing: undefined } : x),
    };
    void this.loadSample(track, this.state.tracks.find(x => x.key === track)!.sampleIndex);
    this.emit();
  }
  /** MY DRUMS — audition a user file through a lane's output (browser PREVIEW). */
  async previewUserSample(track: TrackKey, rel: string): Promise<void> {
    const buf = await this.loadUrl(userSampleUrl(rel));
    if (!buf) return;
    this.playPreviewBuffer(track, buf);
  }
  /** MY DRUMS — ADD NEW: a lane of its own for a user file (borrows `slot` for
   *  the kit fallback + alias tables, sample 0 of the current kit underneath). */
  addTrackFromUserSample(slot: TrackKey, rel: string, name: string): TrackKey {
    const key = this.addTrack(name, slot, 0);
    this.state = {
      ...this.state,
      tracks: this.state.tracks.map(x => x.key === key ? { ...x, userPath: rel, userName: name } : x),
    };
    void this.loadSample(key, 0);
    this.emit();
    return key;
  }

  /** The URL a lane's current sample lives at (what loadSample fetches). */
  private sampleUrlFor(track: TrackKey, sampleIndex: number): string | null {
    const t = this.state.tracks.find(x => x.key === track);
    if (t?.userPath) return userSampleUrl(t.userPath);
    const file = (KITS[this.genreOf(track)]?.[this.slotOf(track)] ?? [])[sampleIndex];
    return file ? drumR2Url(file) : null;
  }
  /** The decoded buffer if it is already in the cache — synchronous, so a hit
   *  whose sample is warm goes from "decide" to "sound" in one call stack. */
  private cachedBuffer(track: TrackKey, sampleIndex: number): AudioBuffer | null {
    const url = this.sampleUrlFor(track, sampleIndex);
    return url ? (this.buffers.get(url) ?? null) : null;
  }

  /** Play one hit at `when`. `pan` (-1..1) inserts a StereoPannerNode when non-zero.
   *  When `chokeAt` is given the hit is a SCHEDULED note-repeat sub-hit: it is
   *  self-contained (not in the lane's voice list) and self-chokes into `chokeAt`.
   *
   *  Warm buffer → emitVoice right now, synchronously (the common case: the
   *  scheduler and the hand both hit warm lanes). Cold buffer → fetch, then play
   *  the moment it lands — at `when` if that is still ahead, else now; a hit is
   *  never dropped for being cold, and the registry is only ever touched from
   *  emitVoice, so two cold hits resolving out of order cannot cross wires. */
  private playHit(track: TrackKey, sampleIndex: number, volume: number, when: number, pan = 0, chokeAt?: number): Promise<void> {
    if (this.drumSink) {
      // NATIVE: the hit plays on the C++ lane (sub-hits never reach here — the TS scheduler is off); keep the decoded
      // buffer warm so the shadow can mirror the lane
      if (chokeAt === undefined) this.drumSink.hit(track, volume, when, pan);
      if (!this.cachedBuffer(track, sampleIndex)) void this.loadSample(track, sampleIndex);
      return Promise.resolve();
    }
    const warm = this.cachedBuffer(track, sampleIndex);
    if (warm) { this.emitVoice(track, warm, volume, when, pan, chokeAt); return Promise.resolve(); }
    return this.loadSample(track, sampleIndex).then(buf => {
      if (!buf) return;
      const at = Math.max(when, this.ctx.currentTime + 0.001);
      this.emitVoice(track, buf, volume, at, pan, chokeAt === undefined ? undefined : Math.max(chokeAt, at + DRUM_ATTACK_S + DRUM_CHOKE_S));
    });
  }

  /** Cut a voice at `at`: pin its gain at the level it has THEN (inside its
   *  attack → the interpolated value, so a double-trigger never steps UP first)
   *  and ramp linearly to 0 over DRUM_CHOKE_S. Gain-only on purpose: stop() may
   *  be called once per source and we may have to cut the same voice earlier
   *  again (a hit inserted between it and its booked cutter), so the source is
   *  left to end with its buffer and onended disconnects it. */
  private chokeVoice(v: LaneVoice, at: number): void {
    const level = v.attackS > 0 && at < v.startAt + v.attackS ? v.target * Math.max(0, (at - v.startAt) / v.attackS) : v.target;
    try {
      holdGainAt(v.g.gain, level, at);
      v.g.gain.linearRampToValueAtTime(0, at + DRUM_CHOKE_S);
    } catch { /* param already torn down */ }
    v.chokeAt = at;
  }

  /** Start one voice NOW (synchronous — the buffer is in hand). */
  private emitVoice(track: TrackKey, buf: AudioBuffer, volume: number, when: number, pan: number, chokeAt?: number): void {
    const tap = this.ensureTap(track);
    try {
      const src = this.ctx.createBufferSource();
      src.buffer = buf;
      const g = this.ctx.createGain();
      const target = Math.max(0.0001, volume);
      const head = drumHeadLevel(buf);
      const attackS = head < DRUM_HEAD_SILENCE ? 0 : DRUM_ATTACK_S;
      // Punch-preserving attack (applyDrumAttack): instant when the sample
      // starts at silence, else the 3 ms click guard — the SAME envelope for
      // the scheduler, a hand hit, a note-repeat sub-hit and the exports.
      applyDrumAttack(g.gain, when, volume, head);
      src.connect(g);
      let panNode: StereoPannerNode | null = null;
      if (pan !== 0 && typeof this.ctx.createStereoPanner === 'function') {
        panNode = this.ctx.createStereoPanner();
        panNode.pan.value = Math.max(-1, Math.min(1, pan));
        g.connect(panNode);
        panNode.connect(tap);
      } else {
        g.connect(tap);
      }
      const cleanup = () => { try { src.disconnect(); g.disconnect(); panNode?.disconnect(); } catch { /* */ } };
      if (chokeAt !== undefined) {
        // Note-repeat sub-hit: self-chokes into the next repeat / the step
        // boundary (never before its own attack has landed) and stops right after.
        const ch = Math.max(when + attackS + DRUM_CHOKE_S, chokeAt);
        g.gain.setValueAtTime(target, Math.max(when + attackS, ch - DRUM_CHOKE_S));
        g.gain.linearRampToValueAtTime(0, ch);
        src.onended = cleanup;
        src.start(when); // start() before stop(): an unstarted source throws on stop()
        try { src.stop(ch + 0.01); } catch { /* */ }
        return;
      }
      const list = (this.laneVoices[track] ??= []);
      // Drop what is gone: ended, or cut in the past.
      const now = this.ctx.currentTime;
      for (let i = list.length - 1; i >= 0; i--) {
        const v = list[i];
        if (v.ended || (v.chokeAt !== undefined && v.chokeAt + DRUM_CHOKE_S <= now)) list.splice(i, 1);
      }
      // Time order decides who cuts whom: every voice that started AT OR BEFORE
      // this hit is cut at this hit; a voice booked LATER is left alone and
      // will cut THIS voice when it lands.
      let endAt: number | undefined;
      for (const v of list) {
        if (v.startAt <= when) { if (v.chokeAt === undefined || v.chokeAt > when) this.chokeVoice(v, when); }
        else endAt = endAt === undefined ? v.startAt : Math.min(endAt, v.startAt);
      }
      // MUTE GROUPS (muteGroups.ts): lanes sharing a group cut each other by the
      // SAME time-order rule — a closed hat lands and the open hat stops, and an
      // open hat already BOOKED later will stop this one when it lands. The
      // scheduler books ahead, so both directions matter. Exports mirror this
      // via annotateGroupCuts + groupCutAt.
      const grp = this.muteGroupOf(track);
      if (grp) {
        for (const otherKey of Object.keys(this.laneVoices) as TrackKey[]) {
          if (otherKey === track || this.muteGroupOf(otherKey) !== grp) continue;
          for (const v of this.laneVoices[otherKey] ?? []) {
            if (v.ended) continue;
            if (v.startAt <= when) { if (v.chokeAt === undefined || v.chokeAt > when) this.chokeVoice(v, when); }
            else endAt = endAt === undefined ? v.startAt : Math.min(endAt, v.startAt);
          }
        }
      }
      const voice: LaneVoice = { src, g, pan: panNode, startAt: when, target, attackS, ended: false };
      src.onended = () => {
        voice.ended = true;
        cleanup();
        const l = this.laneVoices[track];
        if (l) { const k = l.indexOf(voice); if (k >= 0) l.splice(k, 1); }
      };
      src.start(when); // offset 0 — drums keep their transient front
      if (endAt !== undefined) this.chokeVoice(voice, endAt);
      list.push(voice);
    } catch {
      // createBufferSource()/start() throw if the context was suspended/interrupted
      // (iOS screen-lock, backgrounded tab) before the scheduler could be parked.
      // Swallow so a stray tick can't spam unhandled rejections; the visibility
      // handler resumes + restarts us.
      return;
    }
  }

  /** This lane's mute group (0/undefined = off). */
  muteGroupOf(track: TrackKey): number | undefined {
    return this.state.tracks.find(t => t.key === track)?.muteGroup || undefined;
  }
  /** Put a lane in a mute group (or `null` to take it out). Lanes sharing a
   *  group cut each other — live and in every export. */
  setTrackMuteGroup(track: TrackKey, group: number | null): void {
    const g = group && group > 0 ? Math.floor(group) : undefined;
    if (this.muteGroupOf(track) === g) return;
    this.pushDrumHistory();
    this.state = {
      ...this.state,
      tracks: this.state.tracks.map(t => (t.key === track ? { ...t, muteGroup: g } : t)),
    };
    this.emit();
  }
  /** Every lane's group, for the export builders (annotateGroupCuts). */
  muteGroupMap(): Record<TrackKey, number | undefined> {
    const out: Record<TrackKey, number | undefined> = {};
    for (const t of this.state.tracks) if (t.muteGroup) out[t.key] = t.muteGroup;
    return out;
  }

  // ── Phase 3.3: the native drum shadow's view of the lanes ─────────────────
  /** The decoded buffer a lane plays right now, if it is warm (the shadow mirrors it into the C++ Sampler). */
  cachedBufferFor(track: TrackKey): AudioBuffer | null {
    const t = this.state.tracks.find(x => x.key === track);
    return t ? this.cachedBuffer(track, t.sampleIndex) : null;
  }
  /** Load (or return) a lane's current buffer; onBufferReady fires when a lane's buffer lands. */
  ensureLoaded(track: TrackKey): Promise<AudioBuffer | null> {
    const t = this.state.tracks.find(x => x.key === track);
    return t ? this.loadSample(track, t.sampleIndex) : Promise.resolve(null);
  }
  /** Subscribe to "a lane's buffer is decoded" (loads are async and do not emit state). Returns the unsubscribe. */
  onBufferReady(fn: (track: TrackKey) => void): () => void {
    this.bufferReadyListeners.add(fn);
    return () => { this.bufferReadyListeners.delete(fn); };
  }
  private fireBufferReady(track: TrackKey): void {
    for (const fn of this.bufferReadyListeners) { try { fn(track); } catch { /* a bad listener must never break a load */ } }
  }
  /** Tests / the headless probe: put a buffer into a lane's cache as if it had been decoded (no network). */
  primeBuffer(track: TrackKey, buf: AudioBuffer): void {
    const t = this.state.tracks.find(x => x.key === track);
    const url = t ? this.sampleUrlFor(track, t.sampleIndex) : null;
    if (!url) return;
    this.buffers.set(url, buf);
    this.fireBufferReady(track);
  }
  /** The native position push (20 Hz): the ctx time the audible pass's step 0 is heard — the grid origin the
   *  live-record landing reads (the playhead reads the sink's elapsedSec directly). */
  nativeDrumUpdate(u: { playing: boolean; loopStartCtx: number }): void {
    if (!this.drumSink || !this.state.playing) return;
    if (Number.isFinite(u.loopStartCtx)) this.playStartTime = u.loopStartCtx;
  }

  // Trigger a single hit immediately (used for preview when user taps a
  // track header). Volume = 1 to make it audible.
  preview(track: TrackKey): void {
    const t = this.state.tracks.find(x => x.key === track);
    if (!t) return;
    void this.playHit(track, t.sampleIndex, 1, this.ctx.currentTime + 0.005);
  }

  /** LIVE mode (finger-drum / note-repeat): play a track's CURRENT sample now,
   *  routed through the exact same playHit path the sequencer + preview use so it
   *  sounds identical. This is the LOW-LATENCY path: the hit is scheduled at
   *  ctx.currentTime with NO look-ahead offset (play NOW — unlike the sequencer,
   *  which schedules ahead). `offsetSec` is an optional feel nudge (-0.05..+0.05,
   *  default 0 = none). `when` lets a caller pass a precomputed schedule time
   *  (e.g. MIDI timestamp compensation); it's clamped so it never lands in the
   *  past. The track's own volume is used (matching the sequencer), falling back
   *  to full gain when a track is at 0 so an explicit tap is never silent.
   *  Resumes a suspended AudioContext SYNCHRONOUSLY so the first hit isn't
   *  delayed by a cold context. */
  playLive(track: TrackKey, offsetSec = 0, when?: number): void {
    const t = this.state.tracks.find(x => x.key === track);
    if (!t) return;
    if (this.ctx.state !== 'running') void this.ctx.resume();
    const vol = t.volume > 0 ? t.volume : 1;
    const at = when !== undefined
      ? Math.max(this.ctx.currentTime, when)
      : this.ctx.currentTime + offsetSec;
    // One owner per hit: remember when this track was hand-played so the
    // scheduler can skip the pattern's copy of the SAME hit (a live-recorded
    // step) instead of double-firing and self-choking the hand voice short.
    this.lastLiveHit[track] = at;
    void this.playHit(track, t.sampleIndex, vol, at);
    // A human hit this pad — tell whoever cares (the bar-graph editor follows
    // it). AFTER the audio is scheduled, so a listener can never delay a hit.
    this.firePadHit(track);
  }

  // ── Hand-played hits ───────────────────────────────────────────────────────
  // Deliberately NOT part of the state emit. The emit is throttled precisely so
  // finger-drumming does not re-render the whole grid per hit (see the dirty/
  // flush note above), and folding a "last hit" field into it would undo that.
  // This channel is immediate and carries one track key.
  //
  // Only `playLive` fires it — the path every hand-played hit goes through, from
  // the pad grid, the computer keyboard and MIDI alike. The sequencer uses
  // `scheduleStep`, so a playing pattern never moves the editor under you.
  private padHitListeners = new Set<(t: TrackKey) => void>();

  /** Subscribe to hand-played hits. Returns an unsubscribe. */
  onPadHit(fn: (t: TrackKey) => void): () => void {
    this.padHitListeners.add(fn);
    return () => { this.padHitListeners.delete(fn); };
  }

  private firePadHit(track: TrackKey): void {
    for (const fn of this.padHitListeners) {
      try { fn(track); } catch { /* a bad listener must never break a drum hit */ }
    }
  }

  /** LIVE mode recording: when the sequencer is playing, stamp the 16th-note step
   *  nearest to `hitAudioContextTime` ON for the given track. Quantizes to the
   *  STRAIGHT grid (playStartTime is the ctx time step 0 was heard, stepDur is one
   *  16th) so the recorded step plays back with the scheduler's swing applied — no
   *  double-swing. Setting (not flipping) means repeated ticks landing on the same
   *  step are idempotent; an already-on step short-circuits to avoid React churn.
   *  No-op while stopped.
   *
   *  LIVE/COMMIT SPLIT (mirrors setStepGraphValueLive): the hit is written
   *  STRAIGHT into the internal pattern array with NO emit — the look-ahead
   *  scheduler reads this.state.pattern directly (patternFor), so it picks the
   *  hit up on its next 25 ms tick regardless of when React is told. Emitting
   *  per hit re-rendered the whole grid on the audio thread and starved the
   *  scheduler → the skips. We just mark the sequence dirty; scheduleAhead
   *  flushes ONE throttled emit (~10 fps) so the steps still light up. */
  /** Hits played while REC is armed but the transport has not started yet (the
   *  count-in): kept, and the ones within half a grid step of the downbeat land
   *  on step 1 when play starts — the first hit of a take is the one you play
   *  ON the one, and humans (and MIDI) land it a few ms early. */
  private earlyHits: Array<{ trackIndex: number; at: number }> = [];
  // ctx time each track was last HAND-played (playLive) — the scheduler skips
  // a pattern step firing within LIVE_OWNER_WINDOW of it: while live-recording,
  // the hand hit IS that step's audio, and firing the pattern's copy too
  // double-triggers and self-chokes the hand voice short (his 2026-08-20
  // "drums don't play all the way through while recording" report).
  private lastLiveHit: Partial<Record<TrackKey, number>> = {};
  private static readonly LIVE_OWNER_WINDOW = 0.12; // covers swing + SHIFT (±50ms) + quantize rounding

  /** Output latency: the gap between scheduling a sound and HEARING it. The
   *  player locks to what they hear, so a hit's musical time is its arrival
   *  time MINUS this — without it every recording lands late by the buffer. */
  private outLatSec(): number {
    const o = (this.ctx as AudioContext).outputLatency ?? 0;
    return o > 0 ? o : (0.02 + (this.ctx.baseLatency ?? 0));
  }

  /** THE hand-played LIVE entry (pad grid / computer keys / MIDI): plays the
   *  track AND records it with the timing rules in one place —
   *  · musical time = now − handler lag (eventTimestamp) − output latency:
   *    the moment the player MEANT, relative to what they were hearing.
   *  · LIVE-recording with the GRID ON (his ask 2026-08-20: "quantize what I
   *    hear coming out of the speakers"): the AUDIBLE hit snaps to the
   *    nearest grid line — a slightly-early hit is DELAYED onto the line, a
   *    late one sounds immediately (the past is gone) — and records exactly
   *    on that line, SHIFT zeroed. Grid OFF = plays now, records free
   *    (recordLiveHit bakes the residual into SHIFT). Not recording = plays.
   *  The audible line is the STRAIGHT grid; the scheduler swings recorded
   *  steps on the next pass, same as recordLiveHit's straight-write rule. */
  liveHit(trackIndex: number, eventTimestamp?: number): void {
    const track = this.state.tracks[trackIndex];
    if (!track) return;
    const now = this.ctx.currentTime;
    const lag = eventTimestamp !== undefined && eventTimestamp > 0
      ? Math.max(0, Math.min(0.05, (performance.now() - eventTimestamp) / 1000)) : 0;
    const quantizing = this.state.liveRecording && this.state.playing && !this.state.gridOff;
    const stepDur = this.stepDurSec();
    if (!quantizing || stepDur <= 0) {
      // Schedule as early as the input allows (never in the past) — the MIDI
      // path's old inline compensation, now shared by every input.
      this.playLive(track.key, 0, lag > 0 ? Math.max(now, now - lag + (this.ctx.baseLatency ?? 0)) : undefined);
      if (this.state.liveRecording) this.recordLiveHit(trackIndex, now - lag);
      return;
    }
    const intent = now - lag - this.outLatSec();
    // INPUT QUANTIZE strength (the fader next to SWING): the audible hit is
    // pulled toward its nearest grid line by the same fraction the write is —
    // 100 waits for the line, 0 sounds at the exact played time, between =
    // proportionally closer. A corrected time already behind us sounds now.
    const s = this.inputQuantizeStrength();
    const gridDur = stepDur * this.viewStride();
    const nearest = Math.round((intent - this.playStartTime) / gridDur); // grid-line index, unwrapped
    const lineT = this.playStartTime + nearest * gridDur;
    const r = this.recordLiveHitAt(trackIndex, intent); // the write shares the strength rule
    // The step was ALREADY in the pattern and its firing is booked (the
    // schedule cursor is past it): that copy sounds at ~our time — playing
    // ours too would double-trigger and self-choke it short. One owner per
    // hit; the not-yet-booked case is covered from the other side (playLive
    // stamps lastLiveHit → the scheduler skips its copy).
    // NATIVE: the engine fires the pattern's copy itself (one owner per hit, in RT code) — the hand copy is skipped
    const booked = !!r?.wasOn && (this.drumSink ? true : lineT <= this.nextStepTime);
    if (!booked) this.playLive(track.key, 0, Math.max(now, intent + s * (lineT - intent)));
  }

  recordLiveHit(trackIndex: number, hitAudioContextTime: number): void {
    if (!this.state.liveRecording) return;
    // The player was locked to what they HEARD — pull the hit back by the
    // output buffer so it lands where they meant it (see outLatSec). The
    // comp happens exactly ONCE, here; recordLiveHitAt takes musical time
    // (flushed early hits already carry it).
    this.recordLiveHitAt(trackIndex, hitAudioContextTime - this.outLatSec());
  }
  /** Returns the target internal step and whether it was ALREADY on (liveHit
   *  uses that to avoid double-firing a step the scheduler has booked). */
  private recordLiveHitAt(trackIndex: number, hitAudioContextTime: number): { step: number; wasOn: boolean } | null {
    if (!this.state.playing) {
      this.earlyHits.push({ trackIndex, at: hitAudioContextTime });
      if (this.earlyHits.length > 32) this.earlyHits.shift();
      return null;
    }
    const track = this.state.tracks[trackIndex];
    if (!track) return null;
    const stepDur = this.stepDurSec();
    if (stepDur <= 0) return null;
    const total = this.state.bars * this.spb();
    const elapsed = hitAudioContextTime - this.playStartTime;
    const stepsElapsed = elapsed / stepDur;            // fractional INTERNAL steps since play start
    // Quantize to the VIEW division, not the storage resolution: the grid button
    // is what the user thinks of as "quantize". Snap in view units, then scale
    // back up to an internal index (stride is exact — every division divides 32).
    const stride = this.viewStride();
    const nearestView = Math.round(stepsElapsed / stride) * stride;
    // GRID OFF = freeform: the hit sits on its nearest DISPLAY step with the
    // full residual in SHIFT (exact timing on playback). GRID ON: INPUT
    // QUANTIZE strength (the fader next to SWING, 0..100) pulls the hit
    // toward its grid line — 100 lands ON the line (SHIFT 0), 0 keeps the
    // exact timing, between = proportionally closer. The corrected time
    // snaps to the nearest INTERNAL step (1/32 storage), and whatever
    // residual remains goes to SHIFT so playback reproduces what was heard.
    const s = this.state.gridOff ? 0 : this.inputQuantizeStrength();
    const corrected = stepsElapsed + s * (nearestView - stepsElapsed);
    const snapped = this.state.gridOff ? nearestView : Math.round(corrected);
    const step = ((snapped % total) + total) % total;  // wrapped into the loop
    if (this.state.pattern[track.key][step]) return { step, wasOn: true }; // already on → no churn
    // Mutate the internal array directly (the active sequence shares this same
    // row reference via writePattern, so it stays in sync) — no emit.
    this.state.pattern[track.key][step] = true;
    if (this.state.stepShift[track.key]) {
      // ±50 ms is the SHIFT range (clampGraph); a full-strength hit writes a
      // clean 0 so an on-grid recording never carries a stale residual.
      const residualMs = (corrected - snapped) * stepDur * 1000;
      this.state.stepShift[track.key][step] = Math.abs(residualMs) < 0.5 ? 0 : clampGraph('SHIFT', residualMs);
    }
    this._sequenceDirty = true;
    return { step, wasOn: false };
  }

  // ── Step-input recording (pad hits fill steps one at a time) ──────────────
  /** Arm STEP recording: each subsequent pad hit stamps the step under the
   *  cursor and advances it (see recordStepHit). Mutually exclusive with LIVE
   *  recording (the host calls stopStepRec when arming LIVE, and vice versa). */
  startStepRec(): void {
    // One snapshot at arm time so the whole step-record session collapses to one
    // undo (each recordStepHit then writes without its own push). Matches the
    // chopper's startRecordingSeq, which also snapshots once at the session start.
    this.pushDrumHistory();
    const total = this.state.bars * this.spb();
    this.state = { ...this.state, stepRecording: true, liveRecording: false, drumRecordStep: 0 };
    this.emit();
  }

  stopStepRec(): void {
    this.state = { ...this.state, stepRecording: false };
    this.emit();
  }

  // ── dynamic lanes ──────────────────────────────────────────────────────
  // The five defaults are fixed; anything past them is user-added from the drum
  // browser. A new lane needs a row in EVERY stored sequence and in all four
  // step graphs, or the scheduler reads undefined for it.

  /** Colours for added lanes, cycled so each new one is visually distinct from
   *  its neighbours without asking the user to pick. */
  private static ADDED_COLORS = ['#a855f7', '#06b6d4', '#ec4899', '#84cc16', '#f59e0b', '#14b8a6'];

  /** Add a lane that borrows `kitKey`'s sample list, starting on `sampleIndex`.
   *  Returns the new lane's key. */
  addTrack(name: string, kitKey: TrackKey, sampleIndex: number, genre?: Genre): TrackKey {
    this.pushDrumHistory();
    // Keys must be unique and stable — they index every pattern row and graph.
    let n = 1;
    while (this.state.tracks.some(t => t.key === `user${n}`)) n++;
    const key = `user${n}`;
    const color = DrumEngine.ADDED_COLORS[(this.state.tracks.length - BUILTIN_TRACK_KEYS.length) % DrumEngine.ADDED_COLORS.length];
    const len = this.state.bars * this.spb();

    const sequences = this.state.sequences.map(seq => ({ ...seq, [key]: Array(len).fill(false) }));
    const graft = (g: StepGraph, def: number): StepGraph => ({ ...g, [key]: Array(MAX_STEPS).fill(def) });

    // Every lane needs its own output tap or it has nowhere to play from — and
    // the mixer re-points this one to the lane's new strip (see ChopperView).
    this.ensureTap(key);
    // Arranged playback already queued (pendingPatterns) predates this lane —
    // give it an empty row there too, or scheduleStep reads an undefined row.
    this.pendingPatterns = this.pendingPatterns.map(p => ({ ...p, pattern: { ...p.pattern, [key]: Array(len).fill(false) } }));

    this.state = {
      ...this.state,
      tracks: [...this.state.tracks, {
        key, name, color, kitKey, added: true,
        sampleIndex, sampleGenre: genre ?? this.state.genre,
        muted: false, solo: false, volume: 1.0,
      }],
      sequences,
      pattern: sequences[this.state.seqIndex],
      stepVelocity: graft(this.state.stepVelocity, GRAPH_DEFAULTS.VELOCITY),
      stepShift: graft(this.state.stepShift, GRAPH_DEFAULTS.SHIFT),
      stepPan: graft(this.state.stepPan, GRAPH_DEFAULTS.PAN),
      stepRepeat: graft(this.state.stepRepeat, GRAPH_DEFAULTS.REPEAT),
    };
    void this.loadSample(key, sampleIndex);
    this.emit();
    return key;
  }

  /** Browser bridge for ADD NEW: resolve a (slot, kit, filename) triple to an
   *  index and open a lane on it, named with the same alias the browser shows so
   *  the row and the browser read identically. */
  addTrackFromSample(slot: TrackKey, genre: Genre, file: string): TrackKey | null {
    const list = KITS[genre]?.[this.slotOf(slot)] ?? KITS[genre]?.[slot as BuiltinTrackKey] ?? [];
    const idx = list.indexOf(file);
    if (idx < 0) return null;
    const name = drumAlias(slot as BuiltinTrackKey, list, file);
    return this.addTrack(name, slot, idx, genre);
  }

  /** Remove an ADDED lane (the five defaults are permanent). Drops its row from
   *  every sequence and graph so nothing is left dangling. */
  removeTrack(key: TrackKey): void {
    const t = this.state.tracks.find(x => x.key === key);
    if (!t?.added) return;
    this.pushDrumHistory();
    try { this.trackOutputNodes[key]?.disconnect(); } catch { /* already gone */ }
    delete this.trackOutputNodes[key];
    const strip = (o: Record<string, unknown[]>) => {
      const out: Record<string, unknown[]> = {};
      for (const k of Object.keys(o)) if (k !== key) out[k] = o[k];
      return out;
    };
    const sequences = this.state.sequences.map(s => strip(s as never) as Pattern);
    this.state = {
      ...this.state,
      tracks: this.state.tracks.filter(x => x.key !== key),
      sequences,
      pattern: sequences[this.state.seqIndex],
      stepVelocity: strip(this.state.stepVelocity as never) as StepGraph,
      stepShift: strip(this.state.stepShift as never) as StepGraph,
      stepPan: strip(this.state.stepPan as never) as StepGraph,
      stepRepeat: strip(this.state.stepRepeat as never) as StepGraph,
    };
    this.emit();
  }

  /** Arm REC (live recording). Explicit state rather than "is the transport
   *  playing with drum pads on" — that inference meant the only way to stop
   *  recording was to stop the transport, so disarming killed playback. One
   *  snapshot at arm time collapses the whole take into a single undo, matching
   *  startStepRec. Mutually exclusive with STEP. */
  startLiveRec(): void {
    if (this.state.liveRecording) return;
    this.pushDrumHistory();
    this.state = { ...this.state, liveRecording: true, stepRecording: false };
    this.emit();
  }

  /** Disarm REC. Deliberately does NOT touch the transport — the loop keeps
   *  playing, you just stop writing into it. */
  stopLiveRec(): void {
    if (!this.state.liveRecording) return;
    this.state = { ...this.state, liveRecording: false };
    this.emit();
  }

  /** Called from the pad trigger path in ChopperView when stepRecording is on.
   *  Stamps the current drumRecordStep ON for `trackIndex`, then advances the
   *  cursor to the next step (wrapping within the loop length). No-op when
   *  stepRecording is false. Emits so the grid lights up immediately. */
  recordStepHit(trackIndex: number): void {
    if (!this.state.stepRecording) return;
    const track = this.state.tracks[trackIndex];
    if (!track) return;
    const total = this.state.bars * this.spb();
    if (total <= 0) return;
    // The cursor walks VISIBLE columns, so STEP input at 1/8 fills eighth notes
    // even though storage is 1/32. drumRecordStep is an internal index; snap it
    // onto the view grid first in case the division changed mid-session.
    const stride = this.viewStride();
    const step = (Math.round(this.state.drumRecordStep / stride) * stride) % total;
    // Set the step ON and advance cursor
    this.state.pattern[track.key][step] = true;
    const next = (step + stride) % total;
    this.state = { ...this.state, drumRecordStep: next };
    this._sequenceDirty = true;
    this.emit();
  }

  /** Commit live-recorded hits to React state with a SINGLE emit. Snapshots the
   *  in-place-mutated pattern into fresh references (like commitStepGraph) so the
   *  host re-renders once + dirty-tracking sees the change, and re-points the
   *  active stored sequence at it. Called throttled from the scheduler tick and
   *  immediately on stop(). No-op when nothing was recorded since the last flush. */
  private flushSequence(): void {
    if (!this._sequenceDirty) return;
    this._sequenceDirty = false;
    this._lastSeqFlush = this.ctx.currentTime;
    const pattern: Pattern = {} as Pattern;
    for (const k of Object.keys(this.state.pattern) as TrackKey[]) {
      pattern[k] = [...this.state.pattern[k]];
    }
    const sequences = this.state.sequences.slice();
    sequences[this.state.seqIndex] = pattern;
    this.state = { ...this.state, pattern, sequences };
    this.emit();
  }

  /** DEV-only (?debug=1) A/B capture. Renders the current sample of `track`
   *  offline through three envelopes so the transient can be compared:
   *    - reference  : full gain from sample 0 (the ideal punchy audition)
   *    - sequencer  : the FIXED attack (applyDrumAttack — same fn as live playback)
   *    - legacy     : the OLD 25 ms exponential ramp (the softening bug), for proof
   *  Returns the three buffers + peak(first 50 ms) / RMS(200 ms) metrics. Uses
   *  OfflineAudioContext (not MediaStreamDestination) so the comparison is
   *  deterministic and isolates the drum envelope — the host master FX chain is
   *  intentionally excluded (it processes every path equally, so it can't explain
   *  a preview-vs-sequencer difference). */
  async captureAB(track: TrackKey): Promise<{
    reference: AudioBuffer; sequencer: AudioBuffer; legacy: AudioBuffer;
    metrics: Record<'reference' | 'sequencer' | 'legacy', { peak50ms: number; rms200ms: number }>;
  }> {
    const t = this.state.tracks.find(x => x.key === track);
    const buf = t ? await this.loadSample(track, t.sampleIndex) : null;
    if (!buf) throw new Error('captureAB: no sample buffer for ' + track);
    const sr = this.ctx.sampleRate;
    const frames = Math.ceil(sr * 1.0); // 1 s
    const volume = 1;
    const headAbs = drumHeadLevel(buf);
    type Env = 'reference' | 'sequencer' | 'legacy';
    const render = (env: Env): Promise<AudioBuffer> => {
      const oac = new OfflineAudioContext(1, frames, sr);
      const src = oac.createBufferSource(); src.buffer = buf;
      const g = oac.createGain();
      if (env === 'reference') {
        g.gain.setValueAtTime(volume, 0);
      } else if (env === 'sequencer') {
        applyDrumAttack(g.gain, 0, volume, headAbs); // identical to live playback
      } else { // legacy — the removed 25 ms exponential softening, for comparison
        g.gain.setValueAtTime(0.0001, 0);
        g.gain.exponentialRampToValueAtTime(volume, 0.025);
      }
      src.connect(g); g.connect(oac.destination);
      src.start(0);
      return oac.startRendering();
    };
    const metricsOf = (b: AudioBuffer) => {
      const d = b.getChannelData(0);
      const n50 = Math.min(d.length, Math.floor(sr * 0.05));
      const n200 = Math.min(d.length, Math.floor(sr * 0.2));
      let peak = 0; for (let i = 0; i < n50; i++) { const a = Math.abs(d[i]); if (a > peak) peak = a; }
      let sum = 0; for (let i = 0; i < n200; i++) sum += d[i] * d[i];
      return { peak50ms: peak, rms200ms: Math.sqrt(sum / Math.max(1, n200)) };
    };
    const reference = await render('reference');
    const sequencer = await render('sequencer');
    const legacy = await render('legacy');
    return {
      reference, sequencer, legacy,
      metrics: {
        reference: metricsOf(reference),
        sequencer: metricsOf(sequencer),
        legacy: metricsOf(legacy),
      },
    };
  }
}
