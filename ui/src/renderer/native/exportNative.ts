/**
 * Terminator 3.0 — the OFFLINE EXPORTER on the page side (Phase 4.5e).
 *
 * The renderer is entirely native: `native.exportProject` hands the shell the project JSON plus KEY MAPS into the
 * sample store (the audio is already there — the page uploaded it), and the shell renders it through the SAME
 * engine, mixer, sequencers and devices that are playing, then writes the WAVs. Nothing is rendered in Web Audio,
 * so "export == what you hear" is true by construction rather than by two implementations agreeing.
 */
import { isNative, native } from './juceBridge';

type AnyRecord = Record<string, unknown>;

export interface NativeExportRequest {
  /** The project as the page serializes it (ChopperEngine.serialize()). */
  project: AnyRecord;
  /** Store key of the main track (main-track chops read it). */
  main?: string;
  /** videoId → store key, for pad-source pads. */
  sources?: Record<string, string>;
  /** drum lane key ('kick', …) → store key. */
  drumLanes?: Record<string, string>;
  /** Absolute output path for the master WAV; trackouts land beside it as "<name> - <channel>.wav". */
  path: string;
  bitDepth?: 16 | 24 | 32;
  sampleRate?: number;
  loops?: number;
  tail?: number;
  /** Defaults: the mix, the drums, the bass and the master's safety limiter are all IN. */
  mixer?: boolean;
  drums?: boolean;
  bass?: boolean;
  limiter?: boolean;
  /** Channel names to write as trackouts, one stereo file each. */
  stems?: string[];
}

export interface NativeExportResult {
  ok: boolean;
  error?: string;
  files?: string[];
  seconds?: number;
  sampleRate?: number;
  bitDepth?: number;
  /** Peak of the rendered master (0 = the export is silent — a failure, not a pass). */
  peak?: number;
}

/** Render + write. Rejects outside the shell. */
export function exportProjectNative(req: NativeExportRequest): Promise<NativeExportResult> {
  return native.exportProject(req as unknown as AnyRecord) as Promise<NativeExportResult>;
}

declare global {
  interface Window {
    __terminatorNativeExport?: { selfTest: () => Promise<AnyRecord> };
  }
}

/** Probe hook: render a tiny synthetic project end to end and confirm real WAVs land on disk. */
export function installExportProbe(deps: { tempDir: () => string; sep: () => string }): void {
  if (!isNative()) return;
  window.__terminatorNativeExport = {
    selfTest: async () => {
      const r: AnyRecord = {};
      const key = 'export-probe';
      const path = `${deps.tempDir()}${deps.sep()}terminator-export-probe.wav`;
      try {
        // a 0.25 s decaying burst straight into the sample store (the same begin/chunk/end the shadow uses)
        const sr = 48000, frames = 12000;
        const pcm = new Float32Array(frames);
        for (let i = 0; i < frames; i++) pcm[i] = Math.exp(-8 * i / frames) * Math.sin(2 * Math.PI * 220 * i / sr);
        const begun = await native.samples({ verb: 'begin', key, sampleRate: sr, channels: 1, frames });
        r.uploaded = begun?.ok === true;
        if (!r.uploaded) { r.error = begun?.error ?? 'begin failed'; return r; }
        const bytes = new Uint8Array(pcm.buffer);
        let bin = '';
        for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
        await native.samples({ verb: 'chunk', key, offset: 0, data: btoa(bin) });
        await native.samples({ verb: 'end', key });

        const project = {
          pads: [{ index: 0, chopId: null, mode: 'oneshot', pitch: 0 }],
          padBufferMeta: { 0: { videoId: 'probe', title: 'probe', start: 0, end: 0.25 } },
          sequences: [{ bars: 1, resolution: 16, viewResolution: 16, loop: true, grid: [[0]], velGrid: [[1]], revGrid: [] }],
          currentSeqIdx: 0,
          metronomeBpm: 120,
          chopVolume: 1,
        };
        const res = await exportProjectNative({
          project, sources: { probe: key }, path, bitDepth: 16, sampleRate: sr, tail: 0.2,
        });
        r.ok = res?.ok === true;
        r.files = res?.files?.length ?? 0;
        r.seconds = res?.seconds ?? 0;
        r.bitDepth = res?.bitDepth ?? 0;
        r.peak = res?.peak ?? 0;
        if (res?.error) r.error = res.error;
        // it must be a REAL file with real bytes, not just a promise that resolved
        if (res?.files?.length) {
          const stat = await native.fs({ verb: 'stat', path: res.files[0] });
          r.bytes = Number(stat?.size ?? 0);
          await native.fs({ verb: 'trash', path: res.files[0] });
        }
      } catch (e) { r.error = String((e as Error)?.message ?? e); }
      finally { try { await native.samples({ verb: 'release', key }); } catch { /* nothing to release */ } }
      return r;
    },
  };
}
