// Renderer-side view of the Sample Library bridge (Electron only). The main
// process owns the tree (src/main/library.ts); this is the typed surface the
// browser calls, built from window.terminator when it exposes libraryGet.

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
  /** USER SAMPLES: a real file/folder on disk — organising it happens in Finder too. */
  mirrored?: boolean;
  /** A folder inside a linked directory not listed yet — listLink(id) fills it when opened. */
  lazy?: boolean;
}
export interface LibraryData { root: string[]; nodes: Record<string, LibNode>; libraryRoot: string }
export interface YtProgress { jobId: string; phase: 'enumerating' | 'downloading' | 'done' | 'cancelled' | 'error'; done?: number; total?: number; title?: string; percent?: number; folderId?: string; nodeId?: string; error?: string; failed?: number; skipped?: number; capped?: boolean }

export interface LibraryBridge {
  get: () => Promise<LibraryData | { error: string }>;
  /** Direct children of a linked folder (lazy listing — one readdir). */
  listLink: (id: string) => Promise<LibNode[] | { error: string }>;
  /** File-name search across every linked folder: { linkRootId: hits[] }. */
  searchLinks: (q: string) => Promise<Record<string, LibNode[]> | { error: string }>;
  createFolder: (parentId: string | null, name: string, index?: number) => Promise<LibNode | { error: string }>;
  rename: (id: string, name: string) => Promise<LibNode | { error: string }>;
  move: (ids: string[], targetId: string | null, index?: number) => Promise<unknown>;
  copy: (ids: string[], targetId: string | null, index?: number) => Promise<string[] | { error: string }>;
  duplicate: (ids: string[]) => Promise<string[] | { error: string }>;
  remove: (ids: string[]) => Promise<unknown>;
  importPaths: (paths: string[], targetId: string | null, index?: number) => Promise<string[] | { error: string }>;
  addR2Ref: (targetId: string | null, r2Id: string, name: string, r2Playlist: string, durationSec?: number, index?: number) => Promise<unknown>;
  /** TERMINATOR SAMPLES → your folder as a REAL copy (pulled, then placed); falls back to a reference offline. */
  importR2?: (targetId: string | null, r2Id: string, name: string, r2Playlist: string, durationSec?: number, index?: number) => Promise<unknown>;
  reveal: (id: string) => Promise<unknown>;
  pickFolder: () => Promise<string[] | { error: string }>;
  pickFiles: (targetId: string | null) => Promise<string[] | { error: string }>;
  saveRecording: (payload: { filename: string; data: ArrayBuffer }) => Promise<LibNode | { error: string }>;
  /** Terminator 3.0 (WebView drops carry no paths): the dropped Files' BYTES → Imports/ (or the USER SAMPLES
   *  folder they landed on). Absent in Electron (importPaths has the paths). */
  importFiles?: (files: File[], targetId: string | null, index?: number) => Promise<string[] | { error: string }>;
  youtubeImport: (url: string, targetId: string | null) => Promise<{ jobId: string }>;
  youtubeCancel: (jobId: string) => Promise<unknown>;
  onChanged: (handler: () => void) => () => void;
  onYouTubeProgress: (handler: (p: YtProgress) => void) => () => void;
  pathForFile: (file: File) => string;
}

/** Playable URL for a library file node (served off disk by the main process; in Terminator 3.0 the JUCE shell
 *  serves it at /lib/b64/<path> — `window.terminator.libraryFileUrl` resolves the node synchronously). */
export const libFileUrl = (nodeId: string): string => {
  const t = (window as any).terminator;
  if (t && typeof t.libraryFileUrl === 'function') { const u = t.libraryFileUrl(nodeId); if (typeof u === 'string' && u) return u; }
  return `terminator-lib://file/${encodeURIComponent(nodeId)}`;
};
/** Browser entry ids for library files carry this prefix so the host can tell
 *  them from R2 ids. */
export const LIB_ID_PREFIX = 'lib:';
/** The library folder that holds DL'd playlists (one sub-folder per playlist); shown under TERMINATOR SAMPLES. */
export const DL_PLAYLISTS_ID = 'dl-playlists';

export function libraryBridgeFromWindow(): LibraryBridge | undefined {
  const t = (window as any).terminator;
  if (!t || typeof t.libraryGet !== 'function') return undefined;
  return {
    get: t.libraryGet,
    listLink: t.libraryListLink,
    searchLinks: t.librarySearchLinks,
    createFolder: t.libraryCreateFolder,
    rename: t.libraryRename,
    move: t.libraryMove,
    copy: t.libraryCopy,
    duplicate: t.libraryDuplicate,
    remove: t.libraryRemove,
    importPaths: t.libraryImportPaths,
    addR2Ref: t.libraryAddR2Ref,
    importR2: t.libraryImportR2,
    reveal: t.libraryReveal,
    pickFolder: t.libraryPickFolder,
    pickFiles: t.libraryPickFiles,
    saveRecording: t.librarySaveRecording,
    importFiles: typeof t.libraryImportFiles === 'function' ? t.libraryImportFiles : undefined,
    youtubeImport: t.libraryYouTubeImport,
    youtubeCancel: t.libraryYouTubeCancel,
    onChanged: t.onLibraryChanged,
    onYouTubeProgress: t.onLibraryYouTubeProgress,
    pathForFile: t.pathForFile,
  };
}
