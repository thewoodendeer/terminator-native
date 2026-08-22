// ─────────────────────────────────────────────────────────────────────────────
// Bundled-asset loading — the ONE place that knows how to read a file we ship
// inside the app (the demo project, foley samples, …).
//
// Two things bite, and both are invisible in `npm run dev`:
//
//  1. PATH. Vite's base differs per target — `/terminator-app/` on the live web
//     bundle, `./` in the packaged desktop app. A hard-coded `/demo/…` resolves
//     to the SITE ROOT on the web (404) and to the FILESYSTEM ROOT in Electron
//     (404). Always build the URL from import.meta.env.BASE_URL.
//  2. FETCH. The packaged renderer runs on file://, where fetch() refuses
//     file: URLs outright. Those reads go through the extractorAssets preload
//     bridge instead (main reads them out of the bundle, path-locked).
//
// Dev hides both: base is '/' and the origin is http://localhost.
// ─────────────────────────────────────────────────────────────────────────────

type AssetBridge = {
  read(relPath: string): Promise<{ ok: true; data: ArrayBuffer } | { ok: false; error: string }>;
};

function assetBridge(): AssetBridge | null {
  const b = (window as unknown as { extractorAssets?: AssetBridge }).extractorAssets;
  return b && typeof b.read === 'function' ? b : null;
}

/** Browser URL for a bundled asset. `rel` is bundle-relative, e.g. 'demo/demo.xpj'. */
export function bundledAssetUrl(rel: string): string {
  const base = import.meta.env.BASE_URL || '/';
  return `${base}${rel.replace(/^\/+/, '')}`;
}

/** Bytes of a bundled asset, however this build can reach them. */
export async function fetchBundledAsset(rel: string): Promise<ArrayBuffer> {
  const clean = rel.replace(/^\/+/, '');
  const bridge = assetBridge();
  // file:// (packaged desktop) — fetch can't read it; main hands us the bytes
  if (location.protocol === 'file:' && bridge) {
    const r = await bridge.read(decodeURIComponent(clean));
    if (!r.ok) throw new Error(r.error);
    return r.data;
  }
  const res = await fetch(bundledAssetUrl(clean));
  if (!res.ok) throw new Error(`${clean} → HTTP ${res.status}`);
  return res.arrayBuffer();
}

/** Bundled asset as a File, named so parseFiles can bind samples by basename. */
export async function fetchBundledFile(rel: string, name: string, type = ''): Promise<File> {
  const data = await fetchBundledAsset(rel);
  return new File([data], name, type ? { type } : undefined);
}
