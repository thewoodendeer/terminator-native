/**
 * Terminator 3.0 — THE BEAT FINISHER ARRANGEMENT, HANDED TO THE ENGINE (Phase 4.7b).
 *
 * The export used to render in Web Audio because the page is the only thing that knows the arrangement. That is
 * still true — and it stays true here. What changed is the split:
 *
 *   • the PAGE decides WHAT plays and WHEN. This module reuses the very functions the live arranger preview and the
 *     Web Audio exporter already use (`buildChopEvents`, `buildDrumTrackHits`, `drumGraphsOf`, `buildBassNotes` /
 *     `buildBassBends` + `bassTimelineNotes`), so there is ONE reading of a section's bars, swing, per-step
 *     VELOCITY / SHIFT / PAN / REPEAT and bass line — the same one you hear when you press play in the arranger.
 *   • the ENGINE decides how it SOUNDS: the voices, the pads' regions and stems, the drum lanes' mute-group choke,
 *     the bass synth, the mixer, the console, PDC, the limiter, the dither. `terminatorExport` takes the hits and
 *     renders them through the same objects that are playing.
 *
 * Two things are deliberately NOT sent:
 *   • MUTE-GROUP CUTS (`groupCutAt`). The drum pads carry their mute groups natively, so the engine chokes in the
 *     same order playback does; sending page-computed cuts as well would be two mechanisms for one rule.
 *   • the chop hits' gain. A pad's level (CHOP volume × NORM) is already on the pad natively, so a hit is velocity 1
 *     and the pad does the rest — the same as a live pad press.
 *
 * One difference is sent ON PURPOSE: the DRUM MASTER volume is folded into each drum hit's gain, because the native
 * engine applies it live (DrumSequencer: lane volume × step velocity × master) while the page's Web Audio desktop
 * path routes drum tracks straight into their mixer channels, bypassing its own drum master gain. Native playback is
 * the authority, so a native bounce matches native playback.
 */
import type { Arrangement } from '../arranger/types';
import type { ChopperEngine, PadSource } from '../chopper/ChopperEngine';
import type { DrumEngine, TrackKey } from '../drums/DrumEngine';
import { buildBassBends, buildBassNotes, buildChopEvents } from '../arranger/exportArrangement';
import { buildDrumTrackHits, drumGraphsOf } from '../arranger/exportArrangement';
import { bassTimelineNotes } from '../bass/BassEngine';
import { nativeEngineShadow } from './nativeEngineShadow';

/** Pad indices ≥ this are the DRUM machine's lanes natively (engine/core/Sampler.h kDrumPadBase). */
export const DRUM_PAD_BASE = 128;

/** One scheduled hit in the payload the shell parses (`arrangement.hits`). */
export interface NativeArrHit {
  pad: number;
  t: number;
  vel?: number;
  /** A drum lane's per-step PAN (−1..1). Absent = the pad's own. */
  pan?: number;
  /** A note-repeat SUB-HIT: chokes nothing; `stop` is its self-choke. */
  sub?: boolean;
  /** The chop sequencer's per-cell REVERSE for this hit only. */
  rev?: boolean;
  /** Absolute time to end this hit: a chop's cut where the next one starts, or a sub-hit's self-choke. */
  stop?: number;
}

export interface NativeArrBassEvent {
  kind: 'on' | 'off' | 'slide' | 'bend';
  t: number;
  note?: number;
  vel?: number;
  /** slide: length in seconds · bend: semitones. */
  value?: number;
}

export interface NativeArrangement {
  lengthSec: number;
  hits: NativeArrHit[];
  bass?: NativeArrBassEvent[];
  bassPatch?: unknown;
}

/** The store keys an arrangement render needs: the main track, each pad source by videoId, each drum lane by key. */
export interface NativeSampleKeys {
  main?: string;
  sources: Record<string, string>;
  drumLanes: Record<string, string>;
  /** Pad index → the store key of audio only the PAGE can make for that pad: the TIME-STRETCHED slice. The
   *  renderer plays it whole, with the mask and REVERSE already baked in. Without it a bounce plays the dry
   *  chop while the pads play the stretched one. */
  padSamples?: Record<string, string>;
}

const MAX_PADS = 64;

/** Seconds per beat / bar for an arrangement at `bpm`. */
const beatDurOf = (bpm: number): number => 60 / Math.max(1, bpm);

/** The arrangement's own length in seconds (its sections' bars — the tail is the renderer's `tail`). */
export function arrangementLengthSec(arr: Arrangement, bpm: number): number {
  const barDur = beatDurOf(bpm) * 4;
  const bars = arr.sections.reduce((a, s) => a + Math.max(1, Math.floor(s.bars) || 1), 0);
  return bars * barDur;
}

/**
 * The arrangement as the shell's `arrangement` payload. `drumTracks` comes from `drumEngine.getExportTracks()` (the
 * caller awaits it, so this stays synchronous and testable); a track that is muted, soloed out or silent is skipped,
 * exactly as the Web Audio exporter skips it. Lane numbering follows the drum engine's OWN track order, which is the
 * order the project serializes and therefore the order the native renderer hands its lanes out in.
 */
export function buildNativeArrangement(
  arr: Arrangement,
  bpm: number,
  drumEngine: DrumEngine,
  drumTracks: Array<{ key: TrackKey; buffer: AudioBuffer | null; volume: number; audible: boolean }>,
): NativeArrangement {
  const beatDur = beatDurOf(bpm);
  const hits: NativeArrHit[] = [];

  // CHOPS: absolute times with the cut at the next hit (maxDur) and the per-cell reverse.
  for (const ev of buildChopEvents(arr, beatDur)) {
    const h: NativeArrHit = { pad: ev.padIdx, t: ev.time, stop: ev.time + ev.maxDur };
    if (ev.reverse !== undefined) h.rev = !!ev.reverse;
    hits.push(h);
  }

  // DRUMS: one lane per track in the engine's order; the hits already carry swing, VELOCITY, SHIFT, PAN and the
  // REPEAT sub-hits. `chokeAt` on a sub-hit is its self-choke; a mute-group cut is the engine's job, not ours.
  const state = drumEngine.getState();
  const swing = state.drumSwing ?? 0;
  const master = Math.max(0, Math.min(1, state.masterVolume ?? 1));
  const graphs = drumGraphsOf(drumEngine);
  let lane = 0;
  for (const t of drumTracks) {
    const idx = lane++;
    if (!t.audible || !t.buffer || t.volume <= 0) continue;
    for (const h of buildDrumTrackHits(arr, t.key, t.volume, beatDur, bpm, swing, graphs)) {
      if (h.gain <= 0) continue;
      const hit: NativeArrHit = { pad: DRUM_PAD_BASE + idx, t: h.time, vel: h.gain * master };
      if (h.pan !== undefined && h.pan !== 0) hit.pan = h.pan;
      if (h.chokeAt !== undefined) {
        hit.sub = true; // only a roll's sub-hits carry chokeAt; a plain hit is choked by its group
        hit.stop = h.chokeAt;
      }
      hits.push(hit);
    }
  }
  hits.sort((a, b) => a.t - b.t);

  const out: NativeArrangement = { lengthSec: arrangementLengthSec(arr, bpm), hits };

  // BASS: the same absolute-time event list the live preview plays, plus the BEND lane.
  if (arr.bassPatch) {
    const notes = buildBassNotes(arr, beatDur);
    const bends = buildBassBends(arr, beatDur);
    if (notes.length) {
      const events: NativeArrBassEvent[] = [];
      for (const e of bassTimelineNotes(notes)) {
        const at = Number(e.at ?? 0);
        if (e.slide) events.push({ kind: 'slide', t: at, note: Number(e.note ?? 0), value: Number(e.dur ?? 0) });
        else if (e.on) events.push({ kind: 'on', t: at, note: Number(e.note ?? 0), vel: Number(e.vel ?? 1) });
        else events.push({ kind: 'off', t: at, note: Number(e.note ?? 0) });
      }
      for (const b of bends) events.push({ kind: 'bend', t: b.time, value: b.semis });
      events.sort((a, b) => a.t - b.t);
      out.bass = events;
      out.bassPatch = arr.bassPatch;
    }
  }
  return out;
}

/**
 * The key maps for a native render. Every buffer a bounce reads is ALREADY in the shell's SampleStore, because the
 * live shadow uploaded it when the pad or lane was bound — so this resolves keys and waits for any first-sight
 * upload, and never sends audio itself. Null when no shadow is attached (not running in the shell).
 */
export async function nativeSampleKeys(
  engine: ChopperEngine,
  drumTracks: Array<{ key: TrackKey; buffer: AudioBuffer | null }>,
): Promise<NativeSampleKeys | null> {
  const shadow = nativeEngineShadow();
  if (!shadow) return null;
  const out: NativeSampleKeys = { sources: {}, drumLanes: {} };
  const waits: Array<Promise<boolean>> = [];
  const state = engine.getState();
  for (let i = 0; i < MAX_PADS; i++) {
    // TIME STRETCH: what the pad PLAYS, so the bounce is what he just heard. A slice that is not warm yet is
    // rendered by the page here and then uploaded — an export can afford the compute a hit cannot.
    let stretched: AudioBuffer | null = null;
    try {
      const r = engine.stretchedSliceFor(i);
      if (r?.warming) { await r.warming; stretched = engine.stretchedSliceFor(i)?.buffer ?? null; }
      else stretched = r?.buffer ?? null;
    } catch { stretched = null; }
    if (stretched) {
      const rec = shadow.ensure(stretched, 'stretch');
      (out.padSamples ??= {})[String(i)] = rec.key;
      waits.push(rec.ready);
    }
    let src: PadSource | null = null;
    try { src = engine.resolvePadSource(i); } catch { src = null; }
    if (!src?.buffer) continue;
    if (src.isPad) {
      const videoId = state.padBufferMeta?.[i]?.videoId;
      if (!videoId || out.sources[videoId]) continue;
      const rec = shadow.ensure(src.buffer, 'src');
      out.sources[videoId] = rec.key;
      waits.push(rec.ready);
    } else if (!out.main) {
      const rec = shadow.ensure(src.buffer, 'main');
      out.main = rec.key;
      waits.push(rec.ready);
    }
  }
  for (const t of drumTracks) {
    if (!t.buffer || out.drumLanes[t.key]) continue;
    const rec = shadow.ensure(t.buffer, 'drum');
    out.drumLanes[t.key] = rec.key;
    waits.push(rec.ready);
  }
  await Promise.all(waits);
  return out;
}
