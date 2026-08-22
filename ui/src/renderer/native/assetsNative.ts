/**
 * assetsNative — the ASSET STORE (projectAssets.ts: `asset:<sha1>` — the audio a project brings with it) and
 * the `.tprojz` bundle bytes for Terminator 3.0, over `terminatorFs`:
 *   <dataDir>/assets/<hash>.<ext> + <hash>.json   — the same layout the Electron app keeps under
 *                                                  <userData>/terminator-presets/assets (main.ts chopper:asset*)
 * READ FALLBACK: an asset missing from the native store is looked up in the Electron app's store on this
 * machine (macOS ~/Library/Application Support/terminator/terminator-presets/assets, Windows
 * %APPDATA%/terminator/terminator-presets/assets) — so the projects saved by Terminator 2.x open with their
 * samples natively without copying hundreds of MB (the full settings/presets import is Phase 8).
 * Bytes go C++→JS through `readBinary` (a one-shot /blob/<token> URL the page fetches) and JS→C++ through
 * `writeBinary` (chunked base64).
 */
import { isNative, native, nativeBoot } from './juceBridge';

type AnyRecord = Record<string, any>;

const safeHash = (h: unknown): string | null => (typeof h === 'string' && /^[a-f0-9]{16,64}$/i.test(h) ? h.toLowerCase() : null);

const bytesToBase64 = (bytes: Uint8Array): Promise<string> =>
  new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onerror = () => reject(r.error ?? new Error('base64 failed'));
    r.onload = () => { const s = String(r.result); resolve(s.slice(s.indexOf(',') + 1)); };
    r.readAsDataURL(new Blob([bytes as unknown as BlobPart]));
  });

/** Write bytes to a path (chunked appends keep every bridge message small). */
export async function writeBinaryFile(path: string, bytes: Uint8Array): Promise<{ ok: boolean; error?: string }> {
  const CHUNK = 3 * 1024 * 1024;
  if (bytes.length === 0) { const r = await native.fs({ verb: 'writeBinary', path, data: '', append: false }); return r?.ok ? { ok: true } : { ok: false, error: r?.error ?? 'write failed' }; }
  for (let off = 0; off < bytes.length; off += CHUNK) {
    const part = bytes.subarray(off, Math.min(bytes.length, off + CHUNK));
    const r = await native.fs({ verb: 'writeBinary', path, data: await bytesToBase64(part), append: off > 0 });
    if (!r?.ok) return { ok: false, error: r?.error ?? 'write failed' };
  }
  return { ok: true };
}

/** Read a file's bytes (readBinary → one-shot /blob/ fetch). null when missing/unreadable. */
export async function readBinaryFile(path: string): Promise<{ bytes: Uint8Array; name: string } | null> {
  const r = await native.fs({ verb: 'readBinary', path });
  if (!r?.ok || typeof r.url !== 'string') return null;
  const res = await fetch(new URL(r.url, location.href).href);
  if (!res.ok) return null;
  return { bytes: new Uint8Array(await res.arrayBuffer()), name: String(r.name ?? '') };
}

export interface AssetsDeps { dataDir: () => string; join: (dir: string, name: string) => string }

export function buildAssetKeys(deps: AssetsDeps): { keys: AnyRecord; assetsDir: () => string; fallbackDir: () => string | null } {
  const boot = nativeBoot();
  const assetsDir = () => deps.join(deps.dataDir(), 'assets');
  /** The Electron app's asset store on this machine (read-only fallback). */
  const fallbackDir = (): string | null => {
    const home = boot?.dirs.home ?? '';
    if (!home) return null;
    const sep = boot?.dirs.sep ?? '/';
    if (sep === '\\') {
      // %APPDATA% = <home>\AppData\Roaming
      return [home, 'AppData', 'Roaming', 'terminator', 'terminator-presets', 'assets'].join('\\');
    }
    return [home, 'Library', 'Application Support', 'terminator', 'terminator-presets', 'assets'].join('/');
  };
  const findIn = async (dir: string, hash: string): Promise<{ file: string; json: string | null } | null> => {
    const r = await native.fs({ verb: 'list', dir });
    if (!r?.ok) return null;
    const entries = r.entries as any[];
    const hit = entries.find(e => !e.isDir && String(e.fileName).toLowerCase().startsWith(hash + '.') && !String(e.fileName).endsWith('.json'));
    if (!hit) return null;
    const json = entries.find(e => !e.isDir && String(e.fileName).toLowerCase() === `${hash}.json`);
    return { file: String(hit.path), json: json ? String(json.path) : null };
  };
  const find = async (hash: string) => (await findIn(assetsDir(), hash)) ?? (fallbackDir() ? await findIn(fallbackDir()!, hash) : null);

  const keys: AnyRecord = {
    assetPut: async (hash: unknown, name: unknown, mime: unknown, data: unknown) => {
      try {
        const h = safeHash(hash); if (!h) return { error: 'bad hash' };
        if (!(data instanceof Uint8Array) && !(data instanceof ArrayBuffer)) return { error: 'bad data' };
        const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
        if (bytes.byteLength > 512 * 1024 * 1024) return { error: 'asset too large' };
        const nm = typeof name === 'string' ? name.slice(0, 200) : 'sample';
        const m = /\.([a-z0-9]{2,5})$/i.exec(nm);
        const ext = m ? m[1].toLowerCase() : 'bin';
        await native.fs({ verb: 'mkdir', path: assetsDir() });
        if (!(await findIn(assetsDir(), h))) {
          const w = await writeBinaryFile(deps.join(assetsDir(), `${h}.${ext}`), bytes);
          if (!w.ok) return { error: w.error ?? 'write failed' };
          await native.fs({ verb: 'writeText', path: deps.join(assetsDir(), `${h}.json`), text: JSON.stringify({ hash: h, name: nm, mime: typeof mime === 'string' ? mime : '', bytes: bytes.byteLength, savedAt: Date.now() }) });
        }
        return { ok: true };
      } catch (e: any) { return { error: e?.message ?? String(e) }; }
    },
    assetGet: async (hash: unknown) => {
      const h = safeHash(hash); if (!h) return null;
      const hit = await find(h); if (!hit) return null;
      const rb = await readBinaryFile(hit.file); if (!rb) return null;
      let meta: AnyRecord = {};
      if (hit.json) { const j = await native.fs({ verb: 'readText', path: hit.json }); if (j?.ok) { try { meta = JSON.parse(String(j.text)); } catch { /* */ } } }
      return { data: rb.bytes, name: meta.name ?? rb.name, mime: meta.mime ?? '' };
    },
    assetHas: async (hash: unknown) => { const h = safeHash(hash); if (!h) return false; return (await find(h)) !== null; },
  };
  return { keys, assetsDir, fallbackDir };
}

declare global {
  interface Window { __terminatorNativeAssets?: { selfTest: () => Promise<AnyRecord> } }
}

/** Probe: put → has → get a tiny asset (byte-identical through /blob/), then remove it; report the fallback dir. */
export function installAssetsProbe(store: ReturnType<typeof buildAssetKeys>): void {
  if (!isNative()) return;
  window.__terminatorNativeAssets = {
    selfTest: async () => {
      const r: AnyRecord = {};
      try {
        const bytes = new Uint8Array(70000);
        for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 31 + 7) & 255;
        const hash = 'feedface0123456789abcdef0123456789abcdef'; // a fixed probe hash (removed at the end)
        r.put = (await store.keys.assetPut(hash, 'probe.wav', 'audio/wav', bytes))?.ok === true;
        r.has = await store.keys.assetHas(hash);
        const got = await store.keys.assetGet(hash);
        r.getBytes = got?.data?.length ?? -1;
        let same = !!got && got.data.length === bytes.length;
        if (same) for (let i = 0; i < bytes.length; i += 997) if (got!.data[i] !== bytes[i]) { same = false; break; }
        r.getIdentical = same;
        r.name = got?.name;
        // clean up the probe asset (Trash) — the store is the user's
        const dir = store.assetsDir();
        await native.fs({ verb: 'trash', path: `${dir}${dir.includes('\\') ? '\\' : '/'}${hash}.wav` });
        await native.fs({ verb: 'trash', path: `${dir}${dir.includes('\\') ? '\\' : '/'}${hash}.json` });
        r.gone = !(await store.keys.assetHas(hash));
        const fb = store.fallbackDir();
        r.fallbackDir = fb;
        if (fb) { const st = await native.fs({ verb: 'stat', path: fb }); r.fallbackPresent = !!st?.isDir; if (st?.isDir) { const l = await native.fs({ verb: 'list', dir: fb }); r.fallbackAssets = l?.ok ? (l.entries as any[]).filter(e => !String(e.fileName).endsWith('.json')).length : -1; } }
        r.assetsOk = r.put && r.has && r.getIdentical && r.gone;
      } catch (e) { r.error = String((e as any)?.stack ?? e); r.assetsOk = false; }
      return r;
    },
  };
}
