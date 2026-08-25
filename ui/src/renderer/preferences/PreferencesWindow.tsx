// NATIVE (Terminator 3.0): the preferences page is hosted in a second JUCE window — install the native
// window.terminator first (no-op elsewhere) and swap the AUDIO / MIDI device UI for the native panes.
import '../native/ipc-native';
import { isNative } from '../native/juceBridge';
import NativeAudioPane from '../native/NativeAudioPane';
import NativePluginsPane from '../native/NativePluginsPane';
import NativeMidiPane from '../native/NativeMidiPane';
import React, { useEffect, useState, useCallback, CSSProperties } from 'react';
import { createRoot } from 'react-dom/client';

// ─────────────────────────────────────────────────────────────────────────────
// Terminator Preferences — runs in its OWN BrowserWindow (see src/main/
// preferences.ts), separate from the main chopper window. It shares the same
// preload, so window.terminator (and the settings IPC) is available. All prefs
// persist into terminator-settings.json via getSettings/setSettings; the main
// process broadcasts settings:changed back to the main window so it can apply
// audio prefs immediately where the Web Audio API allows.
// ─────────────────────────────────────────────────────────────────────────────

// The shared preload bridge. Typed loosely here — the full surface lives in the
// preload; this window only needs the settings methods (optional-guarded so a
// stale/web bridge degrades gracefully).
type DirInfo = { path: string; isDefault: boolean };
const bridge = (window as any).terminator as {
  getSettings?: () => Promise<Record<string, any>>;
  setSettings?: (patch: Record<string, any>) => Promise<{ ok?: boolean; settings?: Record<string, any> }>;
  // FOLDERS tab (all optional-guarded — a stale preload degrades gracefully)
  getProjectsDir?: () => Promise<DirInfo>;
  chooseProjectsDir?: () => Promise<DirInfo & { ok?: boolean; cancelled?: boolean; error?: string }>;
  resetProjectsDir?: () => Promise<DirInfo & { ok?: boolean }>;
  revealProjectsDir?: () => Promise<{ ok?: boolean; error?: string }>;
  getLibraryRoot?: () => Promise<DirInfo>;
  chooseLibraryRoot?: (mode: 'move' | 'point') => Promise<DirInfo & { ok?: boolean; cancelled?: boolean; error?: string; moved?: number; oldRoot?: string }>;
  resetLibraryRoot?: () => Promise<DirInfo & { ok?: boolean }>;
  revealLibraryRoot?: () => Promise<{ ok?: boolean; error?: string }>;
  onLibraryMoveProgress?: (cb: (p: { done: number; total: number }) => void) => () => void;
  getCacheDirInfo?: () => Promise<DirInfo>;
  setCacheDir?: () => Promise<{ ok?: boolean; cacheDir?: string; cancelled?: boolean }>;
  resetCacheDir?: () => Promise<DirInfo & { ok?: boolean }>;
  revealCacheDir?: () => Promise<{ ok?: boolean; error?: string }>;
  // Disk usage + the STEMS section (engines + saved stem audio).
  getFolderSizes?: () => Promise<Record<'projects' | 'library' | 'cache' | 'drums' | 'drumsBundled', { bytes: number; approx: boolean }>>;
  libraryReveal?: (id: string) => Promise<unknown>;
  drumsUserDir?: () => Promise<DirInfo>;
  drumsUserReveal?: () => Promise<{ ok: boolean }>;
  drumsUserEmpty?: () => Promise<{ ok: boolean; moved: number; error?: string }>;
  stemsUsage?: () => Promise<{ models: Array<{ quality: 'fast' | 'fine'; bytes: number; ready: boolean; expectedBytes?: number; downloading?: boolean }>; modelsDir: string; audio: { bytes: number; count: number }; songs?: Array<{ title: string; bytes: number; files: number }> }>;
  stemsDeleteModels?: (q: 'fast' | 'fine') => Promise<{ ok: boolean; error?: string }>;
  stemsDownloadModels?: (q: 'fast' | 'fine') => Promise<{ ok: boolean; error?: string }>;
  onStemsModelProgress?: (cb: (p: { quality: 'fast' | 'fine'; pct: number }) => void) => () => void;
  stemsClearAudio?: () => Promise<{ ok: boolean; deleted?: number; bytes?: number; error?: string }>;
  stemsDeleteSongStems?: (title: string) => Promise<{ ok: boolean; deleted?: number; bytes?: number; error?: string }>;
  stemsRevealModels?: () => Promise<{ ok: boolean; error?: string }>;
  stemsRevealAudio?: () => Promise<{ ok: boolean; error?: string }>;
  // NATIVE (3.0): the engines folder can move — pointing it at a folder that already holds htdemucs (the
  // Electron app's, an external drive) adopts those files instead of downloading them again.
  stemsModelsDir?: () => Promise<{ path: string; isDefault: boolean }>;
  stemsChooseModelsDir?: () => Promise<{ path: string; isDefault: boolean; cancelled?: boolean; error?: string }>;
  stemsResetModelsDir?: () => Promise<{ path: string; isDefault: boolean; error?: string }>;
} | undefined;

/** Finder-style decimal units — matches what the OS shows for the folder. */
const fmtBytes = (n: number): string =>
  n >= 1e9 ? `${(n / 1e9).toFixed(2)} GB`
  : n >= 1e6 ? `${(n / 1e6).toFixed(1)} MB`
  : n >= 1e3 ? `${Math.round(n / 1e3)} KB`
  : `${n} B`;

const BUFFER_SIZES = [128, 256, 512, 1024];
const SAMPLE_RATES = [44100, 48000];
/** What the SYSTEM runs at — a throwaway default context reports the hardware
 *  rate (cheap; closed immediately). Shown so the AUTO option is concrete. */
function systemSampleRate(): number | null {
  try { const c = new AudioContext(); const r = c.sampleRate; void c.close(); return r; } catch { return null; }
}

// Sequencer resolution (pulses per quarter note). The scheduler snaps drum
// micro-timing to this grid; lower values give vintage drum-machine "feel",
// higher values give modern-DAW precision. Applied globally via the drum engine.
const PPQ_OPTIONS: Array<{ value: number; desc: string }> = [
  { value: 24,  desc: 'E-mu SP-1200, raw golden age hip hop feel' },
  { value: 48,  desc: 'Roger Linn LM-1, Prince/MJ era groove' },
  { value: 96,  desc: 'MPC 60 / 2000 / 3000, legendary classic timing' },
  { value: 192, desc: 'Modern DAW standard, smooth feel' },
  { value: 480, desc: 'Pro Tools / Logic precision' },
  { value: 960, desc: 'MPC 4000 / modern MPC, maximum resolution' },
];

interface AudioPrefs {
  // ENGINE options (applied at AudioContext construction → next launch).
  // 0 = AUTO (system default). These are the honest keys — the legacy
  // audio.bufferSize/sampleRate were never applied and stay ignored.
  bufferFrames: number;
  sampleRateHz: number;
  ppq: number;              // sequencer resolution (pulses per quarter)
  outputDeviceId: string;   // '' = system default
  inputDeviceId: string;    // '' = system default
}
interface MidiPrefs {
  inputs: Record<string, boolean>;   // device id → enabled
  outputs: Record<string, boolean>;
  clock: boolean;
  /** Follow the TEMPO of a MIDI clock master while it drives the transport.
   *  Off by default: PLAY/STOP from the hardware always start/stop Terminator;
   *  the BPM only moves to match when this is on. */
  clockFollow?: boolean;
  channel: number;                   // 1..16
}
// AUTO everywhere: the browser's 'interactive' latency hint already asks for
// the smallest safe buffer, and the hardware rate avoids a resampler.
const DEFAULT_AUDIO: AudioPrefs = { bufferFrames: 0, sampleRateHz: 0, ppq: 960, outputDeviceId: '', inputDeviceId: '' };
const DEFAULT_MIDI: MidiPrefs = { inputs: {}, outputs: {}, clock: false, clockFollow: false, channel: 1 };

// ── shared styles (reference the CSS vars defined in preferences.html) ─────────
const card: CSSProperties = {
  background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 6,
  padding: '12px 14px', marginBottom: 12,
};
const label: CSSProperties = { display: 'block', color: 'var(--text-dim)', fontSize: 11, letterSpacing: 1, marginBottom: 5, textTransform: 'uppercase' };
const row: CSSProperties = { marginBottom: 12 };
const selectStyle: CSSProperties = {
  width: '100%', background: 'var(--bg3)', color: 'var(--text)', border: '1px solid var(--border)',
  borderRadius: 4, padding: '6px 8px', fontFamily: 'inherit', fontSize: 13,
};
const hint: CSSProperties = { color: 'var(--text-dim)', fontSize: 11, marginTop: 5, lineHeight: 1.4 };
const toggleRow: CSSProperties = {
  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
  padding: '6px 8px', borderBottom: '1px solid var(--border)', gap: 10,
};
const btn: CSSProperties = {
  background: 'var(--bg3)', color: 'var(--neon)', border: '1px solid var(--border)',
  borderRadius: 4, padding: '6px 12px', cursor: 'pointer', fontFamily: 'inherit', fontSize: 12,
};

function Toggle({ on, onChange }: { on: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      onClick={() => onChange(!on)}
      style={{
        width: 42, height: 22, borderRadius: 11, border: '1px solid var(--border)',
        background: on ? 'var(--neon)' : 'var(--bg3)', position: 'relative', cursor: 'pointer', flex: '0 0 auto',
      }}
      aria-pressed={on}
    >
      <span style={{
        position: 'absolute', top: 2, left: on ? 22 : 2, width: 16, height: 16, borderRadius: '50%',
        background: on ? '#04140c' : 'var(--text-dim)', transition: 'left 0.12s',
      }} />
    </button>
  );
}

// ── FOLDERS tab ───────────────────────────────────────────────────────────────
// One row per place Terminator saves to. PROJECTS and AUDIO CACHE reuse the
// exact settings the in-app controls write (OPEN… → CHANGE FOLDER / the cache
// button) — this tab is just the one place to see them all. The SAMPLE LIBRARY
// row is the new one: MOVE copies the library (files + index) and leaves the
// old folder as a backup, POINT just uses a folder that's already a library
// (or starts a fresh one there).
const pathStyle: CSSProperties = {
  color: 'var(--text)', fontSize: 11, fontFamily: 'ui-monospace, monospace',
  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', direction: 'rtl', textAlign: 'left',
  background: 'var(--bg3)', border: '1px solid var(--border)', borderRadius: 4, padding: '5px 8px', marginBottom: 8,
};
const btnRow: CSSProperties = { display: 'flex', gap: 8, flexWrap: 'wrap' };
const btnSm: CSSProperties = { ...btn, padding: '4px 10px' };

function FolderRow(props: {
  title: string; desc: string; info: DirInfo | null; busy?: boolean;
  buttons: Array<{ label: string; title: string; onClick: () => void; disabled?: boolean }>;
  note?: string | null; error?: string | null;
  /** Disk usage chip next to the title ("…" while it's being measured). */
  size?: string | null;
}) {
  return (
    <div style={card}>
      <label style={label}>
        {props.title}
        {props.size !== undefined && (
          <span style={{ float: 'right', color: 'var(--neon)', textTransform: 'none', letterSpacing: 0 }}
            title="Disk space this folder is using right now">
            {props.size ?? '…'}
          </span>
        )}
      </label>
      <div style={hint}>{props.desc}</div>
      <div style={{ ...pathStyle, marginTop: 8 }} title={props.info?.path ?? ''}>
        {props.info ? `‎${props.info.path}` : '…'}
        {props.info?.isDefault ? <span style={{ color: 'var(--text-dim)' }}>{'‎'} (default)</span> : null}
      </div>
      <div style={btnRow}>
        {props.buttons.map(b => (
          <button key={b.label} style={btnSm} title={b.title} disabled={b.disabled || props.busy} onClick={b.onClick}>{b.label}</button>
        ))}
      </div>
      {props.note && <div style={{ ...hint, color: 'var(--neon)' }}>{props.note}</div>}
      {props.error && <div style={{ ...hint, color: '#ff5f56' }}>{props.error}</div>}
    </div>
  );
}

function FoldersPane() {
  const [projects, setProjects] = useState<DirInfo | null>(null);
  const [libraryDir, setLibraryDir] = useState<DirInfo | null>(null);
  const [cache, setCache] = useState<DirInfo | null>(null);
  const [libChoice, setLibChoice] = useState(false);         // CHANGE… pressed → Move / Point picker
  const [moving, setMoving] = useState<{ done: number; total: number } | null>(null);
  const [note, setNote] = useState<string | null>(null);     // post-move "old folder kept at …"
  const [err, setErr] = useState<{ projects?: string; library?: string; cache?: string; stems?: string; drums?: string }>({});
  // Disk usage per row + the STEMS section (null = still measuring).
  const [sizes, setSizes] = useState<Record<'projects' | 'library' | 'cache' | 'drums' | 'drumsBundled', { bytes: number; approx: boolean }> | null>(null);
  const [drumsDir, setDrumsDir] = useState<DirInfo | null>(null);
  const [drumsConfirm, setDrumsConfirm] = useState(false);
  const [drumsNote, setDrumsNote] = useState<string | null>(null);
  const [stems, setStems] = useState<{ models: Array<{ quality: 'fast' | 'fine'; bytes: number; ready: boolean; expectedBytes?: number; downloading?: boolean }>; modelsDir: string; audio: { bytes: number; count: number }; songs?: Array<{ title: string; bytes: number; files: number }> } | null>(null);
  const [stemsNote, setStemsNote] = useState<string | null>(null);
  const [modelsDirDefault, setModelsDirDefault] = useState(true);
  // 7.3a experiment: masked pads read the engine's stem planes instead of a mix the page uploads.
  const [stemPlanes, setStemPlanes] = useState(false);
  // Engine download progress per quality (0..100) while one is in flight —
  // driven by the broadcast event, not by polling (a .part file reads as 0 B).
  const [dl, setDl] = useState<Partial<Record<'fast' | 'fine', number>>>({});
  // Which destructive stems button is in its inline "SURE?" state — an engine,
  // the clear-all, or one song's title (prefixed so titles can't collide).
  const [confirmClear, setConfirmClear] = useState<null | 'audio' | 'fast' | 'fine' | `song:${string}`>(null);

  const refresh = useCallback(async () => {
    try { setProjects(await bridge?.getProjectsDir?.() ?? null); } catch { /* */ }
    try { setLibraryDir(await bridge?.getLibraryRoot?.() ?? null); } catch { /* */ }
    try { setCache(await bridge?.getCacheDirInfo?.() ?? null); } catch { /* */ }
    try { setSizes(await bridge?.getFolderSizes?.() ?? null); } catch { /* */ }
    try { setDrumsDir(await bridge?.drumsUserDir?.() ?? null); } catch { /* */ }
    try { setStems(await bridge?.stemsUsage?.() ?? null); } catch { /* */ }
    try { const d = await bridge?.stemsModelsDir?.(); if (d) setModelsDirDefault(d.isDefault); } catch { /* */ }
    try { setStemPlanes((await bridge?.getSettings?.())?.stemsPlanes === true); } catch { /* */ }
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => bridge?.onLibraryMoveProgress?.(p => setMoving(p)) ?? undefined, []);
  useEffect(() => bridge?.onStemsModelProgress?.(p => {
    setDl(d => ({ ...d, [p.quality]: p.pct }));
    if (p.pct >= 100) { setTimeout(() => { setDl(d => { const n = { ...d }; delete n[p.quality]; return n; }); void refresh(); }, 400); }
  }) ?? undefined, [refresh]);
  const downloadEngine = async (q: 'fast' | 'fine') => {
    setErr(e => ({ ...e, stems: undefined })); setStemsNote(null);
    setDl(d => ({ ...d, [q]: 0 }));
    const r = await bridge?.stemsDownloadModels?.(q);
    setDl(d => { const n = { ...d }; delete n[q]; return n; });
    if (r && !r.ok) setErr(e => ({ ...e, stems: r.error ?? 'download failed' }));
    else setStemsNote(`${q.toUpperCase()} engine downloaded — your first ${q.toUpperCase()} split starts straight away.`);
    void refresh();
  };

  const sizeOf = (k: 'projects' | 'library' | 'cache' | 'drums' | 'drumsBundled'): string | null =>
    sizes && sizes[k] ? `${fmtBytes(sizes[k].bytes)}${sizes[k].approx ? '+' : ''}` : null;

  const deleteEngine = async (q: 'fast' | 'fine') => {
    setConfirmClear(null); setErr(e => ({ ...e, stems: undefined }));
    const r = await bridge?.stemsDeleteModels?.(q);
    if (r && !r.ok) setErr(e => ({ ...e, stems: r.error ?? 'could not delete' }));
    else setStemsNote(`${q.toUpperCase()} engine deleted — it re-downloads on the next ${q.toUpperCase()} split.`);
    void refresh();
  };
  // The engines folder (native): pointing it at one that already holds htdemucs adopts those files — nothing
  // is copied, and the 166 MB download is skipped.
  const chooseModelsDir = async () => {
    setErr(e => ({ ...e, stems: undefined })); setStemsNote(null);
    const r = await bridge?.stemsChooseModelsDir?.();
    if (r?.cancelled) return;
    if (r?.error) setErr(e => ({ ...e, stems: r.error }));
    else setStemsNote('Engines folder changed — engines already in there are used as they are; anything missing downloads on the next split.');
    void refresh();
  };
  const resetModelsDir = async () => {
    setErr(e => ({ ...e, stems: undefined })); setStemsNote(null);
    const r = await bridge?.stemsResetModelsDir?.();
    if (r?.error) setErr(e => ({ ...e, stems: r.error }));
    else setStemsNote('Back to the standard engines folder — the files where you pointed it are left alone.');
    void refresh();
  };
  const toggleStemPlanes = async () => {
    const next = !stemPlanes;
    setStemPlanes(next); setStemsNote(null);
    await bridge?.setSettings?.({ stemsPlanes: next });
    setStemsNote(next
      ? 'Pads will read their stems straight from the engine — split a song again for it to take effect on that song.'
      : 'Back to the normal path: Terminator mixes each pad’s stems itself.');
  };
  const clearStemAudio = async () => {
    setConfirmClear(null); setErr(e => ({ ...e, stems: undefined }));
    const r = await bridge?.stemsClearAudio?.();
    if (r && !r.ok) setErr(e => ({ ...e, stems: r.error ?? 'could not clear' }));
    else setStemsNote(`Cleared ${fmtBytes(r?.bytes ?? 0)} of stem audio — every song will split fresh again; saved projects keep their layer choices.`);
    void refresh();
  };
  const deleteSongStems = async (title: string) => {
    setConfirmClear(null); setErr(e => ({ ...e, stems: undefined }));
    const r = await bridge?.stemsDeleteSongStems?.(title);
    if (r && !r.ok) setErr(e => ({ ...e, stems: r.error ?? 'could not delete' }));
    else setStemsNote(`Deleted the stems for “${title}” (${fmtBytes(r?.bytes ?? 0)}) — Terminator forgets this song, so it splits fresh next time; projects keep their layer choices.`);
    void refresh();
  };

  const changeLibrary = async (mode: 'move' | 'point') => {
    setLibChoice(false); setErr(e => ({ ...e, library: undefined })); setNote(null);
    if (mode === 'move') setMoving({ done: 0, total: 0 });
    const res = await bridge?.chooseLibraryRoot?.(mode);
    setMoving(null);
    if (!res) return;
    if (res.error) setErr(e => ({ ...e, library: res.error }));
    else if (res.ok && mode === 'move' && res.oldRoot) setNote(`Moved ${res.moved ?? 0} file${res.moved === 1 ? '' : 's'}. The old folder was kept at ${res.oldRoot} — delete it in Finder once you've checked everything is here.`);
    setLibraryDir({ path: res.path, isDefault: res.isDefault });
  };

  return (
    <>
      <FolderRow
        title="Projects"
        desc="Where SAVE PROJECT writes your .tproj / .tprojz files. Same setting as OPEN… → Local → CHANGE FOLDER. Changing it points new saves there — projects already in the old folder stay put."
        info={projects}
        size={sizeOf('projects')}
        error={err.projects}
        buttons={[
          { label: 'CHANGE…', title: 'Pick a new projects folder (a cloud-synced folder or an external drive works)', onClick: () => void bridge?.chooseProjectsDir?.().then(r => { if (r?.error) setErr(e => ({ ...e, projects: r.error })); else { setErr(e => ({ ...e, projects: undefined })); setProjects({ path: r.path, isDefault: r.isDefault }); } }) },
          { label: 'USE DEFAULT', title: 'Back to the standard app-data folder', disabled: projects?.isDefault, onClick: () => void bridge?.resetProjectsDir?.().then(r => r && setProjects({ path: r.path, isDefault: r.isDefault })) },
          { label: 'OPEN', title: 'Show this folder in Finder / Explorer', onClick: () => void bridge?.revealProjectsDir?.() },
        ]}
      />
      <FolderRow
        title="Sample Library"
        desc="Home of your recordings, YouTube imports, downloaded playlists and YOUR OWN samples (Recordings / YouTube / Imports / User Samples / Drums). MOVE copies the whole library and its index to the new folder — the old one is kept as a backup. POINT just uses a folder as-is (an existing library there is adopted; an empty one starts fresh). To browse a sample library you keep elsewhere WITHOUT moving it, use ＋ LINK FOLDER in the sample browser."
        info={libraryDir}
        size={sizeOf('library')}
        busy={!!moving}
        error={err.library}
        note={moving ? (moving.total ? `Moving ${moving.done} / ${moving.total}…` : 'Moving…') : note}
        buttons={libChoice ? [
          { label: 'MOVE LIBRARY THERE', title: 'Copy your library files + index to the folder you pick (recommended)', onClick: () => void changeLibrary('move') },
          { label: 'JUST POINT', title: 'Use the folder you pick as-is — no files are copied', onClick: () => void changeLibrary('point') },
          { label: 'CANCEL', title: 'Never mind', onClick: () => setLibChoice(false) },
        ] : [
          { label: 'CHANGE…', title: 'Move the library, or point at another one', onClick: () => setLibChoice(true) },
          { label: 'USE DEFAULT', title: 'Back to the Music folder (files stay where they are)', disabled: libraryDir?.isDefault, onClick: () => void bridge?.resetLibraryRoot?.().then(r => r && setLibraryDir({ path: r.path, isDefault: r.isDefault })) },
          { label: 'OPEN', title: 'Show this folder in Finder / Explorer', onClick: () => void bridge?.revealLibraryRoot?.() },
        ]}
      />
      {libraryDir && bridge?.libraryReveal && (
        <FolderRow
          title="User Samples"
          desc="Your own samples — the USER SAMPLES folder in the sample browser IS this folder. Drop files or whole folders in here (Finder or the browser), make sub-folders, move, rename, delete: it all happens on disk, and the browser shows it live. Lives inside the Sample Library, so it moves with it."
          info={{ path: `${libraryDir.path}${libraryDir.path.includes('\\') ? '\\' : '/'}User Samples`, isDefault: libraryDir.isDefault }}
          buttons={[
            { label: 'OPEN', title: 'Show your samples folder in Finder / Explorer', onClick: () => void bridge?.libraryReveal?.('user') },
          ]}
        />
      )}
      {bridge?.drumsUserDir && (
        <FolderRow
          title="Drums"
          desc={`Your OWN drum one-shots — drop files (and sub-folders) in here and they show up under MY DRUMS in the drum browser, ready to LOAD onto any lane or ADD as a new one. It lives inside the Sample Library folder, so it moves with it. The built-in KCC kit (${sizeOf('drumsBundled') ?? '…'}) ships inside the app itself — it is not in this folder and cannot be deleted.`}
          info={drumsDir}
          size={sizeOf('drums')}
          note={drumsNote}
          error={err.drums}
          buttons={drumsConfirm ? [
            { label: 'EMPTY — SURE?', title: 'Move everything in your drums folder to the Trash (nothing is deleted for real; projects that used those sounds show MISSING on that lane)', onClick: () => { setDrumsConfirm(false); void bridge?.drumsUserEmpty?.().then(r => { if (r && !r.ok) setErr(e => ({ ...e, drums: r.error ?? 'could not empty' })); else setDrumsNote(`Moved ${r?.moved ?? 0} item${(r?.moved ?? 0) === 1 ? '' : 's'} to the Trash.`); void refresh(); }); } },
            { label: 'CANCEL', title: 'Keep everything', onClick: () => setDrumsConfirm(false) },
          ] : [
            { label: 'OPEN', title: 'Show your drums folder in Finder / Explorer — drop your one-shots in here', onClick: () => void bridge?.drumsUserReveal?.() },
            { label: 'EMPTY…', title: 'Move every file in your drums folder to the Trash (asks first)', disabled: !sizes?.drums?.bytes, onClick: () => setDrumsConfirm(true) },
          ]}
        />
      )}
      <FolderRow
        title="YouTube"
        desc="Every YouTube pull — the URL bar, a link on a pad, a playlist — lands here as a real file (your Sample Library → YouTube), so you can see it in the sample browser and load it again later without downloading. It moves with the library (SAMPLE LIBRARY above)."
        info={cache}
        size={sizeOf('cache')}
        error={err.cache}
        buttons={[
          { label: 'OPEN', title: 'Show the YouTube folder in Finder / Explorer', onClick: () => void bridge?.revealCacheDir?.() },
        ]}
      />
      {bridge?.stemsUsage && (
        <div style={card}>
          <label style={label}>
            Stems
            <span style={{ float: 'right', color: 'var(--neon)', textTransform: 'none', letterSpacing: 0 }}
              title="Everything stem separation keeps on disk: the engines plus every split song's saved stem audio">
              {stems ? fmtBytes(stems.models.reduce((n, m) => n + m.bytes, 0) + stems.audio.bytes) : '…'}
            </span>
          </label>
          <div style={hint}>
            The split engines (downloaded once on first use, then yours offline) and the stem audio of every split song (kept in the app's project store so a saved project reloads its stems instantly). Deleting either is safe — an engine re-downloads on the next split, and cleared songs keep their layer choices and simply re-split when opened.
          </div>
          <div style={{ ...pathStyle, marginTop: 8 }} title={stems?.modelsDir ?? ''}>{stems ? `‎${stems.modelsDir}` : '…'}</div>
          {bridge?.stemsChooseModelsDir && (
            <div style={{ ...btnRow, marginTop: 6 }}>
              <button style={btnSm}
                title="Keep the engines somewhere else — an external drive, or a folder that already holds them (Terminator uses what is already in there instead of downloading it again). Nothing is copied or moved."
                onClick={() => void chooseModelsDir()}>CHANGE…</button>
              <button style={btnSm} disabled={modelsDirDefault}
                title="Back to the standard engines folder (the files where you pointed it are left where they are)"
                onClick={() => void resetModelsDir()}>USE DEFAULT</button>
            </div>
          )}
          {(['fast', 'fine'] as const).map(q => {
            const m = stems?.models.find(x => x.quality === q);
            const pct = dl[q];
            const busy = pct !== undefined || !!m?.downloading;
            const expected = m?.expectedBytes ? ` (${fmtBytes(m.expectedBytes)})` : '';
            return (
              <div key={q} style={toggleRow}>
                <span>
                  {q === 'fast' ? 'FAST engine' : 'FINE engine'} — {m ? (busy ? `downloading ${pct ?? 0}%` : m.bytes ? `${fmtBytes(m.bytes)}${m.ready ? '' : ' (partial)'}` : `not downloaded${expected}`) : '…'}
                </span>
                {!m?.ready && !busy ? (
                  <button style={btnSm} disabled={!bridge?.stemsDownloadModels}
                    title={`Download this engine now${expected} so your first ${q.toUpperCase()} split starts immediately instead of waiting for the download. It is kept on this computer; DELETE frees the space again.`}
                    onClick={() => void downloadEngine(q)}>⇣ DOWNLOAD</button>
                ) : busy ? (
                  <button style={btnSm} disabled title="Downloading — the split button in the chopper shows the same progress">⇣ {pct ?? 0}%</button>
                ) : confirmClear === q ? (
                  <span style={{ display: 'flex', gap: 6 }}>
                    <button style={btnSm} title="Yes — free the space" onClick={() => void deleteEngine(q)}>DELETE — SURE?</button>
                    <button style={btnSm} title="Keep it" onClick={() => setConfirmClear(null)}>CANCEL</button>
                  </span>
                ) : (
                  <button style={btnSm} disabled={!m?.bytes}
                    title="Delete this engine's files — the next split at this quality downloads them again"
                    onClick={() => setConfirmClear(q)}>DELETE</button>
                )}
              </div>
            );
          })}
          <div style={toggleRow}>
            <span>
              Stem audio — {stems ? (stems.audio.count ? `${stems.songs?.length ?? 0} song${(stems.songs?.length ?? 0) === 1 ? '' : 's'}, ${fmtBytes(stems.audio.bytes)}` : 'none saved') : '…'}
            </span>
            {confirmClear === 'audio' ? (
              <span style={{ display: 'flex', gap: 6 }}>
                <button style={btnSm} title="Yes — projects keep their layer choices and re-split when opened" onClick={() => void clearStemAudio()}>CLEAR ALL — SURE?</button>
                <button style={btnSm} title="Keep it" onClick={() => setConfirmClear(null)}>CANCEL</button>
              </span>
            ) : (
              <button style={btnSm} disabled={!stems?.audio.count}
                title="Delete every saved song's stem audio — safe: layer choices stay in the projects, which re-split on open"
                onClick={() => setConfirmClear('audio')}>CLEAR ALL</button>
            )}
          </div>
          {(stems?.songs ?? []).map((s, i, arr) => (
            <div key={s.title} style={{ ...toggleRow, ...(i === arr.length - 1 ? { borderBottom: 'none' } : {}), paddingLeft: 20 }}>
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={`${s.title} — ${s.files} stem file${s.files === 1 ? '' : 's'}`}>
                {s.title} — {fmtBytes(s.bytes)}
              </span>
              {confirmClear === `song:${s.title}` ? (
                <span style={{ display: 'flex', gap: 6, flex: '0 0 auto' }}>
                  <button style={btnSm} title="Yes — Terminator forgets this song and splits it fresh next time; its project keeps the layer choices" onClick={() => void deleteSongStems(s.title)}>DELETE — SURE?</button>
                  <button style={btnSm} title="Keep it" onClick={() => setConfirmClear(null)}>CANCEL</button>
                </span>
              ) : (
                <button style={{ ...btnSm, flex: '0 0 auto' }}
                  title="Delete just this song's saved stems — safe: the song simply splits fresh next time, and its project keeps the layer choices"
                  onClick={() => setConfirmClear(`song:${s.title}`)}>DELETE</button>
              )}
            </div>
          ))}
          {bridge?.stemsChooseModelsDir && (
            <div style={toggleRow}>
              <span title="EXPERIMENTAL. Normally Terminator mixes a pad's chosen stems into a new piece of audio and hands it to the engine — one for every different combination. With this on, the engine keeps the four layers itself and sums the lit ones as the pad plays: much less memory on a long song, and switching layers is instant. Split a song again after turning it on. Turn it off and everything works exactly as before.">
                Play stems from the engine (experimental)
              </span>
              <button style={btnSm} title={stemPlanes ? 'Back to the normal path' : 'Let the engine hold the layers'} onClick={() => void toggleStemPlanes()}>
                {stemPlanes ? 'ON' : 'OFF'}
              </button>
            </div>
          )}
          <div style={btnRow}>
            <button style={btnSm} title="Show the engines folder in Finder / Explorer" onClick={() => void bridge?.stemsRevealModels?.()}>OPEN ENGINES</button>
            <button style={btnSm}
              title="Show the audio store in Finder / Explorer. Careful in there: files are named by content hash and PROJECT SAMPLES live in the same folder — use the DELETE buttons above to remove a song's stems safely"
              onClick={() => void bridge?.stemsRevealAudio?.()}>OPEN STEM AUDIO</button>
          </div>
          {stemsNote && <div style={{ ...hint, color: 'var(--neon)' }}>{stemsNote}</div>}
          {err.stems && <div style={{ ...hint, color: '#ff5f56' }}>{err.stems}</div>}
        </div>
      )}
      <div style={hint}>
        Project samples themselves live in the app's own store so every project can always find them — the cache folder above is the knob for putting big audio on another drive.
      </div>
    </>
  );
}

function PreferencesApp() {
  const [tab, setTab] = useState<'audio' | 'midi' | 'plugins' | 'folders'>('audio');
  const [audio, setAudio] = useState<AudioPrefs>(DEFAULT_AUDIO);
  const [midi, setMidi] = useState<MidiPrefs>(DEFAULT_MIDI);
  const [outputs, setOutputs] = useState<MediaDeviceInfo[]>([]);
  const [inputs, setInputs] = useState<MediaDeviceInfo[]>([]);
  const [midiInputs, setMidiInputs] = useState<Array<{ id: string; name: string }>>([]);
  const [midiOutputs, setMidiOutputs] = useState<Array<{ id: string; name: string }>>([]);
  const [loaded, setLoaded] = useState(false);
  const [systemRate] = useState<number | null>(() => systemSampleRate());

  // Load persisted settings once.
  useEffect(() => {
    (async () => {
      try {
        const s = await bridge?.getSettings?.();
        if (s?.audio) {
          const a = s.audio;
          // Only the honest keys — the legacy bufferSize/sampleRate values
          // were never applied to anything and must not resurface.
          setAudio({
            ...DEFAULT_AUDIO,
            bufferFrames: BUFFER_SIZES.includes(a.bufferFrames) ? a.bufferFrames : 0,
            sampleRateHz: SAMPLE_RATES.includes(a.sampleRateHz) ? a.sampleRateHz : 0,
            ppq: typeof a.ppq === 'number' ? a.ppq : DEFAULT_AUDIO.ppq,
            outputDeviceId: typeof a.outputDeviceId === 'string' ? a.outputDeviceId : '',
            inputDeviceId: typeof a.inputDeviceId === 'string' ? a.inputDeviceId : '',
          });
        }
        if (s?.midi) setMidi({ ...DEFAULT_MIDI, ...s.midi });
      } catch { /* defaults */ }
      setLoaded(true);
    })();
  }, []);

  // Persist whenever a section changes (after the initial load, so we don't
  // immediately re-write the just-loaded values).
  useEffect(() => { if (loaded) void bridge?.setSettings?.({ audio }); }, [audio, loaded]);
  useEffect(() => { if (loaded) void bridge?.setSettings?.({ midi }); }, [midi, loaded]);

  // ── audio device enumeration (WEB / Electron only) ─────────────────────────
  // Natively the audio tab is NativeAudioPane and the device lists come from the C++ AudioIO — these `outputs` /
  // `inputs` are never rendered there. Running it anyway asked WKWebView for the microphone (getUserMedia) on mount
  // and again on every `devicechange`, and that permission is not persisted in the WebView: opening Preferences
  // popped the macOS mic prompt several times for a list nothing reads. Native skips the whole path.
  const refreshAudioDevices = useCallback(async () => {
    if (isNative()) return;
    try {
      // Unlock device labels by briefly requesting mic access (best effort).
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        stream.getTracks().forEach(t => t.stop());
      } catch { /* labels may be blank without permission */ }
      const devs = await navigator.mediaDevices.enumerateDevices();
      setOutputs(devs.filter(d => d.kind === 'audiooutput'));
      setInputs(devs.filter(d => d.kind === 'audioinput'));
    } catch { /* enumeration unavailable */ }
  }, []);

  useEffect(() => {
    if (isNative()) return;
    void refreshAudioDevices();
    const handler = () => void refreshAudioDevices();
    navigator.mediaDevices?.addEventListener?.('devicechange', handler);
    return () => navigator.mediaDevices?.removeEventListener?.('devicechange', handler);
  }, [refreshAudioDevices]);

  // ── MIDI device enumeration (WEB / Electron only) ──────────────────────────
  // Same story: natively the MIDI tab is NativeMidiPane (CoreMIDI through the shell), so asking the WebView for Web
  // MIDI access only costs another permission prompt for a list nothing renders.
  const refreshMidiDevices = useCallback(async () => {
    if (isNative()) return;
    try {
      const access = await (navigator as any).requestMIDIAccess?.({ sysex: false });
      if (!access) return;
      const ins: Array<{ id: string; name: string }> = [];
      const outs: Array<{ id: string; name: string }> = [];
      access.inputs.forEach((p: any) => ins.push({ id: p.id, name: p.name || p.id }));
      access.outputs.forEach((p: any) => outs.push({ id: p.id, name: p.name || p.id }));
      setMidiInputs(ins);
      setMidiOutputs(outs);
    } catch { /* Web MIDI unavailable */ }
  }, []);

  useEffect(() => { void refreshMidiDevices(); }, [refreshMidiDevices]);

  // A MIDI device defaults to ENABLED unless explicitly turned off.
  const isMidiOn = (kind: 'inputs' | 'outputs', id: string) => midi[kind][id] !== false;
  const setMidiOn = (kind: 'inputs' | 'outputs', id: string, on: boolean) =>
    setMidi(m => ({ ...m, [kind]: { ...m[kind], [id]: on } }));

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      {/* Title bar / tabs */}
      <div style={{ display: 'flex', borderBottom: '1px solid var(--border)', background: 'var(--bg2)' }}>
        {(isNative()
          ? (['audio', 'midi', 'plugins', 'folders'] as const)
          : (['audio', 'midi', 'folders'] as const)
        ).map(t => (
          <button
            key={t}
            onClick={() => setTab(t)}
            style={{
              flex: 1, padding: '12px 0', background: tab === t ? 'var(--bg)' : 'transparent',
              color: tab === t ? 'var(--neon)' : 'var(--text-dim)', border: 'none',
              borderBottom: tab === t ? '2px solid var(--neon)' : '2px solid transparent',
              cursor: 'pointer', fontFamily: 'inherit', fontSize: 13, letterSpacing: 2, textTransform: 'uppercase',
            }}
          >
            {t}
          </button>
        ))}
      </div>

      {/* Body */}
      <div style={{ flex: 1, overflowY: 'auto', padding: 14 }}>
        {tab === 'plugins' && isNative() && <NativePluginsPane />}
        {tab === 'audio' && isNative() && (
          <>
            <NativeAudioPane />
            <div style={card}>
              <div style={{ ...row, marginBottom: 0 }}>
                <label style={label}>Sequencer Resolution (PPQ)</label>
                <select
                  style={selectStyle}
                  value={audio.ppq}
                  onChange={e => setAudio(a => ({ ...a, ppq: Number(e.target.value) }))}
                >
                  {PPQ_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.value} PPQ — {o.desc}</option>)}
                </select>
                <div style={hint}>{PPQ_OPTIONS.find(o => o.value === audio.ppq)?.desc ?? ''}</div>
              </div>
            </div>
          </>
        )}
        {tab === 'audio' && !isNative() && (
          <>
            <div style={card}>
              <div style={row}>
                <label style={label}>Buffer Size</label>
                <select
                  style={selectStyle}
                  value={audio.bufferFrames}
                  onChange={e => setAudio(a => ({ ...a, bufferFrames: Number(e.target.value) }))}
                >
                  <option value={0}>Auto — smallest the system allows (recommended)</option>
                  {BUFFER_SIZES.map(b => <option key={b} value={b}>{b} samples (~{(b / 48000 * 1000).toFixed(1)} ms)</option>)}
                </select>
                <div style={hint}>The latency knob: smaller = tighter pad feel, bigger = safer on a struggling machine. Applied when Terminator next launches.</div>
              </div>
              <div style={row}>
                <label style={label}>Sample Rate</label>
                <select
                  style={selectStyle}
                  value={audio.sampleRateHz}
                  onChange={e => setAudio(a => ({ ...a, sampleRateHz: Number(e.target.value) }))}
                >
                  <option value={0}>Auto — system rate{systemRate ? ` (${systemRate} Hz)` : ''}</option>
                  {SAMPLE_RATES.map(r => <option key={r} value={r}>{r} Hz</option>)}
                </select>
                <div style={hint}>Barely affects latency — pick 44100 to match Terminator's sample library and the STEMS engine, or Auto to run at the hardware rate with no resampling. Applied when Terminator next launches.</div>
              </div>
              <div style={{ ...row, marginBottom: 0 }}>
                <label style={label}>Sequencer Resolution (PPQ)</label>
                <select
                  style={selectStyle}
                  value={audio.ppq}
                  onChange={e => setAudio(a => ({ ...a, ppq: Number(e.target.value) }))}
                >
                  {PPQ_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.value} PPQ — {o.desc}</option>)}
                </select>
                <div style={hint}>{PPQ_OPTIONS.find(o => o.value === audio.ppq)?.desc ?? ''}</div>
              </div>
            </div>

            <div style={card}>
              <div style={row}>
                <label style={label}>Output Device</label>
                <select
                  style={selectStyle}
                  value={audio.outputDeviceId}
                  onChange={e => setAudio(a => ({ ...a, outputDeviceId: e.target.value }))}
                >
                  <option value="">System Default</option>
                  {outputs.map(d => <option key={d.deviceId} value={d.deviceId}>{d.label || `Output ${d.deviceId.slice(0, 6)}`}</option>)}
                </select>
              </div>
              <div style={row}>
                <label style={label}>Input Device</label>
                <select
                  style={selectStyle}
                  value={audio.inputDeviceId}
                  onChange={e => setAudio(a => ({ ...a, inputDeviceId: e.target.value }))}
                >
                  <option value="">System Default</option>
                  {inputs.map(d => <option key={d.deviceId} value={d.deviceId}>{d.label || `Input ${d.deviceId.slice(0, 6)}`}</option>)}
                </select>
              </div>
              <button style={btn} onClick={() => void refreshAudioDevices()}>Refresh Devices</button>
            </div>
          </>
        )}

        {tab === 'midi' && (
          <>
            {isNative() && <NativeMidiPane />}
            {!isNative() && (<>
            <div style={card}>
              <label style={label}>MIDI Inputs</label>
              {midiInputs.length === 0 && <div style={{ color: 'var(--text-dim)', padding: '6px 0' }}>No MIDI inputs connected</div>}
              {midiInputs.map(d => (
                <div key={d.id} style={toggleRow}>
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{d.name}</span>
                  <Toggle on={isMidiOn('inputs', d.id)} onChange={v => setMidiOn('inputs', d.id, v)} />
                </div>
              ))}
            </div>

            <div style={card}>
              <label style={label}>MIDI Outputs</label>
              {midiOutputs.length === 0 && <div style={{ color: 'var(--text-dim)', padding: '6px 0' }}>No MIDI outputs connected</div>}
              {midiOutputs.map(d => (
                <div key={d.id} style={toggleRow}>
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{d.name}</span>
                  <Toggle on={isMidiOn('outputs', d.id)} onChange={v => setMidiOn('outputs', d.id, v)} />
                </div>
              ))}
            </div>
            </>)}

            <div style={card}>
              <div style={{ ...toggleRow, borderBottom: 'none' }} title="Send MIDI Clock from Terminator's transport: PLAY sends Song Position 0 + START and then 24 ticks per quarter note at the session tempo, STOP sends STOP — to every MIDI output left ON above. Your drum machine / DAW set to external sync locks to Terminator's grid (the same anchor the drums and bass play from).">
                <span>MIDI Clock (send)</span>
                <Toggle on={midi.clock} onChange={v => setMidi(m => ({ ...m, clock: v }))} />
              </div>
              <div style={{ ...toggleRow, borderBottom: 'none' }} title="When your MPC / drum machine / DAW sends MIDI clock, its PLAY and STOP always start and stop Terminator — nothing to switch on. Turn THIS on and Terminator also follows its TEMPO from the clock ticks while it is driving (the BPM readout moves to match within a beat, so the two stay locked instead of drifting). Off = Terminator keeps its own BPM and just starts and stops with the hardware. Only the port that pressed PLAY is listened to, so a device that shows up as two MIDI ports cannot double the tempo.">
                <span>MIDI Clock (follow tempo)</span>
                <Toggle on={!!midi.clockFollow} onChange={v => setMidi(m => ({ ...m, clockFollow: v }))} />
              </div>
              <div style={{ ...row, marginTop: 8 }}>
                <label style={label}>MIDI Channel</label>
                <select
                  style={selectStyle}
                  value={midi.channel}
                  onChange={e => setMidi(m => ({ ...m, channel: Number(e.target.value) }))}
                >
                  {Array.from({ length: 16 }, (_, i) => i + 1).map(c => <option key={c} value={c}>{c}</option>)}
                </select>
              </div>
            </div>

            {!isNative() && <button style={btn} onClick={() => void refreshMidiDevices()}>Refresh Devices</button>}
          </>
        )}

        {tab === 'folders' && <FoldersPane />}
      </div>
    </div>
  );
}

// Self-mount: this module is the entry point for preferences.html.
const rootEl = document.getElementById('root');
if (rootEl) createRoot(rootEl).render(<PreferencesApp />);

export default PreferencesApp;
