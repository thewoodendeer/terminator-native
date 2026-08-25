/**
 * Terminator 3.0 — THE EXPORT RENDERS NATIVELY (Phase 4.7b).
 *
 * The Beat Finisher master / trackouts used to be rendered by the page's Web Audio mixer, which meant the FILE was a
 * second engine's opinion of the beat: the native console, PDC, safety limiter and every premium (native-only)
 * device were simply absent from it. This routes those two targets at the shell instead — one save dialog, then
 * `terminatorExport` renders the song through the SAME engine, mixer and devices that are playing and writes the
 * files itself.
 *
 * What is unchanged: the page still decides WHAT plays and WHEN (`buildNativeArrangement` reuses the arranger's own
 * flatteners), the STEM channel list is still the page's (`drumPlanFor` / `routesForEvents` / the active sends), and
 * MPC Project / Drum Rack still run on the page's exporters — the native renderer has no .mpcsample or .adg writer.
 *
 * Cancel keeps the same rule as everywhere else: the render aborts at its next progress point and NOTHING is
 * written, so a cancelled export never leaves a half file behind.
 */
import type { Arrangement } from '../arranger/types';
import type { ChopperEngine } from '../chopper/ChopperEngine';
import type { DrumEngine, TrackKey } from '../drums/DrumEngine';
import { SEND_CHANNELS, type ChannelName, type MixerEngine } from '../../mixer/MixerEngine';
import { buildNativeArrangement, nativeSampleKeys } from './arrangementNative';
import { exportProjectNative } from './exportNative';
import { isNative, native } from './juceBridge';

export interface NativeArrangementExportOpts {
  engine: ChopperEngine;
  drumEngine: DrumEngine;
  mixer: MixerEngine | null;
  arrangement: Arrangement;
  bpm: number;
  project: Record<string, unknown>;
  title: string;
  target: 'master' | 'stems';
  audioFormat: 'wav' | 'flac' | 'mp3';
  bitDepth: 16 | 24;
  mp3Kbps?: number;
  onProgress?: (pct: number, label: string) => void;
  shouldCancel?: () => boolean;
}

/** Thrown when the user cancelled — the same contract the page's exporter has (nothing happened, not a failure). */
export class NativeExportCancelled extends Error {
  constructor() {
    super('Export cancelled');
    this.name = 'ExportCancelled';
  }
}

const safeName = (s: string): string =>
  String(s).replace(/[/\\:*?"<>|\0]/g, '-').replace(/\s+/g, '_').slice(0, 80) || 'beat';

/** The mixer channels a trackout export writes, in the page's own order: the chop routes in play, the drum lanes'
 *  channels, the bass, then every ACTIVE send — deduped, because several drum lanes share one channel. */
async function stemChannelsFor(
  opts: NativeArrangementExportOpts,
  drumTracks: Array<{ key: TrackKey; buffer: AudioBuffer | null; volume: number; audible: boolean }>,
): Promise<string[]> {
  const { engine, mixer, arrangement } = opts;
  if (!mixer) return [];
  const { drumPlanFor } = await import('../arranger/renderArrangementDAW');
  const { buildChopEvents } = await import('../arranger/exportArrangement');
  const audible = (c: ChannelName) => mixer.channels.has(c) && mixer.isChannelAudible(c);
  const out: string[] = [];
  const push = (c: string) => {
    if (c && !out.includes(c)) out.push(c);
  };
  const chopEvents = buildChopEvents(arrangement, 60 / Math.max(1, opts.bpm));
  for (const r of engine.routesForEvents(chopEvents))
    if (audible(r)) push(r);
  const playing = drumTracks.filter((t) => t.audible && t.buffer && t.volume > 0).map((t) => t.key);
  for (const d of drumPlanFor(playing))
    if (audible(d.channel)) push(d.channel);
  if (arrangement.bassPatch && audible('bass')) push('bass');
  for (const s of SEND_CHANNELS)
    if (mixer.isSendActive(s) && audible(s)) push(s);
  return out;
}

/**
 * Render + write the arrangement through the shell. Returns the status line for the UI.
 * Throws `NativeExportCancelled` when the user cancels, and a plain Error when the shell reports a failure.
 */
export async function exportArrangementNative(opts: NativeArrangementExportOpts): Promise<string> {
  if (!isNative()) throw new Error('the native exporter needs the Terminator shell');
  const report = (pct: number, label: string) => {
    if (opts.shouldCancel?.()) throw new NativeExportCancelled();
    opts.onProgress?.(pct, label);
  };

  report(0.04, 'Loading drum samples…');
  await opts.drumEngine.preload?.();
  const drumTracks = await opts.drumEngine.getExportTracks();

  report(0.08, 'Reading the arrangement…');
  const arrangement = buildNativeArrangement(opts.arrangement, opts.bpm, opts.drumEngine, drumTracks);
  if (!arrangement.hits.length && !arrangement.bass?.length)
    throw new Error('Nothing to export — add chops, drums or bass to the arrangement.');
  const keys = await nativeSampleKeys(opts.engine, drumTracks);
  if (!keys) throw new Error('the engine bridge is not attached — nothing to render');
  const stems = opts.target === 'stems' ? await stemChannelsFor(opts, drumTracks) : [];

  // WHERE it goes: one dialog, even for trackouts — the user names the master and the stems land beside it, which is
  // what a DAW does. A cancelled dialog writes nothing.
  const base = safeName(opts.title || 'beat-finisher');
  // Every container is written by the shell itself — WAV and FLAC through JUCE, MP3 through the `lame` that ships
  // in the bundle — so there is no transcode step and no intermediate file to clean up.
  const ext = opts.audioFormat;
  const chosen = await native.fs({ verb: 'saveDialog', title: 'Export', defaultName: `${base}-master.${ext}` });
  if (!chosen?.ok || !chosen?.path) throw new NativeExportCancelled();
  const path = String(chosen.path);

  report(0.12, opts.target === 'stems' ? 'Rendering trackouts…' : 'Rendering…');
  const job = exportProjectNative(
    {
      project: opts.project,
      main: keys.main,
      sources: keys.sources,
      padSamples: keys.padSamples,
      drumLanes: keys.drumLanes,
      path,
      format: opts.audioFormat,
      mp3Kbps: opts.mp3Kbps,
      bitDepth: opts.bitDepth,
      sampleRate: opts.engine.buffer?.sampleRate,
      tail: 2.5,
      mixer: true,
      drums: true,
      bass: true,
      limiter: true,
      stems,
      arrangement,
    },
    (pct) => {
      // the render owns 12 → 95 %
      if (opts.shouldCancel?.()) job.cancel();
      opts.onProgress?.(0.12 + (pct / 100) * 0.83, opts.target === 'stems' ? 'Rendering trackouts…' : 'Rendering…');
    },
  );
  const res = await job.done;
  if (res?.cancelled) throw new NativeExportCancelled();
  if (!res?.ok) throw new Error(res?.error ?? 'the render failed');
  if (!(res.peak && res.peak > 0)) throw new Error('the render came out SILENT — nothing was written that you could hear');

  void native.fs({ verb: 'reveal', path: res.files?.[0] ?? path });
  opts.onProgress?.(1, 'Done');
  const n = res.files?.length ?? 1;
  return opts.target === 'stems'
    ? `${n} trackout${n === 1 ? '' : 's'} exported (rendered by the engine).`
    : `Master ${ext.toUpperCase()} exported (rendered by the engine).`;
}
