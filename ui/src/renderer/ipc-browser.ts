/**
 * Browser-side stand-in for the Electron preload's `window.terminator` API.
 *
 * Installed when the renderer is loaded as a plain static page (web build)
 * instead of from Electron. Mirrors the same method shapes the renderer
 * already expects, backed by browser-native storage:
 *
 *   - presets / session / cache metadata  → IndexedDB
 *   - sample import                        → file picker (drag-drop already
 *                                            works via the existing drop
 *                                            handlers in the renderer)
 *   - audio exports                        → blob downloads
 *   - playlists                            → empty list for now; Drive
 *                                            integration is a follow-up
 *   - MPC export / yt-dlp download / cache directory → not applicable on web
 *
 * Anything that genuinely needs the Electron desktop (the local audio cache
 * dir, the MPC card export) returns a friendly "not available" error rather
 * than throwing, so the existing renderer error paths surface a message.
 */

'use strict';

import { r2IsConfigured, listPlaylistsForRenderer, fetchR2Audio, looksLikeR2Id, assertDecodableAudio } from './r2';
import { deliverFiles } from './lib/download';

// ── tiny IndexedDB helper ────────────────────────────────────────────────────
// One database, three stores: kv for presets+session+named, audio for sample
// blobs (so cached YouTube fetches in a future Drive flow can stick around
// across page reloads).
const DB_NAME = 'terminator';
const DB_VERSION = 1;

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
      if (!db.objectStoreNames.contains('audio')) db.createObjectStore('audio');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function kvGet<T = unknown>(key: string): Promise<T | null> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('kv', 'readonly');
    const req = tx.objectStore('kv').get(key);
    req.onsuccess = () => resolve((req.result ?? null) as T | null);
    req.onerror = () => reject(req.error);
  });
}

// IndexedDB has no enforced per-value size limit beyond what the OS allows,
// so we add our own. Presets are JSON; ~5 MB serialized is already absurdly
// large (mostly chops + sequences + pad metadata, no audio). Anything bigger
// is either corruption or a deliberate attempt to fill the user's disk.
const MAX_VALUE_BYTES = 5 * 1024 * 1024;
function approximateJsonBytes(v: unknown): number {
  try { return JSON.stringify(v).length; } catch { return MAX_VALUE_BYTES + 1; }
}

async function kvSet(key: string, value: unknown): Promise<void> {
  if (typeof key !== 'string' || !key || key.length > 256) {
    throw new Error('invalid kv key');
  }
  if (approximateJsonBytes(value) > MAX_VALUE_BYTES) {
    throw new Error('value too large');
  }
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('kv', 'readwrite');
    tx.objectStore('kv').put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function kvDelete(key: string): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('kv', 'readwrite');
    tx.objectStore('kv').delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// IndexedDB cache for fetched Drive audio. Saves the ArrayBuffer + a small
// metadata wrapper so reloading a track skips the network entirely.
interface CachedAudio {
  audio: ArrayBuffer;
  title: string;
  durationSec: number;
  videoId: string;
  cachedAt: number;
}
async function audioGet(id: string): Promise<CachedAudio | null> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('audio', 'readonly');
    const req = tx.objectStore('audio').get(id);
    req.onsuccess = () => resolve((req.result ?? null) as CachedAudio | null);
    req.onerror = () => reject(req.error);
  });
}
async function audioPut(id: string, value: CachedAudio): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('audio', 'readwrite');
    tx.objectStore('audio').put(value, id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
async function audioDelete(id: string): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('audio', 'readwrite');
    tx.objectStore('audio').delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// Cache index: tiny sidecar of {id, lastUsed, bytes} entries kept in `kv` so
// we can run LRU eviction without scanning every audio blob. Touched on read
// and write so frequently-played tracks survive even if they were cached
// long ago.
interface CacheIndexEntry { id: string; lastUsed: number; bytes: number }
const CACHE_INDEX_KEY = 'cache:audioIndex';
// Soft cap. Browsers grant 10-60% of free disk for IndexedDB but iOS Safari
// is stingy — 200 MB keeps the cache useful without filling a phone.
const AUDIO_CACHE_MAX_BYTES = 200 * 1024 * 1024;

async function readCacheIndex(): Promise<CacheIndexEntry[]> {
  const v = await kvGet<CacheIndexEntry[]>(CACHE_INDEX_KEY);
  return Array.isArray(v) ? v : [];
}
async function writeCacheIndex(idx: CacheIndexEntry[]): Promise<void> {
  // Cheap dedupe sort — index stays tiny (< 1 KB even with hundreds of entries).
  await kvSet(CACHE_INDEX_KEY, idx);
}
async function touchCacheEntry(id: string): Promise<void> {
  const idx = await readCacheIndex();
  const hit = idx.find(e => e.id === id);
  if (!hit) return;
  hit.lastUsed = Date.now();
  await writeCacheIndex(idx);
}
async function recordCachePut(id: string, bytes: number): Promise<void> {
  const idx = await readCacheIndex();
  const i = idx.findIndex(e => e.id === id);
  const entry: CacheIndexEntry = { id, lastUsed: Date.now(), bytes };
  if (i >= 0) idx[i] = entry; else idx.push(entry);
  await writeCacheIndex(idx);
}
async function evictUntilUnder(maxBytes: number): Promise<void> {
  const idx = await readCacheIndex();
  let total = idx.reduce((s, e) => s + e.bytes, 0);
  if (total <= maxBytes) return;
  // Oldest first.
  idx.sort((a, b) => a.lastUsed - b.lastUsed);
  while (total > maxBytes && idx.length > 0) {
    const victim = idx.shift()!;
    try { await audioDelete(victim.id); } catch { /* ignore */ }
    total -= victim.bytes;
  }
  await writeCacheIndex(idx);
}

async function kvListPrefix(prefix: string): Promise<Array<{ key: string; value: any }>> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const out: Array<{ key: string; value: any }> = [];
    const tx = db.transaction('kv', 'readonly');
    const store = tx.objectStore('kv');
    const range = IDBKeyRange.bound(prefix, prefix + '￿');
    const req = store.openCursor(range);
    req.onsuccess = () => {
      const cur = req.result;
      if (!cur) { resolve(out); return; }
      out.push({ key: String(cur.key), value: cur.value });
      cur.continue();
    };
    req.onerror = () => reject(req.error);
  });
}

// ── name sanitizer (mirrors the engine's safeName in src/main/presets.ts) ───
function safeName(name: string): string {
  return String(name)
    .replace(/[/\\:*?"<>|\0]/g, '-')
    .replace(/^\.+/, '')
    .trim()
    .slice(0, 64) || 'preset';
}

// ── the shim ────────────────────────────────────────────────────────────────
export function installBrowserIPC(): void {
  // Don't clobber a real Electron preload if one happened to be present.
  if ((window as any).terminator) return;

  (window as any).terminator = {
    // Stems / exports — trigger browser downloads of the WAV ArrayBuffers
    exportStem: async (payload: { name: string; data: ArrayBuffer }) => {
      await deliverFiles([{ name: `${safeName(payload.name)}.wav`, data: payload.data, mime: 'audio/wav' }]);
      return { filePath: payload.name };
    },
    exportAllStems: async (stems: Array<{ name: string; data: ArrayBuffer }>) => {
      // One share sheet / sequential downloads — never a tight loop of blob
      // navigations (that crashed the iframe on iOS).
      await deliverFiles(stems.map(s => ({ name: `${safeName(s.name)}.wav`, data: s.data, mime: 'audio/wav' })));
      return { saved: stems.map(s => s.name) };
    },

    // MPC export / eject — not applicable on web. Renderer surfaces an err.
    exportToMpc: async () => ({ error: 'MPC export is a desktop-only feature.' }),
    ejectMpc: async () => ({ error: 'Not available on web.' }),
    onMpcStatus: (_handler: (mp: string | null) => void) => () => {},

    // ── Chopper ────────────────────────────────────────────────────────────
    listPlaylists: async () => {
      // Drive is the playlist source for the web build. If the user hasn't
      // configured VITE_DRIVE_API_KEY / VITE_DRIVE_FOLDER_ID, return an empty
      // list so the UI still loads (file-drop continues to work).
      if (!r2IsConfigured()) return [];

      // IndexedDB-cached listing — TTL 1 h. Network calls hit Drive multiple
      // times (one per playlist folder), so cold-start latency is noticeable
      // on cellular. Cached returns appear instantly; we still refresh in the
      // background so a stale entry triggers a one-shot update the next time
      // the user opens the app. Survives Drive going down too: if the network
      // call fails and we have any cached value (even expired), we return it.
      const PLAYLIST_TTL = 60 * 60 * 1000;
      // Bump the version suffix when the listing's SHAPE/contents change in a way
      // a stale cache shouldn't survive — here: hiding the broken Golden Hour
      // samples (brokenSamples.ts) takes effect on the first load post-deploy
      // instead of after the 1 h TTL / a background refresh.
      const PLAYLIST_KEY = 'cache:playlists:v3';
      const cached = await kvGet<{ list: any[]; cachedAt: number }>(PLAYLIST_KEY);
      const now = Date.now();
      const fresh = cached && (now - cached.cachedAt < PLAYLIST_TTL);

      if (fresh) {
        // Background refresh — silently update so the next page load sees
        // the newest folders. No user-visible churn this run.
        listPlaylistsForRenderer()
          .then(list => kvSet(PLAYLIST_KEY, { list, cachedAt: Date.now() }).catch(() => {}))
          .catch(() => {});
        return cached.list;
      }

      try {
        const list = await listPlaylistsForRenderer();
        await kvSet(PLAYLIST_KEY, { list, cachedAt: now }).catch(() => {});
        return list;
      } catch (e) {
        console.warn('[ipc-browser] Drive listing failed:', e);
        // Fall back to stale cache rather than showing nothing.
        return cached?.list ?? [];
      }
    },

    // Asset store (projectAssets.ts) — the user's own samples by content hash,
    // in the same IndexedDB audio store as fetched tracks, under `asset:` keys
    // (outside the LRU index, so a project's samples are never evicted).
    assetPut: async (hash: string, name: string, mime: string, data: ArrayBuffer | Uint8Array) => {
      try {
        const ab = data instanceof Uint8Array ? data.slice().buffer : data;
        await audioPut(`asset:${hash}`, { audio: ab, title: name, durationSec: 0, videoId: `asset:${hash}`, cachedAt: Date.now(), mime } as any);
        return { ok: true };
      } catch (e: any) { return { error: e?.message ?? String(e) }; }
    },
    assetGet: async (hash: string) => {
      try {
        const r: any = await audioGet(`asset:${hash}`);
        return r ? { data: r.audio as ArrayBuffer, name: r.title as string, mime: (r.mime as string) ?? '' } : null;
      } catch { return null; }
    },
    assetHas: async (hash: string) => { try { return (await audioGet(`asset:${hash}`)) !== null; } catch { return false; } },
    downloadYouTube: async (idOrUrl: string) => {
      // The renderer reuses the YouTube path to ask for any track by ID. In
      // the web build, that ID is actually a Drive file ID. Check the shape
      // and route to Drive; otherwise surface a clear error.
      if (typeof idOrUrl !== 'string' || !idOrUrl) {
        return { ok: false, error: 'invalid id' };
      }
      if (!looksLikeR2Id(idOrUrl)) {
        return { ok: false, error: 'YouTube URLs are desktop-only on the web build. Drop a file or pick a track.' };
      }
      if (!r2IsConfigured()) {
        return { ok: false, error: 'Sample library not configured.' };
      }

      // Check IndexedDB cache first so reloads are instant.
      try {
        const cached = await audioGet(idOrUrl);
        if (cached) {
          // Validate before trusting it: a truncated or audio-less file cached
          // before this guard existed would otherwise keep failing to decode on
          // every click. If the cached bytes are bad, throw to the catch below,
          // which evicts them and re-fetches (self-heal).
          assertDecodableAudio(cached.audio);
          // Touch so LRU keeps frequently-played samples around.
          void touchCacheEntry(idOrUrl);
          return { ok: true, audio: cached.audio, title: cached.title, durationSec: cached.durationSec, videoId: cached.videoId };
        }
      } catch {
        // Cache miss, or a bad cached entry — drop it and fall through to the
        // network. (audioDelete on a plain miss is a harmless no-op.)
        void audioDelete(idOrUrl).catch(() => {});
      }

      try {
        const result = await fetchR2Audio(idOrUrl);
        // Best-effort cache. If quota errors out, evict oldest entries until
        // there's room and retry once. Cache failure never blocks playback.
        try {
          const bytes = result.audio.byteLength;
          await evictUntilUnder(Math.max(0, AUDIO_CACHE_MAX_BYTES - bytes));
          try {
            await audioPut(idOrUrl, { ...result, cachedAt: Date.now() });
          } catch {
            // Quota probably full despite our soft cap (other origins, OS pressure).
            // Aggressively evict to half-capacity and retry once.
            await evictUntilUnder(Math.floor(AUDIO_CACHE_MAX_BYTES / 2));
            await audioPut(idOrUrl, { ...result, cachedAt: Date.now() });
          }
          await recordCachePut(idOrUrl, bytes);
        } catch (e) {
          console.warn('[ipc-browser] audio cache put failed:', e);
        }
        return { ok: true, ...result };
      } catch (e: any) {
        return { ok: false, error: e?.message ?? String(e) };
      }
    },

    // Cache dir / playlist cache management — no equivalent in a browser.
    // The renderer treats these as no-ops on web (it just won't render the
    // cache UI panels once we wire the platform check).
    getCacheDir: async () => 'browser:indexeddb',
    setCacheDir: async () => ({ cancelled: true }),
    getCacheStatus: async () => ({ cached: 0, total: 0, sizeMB: 0, estimatedMB: 0 }),
    downloadPlaylist: async () => ({ ok: false, error: 'Not available on web.' }),
    deletePlaylistCache: async () => ({ deleted: 0 }),
    onCacheProgress: (_handler: any) => () => {},

    // Presets — keyed by videoId in IndexedDB, mirroring the file layout.
    savePreset: async (preset: any) => {
      if (!preset || typeof preset.videoId !== 'string' || preset.videoId.length > 200) {
        return { error: 'invalid preset' };
      }
      try {
        await kvSet(`preset:${preset.videoId}`, preset);
        return { ok: true };
      } catch (e: any) { return { error: e?.message ?? String(e) }; }
    },
    loadPreset: async (videoId: string) => {
      if (typeof videoId !== 'string' || videoId.length > 200) return null;
      return await kvGet(`preset:${videoId}`);
    },

    saveSession: async (session: any) => {
      try {
        await kvSet('session', session);
        return { ok: true };
      } catch (e: any) { return { error: e?.message ?? String(e) }; }
    },
    loadSession: async () => await kvGet('session'),

    listNamedPresets: async () => {
      const items = await kvListPrefix('named:');
      return items.map(({ value }) => ({
        name: value?.name ?? '',
        trackTitle: value?.trackTitle,
        savedAt: value?.savedAt ?? '',
        videoId: value?.videoId ?? '',
      })).sort((a, b) => String(b.savedAt).localeCompare(String(a.savedAt)));
    },
    saveNamedPreset: async (name: string, preset: any) => {
      if (typeof name !== 'string' || !name || name.length > 200) return { error: 'invalid name' };
      try {
        await kvSet(`named:${safeName(name)}`, { ...preset, name });
        return { ok: true };
      } catch (e: any) { return { error: e?.message ?? String(e) }; }
    },
    loadNamedPreset: async (name: string) => {
      if (typeof name !== 'string' || !name) return null;
      return await kvGet(`named:${safeName(name)}`);
    },
    deleteNamedPreset: async (name: string) => {
      if (typeof name !== 'string' || !name) return { error: 'invalid name' };
      await kvDelete(`named:${safeName(name)}`);
      return { ok: true };
    },

    // EULA — on web we silently accept. Desktop version still gates this
    // because the YouTube downloader is the actual liability. On web the
    // user is dropping their own files, no EULA needed.
    eulaStatus: async () => ({ accepted: true }),
    eulaAccept: async () => ({ ok: true }),

    // Desktop licensing — desktop-only. Inert on web: the gate never runs here
    // (ChopperView's gate effect bails on isWeb), and isSubscribed() uses the
    // ?sub=1 wrapper path, never these. Stubs keep the bridge shape consistent.
    startBrowserSignIn: async () => {},
    checkLicense: async () => ({ unlocked: false, email: '' }),
    signOut: async () => {},
    openBuyPage: async () => {},
    onAuthSignedIn: (_handler: (info: { email: string }) => void) => () => {},
  };
}

// Install eagerly when this module is first imported. Done as a side effect
// so that downstream modules (App.tsx) which read `window.terminator` at
// load time get a populated shim — calling installBrowserIPC() later from
// main.tsx is too late because ES imports execute their dependents' bodies
// first. Idempotent: bails if a real Electron preload is already in place.
installBrowserIPC();
