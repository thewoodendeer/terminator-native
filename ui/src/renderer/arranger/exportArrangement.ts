// Phase 4A — Beat Finisher export. Renders an arrangement (the producer's chops
// arranged into sections + the drum sequencer) OFFLINE, then packages WAVs and
// triggers a download. Timing mirrors the live ArrangerPreview: chops reset per
// section (chopEvents already loop the sequence to fill the bars); drums run on
// a continuous loop phase (pattern step = globalStep % patternLength), with the
// section's pattern resolved per step.
//
// UNIFIED DAW PATH (desktop): when the chopper has a MixerEngine wired
// (engine.mixerEngine — desktop only), master + stems render through
// renderArrangementDAW, which bakes every mixer strip (insert FX, fader, pan,
// mute/solo), the send buses, and the master strip — so the export sounds
// exactly like pressing play. Both the main EXPORT section and the Beat
// Finisher modal call this same code (runExport delegates here with the live
// arrangement). Without a mixer (mobile/HardwareView) the legacy
// renderArrangementMix path is preserved untouched.
//
// `buildArrangementFiles` renders + packages WITHOUT downloading (testable);
// `exportArrangement` wraps it with deliverFiles.

import { ChopperEngine } from '../chopper/ChopperEngine';
import { DrumEngine, TrackKey, drumSwingOffsetSec, REPEAT_RATES } from '../drums/DrumEngine';
import { Arrangement, ArrangementSection } from './types';
import { buildZip } from '../chopper/exporters/zipWriter';
import { buildArrangementMpcSample, MpcArrNote } from '../chopper/exporters/mpcSample';
import { encodeWAV } from '../audio/StemExporter';
import { encodeFLAC, quantizeTPDF16 } from '../audio/flacEncoder';
import { deliverFiles } from '../lib/download';
import { renderArrangementDAW, channelForTrack, DrumTrackHit } from './renderArrangementDAW';
import { annotateGroupCuts } from '../drums/muteGroups';
import { renderBassOffline, type BassRenderNote, type BassRenderBend } from '../bass/BassEngine';

export type ExportTarget = 'master' | 'stems' | 'mpc';

const MPC_PPQ = 960;

type ChopEvent = { padIdx: number; time: number; maxDur: number; reverse?: boolean };
type DrumHit = { buffer: AudioBuffer; time: number; gain: number; pan?: number; chokeAt?: number; groupCutAt?: number };

function safeName(s: string): string {
  return String(s).replace(/[/\\:*?"<>|\0]/g, '-').replace(/\s+/g, '_').slice(0, 80) || 'beat';
}

/** Resolve every section's bassNotes into absolute-time notes (seconds). */
function buildBassNotes(arr: Arrangement, beatDur: number): BassRenderNote[] {
  const barDur = beatDur * 4;
  const out: BassRenderNote[] = [];
  let cursor = 0;
  for (const sec of arr.sections) {
    const bars = Math.max(1, Math.floor(sec.bars) || 1);
    for (const n of sec.bassNotes ?? []) {
      out.push({ time: cursor + n.beat * beatDur, note: n.note, dur: Math.max(0.02, n.dur * beatDur), vel: n.vel, ...(n.slide ? { slide: true } : {}) });
    }
    cursor += bars * barDur;
  }
  return out;
}

/** Every section's BEND lane as absolute-time bends (seconds). */
function buildBassBends(arr: Arrangement, beatDur: number): BassRenderBend[] {
  const barDur = beatDur * 4;
  const out: BassRenderBend[] = [];
  let cursor = 0;
  for (const sec of arr.sections) {
    const bars = Math.max(1, Math.floor(sec.bars) || 1);
    for (const b of sec.bassBends ?? []) out.push({ time: cursor + b.beat * beatDur, semis: b.semis });
    cursor += bars * barDur;
  }
  return out;
}

/** Resolve the chops of every section into absolute-time pad events, cutting
 *  each at the next chop so the sequence plays like the sequencer (matches the
 *  live preview's chopEvents). */
function buildChopEvents(arr: Arrangement, beatDur: number): ChopEvent[] {
  const barDur = beatDur * 4;
  // Collect (padIdx, time) pairs across all sections.
  const raw: Array<{ padIdx: number; time: number; reverse: boolean }> = [];
  let cursor = 0;
  for (const sec of arr.sections) {
    const bars = Math.max(1, Math.floor(sec.bars) || 1);
    for (const ev of sec.chopEvents ?? []) {
      const time = cursor + ev.beat * beatDur;
      ev.pads.forEach((pad, i) => raw.push({ padIdx: pad, time, reverse: !!ev.rev?.[i] }));
    }
    cursor += bars * barDur;
  }
  if (!raw.length) return [];
  raw.sort((a, b) => a.time - b.time);
  // Distinct hit times → each event rings until the next distinct hit.
  const times = Array.from(new Set(raw.map(r => Math.round(r.time * 1e4) / 1e4))).sort((a, b) => a - b);
  const nextOf = new Map<number, number>();
  for (let i = 0; i < times.length; i++) nextOf.set(times[i], times[i + 1] ?? times[i] + beatDur * 2);
  return raw.map(r => {
    const key = Math.round(r.time * 1e4) / 1e4;
    return { padIdx: r.padIdx, time: r.time, maxDur: Math.max(0.05, (nextOf.get(key) ?? r.time + beatDur * 2) - r.time), reverse: r.reverse };
  });
}

/** Steps per bar a section's drum rows are written at. The DrumEngine stores
 *  patterns at a fixed internal 1/32 and the arrangement builders stamp that on
 *  the section (drumStepsPerBar); absent = 16, the historical contract the
 *  export test fixtures still use. Reading every row as 16ths (the old
 *  hardcoded `* 16`) played a live 32nd row at half speed with the back half of
 *  every bar missing.
 *
 *  It is DECLARED, never inferred: a drum row is not one section long — the
 *  loop keeps its own length (2 bars by default) and tiles across a 4-bar
 *  section — so `row.length / sec.bars` is meaningless. (An earlier version of
 *  this fix guessed exactly that and turned a 2-bar loop under a 4-bar section
 *  back into half time.) */
const DEFAULT_DRUM_SPB = 16;
function sectionDrumSpb(sec: ArrangementSection): number {
  const spb = sec.drumStepsPerBar;
  return Number.isInteger(spb) && (spb as number) > 0 ? (spb as number) : DEFAULT_DRUM_SPB;
}

/** The single step resolution an arrangement's drums are laid out at: the finest
 *  declared across its sections (they all come from the one engine, so in
 *  practice they agree). Coarser rows are stretched onto this grid so the global
 *  step counter — which is what keeps loop PHASE continuous across sections —
 *  stays meaningful. */
function arrangementDrumSpb(arr: Arrangement): number {
  let spb = 0;
  for (const sec of arr.sections) spb = Math.max(spb, sectionDrumSpb(sec));
  return spb || DEFAULT_DRUM_SPB;
}

/** Read `row` (written at `rowSpb`) at global step `g` of a `gridSpb` grid.
 *  Loop phase is continuous: the row tiles across the whole song. A coarser row
 *  only sounds on the grid steps that fall exactly on one of its own steps. */
function drumRowAt(row: readonly boolean[], rowSpb: number, gridSpb: number, g: number): boolean {
  const stride = gridSpb / rowSpb;
  if (g % stride !== 0) return false;
  const i = g / stride;
  return !!row[i % row.length];
}


/** The per-step graphs the live scheduler reads (DrumEngine.scheduleStep):
 *  VELOCITY × volume, SHIFT (ms, snapped to the PPQ pulse), PAN, REPEAT. They
 *  are indexed by the LOOP step of the engine's own pattern (internal 96/bar,
 *  wrapping at bars × 96) — the same index for every section, exactly as live
 *  arranged playback applies them. */
export interface DrumStepGraphs {
  bars: number; ppq: number;
  stepVelocity: Partial<Record<TrackKey, number[]>>;
  stepShift: Partial<Record<TrackKey, number[]>>;
  stepPan: Partial<Record<TrackKey, number[]>>;
  stepRepeat: Partial<Record<TrackKey, number[]>>;
}
const INTERNAL_SPB = 96;
/** Every hit of one track across the arrangement AS THE LIVE LANE WOULD FIRE
 *  IT: swing + SHIFT in the time, VELOCITY in the gain, PAN, and a REPEAT step
 *  expanded into its self-choking sub-hits. The single source of truth for the
 *  DAW per-track render and the legacy flat list. */
export function buildDrumTrackHits(arr: Arrangement, track: TrackKey, volume: number, beatDur: number, bpm: number, drumSwing: number, graphs?: DrumStepGraphs): DrumTrackHit[] {
  const spb = arrangementDrumSpb(arr);
  const stepDur = (beatDur * 4) / spb;
  const per16th = spb / 16;
  const perInternal = INTERNAL_SPB / spb;              // internal steps per arrangement step
  const loopLen = Math.max(1, (graphs?.bars ?? 1) * INTERNAL_SPB);
  const pulseSec = graphs && bpm > 0 && graphs.ppq > 0 ? (60 / bpm) / graphs.ppq : 0;
  const hits: DrumTrackHit[] = [];
  const spans = arr.sections.map((sec) => Math.max(1, Math.floor(sec.bars) || 1) * spb);
  const totalSteps = spans.reduce((a, b) => a + b, 0);
  let secIdx = 0;
  let secEnd = spans[0] ?? 0;
  for (let g = 0; g < totalSteps; g++) {
    while (g >= secEnd && secIdx < arr.sections.length - 1) { secIdx++; secEnd += spans[secIdx]; }
    const sec = arr.sections[secIdx];
    const pat = sec?.drumPattern;
    if (!pat) continue;
    const row = pat[track];
    if (!row || row.length === 0) continue;
    if (!drumRowAt(row, sectionDrumSpb(sec), spb, g)) continue;
    const base = g * stepDur + drumSwingOffsetSec(Math.floor(g / per16th), bpm, drumSwing);
    const li = Math.round(g * perInternal) % loopLen;   // the live loop index of this step
    const vel = graphs?.stepVelocity[track]?.[li] ?? 1;
    const gain = volume * vel;
    if (gain <= 0) continue;
    let shiftSec = (graphs?.stepShift[track]?.[li] ?? 0) / 1000;
    if (pulseSec > 0) shiftSec = Math.round(shiftSec / pulseSec) * pulseSec;
    const time = Math.max(0, base + shiftSec);
    const pan = graphs?.stepPan[track]?.[li] ?? 0;
    const rate = REPEAT_RATES[graphs?.stepRepeat[track]?.[li] ?? 0];
    const interval = rate && rate.beats > 0 ? rate.beats * beatDur : 0;
    const nextStepTime = (g + 1) * stepDur;
    const times: number[] = [];
    if (interval > 0.001) for (let tt = time; tt < nextStepTime - 0.001; tt += interval) times.push(tt);
    if (times.length < 2) hits.push({ time, gain, pan: pan || undefined });
    else for (let i = 0; i < times.length; i++) hits.push({ time: times[i], gain, pan: pan || undefined, chokeAt: i + 1 < times.length ? times[i + 1] : nextStepTime });
  }
  return hits;
}
/** The live engine's graphs, shaped for buildDrumTrackHits. */
export function drumGraphsOf(drumEngine: DrumEngine): DrumStepGraphs {
  const st = drumEngine.getState() as unknown as DrumStepGraphs;
  return { bars: st.bars, ppq: st.ppq, stepVelocity: st.stepVelocity ?? {}, stepShift: st.stepShift ?? {}, stepPan: st.stepPan ?? {}, stepRepeat: st.stepRepeat ?? {} };
}

/** Legacy flat hit list (mobile / no-mixer path) — every audible track's hits
 *  with its sample buffer + per-hit volume, ready for renderArrangementMix. */
/** Mute-group cut times, computed ONCE for whichever hit set is being rendered
 *  (muteGroups.ts is the single owner of the rule — live and both offline
 *  renderers must agree or an export stops matching playback). */
function withGroupCuts<T extends { time: number; chokeAt?: number; groupCutAt?: number }>(
  byTrack: Partial<Record<TrackKey, T[]>>,
  drumEngine: { muteGroupOf?: (k: TrackKey) => number | undefined },
): void {
  if (!drumEngine.muteGroupOf) return;
  annotateGroupCuts(byTrack, k => drumEngine.muteGroupOf!(k));
}

function buildDrumHits(
  arr: Arrangement,
  tracks: Array<{ key: TrackKey; buffer: AudioBuffer | null; volume: number; audible: boolean }>,
  beatDur: number,
  bpm: number,
  drumSwing: number,
  graphs?: DrumStepGraphs,
  drumEngine?: { muteGroupOf?: (k: TrackKey) => number | undefined },
): DrumHit[] {
  // Per track first, so the mute-group cut can see whole lanes; flattened after.
  const byTrack: Partial<Record<TrackKey, DrumTrackHit[]>> = {};
  const bufOf = new Map<TrackKey, AudioBuffer>();
  for (const t of tracks) {
    if (!t.audible || !t.buffer || t.volume <= 0) continue;
    byTrack[t.key] = buildDrumTrackHits(arr, t.key, t.volume, beatDur, bpm, drumSwing, graphs);
    bufOf.set(t.key, t.buffer);
  }
  if (drumEngine) withGroupCuts(byTrack, drumEngine);
  const hits: DrumHit[] = [];
  for (const [key, list] of Object.entries(byTrack) as Array<[TrackKey, DrumTrackHit[]]>) {
    const buffer = bufOf.get(key)!;
    for (const h of list) hits.push({ buffer, ...h });
  }
  return hits.sort((a, b) => a.time - b.time);
}

/** Lay ONE section onto an MPC note timeline (PPQ ticks, relative to the section
 *  start so it's a standalone loopable sequence). Pads are CONTIGUOUS from 0 (the
 *  MPC fills PADnn WAVs onto consecutive pads, so any gap shifts samples = wrong-
 *  sample bug): `drumInfo` holds the drum pads (placed first) + their velocities;
 *  `chopRemap` maps the chopper's pad index → its output pad (right after drums).
 *  Note = 36 + output pad. Chops come from chopEvents (beats within the section);
 *  drums tile the section's pattern from its local start. The live 16T drum swing
 *  is baked into the drum note POSITIONS (odd 16ths pushed late, downbeats fixed)
 *  so the sequence grooves on MPC hardware exactly like Terminator playback —
 *  chops stay straight (live only swings drums). Each section starts on an even
 *  global step (spans are multiples of 16), so the local step `g` parity matches
 *  the global parity buildDrumTrackHits/the live scheduler use. */
function buildSectionNotes(
  sec: ArrangementSection,
  chopVel: number,
  drumGain: number,
  chopRemap: Map<number, number>,
  drumInfo: Array<{ key: TrackKey; pad: number; volume: number }>,
  bpm: number,
  drumSwing: number,
): MpcArrNote[] {
  const stepTicks = MPC_PPQ / 4; // 16th note
  const bars = Math.max(1, Math.floor(sec.bars) || 1);
  const notes: MpcArrNote[] = [];

  for (const ev of sec.chopEvents ?? []) {
    const time = ev.beat * MPC_PPQ;
    for (const pad of ev.pads) {
      const np = chopRemap.get(pad);
      if (np === undefined) continue; // pad has no rendered chop → skip
      notes.push({ time, note: 36 + np, length: stepTicks, velocity: chopVel });
    }
  }

  const pat = sec.drumPattern;
  if (pat) {
    // Lay the rows on the resolution the section declares (32nds for live
    // captures, 16ths for the legacy fixtures) — see sectionDrumSpb.
    const spb = sectionDrumSpb(sec);
    const gridTicks = (MPC_PPQ * 4) / spb;
    const per16th = spb / 16;
    const steps = bars * spb;
    for (let g = 0; g < steps; g++) {
      // Swing offset (seconds) → MPC ticks: sec × (bpm/60) beats/sec × 960 ticks/beat.
      // drumSwingOffsetSec is indexed in 16ths and returns 0 on even ones, so
      // downbeats never move — convert the grid step to its 16th slot first.
      const swingTicks = Math.round(drumSwingOffsetSec(Math.floor(g / per16th), bpm, drumSwing) * (bpm / 60) * MPC_PPQ);
      const time = g * gridTicks + swingTicks;
      for (const d of drumInfo) {
        const row = pat[d.key];
        if (!row || row.length === 0) continue;
        if (drumRowAt(row, spb, spb, g)) {
          notes.push({ time, note: 36 + d.pad, length: stepTicks, velocity: d.volume * drumGain });
        }
      }
    }
  }
  return notes;
}

export interface ExportArrangementOpts {
  engine: ChopperEngine;
  drumEngine: DrumEngine;
  arrangement: Arrangement;
  bpm: number;
  target: ExportTarget;
  title?: string;
  bitDepth?: 16 | 24;
  /** Container for the audio this export writes. FLAC is LOSSLESS — the same
   *  16-bit samples as the WAV (quantizeTPDF16 is the very dither encodeWAV
   *  uses, pinned by scripts/flac-encoder.test.mts), about half the bytes.
   *  Only the targets whose bytes the USER consumes may take it: a .mpcsample
   *  or a Drum Rack is read by a sampler/DAW that parses WAV headers, so those
   *  stay WAV whatever is asked for. */
  audioFormat?: 'wav' | 'flac';
  onProgress?: (pct: number, label: string) => void;
  /** CANCEL: polled at every progress point. Returning true aborts with `ExportCancelled` BEFORE any file is
   *  written, so a cancelled export never leaves a partial file behind — the same rule the native renderer keeps. */
  shouldCancel?: () => boolean;
}

/** Thrown when `shouldCancel` asked to stop. Callers should treat it as "nothing happened", not as a failure. */
export class ExportCancelled extends Error {
  constructor() { super('Export cancelled'); this.name = 'ExportCancelled'; }
}

export interface ExportFile { name: string; data: ArrayBuffer | Uint8Array; mime: string }

/** Render + package the arrangement export WITHOUT downloading — the testable
 *  core shared by exportArrangement (below) and the headless export tests. */
export async function buildArrangementFiles(opts: ExportArrangementOpts): Promise<{ files: ExportFile[]; message: string }> {
  const { engine, drumEngine, arrangement, bpm, target } = opts;
  const bitDepth = opts.bitDepth ?? 16;
  // MPC + Drum Rack parse WAV headers — never hand them FLAC.
  const flac = opts.audioFormat === 'flac' && (target === 'master' || target === 'stems');
  /** The chosen container for one rendered buffer. */
  const encodeAudio = (buf: AudioBuffer): Uint8Array => {
    if (!flac) return new Uint8Array(encodeWAV(buf, bitDepth));
    const chans: Float32Array[] = [];
    for (let c = 0; c < buf.numberOfChannels; c++) chans.push(buf.getChannelData(c));
    return encodeFLAC(quantizeTPDF16(chans, buf.length), buf.sampleRate, 16);
  };
  const ext = flac ? 'flac' : 'wav';
  const audioMime = flac ? 'audio/flac' : 'audio/wav';
  const report = opts.onProgress ?? (() => {});
  // every progress point is also a cancel point — the render stops here, before anything is written
  const progress = (pct: number, label: string) => {
    if (opts.shouldCancel?.()) throw new ExportCancelled();
    report(pct, label);
  };
  const base = safeName(opts.title || 'beat-finisher');

  const beatDur = 60 / Math.max(1, bpm);
  const barDur = beatDur * 4;
  const totalBars = arrangement.sections.reduce((a, s) => a + Math.max(1, Math.floor(s.bars) || 1), 0);
  const TAIL = 2.5; // let reverb / one-shot tails ring out
  const totalSec = totalBars * barDur + TAIL;

  progress(0.05, 'Loading drum samples…');
  await drumEngine.preload?.();
  const tracks = await drumEngine.getExportTracks();

  // Bake the live 16T drum swing into every hit time (matches the look-ahead
  // scheduler) so master + stems groove exactly like playback. 0 ⇒ straight.
  const drumSwing = drumEngine.getState().drumSwing ?? 0;
  // Per-step VELOCITY / SHIFT / PAN / REPEAT ride along (they used to be
  // dropped: exports had every accent, micro-timing, pan and roll flattened).
  const graphs = drumGraphsOf(drumEngine);
  const chopEvents = buildChopEvents(arrangement, beatDur);
  const drumHits = buildDrumHits(arrangement, tracks, beatDur, bpm, drumSwing, graphs, drumEngine);
  // BASS rides the desktop DAW path only (needs the mixer's bass strip + the
  // synth worklet); the legacy no-mixer render has no bass.
  const bassNotes = arrangement.bassPatch ? buildBassNotes(arrangement, beatDur) : [];
  const bassBends = arrangement.bassPatch ? buildBassBends(arrangement, beatDur) : [];
  const bass = arrangement.bassPatch && bassNotes.length ? { patch: arrangement.bassPatch, notes: bassNotes, bends: bassBends } : undefined;
  // Legacy (no mixer, i.e. mobile): the bass is rendered ONCE here and summed
  // into the master-chain render alongside chops + drums (and gets its own stem).
  const legacyBass = async (): Promise<AudioBuffer | undefined> => {
    if (!bass) return undefined;
    progress(0.12, 'Rendering bass…');
    return renderBassOffline(bass.patch, bass.notes, totalSec, engine.buffer?.sampleRate ?? 44100, bass.bends);
  };
  if (chopEvents.length === 0 && drumHits.length === 0 && !bass) {
    throw new Error('Nothing to export — add chops, drums or bass to the arrangement.');
  }
  const chopGain = engine.getChopVolume?.() ?? 1;
  const drumGain = drumEngine.getState().masterVolume ?? 1;
  // Desktop DAW path: the mixer strips (FX/fader/pan/mute), sends and master
  // strip get baked. Mobile (no mixer) keeps the legacy internal-chain render.
  const mixer = engine.mixerEngine ?? null;
  const runDAW = (wantMaster: boolean, wantStems: boolean, onStep: (label: string) => void) => {
    const drumHitsByTrack: Partial<Record<TrackKey, DrumTrackHit[]>> = {};
    const drumBuffers: Partial<Record<TrackKey, AudioBuffer | null>> = {};
    for (const t of tracks) {
      if (!t.audible || !t.buffer || t.volume <= 0) continue;
      const hits = buildDrumTrackHits(arrangement, t.key, t.volume, beatDur, bpm, drumSwing, graphs);
      if (!hits.length) continue;
      drumHitsByTrack[t.key] = hits;
      drumBuffers[t.key] = t.buffer;
    }
    // MUTE GROUPS: a lane cut by a group-mate stops there, exactly as live.
    withGroupCuts(drumHitsByTrack, drumEngine);
    return renderArrangementDAW({
      engine, mixer: mixer!, chopEvents,
      drumHits: drumHitsByTrack, drumBuffers, bass,
      baseSec: totalSec, wantMaster, wantStems, onStep,
    });
  };

  if (target === 'master') {
    if (mixer) {
      // Count: chops + per-drum + sends + master ≈ steps; map onto 0.1..0.85.
      let step = 0;
      const daw = await runDAW(true, false, (label) => { step++; progress(Math.min(0.85, 0.1 + step * 0.09), label); });
      progress(0.88, flac ? 'Encoding FLAC…' : 'Encoding WAV…');
      const data = encodeAudio(daw.master!);
      return { files: [{ name: `${base}-master.${ext}`, data, mime: audioMime }], message: `Master ${ext.toUpperCase()} exported.` };
    }
    const bassBuffer = await legacyBass();
    progress(0.25, 'Rendering master…');
    // The legacy (no-mixer) render returns WAV bytes; FLAC decodes them back to
    // an AudioBuffer once rather than duplicating the whole render path.
    const data = await engine.renderArrangementMix({ chopEvents, drumHits, totalSec, chopGain, drumGain, bitDepth, bassBuffer });
    if (!flac) return { files: [{ name: `${base}-master.wav`, data, mime: 'audio/wav' }], message: 'Master WAV exported.' };
    progress(0.9, 'Encoding FLAC…');
    const buf = await engine.decodeAudio(data.slice(0));
    return { files: [{ name: `${base}-master.flac`, data: encodeAudio(buf), mime: 'audio/flac' }], message: 'Master FLAC exported.' };
  }

  if (target === 'mpc') {
    // Full arrangement as one MPC project, laid out like Drum Dojo: DRUMS on the
    // first bank-A pads (0..D-1, one per drum track actually used), then the CHOP
    // samples right after (D..D+C-1). Everything CONTIGUOUS from pad 0 — the MPC
    // fills PADnn WAVs onto consecutive pads, so a gap would shift samples onto the
    // wrong pads. Slot-0 sequence carries BOTH the drum pattern and the chop
    // pattern. PADnn → pad nn → note 36+nn, matching the note events.
    const pad2 = (n: number) => String(n + 1).padStart(2, '0');

    // 1. Drum tracks that actually play in the arrangement (audible + ≥1 hit) → pads 0..D-1.
    const drumUsed = new Set<TrackKey>();
    for (const sec of arrangement.sections) {
      const pat = sec.drumPattern;
      if (!pat) continue;
      for (const t of tracks) {
        if (drumUsed.has(t.key) || !t.audible || !t.buffer) continue;
        const row = pat[t.key];
        if (row && row.some(Boolean)) drumUsed.add(t.key);
      }
    }
    const usedDrums = tracks.filter((t) => drumUsed.has(t.key)); // preserves kick..perc order
    const drumInfo = usedDrums.map((t, i) => ({ key: t.key, pad: i, volume: t.volume }));
    const chopBase = usedDrums.length;

    // 2. Chop pads the arrangement uses → contiguous pads chopBase..chopBase+C-1.
    const usedChopPads = new Set<number>();
    for (const sec of arrangement.sections) for (const ev of sec.chopEvents ?? []) for (const p of ev.pads) usedChopPads.add(p);
    progress(0.25, 'Rendering chop pads…');
    const allChops = await engine.exportChops(24); // [{ name, data, padIndex }] through master FX
    const usedChops = allChops.filter((c) => usedChopPads.has(c.padIndex)).sort((a, b) => a.padIndex - b.padIndex);
    const chopRemap = new Map<number, number>();
    usedChops.forEach((c, idx) => chopRemap.set(c.padIndex, chopBase + idx));

    // 3. One MPC sequence per section (slot i = section i), each carrying that
    //    section's chop + drum notes.
    const seqs = arrangement.sections.map((sec) => ({
      bars: Math.max(1, Math.floor(sec.bars) || 1),
      notes: buildSectionNotes(sec, chopGain, drumGain, chopRemap, drumInfo, bpm, drumSwing),
    }));
    if (seqs.every((s) => s.notes.length === 0)) throw new Error('Nothing to export — add chops or drums to the arrangement.');

    // 4. WAVs: drums first (pads 0..D-1), then chops (pads D..). On desktop each
    //    drum one-shot is baked through ITS mixer channel's insert FX + fader
    //    (same treatment the chop WAVs already get); mobile keeps the raw buffer.
    const entries: Array<{ path: string; data: Uint8Array }> = [];
    progress(0.5, 'Rendering drum pads…');
    for (const t of usedDrums) {
      const baked = mixer ? await mixer.renderWithMixerFX(t.buffer!, channelForTrack(t.key)) : t.buffer!;
      entries.push({ path: `${base}/PAD${pad2(drumInfo.find((d) => d.key === t.key)!.pad)}_${t.key}.wav`, data: new Uint8Array(encodeWAV(baked, 24)) });
    }
    for (const c of usedChops) {
      entries.push({ path: `${base}/PAD${pad2(chopRemap.get(c.padIndex)!)}_${safeName(c.name)}.wav`, data: new Uint8Array(c.data) });
    }

    // Mute groups: chops choke each other (group 1, mono like Terminator); drums ring (0).
    const muteGroups = new Array(128).fill(0);
    chopRemap.forEach((np) => { if (np >= 0 && np < 128) muteGroups[np] = 1; });

    progress(0.85, 'Building .mpcsample…');
    const mpc = await buildArrangementMpcSample({ bpm, sequences: seqs, muteGroups });
    entries.push({ path: `${base}/${base}.mpcsample`, data: mpc });

    progress(0.92, 'Zipping…');
    const zip = buildZip(entries);
    return {
      files: [{ name: `${base}-mpc.zip`, data: zip, mime: 'application/zip' }],
      message: `MPC project exported — ${usedDrums.length} drum + ${usedChops.length} chop pads, ${seqs.length} sequences.`,
    };
  }

  // Stems / Trackouts.
  if (mixer) {
    // DAW trackouts: one WAV per mixer channel (sample + each drum), plus a
    // 100%-wet return stem per ACTIVE send bus — all strip FX/fader/pan baked.
    let step = 0;
    const daw = await runDAW(false, true, (label) => { step++; progress(Math.min(0.85, 0.08 + step * 0.08), label); });
    if (!daw.stems.length) throw new Error('Nothing to export — add chops or drums to the arrangement.');
    progress(0.88, flac ? 'Encoding FLACs…' : 'Encoding WAVs…');
    const entries = daw.stems.map((s) => ({
      path: `${base}/${s.stemName}.${ext}`,
      data: encodeAudio(s.buffer),
    }));
    progress(0.94, 'Zipping…');
    const zip = buildZip(entries);
    return {
      files: [{ name: `${base}-stems.zip`, data: zip, mime: 'application/zip' }],
      message: `${entries.length} stem${entries.length === 1 ? '' : 's'} exported.`,
    };
  }

  // Legacy (no mixer): chop stem + drum stem, each through the master chain, zipped.
  const entries: Array<{ path: string; data: Uint8Array }> = [];
  if (chopEvents.length) {
    progress(0.2, 'Rendering chop stem…');
    const chopWav = await engine.renderArrangementMix({ chopEvents, totalSec, chopGain, bitDepth });
    entries.push({ path: `${base}/chops.wav`, data: new Uint8Array(chopWav) });
  }
  if (drumHits.length) {
    progress(0.6, 'Rendering drum stem…');
    const drumWav = await engine.renderArrangementMix({ drumHits, totalSec, drumGain, bitDepth });
    entries.push({ path: `${base}/drums.wav`, data: new Uint8Array(drumWav) });
  }
  if (bass) {
    const bassBuffer = await legacyBass();
    progress(0.8, 'Rendering bass stem…');
    const bassWav = await engine.renderArrangementMix({ totalSec, bitDepth, bassBuffer });
    entries.push({ path: `${base}/bass.wav`, data: new Uint8Array(bassWav) });
  }
  progress(0.92, 'Zipping…');
  const zip = buildZip(entries);
  return {
    files: [{ name: `${base}-stems.zip`, data: zip, mime: 'application/zip' }],
    message: `${entries.length} stem${entries.length === 1 ? '' : 's'} exported.`,
  };
}

/** Render + download the arrangement. Returns a short status message. */
export async function exportArrangement(opts: ExportArrangementOpts): Promise<string> {
  const report = opts.onProgress ?? (() => {});
  const progress = (pct: number, label: string) => {
    if (opts.shouldCancel?.()) throw new ExportCancelled();
    report(pct, label);
  };
  const { files, message } = await buildArrangementFiles(opts);
  progress(0.96, 'Saving…');
  await deliverFiles(files);
  progress(1, message);
  return message;
}
