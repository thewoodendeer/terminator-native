/**
 * libraryNative — the Sample Library wired to the JUCE shell: `libraryCore` (the Electron library logic, ported)
 * over `terminatorFs` (app/src/ShellServices.cpp), plus the `window.terminator.library*` surface the React app
 * already speaks (LibraryTree / SampleBrowser / ChopperView / Preferences → FOLDERS). Files are served by the
 * shell at `/lib/b64/<base64url(path)>` — only under the roots this module registers (`serveRoots`), which is
 * what `libraryFileUrl(nodeId)` (→ libFileUrl in libraryBridge.ts) points at.
 * Not native yet: YouTube import (yt-dlp child process — the job reports an error phase right away).
 */
import { createLibraryCore, type FsApi, type LibNode, type LibraryCore } from './libraryCore';
import { isNative, native, nativeBoot } from './juceBridge';

type AnyRecord = Record<string, any>;
type Unsub = () => void;

const AUDIO_EXT_LIST = ['wav', 'aif', 'aiff', 'mp3', 'm4a', 'aac', 'ogg', 'opus', 'flac', 'webm', 'mp4', 'caf'];

const bytesToBase64 = (bytes: Uint8Array): Promise<string> =>
  new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onerror = () => reject(r.error ?? new Error('base64 failed'));
    r.onload = () => { const s = String(r.result); resolve(s.slice(s.indexOf(',') + 1)); };
    r.readAsDataURL(new Blob([bytes as unknown as BlobPart]));
  });
const b64url = (s: string): string => {
  const bytes = new TextEncoder().encode(s);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

/** terminatorFs as the library's FsApi. */
export function nativeFsApi(): FsApi {
  const call = (req: AnyRecord) => native.fs(req);
  return {
    readText: async (p) => { const r = await call({ verb: 'readText', path: p }); return r?.ok ? String(r.text ?? '') : null; },
    writeText: async (p, text) => !!(await call({ verb: 'writeText', path: p, text }))?.ok,
    writeBinary: async (p, bytes) => {
      // chunked appends keep every bridge message small (a 10-minute WAV recording is ~100 MB)
      const CHUNK = 3 * 1024 * 1024;
      for (let off = 0; off < bytes.length || (off === 0 && bytes.length === 0); off += CHUNK) {
        const part = bytes.subarray(off, Math.min(bytes.length, off + CHUNK));
        const r = await call({ verb: 'writeBinary', path: p, data: await bytesToBase64(part), append: off > 0 });
        if (!r?.ok) return false;
        if (bytes.length === 0) break;
      }
      return true;
    },
    stat: async (p) => { const r = await call({ verb: 'stat', path: p }); return r?.ok ? { exists: !!r.exists, isDir: !!r.isDir, isFile: !!r.isFile, size: Number(r.size) || 0, modifiedAt: Number(r.modifiedAt) || 0, createdAt: Number(r.createdAt) || 0 } : { exists: false, isDir: false, isFile: false, size: 0, modifiedAt: 0, createdAt: 0 }; },
    list: async (dir) => { const r = await call({ verb: 'list', dir }); return r?.ok ? (r.entries as any[]).map(e => ({ name: String(e.name), fileName: String(e.fileName), path: String(e.path), isDir: !!e.isDir, size: Number(e.size) || 0, modifiedAt: Number(e.modifiedAt) || 0, createdAt: Number(e.createdAt) || 0 })) : []; },
    mkdir: async (p) => !!(await call({ verb: 'mkdir', path: p }))?.ok,
    move: async (from, to) => !!(await call({ verb: 'move', from, to }))?.ok,
    copy: async (from, to) => !!(await call({ verb: 'copy', from, to }))?.ok,
    trash: async (p) => !!(await call({ verb: 'trash', path: p }))?.ok,
    reveal: async (p) => { await call({ verb: 'reveal', path: p }); },
    openPath: async (p) => { await call({ verb: 'openPath', path: p }); },
    serveRoots: async (roots) => { await call({ verb: 'serveRoots', roots }); },
  };
}

export interface LibraryOverlayDeps {
  getSettings: () => Promise<AnyRecord>;
  setSettings: (patch: AnyRecord) => Promise<unknown>;
  settingsSync: () => AnyRecord;
}

/** Build the `window.terminator.library*` keys (+ the FOLDERS-tab root methods) for the native shell. */
export function buildLibraryOverlay(deps: LibraryOverlayDeps): { keys: AnyRecord; core: LibraryCore } {
  const boot = nativeBoot();
  const sep = (boot?.dirs.sep === '\\' ? '\\' : '/') as '/' | '\\';
  const music = boot?.dirs.music ?? '';
  const core = createLibraryCore(nativeFsApi(), { defaultRoot: music ? `${music}${sep}Terminator` : `${sep}Terminator`, sep });
  const startRoot = deps.settingsSync().libraryDir;
  if (typeof startRoot === 'string' && startRoot) core.setLibraryRoot(startRoot);

  const wrap = async <T,>(fn: () => Promise<T>): Promise<T | { error: string }> => { try { return await fn(); } catch (e: any) { return { error: e?.message ?? String(e) }; } };
  const libStr = (v: unknown, max = 1024) => typeof v === 'string' ? v.slice(0, max) : '';
  const libIds = (v: unknown, max = 4096) => Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').slice(0, max) : [];
  const libTarget = (v: unknown) => (v === null || v === undefined) ? null : libStr(v, 4096) || null;
  const libIndex = (v: unknown) => typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.floor(v)) : undefined;

  const changedListeners = new Set<() => void>();
  core.onLibraryChanged(() => { for (const l of changedListeners) { try { l(); } catch { /* */ } } });
  const ytListeners = new Set<(p: AnyRecord) => void>();
  const moveListeners = new Set<(p: { done: number; total: number }) => void>();
  const rootInfo = () => ({ path: core.libraryRoot(), isDefault: !(typeof deps.settingsSync().libraryDir === 'string' && deps.settingsSync().libraryDir) });

  const readFiles = async (files: File[]) => {
    const out: Array<{ name: string; bytes: Uint8Array }> = [];
    for (const f of files) { if (!/\.(wav|aif|aiff|mp3|m4a|aac|ogg|opus|flac|webm|mp4|caf)$/i.test(f.name)) continue; out.push({ name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) }); }
    return out;
  };

  const keys: AnyRecord = {
    libraryGet: () => wrap(() => core.getLibrary()),
    libraryListLink: (id: unknown) => wrap(() => core.listLink(libStr(id, 4096))),
    librarySearchLinks: (q: unknown) => wrap(() => core.searchLinks(typeof q === 'string' ? q.slice(0, 200) : '')),
    libraryCreateFolder: (parentId: unknown, name: unknown, index: unknown) => wrap(() => core.createFolder(libTarget(parentId), libStr(name, 200), libIndex(index))),
    libraryRename: (id: unknown, name: unknown) => wrap(() => core.rename(libStr(id), libStr(name, 200))),
    libraryMove: (ids: unknown, targetId: unknown, index: unknown) => wrap(() => core.move(libIds(ids), libTarget(targetId), libIndex(index))),
    libraryCopy: (ids: unknown, targetId: unknown, index: unknown) => wrap(() => core.copy(libIds(ids), libTarget(targetId), libIndex(index))),
    libraryDuplicate: (ids: unknown) => wrap(() => core.duplicate(libIds(ids))),
    libraryRemove: (ids: unknown) => wrap(() => core.remove(libIds(ids))),
    libraryImportPaths: (paths: unknown, targetId: unknown, index: unknown) => wrap(() => core.importPaths(libIds(paths), libTarget(targetId), libIndex(index))),
    /** Bytes from a WebView drop (no paths) → Imports/ (or the USER SAMPLES folder) + nodes. */
    libraryImportFiles: (files: unknown, targetId: unknown, index: unknown) => wrap(async () => core.importFiles(await readFiles(Array.isArray(files) ? files.filter((f): f is File => f instanceof File) : []), libTarget(targetId), libIndex(index))),
    libraryAddR2Ref: (targetId: unknown, r2Id: unknown, name: unknown, r2Playlist: unknown, durationSec: unknown, index: unknown) =>
      wrap(() => core.addR2Ref(libTarget(targetId), libStr(r2Id, 128), libStr(name, 200), libStr(r2Playlist, 200), typeof durationSec === 'number' ? durationSec : undefined, libIndex(index))),
    libraryImportR2: (targetId: unknown, r2Id: unknown, name: unknown, r2Playlist: unknown, durationSec: unknown, index: unknown) =>
      // a REAL copy of an R2 sample needs the pull (network) — until the native pull lands, keep a reference (the Electron offline fallback)
      wrap(() => core.addR2Ref(libTarget(targetId), libStr(r2Id, 128), libStr(name, 200), libStr(r2Playlist, 200), typeof durationSec === 'number' ? durationSec : undefined, libIndex(index))),
    libraryReveal: (id: unknown) => wrap(async () => { await core.reveal(libStr(id)); return { ok: true }; }),
    libraryPickFolder: async () => {
      const r = await native.fs({ verb: 'openDialog', mode: 'dir', title: 'Add a folder from your computer', dir: core.libraryRoot() });
      if (!r?.ok || r.cancelled) return [];
      return wrap(() => core.importPaths((r.paths as string[] | undefined) ?? [r.path], null));
    },
    libraryPickFiles: async (targetId: unknown) => {
      const r = await native.fs({ verb: 'openDialog', mode: 'file', multiple: true, title: 'Import samples', dir: core.libraryRoot(), filters: AUDIO_EXT_LIST.map(e => `*.${e}`).join(';') });
      if (!r?.ok || r.cancelled) return [];
      return wrap(() => core.importPaths((r.paths as string[] | undefined) ?? [r.path], libTarget(targetId)));
    },
    librarySaveRecording: (payload: unknown) => wrap(async () => {
      const { filename, data } = (payload ?? {}) as { filename?: unknown; data?: unknown };
      if (!(data instanceof ArrayBuffer) || data.byteLength === 0 || data.byteLength > 2 * 1024 * 1024 * 1024) throw new Error('invalid sample data');
      return core.saveRecording(libStr(filename, 200), new Uint8Array(data));
    }),
    libraryYouTubeImport: async (_url: unknown, _targetId: unknown) => {
      const jobId = `native-${Date.now().toString(36)}`;
      setTimeout(() => { for (const l of ytListeners) { try { l({ jobId, phase: 'error', error: 'YouTube import is not in the native app yet' }); } catch { /* */ } } }, 0);
      return { jobId };
    },
    libraryYouTubeCancel: async (_jobId: unknown) => ({ ok: true }),
    onLibraryChanged: (handler: () => void): Unsub => { changedListeners.add(handler); return () => changedListeners.delete(handler); },
    onLibraryYouTubeProgress: (handler: (p: AnyRecord) => void): Unsub => { ytListeners.add(handler); return () => ytListeners.delete(handler); },
    /** The URL the shell serves a library file at (sync — the cached tree resolves ids; null before the first load / unknown). */
    libraryFileUrl: (nodeId: unknown): string | null => {
      const p = core.resolveReadableSync(libStr(nodeId, 4096));
      if (!p) return null;
      return new URL(`/lib/b64/${b64url(p)}`, location.href).href;
    },

    // Preferences → FOLDERS: the library root
    getLibraryRoot: async () => rootInfo(),
    chooseLibraryRoot: async (mode: 'move' | 'point') => {
      if (mode !== 'move' && mode !== 'point') return { error: 'invalid mode', ...rootInfo() };
      const r = await native.fs({ verb: 'openDialog', mode: 'dir', title: mode === 'move' ? 'Move the sample library to…' : 'Use this folder as the sample library', dir: core.libraryRoot() });
      if (!r?.ok || r.cancelled) return { cancelled: true, ...rootInfo() };
      const dir = String(r.path);
      try {
        let moved: number | undefined, oldRoot: string | undefined;
        if (mode === 'move') { const res = await core.moveLibrary(dir, (done, total) => { for (const l of moveListeners) { try { l({ done, total }); } catch { /* */ } } }); moved = res.moved; oldRoot = res.oldRoot; }
        else core.setLibraryRoot(dir);
        await deps.setSettings({ libraryDir: dir });
        return { ok: true, moved, oldRoot, ...rootInfo() };
      } catch (e: any) { return { error: e?.message ?? String(e), ...rootInfo() }; }
    },
    resetLibraryRoot: async () => { await deps.setSettings({ libraryDir: null }); core.setLibraryRoot(null); return { ok: true, ...rootInfo() }; },
    revealLibraryRoot: async () => { await native.fs({ verb: 'mkdir', path: core.libraryRoot() }); const r = await native.fs({ verb: 'openPath', path: core.libraryRoot() }); return r?.ok ? { ok: true } : { error: r?.error ?? 'could not open' }; },
    onLibraryMoveProgress: (cb: (p: { done: number; total: number }) => void): Unsub => { moveListeners.add(cb); return () => moveListeners.delete(cb); },
  };
  return { keys, core };
}

declare global {
  interface Window { __terminatorNativeLibrary?: { selfTest: () => Promise<AnyRecord> } }
}

/** The probe's read-only self-test (tools/ci/probe-app.sh): the tree loads, the roots are registered, and — when
 *  the library already holds a managed file — the shell serves it at its /lib/b64/ URL. Never writes to the
 *  user's library beyond the first-run bootstrap the real app does anyway. */
export function installLibraryProbe(core: LibraryCore, keys: AnyRecord): void {
  if (!isNative()) return;
  window.__terminatorNativeLibrary = {
    selfTest: async () => {
      const r: AnyRecord = {};
      try {
        const t = await core.getLibrary();
        r.root = t.libraryRoot;
        r.nodes = Object.keys(t.nodes).length;
        r.systemOk = ['recordings', 'youtube', 'imports', 'user'].every(id => !!t.nodes[id]);
        // a managed file that is actually on disk (a library can carry stale entries for files moved away)
        let managed: LibNode | undefined;
        let tried = 0;
        const candidates = Object.values(t.nodes).filter((n: LibNode) => n.type === 'file' && !!n.path && core.isManaged(n.path!) && /\.(wav|mp3|m4a|aif|aiff|flac|ogg)$/i.test(n.path!))
          .sort((a: LibNode, b: LibNode) => Number(b.meta?.source === 'recording') - Number(a.meta?.source === 'recording')); // recordings first (always local)
        for (const n of candidates) {
          tried++;
          const st = await native.fs({ verb: 'stat', path: n.path! });
          if (st?.ok && st.isFile) { managed = n; break; }
        }
        r.candidatesTried = tried;
        if (managed) {
          const url = keys.libraryFileUrl(managed.id) as string | null;
          r.servedUrl = url ? url.slice(0, 60) + '…' : null;
          if (url) {
            const res = await fetch(url);
            r.servedStatus = res.status;
            const ab = await res.arrayBuffer();
            r.servedBytes = ab.byteLength;
            r.servedOk = res.ok && ab.byteLength > 0 && ab.byteLength === (managed.meta?.size ?? ab.byteLength);
            // can the <audio> preview stream it? (WebKit media loading through the resource provider) — opt-in:
            // window.__terminatorProbeAudio = true (a media load through the scheme handler can stall the page)
            if ((window as any).__terminatorProbeAudio) r.audioCanPlay = await new Promise<boolean>((resolve) => {
              const a = new Audio();
              const done = (v: boolean) => { a.src = ''; resolve(v); };
              a.addEventListener('loadedmetadata', () => done(true), { once: true });
              a.addEventListener('error', () => done(false), { once: true });
              setTimeout(() => done(false), 4000);
              a.preload = 'metadata'; a.src = url;
            });
          }
        } else r.servedFile = 'none';
        const blocked = await fetch(new URL('/lib/b64/' + b64url('/etc/hosts'), location.href).href).then(x => x.status).catch(() => -1);
        r.outsideRootBlocked = blocked !== 200;
        r.ok = r.systemOk && (managed ? r.servedOk === true : true) && r.outsideRootBlocked;
      } catch (e) { r.error = String((e as any)?.stack ?? e); r.ok = false; }
      return r;
    },
  };
}
