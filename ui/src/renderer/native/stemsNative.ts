/**
 * stemsNative — STEM SEPARATION in the JUCE shell (Phase 7.1c).
 *
 * The renderer's stems layer (stemsController.ts) was written against the Electron worker: it asks the host to
 * split, receives ready spans as Float32Arrays, owns the stem AudioBuffers, draws the waveform composite,
 * writes the FLAC assets and keeps the global cache. All of that is kept exactly as it is — this module just
 * makes the JUCE shell answer the same calls:
 *
 *   • the SPLIT runs inside Terminator (htdemucs through onnxruntime, in process — no Node child, no temp
 *     file). The renderer does not ship 170 MB of PCM to start it: the audio is ALREADY in the shell's sample
 *     store (the engine shadow uploaded it to play the pads), so the split takes the store KEY.
 *   • a ready span's PCM comes back as BYTES through the resource provider (`/blob/<token>`), not in the
 *     event payload — JUCE escapes C++→JS payloads into a JS string literal character by character, which a
 *     megabyte of floats would never survive. The fetch is binary and the order is preserved: `done` is not
 *     delivered until every chunk before it has been fetched and handed over (the ORDER TRAP the Electron
 *     path hit — finalizing on `done` while the last span was still in flight wrote assets missing spans).
 *   • the CACHE is the same JSON index in the same shape as Electron's stems-cache.json, under the app's
 *     presets folder — split a song once, ever.
 *
 * Models: the shell downloads htdemucs on first use (SHA-256 verified) into <dataDir>/stems/models. The
 * `models` phase of the progress line is that download.
 */
import { isNative, native, onNativeEvent } from './juceBridge';

type AnyRecord = Record<string, any>;
type Unsub = () => void;
type Span = { startSec: number; endSec: number };
type Quality = 'fast' | 'fine';

export interface StemsCacheEntry {
  quality: Quality;
  assets: Record<string, string>;
  readyRanges: Array<[number, number]>;
  sampleRate: number;
  frames: number;
  title: string;
  savedAt: number;
}
interface CacheIndex { version: number; entries: Record<string, Partial<Record<Quality, StemsCacheEntry>>> }
const CACHE_VERSION = 1;
const CACHE_MAX_KEYS = 300; // ~300 songs of index; the audio is capped by the asset store

export interface StemsNativeDeps {
  presetsDir: () => string;
  readJson: <T>(path: string) => Promise<T | null>;
  writeJson: (path: string, value: unknown) => Promise<{ ok: boolean; error?: string }>;
  join: (dir: string, name: string) => string;
}

/** The stems half of `window.terminator` — the same method names the Electron preload exposes. */
export function buildStemsOverlay(deps: StemsNativeDeps): AnyRecord {
  const cacheFile = () => deps.join(deps.presetsDir(), 'stems-cache.json');
  const readIndex = async (): Promise<CacheIndex> => {
    const raw = await deps.readJson<CacheIndex>(cacheFile());
    return raw && raw.version === CACHE_VERSION && raw.entries && typeof raw.entries === 'object'
      ? raw : { version: CACHE_VERSION, entries: {} };
  };
  const writeIndex = async (idx: CacheIndex) => {
    // Bounded like the Electron index: oldest-saved keys go first.
    const keys = Object.keys(idx.entries);
    if (keys.length > CACHE_MAX_KEYS) {
      const stamped = keys.map(k => {
        const e = idx.entries[k];
        return { k, at: Math.max(e?.fast?.savedAt ?? 0, e?.fine?.savedAt ?? 0) };
      }).sort((a, b) => a.at - b.at);
      for (const { k } of stamped.slice(0, keys.length - CACHE_MAX_KEYS)) delete idx.entries[k];
    }
    await deps.writeJson(cacheFile(), idx);
  };

  // ── the split, and the ordered delivery of its spans ──
  let chunkCb: ((c: { startFrame: number; endFrame: number; stems: Float32Array[] }) => void) | null = null;
  let progressCb: ((p: { phase: 'models' | 'load' | 'split'; pct: number; total?: number }) => void) | null = null;
  let doneCb: (() => void) | null = null;
  let errorCb: ((e: { message: string }) => void) | null = null;
  /** Every chunk fetch, in order — `done` waits on this so no span is still in flight when the page finalizes. */
  let chain: Promise<void> = Promise.resolve();

  const fetchChunk = async (payload: AnyRecord): Promise<void> => {
    const url = String(payload?.blob ?? '');
    const frames = Number(payload?.frames ?? 0) | 0;
    const planes = Number(payload?.planes ?? 8) | 0;
    if (!url || frames <= 0 || !chunkCb) return;
    const res = await fetch(new URL(url, location.href).href);
    if (!res.ok) throw new Error(`stems span fetch failed (${res.status})`);
    const buf = await res.arrayBuffer();
    if (buf.byteLength < frames * planes * 4) throw new Error('stems span is short');
    const stems: Float32Array[] = [];
    for (let p = 0; p < planes; p++) stems.push(new Float32Array(buf, p * frames * 4, frames));
    chunkCb({ startFrame: Number(payload.startFrame) | 0, endFrame: Number(payload.endFrame) | 0, stems });
  };

  if (isNative()) {
    onNativeEvent('terminator.stemsChunk', (payload: AnyRecord) => {
      chain = chain.then(() => fetchChunk(payload)).catch(e => {
        errorCb?.({ message: String((e as any)?.message ?? e) });
      });
    });
    onNativeEvent('terminator.stemsProgress', (p: AnyRecord) => {
      const phase = p?.phase === 'models' || p?.phase === 'load' ? p.phase : 'split';
      progressCb?.({ phase, pct: Math.max(0, Math.min(100, Number(p?.pct) || 0)), total: p?.total });
    });
  }

  const splitDone = (): Promise<{ ok: true } | { error: string }> => new Promise(resolve => {
    let settled = false;
    const offDone = onNativeEvent('terminator.stemsDone', (d: AnyRecord) => {
      // the spans first: the page finalizes on done, and a span still being fetched would be lost
      void chain.then(() => {
        if (settled) return;
        settled = true; offDone(); offErr(); doneCb?.();
        // A cancel keeps the spans that landed — the controller persists them under its own cancel branch,
        // which it only takes for this exact error string (the Electron worker's).
        resolve(d?.cancelled ? { error: 'cancelled' } : { ok: true });
      });
    });
    const offErr = onNativeEvent('terminator.stemsError', (e: AnyRecord) => {
      if (settled) return;
      settled = true; offDone(); offErr();
      const message = String(e?.message ?? 'split failed');
      errorCb?.({ message });
      resolve({ error: message });
    });
  });

  return {
    /** NATIVE MARKER: the controller passes `key` (the shadow's store key) instead of copying the PCM. */
    stemsNative: true,
    stemsSplit: async (opts: AnyRecord) => {
      const key = String(opts?.key ?? '');
      if (!key) return { error: 'native stems need the sample key' };
      const finished = splitDone();
      const r = await native.stems({
        verb: 'split', key,
        quality: opts?.quality === 'fine' ? 'fine' : 'fast',
        windows: Array.isArray(opts?.windows) ? opts.windows.map((w: Span) => ({ startSec: w.startSec, endSec: w.endSec })) : [],
        sweep: !!opts?.sweep,
      });
      if (!r?.ok) return { error: r?.error ?? 'split failed' };
      return finished;
    },
    stemsQueueWindow: async (span: Span) => {
      const r = await native.stems({ verb: 'queueWindow', span: { startSec: span.startSec, endSec: span.endSec } });
      return r?.ok ? { ok: true } : { error: r?.error ?? 'queue failed' };
    },
    stemsCancel: async () => { await native.stems({ verb: 'cancel' }); return { ok: true }; },
    stemsStatus: async () => native.stems({ verb: 'status' }),
    stemsDownloadModels: async (quality: Quality) => native.stems({ verb: 'downloadModels', quality }),
    stemsDeleteModels: async (quality: Quality) => native.stems({ verb: 'deleteModels', quality }),

    onStemsChunk: (cb: (c: { startFrame: number; endFrame: number; stems: Float32Array[] }) => void): Unsub => {
      chunkCb = cb; return () => { if (chunkCb === cb) chunkCb = null; };
    },
    onStemsProgress: (cb: (p: { phase: 'models' | 'load' | 'split'; pct: number; total?: number }) => void): Unsub => {
      progressCb = cb; return () => { if (progressCb === cb) progressCb = null; };
    },
    onStemsDone: (cb: () => void): Unsub => { doneCb = cb; return () => { if (doneCb === cb) doneCb = null; }; },
    onStemsError: (cb: (e: { message: string }) => void): Unsub => { errorCb = cb; return () => { if (errorCb === cb) errorCb = null; }; },

    // ── the global cache (same file name, same shape as Electron's) ──
    stemsCacheGet: async (key: string, quality: Quality): Promise<StemsCacheEntry | null> => {
      const idx = await readIndex();
      return idx.entries[key]?.[quality] ?? null;
    },
    stemsCachePut: async (key: string, entry: StemsCacheEntry) => {
      if (!key || !entry || (entry.quality !== 'fast' && entry.quality !== 'fine')) return { error: 'bad cache entry' };
      const idx = await readIndex();
      idx.entries[key] = { ...(idx.entries[key] ?? {}), [entry.quality]: { ...entry, savedAt: Date.now() } };
      await writeIndex(idx);
      return { ok: true };
    },
    stemsCacheDrop: async (key: string, quality?: Quality) => {
      const idx = await readIndex();
      if (!idx.entries[key]) return { ok: true };
      if (quality) delete idx.entries[key][quality]; else delete idx.entries[key];
      if (idx.entries[key] && Object.keys(idx.entries[key]).length === 0) delete idx.entries[key];
      await writeIndex(idx);
      return { ok: true };
    },
  };
}

declare global {
  interface Window { __terminatorNativeStems?: { selfTest: () => Promise<AnyRecord> } }
}

/** Probe hook: the whole native stems path without a click — the verb answers, the models are reported, and
 *  (when a model is on the machine and TERMINATOR_PROBE_STEMS is set) a real 2-second split runs and its span
 *  comes back through the blob fetch with audio in it. */
export function installStemsProbe(): void {
  if (!isNative()) return;
  window.__terminatorNativeStems = {
    selfTest: async () => {
      const r: AnyRecord = {};
      const t = (window as any).terminator as AnyRecord;
      try {
        const status = await native.stems({ verb: 'status' });
        r.ortLoaded = status?.available === true;
        r.ort = status?.ort ?? '';
        r.unavailable = status?.unavailable;
        r.models = (status?.models ?? []).map((m: AnyRecord) => ({ quality: m.quality, ready: !!m.ready }));
        r.bridgeOk = typeof t?.stemsSplit === 'function' && typeof t?.onStemsChunk === 'function';
        // an unknown key must be refused, not started (and must not leave the hub busy)
        const bad = await native.stems({ verb: 'split', key: 'no-such-key' });
        r.refusesUnknownKey = bad?.ok === false;
        // the cache round-trips through the same JSON shape the Electron app writes
        const key = 'probe-cache-key';
        await t.stemsCachePut(key, { quality: 'fast', assets: { drums: 'asset:probe' }, readyRanges: [[0, 1]], sampleRate: 48000, frames: 48000, title: 'probe', savedAt: 0 });
        const got = await t.stemsCacheGet(key, 'fast');
        r.cacheRoundTrip = got?.quality === 'fast' && got?.assets?.drums === 'asset:probe';
        await t.stemsCacheDrop(key);
        r.cacheDropped = (await t.stemsCacheGet(key, 'fast')) === null;

        const wantSplit = !!(window as any).__terminatorProbeStems;
        const fastReady = (status?.models ?? []).some((m: AnyRecord) => m.quality === 'fast' && m.ready);
        r.splitRan = false;
        if (wantSplit && r.ortLoaded && fastReady) {
          // 2 s of a tone into the store, then a real split of it: one chunk of the model's grid.
          const sr = 44100, frames = sr * 2, sampleKey = 'stems-probe';
          const pcm = new Float32Array(frames);
          for (let i = 0; i < frames; i++) pcm[i] = 0.3 * Math.sin(2 * Math.PI * 110 * i / sr) + 0.2 * Math.sin(2 * Math.PI * 1500 * i / sr);
          const begun = await native.samples({ verb: 'begin', key: sampleKey, sampleRate: sr, channels: 1, frames });
          if (begun?.ok) {
            const bytes = new Uint8Array(pcm.buffer);
            let bin = ''; for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
            await native.samples({ verb: 'chunk', key: sampleKey, offset: 0, data: btoa(bin) });
            await native.samples({ verb: 'end', key: sampleKey });
            const spans: Array<{ start: number; end: number; peak: number }> = [];
            const phases = new Set<string>();
            const offChunk = t.onStemsChunk((c: { startFrame: number; endFrame: number; stems: Float32Array[] }) => {
              let peak = 0;
              for (const plane of c.stems) for (let i = 0; i < plane.length; i += 37) peak = Math.max(peak, Math.abs(plane[i]));
              spans.push({ start: c.startFrame, end: c.endFrame, peak });
            });
            const offProgress = t.onStemsProgress((p: AnyRecord) => phases.add(String(p.phase)));
            const started = Date.now();
            const res = await t.stemsSplit({ key: sampleKey, srcRate: sr, quality: 'fast', windows: [], sweep: true });
            offChunk(); offProgress();
            r.splitRan = true;
            r.splitOk = (res as AnyRecord)?.ok === true;
            r.splitError = (res as AnyRecord)?.error;
            r.splitSeconds = Math.round((Date.now() - started) / 100) / 10;
            r.spans = spans.length;
            r.spanFrames = spans.reduce((n, s) => n + (s.end - s.start), 0);
            r.spanPeak = Math.round(Math.max(0, ...spans.map(s => s.peak)) * 1000) / 1000;
            r.phases = [...phases];
            await native.samples({ verb: 'release', key: sampleKey });
          } else {
            r.splitError = begun?.error ?? 'upload failed';
          }
        }
      } catch (e) {
        r.error = String((e as any)?.stack ?? (e as any)?.message ?? e);
      }
      return r;
    },
  };
}
