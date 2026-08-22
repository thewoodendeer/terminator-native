/**
 * Export-format registry. Each handler turns the current engine state into
 * one downloadable blob and triggers a browser save. Future formats
 * (.mpcsample, .adg, .fpc, .mid) plug in here.
 */

import { ChopperEngine } from '../ChopperEngine';
import { buildMpcPattern } from './mpcPattern';
import { buildMpcSample } from './mpcSample';
import { buildDrumRackZip } from './drumRack';
import { buildMidi } from './midi';
import { buildZip } from './zipWriter';
import { deliverFiles } from '../../lib/download';
import { ExportFormat } from './formats';
import type { DrumEngine } from '../../drums/DrumEngine';
import type { Arrangement } from '../../arranger/types';

/** Unified-export context (desktop ChopperView): the live Beat Finisher
 *  arrangement + drum engine, so the main EXPORT section renders through the
 *  EXACT same arrangement pipeline as the Beat Finisher modal (mixer FX, send
 *  buses and master strip baked — see exportArrangement). Callers that don't
 *  pass it (HardwareView/mobile) keep the legacy per-format handlers below. */
export interface ExportRunContext {
  drumEngine: DrumEngine;
  arrangement: Arrangement;
  bpm: number;
}

// Re-export the lightweight metadata so existing imports from './exporters'
// keep working, while the heavy builders above only load when this module is
// dynamically imported (on export).
export { EXPORT_FORMATS } from './formats';
export type { ExportFormat, ExportFormatMeta } from './formats';

function safeFileName(s: string): string {
  return String(s).replace(/[/\\:*?"<>|\0]/g, '-').replace(/\s+/g, '_').slice(0, 80) || 'terminator';
}

/** Make the browser save `bytes` as `filename`. Same blob-download pattern
 *  the renderer already uses for stem exports. */
// Cross-platform delivery (anchor-download on desktop, Web Share on iOS so the
// embedded iframe doesn't navigate-to-blob and crash). Fire-and-forget keeps
// the existing sync call sites; the share starts within the click's activation.
function downloadBlob(filename: string, bytes: Uint8Array | ArrayBuffer | string, mime: string): void {
  void deliverFiles([{ name: filename, data: bytes, mime }]);
}

/** Run the chosen exporter. Returns a short status message on success or
 *  throws if the format isn't ready yet. With `ctx` (desktop), Master Mixdown /
 *  Trackouts / MPC render the Beat Finisher arrangement through the unified
 *  DAW pipeline and the Drum Rack gains the drum pads — identical output to the
 *  Beat Finisher modal's own export. Without it, the legacy handlers run. */
/** Targets whose bytes the USER consumes, so they can ship FLAC. MPC projects
 *  and Drum Racks are parsed by a sampler/DAW that reads WAV headers. */
export const FLAC_CAPABLE: ReadonlySet<ExportFormat> = new Set<ExportFormat>(['master-wav', 'wav-stems']);

export async function runExport(
  engine: ChopperEngine,
  format: ExportFormat,
  onProgress?: (pct: number) => void,
  ctx?: ExportRunContext,
  audioFormat: 'wav' | 'flac' = 'wav',
): Promise<string> {
  const state = engine.getState();
  const baseName = safeFileName(state.trackTitle || 'terminator');

  if (ctx) {
    // Lazy like the views' own imports — keeps the arrangement renderer out of
    // the initial bundle for callers that never pass a context (HardwareView).
    const { exportArrangement } = await import('../../arranger/exportArrangement');
    const arrOpts = {
      engine, drumEngine: ctx.drumEngine, arrangement: ctx.arrangement, bpm: ctx.bpm,
      title: state.trackTitle || 'terminator', bitDepth: 16 as const,
      // FLAC only reaches the targets that can take it (exportArrangement
      // enforces the same rule, so a stray caller can't hand MPC a FLAC).
      audioFormat: FLAC_CAPABLE.has(format) ? audioFormat : ('wav' as const),
      onProgress: (p: number) => onProgress?.(Math.round(p * 100)),
    };
    switch (format) {
      case 'master-wav': return exportArrangement({ ...arrOpts, target: 'master' });
      case 'wav-stems': return exportArrangement({ ...arrOpts, target: 'stems' });
      case 'mpc-sample': return exportArrangement({ ...arrOpts, target: 'mpc' });
      case 'drum-rack': {
        const res = await buildDrumRackZip(engine, baseName, { drumEngine: ctx.drumEngine, onProgress });
        downloadBlob(res.filename, res.bytes, 'application/zip');
        return `Drum Rack with ${res.padCount} pad${res.padCount === 1 ? '' : 's'} exported.`;
      }
      default: break; // the remaining formats are arrangement-independent
    }
  }

  switch (format) {
    case 'original-wav': {
      const out = engine.exportOriginal(24);
      downloadBlob(`${safeFileName(out.name)}.wav`, out.data, 'audio/wav');
      return 'Original track exported.';
    }
    case 'wav-stems': {
      const chops = await engine.exportChops(24, onProgress);
      if (chops.length === 0) throw new Error('No chops to export — chop the sample first.');
      const entries = chops.map(c => ({
        path: `${baseName}/${safeFileName(c.name)}.wav`,
        data: new Uint8Array(c.data),
      }));
      const zip = buildZip(entries);
      downloadBlob(`${baseName}-stems.zip`, zip, 'application/zip');
      return `${chops.length} chop${chops.length === 1 ? '' : 's'} exported.`;
    }
    case 'seq-wav': {
      const out = await engine.exportSeq(24);
      downloadBlob(`${safeFileName(out.name)}.wav`, out.data, 'audio/wav');
      return 'Sequence rendered.';
    }
    case 'seqs-zip': {
      const outs = await engine.exportSequences(24);
      const entries = outs.map(s => ({
        path: `${baseName}/${safeFileName(s.name)}.wav`,
        data: new Uint8Array(s.data),
      }));
      const zip = buildZip(entries);
      downloadBlob(`${baseName}-sequences.zip`, zip, 'application/zip');
      return `${outs.length} sequence${outs.length === 1 ? '' : 's'} rendered.`;
    }
    case 'master-wav': {
      const out = await engine.exportMaster(24);
      downloadBlob(`${safeFileName(out.name)}.wav`, out.data, 'audio/wav');
      return 'Master rendered.';
    }
    case 'mpc-pattern': {
      const json = buildMpcPattern(engine);
      // octet-stream so iOS share keeps the custom .mpcpattern extension.
      downloadBlob(`${baseName}.mpcpattern`, json, 'application/octet-stream');
      return 'MPC pattern exported.';
    }
    case 'mpc-sample': {
      // An MPC sample program needs the audio, not just the note data — so we
      // ship a folder (zipped) with one WAV per assigned pad plus the
      // .mpcsample, exactly like Drum Dojo. The MPC auto-assigns each
      // `PAD{NN}_…wav` to pad NN (note 36+idx), which matches the note events
      // buildMpcSample writes.
      const pads = await engine.exportChops(24, onProgress);
      if (pads.length === 0) throw new Error('No assigned pads to export — chop the sample and assign pads first.');
      const mpc = await buildMpcSample(engine);
      const entries = pads.map(p => ({
        path: `${baseName}/PAD${String(p.padIndex + 1).padStart(2, '0')}_${safeFileName(p.name)}.wav`,
        data: new Uint8Array(p.data),
      }));
      entries.push({ path: `${baseName}/${baseName}.mpcsample`, data: mpc });
      const zip = buildZip(entries);
      downloadBlob(`${baseName}-mpc.zip`, zip, 'application/zip');
      return `MPC project exported — ${pads.length} pad${pads.length === 1 ? '' : 's'} + sequences.`;
    }
    case 'drum-rack': {
      const res = await buildDrumRackZip(engine, baseName);
      downloadBlob(res.filename, res.bytes, 'application/zip');
      return `Drum Rack with ${res.padCount} pad${res.padCount === 1 ? '' : 's'} exported.`;
    }
    case 'midi': {
      const bytes = buildMidi(engine);
      downloadBlob(`${baseName}.mid`, bytes, 'audio/midi');
      return 'MIDI exported.';
    }
  }
}
