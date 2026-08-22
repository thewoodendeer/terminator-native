/**
 * libraryCore — the Sample Library (~/Music/Terminator: library.json tree + Recordings/ YouTube/ Imports/
 * User Samples/) for Terminator 3.0, ported VERBATIM-IN-LOGIC from the Electron main process
 * (`terminator/src/main/library.ts` @ 0af0dbe) onto an injectable `FsApi`:
 *   • in the native app the FsApi is `terminatorFs` (app/src/ShellServices.cpp) — libraryNative.ts wires it;
 *   • in tests it is Node's fs over a temp folder (ui/scripts/test-library.mts) — the Electron harness's cases.
 * The page is first-party code, so the library's organisation logic lives here (one implementation, the same
 * library.json on disk the Electron app writes — a user's library moves between the two apps unchanged); the
 * shell only does generic, path-checked file verbs and serves files under the roots this module registers
 * (`serveRoots`). Pure: no DOM, no bridge imports (Node can run it as-is).
 *
 * The Electron module's doc comment, kept because it is the spec:
 *   The tree in library.json is the ORGANISATION (virtual): moving an item between folders never moves the
 *   file on disk — files stay where their origin put them, so nothing you do in the browser can lose a file.
 *   Deleting sends the file to the Trash. "Linked" folders point at directories elsewhere on the computer and
 *   are scanned live, read-only. USER SAMPLES is the exception, on purpose: scanned from disk like a link, but
 *   WRITABLE — new folder = a real directory, move/copy/rename happen on disk, delete goes to the Trash, a drop
 *   from Finder copies in. Its nodes carry ids `user:<relative path>` and `mirrored: true`; nothing about them
 *   is stored in library.json (disk is the truth), and every path is proven to sit under <root>/User Samples
 *   before it is touched. Every path this module touches is proven to sit under the library root or under a
 *   linked directory before it's read, copied, renamed or trashed.
 * Differences vs Electron (deliberate): no legacy userData migrations (Electron-only dirs); a failed Trash
 * leaves the file on disk (no unlink fallback); `importFiles` (bytes from a WebView drop, which has no paths).
 */

export type LibNodeType = 'folder' | 'file' | 'link' | 'r2';
export interface LibNode {
  id: string;
  type: LibNodeType;
  name: string;
  children?: string[];
  path?: string;
  meta?: { source?: 'recording' | 'youtube' | 'import' | 'linked' | 'user'; videoId?: string; durationSec?: number; r2Id?: string; r2Playlist?: string; size?: number; createdAt?: number };
  system?: boolean;
  readonly?: boolean;
  mirrored?: boolean;
  lazy?: boolean;
}
export interface LibraryTree { version: 1; root: string[]; nodes: Record<string, LibNode> }
export interface LibraryData { root: string[]; nodes: Record<string, LibNode>; libraryRoot: string }

export interface FsStat { exists: boolean; isDir: boolean; isFile: boolean; size: number; modifiedAt: number; createdAt: number }
export interface FsEntry { name: string; fileName: string; path: string; isDir: boolean; size: number; modifiedAt: number; createdAt: number }
/** The generic file verbs the library needs. Every implementation: absolute paths only; `list` is ONE level,
 *  dot-files skipped; `mkdir` creates parents; `move` renames (across volumes too) and refuses an existing
 *  target; `copy` copies a file or a folder recursively (dot-files skipped) and refuses an existing target;
 *  `trash` moves to the OS Trash; `writeText` is atomic. */
export interface FsApi {
  readText(path: string): Promise<string | null>;
  writeText(path: string, text: string): Promise<boolean>;
  writeBinary(path: string, bytes: Uint8Array): Promise<boolean>;
  stat(path: string): Promise<FsStat>;
  list(dir: string): Promise<FsEntry[]>;
  mkdir(path: string): Promise<boolean>;
  move(from: string, to: string): Promise<boolean>;
  copy(from: string, to: string): Promise<boolean>;
  trash(path: string): Promise<boolean>;
  reveal(path: string): Promise<void>;
  openPath(path: string): Promise<void>;
  /** Tell the host which roots it may serve files from (the native shell's /lib/b64/). Optional. */
  serveRoots?(roots: string[]): Promise<void>;
}
export interface LibraryConfig { defaultRoot: string; sep: '/' | '\\' }

export const AUDIO_EXTS = /\.(wav|aif|aiff|mp3|m4a|aac|ogg|opus|flac|webm|mp4|caf)$/i;
export const DL_PLAYLISTS_ID = 'dl-playlists';
const SYSTEM: Array<{ id: string; name: string; dir: string }> = [
  { id: 'recordings', name: 'RECORDINGS', dir: 'Recordings' },
  { id: 'youtube', name: 'YOUTUBE', dir: 'YouTube' },
  { id: 'imports', name: 'IMPORTS', dir: 'Imports' },
  { id: 'user', name: 'USER SAMPLES', dir: 'User Samples' },
];
const USER_ID = 'user';
const USER_MAX_FILES = 50000, USER_MAX_DEPTH = 16;
const LINK_MAX_FILES = 50000, LINK_MAX_DEPTH = 16;
const LINK_INDEX_TTL_MS = 5 * 60_000, SEARCH_MAX_PER_ROOT = 400;

// ── paths (posix or windows, decided by `sep`) ───────────────────────────────
export function makePath(sep: '/' | '\\') {
  const splitAll = (p: string) => p.split(/[\\/]+/);
  const isAbs = (p: string) => sep === '/' ? p.startsWith('/') : (/^[A-Za-z]:[\\/]/.test(p) || p.startsWith('\\\\'));
  /** Normalise: collapse separators, resolve `.`/`..`, no trailing separator (except a bare root). */
  const norm = (p: string): string => {
    if (!p) return '';
    const parts = splitAll(p);
    const out: string[] = [];
    let prefix = '';
    if (sep === '/') { if (p.startsWith('/')) prefix = '/'; }
    else if (/^[A-Za-z]:/.test(p)) { prefix = parts[0].slice(0, 2) + '\\'; parts[0] = parts[0].slice(2); }
    else if (p.startsWith('\\\\')) { prefix = '\\\\'; }
    for (const seg of parts) {
      if (!seg || seg === '.') continue;
      if (seg === '..') { if (out.length) out.pop(); continue; }
      out.push(seg);
    }
    const body = out.join(sep);
    if (prefix) return body ? prefix + body : prefix;
    return body;
  };
  const join = (...parts: string[]) => norm(parts.filter(Boolean).join(sep));
  const resolve = (...parts: string[]) => join(...parts);
  const basename = (p: string, ext?: string) => {
    const segs = splitAll(norm(p)); let b = segs[segs.length - 1] ?? '';
    if (ext && b.toLowerCase().endsWith(ext.toLowerCase()) && b.length > ext.length) b = b.slice(0, -ext.length);
    return b;
  };
  const dirname = (p: string) => { const n = norm(p); const i = n.lastIndexOf(sep); if (i < 0) return ''; if (i === 0 && sep === '/') return '/'; const d = n.slice(0, i); return d.endsWith(':') ? d + sep : d; };
  const extname = (p: string) => { const b = basename(p); const i = b.lastIndexOf('.'); return i > 0 ? b.slice(i) : ''; };
  const under = (p: string, dir: string) => { const np = norm(p), nd = norm(dir); if (!np || !nd || np === nd) return false; const d = nd.endsWith(sep) ? nd : nd + sep; return np.startsWith(d); };
  const relative = (from: string, to: string) => { const nf = norm(from), nt = norm(to); if (nf === nt) return ''; return under(nt, nf) ? nt.slice((nf.endsWith(sep) ? nf : nf + sep).length) : nt; };
  return { sep, isAbs, norm, join, resolve, basename, dirname, extname, under, relative };
}

const safeName = (name: string, fallback = 'untitled'): string => {
  const clean = String(name ?? '').split('').filter(ch => ch.charCodeAt(0) >= 32).join('')
    .replace(/[/\\:*?"<>|]/g, '-').replace(/\s+/g, ' ').trim().slice(0, 120).replace(/^\.+/, '').replace(/[. ]+$/, '');
  return clean || fallback;
};
const newId = (): string => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
const byName = (a: { fileName: string }, b: { fileName: string }) => a.fileName.localeCompare(b.fileName, undefined, { numeric: true });

export type LibraryCore = ReturnType<typeof createLibraryCore>;

export function createLibraryCore(fs: FsApi, cfg: LibraryConfig) {
  const path = makePath(cfg.sep);
  let rootDirOverride: string | null = null;
  let cache: LibraryTree | null = null;
  const linkIndexCache = new Map<string, { at: number; nodes: LibNode[] }>();
  const listeners = new Set<() => void>();
  const notify = () => { for (const l of listeners) { try { l(); } catch { /* */ } } };

  const libraryRoot = (): string => rootDirOverride ?? path.norm(cfg.defaultRoot);
  const systemDir = (id: 'recordings' | 'youtube' | 'imports' | 'user'): string => path.join(libraryRoot(), SYSTEM.find(s => s.id === id)!.dir);
  const userDir = () => systemDir('user');
  const indexPath = () => path.join(libraryRoot(), 'library.json');

  const exists = async (p: string) => (await fs.stat(p)).exists;
  const isDirectory = async (p: string) => (await fs.stat(p)).isDir;
  const mkdirp = (p: string) => fs.mkdir(p);
  const listDir = async (dir: string): Promise<FsEntry[]> => { try { const e = await fs.list(dir); return e.filter(x => !x.fileName.startsWith('.')).sort(byName); } catch { return []; } };
  const statMeta = async (p: string): Promise<{ size?: number; createdAt?: number }> => { const st = await fs.stat(p); return st.exists ? { size: st.size, createdAt: st.createdAt || st.modifiedAt } : {}; };

  function emptyTree(): LibraryTree {
    const t: LibraryTree = { version: 1, root: [], nodes: {} };
    for (const s of SYSTEM) { t.nodes[s.id] = { id: s.id, type: 'folder', name: s.name, children: [], system: true }; t.root.push(s.id); }
    return t;
  }
  function parentOf(t: LibraryTree, id: string): string | null { for (const n of Object.values(t.nodes)) if (n.children?.includes(id)) return n.id; return null; }
  function detach(t: LibraryTree, id: string): void { t.root = t.root.filter(x => x !== id); for (const n of Object.values(t.nodes)) if (n.children) n.children = n.children.filter(x => x !== id); }
  function isDescendant(t: LibraryTree, maybeChild: string, ancestor: string): boolean { let p = parentOf(t, maybeChild); while (p) { if (p === ancestor) return true; p = parentOf(t, p); } return false; }
  function attach(t: LibraryTree, id: string, parentId: string | null, index?: number): void {
    const list = parentId ? (t.nodes[parentId].children ??= []) : t.root;
    const i = index === undefined || index < 0 || index > list.length ? list.length : index;
    list.splice(i, 0, id);
  }
  const linkRoots = (t: LibraryTree): string[] => Object.values(t.nodes).filter(n => n.type === 'link' && n.path).map(n => n.path!);
  const isManaged = (p: string) => path.under(p, libraryRoot());
  const publishRoots = async (t: LibraryTree) => { if (fs.serveRoots) { try { await fs.serveRoots([libraryRoot(), ...linkRoots(t)]); } catch { /* */ } } };

  async function load(): Promise<LibraryTree> {
    if (cache) return cache;
    let t: LibraryTree | null = null;
    try {
      const raw = await fs.readText(indexPath());
      if (raw) { const j = JSON.parse(raw); if (j && j.version === 1 && Array.isArray(j.root) && j.nodes && typeof j.nodes === 'object') t = j as LibraryTree; }
    } catch { /* first run */ }
    const fresh = !t;
    if (!t) t = emptyTree();
    for (const s of SYSTEM) {
      if (!t.nodes[s.id]) t.nodes[s.id] = { id: s.id, type: 'folder', name: s.name, children: [], system: true };
      if (!t.root.includes(s.id) && !parentOf(t, s.id)) t.root.push(s.id);
    }
    cache = t;
    if (fresh) {
      try { for (const s of SYSTEM) await mkdirp(path.join(libraryRoot(), s.dir)); await save(t); } catch { /* read-only disk — stays in memory */ }
    }
    await publishRoots(t);
    return t;
  }
  async function save(t: LibraryTree): Promise<void> {
    cache = t;
    linkIndexCache.clear();
    await mkdirp(libraryRoot());
    if (!(await fs.writeText(indexPath(), JSON.stringify(t, null, 1)))) throw new Error('could not write library.json');
    await publishRoots(t);
    notify();
  }

  // ── USER SAMPLES ──
  const userIdFor = (abs: string): string => 'user:' + path.relative(userDir(), abs).split(/[\\/]/).join('/');
  function userPathOf(id: string): string | null {
    if (!id.startsWith('user:')) return null;
    const rel = id.slice(5);
    if (!rel || rel.includes('\0')) return null;
    const p = path.resolve(userDir(), ...rel.split('/'));
    return path.under(p, userDir()) ? p : null;
  }
  async function mirroredDir(targetId: string | null): Promise<string | null> {
    if (targetId === USER_ID) return userDir();
    if (targetId && targetId.startsWith('user:')) { const p = userPathOf(targetId); if (p && await isDirectory(p)) return p; }
    return null;
  }
  const userNodeFor = (abs: string, isDir: boolean): LibNode => isDir
    ? { id: userIdFor(abs), type: 'folder', name: path.basename(abs), children: [], path: abs, mirrored: true }
    : { id: userIdFor(abs), type: 'file', name: path.basename(abs).replace(/\.[^.]+$/, ''), path: abs, mirrored: true, meta: { source: 'user' } };
  async function uniqueDir(dir: string, base: string): Promise<string> {
    let cand = path.join(dir, base); let n = 2; const m = /^(.*?) (\d+)$/.exec(base); let stem = base;
    if (m) { stem = m[1]; n = Number(m[2]) + 1; }
    while (await exists(cand)) { cand = path.join(dir, `${stem} ${n}`); n++; }
    return cand;
  }
  async function uniquePath(dir: string, base: string, ext: string): Promise<string> {
    let cand = path.join(dir, `${base}${ext}`); let n = 2; const m = /^(.*?) (\d+)$/.exec(base); let stem = base;
    if (m) { stem = m[1]; n = Number(m[2]) + 1; }
    while (await exists(cand)) { cand = path.join(dir, `${stem} ${n}${ext}`); n++; }
    return cand;
  }
  async function moveOnDisk(from: string, to: string): Promise<void> { if (!(await fs.move(from, to))) throw new Error(`could not move ${path.basename(from)}`); }
  async function copyOnDisk(from: string, to: string): Promise<void> { if (!(await fs.copy(from, to))) throw new Error(`could not copy ${path.basename(from)}`); }
  async function scanUser(dir: string, budget: { left: number }, depth = 0): Promise<LibNode[]> {
    const out: LibNode[] = [];
    for (const e of await listDir(dir)) {
      if (budget.left <= 0) break;
      if (e.isDir) {
        if (depth >= USER_MAX_DEPTH) continue;
        const kids = await scanUser(e.path, budget, depth + 1);
        out.push({ ...userNodeFor(e.path, true), children: kids.filter(k => path.dirname(k.path!) === e.path).map(k => k.id) }, ...kids);
      } else if (AUDIO_EXTS.test(e.fileName)) {
        budget.left--;
        out.push({ ...userNodeFor(e.path, false), meta: { source: 'user', size: e.size, createdAt: e.createdAt || e.modifiedAt } });
      }
    }
    return out;
  }
  async function nodeOrVirtual(t: LibraryTree, id: string): Promise<LibNode | undefined> {
    const n = t.nodes[id];
    if (n) return n;
    if (id.startsWith('link:')) {
      const p = id.slice(5);
      if (!linkRoots(t).some(r => path.under(p, r))) return undefined;
      if (AUDIO_EXTS.test(p)) return { id, type: 'file', name: path.basename(p).replace(/\.[^.]+$/, ''), path: p, readonly: true, meta: { source: 'linked' } };
      if (await isDirectory(p)) return { id, type: 'folder', name: path.basename(p), path: p, readonly: true, children: [] };
      return undefined;
    }
    const up = userPathOf(id);
    if (up) { const st = await fs.stat(up); return st.exists ? userNodeFor(up, st.isDir) : undefined; }
    return undefined;
  }

  // ── read ──
  async function scanLink(dir: string, budget: { left: number; total: number }, depth = 0): Promise<LibNode[]> {
    const out: LibNode[] = [];
    for (const e of await listDir(dir)) {
      if (e.isDir) {
        if (depth >= LINK_MAX_DEPTH) continue;
        const kids = await scanLink(e.path, budget, depth + 1);
        out.push({ id: `link:${e.path}`, type: 'folder', name: e.fileName, children: kids.filter(k => path.dirname(k.path!) === e.path).map(k => k.id), readonly: true, path: e.path }, ...kids);
      } else if (AUDIO_EXTS.test(e.fileName)) {
        budget.total++;
        if (budget.left <= 0) continue;
        budget.left--;
        out.push({ id: `link:${e.path}`, type: 'file', name: e.fileName.replace(/\.[^.]+$/, ''), path: e.path, readonly: true, meta: { source: 'linked' } });
      }
    }
    return out;
  }
  async function listLinkDir(dir: string): Promise<LibNode[]> {
    const out: LibNode[] = [];
    for (const e of await listDir(dir)) {
      if (e.isDir) out.push({ id: `link:${e.path}`, type: 'folder', name: e.fileName, children: [], readonly: true, path: e.path, lazy: true });
      else if (AUDIO_EXTS.test(e.fileName)) out.push({ id: `link:${e.path}`, type: 'file', name: e.fileName.replace(/\.[^.]+$/, ''), path: e.path, readonly: true, meta: { source: 'linked' } });
    }
    return out;
  }
  async function linkDirOf(id: string): Promise<string | null> {
    const t = await load();
    const n = t.nodes[id];
    const p = n?.type === 'link' && n.path ? n.path : id.startsWith('link:') ? id.slice(5) : null;
    if (!p || !linkRoots(t).some(r => path.under(p, r) || path.norm(p) === path.norm(r))) return null;
    return (await isDirectory(p)) ? p : null;
  }
  async function resolveReadable(idOrPath: string): Promise<string | null> {
    const t = await load();
    return resolveReadableIn(t, idOrPath);
  }
  function resolveReadableIn(t: LibraryTree, idOrPath: string): string | null {
    if (idOrPath === USER_ID) return userDir();
    const n = t.nodes[idOrPath];
    const p = n?.path ?? userPathOf(idOrPath) ?? (idOrPath.startsWith('link:') ? idOrPath.slice(5) : (path.isAbs(idOrPath) ? idOrPath : null));
    if (!p) return null;
    if (isManaged(p) || linkRoots(t).some(r => path.under(p, r))) return p;
    return null;
  }
  /** The readable path behind an id WITHOUT touching the disk (the cached tree; null before the first load). */
  function resolveReadableSync(idOrPath: string): string | null { return cache ? resolveReadableIn(cache, idOrPath) : null; }

  async function listLink(id: string): Promise<LibNode[]> { const dir = await linkDirOf(id); if (!dir) throw new Error('not a linked folder'); return listLinkDir(dir); }
  async function searchLinks(query: string): Promise<Record<string, LibNode[]>> {
    const q = query.trim().toLowerCase(); const out: Record<string, LibNode[]> = {};
    if (!q) return out;
    const t = await load();
    for (const n of Object.values(t.nodes)) {
      if (n.type !== 'link' || !n.path) continue;
      let idx = linkIndexCache.get(n.path);
      if (!idx || Date.now() - idx.at > LINK_INDEX_TTL_MS) { idx = { at: Date.now(), nodes: (await scanLink(n.path, { left: LINK_MAX_FILES, total: 0 })).filter(k => k.type === 'file') }; linkIndexCache.set(n.path, idx); }
      const hits: LibNode[] = [];
      for (const k of idx.nodes) { if (k.name.toLowerCase().includes(q)) { hits.push(k); if (hits.length >= SEARCH_MAX_PER_ROOT) break; } }
      if (hits.length) out[n.id] = hits;
    }
    return out;
  }
  async function getLibrary(): Promise<LibraryData> {
    const t = await load();
    const nodes: Record<string, LibNode> = {};
    for (const [id, n] of Object.entries(t.nodes)) nodes[id] = { ...n, children: n.children ? [...n.children] : undefined };
    for (const n of Object.values(t.nodes)) {
      if (n.type !== 'link' || !n.path) continue;
      const top = await listLinkDir(n.path);
      nodes[n.id] = { ...n, children: top.map(k => k.id) };
      for (const k of top) nodes[k.id] = k;
    }
    await mkdirp(userDir());
    const ukids = await scanUser(userDir(), { left: USER_MAX_FILES });
    nodes[USER_ID] = { ...(nodes[USER_ID] ?? { id: USER_ID, type: 'folder', name: 'USER SAMPLES', system: true }), children: ukids.filter(k => path.dirname(k.path!) === userDir()).map(k => k.id), path: userDir(), mirrored: true };
    for (const k of ukids) nodes[k.id] = k;
    return { root: [...t.root], nodes, libraryRoot: libraryRoot() };
  }

  // ── mutations ──
  async function createFolder(parentId: string | null, name: string, index?: number): Promise<LibNode> {
    const t = await load();
    const mdir = await mirroredDir(parentId);
    if (mdir) { const to = await uniqueDir(mdir, safeName(name, 'New Folder')); await mkdirp(to); notify(); return userNodeFor(to, true); }
    if (parentId && (!t.nodes[parentId] || t.nodes[parentId].type !== 'folder' || t.nodes[parentId].readonly)) throw new Error('bad parent');
    const id = newId();
    const n: LibNode = { id, type: 'folder', name: safeName(name, 'New Folder'), children: [] };
    t.nodes[id] = n; attach(t, id, parentId, index);
    await save(t); return n;
  }
  async function rename(id: string, name: string): Promise<LibNode> {
    const t = await load();
    const up = userPathOf(id);
    if (up) {
      const isDir = await isDirectory(up);
      const ext = isDir ? '' : path.extname(up);
      const clean = safeName(name, path.basename(up, ext));
      const to = isDir ? await uniqueDir(path.dirname(up), clean) : await uniquePath(path.dirname(up), clean, ext);
      if (to !== up) await moveOnDisk(up, to);
      notify();
      return userNodeFor(to, isDir);
    }
    const n = t.nodes[id];
    if (!n || n.system || n.readonly) throw new Error('cannot rename');
    const clean = safeName(name, n.name);
    if (n.type === 'file' && n.path && isManaged(n.path)) {
      const ext = path.extname(n.path);
      const to = await uniquePath(path.dirname(n.path), clean, ext);
      await moveOnDisk(n.path, to);
      n.path = to; n.name = path.basename(to, ext);
    } else n.name = clean;
    await save(t); return n;
  }
  async function moveIndexFolderToDisk(t: LibraryTree, folderId: string, destDir: string): Promise<void> {
    const n = t.nodes[folderId];
    if (!n || n.type !== 'folder' || n.system) return;
    const dir = await uniqueDir(destDir, safeName(n.name, 'Folder'));
    await mkdirp(dir);
    for (const c of [...(n.children ?? [])]) {
      const k = t.nodes[c]; if (!k) continue;
      if (k.type === 'file' && k.path && isManaged(k.path)) { const ext = path.extname(k.path); await moveOnDisk(k.path, await uniquePath(dir, safeName(k.name, 'sample'), ext)); detach(t, c); delete t.nodes[c]; }
      else if (k.type === 'folder') await moveIndexFolderToDisk(t, c, dir);
      else { detach(t, c); delete t.nodes[c]; }
    }
    detach(t, folderId); delete t.nodes[folderId];
  }
  async function pullUserIntoIndex(t: LibraryTree, abs: string): Promise<string | null> {
    const st = await fs.stat(abs);
    if (!st.exists) return null;
    if (st.isDir) {
      const id = newId();
      t.nodes[id] = { id, type: 'folder', name: path.basename(abs), children: [] };
      for (const e of await listDir(abs)) {
        if (!e.isDir && !AUDIO_EXTS.test(e.fileName)) continue;
        const cid = await pullUserIntoIndex(t, e.path);
        if (cid) t.nodes[id].children!.push(cid);
      }
      await fs.trash(abs).catch(() => false); // non-audio leftovers travel to the Trash with the folder
      return id;
    }
    if (!AUDIO_EXTS.test(abs)) return null;
    const ext = path.extname(abs);
    const dest = systemDir('imports');
    await mkdirp(dest);
    const to = await uniquePath(dest, safeName(path.basename(abs, ext), 'sample'), ext);
    await moveOnDisk(abs, to);
    const id = newId();
    t.nodes[id] = { id, type: 'file', name: path.basename(to, ext), path: to, meta: { source: 'import', ...(await statMeta(to)) } };
    return id;
  }
  async function move(ids: string[], targetId: string | null, index?: number): Promise<void> {
    const t = await load();
    const mdir = await mirroredDir(targetId);
    if (mdir) {
      let touched = false;
      for (const id of ids) {
        const up = userPathOf(id);
        if (up) {
          const st = await fs.stat(up);
          if (!st.exists || path.dirname(up) === mdir || path.under(mdir, up)) continue;
          const to = st.isDir ? await uniqueDir(mdir, path.basename(up)) : await uniquePath(mdir, path.basename(up, path.extname(up)), path.extname(up));
          await moveOnDisk(up, to); touched = true;
          continue;
        }
        const n = t.nodes[id];
        if (!n || n.readonly || n.system) continue;
        if (n.type === 'file' && n.path && isManaged(n.path)) { const ext = path.extname(n.path); await moveOnDisk(n.path, await uniquePath(mdir, safeName(n.name, 'sample'), ext)); detach(t, id); delete t.nodes[id]; touched = true; }
        else if (n.type === 'folder') { await moveIndexFolderToDisk(t, id, mdir); touched = true; }
      }
      if (touched) await save(t);
      return;
    }
    if (targetId && (!t.nodes[targetId] || t.nodes[targetId].type !== 'folder' || t.nodes[targetId].readonly)) throw new Error('bad target');
    let at = index;
    for (const id of ids) {
      const up = userPathOf(id);
      if (up) {
        if (!(await exists(up))) continue;
        const nid = await pullUserIntoIndex(t, up);
        if (nid) { attach(t, nid, targetId, at); if (at !== undefined) at++; }
        continue;
      }
      const n = t.nodes[id];
      if (!n || n.readonly) continue;
      if (n.system && targetId !== null) continue;
      if (targetId && (id === targetId || isDescendant(t, targetId, id))) continue;
      const list = targetId ? t.nodes[targetId].children ?? [] : t.root;
      const cur = list.indexOf(id);
      if (at !== undefined && cur >= 0 && cur < at) at--;
      detach(t, id);
      attach(t, id, targetId, at);
      if (at !== undefined) at++;
    }
    await save(t);
  }
  async function copy(ids: string[], targetId: string | null, index?: number): Promise<string[]> {
    const t = await load();
    const mdir = await mirroredDir(targetId);
    if (mdir) {
      const made: string[] = [];
      const copyInto = async (srcAbs: string, isDir: boolean, dir: string): Promise<string> => {
        if (isDir) { const to = await uniqueDir(dir, path.basename(srcAbs)); await copyOnDisk(srcAbs, to); return to; }
        const ext = path.extname(srcAbs);
        const to = await uniquePath(dir, safeName(path.basename(srcAbs, ext), 'sample'), ext);
        await copyOnDisk(srcAbs, to);
        return to;
      };
      const copyIndexFolder = async (folderId: string, dir: string): Promise<void> => {
        const n = t.nodes[folderId]; if (!n || n.type !== 'folder') return;
        const to = await uniqueDir(dir, safeName(n.name, 'Folder'));
        await mkdirp(to);
        for (const c of n.children ?? []) {
          const k = t.nodes[c]; if (!k) continue;
          if (k.type === 'file' && k.path && resolveReadableIn(t, c)) await copyInto(k.path, false, to);
          else if (k.type === 'folder') await copyIndexFolder(c, to);
        }
      };
      for (const id of ids) {
        const up = userPathOf(id);
        if (up) { const st = await fs.stat(up); if (!st.exists || path.under(mdir, up)) continue; made.push(userIdFor(await copyInto(up, st.isDir, mdir))); continue; }
        const n = await nodeOrVirtual(t, id);
        if (!n || n.system) continue;
        if (n.type === 'file' && n.path && resolveReadableIn(t, id)) made.push(userIdFor(await copyInto(n.path, false, mdir)));
        else if (n.type === 'folder' && n.readonly && n.path) made.push(userIdFor(await copyInto(n.path, true, mdir)));
        else if (n.type === 'folder') await copyIndexFolder(id, mdir);
        else if (n.type === 'link' && n.path) made.push(userIdFor(await copyInto(n.path, true, mdir)));
      }
      notify();
      return made;
    }
    if (targetId && (!t.nodes[targetId] || t.nodes[targetId].type !== 'folder' || t.nodes[targetId].readonly)) throw new Error('bad target');
    const made: string[] = [];
    const cloneNode = async (srcId: string): Promise<string | null> => {
      const n = await nodeOrVirtual(t, srcId);
      if (!n) return null;
      if (n.type === 'link') return null;
      const id = newId();
      if (n.type === 'folder') {
        t.nodes[id] = { id, type: 'folder', name: n.name, children: [] };
        const kids = n.readonly && n.path
          ? (await scanLink(n.path, { left: LINK_MAX_FILES, total: 0 })).filter(k => path.dirname(k.path!) === n.path).map(k => k.id)
          : (n.children ?? []);
        for (const c of kids) { const cid = await cloneNode(c); if (cid) t.nodes[id].children!.push(cid); }
        return id;
      }
      if (n.type === 'r2') { t.nodes[id] = { ...n, id }; return id; }
      if (n.type === 'file' && n.path) {
        if (!resolveReadableIn(t, srcId)) return null;
        const ext = path.extname(n.path);
        const dir = n.readonly || n.mirrored ? systemDir('imports') : path.dirname(n.path);
        await mkdirp(dir);
        const to = await uniquePath(dir, n.name, ext);
        await copyOnDisk(n.path, to);
        t.nodes[id] = { id, type: 'file', name: path.basename(to, ext), path: to, meta: { ...(n.meta ?? {}), source: n.readonly ? 'import' : n.meta?.source, ...(await statMeta(to)) } };
        return id;
      }
      return null;
    };
    let at = index;
    for (const src of ids) {
      const id = await cloneNode(src);
      if (!id) continue;
      attach(t, id, targetId, at);
      if (at !== undefined) at++;
      made.push(id);
    }
    await save(t);
    return made;
  }
  async function duplicate(ids: string[]): Promise<string[]> {
    const t = await load();
    const made: string[] = [];
    for (const id of ids) {
      const up = userPathOf(id);
      if (up) {
        if (!(await exists(up))) continue;
        const parentId = userIdFor(path.dirname(up)) === 'user:' ? USER_ID : userIdFor(path.dirname(up));
        const [nid] = await copy([id], parentId);
        if (nid) made.push(nid);
        continue;
      }
      const parent = parentOf(t, id);
      const list = parent ? t.nodes[parent].children ?? [] : t.root;
      const idx = list.indexOf(id);
      const [nid] = await copy([id], parent, idx + 1);
      if (nid) made.push(nid);
    }
    return made;
  }
  async function remove(ids: string[]): Promise<void> {
    const t = await load();
    const trash: string[] = [];
    const roots = linkRoots(t);
    const kill = (id: string) => {
      const n = t.nodes[id];
      if (!n || n.system || n.readonly) return;
      if (n.type === 'folder') for (const c of [...(n.children ?? [])]) kill(c);
      if (n.type === 'file' && n.path && isManaged(n.path)) trash.push(n.path);
      detach(t, id);
      delete t.nodes[id];
    };
    for (const id of ids) {
      const up = userPathOf(id);
      if (up) { await fs.trash(up).catch(() => false); continue; }
      if (!t.nodes[id] && id.startsWith('link:')) {
        const p = id.slice(5);
        if (!AUDIO_EXTS.test(p) || !roots.some(r => path.under(p, r))) continue;
        const st = await fs.stat(p);
        if (st.exists && !st.isDir) trash.push(p);
        continue;
      }
      kill(id);
    }
    for (const p of trash) await fs.trash(p).catch(() => false);
    await save(t);
  }
  async function importPaths(paths: string[], targetId: string | null, index?: number): Promise<string[]> {
    const t = await load();
    const mdir = await mirroredDir(targetId);
    if (mdir) {
      const made: string[] = [];
      for (const p of paths) {
        const st = await fs.stat(p);
        if (!st.exists) continue;
        if (path.under(mdir, p) || path.norm(p) === mdir) continue;
        if (st.isDir) { const to = await uniqueDir(mdir, safeName(path.basename(p), 'Folder')); await copyOnDisk(p, to); made.push(userIdFor(to)); }
        else if (AUDIO_EXTS.test(p)) {
          const ext = path.extname(p);
          const to = await uniquePath(mdir, safeName(path.basename(p, ext), 'sample'), ext);
          if (path.norm(p) !== to) await copyOnDisk(p, to);
          made.push(userIdFor(to));
        }
      }
      notify();
      return made;
    }
    if (targetId && (!t.nodes[targetId] || t.nodes[targetId].type !== 'folder' || t.nodes[targetId].readonly)) throw new Error('bad target');
    const made: string[] = [];
    const dest = systemDir('imports');
    let at = index;
    for (const p of paths) {
      const st = await fs.stat(p);
      if (!st.exists) continue;
      if (st.isDir) {
        if (isManaged(p)) continue;
        const id = newId();
        t.nodes[id] = { id, type: 'link', name: path.basename(p), path: path.norm(p), children: [] };
        attach(t, id, targetId, at); if (at !== undefined) at++;
        made.push(id);
      } else if (AUDIO_EXTS.test(p)) {
        const ext = path.extname(p);
        await mkdirp(dest);
        const to = isManaged(p) ? path.norm(p) : await uniquePath(dest, safeName(path.basename(p, ext)), ext);
        if (to !== path.norm(p)) await copyOnDisk(p, to);
        const id = newId();
        t.nodes[id] = { id, type: 'file', name: path.basename(to, ext), path: to, meta: { source: 'import', ...(await statMeta(to)) } };
        attach(t, id, targetId, at); if (at !== undefined) at++;
        made.push(id);
      }
    }
    await save(t);
    return made;
  }
  /** Bytes the page holds (a Finder drop in a WebView carries no paths) → files in Imports/ (or the USER SAMPLES
   *  folder they were dropped on) + nodes. Non-audio names are skipped like importPaths does. */
  async function importFiles(files: Array<{ name: string; bytes: Uint8Array }>, targetId: string | null, index?: number): Promise<string[]> {
    const t = await load();
    const mdir = await mirroredDir(targetId);
    const made: string[] = [];
    if (mdir) {
      for (const f of files) {
        if (!AUDIO_EXTS.test(f.name)) continue;
        const ext = path.extname(f.name);
        const to = await uniquePath(mdir, safeName(path.basename(f.name, ext), 'sample'), ext);
        if (!(await fs.writeBinary(to, f.bytes))) throw new Error(`could not write ${f.name}`);
        made.push(userIdFor(to));
      }
      notify();
      return made;
    }
    if (targetId && (!t.nodes[targetId] || t.nodes[targetId].type !== 'folder' || t.nodes[targetId].readonly)) throw new Error('bad target');
    const dest = systemDir('imports');
    await mkdirp(dest);
    let at = index;
    for (const f of files) {
      if (!AUDIO_EXTS.test(f.name)) continue;
      const ext = path.extname(f.name);
      const to = await uniquePath(dest, safeName(path.basename(f.name, ext)), ext);
      if (!(await fs.writeBinary(to, f.bytes))) throw new Error(`could not write ${f.name}`);
      const id = newId();
      t.nodes[id] = { id, type: 'file', name: path.basename(to, ext), path: to, meta: { source: 'import', ...(await statMeta(to)) } };
      attach(t, id, targetId, at); if (at !== undefined) at++;
      made.push(id);
    }
    await save(t);
    return made;
  }
  async function saveRecording(filename: string, data: Uint8Array): Promise<LibNode> {
    const t = await load();
    const dir = systemDir('recordings');
    await mkdirp(dir);
    const ext = path.extname(filename) || '.wav';
    const to = await uniquePath(dir, safeName(path.basename(filename, ext), 'recording'), ext);
    if (!(await fs.writeBinary(to, data))) throw new Error('could not write the recording');
    const id = newId();
    const n: LibNode = { id, type: 'file', name: path.basename(to, ext), path: to, meta: { source: 'recording', ...(await statMeta(to)) } };
    t.nodes[id] = n; attach(t, id, 'recordings');
    await save(t); return n;
  }
  async function addYouTubeFile(folderId: string, audioPath: string, title: string, videoId: string, durationSec: number): Promise<LibNode> {
    const t = await load();
    const id = newId();
    const n: LibNode = { id, type: 'file', name: safeName(title, videoId), path: audioPath, meta: { source: 'youtube', videoId, durationSec, ...(await statMeta(audioPath)) } };
    t.nodes[id] = n; attach(t, id, t.nodes[folderId] ? folderId : 'youtube');
    await save(t); return n;
  }
  async function findYouTubeFile(videoId: string): Promise<LibNode | null> {
    const t = await load();
    for (const n of Object.values(t.nodes)) {
      if (n.type !== 'file' || n.meta?.videoId !== videoId || !n.path) continue;
      if (await exists(n.path)) return n;
    }
    return null;
  }
  async function adoptYouTubeFile(srcPath: string, meta: { videoId: string; title: string; durationSec?: number }, folderId = 'youtube'): Promise<LibNode> {
    const already = await findYouTubeFile(meta.videoId);
    if (already) { if (path.norm(already.path!) !== path.norm(srcPath)) await fs.trash(srcPath).catch(() => false); return already; }
    const dir = systemDir('youtube');
    await mkdirp(dir);
    let dest = srcPath;
    if (!isManaged(srcPath)) { dest = await uniquePath(dir, safeName(meta.title, meta.videoId), path.extname(srcPath)); await moveOnDisk(srcPath, dest); }
    return addYouTubeFile(folderId, dest, meta.title, meta.videoId, meta.durationSec ?? 0);
  }
  async function ensureYouTubeFolder(name: string, parentId: string | null): Promise<{ node: LibNode; dir: string }> {
    const t = await load();
    const parent = parentId && t.nodes[parentId]?.type === 'folder' && !t.nodes[parentId].readonly ? parentId : 'youtube';
    const clean = safeName(name, 'playlist');
    const id = newId();
    const n: LibNode = { id, type: 'folder', name: clean, children: [] };
    t.nodes[id] = n; attach(t, id, parent);
    await save(t);
    return { node: n, dir: path.join(systemDir('youtube'), clean) };
  }
  async function findOrCreateDownloadedPlaylistFolder(name: string): Promise<{ node: LibNode; dir: string }> {
    const t = await load();
    let root = t.nodes[DL_PLAYLISTS_ID];
    if (!root || root.type !== 'folder') { root = { id: DL_PLAYLISTS_ID, type: 'folder', name: 'DOWNLOADED PLAYLISTS', children: [] }; t.nodes[DL_PLAYLISTS_ID] = root; attach(t, DL_PLAYLISTS_ID, null, 0); }
    const clean = safeName(name, 'playlist');
    const dir = path.join(systemDir('youtube'), 'Playlists', clean);
    for (const cid of root.children ?? []) { const n = t.nodes[cid]; if (n && n.type === 'folder' && n.name === clean) { await save(t); return { node: n, dir }; } }
    const id = newId();
    const n: LibNode = { id, type: 'folder', name: clean, children: [] };
    t.nodes[id] = n; attach(t, id, DL_PLAYLISTS_ID);
    await save(t);
    return { node: n, dir };
  }
  async function addR2Ref(targetId: string | null, r2Id: string, name: string, r2Playlist: string, durationSec?: number, index?: number): Promise<LibNode> {
    const t = await load();
    if (await mirroredDir(targetId)) throw new Error('USER SAMPLES holds real files — copy the sample to your library first, or drop it on one of your own folders');
    const id = newId();
    const n: LibNode = { id, type: 'r2', name, meta: { r2Id, r2Playlist, durationSec } };
    t.nodes[id] = n; attach(t, id, targetId, index);
    await save(t); return n;
  }
  async function reveal(id: string): Promise<void> {
    if (id === USER_ID) { await mkdirp(userDir()); await fs.openPath(userDir()); return; }
    const p = await resolveReadable(id);
    if (p) await fs.reveal(p);
    else if (id === 'root') await fs.openPath(libraryRoot());
  }
  /** Point the library at another root (null = the default). Drops the in-memory tree so the next read loads (or
   *  bootstraps) the index AT that root — an existing library.json there is adopted as-is. */
  function setLibraryRoot(dir: string | null): void {
    const next = dir ? path.norm(dir) : null;
    if (next === rootDirOverride) return;
    rootDirOverride = next;
    if (cache) { cache = null; notify(); }
  }
  async function moveLibrary(newRoot: string, onProgress?: (done: number, total: number) => void): Promise<{ moved: number; oldRoot: string }> {
    const oldRoot = path.norm(libraryRoot());
    const dest = path.norm(newRoot);
    if (dest === oldRoot) throw new Error('That is already the library folder.');
    if (path.under(dest, oldRoot)) throw new Error('The new folder is inside the current library — pick one outside it.');
    if (path.under(oldRoot, dest)) throw new Error('The new folder contains the current library — pick one outside it.');
    if (await exists(path.join(dest, 'library.json'))) throw new Error('That folder already holds a Terminator library — use "Point at it" instead of moving.');
    const t: LibraryTree = JSON.parse(JSON.stringify(await load()));
    const files = Object.values(t.nodes).filter((n): n is LibNode & { path: string } => n.type === 'file' && !!n.path && path.under(n.path, oldRoot));
    await mkdirp(dest);
    for (const s of SYSTEM) await mkdirp(path.join(dest, s.dir));
    let done = 0;
    for (const n of files) {
      const to = path.join(dest, path.relative(oldRoot, n.path));
      await mkdirp(path.dirname(to));
      if (!(await exists(to))) await copyOnDisk(n.path, to);
      n.path = to;
      done++;
      onProgress?.(done, files.length);
    }
    const oldUser = path.join(oldRoot, 'User Samples'), newUser = path.join(dest, 'User Samples');
    if (await exists(oldUser)) {
      // copy the contents (the destination dir was just created)
      for (const e of await listDir(oldUser)) await fs.copy(e.path, path.join(newUser, e.fileName)).catch(() => false);
    }
    rootDirOverride = dest;
    await save(t);
    return { moved: done, oldRoot };
  }

  return {
    libraryRoot, setLibraryRoot, systemDir, userDir, isManaged,
    onLibraryChanged: (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; },
    resolveReadable, resolveReadableSync, listLink, searchLinks, getLibrary,
    createFolder, rename, move, copy, duplicate, remove, importPaths, importFiles, saveRecording,
    addYouTubeFile, findYouTubeFile, adoptYouTubeFile, ensureYouTubeFolder, findOrCreateDownloadedPlaylistFolder, addR2Ref,
    reveal, moveLibrary, path,
  };
}
