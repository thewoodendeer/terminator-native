// The Sample Browser's tree: the TERMINATOR library (R2 playlists, read-only,
// collapsible) followed by YOUR library (~/Music/Terminator: RECORDINGS,
// YOUTUBE, IMPORTS, your own folders, folders linked from the computer).
//
// One flat, indented row list drives everything — keyboard nav, Shift-range,
// drag-and-drop targets and the context menu all work on row indices.
//   click item        preview (host)          double-click item   LOAD (host)
//   click folder      select + open/close     double-click folder rename
//   Shift/Cmd click   range / toggle          drag                move (Cmd = copy ghost)
//   right-click       cut/copy/paste/rename/duplicate/delete/new folder/reveal/import
//   drop from Finder  files → IMPORTS (or the folder you drop on), directories → linked
//   ▶ YouTube         paste a video or playlist link → downloads into YOUTUBE
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react';
import { createPortal } from 'react-dom';
import type { BrowserEntry, BrowserPlaylist } from './SampleBrowser';
import { LIB_ID_PREFIX, DL_PLAYLISTS_ID, type LibNode, type LibraryBridge, type LibraryData, type YtProgress } from './libraryBridge';
import { useKeepOnScreen } from '../hooks/useKeepOnScreen';

const fmtTime = (sec?: number): string => {
  if (sec == null || !isFinite(sec) || sec < 0) return '--:--';
  const m = Math.floor(sec / 60); const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
};
const fmtBytes = (n?: number): string => {
  if (!n || !isFinite(n) || n <= 0) return '';
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(n / 1024))} KB`;
};
// Expansion lives in SESSION storage (his rule 2026-08-21): reopening the
// browser during a session finds the folders as you left them, a fresh app
// launch starts with everything collapsed. The last sample you LOADED is
// remembered too, so the browser reopens with its folder open and it selected.
const EXPANDED_LS = 'terminator.library.expanded.v2';
export const LAST_LOADED_LS = 'terminator.library.lastLoaded.v1';
const R2_ROOT = 'r2';
const R2_PL = (name: string) => `r2pl:${name}`;

export interface TreeRow {
  key: string;
  kind: 'folder' | 'item' | 'ytadd' | 'ytjob';
  depth: number;
  name: string;
  /** folder */
  folderId?: string; open?: boolean; count?: number; countLabel?: string; system?: boolean; readonly?: boolean; libNode?: LibNode; isR2?: boolean;
  /** which library folder new things go into when dropped ON this row (null = root, undefined = not a target) */
  dropInto?: string | null;
  /** parent library folder id (null = root) and index within it — for before/after drops */
  parentId?: string | null; index?: number;
  /** item */
  entry?: BrowserEntry; plName?: string; presetStar?: boolean; sub?: string;
  /** ytjob */
  job?: YtProgress;
}

interface Props {
  playlists: BrowserPlaylist[];
  library?: LibraryBridge;
  query: string;
  selKey: string | null;
  isPlaying: boolean;
  presetIndex?: Record<string, string>;
  initialPlaylist?: string;
  onSelectEntry: (plName: string, entry: BrowserEntry) => void;
  onLoadEntry: (entry: BrowserEntry) => void;
  /** Right-click → "Load to new pad": the sample lands on the next empty pad as
   *  its own source (the browser stays open so you can keep stacking pads). */
  onLoadToPad?: (entry: BrowserEntry) => void;
  /** Right-click → Preview / Stop (the transport's ▶ for this row). */
  onPreviewEntry?: (plName: string, entry: BrowserEntry) => void;
  onVisibleItems: (items: Array<{ plName: string; entry: BrowserEntry }>) => void;
  onStatus: (msg: string) => void;
  selectedElRef: (el: HTMLDivElement | null) => void;
}

export default function LibraryTree({ playlists, library, query, selKey, isPlaying, presetIndex, initialPlaylist, onSelectEntry, onLoadEntry, onLoadToPad, onPreviewEntry, onVisibleItems, onStatus, selectedElRef }: Props) {
  // ── library data ────────────────────────────────────────────────────────
  const [lib, setLib] = useState<LibraryData | null>(null);
  const [libErr, setLibErr] = useState<string | null>(null);
  const refresh = useCallback(async () => {
    if (!library) return;
    const r = await library.get();
    if ('error' in r) setLibErr(r.error); else { setLib(r); setLibErr(null); }
  }, [library]);
  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => library?.onChanged(() => { void refresh(); }), [library, refresh]);

  // ── YouTube import jobs ─────────────────────────────────────────────────
  const [jobs, setJobs] = useState<Record<string, YtProgress>>({});
  useEffect(() => library?.onYouTubeProgress(p => {
    setJobs(j => ({ ...j, [p.jobId]: p }));
    if (p.phase === 'done' || p.phase === 'error' || p.phase === 'cancelled') {
      onStatus(p.phase === 'done' ? `✓ ${p.title ?? 'YouTube'} — ${p.done ?? 0}/${p.total ?? 0} imported${p.failed ? `, ${p.failed} failed` : ''}`
        : p.phase === 'error' ? `YouTube: ${p.error ?? 'failed'}` : 'YouTube import cancelled');
      setTimeout(() => setJobs(j => { const n = { ...j }; delete n[p.jobId]; return n; }), 5000);
    }
  }), [library, onStatus]);
  const [ytUrl, setYtUrl] = useState('');
  const ytInputRef = useRef<HTMLInputElement>(null);
  const startYouTube = async (targetId: string | null) => {
    const url = ytUrl.trim();
    if (!url || !library) return;
    setYtUrl('');
    onStatus('Contacting YouTube…');
    await library.youtubeImport(url, targetId);
  };

  // ── expansion ───────────────────────────────────────────────────────────
  const [expanded, setExpanded] = useState<Set<string>>(() => {
    try {
      const saved = JSON.parse(sessionStorage.getItem(EXPANDED_LS) || 'null');
      if (Array.isArray(saved)) return new Set(saved);
    } catch { /* */ }
    return new Set(); // a new session: every folder collapsed
  });
  void initialPlaylist; // no auto-expansion on open (his rule) — the last-loaded restore below decides
  useEffect(() => { try { sessionStorage.setItem(EXPANDED_LS, JSON.stringify([...expanded])); } catch { /* */ } }, [expanded]);
  // ── linked folders list LAZILY ──────────────────────────────────────────
  // getLibrary() carries only a link root's direct children; every deeper
  // folder is `lazy` until you open it, then listLink(id) fills it (one readdir
  // in main — a 160k-file library opens instantly). `extra` holds what has been
  // listed this mount; it is re-listed when the library changes.
  const [extra, setExtra] = useState<Record<string, LibNode>>({});
  const loadingRef = useRef<Set<string>>(new Set());
  const loadLazy = useCallback(async (id: string): Promise<void> => {
    if (!library || loadingRef.current.has(id)) return;
    loadingRef.current.add(id);
    try {
      const r = await library.listLink(id);
      if (Array.isArray(r)) {
        setExtra(prev => {
          const next = { ...prev };
          const parent = next[id] ?? lib?.nodes[id];
          if (parent) next[id] = { ...parent, lazy: false, children: r.map(k => k.id) };
          for (const k of r) next[k.id] = next[k.id]?.lazy === false ? { ...k, lazy: false, children: next[k.id].children } : k;
          return next;
        });
      }
    } finally { loadingRef.current.delete(id); }
  }, [library, lib]);
  const nodesView = useMemo<Record<string, LibNode>>(() => {
    if (!lib) return {};
    const keys = Object.keys(extra);
    if (!keys.length) return lib.nodes;
    return { ...lib.nodes, ...extra };
  }, [lib, extra]);
  // The library changed (a write, a rescan): re-list the lazy folders that are
  // open right now so the tree shows the disk as it is.
  useEffect(() => {
    if (!lib) return;
    for (const id of expanded) if (extra[id] && extra[id].lazy === false) void loadLazy(id);
  }, [lib]); // eslint-disable-line react-hooks/exhaustive-deps
  const toggle = (id: string) => {
    setExpanded(s => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
    const n = nodesView[id];
    if (n?.lazy && !expanded.has(id)) void loadLazy(id);
  };
  // Search reaches INTO linked folders through main's name index (debounced).
  const [linkHits, setLinkHits] = useState<Record<string, LibNode[]>>({});
  const [searching, setSearching] = useState(false);
  const qForSearch = query.trim();
  useEffect(() => {
    if (!library || !qForSearch) { setLinkHits({}); setSearching(false); return; }
    let alive = true;
    setSearching(true);
    const t = setTimeout(async () => {
      const r = await library.searchLinks(qForSearch);
      if (!alive) return;
      setLinkHits(r && !('error' in r) ? (r as Record<string, LibNode[]>) : {});
      setSearching(false);
    }, 250);
    return () => { alive = false; clearTimeout(t); };
  }, [library, qForSearch]);

  // ── selection ───────────────────────────────────────────────────────────
  const [sel, setSel] = useState<Set<string>>(new Set());
  const anchor = useRef<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const renameInput = useRef<HTMLInputElement>(null);
  const [menu, setMenu] = useState<null | { x: number; y: number; row: TreeRow | null }>(null);
  // Second page of the right-click menu: Move to ▸ / Copy to ▸ → pick a folder.
  const [menuSub, setMenuSub] = useState<null | 'move' | 'copy'>(null);
  const clipboard = useRef<null | { ids: string[]; cut: boolean }>(null);
  const [cutKeys, setCutKeys] = useState<Set<string>>(new Set());

  // ── rows ────────────────────────────────────────────────────────────────
  const q = query.trim().toLowerCase();
  const rows = useMemo<TreeRow[]>(() => {
    const out: TreeRow[] = [];
    // TERMINATOR (R2)
    const r2Open = expanded.has(R2_ROOT) || !!q;
    let r2Total = 0; for (const p of playlists) r2Total += p.entries.length;
    const r2Groups = playlists.map(p => ({ p, entries: q ? p.entries.filter(e => e.title.toLowerCase().includes(q)) : p.entries })).filter(g => !q || g.entries.length);
    if (!q || r2Groups.length) out.push({ key: R2_ROOT, kind: 'folder', depth: 0, name: 'TERMINATOR SAMPLES', folderId: R2_ROOT, open: r2Open, count: r2Total, system: true, readonly: true, isR2: true });
    if (r2Open) for (const { p, entries } of r2Groups) {
      const fid = R2_PL(p.name);
      const open = expanded.has(fid) || !!q;
      out.push({ key: fid, kind: 'folder', depth: 1, name: p.name, folderId: fid, open, count: p.entries.length, readonly: true, isR2: true });
      if (open) entries.forEach((e, i) => out.push({ key: `${p.name}::${e.id}#${i}`, kind: 'item', depth: 2, name: e.title, entry: e, plName: p.name, presetStar: !!presetIndex?.[e.id] }));
    }
    const r2End = out.length; // DOWNLOADED PLAYLISTS rows slot in here
    // YOUR library
    if (lib) {
      const nodes = nodesView;
      const matches = (id: string): boolean => {
        const n = nodes[id]; if (!n) return false;
        if (n.type === 'link') return (linkHits[id]?.length ?? 0) > 0 || (n.children ?? []).some(matches);
        if (n.type === 'folder') return (n.children ?? []).some(matches);
        return n.name.toLowerCase().includes(q);
      };
      const fileRow = (n: LibNode, depth: number, parentId: string | null, index: number): TreeRow => ({
        key: n.id, kind: 'item', depth, name: n.name, libNode: n, parentId, index,
        entry: { id: LIB_ID_PREFIX + n.id, title: n.name, duration: n.meta?.durationSec }, plName: '',
        sub: n.meta?.durationSec ? fmtTime(n.meta.durationSec) : fmtBytes(n.meta?.size), readonly: !!n.readonly });
      const walk = (ids: string[], depth: number, parentId: string | null) => {
        ids.forEach((id, index) => {
          const n = nodes[id]; if (!n) return;
          if (q && !matches(id)) return;
          if (n.type === 'folder' || n.type === 'link') {
            const open = expanded.has(id) || !!q;
            const ro = n.type === 'link' || !!n.readonly;
            const count = ro ? (n.children ?? []).length : countFiles(nodes, id);
            // linked folders: the count is what is LISTED (direct children); a
            // folder not opened yet shows … — its size is on disk, not in memory
            const countLabel = n.lazy ? '…' : ro ? String((n.children ?? []).length) : undefined;
            out.push({ key: id, kind: 'folder', depth, name: n.name, folderId: id, open, count, countLabel, system: !!n.system, readonly: ro, libNode: n, dropInto: ro ? undefined : id, parentId, index });
            if (open && q && n.type === 'link') {
              // search: the hits from main's index, flat under the root (the tree below is not walked)
              const hits = linkHits[id] ?? [];
              hits.forEach((h, i) => out.push(fileRow(h, depth + 1, undefined as unknown as null, i)));
              if (!hits.length) out.push({ key: `${id}:nohits`, kind: 'item', depth: depth + 1, name: searching ? 'searching…' : `no file named "${query.trim()}" in this folder`, sub: '' });
              else if (hits.length >= 400) out.push({ key: `${id}:morehits`, kind: 'item', depth: depth + 1, name: 'first 400 matches shown — type more to narrow it down', sub: '' });
            } else if (open) {
              if (id === 'youtube' && library) {
                out.push({ key: 'ytadd', kind: 'ytadd', depth: depth + 1, name: '', dropInto: id, parentId: id, index: 0 });
                for (const job of Object.values(jobs)) out.push({ key: `job:${job.jobId}`, kind: 'ytjob', depth: depth + 1, name: job.title ?? '', job });
              }
              walk(n.children ?? [], depth + 1, ro ? undefined as unknown as null : id);
              if (n.lazy) out.push({ key: `${id}:loading`, kind: 'item', depth: depth + 1, name: 'reading folder…', sub: '' });
              else if (ro && !(n.children ?? []).length) out.push({ key: `${id}:empty`, kind: 'item', depth: depth + 1, name: 'No audio files in this folder', sub: '' });
              if (!q && !(n.children ?? []).length && !ro) out.push({ key: `${id}:empty`, kind: 'item', depth: depth + 1, name: id === 'recordings' ? 'No recordings yet — use RECORD SAMPLE' : id === 'youtube' ? 'Paste a YouTube link above' : id === 'imports' ? 'Drop files here from Finder' : id === 'user' ? 'Your own samples — a REAL folder: drop files or folders here, make folders, move things around; it all happens on disk too' : n.mirrored ? 'Empty folder — drop samples here' : 'Empty — drop samples here', sub: '', dropInto: id, parentId: id, index: 0 });
            }
          } else if (n.type === 'file') {
            out.push(fileRow(n, depth, parentId, index));
          } else if (n.type === 'r2') {
            const r2Id = n.meta?.r2Id ?? '';
            out.push({ key: id, kind: 'item', depth, name: n.name, libNode: n, parentId, index,
              entry: { id: r2Id, title: n.name, duration: n.meta?.durationSec }, plName: n.meta?.r2Playlist ?? '', presetStar: !!presetIndex?.[r2Id],
              sub: fmtTime(n.meta?.durationSec) });
          }
        });
      };
      // DOWNLOADED PLAYLISTS (a real library folder, DL_PLAYLISTS_ID) is SHOWN
      // under TERMINATOR SAMPLES — that is where those songs came from (his
      // rule 2026-08-22) — not loose at the top level.
      walk(lib.root.filter(id => id !== DL_PLAYLISTS_ID), 0, null);
      if (lib.nodes[DL_PLAYLISTS_ID] && (r2Open || q)) {
        const before = out.length;
        walk([DL_PLAYLISTS_ID], 1, null);
        const dl = out.splice(before);
        out.splice(r2End, 0, ...dl);
      }
    }
    return out;
  }, [playlists, lib, nodesView, linkHits, searching, expanded, q, query, presetIndex, jobs, library]);

  // Reopen on the sample you last LOADED: open its folder chain, select it,
  // scroll it into view. Runs once per mount, as soon as the library is in.
  const restoredRef = useRef(false);
  useEffect(() => {
    if (restoredRef.current) return;
    let last: { id: string; pl?: string } | null = null;
    try { last = JSON.parse(sessionStorage.getItem(LAST_LOADED_LS) || 'null'); } catch { /* */ }
    if (!last || !last.id) { restoredRef.current = true; return; }
    if (last.id.startsWith(LIB_ID_PREFIX)) {
      if (!lib) return; // wait for the library
      const nodeId = last.id.slice(LIB_ID_PREFIX.length);
      const focus = () => {
        setSel(new Set([nodeId])); anchor.current = nodeId;
        setTimeout(() => treeRef.current?.querySelector(`[data-rowkey="${CSS.escape(nodeId)}"]`)?.scrollIntoView({ block: 'center' }), 120);
      };
      if (nodeId.startsWith('link:')) {
        // a file inside a linked folder: its ancestors are its PATH — list each
        // level down from the link root (lazy), then open the chain
        const abs = nodeId.slice(5);
        const root = Object.values(lib.nodes).find(n => n.type === 'link' && n.path && (abs.startsWith(n.path + '/') || abs.startsWith(n.path + '\\')));
        if (!root || !root.path) { restoredRef.current = true; return; }
        restoredRef.current = true;
        const sep = abs.includes('/') ? '/' : '\\';
        const rel = abs.slice(root.path.length + 1).split(sep); rel.pop();
        const dirs: string[] = []; let acc = root.path;
        for (const part of rel) { acc += sep + part; dirs.push('link:' + acc); }
        void (async () => {
          for (const d of dirs) await loadLazy(d);
          setExpanded(e => new Set([...e, root.id, ...dirs]));
          focus();
        })();
        return;
      }
      if (!lib.nodes[nodeId]) { restoredRef.current = true; return; }
      const chain: string[] = [];
      let cur: string | null = nodeId;
      const parentOf = (id: string): string | null => { for (const n of Object.values(lib.nodes)) if (n.children?.includes(id)) return n.id; return null; };
      while ((cur = parentOf(cur)) !== null) chain.push(cur);
      setExpanded(e => new Set([...e, ...chain]));
      focus();
    } else if (last.pl) {
      const pl = R2_PL(last.pl);
      setExpanded(e => new Set([...e, R2_ROOT, pl]));
      setTimeout(() => {
        const row = treeRef.current?.querySelector(`[data-rowkey^="${CSS.escape(`${last!.pl}::${last!.id}#`)}"]`) as HTMLElement | null;
        if (row) { const k = row.getAttribute('data-rowkey')!; setSel(new Set([k])); anchor.current = k; row.scrollIntoView({ block: 'center' }); }
      }, 80);
    }
    restoredRef.current = true;
  }, [lib]); // eslint-disable-line react-hooks/exhaustive-deps

  // A folder you just ADDED (new folder, linked folder, a dropped directory)
  // arrives COLLAPSED, sub-folders included — even if a folder with the same
  // ids was open earlier this session (re-linking the same path).
  const seenIdsRef = useRef<Set<string> | null>(null);
  useEffect(() => {
    if (!lib) return;
    const ids = new Set(Object.keys(lib.nodes));
    const prev = seenIdsRef.current;
    seenIdsRef.current = ids;
    if (!prev) return; // first load of this mount: the session's expansion stands
    const fresh: string[] = [];
    for (const id of ids) {
      if (prev.has(id) || id.startsWith('user:')) continue; // USER SAMPLES ids change on rename — leave them
      const t = lib.nodes[id].type;
      if (t === 'folder' || t === 'link') fresh.push(id);
    }
    if (!fresh.length) return;
    setExpanded(s => { let n: Set<string> | null = null; for (const id of fresh) if (s.has(id)) { n ??= new Set(s); n.delete(id); } return n ?? s; });
  }, [lib]);

  // ↑ / ↓ in the host moves the highlighted sample — keep the tree's own
  // selection on that row so there is ONE highlight, not two.
  useEffect(() => {
    if (!selKey) return;
    const row = rows.find(r => r.kind === 'item' && !!r.entry && `${r.plName ?? ''}::${r.entry.id}` === selKey);
    if (!row || (sel.size === 1 && sel.has(row.key))) return;
    setSel(new Set([row.key])); anchor.current = row.key;
  }, [selKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // visible items → host keyboard nav
  useEffect(() => {
    onVisibleItems(rows.filter(r => r.kind === 'item' && r.entry).map(r => ({ plName: r.plName ?? '', entry: r.entry! })));
  }, [rows, onVisibleItems]);

  const rowByKey = useMemo(() => new Map(rows.map(r => [r.key, r])), [rows]);
  const rowIndex = (key: string) => rows.findIndex(r => r.key === key);

  // ── click / select ──────────────────────────────────────────────────────
  const clickRow = (row: TreeRow, e: { shiftKey: boolean; metaKey: boolean; ctrlKey: boolean }) => {
    if (e.metaKey || e.ctrlKey) {
      setSel(s => { const n = new Set(s); if (n.has(row.key)) n.delete(row.key); else n.add(row.key); return n; });
      anchor.current = row.key; return;
    }
    if (e.shiftKey && anchor.current) {
      const a = rowIndex(anchor.current), b = rowIndex(row.key);
      if (a >= 0 && b >= 0) {
        const [lo, hi] = a < b ? [a, b] : [b, a];
        setSel(new Set(rows.slice(lo, hi + 1).filter(r => r.kind === 'item' || r.kind === 'folder').map(r => r.key)));
        return;
      }
    }
    setSel(new Set([row.key]));
    anchor.current = row.key;
  };

  // ── rename ──────────────────────────────────────────────────────────────
  const canRename = (row: TreeRow) => !!row.libNode && !row.libNode.system && !row.libNode.readonly && !!library;
  const commitRename = async (row: TreeRow, value: string) => {
    setRenaming(null);
    if (!library || !row.libNode) return;
    const v = value.trim();
    if (!v || v === row.libNode.name) return;
    const r = await library.rename(row.libNode.id, v);
    if (r && 'error' in (r as any)) onStatus(`Rename failed: ${(r as any).error}`);
  };
  useEffect(() => {
    if (!renaming) return;
    const onDown = (ev: PointerEvent) => {
      const t = ev.target as HTMLElement | null;
      if (t && t.closest('.sb-rename')) return;
      const row = rowByKey.get(renaming);
      if (row) void commitRename(row, renameInput.current?.value ?? '');
      else setRenaming(null);
    };
    document.addEventListener('pointerdown', onDown, true);
    return () => document.removeEventListener('pointerdown', onDown, true);
  }, [renaming, rowByKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── selection → library ids ─────────────────────────────────────────────
  const libIdsOf = (keys: Iterable<string>): string[] => {
    const out: string[] = [];
    for (const k of keys) { const r = rowByKey.get(k); if (r?.libNode && !r.libNode.readonly && !r.libNode.system) out.push(r.libNode.id); }
    return out;
  };
  /** What COPY may take: everything cut can, plus linked (read-only) files and
   *  sub-folders — the paste is a real copy of yours. Never the link root itself. */
  const copyIdsOf = (keys: Iterable<string>): string[] => {
    const out: string[] = [];
    for (const k of keys) { const r = rowByKey.get(k); const n = r?.libNode; if (n && !n.system && n.type !== 'link') out.push(n.id); }
    return out;
  };
  /** What DELETE may take: owned nodes, a link root (= unlink), a linked FILE
   *  (= your own file → Trash). Linked sub-folders are left alone. */
  const removableRows = (keys: Iterable<string>): TreeRow[] => {
    const out: TreeRow[] = [];
    for (const k of keys) { const r = rowByKey.get(k); const n = r?.libNode; if (r && n && !n.system && !(n.readonly && n.type !== 'file')) out.push(r); }
    return out;
  };
  const selectionFor = (row: TreeRow | null): string[] => (row && !sel.has(row.key)) ? [row.key] : [...sel];

  // ── actions ─────────────────────────────────────────────────────────────
  const act = {
    newFolder: async (parentId: string | null, index?: number) => {
      if (!library) return;
      const r = await library.createFolder(parentId, 'New Folder', index);
      if (r && !('error' in r)) { setExpanded(s => new Set(parentId ? [...s, parentId] : s)); setTimeout(() => setRenaming(r.id), 50); }
    },
    rename: (row: TreeRow) => { if (canRename(row)) setRenaming(row.key); },
    duplicate: async (keys: string[]) => {
      if (!library) return;
      const ids = libIdsOf(keys); if (ids.length) await library.duplicate(ids);
      // R2 items inside TERMINATOR can't be duplicated in place (read-only) — copy to root instead.
    },
    remove: async (keys: string[]) => {
      if (!library) return;
      const rs = removableRows(keys);
      if (!rs.length) return;
      // Always ask first — it is a Trash / unlink, not an undo-able edit.
      const links = rs.filter(r => r.libNode!.type === 'link');
      const linked = rs.filter(r => r.libNode!.readonly && r.libNode!.type === 'file');
      const refs = rs.filter(r => r.libNode!.type === 'r2');
      const owned = rs.length - links.length - linked.length - refs.length;
      const nm = (r: TreeRow) => `"${r.name}"`;
      const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;
      let msg: string;
      if (rs.length === 1) {
        const r = rs[0], n = r.libNode!;
        msg = n.type === 'link' ? `Unlink ${nm(r)}?\n\nThe folder stays where it is on your computer — it just leaves the browser.`
          : n.type === 'r2' ? `Remove ${nm(r)} from this folder?\n\n(It stays in TERMINATOR SAMPLES.)`
          : n.readonly ? `Move ${nm(r)} to the Trash?\n\nThis is a file inside a linked folder on your computer.`
          : n.type === 'folder' ? `Move the folder ${nm(r)} and everything in it to the Trash?`
          : `Move ${nm(r)} to the Trash?`;
      } else {
        const parts: string[] = [];
        if (owned) parts.push(`${plural(owned, 'item')} to the Trash`);
        if (linked.length) parts.push(`${plural(linked.length, 'linked file')} to the Trash (files on your computer)`);
        if (links.length) parts.push(`unlink ${plural(links.length, 'folder')} (stays on disk)`);
        if (refs.length) parts.push(`${plural(refs.length, 'TERMINATOR SAMPLES reference')} removed`);
        msg = `Delete ${rs.length} items?\n\n${parts.join('\n')}`;
      }
      if (!window.confirm(msg)) return;
      await library.remove(rs.map(r => r.libNode!.id));
      setSel(new Set());
    },
    cut: (keys: string[]) => { const ids = libIdsOf(keys); clipboard.current = ids.length ? { ids, cut: true } : null; setCutKeys(new Set(keys.filter(k => rowByKey.get(k)?.libNode))); },
    copy: (keys: string[]) => {
      // Copies may include R2 items (from TERMINATOR): they become refs on paste.
      // Linked (read-only) files copy too — the paste is a real file of yours.
      const ids = copyIdsOf(keys);
      const r2 = keys.map(k => rowByKey.get(k)).filter(r => r && r.kind === 'item' && !r.libNode && r.entry) as TreeRow[];
      clipboard.current = { ids, cut: false };
      (clipboard.current as any).r2 = r2.map(r => ({ id: r.entry!.id, name: r.entry!.title, pl: r.plName ?? '', dur: r.entry!.duration }));
      setCutKeys(new Set());
    },
    paste: async (targetId: string | null, index?: number) => {
      const c = clipboard.current as (null | { ids: string[]; cut: boolean; r2?: Array<{ id: string; name: string; pl: string; dur?: number }> });
      if (!c || !library) return;
      if (c.ids.length) { if (c.cut) await library.move(c.ids, targetId, index); else await library.copy(c.ids, targetId, index); }
      for (const r of c.r2 ?? []) await (library.importR2 ?? library.addR2Ref)(targetId, r.id, r.name, r.pl, r.dur, index);
      if (c.cut) { clipboard.current = null; setCutKeys(new Set()); }
    },
    reveal: async (row: TreeRow) => { if (library && row.libNode) await library.reveal(row.libNode.id); },
    addComputerFolder: async () => { if (library) await library.pickFolder(); },
    importFiles: async (targetId: string | null) => { if (library) await library.pickFiles(targetId); },
  };

  // keyboard: Delete / Cmd+C / X / V / D on the tree while it has selection
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return;
      if (!sel.size) return;
      const mod = e.metaKey || e.ctrlKey;
      if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); e.stopPropagation(); void act.remove([...sel]); }
      else if (mod && e.key.toLowerCase() === 'c') { e.preventDefault(); e.stopPropagation(); act.copy([...sel]); }
      else if (mod && e.key.toLowerCase() === 'x') { e.preventDefault(); e.stopPropagation(); act.cut([...sel]); }
      else if (mod && e.key.toLowerCase() === 'v') { e.preventDefault(); e.stopPropagation(); const r = rowByKey.get(anchor.current ?? ''); void act.paste(r?.dropInto ?? r?.parentId ?? null, r?.kind === 'item' && r.index !== undefined ? r.index + 1 : undefined); }
      else if (mod && e.key.toLowerCase() === 'd') { e.preventDefault(); e.stopPropagation(); void act.duplicate([...sel]); }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }); // eslint-disable-line react-hooks/exhaustive-deps

  // ── drag & drop (pointer-based, Cmd = copy ghost) ───────────────────────
  const [drag, setDrag] = useState<null | { keys: string[]; copy: boolean; x: number; y: number; over: null | { key: string; where: 'into' | 'before' | 'after' } }>(null);
  const dragRef = useRef<typeof drag>(null);
  const pressRef = useRef<null | { key: string; x: number; y: number; copy: boolean }>(null);
  const treeRef = useRef<HTMLDivElement>(null);
  const hitRow = (x: number, y: number): null | { key: string; where: 'into' | 'before' | 'after' } => {
    const el = document.elementFromPoint(x, y) as HTMLElement | null;
    const rowEl = el?.closest('[data-rowkey]') as HTMLElement | null;
    if (!rowEl) return null;
    const key = rowEl.dataset.rowkey!;
    const row = rowByKey.get(key); if (!row) return null;
    const r = rowEl.getBoundingClientRect();
    const f = (y - r.top) / Math.max(1, r.height);
    if (row.kind === 'folder' && row.dropInto !== undefined) return { key, where: f < 0.25 ? 'before' : f > 0.75 ? 'after' : 'into' };
    if (row.kind === 'folder') return { key, where: f < 0.5 ? 'before' : 'after' };
    return { key, where: f < 0.5 ? 'before' : 'after' };
  };
  /** Resolve a hit into (targetFolderId, index) — null if not a legal library target. */
  const dropTarget = (h: { key: string; where: 'into' | 'before' | 'after' }): null | { targetId: string | null; index?: number } => {
    const row = rowByKey.get(h.key); if (!row) return null;
    if (h.where === 'into') return row.dropInto === undefined ? null : { targetId: row.dropInto };
    if (row.parentId === undefined) return null;          // inside TERMINATOR / a linked folder
    if (row.index === undefined) return { targetId: row.parentId };
    return { targetId: row.parentId, index: row.index + (h.where === 'after' ? 1 : 0) };
  };
  const onRowPointerDown = (row: TreeRow, e: ReactPointerEvent) => {
    if (e.button !== 0) return;
    if ((e.target as HTMLElement).closest('.sb-tw, .sb-rename, button, input')) return;
    pressRef.current = { key: row.key, x: e.clientX, y: e.clientY, copy: e.metaKey || e.ctrlKey };
  };
  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      const p = pressRef.current;
      if (p && !dragRef.current) {
        if (Math.hypot(e.clientX - p.x, e.clientY - p.y) < 5) return;
        const row = rowByKey.get(p.key);
        if (!row || (row.kind !== 'item' && row.kind !== 'folder') || row.key === R2_ROOT || row.key.endsWith(':empty')) { pressRef.current = null; return; }
        const keys = sel.has(p.key) ? [...sel] : [p.key];
        const d = { keys, copy: p.copy, x: e.clientX, y: e.clientY, over: null };
        dragRef.current = d; setDrag(d);
        pressRef.current = null;
        return;
      }
      const d = dragRef.current; if (!d) return;
      const over = hitRow(e.clientX, e.clientY);
      const nd = { ...d, x: e.clientX, y: e.clientY, over, copy: d.copy || e.metaKey || e.ctrlKey };
      dragRef.current = nd; setDrag(nd);
    };
    const onUp = async () => {
      pressRef.current = null;
      const d = dragRef.current;
      dragRef.current = null; setDrag(null);
      if (!d || !d.over || !library) return;
      const tgt = dropTarget(d.over); if (!tgt) return;
      const libIds: string[] = [], roIds: string[] = [];
      const r2: Array<{ id: string; name: string; pl: string; dur?: number }> = [];
      for (const k of d.keys) {
        const r = rowByKey.get(k); if (!r) continue;
        if (r.libNode) { if (r.libNode.readonly && (r.libNode.type === 'file' || r.libNode.type === 'folder')) roIds.push(r.libNode.id); else if (!r.libNode.readonly && !(r.libNode.system && d.over.where === 'into')) libIds.push(r.libNode.id); }
        else if (r.kind === 'item' && r.entry) r2.push({ id: r.entry.id, name: r.entry.title, pl: r.plName ?? '', dur: r.entry.duration });
      }
      // system folders may be re-ordered at root but never dropped INTO something else
      const sys = libIds.filter(id => lib?.nodes[id]?.system);
      const nonSys = libIds.filter(id => !lib?.nodes[id]?.system);
      if (nonSys.length) { if (d.copy) await library.copy(nonSys, tgt.targetId, tgt.index); else await library.move(nonSys, tgt.targetId, tgt.index); }
      if (sys.length && tgt.targetId === null) await library.move(sys, null, tgt.index);
      if (roIds.length) await library.copy(roIds, tgt.targetId, tgt.index);   // linked files / sub-folders → copied into your library
      for (const r of r2) await (library.importR2 ?? library.addR2Ref)(tgt.targetId, r.id, r.name, r.pl, r.dur, tgt.index);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    return () => { window.removeEventListener('pointermove', onMove); window.removeEventListener('pointerup', onUp); window.removeEventListener('pointercancel', onUp); };
  }); // eslint-disable-line react-hooks/exhaustive-deps

  // ── native drop from Finder / Explorer ─────────────────────────────────
  const [extOver, setExtOver] = useState<null | { key: string; where: 'into' | 'before' | 'after' }>(null);
  const onDragOver = (e: React.DragEvent) => {
    if (!library || !e.dataTransfer.types.includes('Files')) return;
    e.preventDefault(); e.dataTransfer.dropEffect = 'copy';
    setExtOver(hitRow(e.clientX, e.clientY));
  };
  const onDrop = async (e: React.DragEvent) => {
    if (!library) return;
    e.preventDefault();
    const h = hitRow(e.clientX, e.clientY);
    setExtOver(null);
    const files = Array.from(e.dataTransfer.files);
    const paths = files.map(f => library.pathForFile(f)).filter(Boolean);
    // Terminator 3.0 (WebView): drops carry no paths — the bytes go in through importFiles instead.
    if (!paths.length && !(library.importFiles && files.length)) return;
    const tgt = h ? dropTarget(h) : { targetId: null as string | null };
    const t = tgt ?? { targetId: null as string | null };
    // Files dropped on TERMINATOR / a linked folder land in IMPORTS.
    const r = paths.length
      ? await library.importPaths(paths, t.targetId ?? (h && !tgt ? 'imports' : null), t.index)
      : await library.importFiles!(files, t.targetId ?? (h && !tgt ? 'imports' : null), t.index);
    if (r && 'error' in (r as any)) onStatus(`Import failed: ${(r as any).error}`);
    else onStatus(`Imported ${(r as string[]).length} item${(r as string[]).length === 1 ? '' : 's'}`);
  };

  // ── context menu ────────────────────────────────────────────────────────
  useEffect(() => {
    if (!menu) return;
    // A press INSIDE the menu is a choice, not a dismissal (the listener is
    // capture-phase on window, so the menu's own stopPropagation can't save it).
    const close = (e: Event) => { if (e.type === 'pointerdown' && menuRef.current && e.target instanceof Node && menuRef.current.contains(e.target)) return; setMenu(null); };
    window.addEventListener('pointerdown', close, true);
    window.addEventListener('keydown', close, true);
    return () => { window.removeEventListener('pointerdown', close, true); window.removeEventListener('keydown', close, true); };
  }, [menu]);
  const menuRef = useRef<HTMLDivElement>(null);
  useKeepOnScreen(menuRef, menu ? `${menu.x},${menu.y}` : null);
  const openMenu = (e: React.MouseEvent, row: TreeRow | null) => {
    // No library bridge (web): the folder/file ops don't exist, but a SAMPLE row
    // still gets Load / Load to new pad / Preview.
    if (!library && !(row?.kind === 'item' && row.entry)) return;
    e.preventDefault(); e.stopPropagation();
    if (row && !sel.has(row.key)) { setSel(new Set([row.key])); anchor.current = row.key; }
    setMenuSub(null);
    setMenu({ x: Math.min(e.clientX, window.innerWidth - 200), y: Math.min(e.clientY, window.innerHeight - 320), row });
  };
  const menuItems = (): Array<{ label: string; run?: () => void; disabled?: boolean; sep?: boolean; tip?: string; keep?: boolean }> => {
    const row = menu?.row ?? null;
    const keys = selectionFor(row);
    const libSel = libIdsOf(keys);
    const anyLib = libSel.length > 0;
    const anyCopy = copyIdsOf(keys).length > 0;
    const anyRemove = removableRows(keys).length > 0;
    const hasClip = !!clipboard.current && ((clipboard.current.ids.length > 0) || ((clipboard.current as any).r2?.length > 0));
    const intoId: string | null = row?.dropInto !== undefined ? row.dropInto : (row?.parentId !== undefined ? row.parentId : null);
    const afterIdx = row?.kind === 'item' && row.index !== undefined ? row.index + 1 : undefined;
    const r2Sel = keys.some(k => { const r = rowByKey.get(k); return r?.kind === 'item' && !r.libNode; });
    // The sample under the pointer (an item row) — LOAD / LOAD TO NEW PAD / PREVIEW act on it.
    const item = row?.kind === 'item' && row.entry ? row : null;
    const itemRows = keys.map(k => rowByKey.get(k)).filter((r): r is TreeRow => !!r && r.kind === 'item' && !!r.entry);
    const sampleItems: Array<{ label: string; run?: () => void; disabled?: boolean; sep?: boolean; tip?: string; keep?: boolean }> = item ? [
      { label: 'Load', tip: 'Load this sample as the main track (the waveform)', run: () => onLoadEntry(item.entry!) },
      { label: itemRows.length > 1 && onLoadToPad ? `Load ${itemRows.length} to new pads` : 'Load to new pad', disabled: !onLoadToPad, tip: 'Put this sample on the NEXT EMPTY PAD as its own source — the browser stays open so you can stack several',
        run: () => { for (const r of (itemRows.length > 1 ? itemRows : [item])) onLoadToPad?.(r.entry!); } },
      { label: isPlaying && selKey === item.key ? 'Stop preview' : 'Preview', disabled: !onPreviewEntry, tip: 'Hear it without loading it (SPACE does the same on the highlighted sample)', run: () => onPreviewEntry?.(item.plName ?? '', item.entry!) },
      { sep: true, label: '' },
    ] : [];
    if (!library) return sampleItems.filter(it => !it.sep);
    return [
      ...sampleItems,
      { label: 'New folder', tip: 'A new folder here (a real folder on disk inside your library)', run: () => void act.newFolder(intoId, row?.kind === 'folder' && row.dropInto !== undefined ? undefined : afterIdx) },
      { label: 'Import files…', tip: 'Copy audio files from your computer into this folder', run: () => void act.importFiles(intoId) },
      { label: 'Add folder from computer…', tip: 'Link a folder on your computer — it stays where it is and shows up here, live, read-only', run: () => void act.addComputerFolder() },
      { sep: true, label: '' },
      { label: 'Cut', disabled: !anyLib, tip: 'Move the selection — paste it into another folder (your own files only; linked files can be copied)', run: () => act.cut(keys) },
      { label: 'Copy', disabled: !anyCopy && !r2Sel, tip: 'Copy the selection — paste makes your own copy (a linked file becomes a real file in your library; a TERMINATOR SAMPLES song is pulled and becomes a real file of yours)', run: () => act.copy(keys) },
      { label: 'Paste', disabled: !hasClip, tip: 'Paste what you cut or copied into this folder', run: () => void act.paste(intoId, afterIdx) },
      { label: 'Move to ▸', disabled: !anyLib && !anyCopy && !r2Sel, keep: true, tip: 'Pick any folder of yours — the selection goes there. Your own files MOVE; a TERMINATOR SAMPLES song is pulled and becomes a real file of yours in that folder; a linked file is copied in (the original stays on your computer)', run: () => setMenuSub('move') },
      { label: 'Copy to ▸', disabled: !anyCopy && !r2Sel, keep: true, tip: 'Pick any folder of yours — a COPY lands there and the original stays where it is', run: () => setMenuSub('copy') },
      { label: 'Duplicate', disabled: !anyLib, tip: 'A copy next to the original (your own files only — Copy a linked file into your library instead)', run: () => void act.duplicate(keys) },
      { sep: true, label: '' },
      { label: 'Rename', disabled: !row || !canRename(row), tip: 'Rename it — on disk too', run: () => row && act.rename(row) },
      { label: row?.libNode?.type === 'link' ? 'Unlink folder' : 'Delete…', disabled: !anyRemove, tip: row?.libNode?.type === 'link' ? 'Remove this linked folder from the browser — nothing on disk changes' : 'Move the selection to the Trash (it asks first)', run: () => void act.remove(keys) },
      { sep: true, label: '' },
      { label: 'Reveal in Finder', disabled: !row?.libNode || row.libNode.type === 'r2', tip: 'Show the real file or folder on your computer', run: () => row && void act.reveal(row) },
    ];
  };

  // ── render ──────────────────────────────────────────────────────────────
  const overKey = drag?.over?.key ?? extOver?.key ?? null;
  const overWhere = drag?.over?.where ?? extOver?.where ?? null;
  const overLegal = drag?.over ? !!dropTarget(drag.over) : extOver ? true : false;
  const empty = rows.length === 0;
  return (
    <div
      ref={treeRef}
      className={`sb-tree${drag ? ' sb-tree--dragging' : ''}`}
      onDragOver={onDragOver}
      onDragLeave={() => setExtOver(null)}
      onDrop={onDrop}
      onContextMenu={e => openMenu(e, null)}
      onPointerDown={e => { if (e.target === e.currentTarget) { setSel(new Set()); anchor.current = null; } }}
    >
      {library && (
        <div className="sb-tree-tools">
          <button className="sb-tool" onClick={() => void act.newFolder(null)} title="New folder at the top level (right-click a folder to create one inside it)">＋ FOLDER</button>
          <button className="sb-tool" onClick={() => void act.importFiles(null)} title="Import audio files from your computer into IMPORTS (or drop them onto any folder)">＋ FILES</button>
          <button className="sb-tool" onClick={() => void act.addComputerFolder()} title="Link a folder on your computer — it stays where it is and shows up here">＋ LINK FOLDER</button>
          <button className="sb-tool" onClick={() => { setExpanded(s => new Set([...s, 'youtube'])); setTimeout(() => ytInputRef.current?.focus(), 50); }} title="Import a YouTube video or playlist">▶ YOUTUBE</button>
          {sel.size > 1 && <span className="sb-tool-count">{sel.size} selected</span>}
        </div>
      )}
      {libErr && <div className="sb-empty">Library: {libErr}</div>}
      {empty && <div className="sb-empty">{q ? `No samples match "${query}"` : 'Nothing here yet'}</div>}
      {rows.map(row => {
        const isSel = sel.has(row.key);
        const isFocus = row.kind === 'item' && !!row.entry && selKey === `${row.plName}::${row.entry.id}`;
        const isOver = overKey === row.key;
        const cls = ['sb-row', `sb-row--${row.kind}`, isSel ? 'sb-row--sel' : '', isFocus ? 'sb-track--sel' : '', cutKeys.has(row.key) ? 'sb-row--cut' : '',
          isOver && overWhere === 'into' ? (overLegal ? 'sb-row--over-into' : 'sb-row--over-bad') : '', isOver && overWhere === 'before' ? 'sb-row--over-before' : '', isOver && overWhere === 'after' ? 'sb-row--over-after' : '',
          drag && drag.keys.includes(row.key) ? 'sb-row--dragsrc' : ''].filter(Boolean).join(' ');
        const style = { '--depth': row.depth } as CSSProperties;
        if (row.kind === 'ytadd') {
          return (
            <div key={row.key} data-rowkey={row.key} className={cls} style={style} onContextMenu={e => openMenu(e, row)}>
              <input ref={ytInputRef} className="sb-yt-input sb-yt-url" type="text" placeholder="paste a YouTube video or playlist link…" value={ytUrl} title="Paste a YouTube video or playlist link and press Enter / IMPORT — a playlist becomes its own folder here, tracks arrive as they download"
                onChange={e => setYtUrl(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') void startYouTube(null); e.stopPropagation(); }} />
              <button className="sb-yt-addbtn" disabled={!ytUrl.trim()} onClick={() => void startYouTube(null)} title="Download the audio of that link into YOUTUBE (nothing to install — the downloader is built in)">IMPORT</button>
            </div>
          );
        }
        if (row.kind === 'ytjob') {
          const j = row.job!;
          const pct = j.phase === 'enumerating' ? null : (j.total && j.total > 1 ? Math.round(((j.done ?? 0) / j.total) * 100) : Math.round(j.percent ?? 0));
          return (
            <div key={row.key} data-rowkey={row.key} className={`${cls} sb-row--job-${j.phase}`} style={style}>
              <span className="sb-fico">{j.phase === 'done' ? '✓' : j.phase === 'error' ? '✕' : '⬇'}</span>
              <span className="sb-tname" title={j.error ?? j.title}>{j.phase === 'enumerating' ? 'Reading playlist…' : j.phase === 'error' ? (j.error ?? 'failed') : (j.title || 'YouTube')}</span>
              {pct !== null && (j.phase === 'downloading') && <span className="sb-job-bar"><span style={{ width: `${pct}%` }} /></span>}
              <span className="sb-tdur">{j.phase === 'downloading' && j.total && j.total > 1 ? `${j.done ?? 0}/${j.total}` : j.phase === 'downloading' ? `${pct ?? 0}%` : j.phase}</span>
              {(j.phase === 'downloading' || j.phase === 'enumerating') && <button className="sb-row-del" title="Cancel" onClick={() => void library?.youtubeCancel(j.jobId)}>×</button>}
            </div>
          );
        }
        if (row.kind === 'folder') {
          const icon = row.isR2 ? (row.key === R2_ROOT ? '◆' : '🗀') : row.libNode?.type === 'link' ? '⇗' : row.key === 'recordings' ? '🎙' : row.key === 'youtube' ? '▶' : row.key === 'imports' ? '⤓' : row.key === 'user' ? '★' : row.libNode?.mirrored ? '🗁' : '🗀';
          return (
            <div key={row.key} data-rowkey={row.key} className={cls} style={style}
              onPointerDown={e => onRowPointerDown(row, e)}
              onClick={e => { if ((e.target as HTMLElement).closest('.sb-rename')) return; clickRow(row, e); if (!e.shiftKey && !e.metaKey && !e.ctrlKey) toggle(row.folderId!); }}
              onDoubleClick={e => { e.stopPropagation(); if (canRename(row)) { toggle(row.folderId!); setRenaming(row.key); } }}
              onContextMenu={e => openMenu(e, row)}
              title={row.libNode?.type === 'link' ? `${row.name} — linked folder on your computer. It stays where it is; Copy a sample here to get your own copy, Delete sends the real file to the Trash (it asks first), Delete on this folder just unlinks it.` + (row.countLabel === '…' ? ' Open it to read it from disk' : '')
                : row.readonly && !row.isR2 ? `${row.name} — a folder inside a linked folder on your computer (read-only here; Copy it or Cmd/Ctrl-drag it to get your own copy)` : row.key === 'user' ? 'USER SAMPLES — your own samples, a real folder inside the Sample Library (Preferences → FOLDERS → USER SAMPLES → OPEN). What you do here happens on disk: new folder = a real folder, move / copy / rename are real, Delete goes to the Trash. Drop files or whole folders from Finder to copy them in' : row.libNode?.mirrored ? `${row.name} — a real folder inside USER SAMPLES (what you do here happens on disk too)` : row.name}>
              <span className="sb-tw" onClick={e => { e.stopPropagation(); toggle(row.folderId!); }}>{row.open ? '▾' : '▸'}</span>
              <span className="sb-fico">{icon}</span>
              {renaming === row.key
                ? <input ref={renameInput} className="sb-rename" autoFocus defaultValue={row.name}
                    onKeyDown={e => { e.stopPropagation(); if (e.key === 'Enter') void commitRename(row, (e.target as HTMLInputElement).value); if (e.key === 'Escape') setRenaming(null); }}
                    onBlur={e => void commitRename(row, e.target.value)} />
                : <span className="sb-fname">{row.name}</span>}
              <span className="sb-fcount" title={row.countLabel === '…' ? 'Not read yet — open the folder' : row.readonly && !row.isR2 ? `${row.countLabel ?? row.count} items listed in this folder` : undefined}>{row.countLabel ?? row.count}</span>
            </div>
          );
        }
        // item
        const e = row.entry;
        const placeholder = !e;
        return (
          <div key={row.key} data-rowkey={row.key} ref={isFocus ? selectedElRef : undefined}
            className={`${cls} sb-track${placeholder ? ' sb-row--hint' : ''}`} style={style}
            onPointerDown={ev => !placeholder && onRowPointerDown(row, ev)}
            onClick={ev => { if (placeholder) return; if ((ev.target as HTMLElement).closest('.sb-rename')) return; clickRow(row, ev); if (!ev.shiftKey && !ev.metaKey && !ev.ctrlKey && e) onSelectEntry(row.plName ?? '', e); }}
            onDoubleClick={ev => { ev.stopPropagation(); if (e) onLoadEntry(e); }}
            onContextMenu={ev => openMenu(ev, placeholder ? null : row)}
            title={placeholder ? undefined : row.presetStar ? `${row.name} — has a saved preset · click to preview, double-click to load` : `${row.name} — click to preview, double-click to load`}>
            <span className="sb-tnum">{row.libNode?.type === 'r2' ? '◆' : row.libNode?.meta?.source === 'youtube' ? '▶' : row.libNode?.meta?.source === 'recording' ? '●' : row.libNode?.readonly ? '⇗' : row.libNode ? '·' : ''}</span>
            {renaming === row.key
              ? <input ref={renameInput} className="sb-rename" autoFocus defaultValue={row.name}
                  onKeyDown={ev => { ev.stopPropagation(); if (ev.key === 'Enter') void commitRename(row, (ev.target as HTMLInputElement).value); if (ev.key === 'Escape') setRenaming(null); }}
                  onBlur={ev => void commitRename(row, ev.target.value)} />
              : <span className="sb-tname">{isFocus && isPlaying ? '♪ ' : ''}{row.name}</span>}
            {row.presetStar && <span className="sb-tstar" title="Saved preset available">★</span>}
            <span className="sb-tdur">{e ? (row.sub ?? fmtTime(e.duration)) : ''}</span>
          </div>
        );
      })}
      {drag && createPortal(
        <div className="sb-drag-ghost" style={{ position: 'fixed', left: drag.x + 12, top: drag.y - 10, zIndex: 10001 }}>
          {drag.copy ? '⧉ ' : ''}{drag.keys.length === 1 ? (rowByKey.get(drag.keys[0])?.name ?? '') : `${drag.keys.length} items`}
        </div>
      , document.body)}
      {menu && createPortal(
        <div className="sb-menu" ref={menuRef} style={{ position: 'fixed', left: menu.x, top: menu.y, zIndex: 10000 }} onPointerDown={e => e.stopPropagation()}>
          {menuSub ? (() => {
            // Every folder of YOURS, in tree order (collapsed ones too) — not
            // TERMINATOR SAMPLES, not linked folders (read-only).
            const targets: Array<{ id: string | null; name: string; depth: number }> = [{ id: null, name: 'LIBRARY (top level)', depth: 0 }];
            const walk = (ids: string[], depth: number) => { for (const id of ids) { const n = lib?.nodes[id]; if (!n || n.type !== 'folder' || n.readonly) continue; targets.push({ id, name: n.name, depth }); walk(n.children ?? [], depth + 1); } };
            walk(lib?.root ?? [], 1);
            const keys = selectionFor(menu.row);
            const go = async (targetId: string | null) => {
              setMenu(null); setMenuSub(null);
              if (!library) return;
              // MOVE: your own files move; anything that can't leave its home
              // (a TERMINATOR SAMPLES song, a linked file) arrives as a real
              // copy of yours instead — "move anything anywhere" (his rule).
              const own = libIdsOf(keys);
              const copyOnly = copyIdsOf(keys).filter(id => !own.includes(id));
              if (menuSub === 'move') { if (own.length) await library.move(own, targetId); if (copyOnly.length) await library.copy(copyOnly, targetId); }
              else { const ids = copyIdsOf(keys); if (ids.length) await library.copy(ids, targetId); }
              for (const k of keys) { const r = rowByKey.get(k); if (r?.kind === 'item' && !r.libNode && r.entry) await (library.importR2 ?? library.addR2Ref)(targetId, r.entry.id, r.entry.title, r.plName ?? '', r.entry.duration); }
            };
            return (<>
              <button className="sb-menu-item" title="Back to the menu" onClick={() => setMenuSub(null)}>← {menuSub === 'move' ? 'MOVE TO…' : 'COPY TO…'}</button>
              <div className="sb-menu-sep" />
              <div style={{ maxHeight: 260, overflowY: 'auto' }}>
                {targets.map(t => (
                  <button key={t.id ?? '__root'} className="sb-menu-item" style={{ paddingLeft: 12 + t.depth * 12 }} title={menuSub === 'move' ? `Move the selection into ${t.name}` : `Copy the selection into ${t.name}`} onClick={() => void go(t.id)}>{t.depth ? '🗀 ' : ''}{t.name}</button>
                ))}
              </div>
            </>);
          })() : menuItems().map((it, i) => it.sep
            ? <div key={i} className="sb-menu-sep" />
            : <button key={i} className="sb-menu-item" disabled={it.disabled} title={it.tip} onClick={() => { if (!it.keep) setMenu(null); it.run?.(); }}>{it.label}</button>)}
        </div>
      , document.body)}
    </div>
  );
}

function countFiles(nodes: Record<string, LibNode>, id: string): number {
  const n = nodes[id]; if (!n) return 0;
  if (n.type === 'file' || n.type === 'r2') return 1;
  let c = 0; for (const k of n.children ?? []) c += countFiles(nodes, k);
  return c;
}
