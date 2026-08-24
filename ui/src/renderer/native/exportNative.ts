/**
 * Terminator 3.0 — the OFFLINE EXPORTER on the page side (Phase 4.5e).
 *
 * The renderer is entirely native: `native.exportProject` hands the shell the project JSON plus KEY MAPS into the
 * sample store (the audio is already there — the page uploaded it), and the shell renders it through the SAME
 * engine, mixer, sequencers and devices that are playing, then writes the WAVs. Nothing is rendered in Web Audio,
 * so "export == what you hear" is true by construction rather than by two implementations agreeing.
 */
import { isNative, native, onNativeEvent } from './juceBridge';

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
  /** 'wav' (default) · 'flac' · 'mp3'. The extension on `path` is replaced to match. */
  format?: 'wav' | 'flac' | 'mp3';
  /** MP3 only — the CBR bitrate (32..320, default 320). */
  mp3Kbps?: number;
  /** WAV 16/24/32 (32 = float) and FLAC 16/24. 16-bit is TPDF-dithered with the app's own quantiser, so a 16-bit
   *  WAV and FLAC of one render hold identical samples and match the Electron app's export sample for sample. */
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
  /** Job id — needed to report progress and to cancel. One is generated if you leave it out. */
  id?: string;
}

export interface NativeExportResult {
  ok: boolean;
  /** True when the render was cancelled: NO files were written, not even partial ones. */
  cancelled?: boolean;
  error?: string;
  files?: string[];
  seconds?: number;
  sampleRate?: number;
  bitDepth?: number;
  format?: string;
  /** Peak of the rendered master (0 = the export is silent — a failure, not a pass). */
  peak?: number;
}

let jobSeq = 0;

/** Render + write. Rejects outside the shell.
 *
 *  `onProgress` is called with 0..100 as the render advances. Call the returned `cancel()` to stop it: the render
 *  aborts at its next progress report and NOTHING is written — a cancelled export never leaves a half file behind.
 */
export function exportProjectNative(
  req: NativeExportRequest,
  onProgress?: (pct: number) => void,
): { done: Promise<NativeExportResult>; cancel: () => void; id: string } {
  const id = req.id ?? `export-${++jobSeq}`;
  const off = onProgress
    ? onNativeEvent('terminator.exportProgress', (e: { id?: string; pct?: number }) => {
        if (e?.id === id) onProgress(Number(e.pct ?? 0));
      })
    : () => {};
  const done = (native.exportProject({ ...req, id } as unknown as AnyRecord) as Promise<NativeExportResult>)
    .finally(off);
  return { done, cancel: () => { void native.exportProject({ verb: 'cancel', id }); }, id };
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
        const run = async (format: 'wav' | 'flac') => {
          const seen: number[] = [];
          const job = exportProjectNative(
            { project, sources: { probe: key }, path, format, bitDepth: 16, sampleRate: sr, tail: 0.2 },
            (pct) => seen.push(pct),
          );
          const res = await job.done;
          if (format === 'wav') r.progressReports = seen.length;
          let bytes = 0;
          // it must be a REAL file with real bytes, not just a promise that resolved
          if (res?.files?.length) {
            const stat = await native.fs({ verb: 'stat', path: res.files[0] });
            bytes = Number(stat?.size ?? 0);
            await native.fs({ verb: 'trash', path: res.files[0] });
          }
          return { ok: res?.ok === true, files: res?.files?.length ?? 0, bytes, peak: res?.peak ?? 0,
                   seconds: res?.seconds ?? 0, bitDepth: res?.bitDepth ?? 0, error: res?.error ?? null };
        };
        const wav = await run('wav');
        const flac = await run('flac');

        // CANCEL: a long render (many loops) stopped as soon as it reports progress must write NOTHING
        {
          const cancelPath = `${deps.tempDir()}${deps.sep()}terminator-export-cancel.wav`;
          const job = exportProjectNative(
            { project, sources: { probe: key }, path: cancelPath, bitDepth: 16, sampleRate: sr, loops: 64, tail: 0.2 },
            () => job.cancel(),
          );
          const res = await job.done;
          r.cancelled = res?.cancelled === true;
          r.cancelWroteNothing = (res?.files?.length ?? 0) === 0;
          const stat = await native.fs({ verb: 'stat', path: cancelPath });
          r.cancelLeftNoFile = !stat?.ok || Number(stat?.size ?? 0) === 0;
          if (stat?.ok) await native.fs({ verb: 'trash', path: cancelPath });
        }
        r.ok = wav.ok && flac.ok;
        r.files = wav.files;
        r.seconds = wav.seconds;
        r.bitDepth = wav.bitDepth;
        r.peak = wav.peak;
        r.bytes = wav.bytes;
        r.flacBytes = flac.bytes;
        // FLAC is lossless COMPRESSION: it must be smaller than the WAV and still have real content
        r.flacSmaller = flac.bytes > 0 && flac.bytes < wav.bytes;
        if (wav.error || flac.error) r.error = wav.error ?? flac.error;
      } catch (e) { r.error = String((e as Error)?.message ?? e); }
      finally { try { await native.samples({ verb: 'release', key }); } catch { /* nothing to release */ } }
      return r;
    },
  };
}
