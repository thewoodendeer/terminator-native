/**
 * Drum-sample resolver. The KCC drum library is addressed by OPAQUE ids only
 * (samples.json lists them per kit/category; no real filenames anywhere in the
 * client — not in the bundle, not on the network, not in the UI; display names
 * are hash aliases, see drumAliases.ts).
 *
 * Where a sample lives, best first:
 *   terminator-drums://sample/<id>.flac   ← the DESKTOP app ships the whole
 *                                            lossless library inside itself
 *                                            (Resources/drums-flac, 2026-08-21)
 *   <R2_BASE>/drums-flac/<id>.flac        ← lossless on R2 (the web app; a
 *                                            desktop install missing a file)
 *   <R2_BASE>/drums/<id>.mp3              ← the original, still serving the
 *                                            other apps; left untouched
 *
 * The local scheme is tried only outside the WEB build; a failed fetch
 * (unknown scheme in a plain browser, or a 404) falls straight through.
 *
 * In the NATIVE shell (Terminator 3.0) there is no custom scheme: `setNativeDrumUrls` swaps in the two URLs the
 * JUCE shell serves on its own origin. The bundled one keeps the `/drums/<id>.<ext>` shape on purpose, so
 * `drumIdFromUrl` below still recovers the id from a project saved there.
 */

const DRUM_R2_BASE = 'https://pub-17b3d7f0dae24aa8b32405d12d43a870.r2.dev';
const IS_WEB = (import.meta as any).env?.MODE === 'web';
const LOCAL_SCHEME = 'terminator-drums://';

/** NATIVE (Terminator 3.0, drumsNative.ts): the JUCE shell has no custom URL SCHEME — it serves the same two
 *  things on its own origin (`/drums/<id>.<ext>` for the bundled library, the library's `/lib/b64/` route for a
 *  file in the user's drums folder). Null in Electron and on the web, where the scheme above is the answer. */
let nativeUrls: { sample(id: string): string; user(rel: string): string } | null = null;
export function setNativeDrumUrls(u: { sample(id: string): string; user(rel: string): string } | null): void {
  nativeUrls = u;
}

/** Every place a sample might live, best first. */
export function drumSampleUrls(id: string): string[] {
  const remote = [`${DRUM_R2_BASE}/drums-flac/${id}.flac`, `${DRUM_R2_BASE}/drums/${id}.mp3`];
  if (nativeUrls) return [nativeUrls.sample(id), ...remote];
  return IS_WEB ? remote : [`${LOCAL_SCHEME}sample/${id}.flac`, ...remote];
}

/** The primary URL (what the browser lists). Loading goes through
 *  drumSampleUrls so the fallback still applies. */
export function drumR2Url(id: string): string {
  return drumSampleUrls(id)[0];
}

/** The opaque id behind any of the URLs above (null for anything else —
 *  e.g. a user's own drum file). */
export function drumIdFromUrl(url: string): string | null {
  const m = /(?:terminator-drums:\/\/sample\/|\/drums-flac\/|\/drums\/)([0-9a-f]{16})\.(?:flac|mp3)$/.exec(url);
  return m ? m[1] : null;
}

/** A file from the user's own drums folder (<Sample Library>/Drums), served
 *  by the desktop app's terminator-drums://user/<relative path> route. */
export function userDrumUrl(relPath: string): string {
  if (nativeUrls) return nativeUrls.user(relPath);
  return `${LOCAL_SCHEME}user/${relPath.split('/').map(encodeURIComponent).join('/')}`;
}
