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
  /** <dataDir>/assets — where finalize() writes the four `<title> — DRUMS.stems.flac` assets. */
  assetsDir: () => string;
  /** The app settings, for the ONE thing the shell cannot remember for itself: a relocated models folder. */
  getSettings: () => Promise<AnyRecord>;
  setSettings: (patch: AnyRecord) => Promise<AnyRecord>;
  readJson: <T>(path: string) => Promise<T | null>;
  writeJson: (path: string, value: unknown) => Promise<{ ok: boolean; error?: string }>;
  join: (dir: string, name: string) => string;
}

// ── Preferences → Stems: what stem separation keeps on disk ────────────────────────────────────────────────
// Ported from the Electron app's main/diskUsage.ts (scanStemAssets / groupStemSongs / stemSongTitleOf) and its
// stems:usage · clearAudio · deleteSongStems · reveal* handlers. The layout is the same store — <hash>.<ext>
// plus a <hash>.json sidecar carrying the original NAME — so the filter is that name's '.stems.flac' suffix
// (older '.stems.wav' assets still count). Deleting stem audio is SAFE: the masks ride the project JSON, a
// project whose assets are gone shows needs-resplit and plays the originals.
type StemAsset = { dataFile: string; sidecar: string; bytes: number; name: string };
const STEM_NAME = /\.stems\.(wav|flac)$/;
const STEM_ROW = /\s—\s(DRUMS|BASS|OTHER|VOCALS)\.stems\.(wav|flac)$/;
/** The song a stem asset belongs to: its name minus the ' — DRUMS.stems.flac' stamp finalize() writes (a
 *  title containing ' — ' itself survives — only the known stem suffix is stripped). */
export const stemSongTitleOf = (name: string): string =>
  STEM_ROW.test(name) ? name.replace(STEM_ROW, '') : name.replace(STEM_NAME, '');
export function groupStemSongs(assets: StemAsset[]): Array<{ title: string; bytes: number; files: number }> {
  const byTitle = new Map<string, { title: string; bytes: number; files: number }>();
  for (const a of assets) {
    const title = stemSongTitleOf(a.name);
    const g = byTitle.get(title) ?? { title, bytes: 0, files: 0 };
    g.bytes += a.bytes; g.files++;
    byTitle.set(title, g);
  }
  return [...byTitle.values()].sort((a, b) => b.bytes - a.bytes);
}
/** `asset:<sha1>` → the bare hash the store files are named by. */
const hashOf = (id: unknown): string => String(id ?? '').replace(/^asset:/, '').toLowerCase();

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

  // ── the models on disk, and what Preferences shows about them ──
  /** Which engine is downloading right now (either window can have started it — the models progress event
   *  carries the quality, so both agree). */
  let downloading: Quality | null = null;
  const modelProgressCbs = new Set<(p: { quality: Quality; pct: number }) => void>();
  if (isNative()) {
    onNativeEvent('terminator.stemsProgress', (p: AnyRecord) => {
      if (p?.phase !== 'models') return;
      const quality: Quality = p?.quality === 'fine' ? 'fine' : 'fast';
      downloading = quality;
      const pct = Math.max(0, Math.min(100, Number(p?.pct) || 0));
      for (const cb of modelProgressCbs) cb({ quality, pct });
    });
    onNativeEvent('terminator.stemsModels', () => { downloading = null; });
  }
  /** The shell answers a download verb at once and finishes on `terminator.stemsModels`; Preferences awaits the
   *  call (the Electron handler awaited ensureModels), so resolve on the completion event. */
  const downloadModels = (quality: Quality): Promise<{ ok: boolean; error?: string }> => new Promise(resolve => {
    let settled = false;
    const off = onNativeEvent('terminator.stemsModels', (d: AnyRecord) => {
      if (settled || (d?.quality && d.quality !== quality)) return;
      settled = true; off(); downloading = null;
      resolve(d?.ready ? { ok: true } : { ok: false, error: String(d?.error ?? 'download failed') });
    });
    downloading = quality;
    void native.stems({ verb: 'downloadModels', quality }).then(r => {
      if (settled || r?.ok) return;
      settled = true; off(); downloading = null;
      resolve({ ok: false, error: String(r?.error ?? 'download failed') });
    });
  });

  // ── the stem audio in the asset store ──
  const MAX_SIDECARS = 4000; // a bounded scan: the store is content-addressed and can hold a lot of samples
  const scanStemAssets = async (): Promise<StemAsset[]> => {
    const r = await native.fs({ verb: 'list', dir: deps.assetsDir() });
    if (!r?.ok || !Array.isArray(r.entries)) return [];
    const data = new Map<string, { path: string; bytes: number }>();
    const sidecars: Array<{ hash: string; path: string }> = [];
    for (const e of r.entries as AnyRecord[]) {
      if (e?.isDir) continue;
      const fileName = String(e?.fileName ?? '');
      const dot = fileName.indexOf('.');
      if (dot <= 0) continue;
      const hash = fileName.slice(0, dot).toLowerCase();
      if (fileName.toLowerCase().endsWith('.json')) sidecars.push({ hash, path: String(e.path) });
      else if (!data.has(hash)) data.set(hash, { path: String(e.path), bytes: Number(e.size) || 0 });
    }
    const wanted = sidecars.filter(x => data.has(x.hash)).slice(0, MAX_SIDECARS);
    const out: StemAsset[] = [];
    for (let i = 0; i < wanted.length; i += 8) { // batched: every sidecar read is a bridge round trip
      const batch = wanted.slice(i, i + 8);
      const metas = await Promise.all(batch.map(x => deps.readJson<{ name?: string }>(x.path).catch(() => null)));
      metas.forEach((meta, k) => {
        const name = typeof meta?.name === 'string' ? meta.name : '';
        if (!STEM_NAME.test(name)) return;
        const d = data.get(batch[k].hash)!;
        out.push({ dataFile: d.path, sidecar: batch[k].path, bytes: d.bytes, name });
      });
    }
    return out;
  };
  /** The shortcut goes with the audio: a cache entry pointing at a deleted asset would "find" stems whose
   *  files are gone. `null` = drop every entry (CLEAR ALL). */
  const dropCacheFor = async (hashes: Set<string> | null): Promise<void> => {
    const idx = await readIndex();
    if (hashes === null) { await writeIndex({ version: CACHE_VERSION, entries: {} }); return; }
    let changed = false;
    for (const key of Object.keys(idx.entries)) {
      const byQuality = idx.entries[key] ?? {};
      for (const q of Object.keys(byQuality) as Quality[]) {
        const entry = byQuality[q];
        if (!entry || !Object.values(entry.assets ?? {}).some(id => hashes.has(hashOf(id)))) continue;
        delete byQuality[q]; changed = true;
      }
      if (Object.keys(byQuality).length === 0) { delete idx.entries[key]; changed = true; }
    }
    if (changed) await writeIndex(idx);
  };
  /** Trash the matching stem assets (data + sidecar) and forget them. `title` null = every song. */
  const removeStemAudio = async (title: string | null): Promise<{ ok: boolean; deleted?: number; bytes?: number; error?: string }> => {
    const status = await native.stems({ verb: 'status' }).catch(() => null);
    if (status?.busy) return { ok: false, error: 'a split is running — cancel it first' };
    const assets = await scanStemAssets();
    let deleted = 0, bytes = 0;
    const gone = new Set<string>();
    for (const a of assets) {
      if (title !== null && stemSongTitleOf(a.name) !== title) continue;
      const d = await native.fs({ verb: 'trash', path: a.dataFile });
      if (!d?.ok) continue; // leave what will not delete, and keep its shortcut
      await native.fs({ verb: 'trash', path: a.sidecar });
      deleted++; bytes += a.bytes;
      const fileName = a.dataFile.split(/[\\/]/).pop() ?? '';
      gone.add(fileName.slice(0, Math.max(0, fileName.indexOf('.'))).toLowerCase());
    }
    await dropCacheFor(title === null ? null : gone).catch(() => { /* the index rebuilds itself */ });
    return { ok: true, deleted, bytes };
  };
  /** Where the engines live. The shell adopts the Electron app's folder at startup when ours is empty, but a
   *  folder the USER picked has to survive a relaunch — the shell has no settings of its own, so it is stored
   *  here and re-applied on boot (`applyModelsDirSetting`). */
  const modelsDirInfo = async (): Promise<{ path: string; isDefault: boolean }> => {
    const status = await native.stems({ verb: 'status' }).catch(() => null);
    return { path: String(status?.modelsDir ?? ''), isDefault: status?.modelsDirIsDefault !== false };
  };
  const setModelsDir = async (path: string | null): Promise<{ path: string; isDefault: boolean; ok: boolean; error?: string }> => {
    const r = await native.stems({ verb: 'modelsDir', path: path ?? '' });
    await deps.setSettings({ stemsModelsDir: path ?? null }).catch(() => ({}));
    return { ok: !!r?.ok || r?.modelsDir !== undefined, path: String(r?.modelsDir ?? ''), isDefault: r?.modelsDirIsDefault !== false };
  };

  const revealDir = async (dir: string): Promise<{ ok: boolean; error?: string }> => {
    if (!dir) return { ok: false, error: 'no folder' };
    await native.fs({ verb: 'mkdir', path: dir });
    const r = await native.fs({ verb: 'openPath', path: dir });
    return r?.ok ? { ok: true } : { ok: false, error: String(r?.error ?? 'could not open the folder') };
  };

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

    // ── Preferences → Stems (the Electron pane's contract, answered by the shell) ──
    stemsDownloadModels: (quality: Quality) => downloadModels(quality === 'fine' ? 'fine' : 'fast'),
    stemsDeleteModels: async (quality: Quality) => {
      const r = await native.stems({ verb: 'deleteModels', quality: quality === 'fine' ? 'fine' : 'fast' });
      return r?.ok ? { ok: true } : { ok: false, error: String(r?.error ?? 'could not delete') };
    },
    onStemsModelProgress: (cb: (p: { quality: Quality; pct: number }) => void): Unsub => {
      modelProgressCbs.add(cb); return () => { modelProgressCbs.delete(cb); };
    },
    stemsUsage: async () => {
      const status = await native.stems({ verb: 'status' }).catch(() => null);
      const models = (Array.isArray(status?.models) ? status!.models : []).map((m: AnyRecord) => ({
        quality: m?.quality === 'fine' ? 'fine' : 'fast' as Quality,
        bytes: Number(m?.bytes) || 0,
        expectedBytes: Number(m?.expectedBytes) || 0,
        ready: !!m?.ready,
        downloading: downloading === (m?.quality === 'fine' ? 'fine' : 'fast'),
      }));
      const assets = await scanStemAssets();
      return {
        models,
        modelsDir: String(status?.modelsDir ?? ''),
        audio: { bytes: assets.reduce((n, a) => n + a.bytes, 0), count: assets.length },
        songs: groupStemSongs(assets),
      };
    },
    stemsClearAudio: () => removeStemAudio(null),
    stemsDeleteSongStems: (title: string) =>
      (typeof title === 'string' && title ? removeStemAudio(title) : Promise.resolve({ ok: false, error: 'bad title' })),
    stemsRevealModels: async () => {
      const status = await native.stems({ verb: 'status' }).catch(() => null);
      return revealDir(String(status?.modelsDir ?? ''));
    },
    stemsRevealAudio: () => revealDir(deps.assetsDir()),
    stemsModelsDir: () => modelsDirInfo(),
    stemsChooseModelsDir: async () => {
      const cur = await modelsDirInfo();
      const r = await native.fs({ verb: 'openDialog', mode: 'dir', title: 'Keep the split engines in…', dir: cur.path });
      if (!r?.ok || !r.path) return { ...cur, cancelled: true };
      // An already-filled folder is ADOPTED as it stands (that is how a machine holding the Electron app's
      // models skips the 166 MB download) — nothing is copied or moved.
      return setModelsDir(String(r.path));
    },
    stemsResetModelsDir: () => setModelsDir(null),

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

/** Re-apply a models folder the user picked in Preferences (the shell starts on its default / the adopted
 *  Electron folder every launch). Call once at install, before anything can start a split. */
export async function applyModelsDirSetting(getSettings: () => Promise<AnyRecord>): Promise<void> {
  if (!isNative()) return;
  try {
    const saved = (await getSettings())?.stemsModelsDir;
    if (typeof saved === 'string' && saved) await native.stems({ verb: 'modelsDir', path: saved });
  } catch { /* a bad saved path just leaves the default in place */ }
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

        // PREFERENCES → STEMS (7.4): the pane's whole contract, without a click. A fake stem asset is written
        // into the store with a real cache shortcut pointing at it; usage has to SEE it as a song, and the
        // pane's per-song DELETE has to take both the files and the shortcut with it.
        const usage = await t.stemsUsage();
        r.usageModelsDir = typeof usage?.modelsDir === 'string' && usage.modelsDir.length > 0;
        r.usageQualities = (usage?.models ?? []).map((m: AnyRecord) => m.quality).join(',');
        const probeHash = 'ffffffffffffffffffffffffffffffffffffffff';
        const probeTitle = 'probe stems song';
        const wav = new Uint8Array(2048);
        r.probeAssetPut = (await t.assetPut(probeHash, `${probeTitle} — DRUMS.stems.flac`, 'audio/flac', wav))?.ok === true;
        await t.stemsCachePut('probe-usage-key', { quality: 'fast', assets: { drums: `asset:${probeHash}` }, readyRanges: [[0, 1]], sampleRate: 44100, frames: 44100, title: probeTitle, savedAt: 0 });
        const withProbe = await t.stemsUsage();
        r.usageSeesSong = (withProbe?.songs ?? []).some((x: AnyRecord) => x.title === probeTitle);
        r.usageCounts = (withProbe?.audio?.count ?? 0) > (usage?.audio?.count ?? 0);
        const del = await t.stemsDeleteSongStems(probeTitle);
        r.deleteOk = del?.ok === true && (del?.deleted ?? 0) > 0;
        const after = await t.stemsUsage();
        r.deleteRemovedSong = !(after?.songs ?? []).some((x: AnyRecord) => x.title === probeTitle);
        r.deleteDroppedCache = (await t.stemsCacheGet('probe-usage-key', 'fast')) === null;
        await t.stemsCacheDrop('probe-usage-key');

        // THE ENGINES FOLDER (7.4): it can move, and USE DEFAULT really goes back. The probe drives the verb
        // (the pane's button opens a folder dialog) and then puts the ORIGINAL folder back — on a machine that
        // adopted the Electron app's models, a reset left in place would hide them from the split below.
        const before = await t.stemsModelsDir();
        const savedDirSetting = (await t.getSettings())?.stemsModelsDir ?? null; // the probe puts it back
        const dirsR = await native.fs({ verb: 'dirs' });
        const sep = String(dirsR?.sep ?? '/');
        const elsewhere = `${String(dirsR?.temp ?? '/tmp')}${sep}terminator-probe-models`;
        await native.stems({ verb: 'modelsDir', path: elsewhere });
        const moved = await t.stemsModelsDir();
        r.modelsDirMoved = moved?.path === elsewhere && moved?.isDefault === false;
        const back = await t.stemsResetModelsDir();
        // A reset re-adopts the Electron app's folder when there is one, so the path back is not necessarily
        // the app's own — what matters is that the chosen folder is gone and nothing is marked as chosen.
        r.modelsDirReset = back?.isDefault === true && back?.path !== elsewhere;
        if (back?.path !== before.path) await native.stems({ verb: 'modelsDir', path: before.path });
        r.modelsDirRestored = (await t.stemsModelsDir())?.path === before.path;
        await t.setSettings({ stemsModelsDir: savedDirSetting });

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
