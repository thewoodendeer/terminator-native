/**
 * Cloudflare R2 playlist source for the web build — replaces drive.ts.
 *
 * Samples were migrated off Google Drive (which throttles downloads / blocks
 * referrers / caps per-file downloads) to a public R2 bucket. A static manifest
 * (playlists.json) lists every playlist + track; each track keeps its ORIGINAL
 * Drive file id so saved presets (which reference samples by `videoId`) keep
 * resolving. Audio is fetched straight from the public r2.dev URL — no API key,
 * no referrer dance, proper CORS, no download quotas.
 *
 * Public API mirrors drive.ts so ipc-browser swaps one import.
 */

'use strict';

import { BROKEN_SAMPLE_IDS } from './brokenSamples';

// Public bucket base (r2.dev managed domain). Audio + manifest live here. Used by
// fetch() paths (manifest, peak decode) — those already work cross-origin.
const R2_BASE = 'https://pub-17b3d7f0dae24aa8b32405d12d43a870.r2.dev';
const MANIFEST_URL = `${R2_BASE}/playlists.json?v=2`;
// Cloudflare Worker proxy in front of R2 that adds Access-Control-Allow-Origin to
// EVERY response, including 206 range responses — which the r2.dev domain omits,
// breaking the <audio crossOrigin> element. Only the audio-element URL needs it.
const R2_WORKER_BASE = 'https://kcc-samples.killavicbeats.workers.dev';

// Drive-shaped ids (33+ chars) and our synthetic md5 ids both match this.
const ID_RE = /^[A-Za-z0-9_-]{20,}$/;

export function r2IsConfigured(): boolean {
  return R2_BASE.length > 0;
}

export function looksLikeR2Id(s: string): boolean {
  return ID_RE.test(s);
}

// Transient network failures clear on a quick retry; keep a per-attempt timeout
// so a hung request can't stall a sample pull forever.
const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);
async function fetchWithRetry(url: string, attempts = 3, timeoutMs = 30000): Promise<Response> {
  let lastErr: any;
  for (let i = 0; i < attempts; i++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, { signal: ctrl.signal });
      clearTimeout(timer);
      if (res.ok || !RETRYABLE_STATUS.has(res.status) || i === attempts - 1) return res;
      lastErr = new Error(`HTTP ${res.status}`);
    } catch (e) {
      clearTimeout(timer);
      lastErr = e;
      if (i === attempts - 1) throw e;
    }
    await new Promise(r => setTimeout(r, 400 * Math.pow(3, i)));
  }
  throw lastErr;
}

type ManifestEntry = { id: string; title: string; key: string; duration?: number };
type Manifest = { version: number; playlists: Array<{ name: string; entries: ManifestEntry[] }> };
type RendererPlaylist = { name: string; entries: Array<{ id: string; title: string; duration?: number }> };

type TrackRef = { key: string; title: string; duration?: number };
// id → object key + metadata, so fetchR2Audio (and preset restore) can resolve a
// sample by its Drive/synthetic id without re-listing.
const trackById = new Map<string, TrackRef>();
// title → the SAME track ref. Secondary index: the desktop app lists playlists
// from local data/*.json keyed by YouTube video id, while the R2 manifest is
// keyed by Drive/synthetic id with NO YouTube id field — so a YouTube id never
// hits trackById. The one shared field is the title (manifest title == the
// download filename == the local playlist's title), so r2AudioUrl falls back to
// this when the id misses. First title wins (duplicate titles resolve to the
// first manifest entry — the accepted trade-off, web is unaffected since it
// always passes a resolvable id).
const trackByTitle = new Map<string, TrackRef>();
let manifestPromise: Promise<Manifest> | null = null;

const MANIFEST_CACHE_KEY = 'tt-r2-manifest-v1';
const MANIFEST_TTL_MS = 30 * 60 * 1000; // 30 min fresh

function indexManifest(m: Manifest): void {
  trackById.clear();
  trackByTitle.clear();
  for (const p of m.playlists) {
    for (const e of p.entries) {
      const ref: TrackRef = { key: e.key, title: e.title, duration: e.duration };
      trackById.set(e.id, ref);
      const t = e.title?.trim();
      if (t && !trackByTitle.has(t)) trackByTitle.set(t, ref); // first occurrence wins
    }
  }
}

function readCache(): Manifest | null {
  try {
    const raw = localStorage.getItem(MANIFEST_CACHE_KEY);
    if (!raw) return null;
    const p = JSON.parse(raw);
    return p && Array.isArray(p.data?.playlists) ? p : null;
  } catch { return null; }
}

/** Load + index the manifest (once). Fresh localStorage cache short-circuits the
 *  network; a fetch failure falls back to any cached copy so playback survives a
 *  blip. */
export function loadManifest(): Promise<Manifest> {
  if (manifestPromise) return manifestPromise;
  manifestPromise = (async () => {
    const cached = readCache();
    if (cached && Date.now() - (cached as any).ts < MANIFEST_TTL_MS) {
      indexManifest((cached as any).data);
      return (cached as any).data as Manifest;
    }
    try {
      const res = await fetchWithRetry(MANIFEST_URL);
      if (!res.ok) throw new Error(`manifest HTTP ${res.status}`);
      const data = await res.json() as Manifest;
      indexManifest(data);
      try { localStorage.setItem(MANIFEST_CACHE_KEY, JSON.stringify({ ts: Date.now(), data })); } catch { /* */ }
      return data;
    } catch (e) {
      if (cached) { indexManifest((cached as any).data); return (cached as any).data as Manifest; }
      manifestPromise = null; // allow a retry next call
      throw e;
    }
  })();
  return manifestPromise;
}

/** Same shape drive.ts returned — one playlist per manifest entry.
 *  Broken (audio-less) samples are stripped HERE, at the single source every
 *  web consumer reads from (Sample Browser, the toolbar playlist picker AND the
 *  random "GET SAMPLE" pool) — see brokenSamples.ts. */
export async function listPlaylistsForRenderer(): Promise<RendererPlaylist[]> {
  const m = await loadManifest();
  return m.playlists.map(p => ({
    name: p.name,
    entries: p.entries
      .filter(e => !BROKEN_SAMPLE_IDS.has(e.id))
      .map(e => ({ id: e.id, title: e.title, duration: e.duration })),
  }));
}

/** Encode each path segment of an object key (the '/' separators survive).
 *  encodeURI leaves &, (, ), #, ?, + unescaped — harmless for today's
 *  slug/id keys, but a future key containing them would 404 (or truncate at
 *  '#'), so encode per-segment to be safe. */
function encodeKey(key: string): string {
  return key.split('/').map(encodeURIComponent).join('/');
}

/** Throw a clear, honest error when a 200-OK body can't possibly decode to
 *  audio — so the UI surfaces the real cause instead of the opaque
 *  "Unable to decode audio data" that decodeAudioData emits.
 *
 *  Covers, with header-only O(1) checks (no frame scan):
 *   - empty bodies (0 bytes),
 *   - text/HTML/XML/JSON error pages served with status 200,
 *   - metadata-only MP3s: a batch of library files were uploaded as an ID3v2
 *     tag + cover art (optionally + a trailing 128-byte ID3v1 'TAG' block) with
 *     NO MPEG audio stream — e.g. golden-hour Herman Harris / Harold Alexander,
 *     which are 45–77 KB of pure tag and decode to nothing. */
export function assertDecodableAudio(audio: ArrayBuffer, contentType = ''): void {
  if (audio.byteLength === 0) {
    throw new Error('This sample is empty (0 bytes) — the file may be missing on the server.');
  }
  const b = new Uint8Array(audio);
  if (/^(text\/|application\/(xml|json|xhtml))/i.test(contentType) || b[0] === 0x3c /* '<' */) {
    throw new Error(`The server returned ${contentType || 'non-audio data'} instead of audio.`);
  }
  // Metadata-only MP3: the ID3v2 tag (read its syncsafe size) plus an optional
  // trailing 128-byte ID3v1 'TAG' fills the whole file → no frames to decode.
  if (b.length >= 10 && b[0] === 0x49 && b[1] === 0x44 && b[2] === 0x33) {
    const synch = ((b[6] & 0x7f) << 21) | ((b[7] & 0x7f) << 14) | ((b[8] & 0x7f) << 7) | (b[9] & 0x7f);
    const tagEnd = 10 + synch + ((b[5] & 0x10) ? 10 : 0); // +10 if a footer is present
    if (tagEnd >= b.length - 128) {
      throw new Error('This sample has no audio — the file on the server is metadata/artwork only (corrupt upload).');
    }
  }
}

/** Public streaming URL for a sample id — for `<audio>.src` (Sample Browser
 *  preview streams directly, no PCM decode). Routed through the CORS Worker so
 *  the cross-origin element can read 206 range responses. SYNCHRONOUS: it reads
 *  the already-indexed manifest (`trackById`), populated by the time any playlist
 *  UI is on screen, so the URL is available inside the click gesture (iOS requires
 *  `audio.play()` in-gesture — no await). Optionally pass the track `title` so a
 *  YouTube-id miss (the desktop case) can fall back to the title index. Returns
 *  null if neither the id nor the title resolves. */
export function r2AudioUrl(fileId: string, title?: string): string | null {
  // Drive/synthetic id (web, and the R2-manifest fallback) → direct hit.
  let t = trackById.get(fileId);
  // Desktop lists from local data/*.json keyed by YouTube id, which never hits
  // trackById — fall back to the shared title (see trackByTitle above).
  if (!t && title) {
    const key = title.trim();
    if (key) t = trackByTitle.get(key);
  }
  return t ? `${R2_WORKER_BASE}/${encodeKey(t.key)}` : null;
}

/** Fetch a sample's bytes from R2 by id (Drive id or synthetic). Returns the
 *  same shape the chopper engine consumed from Drive. videoId stays the lookup
 *  id so presets re-save/restore identically. */
export async function fetchR2Audio(fileId: string): Promise<{ audio: ArrayBuffer; title: string; durationSec: number; videoId: string }> {
  await loadManifest();
  const t = trackById.get(fileId);
  if (!t) throw new Error('Sample not found in the library — it may have been moved or renamed.');
  const res = await fetchWithRetry(`${R2_BASE}/${encodeKey(t.key)}`);
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`R2 fetch failed (${res.status}): ${text.slice(0, 160)}`);
  }
  const audio = await res.arrayBuffer();
  // Reject empty / non-audio / metadata-only bodies up front (a 200-OK with no
  // decodable audio otherwise dies later as an opaque decode error). Throwing
  // here also stops downloadYouTube from caching the bad bytes.
  assertDecodableAudio(audio, res.headers.get('content-type') || '');
  return { audio, title: t.title, durationSec: t.duration ?? 0, videoId: fileId };
}
