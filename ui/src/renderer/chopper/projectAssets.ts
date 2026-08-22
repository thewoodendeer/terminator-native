// PROJECT ASSETS — the audio a project brings with it.
//
// A project used to be pure JSON: a Terminator/YouTube/R2 sample reloads by
// id anywhere, but a file YOU loaded was remembered only as `local_<name>` —
// gone on any other device (and pad samples weren't even restored). Now a
// user file is an ASSET: content-hashed (`asset:<sha1>`), its original bytes
// kept in the ASSET STORE of the device (desktop: <userData>/terminator-
// presets/assets/<hash>.<ext>; web: IndexedDB), and a project that references
// assets can be written as a BUNDLE — `<name>.tprojz`, a plain (stored) zip:
//     project.json      the ChopPreset (asset: ids inside)
//     manifest.json     { version, assets: [{ hash, name, mime, bytes }] }
//     samples/<hash>.<ext>
// Reading a bundle drops its samples into the local store and returns the
// preset; from then on the project loads like any other. TRANSFER TO DEVICE
// streams the same bytes. R2/YouTube ids are untouched — no bloat for those.

import type { ChopPreset } from './ChopperEngine';
import { buildZip } from './exporters/zipWriter';
import { parseZip } from './exporters/zipReader';

export const ASSET_PREFIX = 'asset:';
export const BUNDLE_EXT = '.tprojz';
export const BUNDLE_WARN_BYTES = 100 * 1024 * 1024;
export const BUNDLE_MAX_BYTES = 500 * 1024 * 1024;

export interface AssetMeta { hash: string; name: string; mime: string; bytes: number }
export interface StoredAsset extends AssetMeta { data: ArrayBuffer }

type Bridge = {
  assetPut?: (hash: string, name: string, mime: string, data: ArrayBuffer | Uint8Array) => Promise<{ ok?: boolean; error?: string }>;
  assetGet?: (hash: string) => Promise<{ data: ArrayBuffer | Uint8Array; name: string; mime: string } | null>;
  assetHas?: (hash: string) => Promise<boolean>;
};
const bridge = (): Bridge | undefined => (typeof window !== 'undefined' ? (window as any).terminator : undefined);

const isAssetId = (id: string | null | undefined): id is string => typeof id === 'string' && id.startsWith(ASSET_PREFIX);
export const assetHash = (id: string) => id.slice(ASSET_PREFIX.length);
export const assetId = (hash: string) => ASSET_PREFIX + hash;

/** SHA-1 of the file bytes → 40 hex chars. crypto.subtle everywhere we run. */
export async function hashBytes(ab: ArrayBuffer): Promise<string> {
  const d = await crypto.subtle.digest('SHA-1', ab);
  return Array.from(new Uint8Array(d)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

const mimeFor = (name: string): string => {
  const ext = name.toLowerCase().split('.').pop() ?? '';
  return ({ wav: 'audio/wav', mp3: 'audio/mpeg', m4a: 'audio/mp4', aac: 'audio/aac', ogg: 'audio/ogg', flac: 'audio/flac', aif: 'audio/aiff', aiff: 'audio/aiff', webm: 'audio/webm' } as Record<string, string>)[ext] ?? 'application/octet-stream';
};
const extFor = (name: string, mime: string): string => {
  const m = /\.([a-z0-9]{2,5})$/i.exec(name);
  if (m) return m[1].toLowerCase();
  return ({ 'audio/wav': 'wav', 'audio/mpeg': 'mp3', 'audio/mp4': 'm4a', 'audio/aac': 'aac', 'audio/ogg': 'ogg', 'audio/flac': 'flac', 'audio/aiff': 'aiff', 'audio/webm': 'webm' } as Record<string, string>)[mime] ?? 'bin';
};

// ── the store: session memory in front of the device store ──
const mem = new Map<string, StoredAsset>();
// Assets whose BYTES were released from the session (release()) — the device
// store still has them; only the metadata stays resident for manifests.
const metaMem = new Map<string, AssetMeta>();

export const assetStore = {
  /** Remember a file's bytes under their hash. Returns the asset id. */
  async put(ab: ArrayBuffer, name: string): Promise<string> {
    const hash = await hashBytes(ab);
    const mime = mimeFor(name);
    if (!mem.has(hash)) mem.set(hash, { hash, name, mime, bytes: ab.byteLength, data: ab });
    try { await bridge()?.assetPut?.(hash, name, mime, ab); } catch { /* the session copy still works */ }
    return assetId(hash);
  },
  async putStored(a: StoredAsset): Promise<void> {
    if (!mem.has(a.hash)) mem.set(a.hash, a);
    try { await bridge()?.assetPut?.(a.hash, a.name, a.mime, a.data); } catch { /* */ }
  },
  async get(hash: string): Promise<StoredAsset | null> {
    const m = mem.get(hash); if (m) return m;
    try {
      const r = await bridge()?.assetGet?.(hash);
      if (r && r.data) {
        const data = r.data instanceof ArrayBuffer ? r.data : (r.data as Uint8Array).slice().buffer;
        const a: StoredAsset = { hash, name: r.name, mime: r.mime || mimeFor(r.name), bytes: data.byteLength, data };
        mem.set(hash, a);
        return a;
      }
    } catch { /* */ }
    return null;
  },
  async has(hash: string): Promise<boolean> {
    if (mem.has(hash)) return true;
    try { if (await bridge()?.assetHas?.(hash)) return true; } catch { /* */ }
    return (await this.get(hash)) !== null;
  },
  metaOf(hash: string): AssetMeta | null {
    const m = mem.get(hash);
    if (m) return { hash: m.hash, name: m.name, mime: m.mime, bytes: m.bytes };
    return metaMem.get(hash) ?? null;
  },
  /** Drop the session copy of an asset's BYTES once they've been consumed
   *  (e.g. stems: four full-track WAVs were staying resident after decode —
   *  ~140 MB on a 3-min song). The device store keeps them; get() re-reads. */
  release(hash: string): void {
    const m = mem.get(hash);
    if (!m) return;
    metaMem.set(hash, { hash: m.hash, name: m.name, mime: m.mime, bytes: m.bytes });
    mem.delete(hash);
  },
};

/** Every asset id a preset references (main sample + pad samples). */
export function assetRefsOf(preset: ChopPreset): string[] {
  const out = new Set<string>();
  if (isAssetId(preset.videoId)) out.add(assetHash(preset.videoId));
  const meta = preset.padBufferMeta ?? {};
  for (const k of Object.keys(meta)) { const v = (meta as any)[k]?.videoId; if (isAssetId(v)) out.add(assetHash(v)); }
  // DELIBERATELY NOT collected: preset.stems.assets — stems are DERIVED data
  // (4× ~30MB per split would blow bundles/transfers past BUNDLE_WARN_BYTES).
  // A receiving device re-splits in seconds; masks + readyRanges ride the JSON.
  return [...out];
}
export const projectNeedsBundle = (preset: ChopPreset): boolean => assetRefsOf(preset).length > 0;

/** Which of a preset's assets this device does NOT have (→ "transfer it"). */
export async function missingAssets(preset: ChopPreset): Promise<AssetMeta[]> {
  const out: AssetMeta[] = [];
  const names = (preset as any).assets as AssetMeta[] | undefined;
  for (const h of assetRefsOf(preset)) {
    if (await assetStore.has(h)) continue;
    out.push(names?.find((a) => a.hash === h) ?? { hash: h, name: h.slice(0, 8), mime: '', bytes: 0 });
  }
  return out;
}

/** Stamp the asset manifest onto the preset (names + sizes travel with the
 *  JSON, so a device that lacks the bytes can still say WHICH file it needs). */
export function withAssetManifest(preset: ChopPreset): ChopPreset {
  const refs = assetRefsOf(preset);
  if (!refs.length) { const { assets: _a, ...rest } = preset as any; return rest as ChopPreset; }
  const assets = refs.map((h) => assetStore.metaOf(h) ?? { hash: h, name: h.slice(0, 8), mime: '', bytes: 0 });
  return { ...(preset as any), assets } as ChopPreset;
}

// ── bundles ──
export interface BundleBuild { bytes: Uint8Array; totalBytes: number; assets: AssetMeta[] }

export async function buildProjectBundle(preset: ChopPreset): Promise<BundleBuild> {
  const refs = assetRefsOf(preset);
  const entries: Array<{ path: string; data: Uint8Array }> = [];
  const assets: AssetMeta[] = [];
  let total = 0;
  for (const h of refs) {
    const a = await assetStore.get(h);
    if (!a) throw new Error(`This project needs a sample that isn't on this device (${h.slice(0, 8)}…) — load it via LOAD FILE first`);
    total += a.bytes;
    if (total > BUNDLE_MAX_BYTES) throw new Error(`Project bundle is over ${BUNDLE_MAX_BYTES / 1024 / 1024} MB — too big to save as one file`);
    assets.push({ hash: a.hash, name: a.name, mime: a.mime, bytes: a.bytes });
    entries.push({ path: `samples/${a.hash}.${extFor(a.name, a.mime)}`, data: new Uint8Array(a.data) });
  }
  const enc = new TextEncoder();
  const stamped = withAssetManifest(preset);
  entries.unshift({ path: 'manifest.json', data: enc.encode(JSON.stringify({ version: 1, app: 'terminator', assets })) });
  entries.unshift({ path: 'project.json', data: enc.encode(JSON.stringify(stamped)) });
  return { bytes: buildZip(entries), totalBytes: total, assets };
}

/** Read a bundle: samples go into the local store, the preset comes back. */
export async function unpackProjectBundle(bytes: Uint8Array): Promise<{ preset: ChopPreset; assets: AssetMeta[] }> {
  const entries = parseZip(bytes);
  const td = new TextDecoder();
  const proj = entries.find((e) => e.path === 'project.json');
  if (!proj) throw new Error('Not a Terminator project bundle (no project.json)');
  const preset = JSON.parse(td.decode(proj.data)) as ChopPreset;
  const manEntry = entries.find((e) => e.path === 'manifest.json');
  const manifest = manEntry ? JSON.parse(td.decode(manEntry.data)) as { assets?: AssetMeta[] } : {};
  const assets: AssetMeta[] = [];
  for (const e of entries) {
    if (!e.path.startsWith('samples/')) continue;
    const file = e.path.slice('samples/'.length);
    const hash = file.replace(/\.[^.]+$/, '');
    const meta = manifest.assets?.find((a) => a.hash === hash);
    const data = e.data.slice().buffer as ArrayBuffer;   // detach from the zip
    const a: StoredAsset = { hash, name: meta?.name ?? file, mime: meta?.mime ?? mimeFor(file), bytes: data.byteLength, data };
    await assetStore.putStored(a);
    assets.push({ hash: a.hash, name: a.name, mime: a.mime, bytes: a.bytes });
  }
  return { preset, assets };
}

/** Is this file a project (JSON .tproj or a .tprojz bundle)? */
export const looksLikeProjectFile = (name: string): boolean => /\.(tproj|tprojz)$/i.test(name);
