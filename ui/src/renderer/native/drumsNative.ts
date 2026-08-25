/**
 * drumsNative — DRUMS in the JUCE shell, both halves the Electron app has:
 *
 *  1. **The KCC library shipped INSIDE the app.** `drums-flac/` rides in the bundle (cmake/BundleDrums.cmake)
 *     and the shell serves it at `/drums/<id>.<ext>` (WebShell::provideResource) — the native twin of
 *     Electron's `terminator-drums://sample/<id>.flac`. No network, no IPC bytes, opaque ids only. A build with
 *     no bundled library (a fresh clone, CI) simply falls through to R2, exactly like the web build.
 *  2. **The user's OWN drums folder** — `<Sample Library>/Drums`, the drum browser's MY DRUMS tab and
 *     Preferences → FOLDERS → Drums. The Electron main-process module `userDrums.ts` ported over `terminatorFs`:
 *     the page still names RELATIVE paths and never absolutes, and the files play through the library's own
 *     `/lib/b64/` route (the Drums folder is inside the library root, which libraryCore already registers with
 *     `serveRoots`).
 */
import { isNative, native, nativeBoot } from './juceBridge';
import { setNativeDrumUrls } from '../drums/drumR2';

type AnyRecord = Record<string, any>;

const AUDIO_EXTS = /\.(wav|aif|aiff|mp3|m4a|aac|ogg|opus|flac|webm|mp4|caf)$/i;
const MAX_FILES = 50000;
const MAX_DEPTH = 16;
export const USER_DRUMS_DIRNAME = 'Drums';

const b64url = (s: string): string => {
  const bytes = new TextEncoder().encode(s);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

export interface UserDrumNode { name: string; rel: string; isDir: boolean; children?: UserDrumNode[] }

export interface DrumsOverlayDeps {
  /** The sample-library root (libraryCore.libraryRoot) — the drums folder lives inside it and moves with it. */
  libraryRoot: () => string;
}

/** Build the `window.terminator.drumsUser*` keys and point the page's drum URLs at the shell. */
export function buildDrumsOverlay(deps: DrumsOverlayDeps): {
  keys: AnyRecord;
  userDrumsDir: () => string;
  bundledDir: () => string;
  listUserDrums: (root: string) => Promise<{ root: UserDrumNode[]; truncated: boolean; dir: string }>;
} {
  const sep = (): string => nativeBoot()?.dirs.sep ?? '/';
  const userDrumsDir = (): string => {
    const root = deps.libraryRoot();
    return root.endsWith(sep()) ? root + USER_DRUMS_DIRNAME : root + sep() + USER_DRUMS_DIRNAME;
  };
  const bundledDir = (): string => String(nativeBoot()?.dirs.drumsBundledDir ?? '');
  /** Absolute path for a relative path inside the drums folder, or null (the containment rule Electron's
   *  resolveUserDrum enforces: inside the folder, and an audio file). */
  const resolveUserDrum = (rel: string): string | null => {
    if (!rel || rel.includes('\0') || rel.includes('..') || /^([/\\]|[A-Za-z]:)/.test(rel)) return null;
    if (!AUDIO_EXTS.test(rel)) return null;
    return userDrumsDir() + sep() + rel.split('/').join(sep());
  };

  // The page's two drum URL builders, answered by the shell instead of by a custom scheme.
  setNativeDrumUrls({
    sample: (id: string) => new URL(`/drums/${id}.flac`, location.href).href,
    user: (rel: string) => {
      const p = resolveUserDrum(rel);
      return p ? new URL(`/lib/b64/${b64url(p)}`, location.href).href : '';
    },
  });

  const listUserDrums = async (root: string): Promise<{ root: UserDrumNode[]; truncated: boolean; dir: string }> => {
    await native.fs({ verb: 'mkdir', path: root }).catch(() => null);
    let count = 0;
    let truncated = false;
    const walk = async (dir: string, rel: string, depth: number): Promise<UserDrumNode[]> => {
      if (depth > MAX_DEPTH) { truncated = true; return []; }
      const r = await native.fs({ verb: 'list', dir }).catch(() => null);
      const ents = (r?.ok ? (r.entries as any[]) : []).slice();
      ents.sort((a, b) => String(a.fileName).localeCompare(String(b.fileName), undefined, { numeric: true, sensitivity: 'base' }));
      const out: UserDrumNode[] = [];
      for (const e of ents) {
        const fileName = String(e.fileName ?? '');
        if (!fileName || fileName.startsWith('.')) continue;
        const r2 = rel ? `${rel}/${fileName}` : fileName;
        if (e.isDir) {
          const kids = await walk(String(e.path), r2, depth + 1);
          if (kids.length) out.push({ name: fileName, rel: r2, isDir: true, children: kids });
        } else if (AUDIO_EXTS.test(fileName)) {
          if (++count > MAX_FILES) { truncated = true; break; }
          out.push({ name: fileName, rel: r2, isDir: false });
        }
      }
      return out;
    };
    return { root: await walk(root, '', 0), truncated, dir: root };
  };

  const keys: AnyRecord = {
    drumsUserList: () => listUserDrums(userDrumsDir()),
    drumsUserDir: async () => ({ path: userDrumsDir(), isDefault: true }),
    drumsUserReveal: async () => {
      const dir = userDrumsDir();
      await native.fs({ verb: 'mkdir', path: dir });
      const r = await native.fs({ verb: 'openPath', path: dir });
      return r?.ok ? { ok: true } : { ok: false, error: r?.error ?? 'could not open' };
    },
    /** Move the whole folder's CONTENTS to the Trash — never unlink. A refusal (a network volume with no
     *  Trash) stops at the first item and says so, rather than deleting for real. */
    drumsUserEmpty: async () => {
      const dir = userDrumsDir();
      const r = await native.fs({ verb: 'list', dir }).catch(() => null);
      const ents = r?.ok ? (r.entries as any[]) : [];
      let moved = 0;
      for (const e of ents) {
        const name = String(e.fileName ?? '');
        if (!name || name.startsWith('.')) continue;
        const t = await native.fs({ verb: 'trash', path: String(e.path) }).catch(() => null);
        if (!t?.ok) return { ok: false, moved, error: `Could not move "${name}" to the Trash — nothing was deleted for real` };
        moved++;
      }
      return { ok: true, moved };
    },
  };

  return { keys, userDrumsDir, bundledDir, listUserDrums };
}

export type DrumsOverlay = ReturnType<typeof buildDrumsOverlay>;

/** PROBE: the app self-test for drums (window.__terminatorNativeDrums.selfTest).
 *  - the bundled route answers a real id with real bytes, and refuses anything that is not a 16-hex id;
 *  - the MY DRUMS walk is proven against a folder the probe FILLS ITSELF in temp — never the user's own drums
 *    folder, which is legitimately empty on a fresh machine (and is not something a self-test should write to).
 *  A build with no bundled library still gates: tools/ci/probe-app.sh points TERMINATOR_DRUMS_DIR at a fixture. */
export function installDrumsProbe(overlay: DrumsOverlay): void {
  if (!isNative()) return;
  (window as any).__terminatorNativeDrums = {
    selfTest: async (): Promise<AnyRecord> => {
      const out: AnyRecord = {};
      try {
        const sep = nativeBoot()?.dirs.sep ?? '/';
        const dir = overlay.bundledDir();
        out.bundledDir = !!dir;
        if (dir) {
          const r = await native.fs({ verb: 'list', dir, exts: ['.flac', '.mp3'] }).catch(() => null);
          const files = (r?.ok ? (r.entries as any[]) : []).filter(e => !e.isDir);
          out.bundledCount = files.length;
          const first = files.find(e => /^[0-9a-f]{16}$/.test(String(e.name)));
          if (first) {
            const ext = String(first.fileName).endsWith('.mp3') ? 'mp3' : 'flac';
            const res = await fetch(new URL(`/drums/${String(first.name)}.${ext}`, location.href).href).catch(() => null);
            const buf = res && res.ok ? await res.arrayBuffer().catch(() => null) : null;
            out.bundledBytes = buf ? buf.byteLength : 0;
            out.bundledServed = !!buf && buf.byteLength === Number(first.size);
            // ...and WKWebView can actually DECODE it. The library is lossless FLAC, and a decode that fails
            // here would mean silent drums in the app while every fetch still looked fine (the loader only
            // falls back on a failed FETCH, never on a failed decode).
            if (buf) {
              try {
                const oc = new OfflineAudioContext(1, 1, 44100);
                const dec = await oc.decodeAudioData(buf.slice(0));
                out.bundledDecoded = dec.length > 0;
                out.bundledDecodedFrames = dec.length;
              } catch { out.bundledDecoded = false; }
            }
          }
        }
        // Anything that is not a bare 16-hex id must never reach the filesystem.
        const bad = await fetch(new URL('/drums/..%2F..%2Fetc%2Fhosts.flac', location.href).href).then(x => x.status).catch(() => -1);
        out.bundledBogusRefused = bad !== 200;
        // MY DRUMS: a tree the probe builds in temp, walked by the same code the browser calls.
        const tmp = `${nativeBoot()?.dirs.temp || '/tmp'}${sep}terminator-drums-probe`;
        await native.fs({ verb: 'mkdir', path: `${tmp}${sep}kit` });
        await native.fs({ verb: 'writeText', path: `${tmp}${sep}kit${sep}hit.wav`, text: 'RIFF' });
        await native.fs({ verb: 'writeText', path: `${tmp}${sep}kit${sep}notes.txt`, text: 'not audio' });
        const walked = await overlay.listUserDrums(tmp);
        const kit = walked.root.find(n => n.name === 'kit');
        out.userWalked = !!kit && (kit.children ?? []).some(c => c.rel === 'kit/hit.wav');
        out.userSkipsNonAudio = !!kit && !(kit.children ?? []).some(c => c.rel === 'kit/notes.txt');
        await native.fs({ verb: 'trash', path: tmp });
        // The folder the browser and Preferences actually point at (inside the sample library, so it moves with it).
        const listed = await (window as any).terminator?.drumsUserList?.();
        out.userDirInLibrary = String(listed?.dir ?? '').endsWith(USER_DRUMS_DIRNAME);
        out.ok = out.bundledBogusRefused === true && out.userWalked === true && out.userSkipsNonAudio === true
          && out.userDirInLibrary === true && (!dir || out.bundledServed === true);
      } catch (e: any) {
        out.error = String(e?.message ?? e);
        out.ok = false;
      }
      return out;
    },
  };
}
