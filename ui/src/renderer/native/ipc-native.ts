/**
 * ipc-native — `window.terminator` for the Terminator 3.0 JUCE shell.
 *
 * The renderer talks to its host through `window.terminator` (the Electron preload's 128-method surface; the
 * web build stands in with ipc-browser's IndexedDB shim). Inside the native shell this module OVERLAYS the
 * browser shim: everything the shell can do natively is routed over the JUCE bridge (juceBridge.ts →
 * terminatorFs / terminatorSettings in app/src/ShellServices.cpp); everything it cannot do yet keeps the
 * browser-shim behaviour (IndexedDB, blob downloads) or stays undefined so the UI hides the control. The Preferences window is native (a second JUCE window hosting
 * preferences.html — `openPreferences` → terminatorWindow).
 *
 * Import order matters: main.tsx imports THIS module first; it imports ipc-browser (whose side effect installs
 * the shim), then replaces window.terminator with the overlay — all before App.tsx evaluates and reads it.
 *
 * Native today: settings (get/getSync/set/onChanged), EULA (recorded in settings.json; the Supabase insert
 * comes with the licence flow in Phase 8/9), recents, projects folder + .tproj open/save/list/delete (Trash)
 * with native dialogs, layout / MIDI-map / bass-patch files, per-videoId presets + named presets + the session
 * autosave (JSON files under the app data dir, same layout as Electron's terminator-presets), reveal in
 * Finder/Explorer, open external links, clipboard text, the Preferences window, **the Sample Library**
 * (`library*` + the FOLDERS-tab root methods — libraryNative.ts: the Electron library logic ported over
 * terminatorFs; files served by the shell at /lib/b64/; Finder drops come in as bytes via libraryImportFiles).
 * plus the ASSET STORE + `.tprojz` bundles (assetsNative.ts — <dataDir>/assets with a read fallback into the
 * Electron app's store, bundle bytes via readBinary/writeBinary) and YouTube pulls (the bundled yt-dlp).
 * NOT yet native (browser-shim or undefined): drums/stems, menu shortcuts / Recent submenu / open-with-file
 * events, drag-out, licence, cloud presets.
 */
import { installBrowserIPC } from '../ipc-browser';
import { isNative, native, nativeBoot, onNativeEvent } from './juceBridge';
import { buildLibraryOverlay, installLibraryProbe } from './libraryNative';
import { buildAssetKeys, installAssetsProbe, readBinaryFile, writeBinaryFile } from './assetsNative';

type AnyRecord = Record<string, any>;
type Unsub = () => void;

const PROJECT_EXT = '.tproj';
const BUNDLE_EXT = '.tprojz';

function join(dir: string, name: string): string {
  const sep = nativeBoot()?.dirs.sep ?? '/';
  return dir.endsWith(sep) ? dir + name : dir + sep + name;
}
function projectExtOf(p: string): string | null {
  const l = p.toLowerCase();
  return l.endsWith(BUNDLE_EXT) ? BUNDLE_EXT : l.endsWith(PROJECT_EXT) ? PROJECT_EXT : null;
}
function projectBaseName(p: string): string {
  const base = p.split(/[\\/]/).pop() ?? p;
  return base.replace(/\.tprojz?$/i, '');
}
function safeFilename(name: string): string {
  return String(name).replace(/[/\\:*?"<>|\0]/g, '-').replace(/^\.+/, '').trim().slice(0, 120) || 'untitled';
}
const safeVideoId = (id: unknown): string | null =>
  typeof id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(id) ? id : null;

export function installNativeIPC(): void {
  // make sure the browser shim is in place first (idempotent), then overlay
  installBrowserIPC();
  if (!isNative()) return;
  const base = ((window as any).terminator ?? {}) as AnyRecord;
  const boot = nativeBoot();

  // ── focus: Preferences closed, so the shell handed the main window back (see WebShell::closePreferences).
  // The native view being key is not enough — the DOCUMENT has to be focused or keydown never fires and the pads
  // stay dead until something is clicked. ──
  onNativeEvent('terminator.focusMain', () => {
    try {
      window.focus();
      const el = document.activeElement as HTMLElement | null;
      if (!el || el === document.body) document.body.focus?.();
    } catch { /* */ }
  });

  // ── settings (settings.json `app` — the Electron terminator-settings.json keys, verbatim) ──
  let settingsCache: AnyRecord = boot?.settings ?? {};
  const settingsListeners = new Set<(s: AnyRecord) => void>();
  onNativeEvent('terminator.settingsChanged', (s) => {
    if (s && typeof s === 'object') { settingsCache = s; for (const l of settingsListeners) { try { l(s); } catch { /* */ } } }
  });
  const getSettings = async (): Promise<AnyRecord> => {
    const r = await native.settings({ verb: 'get' });
    if (r?.ok && r.settings && typeof r.settings === 'object') settingsCache = r.settings;
    return settingsCache;
  };
  const setSettings = async (patch: AnyRecord) => {
    const r = await native.settings({ verb: 'set', patch });
    if (r?.ok && r.settings) { settingsCache = r.settings; for (const l of settingsListeners) { try { l(r.settings); } catch { /* */ } } }
    return r?.ok ? { ok: true, settings: r.settings } : { error: r?.error ?? 'settings write failed' };
  };

  // ── dirs ──
  let dirs = boot?.dirs ?? null;
  const refreshDirs = async () => { const r = await native.fs({ verb: 'dirs' }); if (r?.ok) dirs = r as any; return dirs!; };
  const dataDir = () => dirs?.dataDir ?? '';
  const projectsDir = () => dirs?.projectsDir ?? '';
  const projectsDirInfo = () => ({ path: projectsDir(), isDefault: !!dirs?.projectsIsDefault });

  // ── small JSON files in the app data dir ──
  const readJson = async <T,>(path: string): Promise<T | null> => {
    const r = await native.fs({ verb: 'readText', path });
    if (!r?.ok) return null;
    try { return JSON.parse(r.text) as T; } catch { return null; }
  };
  const writeJson = async (path: string, value: unknown) => {
    const r = await native.fs({ verb: 'writeText', path, text: JSON.stringify(value ?? null, null, 2) });
    return r?.ok ? { ok: true } : { ok: false, error: r?.error ?? 'write failed' };
  };
  const dataFile = (name: string) => join(dataDir(), name);
  const presetsDir = () => join(dataDir(), 'presets');

  // ── projects ──
  const readProjectAtPath = async (filePath: string) => {
    if (typeof filePath !== 'string' || !filePath || filePath.length > 4096) return { error: 'invalid path' };
    const ext = projectExtOf(filePath);
    if (!ext) return { error: 'not a project file' };
    if (ext === BUNDLE_EXT) {
      // .tprojz → the raw bytes (the renderer unpacks: project.json + manifest + samples → the asset store)
      const rb = await readBinaryFile(filePath);
      if (!rb) return { error: 'Could not open project — file missing or unreadable' };
      return { path: filePath, name: projectBaseName(filePath), bundle: rb.bytes };
    }
    const r = await native.fs({ verb: 'readText', path: filePath });
    if (!r?.ok) return { error: 'Could not open project — file missing or unreadable' };
    try {
      const data = JSON.parse(r.text);
      if (!data || typeof data !== 'object') return { error: 'invalid project file' };
      return { path: filePath, name: projectBaseName(filePath), data };
    } catch { return { error: 'invalid project file' }; }
  };

  const recents = {
    get: (): Array<{ name: string; id: string; loadedAt: number }> => {
      const raw = settingsCache.recentProjects;
      return Array.isArray(raw) ? raw.filter((r: any) => r && typeof r.id === 'string' && typeof r.name === 'string').slice(0, 10) : [];
    },
  };

  const overlay: AnyRecord = {
    // settings
    getSettings,
    getSettingsSync: () => settingsCache,
    setSettings,
    onSettingsChanged: (h: (s: AnyRecord) => void): Unsub => { settingsListeners.add(h); return () => settingsListeners.delete(h); },

    // EULA — recorded locally; the Supabase insert joins the licence flow (Phase 8/9)
    eulaStatus: async () => ({ accepted: !!(await getSettings()).eula?.accepted }),
    eulaAccept: async (name: string, email: string) => {
      if (typeof name !== 'string' || typeof email !== 'string') return { ok: false, error: 'invalid input' };
      if (name.length > 200 || email.length > 320) return { ok: false, error: 'too long' };
      const r = await setSettings({ eula: { accepted: true, name, email, acceptedAt: new Date().toISOString() } });
      return { ok: !('error' in r) };
    },

    // recents (settings.recentProjects, max 10) — the native File → Recent menu reads the same list later
    getRecentProjects: async () => recents.get(),
    addRecentProject: async (entry: { name: string; id: string }) => {
      if (!entry || typeof entry.name !== 'string' || typeof entry.id !== 'string') return recents.get();
      const next = [{ name: entry.name.slice(0, 200), id: entry.id.slice(0, 1024), loadedAt: Date.now() }, ...recents.get().filter(r => r.id !== entry.id)].slice(0, 10);
      await setSettings({ recentProjects: next });
      return next;
    },
    removeRecentProject: async (id: string) => { const next = recents.get().filter(r => r.id !== id); await setSettings({ recentProjects: next }); return next; },
    onLoadRecent: (_h: (id: string) => void): Unsub => () => {},   // native menu: later
    onOpenFile: (_cb: (p: string) => void): Unsub => () => {},      // .tproj double-click: later (anotherInstanceStarted)

    // projects folder + files
    getProjectsDir: async () => { await refreshDirs(); return projectsDirInfo(); },
    chooseProjectsDir: async () => {
      const r = await native.fs({ verb: 'openDialog', mode: 'dir', title: 'Choose where Terminator saves your projects', dir: projectsDir() });
      if (!r?.ok || r.cancelled) return { cancelled: true, ...projectsDirInfo() };
      await setSettings({ projectsDir: r.path });
      await refreshDirs();
      return { ok: true, ...projectsDirInfo() };
    },
    resetProjectsDir: async () => { await setSettings({ projectsDir: null }); await refreshDirs(); return { ok: true, ...projectsDirInfo() }; },
    revealProjectsDir: async () => { await native.fs({ verb: 'mkdir', path: projectsDir() }); const r = await native.fs({ verb: 'reveal', path: projectsDir() }); return r?.ok ? { ok: true } : { error: r?.error ?? 'reveal failed' }; },
    listProjectFiles: async () => {
      const r = await native.fs({ verb: 'list', dir: projectsDir(), exts: [PROJECT_EXT, BUNDLE_EXT] });
      if (!r?.ok) return [];
      return (r.entries as any[]).filter(e => !e.isDir && projectExtOf(e.path))
        .map(e => ({ name: projectBaseName(e.path), path: e.path, modifiedAt: Number(e.modifiedAt) || 0 }))
        .sort((a, b) => b.modifiedAt - a.modifiedAt);
    },
    openProjectDialog: async () => {
      const r = await native.fs({ verb: 'openDialog', mode: 'file', title: 'Open Terminator Project', dir: projectsDir(), filters: '*.tproj;*.tprojz' });
      if (!r?.ok || r.cancelled) return { cancelled: true };
      return readProjectAtPath(r.path);
    },
    readProjectFile: (filePath: string) => readProjectAtPath(filePath),
    showSaveDialog: async (opts?: { bundle?: boolean }) => {
      const wantBundle = !!opts?.bundle;
      const ext = wantBundle ? BUNDLE_EXT : PROJECT_EXT;
      const r = await native.fs({ verb: 'saveDialog', title: 'Save Terminator Project', dir: projectsDir(), defaultName: `Untitled${ext}`, filters: wantBundle ? '*.tprojz;*.tproj' : '*.tproj' });
      if (!r?.ok || r.cancelled) return { cancelled: true };
      return { path: r.path };
    },
    saveProjectFile: async (target: string, data: object) => {
      if (typeof target !== 'string' || !target) return { error: 'invalid path' };
      if (!data || typeof data !== 'object') return { error: 'invalid project data' };
      const isAbs = /^(\/|[A-Za-z]:[\\/])/.test(target);
      let outPath: string;
      if (isAbs) outPath = target.toLowerCase().endsWith(PROJECT_EXT) ? target : `${target}${PROJECT_EXT}`;
      else outPath = join(projectsDir(), safeFilename(target.toLowerCase().endsWith(PROJECT_EXT) ? target : `${target}${PROJECT_EXT}`));
      const r = await native.fs({ verb: 'writeText', path: outPath, text: JSON.stringify(data, null, 2) });
      if (!r?.ok) return { error: r?.error ?? 'write failed' };
      // A stale bundle twin of the same name would shadow this in the Open list.
      await native.fs({ verb: 'trash', path: outPath.replace(/\.tproj$/i, BUNDLE_EXT) }).catch(() => null);
      return { ok: true, path: r.path, name: projectBaseName(r.path) };
    },
    // Write a project BUNDLE (.tprojz bytes built by the renderer). Same target rules as saveProjectFile.
    saveProjectBundle: async (target: string, bytes: Uint8Array | ArrayBuffer) => {
      if (typeof target !== 'string' || !target) return { error: 'invalid path' };
      if (!(bytes instanceof Uint8Array) && !(bytes instanceof ArrayBuffer)) return { error: 'invalid bundle data' };
      const buf = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
      const isAbs = /^(\/|[A-Za-z]:[\\/])/.test(target);
      let outPath: string;
      if (isAbs) outPath = target.toLowerCase().endsWith(BUNDLE_EXT) ? target : `${target.replace(/\.tproj$/i, '')}${BUNDLE_EXT}`;
      else outPath = join(projectsDir(), safeFilename(target.toLowerCase().endsWith(BUNDLE_EXT) ? target : `${target.replace(/\.tproj$/i, '')}${BUNDLE_EXT}`));
      const w = await writeBinaryFile(outPath, buf);
      if (!w.ok) return { error: w.error ?? 'write failed' };
      await native.fs({ verb: 'trash', path: outPath.replace(/\.tprojz$/i, PROJECT_EXT) }).catch(() => null);
      return { ok: true, path: outPath, name: projectBaseName(outPath) };
    },
    deleteProjectFile: async (filePath: string) => {
      if (typeof filePath !== 'string' || !filePath || !projectExtOf(filePath)) return { error: 'not a project file' };
      const dir = projectsDir();
      if (!filePath.startsWith(dir) || projectBaseName(filePath) === '' ) return { error: 'forbidden' };
      const r = await native.fs({ verb: 'trash', path: filePath });
      return r?.ok ? { ok: true } : { error: r?.error ?? 'delete failed' };
    },

    // small persistence files (same names as Electron's userData files)
    saveLayout: (layout: object) => writeJson(dataFile('layout.json'), layout ?? {}),
    loadLayout: () => readJson<Record<string, { x: number; y: number }>>(dataFile('layout.json')),
    saveMidiMap: (map: object) => writeJson(dataFile('midi-map.json'), map ?? {}),
    loadMidiMap: () => readJson<Record<string, { parameterId: string; min: number; max: number }>>(dataFile('midi-map.json')),
    saveBassPatches: (list: object) => writeJson(dataFile('bass-patches.json'), list ?? []),
    loadBassPatches: () => readJson<Array<{ name: string; patch: object }>>(dataFile('bass-patches.json')),

    // presets + session (JSON under <dataDir>/presets — Electron's terminator-presets layout)
    savePreset: async (preset: any) => {
      const id = safeVideoId(preset?.videoId); if (!id) return { error: 'invalid preset' };
      return writeJson(join(presetsDir(), `${id}.json`), preset);
    },
    loadPreset: async (videoId: string) => { const id = safeVideoId(videoId); return id ? readJson<object>(join(presetsDir(), `${id}.json`)) : null; },
    saveSession: (session: object) => (session && typeof session === 'object') ? writeJson(dataFile('session.json'), session) : Promise.resolve({ error: 'invalid session' }),
    loadSession: () => readJson<object>(dataFile('session.json')),
    listNamedPresets: async () => {
      const r = await native.fs({ verb: 'list', dir: presetsDir(), exts: ['.json'] });
      if (!r?.ok) return [];
      const out: Array<{ name: string; trackTitle?: string; savedAt: string; videoId: string }> = [];
      for (const e of r.entries as any[]) {
        if (e.isDir || !String(e.fileName).startsWith('named_')) continue;
        const p = await readJson<any>(e.path);
        if (p) out.push({ name: p.name ?? e.name, trackTitle: p.trackTitle, savedAt: p.savedAt ?? '', videoId: p.videoId ?? '' });
      }
      return out.sort((a, b) => String(b.savedAt).localeCompare(String(a.savedAt)));
    },
    saveNamedPreset: async (name: string, preset: object) => {
      if (typeof name !== 'string' || !name) return { error: 'invalid name' };
      if (!preset || typeof preset !== 'object') return { error: 'invalid preset' };
      return writeJson(join(presetsDir(), `named_${safeFilename(name)}.json`), { ...preset, name });
    },
    loadNamedPreset: (name: string) => (typeof name === 'string' && name) ? readJson<object>(join(presetsDir(), `named_${safeFilename(name)}.json`)) : Promise.resolve(null),
    deleteNamedPreset: async (name: string) => { if (typeof name !== 'string' || !name) return { error: 'invalid name' }; await native.fs({ verb: 'trash', path: join(presetsDir(), `named_${safeFilename(name)}.json`) }); return { ok: true }; },

    // windows
    openPreferences: async () => { const r = await native.window({ verb: 'preferences' }); return { ok: !!r?.ok }; },

    // system
    revealInFinder: (filePath: string) => { void native.fs({ verb: 'reveal', path: filePath }); },
    openExternal: async (url: string) => { await native.fs({ verb: 'openExternal', url }); },
    clipboardReadText: async () => { const r = await native.fs({ verb: 'clipboardReadText' }); return r?.ok ? String(r.text ?? '') : ''; },
    pathForFile: (_file: File): string => '', // WKWebView/WebView2 drops carry no paths — native drag-in comes via the shell (later)
    onShortcut: (_key: string, _h: () => void): Unsub => () => {}, // native menu accelerators: later
  };

  // the ASSET STORE (<dataDir>/assets, the Electron layout) + the read fallback into the Electron app's store
  const assets = buildAssetKeys({ dataDir, join });
  Object.assign(overlay, assets.keys);
  installAssetsProbe(assets);

  // the Sample Library (~/Music/Terminator) — libraryCore over terminatorFs, files served at /lib/b64/
  const library = buildLibraryOverlay({ getSettings, setSettings, settingsSync: () => settingsCache });
  Object.assign(overlay, library.keys);
  installLibraryProbe(library.core, library.keys, library.yt);

  (window as any).terminator = { ...base, ...overlay };
  (window as any).__terminatorNativeIpc = { installed: true, version: boot?.version ?? '' };
}

installNativeIPC();
