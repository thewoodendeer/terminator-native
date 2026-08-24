import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, CSSProperties, ReactNode, PointerEvent as ReactPointerEvent } from 'react';
import { createPortal } from 'react-dom';
import { isSubscribed, isSignedIn, isDemo, recordPull, pullsRemaining, FREE_PAD_LIMIT, goToDesktopDownload } from '../lib/subscription';
import { SubscribeModal } from '../components/SubscribeModal';
import { ChopperEngine, ChopperState, ChopPreset, MetronomeSound, SEQ_MAX_STEPS, NO_SAMPLE_ID } from './ChopperEngine';
import { attachNativeEngineShadow } from '../native/nativeEngineShadow';
import { isNative, onNativeEvent } from '../native/juceBridge';

const isWeb = (import.meta as any).env?.MODE === 'web';
declare const __TERMINATOR_VERSION__: string;
const isWebUI = true; // Electron desktop mirrors web desktop UI exactly
// iOS resets the embedded tab when the export share sheet backgrounds it
// (WebKit reload-on-foreground). We snapshot the full session under this key
// just before export and restore it on the next load. See snapshotSessionForExport.
const SNAPSHOT_KEY = 'terminator_session_snapshot';
// Crash-recovery autosave: a time-stamped FULL session preset written every 30 s
// (and on tab-hide), so the next load can offer to restore it after a WKWebView
// tab-kill. Distinct from SNAPSHOT_KEY (export-reset only); this survives ANY crash.
const AUTOSAVE_KEY = 'terminator_autosave';
const AUTOSAVE_MAX_AGE_MS = 2 * 60 * 60 * 1000; // 2 hours
// RECORD SAMPLE: persisted choice of recording input (mic/interface device id
// or desktop-capture source id).
const RECORD_INPUT_KEY = 'terminator_record_input';
// Sentinel input id for the "System Audio (what's playing)" choice — captured via
// getDisplayMedia + the main-process setDisplayMediaRequestHandler loopback, not
// a real device id.
const SYSTEM_AUDIO_ID = '__system_audio_loopback__';
/** RECORD SAMPLE input that is Terminator's OWN OUTPUT — the final mix, tapped
 *  right before the speakers (his ask 2026-08-22: "hit record, hit some pads,
 *  and it records that as a new sample"). A MediaStreamDestination on the
 *  master node feeds the same MediaRecorder path as a mic; it never goes back
 *  to the speakers, so there is no feedback. */
const INTERNAL_OUTPUT_ID = '__terminator_output__';
// Platform check for the renderer. `process` is unavailable here (contextIsolation
// + sandbox), so detect macOS via navigator. System-audio loopback is Windows-only.
const IS_MAC = typeof navigator !== 'undefined'
  && /Mac/i.test((navigator as any).userAgentData?.platform || navigator.platform || navigator.userAgent);
import { PadGrid, sourceColor } from './PadGrid';
import { usePadSelection, copyPads, cutPads, pastePads, clearPads, duplicatePads, isPadEmpty, PAD_GRID_MAX } from './padClipboard';
import { StemsController, stemsAvailable, lastQuality, StemsQuality, StemsUiState, MAIN_TARGET, type StemsTarget, type Span } from './stemsController';
import { FaderBubble } from './FaderBubble';
import { useFaderTooltip } from './useFaderTooltip';
import { STEM_ORDER, StemName, stemBit, maskHas, toggleStem, MASK_ALL } from './stemMask';
import { usePadActivity } from './usePadActivity';
import { WaveformView } from './WaveformView';
import { FXKnob } from './MasterFXPanel';
import { MixerEngine, ChannelName, DEFAULT_REGULAR_CHANNELS, SEND_CHANNELS, REGULAR_CHANNELS } from '../../mixer/MixerEngine';
import { MixerSection } from '../../mixer/MixerSection';
import { useKeepOnScreen } from '../hooks/useKeepOnScreen';
import { midiLearn as midiCc } from './midiLearn';
import { midiMapStore, MidiMapTarget } from './MidiMap';
import { Timeline } from './Timeline';
import { EXPORT_FORMATS, ExportFormat } from './exporters/formats';
import ExportModal from './ExportModal';
// Static import (not a dynamic import()): bundling the exporters into the main
// chunk means there's no separate hashed module to fetch at export time. A
// stale cached shell on mobile Safari can't 404 a deleted chunk → no more
// "importing a module script failed" on export.
import { runExport, FLAC_CAPABLE } from './exporters';
import { encodeWAV } from '../audio/StemExporter';
import { isIOS } from '../lib/download';
import { DrumEngine, TrackKey } from '../drums/DrumEngine';
import { DrumSection } from '../drums/DrumSection';
import { BassEngine, bassSeqForSection } from '../bass/BassEngine';
import { BassSection } from '../bass/BassSection';
import { applyTheme, getStoredTheme, syncFinishAttrs, getFinish, applyFinish, getDust, applyDust, METAL_THEMES, type ThemeId, type Finish } from '../themes';
import { ThemeMenu, type ThemeKind } from './ThemeMenu';
import { getUiMode, autoWantsMobile, switchUiMode } from './uiMode';
import { MidiClockSender } from './midiClockOut';
import { MidiClockFollower, MidiClockSourceLock } from './midiClockIn';
import { midiHub } from './midiHub';
import { assetStore, ASSET_PREFIX, assetHash, buildProjectBundle, unpackProjectBundle, projectNeedsBundle, missingAssets, withAssetManifest, looksLikeProjectFile, BUNDLE_WARN_BYTES } from './projectAssets';
import { encodeFlac16 } from '../audio/flacEncode';
import { recordAudioConstraints, describeRecordTrack } from './recordConstraints';
import { MidiStatusPill } from './MidiStatus';
import { HW_PALETTES, paletteById, type HwPalette } from './hwPalettes';
import { ArrangerPreview } from '../arranger/ArrangerPreview';
import { buildArrangerPayload } from '../arranger/payload';
import { Arrangement } from '../arranger/types';
import FinishHimPortal, { PortalTheme, FinishSuggestion, FinishArrangementSection, defaultFinishSections } from '../finishhim/FinishHimPortal';
import SampleBrowser, { BrowserEntry } from './SampleBrowser';
import OpenProjectModal from './OpenProjectModal';
import { TransferModal } from './transfer/TransferModal';
import { EulaModal } from './EulaModal';
import { SignInModal } from './SignInModal';
import { refreshLicense, getLicense, signOutDesktop, onAuthSignedIn } from '../lib/desktopAuth';
import { r2AudioUrl, loadManifest, listPlaylistsForRenderer, fetchR2Audio, looksLikeR2Id } from '../r2';
import { libraryBridgeFromWindow, libFileUrl, LIB_ID_PREFIX } from './libraryBridge';
import { useIsPhone } from '../lib/useIsPhone';
import { HardwareView } from './HardwareView';
import { HelpModal, TipLayer, readTipsEnabled, writeTipsEnabled } from './Help';
import { MidiLatencyMeter } from './MidiLatencyMeter';
import { MPC_PAD_BASE_NOTE } from './midiPads';

const ipc = (window as any).terminator as {
  listPlaylists: () => Promise<Array<{ name: string; entries: Array<{ id: string; title: string; duration?: number }> }>>;
  downloadYouTube: (idOrUrl: string) => Promise<{ ok: boolean; audio?: ArrayBuffer; cacheUrl?: string; title?: string; durationSec?: number; videoId?: string; error?: string }>;
  exportStem: (p: { name: string; data: ArrayBuffer }) => Promise<any>;
  exportAllStems: (stems: Array<{ name: string; data: ArrayBuffer }>, folderName?: string) => Promise<any>;
  exportToMpc: (stems: Array<{ name: string; data: ArrayBuffer }>, folderName?: string) => Promise<{ savedTo?: string; saved?: string[]; error?: string }>;
  ejectMpc: () => Promise<{ ok?: true; error?: string }>;
  onMpcStatus: (handler: (mountpoint: string | null) => void) => () => void;
  getCacheStatus: (playlistName: string) => Promise<{ cached: number; total: number; sizeMB: number; estimatedMB: number }>;
  downloadPlaylist: (playlistName: string) => Promise<{ ok: boolean; done: number; errors: number }>;
  deletePlaylistCache: (playlistName: string) => Promise<{ deleted: number }>;
  onCacheProgress: (handler: (p: { playlistName: string; done: number; total: number; currentTitle: string; active: string[] }) => void) => () => void;
  savePreset: (preset: ChopPreset) => Promise<{ ok: boolean }>;
  loadPreset: (videoId: string) => Promise<ChopPreset | null>;
  saveSession: (session: ChopPreset) => Promise<{ ok: boolean }>;
  loadSession: () => Promise<ChopPreset | null>;
  listNamedPresets: () => Promise<Array<{ name: string; trackTitle?: string; savedAt: string; videoId: string }>>;
  saveNamedPreset: (name: string, preset: ChopPreset) => Promise<{ ok: boolean }>;
  loadNamedPreset: (name: string) => Promise<ChopPreset | null>;
  deleteNamedPreset: (name: string) => Promise<{ ok: boolean }>;
  getCacheDir: () => Promise<string>;
  setCacheDir: () => Promise<{ ok?: boolean; cacheDir?: string; cancelled?: boolean }>;
  revealCacheDir?: () => Promise<{ ok?: boolean; error?: string }>;
  getDesktopSources: () => Promise<{ needsPermission: boolean; sources: Array<{ id: string; name: string }> }>;
  openExternal: (url: string) => Promise<void>;
  enableLoopback: () => Promise<void>;
  disableLoopback: () => Promise<void>;
  // User playlists + recordings (added for the browser folders + RECORD SAMPLE)
  getUserPlaylists: () => Promise<Array<{ id: string; name: string; url: string; type: 'playlist' | 'single'; tracks: Array<{ videoId: string; title: string }> }>>;
  addUserPlaylist: (p: { name: string; url: string }) => Promise<{ id: string; name: string; url: string; type: 'playlist' | 'single'; tracks: Array<{ videoId: string; title: string }> } | { error: string }>;
  removeUserPlaylist: (id: string) => Promise<{ ok?: boolean; error?: string }>;
  saveUserSample: (p: { filename: string; data: ArrayBuffer }) => Promise<{ path: string; filename: string } | { error: string }>;
  listUserSamples: () => Promise<Array<{ filename: string; size: number; createdAt: number }>>;
  deleteUserSample: (filename: string) => Promise<{ ok?: boolean; error?: string }>;
  loadUserSample: (filename: string) => Promise<ArrayBuffer | null>;
  // Native Edit-menu shortcuts (desktop). The renderer subscribes to these so
  // the menu can drive in-app actions. Optional so older preload bundles / the
  // web build (no bridge) don't break.
  onShortcut?: (key: 'playStop' | 'savePreset' | 'export' | 'rearrange' | 'resetLayout' | 'new' | 'open' | 'saveAs', handler: () => void) => () => void;
  // Re-arrange layout persistence (Electron only — JSON file in the app data
  // dir). Optional for the same forward/back-compat reason.
  saveLayout?: (layout: Record<string, { x: number; y: number }>) => Promise<{ ok: boolean }>;
  loadLayout?: () => Promise<Record<string, { x: number; y: number }> | null>;
  // File menu: Recent Projects (Electron only). The renderer reports a load so
  // it shows in File → Recent Projects; onLoadRecent fires when the user picks
  // one. Optional so the web build / older preload bundles don't break.
  addRecentProject?: (entry: { name: string; id: string }) => Promise<Array<{ name: string; id: string; loadedAt: number }>>;
  removeRecentProject?: (id: string) => Promise<Array<{ name: string; id: string; loadedAt: number }>>;
  onLoadRecent?: (handler: (id: string) => void) => () => void;
  // App settings (Preferences window). The main window reads them on mount and
  // reacts to live changes so audio prefs apply where the Web Audio API allows.
  getSettings?: () => Promise<Record<string, any>>;
  onSettingsChanged?: (handler: (settings: Record<string, any>) => void) => () => void;
  // Local project files (File → Open / Save / Save As; Electron only). All read/
  // write the on-disk terminator-presets folder. Optional so the web build skips.
  openProjectDialog?: () => Promise<{ path: string; name: string; data?: ChopPreset; bundle?: Uint8Array } | { cancelled: true } | { error: string }>;
  readProjectFile?: (filePath: string) => Promise<{ path: string; name: string; data?: ChopPreset; bundle?: Uint8Array } | { error: string }>;
  saveProjectBundle?: (target: string, bytes: Uint8Array) => Promise<{ ok?: boolean; path?: string; name?: string; error?: string }>;
  showSaveDialog?: (opts?: { bundle?: boolean }) => Promise<{ path: string } | { cancelled: true }>;
  saveProjectFile?: (target: string, data: ChopPreset) => Promise<{ ok?: boolean; path?: string; name?: string; error?: string }>;
  listProjectFiles?: () => Promise<Array<{ name: string; path: string; modifiedAt: number }>>;
  deleteProjectFile?: (filePath: string) => Promise<{ ok?: boolean; error?: string }>;
  // Projects folder (where .tproj/.tprojz go) — OPEN… → Local → CHANGE FOLDER.
  getProjectsDir?: () => Promise<{ path: string; isDefault: boolean }>;
  chooseProjectsDir?: () => Promise<{ ok?: boolean; cancelled?: boolean; error?: string; path: string; isDefault: boolean }>;
  resetProjectsDir?: () => Promise<{ ok?: boolean; path: string; isDefault: boolean }>;
  revealProjectsDir?: () => Promise<{ ok?: boolean; error?: string }>;
  // .tproj double-clicked in Finder/Explorer → main forwards the path.
  onOpenFile?: (cb: (filePath: string) => void) => () => void;
  // EULA acceptance (Electron only). Optional so the web build / older preload
  // bundles don't break.
  eulaStatus?: () => Promise<{ accepted: boolean }>;
  eulaAccept?: (name: string, email: string) => Promise<{ ok: boolean }>;
  // Cloud presets (Supabase via the KCC /api/terminator-presets route) proxied
  // through the main process so the desktop app syncs presets with web/mobile.
  // Optional so older preload bundles fall back to the local on-disk store.
  cloudPresetsList?: () => Promise<any[]>;
  cloudPresetsSave?: (data: any) => Promise<any>;
  cloudPresetsDelete?: (id: string) => Promise<{ ok?: boolean }>;
  openPreferences?: () => Promise<{ ok: boolean }>;
} | undefined;

// Presets sync via the KCC /api/terminator-presets route on BOTH web (cookie
// auth) and Electron (device-JWT Bearer, proxied through the main process over
// IPC). Falls back to the local on-disk preset store only when an older preload
// bundle lacks the cloud IPC methods.
const cloudPresets = isWeb || !!ipc?.cloudPresetsList;

type Playlist = { name: string; entries: Array<{ id: string; title: string; duration?: number }> };

const METRO_SOUNDS: { value: MetronomeSound; label: string }[] = [
  { value: 'click',   label: 'CLICK' },
  { value: 'hihat',   label: 'HI-HAT' },
  { value: 'rimshot', label: 'RIM' },
  { value: 'kick',    label: 'KICK' },
  { value: 'clap',    label: 'CLAP' },
];

// Map the host app's current theme to one of the FINISH HIM portal skins.
function mapPortalTheme(id: string): PortalTheme {
  if (id === 'macos' || id === 'macos9') return 'mac';
  if (id === 'sonic' || id === 'outrun' || id === 'vicecity') return 'ps2';
  return 'xbox';
}

const ARR_BTN: CSSProperties = {
  fontFamily: 'monospace', fontSize: 11, letterSpacing: 1, padding: '5px 10px',
  background: '#0a1a0f', color: '#00ff41', border: '1px solid #0a3a1a',
  borderRadius: 3, cursor: 'pointer',
};
const ARR_BTN_ON: CSSProperties = { ...ARR_BTN, background: '#00ff41', color: '#001a08', borderColor: '#00ff41' };
const arrCard = (accepted: boolean): CSSProperties => ({
  border: `1px solid ${accepted ? '#00ff41' : '#143524'}`, borderRadius: 4,
  padding: '8px 10px', background: 'rgba(0,0,0,0.25)',
});

// Local fallback song structures for the Beat Finisher picker — used when the
// Gemini endpoint is unreachable (e.g. the dev tunnel has no /api route) or errors,
// so the user can always pick + preview. Regenerate shuffles + picks 3.
const LOCAL_FH_STRUCTURES: FinishSuggestion[] = [
  { name: 'Classic', desc: '4 · 8 · 8 · 8 · 4', tag: 'Intro → 2 verses → hook → outro', sections: [
    { id: 'intro', label: 'Intro', bars: 4, chops: [] }, { id: 'v1', label: 'Verse 1', bars: 8, chops: [] },
    { id: 'v2', label: 'Verse 2', bars: 8, chops: [] }, { id: 'hook', label: 'Hook', bars: 8, chops: [] },
    { id: 'outro', label: 'Outro', bars: 4, chops: [] } ] },
  { name: 'Hook-Heavy', desc: '4 · 8 · 8 · 8 · 8', tag: 'Hook between the verses', sections: [
    { id: 'intro', label: 'Intro', bars: 4, chops: [] }, { id: 'v1', label: 'Verse 1', bars: 8, chops: [] },
    { id: 'h1', label: 'Hook 1', bars: 8, chops: [] }, { id: 'v2', label: 'Verse 2', bars: 8, chops: [] },
    { id: 'h2', label: 'Hook 2', bars: 8, chops: [] } ] },
  { name: 'Short Loop', desc: '2 · 4 · 4 · 4', tag: 'Tight, beat-tape style', sections: [
    { id: 'intro', label: 'Intro', bars: 2, chops: [] }, { id: 'a', label: 'Verse', bars: 4, chops: [] },
    { id: 'b', label: 'Hook', bars: 4, chops: [] }, { id: 'c', label: 'Verse 2', bars: 4, chops: [] } ] },
  { name: 'With Bridge', desc: '4 · 8 · 4 · 8 · 4', tag: 'Adds breathing room', sections: [
    { id: 'intro', label: 'Intro', bars: 4, chops: [] }, { id: 'v', label: 'Verse', bars: 8, chops: [] },
    { id: 'bridge', label: 'Bridge', bars: 4, chops: [] }, { id: 'hook', label: 'Hook', bars: 8, chops: [] },
    { id: 'outro', label: 'Outro', bars: 4, chops: [] } ] },
  { name: 'Anthem', desc: '8 · 8 · 16 · 8', tag: 'Big extended hook', sections: [
    { id: 'intro', label: 'Intro', bars: 8, chops: [] }, { id: 'v1', label: 'Verse', bars: 8, chops: [] },
    { id: 'hook', label: 'Hook', bars: 16, chops: [] }, { id: 'v2', label: 'Verse 2', bars: 8, chops: [] } ] },
];
function pickLocalFhSuggestions(): FinishSuggestion[] {
  const a = [...LOCAL_FH_STRUCTURES];
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a.slice(0, 3);
}

// NORM dB readout: turn the chopGain multiplier into a signed dB string, e.g.
// 1.78 → "+5.0 dB", 0.71 → "-3.0 dB". Unity reads "0.0 dB".
function fmtNormDb(gain: number): string {
  const db = 20 * Math.log10(gain > 0 ? gain : 1e-6);
  return `${db >= 0 ? '+' : ''}${db.toFixed(1)} dB`;
}

// ── Draggable section re-arrange (desktop only) ───────────────────────────────
// The 8 major ChopperView sections can be freely repositioned in a snap-to-grid
// "re-arrange" mode (Edit → Re-arrange Layout). Each section is wrapped in a
// <DraggableSection>. With no saved layout it's a `display:contents` no-op (the
// rendered layout is byte-identical to the un-wrapped DOM). Once a custom layout
// exists it becomes an absolutely-positioned box at its saved x/y/width — and
// STAYS there in normal mode, not only while re-arranging. Re-arrange mode just
// adds the drag handle + grid so you can move them.
const SECTION_IDS = ['LOAD', 'WAVEFORM', 'PADS', 'SEQUENCER', 'DRUMS', 'BASS', 'BEAT FINISHER', 'EXPORT', 'MIXER'] as const;
// THE "is the user typing" predicate for the window key handlers. One
// definition — the inline copies drifted (one omitted contentEditable, so ⌘X
// with a caret in a contentEditable element CUT pads instead of editing text).
const isTextEntry = (t: EventTarget | null): boolean =>
  (t instanceof HTMLInputElement && t.type !== 'range')
  || t instanceof HTMLTextAreaElement
  || (t instanceof HTMLElement && t.isContentEditable);
// The BASS piano roll owns arrows / delete / clipboard keys for its selected
// notes, and it does NOT stop propagation — window handlers must yield.
const inPianoRoll = (t: EventTarget | null): boolean =>
  t instanceof HTMLElement && !!t.closest('.pr-wrap');
// Drum-pad mode: pad i (index i) maps to drum lane i — all lanes, in lane order
// (C1=36→kick … E1=40→perc). Index doubles as the drum track index for recordLiveHit.
// (DRUM PADS mode maps pad i → drum lane i of the LIVE lane list — every lane,
// added ones included, in lane order. See drumTracksRef.)
type SectionId = typeof SECTION_IDS[number];
// Each entry stores the snapped position (x/y) plus the measured width/height —
// width is needed to render the section faithfully when it's absolutely
// positioned outside re-arrange mode; height feeds the scroll-canvas min-height.
export type SectionPos = { x: number; y: number; w?: number; h?: number };
export type SectionLayout = Record<string, SectionPos>;
const REARRANGE_GRID = 16;
const snap = (n: number) => Math.round(n / REARRANGE_GRID) * REARRANGE_GRID;
// Resize limits: sections can't collapse below this, and can't grow past the
// viewport (so a corner-drag can't push content off-screen).
const REARRANGE_MIN_W = 200;
const REARRANGE_MIN_H = 100;
// The four corner resize handles. Each names the edges that MOVE under the
// pointer; the opposite edges stay pinned. Cursor matches the corner.
type ResizeCorner = 'se' | 'sw' | 'ne' | 'nw';
const RESIZE_CORNERS: { corner: ResizeCorner; cursor: string }[] = [
  { corner: 'se', cursor: 'se-resize' },
  { corner: 'sw', cursor: 'sw-resize' },
  { corner: 'ne', cursor: 'ne-resize' },
  { corner: 'nw', cursor: 'nw-resize' },
];

// Bounding box of an element's children — needed because a `display:contents`
// wrapper generates no box of its own, so getBoundingClientRect() on it is empty.
function childUnionRect(el: Element): DOMRect | null {
  let l = Infinity, t = Infinity, r = -Infinity, b = -Infinity;
  for (const kid of Array.from(el.children)) {
    const kr = kid.getBoundingClientRect();
    if (kr.width === 0 && kr.height === 0) continue;
    l = Math.min(l, kr.left); t = Math.min(t, kr.top);
    r = Math.max(r, kr.right); b = Math.max(b, kr.bottom);
  }
  if (l === Infinity) return null;
  return new DOMRect(l, t, r - l, b - t);
}

function DraggableSection({
  id, isRearranging, positioned, pos, dragging, onMove, onResize, onResizeEnd, onDragStateChange, registerRef, children,
}: {
  id: SectionId;
  isRearranging: boolean;
  // True when this section should be absolutely positioned — i.e. we're
  // re-arranging OR a saved custom layout is active in normal mode.
  positioned: boolean;
  pos?: SectionPos;
  dragging: boolean;
  onMove: (id: SectionId, pos: { x: number; y: number }) => void;
  // Corner-drag resize: reports the full new box (position can shift when the
  // top/left edges move).
  onResize: (id: SectionId, pos: SectionPos) => void;
  // Fired once the resize gesture ends, so size-aware children (the waveform
  // canvas) can redraw at the new size.
  onResizeEnd: () => void;
  onDragStateChange: (id: SectionId | null) => void;
  registerRef: (id: SectionId, el: HTMLDivElement | null) => void;
  children: ReactNode;
}) {
  const elRef = useRef<HTMLDivElement>(null);
  const setRef = (el: HTMLDivElement | null) => { elRef.current = el; registerRef(id, el); };

  const startDrag = (e: ReactPointerEvent) => {
    if (!isRearranging) return;
    e.preventDefault();
    e.stopPropagation();
    const el = elRef.current;
    if (!el) return;
    const parent = el.offsetParent as HTMLElement | null;
    const startX = e.clientX, startY = e.clientY;
    const origin = { x: el.offsetLeft, y: el.offsetTop };
    onDragStateChange(id);
    const onPointerMove = (ev: globalThis.PointerEvent) => {
      let nx = snap(origin.x + (ev.clientX - startX));
      let ny = snap(origin.y + (ev.clientY - startY));
      // Keep the section on-screen: clamp into the container's bounds.
      const pw = parent ? parent.clientWidth : window.innerWidth;
      nx = Math.max(0, Math.min(nx, Math.max(0, pw - el.offsetWidth)));
      ny = Math.max(0, ny);
      onMove(id, { x: nx, y: ny });
    };
    const onPointerUp = () => {
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
      onDragStateChange(null);
    };
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
  };

  // Corner-drag resize. `corner` names which edges follow the pointer; the
  // opposite edges stay pinned (so resizing from the top-left also shifts x/y).
  const startResize = (corner: ResizeCorner) => (e: ReactPointerEvent) => {
    if (!isRearranging) return;
    e.preventDefault();
    e.stopPropagation();
    const el = elRef.current;
    if (!el) return;
    const parent = el.offsetParent as HTMLElement | null;
    const startX = e.clientX, startY = e.clientY;
    const ox = el.offsetLeft, oy = el.offsetTop;
    const ow = el.offsetWidth, oh = el.offsetHeight;
    const right = ox + ow, bottom = oy + oh;
    const maxW = parent ? parent.clientWidth : window.innerWidth;
    const maxH = window.innerHeight;
    const movesLeft = corner === 'sw' || corner === 'nw';
    const movesTop  = corner === 'ne' || corner === 'nw';
    onDragStateChange(id);
    const onPointerMove = (ev: globalThis.PointerEvent) => {
      const dx = ev.clientX - startX;
      const dy = ev.clientY - startY;
      let nx = ox, ny = oy, nw = ow, nh = oh;
      if (movesLeft) {
        // Pin the right edge; left edge follows the pointer (snapped, on-screen).
        const nl = Math.max(0, Math.min(snap(ox + dx), right - REARRANGE_MIN_W));
        nx = nl; nw = right - nl;
      } else {
        // Pin the left edge; right edge follows (clamped to the viewport).
        const nr = Math.min(snap(right + dx), maxW);
        nw = Math.max(REARRANGE_MIN_W, nr - ox);
      }
      if (movesTop) {
        const nt = Math.max(0, Math.min(snap(oy + dy), bottom - REARRANGE_MIN_H));
        ny = nt; nh = bottom - nt;
      } else {
        const nb = Math.min(snap(bottom + dy), oy + maxH);
        nh = Math.max(REARRANGE_MIN_H, nb - oy);
      }
      onResize(id, { x: nx, y: ny, w: nw, h: nh });
    };
    const onPointerUp = () => {
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
      onDragStateChange(null);
      onResizeEnd();
    };
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
  };

  const style: CSSProperties | undefined = positioned
    ? {
        position: 'absolute',
        left: pos ? pos.x : undefined,
        top: pos ? pos.y : undefined,
        width: pos?.w ? pos.w : undefined,
        height: pos?.h ? pos.h : undefined,
        zIndex: dragging ? 1000 : (isRearranging ? 20 : undefined),
      }
    : undefined;

  return (
    <div
      ref={setRef}
      className={`rsec${positioned ? ' rsec-positioned' : ''}${dragging ? ' rsec-dragging' : ''}`}
      data-rsec={id}
      style={style}
    >
      {isRearranging && (
        <div className="rsec-handle" onPointerDown={startDrag} title="Drag to move this section">
          <span className="rsec-grip">⠿</span> {id}
        </div>
      )}
      {isRearranging && RESIZE_CORNERS.map(({ corner, cursor }) => (
        <div
          key={corner}
          className={`rsec-resize rsec-resize-${corner}`}
          style={{ cursor }}
          onPointerDown={startResize(corner)}
          title="Drag to resize this section"
        />
      ))}
      {children}
    </div>
  );
}

/** The DR · BS · OT · VX chips on the waveform bar. Own component so it can
 *  subscribe to the pad ACTIVITY channel: a pad HIT (mouse, keyboard, MIDI,
 *  sequencer) re-renders just these chips, never the whole ChopperView — and
 *  they always show the pad you last hit (his rule 2026-08-21; a pad SELECTED
 *  for chop-assign still wins, exactly like the waveform highlight). With pads
 *  multi-selected they edit the whole selection. Main-track chop pads only —
 *  a pad's own sample has no stems. */
/** ◁ REV — the waveform bar's reverse control.
 *
 *  CLICK flips the pad you last hit (or every selected pad): one chop plays
 *  backwards while its neighbours stay forward — his ask 2026-08-22. Per-step
 *  reverse used to live in the sequencer's revGrid and was dropped on
 *  2026-08-18 when REV became a live source-wide state; this brings it back
 *  per PAD, where it also reaches live hits and exports (engine.reversedFor).
 *  RIGHT-CLICK is the old behaviour — flip the whole source on screen.
 *  Flipping a pad back to its source's direction drops the override, so a
 *  later source-wide REV moves that pad again.
 *  Its own component (like StemChips) so `usePadActivity` re-renders THIS
 *  button on every hit instead of the whole ChopperView. */
function RevButton({ engine, selected, sourceKey, sourceReversed, inSourceView, disabled, flash }: {
  engine: ChopperEngine; selected: number[]; sourceKey: string; sourceReversed: boolean;
  inSourceView: boolean; disabled: boolean; flash: (msg: string) => void;
}) {
  usePadActivity(engine); // the target follows the pad you last hit
  const focus = engine.focusedPad();
  const targets = (selected.length ? selected : (focus !== null ? [focus] : [])).filter(i => engine.hasPadContent(i));
  const padMode = targets.length > 0;
  const on = padMode ? engine.reversedFor(targets[0]) : sourceReversed;
  const who = !padMode ? '' : targets.length > 1 ? `${targets.length} PADS` : `PAD ${targets[0] + 1}`;
  return (
    <button
      className={`btn-chop-mode ${on ? 'chop-mode-on' : ''}`}
      disabled={disabled}
      onClick={() => {
        if (!padMode) { engine.toggleSourceReverse(sourceKey); return; }
        const now = engine.togglePadsReverse(targets);
        flash(`${who} ${now ? 'plays backwards ◁' : 'plays forwards'}`);
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        engine.toggleSourceReverse(sourceKey);
        flash(`Whole ${inSourceView ? 'source' : 'sample'} ${!sourceReversed ? 'plays backwards ◁' : 'plays forwards'} — pads you flipped yourself keep their own direction`);
      }}
      title={padMode
        ? `Reverse ${who} — hit or click a pad and this flips THAT pad only, so one chop runs backwards while the rest stay forward (live hits, the sequencer and exports all follow). Flip it back and the pad follows its ${inSourceView ? 'source' : 'sample'} again. RIGHT-CLICK = flip the whole ${inSourceView ? 'source' : 'sample'} instead`
        : `Reverse the whole ${inSourceView ? 'source — every pad of it' : 'sample — chops and all'}. Hit or click a pad first and this button flips THAT pad on its own instead`}
    >
      {padMode ? (on ? `◁ REV ${who} ON` : `◁ REV ${who}`) : (on ? '◁ REV ON' : '◁ REV')}
    </button>
  );
}

function StemChips({ engine, selected, flash }: { engine: ChopperEngine; selected: number[]; flash: (msg: string) => void }) {
  usePadActivity(engine); // re-render on every hit
  const focus = engine.focusedPad();
  // STEMS PER SOURCE: a chop of the main track OR a pad's own sample — any pad
  // whose sound has been split (or can be) takes the chips.
  const hasTarget = (i: number) => engine.stemTargetKind(i) !== null && engine.hasStemsForPad(i);
  const targets = (selected.length ? selected : (focus !== null ? [focus] : [])).filter(hasTarget);
  const showPad = focus !== null && hasTarget(focus) ? focus : (targets[0] ?? null);
  const mask = showPad !== null ? engine.padStems(showPad) : MASK_ALL;
  const CHIP: Record<StemName, string> = { drums: 'DR', bass: 'BS', other: 'OT', vocals: 'VX' };
  return (<>
    {STEM_ORDER.map(name => (
      <button key={name}
        className={`btn-chop-mode ${maskHas(mask, name) ? 'chop-mode-on' : ''}`}
        disabled={!targets.length}
        title={!targets.length
          ? `${name.toUpperCase()} — a layer chip for the pad you last hit. Chips light for pads whose sound has been split: chops of the main track, or a pad's own sample once you split THAT (STEMS while its waveform is showing)`
          : `${name.toUpperCase()} on/off for ${selected.length > 1 ? 'the selected pads' : showPad !== null ? `pad ${showPad + 1} (the pad you last hit)` : 'the pad you last hit'} — same chop, different layer, and it switches LIVE while the chop plays. The last lit stem stays on; a new chop cut from this one starts with the same layers`}
        onClick={() => {
          const next = toggleStem(mask, name);
          if (next === mask) { flash('At least one stem stays on'); return; }
          engine.setPadsStems(targets, next);
        }}>
        {CHIP[name]}
      </button>
    ))}
  </>);
}

/** The live STEMS status line — stays up for the WHOLE split (engine download
 *  → load → splitting → saving) with looping dots + an elapsed clock, and only
 *  leaves when the engine is done. His ask 2026-08-21: the 4 s toast vanished
 *  while the button's percentage stalled, so he couldn't tell if it was still
 *  working — the dots keep moving even when the percentage doesn't. */
function StemsSplitStatus({ ui }: { ui: StemsUiState }) {
  const [tick, setTick] = useState(0);
  const startRef = useRef<number>(performance.now());
  useEffect(() => {
    startRef.current = performance.now();
    const id = window.setInterval(() => setTick(t => t + 1), 450);
    return () => window.clearInterval(id);
  }, []);
  const dots = '.'.repeat((tick % 3) + 1).padEnd(3, '\u00a0');
  const secs = Math.floor((performance.now() - startRef.current) / 1000);
  const clock = `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;
  const label = ui.phase === 'models' ? `DOWNLOADING ENGINE ${ui.pct}%`
    : ui.phase === 'load' ? 'LOADING ENGINE'
    : ui.phase === 'split' ? `SPLITTING ${ui.queue && ui.queue.total > 1 ? `${ui.queue.n} OF ${ui.queue.total}` : 'WHOLE SAMPLE'} · ${ui.pct}%`
    : ui.phase === 'saving' ? 'SAVING STEMS'
    : '';
  if (!label) return null;
  return (
    <div className="chopper-status chopper-status--live" title="Stems are still being made — this line stays until the engine is done (the dots keep moving even when the percentage pauses between chunks)">
      {label}<span style={{ display: 'inline-block', width: '1.6em', textAlign: 'left' }}>{dots}</span>
      <span style={{ opacity: 0.7 }}> {clock}</span>
    </div>
  );
}

export function ChopperView() {
  // VIEW ROUTING: the bespoke "hardware machine" layout (HardwareView) is the
  // MOBILE default; desktop falls back to this classic UI, which carries the
  // full theme system (T-800 / SF2 / Mario / etc. via the theme-cycle button).
  // Overrides, valid on any device: ?classic=1 forces the classic UI; ?v2 or
  // ?hardware forces the hardware layout (so desktop can still preview it).
  // Mobile = touch-primary pointer OR a narrow viewport. Deterministic per page
  // load, and placed before any hook call so this early return never changes
  // hook order. HardwareView is an entirely separate component with its own
  // engines — the classic UI below is left completely untouched. (Vite SPA,
  // client-only: window always exists here.)
  if (typeof window !== 'undefined') {
    const params = new URLSearchParams(window.location.search);
    const forceClassic = params.has('classic') || !isWeb;
    const forceHardware = params.has('v2') || params.has('hardware');
    // The persisted UI MODE (theme picker → UI: AUTO / DESKTOP / MOBILE) — a
    // phone or iPad can choose the desktop layout and vice-versa. AUTO = a
    // PHONE gets the hardware layout, an iPad/tablet and a computer get the
    // desktop one (autoWantsMobile). ?classic and ?v2 still win as explicit
    // one-off overrides.
    const uiMode = getUiMode();
    const isMobile = uiMode === 'mobile' || (uiMode === 'auto' && autoWantsMobile());
    if (!forceClassic && (forceHardware || isMobile)) {
      return <HardwareView />;
    }
  }

  const engineRef = useRef<ChopperEngine | null>(null);
  if (!engineRef.current) engineRef.current = new ChopperEngine();
  const engine = engineRef.current!;
  // Dev-only probe so the engine can be driven / profiled from the console
  // (mirrors the board's __board handle). Stripped from production bundles.
  if (import.meta.env.DEV) (window as any).__chopper = engine;

  // Drum sequencer engine — shares the chopper's AudioContext, feeds into
  // the pad bus so its output passes through the master FX chain, and
  // reads BPM from the chopper so the two transports stay synced.
  const drumEngineRef = useRef<DrumEngine | null>(null);
  // Pristine default snapshots captured once at creation, before any user edits
  // or preset restore — File → New Project restores these so drums + mixer go
  // back to factory defaults.
  const defaultDrumsRef = useRef<ReturnType<DrumEngine['serialize']> | null>(null);
  if (!drumEngineRef.current) {
    drumEngineRef.current = new DrumEngine(engine.ctx, engine.drumBusInput, () => engine.getMasterBpm(), () => engine.getInputQuantize());
    defaultDrumsRef.current = drumEngineRef.current.serialize();
    // Unified undo: drum state rides in every chop snapshot, and drum edits push
    // into the same stack (so Cmd+Z covers both engines in chronological order).
    engine.attachDrumEngine(drumEngineRef.current);
    drumEngineRef.current.setHistorySink({
      record: g => engine.recordHistory(g),
      dropLast: () => engine.dropLastHistory(),
    });
  }
  const drumEngine = drumEngineRef.current!;
  // BASS engine — the third peer engine (Model-D-style synth + piano roll).
  // Shares the chopper's ctx + tempo; its output feeds a dedicated mixer strip
  // (wired with the mixer below). Built once, like the drum engine.
  const bassEngineRef = useRef<BassEngine | null>(null);
  if (!bassEngineRef.current) bassEngineRef.current = new BassEngine(engine.ctx, () => engine.getMasterBpm());
  const bassEngine = bassEngineRef.current!;
  // Same dev-only probe as __chopper — headless piano-roll/synth testing.
  if (import.meta.env.DEV) (window as any).__bass = bassEngine;
  if (import.meta.env.DEV) (window as any).__drums = drumEngine; // dev probe, like __chopper
  const [collapsedDrums, setCollapsedDrums] = useState(true); // collapsed by default, like the other sections
  const [collapsedBass, setCollapsedBass] = useState(true);
  // TRANSFER TO DEVICE / RECEIVE dialog (OPEN… footer).
  const [transfer, setTransfer] = useState<'send' | 'receive' | null>(null);
  // BASS MIDI IN (toggled in the BASS section header): incoming MIDI notes — and
  // the pad keys — play the bass synth instead of the pads. Ref mirror for the
  // mount-once MIDI/keyboard handlers.
  const bassMidiRef = useRef(false);

  // First-launch gate (Electron only — web has no ipc bridge): EULA → Sign In.
  // Default to showing the EULA and only hide it on a confirmed accepted:true
  // response — if the status check rejects or never resolves, we'd rather show
  // the terms than silently skip them. A small delay lets the IPC bridge come
  // up first. Once the EULA is out of the way, the sign-in screen shows unless
  // a desktop session is already stored (signed in / "limited access" guest).
  const [showEula, setShowEula] = useState(false);
  const [showSignIn, setShowSignIn] = useState(false);
  // Bumped after an async license check so the synchronous isSubscribed() gate
  // (which reads the in-memory license cache) re-renders with the new result.
  const [, forceLicenseRerender] = useState(0);
  // Electron gate: re-validate the device license with the server. Unlocked →
  // hide the sign-in modal and re-render (isSubscribed() now true). Otherwise →
  // show the browser sign-in modal. (Web never calls this — see the guard below.)
  const checkLicenseGate = async () => {
    // DEV Electron runs unlocked (see isSubscribed) — no sign-in overlay either.
    if ((import.meta as any).env?.DEV) { setShowSignIn(false); return; }
    // NATIVE build: unlocked until the licence flow is ported (see lib/subscription.ts).
    if (typeof __TERMINATOR_NATIVE__ !== 'undefined' && __TERMINATOR_NATIVE__) { setShowSignIn(false); return; }
    await refreshLicense();
    if (getLicense()?.unlocked) {
      setShowSignIn(false);
      forceLicenseRerender((n) => n + 1);
    } else {
      setShowSignIn(true);
    }
  };
  useEffect(() => {
    // Electron-only gate. The web build NEVER shows the EULA/Sign-In modals —
    // web access is handled entirely by the outer KCC page + ?sub=1. (The web
    // ipc-browser shim defines window.terminator.eulaStatus, so a bridge check
    // alone is not enough to keep this off the web build.)
    if (isWeb) return;
    const checkEula = ipc?.eulaStatus;
    if (!checkEula) return; // no bridge — nothing to gate on
    const timer = setTimeout(() => {
      checkEula()
        .then(({ accepted }) => {
          if (!accepted) { setShowEula(true); return; }
          // EULA accepted on a previous launch — re-validate the license and
          // either unlock (returning pro user) or show the sign-in gate.
          void checkLicenseGate();
        })
        .catch(() => setShowEula(true)); // can't confirm acceptance — show to be safe
    }, 500);
    return () => clearTimeout(timer);
  }, []);

  // Electron: when the main process finishes a browser sign-in + token exchange,
  // re-validate and unlock. (Inert on web — onAuthSignedIn returns a no-op there.)
  useEffect(() => {
    if (isWeb) return;
    const off = onAuthSignedIn(() => { void checkLicenseGate(); });
    return off;
  }, []);

  // Desktop DAW Mixer — built once. The chopper's master output feeds the
  // "sample" channel and each drum track's per-track tap feeds its own channel,
  // so chops + the 5 drum tracks each get a full mixer strip. The mixer master
  // takes over the connection to the speakers (replacing the chopper's direct
  // route + the removed FX panels). Wired here, once, on first render.
  const mixerEngineRef = useRef<MixerEngine | null>(null);
  const defaultMixerRef = useRef<ReturnType<MixerEngine['serialize']> | null>(null);
  if (!mixerEngineRef.current) {
    const mx = new MixerEngine(engine.ctx);
    defaultMixerRef.current = mx.serialize();
    engine.outputNode.disconnect();                            // peel chops off the speakers
    engine.outputNode.connect(mx.getChannelInput('sample'));
    const drumMap: Array<[TrackKey, ChannelName]> = [
      ['kick', 'kick'], ['snare', 'snare'], ['hihat', 'hat'], ['openhat', 'openhat'], ['perc', 'perc'],
    ];
    for (const [tk, ch] of drumMap) drumEngine.routeTrackOutput(tk, mx.getChannelInput(ch));
    // BASS strip — a permanent regular channel right after the drums.
    mx.addChannel('bass');
    mx.setChannelMeta('bass', 'BASS', '#f2c94c');
    bassEngine.outputNode.connect(mx.getChannelInput('bass'));
    mx.connectToDestination();
    engine.attachMixer(mx);    // exports bake the Sample-channel mixer FX; internal limiter steps aside
    mixerEngineRef.current = mx;
  }
  const mixerEngine = mixerEngineRef.current!;

  // NOTE: the drum engine keeps its DEFAULT per-track volumes (kick/snare 1.0,
  // hihat/openhat 0.25, perc 0.50). Those balanced source levels are what BOTH
  // live playback AND the offline arrangement export read (getExportTracks →
  // t.volume), so they must NOT be flattened to unity — doing so made every
  // arrangement export bake drums at a flat, hat-heavy mix. The mixer's per-drum
  // channel fader sits downstream as a live trim on top of that balance (a fader
  // at 0 dB = pass the already-balanced drum signal through unchanged).

  // AI Beat Arranger — live preview player (additive; never touches the tuned
  // sequencer) + the suggestions it's showing.
  const arrangerRef = useRef<ArrangerPreview | null>(null);
  if (!arrangerRef.current) arrangerRef.current = new ArrangerPreview(engine, drumEngine, bassEngine);
  const arranger = arrangerRef.current!;
  const [collapsedArranger, setCollapsedArranger] = useState(true);
  const [arrStructures, setArrStructures] = useState<Arrangement[]>([]);
  const [arrLoading, setArrLoading] = useState(false);
  const [arrError, setArrError] = useState<string | null>(null);
  const [arrPreviewIdx, setArrPreviewIdx] = useState<number | null>(null);
  const [arrAcceptedIdx, setArrAcceptedIdx] = useState<number | null>(null);
  useEffect(() => () => arranger.stop(), []); // stop preview on unmount

  // FINISH HIM portal — opens once the user has chops + a drum pattern. Subscribe
  // to drum state so the entry point appears/updates reactively (user-driven
  // edits only; the ref-based playhead never emits, so no per-frame churn).
  const [finishHimOpen, setFinishHimOpen] = useState(false);
  // Phase 3A.7: a themed intro video plays the FIRST time the Beat Finisher is
  // opened per session. The clip that plays (PS2 or Xbox) is picked at random and
  // locks the modal's theme until page reload. `introVideo` holds the currently-
  // playing clip (renders the overlay); `finishHimTheme` is the locked theme;
  // `introPlayedRef` gates it to once per session (resets on reload).
  const introPlayedRef = useRef(false);
  const [introVideo, setIntroVideo] = useState<'ps2' | 'xbox' | null>(null);
  const [finishHimTheme, setFinishHimTheme] = useState<PortalTheme | null>(null);
  const fhPhone = useIsPhone(); // Phase 3A.9: drop the modal's outer padding on a phone
  // Always-current finishHimOpen for the window keydown handler (whose effect
  // doesn't re-run on every state change) — Phase 3A.2 context-aware SPACE.
  const finishHimOpenRef = useRef(finishHimOpen);
  finishHimOpenRef.current = finishHimOpen;
  // Phase 5: Winamp-style Sample Browser modal. Ref mirrors the open flag so the
  // window key handlers can ignore pad/transport keys while it's up.
  const [sampleBrowserOpen, setSampleBrowserOpen] = useState(false);
  const sampleBrowserOpenRef = useRef(sampleBrowserOpen);
  sampleBrowserOpenRef.current = sampleBrowserOpen;
  const [finishHimSuggestions, setFinishHimSuggestions] = useState<FinishSuggestion[] | undefined>(undefined);
  const [finishHimLoading, setFinishHimLoading] = useState(false);
  const [drumState, setDrumState] = useState(() => drumEngine.getState());
  // The live lane list for DRUM PADS mode (pad i → lane i): a ref so the
  // mount-once MIDI handler always sees the current lanes, added ones included.
  const drumTracksRef = useRef(drumState.tracks); drumTracksRef.current = drumState.tracks;
  useEffect(() => drumEngine.subscribe(setDrumState), [drumEngine]);

  // Phase 2B.1: every fresh load starts with a unique kit + groove (web drums) —
  // re-roll all samples + generate a pattern once on mount. A ref guards against
  // re-firing on HMR (so it only happens on a real page load).
  const didRandomizeOnLoad = useRef(false);
  useEffect(() => {
    if (!isWeb || didRandomizeOnLoad.current) return;
    didRandomizeOnLoad.current = true;
    drumEngine.randomizeAllSamples?.();
    void drumEngine.generate?.('trap');
    // The default-kit randomize + generate above push history; drop them so a
    // fresh session starts with nothing to undo (generate('trap') is synchronous
    // up to its single top-of-method push, so this clears every entry it made).
    engine.clearHistory();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Phase 2C: keep the drum loop phase-locked to the chop sequencer. When the
  // sequencer starts (including after a count-in), the drums start at the EXACT
  // same ctx anchor — same BPM + audio clock means they never drift.
  // MIDI CLOCK (send): Preferences → MIDI. Same anchor as the drums/bass, so
  // outboard gear locks to the very same grid. Outputs = every connected port
  // the MIDI Outputs toggles leave on (default on); read live off settings.
  const midiClockRef = useRef<MidiClockSender | null>(null);
  const midiOutPrefRef = useRef<Record<string, boolean>>({});
  if (!midiClockRef.current) midiClockRef.current = new MidiClockSender(engine.ctx, () => engine.getMasterBpm(), () => midiHub.outputs().filter(o => midiOutPrefRef.current[o.id] !== false));
  useEffect(() => {
    const ipc = (window as any).terminator as { getSettings?: () => Promise<Record<string, any>>; onSettingsChanged?: (h: (s: Record<string, any>) => void) => () => void } | undefined;
    const apply = (s: Record<string, any> | undefined) => {
      const m = s?.midi ?? {};
      midiOutPrefRef.current = (m.outputs && typeof m.outputs === 'object') ? m.outputs : {};
      clockFollowTempoRef.current = !!m.clockFollow;
      const on = !!m.clock;
      if (on) midiHub.start(); // make sure access is requested so outputs exist
      midiClockRef.current?.setEnabled(on);
    };
    ipc?.getSettings?.().then(apply).catch(() => { /* no settings yet */ });
    const off = ipc?.onSettingsChanged?.(apply);
    return () => { off?.(); midiClockRef.current?.dispose(); };
  }, []);
  useEffect(() => {
    engine.setTransportHooks?.(
      (at: number) => { void drumEngine.start(at); void bassEngine.start(at); midiClockRef.current?.start(at); },
      (restart: boolean) => { drumEngine.stop({ keepRec: restart }); bassEngine.stop(); midiClockRef.current?.stop(); },
      // native transport (Terminator 3.0): the chop seq runs on the engine's clock — its measured drift vs this
      // context nudges the satellites' grids (phase-preserving, no restart)
      (d: number) => { drumEngine.nudge(d); bassEngine.nudge(d); midiClockRef.current?.nudge(d); },
    );
  }, [engine, drumEngine, bassEngine]);

  // Unified transport: one entry point starts both grids in lock-step; falls back
  // to drums-only when there's no chop sequence (no sample loaded) to play.
  const startTransport = () => {
    engine.playSeq();                                          // start hook → drums at seqPlayStart
    // Drums ALWAYS run on PLAY, from any section. When a sample is loaded the
    // seqStartHook above already started them phase-locked at the seq anchor;
    // this also covers the no-sample case AND any run where the hook didn't
    // deliver. start() is idempotent (its in-flight claim makes a redundant
    // call a no-op), so this never double-starts the drum scheduler.
    void drumEngine.start();
    void bassEngine.start();
  };
  const stopTransport = () => { engine.stopSeq(); drumEngine.stop(); bassEngine.stop(); };
  // Stable handles for handlers that outlive a render — the MIDI listener is
  // bound once, so calling the render-scoped closures directly would freeze it
  // against the first render's engines.
  const startTransportRef = useRef(startTransport); startTransportRef.current = startTransport;
  const stopTransportRef = useRef(stopTransport); stopTransportRef.current = stopTransport;
  // MIDI clock IN: the estimator + "the hardware is driving" flag (set by an
  // incoming START, cleared by its STOP) — read inside the bound-once handler.
  const clockFollowRef = useRef<MidiClockFollower | null>(null);
  if (!clockFollowRef.current) clockFollowRef.current = new MidiClockFollower();
  const clockFollow = clockFollowRef.current;
  const clockFollowOnRef = useRef(false);
  /** Preferences → MIDI → "MIDI Clock (follow tempo)". OFF by default (his
   *  word 2026-08-22: "I want to hit play and stop on my MIDI and it just
   *  plays and stops Terminator" — the transport always follows; the TEMPO only
   *  when this is on). */
  const clockFollowTempoRef = useRef(false);
  // One port owns the clock: an MPC sends START/clock on every port it exposes,
  // which doubled the tick rate (89 BPM read 177–178) and restarted PLAY twice.
  const clockLockRef = useRef<MidiClockSourceLock | null>(null);
  if (!clockLockRef.current) clockLockRef.current = new MidiClockSourceLock();
  // NATIVE (Terminator 3.0, Phase 3.5): the C++ MidiHub follows the clock TICKS on the driver thread (its own
  // one-port lock + the same estimator) and reports a settled tempo ≤ once per beat; the page keeps the policy —
  // the tempo moves only while the hardware drives (its START reached the router above) AND "follow tempo" is on.
  useEffect(() => {
    if (!isNative()) return;
    return onNativeEvent('terminator.midiClock', (m: { bpm?: number } | null) => {
      const bpm = Number(m?.bpm);
      if (clockFollowOnRef.current && clockFollowTempoRef.current && Number.isFinite(bpm) && bpm > 0) engine.setMetronomeBpm(bpm);
    });
  }, [engine]);
  // Full panic — kill EVERY sound at once: the chop sequencer (and its
  // scheduled AudioBufferSourceNodes), the drum loop, and any manually
  // triggered pad voices still ringing out (envelope tails, reverb sends).
  // Same effect as desktop's double-tap-space and the export-bar ■ STOP.
  const killAllAudio = () => {
    engine.stopSeq();
    bassEngine.panic();
    drumEngine.stop();
    engine.stopAllPads();
  };

  // Ask the (Gemini) finisher endpoint for arrangement suggestions. Same-origin in
  // the web build; on failure (or the dev tunnel, which can't reach it) we leave
  // suggestions undefined and the portal falls back to its static structures.
  const generateFinishHim = async () => {
    setFinishHimLoading(true);
    try {
      const { request } = buildArrangerPayload(engine, drumEngine);
      const res = await fetch('/api/finish-him', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        credentials: 'include', body: JSON.stringify(request),
      });
      if (!res.ok) { setFinishHimSuggestions(pickLocalFhSuggestions()); return; }
      const j = await res.json();
      setFinishHimSuggestions(Array.isArray(j.suggestions) && j.suggestions.length ? j.suggestions : pickLocalFhSuggestions());
    } catch {
      setFinishHimSuggestions(pickLocalFhSuggestions()); // offline / dev tunnel — local fallback
    } finally {
      setFinishHimLoading(false);
    }
  };
  const openFinishHim = () => {
    if (demoBlock()) return;
    // Stop any background playback so the preview doesn't layer with it.
    try { engine.stopSeq(); } catch { /* */ }
    try { drumEngine.stop(); } catch { /* */ }
    try { (engine as any).stopAllPads?.(); } catch { /* */ }
    // Phase 3A.7: first open this session → roll a themed intro video; the clip
    // that plays locks the modal theme. The modal opens once it ends / is skipped.
    if (!introPlayedRef.current) {
      introPlayedRef.current = true;
      const pick: 'ps2' | 'xbox' = Math.random() < 0.5 ? 'ps2' : 'xbox';
      setFinishHimTheme(pick);
      setIntroVideo(pick);
      return;
    }
    setFinishHimOpen(true);
    // Phase 3A-mod: open straight onto the default arrangement — no AI fetch / picker.
  };
  // End the intro (video finished, tapped to skip, or failed to load) → open the modal.
  const dismissIntro = () => { setIntroVideo(null); setFinishHimOpen(true); };

  // Preview the arrangement on the existing audio graph via ArrangerPreview
  // (reuses the chopper transport/BPM + drum engine — no second clock).
  const [finishHimPreviewing, setFinishHimPreviewing] = useState(false);
  // Phase 3A.6: current seek position in BEATS. Drives the stopped-state playhead
  // and the start offset of the next preview; a live seek re-anchors the transport.
  const [finishHimSeekBeat, setFinishHimSeekBeat] = useState(0);
  // Phase 1D: in-memory snapshot of the arrangement so closing + re-opening the
  // Beat Finisher restores exactly where the user left off (resets on page reload).
  const finishHimSavedRef = useRef<FinishArrangementSection[] | null>(null);
  // Phase 3A-mod: master clipper amount, shared by the Beat Finisher mixer + the
  // drum-section header so both stay in sync.
  const [masterClip, setMasterClip] = useState(0);
  // Commit (on release): update the shared React state so both clip faders mirror.
  // Stable identity: it's a prop of the memoized MixerSection.
  const handleSetClip = useCallback((v: number) => { setMasterClip(v); engine.setMasterClip?.(v); }, [engine]);
  // Phase 3A.10.1: live (during drag) — engine only, so we DON'T re-render the
  // whole ChopperView on every move. The fader shows local state until release.
  const handleSetClipLive = (v: number) => { engine.setMasterClip?.(v); };
  // Build the ArrangerPreview arrangement from the Beat Finisher sections.
  // Shared by the initial preview and by live edits (Phase 3A.5) so both resolve
  // chops + per-section drum patterns identically.
  const buildFinishArrangement = (secs: FinishArrangementSection[]): Arrangement => {
    const st = engine.getState();
    const ds = drumEngine.getState();
    // Resolve a chop sequence's grid into beat-stamped pad events, looped (and
    // truncated) to fill `sectionBars`. Mirrors how the Sequencer plays it: each
    // active step fires at its 16th-note position; the loop repeats to fill the
    // section. (Swing isn't modelled — straight grid timing.)
    const chopEventsFor = (seqIdx: number, sectionBars: number): Array<{ beat: number; pads: number[]; rev?: boolean[] }> => {
      const seq: any = (st.sequences || [])[seqIdx];
      if (!seq || !seq.grid) return [];
      const resolution = seq.resolution || 16;
      const seqBars = Math.max(1, seq.bars || 1);
      const stepCount = Math.min(SEQ_MAX_STEPS, seqBars * resolution);
      const stepBeats = 4 / resolution;   // beats per step
      const loopBeats = seqBars * 4;      // beats per full sequence loop
      const sectionBeats = sectionBars * 4;
      const out: Array<{ beat: number; pads: number[]; rev?: boolean[] }> = [];
      for (let base = 0; base < sectionBeats; base += loopBeats) {
        for (let s = 0; s < stepCount; s++) {
          const row = seq.grid[s];
          if (!row || row.length === 0) continue;
          const beat = base + s * stepBeats;
          if (beat >= sectionBeats) break;
          // REV is global at playback (see ChopperEngine.scheduleSeqStepAudio).
          const revNow = engine.getState().reverseSample;
          const rev = row.map(() => revNow);
          out.push({ beat, pads: [...row], rev: rev.some(Boolean) ? rev : undefined });
        }
      }
      return out;
    };
    // Phase 1B: each enabled track plays the drum SEQUENCE chosen for it in this
    // section. Composite those rows into one explicit pattern per section.
    const seqList = (ds.sequences && ds.sequences.length ? ds.sequences : [ds.pattern]) as Array<Record<string, boolean[]>>;
    const bs = bassEngine.getState();
    return {
      name: 'Finish Him',
      bassPatch: bassEngine.serialize().patch,
      sections: secs.map((s) => {
        const bassIdx = bassSeqForSection(s);
        const enabled = Object.keys(s.drumsOn).filter((k) => s.drumsOn[k]);
        const drumPattern: Record<string, boolean[]> = {};
        for (const key of enabled) {
          const idx = s.drumSeq?.[key] ?? 0;
          const pat = seqList[idx] || ds.pattern;
          drumPattern[key] = (pat as any)[key] || [];
        }
        return {
          name: s.label,
          bars: s.bars,
          chops: [],
          chopEvents: chopEventsFor(s.chopSeqIdx, s.bars),
          drums: 'loop' as const,
          enabledDrumTracks: enabled,
          drumPattern,
          // The rows above are the engine's stored rows, verbatim — tell the
          // exporter their resolution rather than letting it assume 16ths.
          drumStepsPerBar: drumEngine.stepsPerBar,
          // BASS: the section's chosen bass pattern, looped to its bars (-1 = off).
          bassNotes: bassIdx >= 0 ? BassEngine.notesForSection(bs.patterns[bassIdx], s.bars) : undefined,
          bassBends: bassIdx >= 0 ? BassEngine.bendsForSection(bs.patterns[bassIdx], s.bars) : undefined,
        };
      }),
    };
  };
  // The CURRENT Beat Finisher arrangement — the saved snapshot when the modal
  // has been opened/edited this session, else the exact default arrangement a
  // fresh modal seeds. This is what the main EXPORT section renders, so main-
  // page exports and Beat Finisher exports produce identical results.
  const currentFinishSections = (): FinishArrangementSection[] => {
    if (finishHimSavedRef.current?.length) return finishHimSavedRef.current;
    const ds = drumEngine.getState();
    const seqList = (ds.sequences && ds.sequences.length ? ds.sequences : [ds.pattern]) as Array<Record<string, boolean[]>>;
    // Mirror the portal's used-track filter: only tracks with hits in ANY drum
    // sequence get arrangement rows (falling back to all when none have hits).
    const all = ds.tracks.map(t => ({ key: t.key }));
    const used = all.filter(tk => seqList.some(seq => seq?.[tk.key]?.some(Boolean)));
    return defaultFinishSections(used.length ? used : all, { drumSeq: ds.seqIndex, chopSeq: engine.getState().currentSeqIdx });
  };

  const previewFinishHim = (secs: FinishArrangementSection[]) => {
    const ds = drumEngine.getState();
    const arrangement = buildFinishArrangement(secs);
    const identity = Array.from({ length: 128 }, (_, i) => i);
    setFinishHimPreviewing(true);
    // Phase 3A.6: start from the current seek position; reset the marker to 0
    // when the preview ends so the next plain play starts from the top.
    void arranger.play(arrangement, identity, ds.pattern as any, ds.bars,
      () => { setFinishHimPreviewing(false); setFinishHimSeekBeat(0); }, finishHimSeekBeat);
  };
  // Phase 3A.5: a live arrangement edit (mute a drum block, switch a section's
  // sequence) re-schedules the drum timeline on the running preview — no restart.
  // Drum-only: chop events stay on their snapshot timeline (bars unchanged).
  const liveUpdateFinishHim = (secs: FinishArrangementSection[]) => {
    if (!finishHimPreviewing) return;
    arranger.updateDrums(buildFinishArrangement(secs));
  };
  // Phase 3A.6: seek to a beat. Moves the marker (stopped-state playhead) and,
  // if a preview is running, re-anchors the transport to continue from there.
  const seekFinishHim = (beat: number) => {
    const b = Math.max(0, beat);
    setFinishHimSeekBeat(b);
    if (finishHimPreviewing) arranger.seek(b);
  };
  const stopFinishHimPreview = () => { arranger.stop(); setFinishHimPreviewing(false); };
  // Phase 4A / 4A.1: render + download the Beat Finisher arrangement. Master,
  // Stems AND MPC all run through the offline arrangement renderer so the export
  // is the FULL arrangement (chops + drums, all sections, mutes) — sound-matched
  // to the preview. (MP3 not wired — no in-browser encoder.)
  const exportFinishHim = async (
    target: 'master' | 'stems' | 'mpc' | 'drum-rack',
    _format: 'wav' | 'mp3',
    secs: FinishArrangementSection[],
    onProgress: (pct: number, label: string) => void,
  ): Promise<string> => {
    // iOS: this export also ends in a share sheet (deliverFiles) that can reload
    // the tab — snapshot the session first, same as the main export path.
    snapshotSessionForExport();
    const title = engine.getState().trackTitle || 'beat-finisher';
    onProgress(0.05, 'Preparing…');
    arranger.stop();
    setFinishHimPreviewing(false);

    // Ableton Drum Rack: reuse the EXACT same exporter the main EXPORT section
    // uses (buildDrumRackZip → drums-first .adg + samples, mixer FX baked into
    // every one-shot). It's one-shot-based and arrangement-independent, so it
    // bypasses the arranger render path entirely.
    if (target === 'drum-rack') {
      onProgress(0.2, 'Building drum rack…');
      const { buildDrumRackZip } = await import('./exporters/drumRack');
      const { deliverFiles } = await import('../lib/download');
      const res = await buildDrumRackZip(engine, title, {
        drumEngine,
        onProgress: (pct) => onProgress(0.2 + (pct / 100) * 0.65, 'Rendering pads…'),
      });
      onProgress(0.9, 'Saving…');
      await deliverFiles([{ name: res.filename, data: res.bytes, mime: 'application/zip' }]);
      onProgress(1, 'Done');
      return `Drum Rack with ${res.padCount} pad${res.padCount === 1 ? '' : 's'} exported.`;
    }

    const arrangement = buildFinishArrangement(secs);
    const bpm = engine.getMasterBpm() || 90;
    const { exportArrangement } = await import('../arranger/exportArrangement');
    return exportArrangement({ engine, drumEngine, arrangement, bpm, target, title, bitDepth: 16, onProgress });
  };

  const [state, setState] = useState<ChopperState>(() => engine.getState());
  const [viewStart, setViewStart] = useState(0);
  const [viewEnd, setViewEnd] = useState(1);
  const viewRef = useRef({ viewStart: 0, viewEnd: 1 });
  // The waveform wrap element — the arrow keys gate on it being mounted (the
  // section unmounts when collapsed) and on-screen. A ref, not a querySelector:
  // a CSS class rename must not silently kill the feature.
  const waveformWrapRef = useRef<HTMLDivElement | null>(null);
  viewRef.current = { viewStart, viewEnd };
  const zoomAnchorRef = useRef<number>(0.5); // fractional position to zoom around
  // True once the user has manually set the zoom (buttons / scroll / pinch /
  // keyboard). While true, creating a chop or switching pads keeps the user's
  // zoom and only pans — it never re-zooms. Reset to false on a fresh track
  // load so the first chop snaps to the default zoom (DEFAULT_CHOP_ZOOM).
  const userZoomedRef = useRef(false);
  // Center zoom on the last-hit pad's chop start (keeps the pad you just played
  // in view), falling back to the current view midpoint when no pad has been
  // triggered or it has no position on the waveform. Reads engine.getState()
  // live so the keyboard handler (a useEffect closure) never sees a stale pad.
  const zoomCenterFrac = (): number => {
    const { viewStart: vs, viewEnd: ve } = viewRef.current;
    const mid = (vs + ve) / 2;
    const buf = engine.buffer;
    if (!buf) return mid;
    const st = engine.getState();
    const idx = st.lastTriggeredPad;
    if (idx == null) return mid;
    const pad = st.pads[idx];
    if (!pad || pad.chopId == null) return mid;
    const chop = st.chops.find(c => c.id === pad.chopId);
    return chop ? chop.start / buf.duration : mid;
  };
  const [playlists, setPlaylists] = useState<Playlist[]>([]);
  // Mirror of `playlists` for reads from async closures (session restore runs on
  // mount, before the playlist list has finished loading, so the closure's
  // captured `playlists` is still []). Lets syncPlaylistToTrack see the live list.
  const playlistsRef = useRef<Playlist[]>([]);
  useEffect(() => { playlistsRef.current = playlists; }, [playlists]);
  const [selectedPlaylist, setSelectedPlaylist] = useState<string>('');
  const [error, setError] = useState<string | null>(null);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);

  // ── Desktop theme menu ────────────────────────────────────────────────
  // The T-800 mark opens a two-column picker: ORIGINAL (HiFi `THEMES`, applied
  // via body[data-theme] + applyTheme) and MINIMAL (Baethoven `HW_PALETTES`,
  // applied as --hw-* role vars + data-palette on the .chopper-view root, which
  // cascades into the in-tree DAW mixer). Hover previews live; click locks.
  type DesktopTheme = { kind: 'original'; id: ThemeId } | { kind: 'minimal'; id: string };
  const DESKTOP_PALETTE_KEY = 'terminator.desktopPalette';
  const HW_ROLE_KEYS = ['bg', 'panel', 'pad', 'text', 'accent', 'border', 'muted', 'faint'] as const;
  const [lockedTheme, setLockedTheme] = useState<DesktopTheme>(() => {
    try {
      const pid = localStorage.getItem(DESKTOP_PALETTE_KEY);
      if (pid && HW_PALETTES.some(p => p.id === pid)) return { kind: 'minimal', id: pid };
    } catch { /* localStorage unavailable */ }
    return { kind: 'original', id: getStoredTheme() };
  });
  const [previewTheme, setPreviewTheme] = useState<DesktopTheme | null>(null);
  const [themeMenuRect, setThemeMenuRect] = useState<DOMRect | null>(null);
  // FINISH (themes.ts): classic vs 4K material. Persisted by applyFinish; the
  // body attribute + light engine follow through terminator:finish.
  const [finish, setFinish] = useState<Finish>(() => getFinish());
  const changeFinish = (f: Finish) => { setFinish(f); applyFinish(f); };
  const [dust, setDust] = useState<boolean>(() => getDust());
  const changeDust = (on: boolean) => { setDust(on); applyDust(on); };

  // ── Help + tooltips (Help.tsx) ────────────────────────────────────────────
  // The ? in the header opens the manual; the manual is also where tooltips are
  // switched on and off. Tips default ON — the person who needs them is the one
  // who has not been to the help menu yet.
  const [helpOpen, setHelpOpen] = useState(false);
  const helpOpenRef = useRef(false);
  helpOpenRef.current = helpOpen;
  const [tips, setTips] = useState(readTipsEnabled);
  const changeTips = (on: boolean) => { setTips(on); writeTipsEnabled(on); };
  const activeTheme: DesktopTheme = previewTheme ?? lockedTheme;
  const activePalette: HwPalette | null = activeTheme.kind === 'minimal' ? paletteById(activeTheme.id) : null;

  // Apply the active (preview ?? locked) theme's body-level state. The root div
  // carries data-palette + the --hw-* vars declaratively (see the return); here
  // we mirror the vars onto <body> for body-portalled popups (pad menu, theme
  // menu) and toggle body[data-theme] so an Original theme's literal-color rules
  // never fight a Minimal palette. No persistence — that happens on lock.
  useEffect(() => {
    const body = document.body;
    if (activeTheme.kind === 'minimal') {
      const p = paletteById(activeTheme.id);
      body.removeAttribute('data-theme');
      for (const k of HW_ROLE_KEYS) body.style.setProperty(`--hw-${k}`, p[k]);
      body.setAttribute('data-cv-palette', p.id);
      syncFinishAttrs(null);
    } else {
      for (const k of HW_ROLE_KEYS) body.style.removeProperty(`--hw-${k}`);
      body.removeAttribute('data-cv-palette');
      body.dataset.theme = activeTheme.id;
      syncFinishAttrs(activeTheme.id);
    }
    // The finish (4K material + light) is decided per theme; tell App so the
    // light engine starts/stops with a hover PREVIEW too, not only on lock.
    try { window.dispatchEvent(new CustomEvent('terminator:finish')); } catch { /* */ }
  }, [activeTheme.kind, activeTheme.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // App.tsx applies the stored ORIGINAL theme to <body> in its own mount effect,
  // which runs AFTER this child's effects — so if we booted into a Minimal
  // palette, re-drop body[data-theme] on the next frame so it doesn't clobber us.
  useEffect(() => {
    if (lockedTheme.kind !== 'minimal') return;
    const raf = requestAnimationFrame(() => document.body.removeAttribute('data-theme'));
    return () => cancelAnimationFrame(raf);
  }, []); // mount only — lockedTheme read once intentionally  // eslint-disable-line react-hooks/exhaustive-deps

  const openThemeMenu = (e: { currentTarget: HTMLElement }) =>
    setThemeMenuRect(e.currentTarget.getBoundingClientRect());
  const previewThemeItem = (kind: ThemeKind, id: string) =>
    setPreviewTheme(kind === 'original' ? { kind, id: id as ThemeId } : { kind, id });
  const endThemePreview = () => setPreviewTheme(null);
  const closeThemeMenu = () => { setPreviewTheme(null); setThemeMenuRect(null); };
  const lockThemeItem = (kind: ThemeKind, id: string) => {
    setPreviewTheme(null);
    setThemeMenuRect(null);
    if (kind === 'original') {
      setLockedTheme({ kind: 'original', id: id as ThemeId });
      try { localStorage.removeItem(DESKTOP_PALETTE_KEY); } catch { /* */ }
      applyTheme(id as ThemeId); // persists terminator.theme + meta + the bg-video event
    } else {
      setLockedTheme({ kind: 'minimal', id });
      try { localStorage.setItem(DESKTOP_PALETTE_KEY, id); } catch { /* */ }
      // body var mirror + data-theme drop handled by the activeTheme effect above
    }
  };
  const [mpcExportDir, setMpcExportDir] = useState<string | null>(null);
  const [cacheStatus, setCacheStatus] = useState<{ cached: number; total: number; sizeMB: number; estimatedMB: number } | null>(null);
  const [cacheDir, setCacheDirState] = useState<string>('');
  const [dlProgress, setDlProgress] = useState<{ done: number; total: number; currentTitle: string; active: string[] } | null>(null);
  const [midiInputs, setMidiInputs] = useState<string[]>([]);
  const [midiLearn, setMidiLearn] = useState(false);
  // Subscription upsell modal — opened when a free-tier user hits the
  // 10-pull cap or taps a locked feature.
  const [subModalOpen, setSubModalOpen] = useState(false);
  // DEMO (the site's download-page embed, ?demo=1): playable end to end, but
  // save / record / export / Beat Finisher and the locked themes open the
  // purchase popup instead. `demoSpent` = the 10-sample allowance is gone;
  // closing the popup then closes the sample browser, and BROWSE / GET SAMPLE
  // go straight to the popup until the page is reloaded.
  const demo = isDemo();
  const [demoSpent, setDemoSpent] = useState(false);
  const demoBlock = (): boolean => { if (!demo) return false; setSubModalOpen(true); return true; };
  // In-flight flag for the top-bar "Buy Terminator — $40" lifetime checkout.
  const [buyingLifetime, setBuyingLifetime] = useState(false);
  // Gate a pull attempt: subscribers always proceed; free tier counts
  // the call and pops the modal once they're over the limit.
  const gatePull = (): boolean => {
    if (demo && demoSpent) { setSubModalOpen(true); return false; }
    if (recordPull()) return true;
    if (demo) setDemoSpent(true);
    setSubModalOpen(true);
    flash(demo ? 'That was the demo\'s 10 samples — get Terminator for the whole crate.' : `Free tier limit reached. Subscribe for unlimited pulls.`);
    return false;
  };

  // ── AI Beat Arranger ──────────────────────────────────────────────────────
  const generateArrangements = async () => {
    if (!isSubscribed()) { setSubModalOpen(true); return; }
    arranger.stop();
    setArrPreviewIdx(null);
    setArrError(null);
    setArrLoading(true);
    try {
      const { request } = buildArrangerPayload(engine, drumEngine);
      if (request.chops.length === 0) {
        setArrError('Chop the sample and assign some pads first.');
        return;
      }
      const res = await fetch('/api/arranger', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(request),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({} as any));
        setArrError(j?.error || `Arranger request failed (${res.status})`);
        return;
      }
      const j = await res.json();
      setArrStructures(Array.isArray(j.structures) ? j.structures : []);
      setArrAcceptedIdx(null);
      if (!Array.isArray(j.structures) || j.structures.length === 0) {
        setArrError('No arrangements came back — try again.');
      }
    } catch {
      setArrError('Could not reach the arranger.');
    } finally {
      setArrLoading(false);
    }
  };

  const previewArrangement = (i: number) => {
    if (arrPreviewIdx === i) { arranger.stop(); setArrPreviewIdx(null); return; }
    const { chopToPad } = buildArrangerPayload(engine, drumEngine);
    const ds = drumEngine.getState();
    setArrPreviewIdx(i);
    void arranger.play(arrStructures[i], chopToPad, ds.pattern as any, ds.bars, () => setArrPreviewIdx(null));
  };

  const acceptArrangement = (i: number) => {
    arranger.stop();
    setArrPreviewIdx(null);
    setArrAcceptedIdx(i);
    flash('Arrangement accepted — export lands in the next update.');
  };
  // Free-tier pad gate: pads at/after this index are locked (null = subscriber
  // or desktop/local dev — no lock). Drives both the engine guard (real
  // enforcement, all trigger sources) and the greyed visual in PadGrid.
  const padLockFrom = isSubscribed() || demo ? null : FREE_PAD_LIMIT;
  const [midiLearnIdx, setMidiLearnIdx] = useState(0); // next pad to learn
  const [midiMap, setMidiMap] = useState<Record<number, number>>(() => {
    // MPC pad-bank mapping: pad bank A01 = C1 = MIDI note 36, so pad index 0
    // is triggered by note 36, pad 1 by note 37, … (A16 = D#2 = note 51).
    // Mapped across the rest of the MIDI range (notes 36-127 → pads 0-91);
    // pads beyond that are reachable via bank shift. Remappable via MIDI-learn.
    // Base note comes from midiPads.ts — the same one the hardware layout maps
    // through, so the two views cannot drift apart again.
    const m: Record<number, number> = {};
    for (let note = MPC_PAD_BASE_NOTE; note <= 127; note++) m[note] = note - MPC_PAD_BASE_NOTE;
    return m;
  });
  const [currentVideoId, setCurrentVideoId] = useState<string | null>(null);
  const [namedPresets, setNamedPresets] = useState<Array<{ id?: string; name: string; trackTitle?: string; savedAt: string; videoId: string; data?: ChopPreset }>>([]);
  const [presetName, setPresetName] = useState('');
  // DOM handles for the File menu's Save As (focus the name field) and Open
  // (focus the load dropdown) actions on desktop.
  const presetNameInputRef = useRef<HTMLInputElement | null>(null);
  const presetLoadSelectRef = useRef<HTMLSelectElement | null>(null);
  // Open Project modal (LOCAL | CLOUD). Cmd+O on Electron, LOAD button on web.
  const [openModalOpen, setOpenModalOpen] = useState(false);
  // The Supabase id of the preset the user LOADED (null for a fresh session). When
  // set and the name is unchanged, SAVE updates THAT row by id; renaming clears it
  // (→ SAVE AS, upsert-by-name). Cleared on a new track load / manual rename.
  const [loadedPresetId, setLoadedPresetId] = useState<string | null>(null);
  // Inline "name already exists — overwrite?" confirmation for upsert-by-name.
  const [confirmSave, setConfirmSave] = useState<{ name: string; existingId?: string } | null>(null);
  // In-flight guard — blocks a double-click / Cmd+S spam from racing two inserts
  // of the same new name into a duplicate (the table has no unique-name constraint).
  const [saving, setSaving] = useState(false);
  // A preset whose sample is one of YOUR OWN loaded files can't be re-fetched
  // (the audio isn't stored anywhere). Loading such a preset stashes it here as
  // a "pending snapshot": the waveform shows which file to reload, and once you
  // load a file whose name matches, the saved chops/pads/sequences apply to it.
  const [pendingPreset, setPendingPreset] = useState<{ data: ChopPreset; fileName: string; presetName: string } | null>(null);
  const [viewPadIdx, setViewPadIdx] = useState<number | null>(null); // null = main track waveform
  /** WAV or FLAC for the exports that can take it (see FLAC_CAPABLE). */
  const [exportAudioFmt, setExportAudioFmt] = useState<'wav' | 'flac'>('wav');
  const [dragOverWaveform, setDragOverWaveform] = useState(false);
  // Section collapse — keeps the layout tight on mobile and lets the user
  // hide whichever component they're not currently editing. Toolbar starts
  // open (it's the first thing they interact with); everything else
  // collapsed so the first screen is just the playlist picker + slim
  // section headers.
  const [collapsedToolbar, setCollapsedToolbar] = useState(false);
  const [collapsedWaveform, setCollapsedWaveform] = useState(true);
  const [collapsedPads, setCollapsedPads] = useState(true);

  // Keyboard pad-bank offset (mirrors PadGrid's −/= shift). Lifted to the view
  // so the SINGLE always-on keyboard→pad handler (defined after onPadTrigger,
  // below) drives BOTH the audio and PadGrid's visual bank, regardless of which
  // section is open. PadGrid's own window handler is disabled on web so there's
  // no double-trigger — see the keydown effect + the PadGrid captureKeyboard prop.
  const [padBank, setPadBank] = useState(0);
  const padBankRef = useRef(0); padBankRef.current = padBank;
  // DRUM PADS mode (toggled from the drum sequencer header): when on, pads 1-5
  // (and their keyboard keys + MIDI notes C1-E1) trigger the 5 drum tracks
  // instead of chops, and live-record into the drum sequencer while it plays.
  // Ref mirror so the always-on keyboard/MIDI handlers read the latest value.
  const [drumPadMode, setDrumPadMode] = useState(false);
  // DRUM PADS mode shows one pad per lane: the grid grows to the lane count
  // (forty lanes → forty pads; the keyboard banks 36 per page, MIDI is note = pad).
  useEffect(() => {
    if (drumPadMode) engine.growPadsTo(drumState.tracks.length);
  }, [drumPadMode, drumState.tracks.length, engine]);
  const drumPadModeRef = useRef(false); drumPadModeRef.current = drumPadMode;
  // Mirror the drum engine's STEP-record arm so the always-on pad/MIDI handlers
  // route a hit to recordStepHit (step mode) vs recordLiveHit (live mode).
  const drumStepRecRef = useRef(false);
  drumStepRecRef.current = drumEngine.getState().stepRecording;
  const [collapsedSeq, setCollapsedSeq] = useState(true);
  // (collapsedPresets removed — the PRESETS section was merged into LOAD.)
  // Web export section — same collapsible pattern as the other phone sections.
  const [collapsedExport, setCollapsedExport] = useState(true);
  // Layout switcher (DESKTOP only for now). The brand icon cycles:
  //   desktop: default → two-col → mpc → default
  // Mobile is locked to the "scroll + size" layout (size L by default) — no
  // layout switching there for now. Persisted so a reload keeps the choice.
  const [layout, setLayout] = useState<'default' | 'two-col' | 'mpc' | 'scroll-size'>(() => {
    try {
      const v = localStorage.getItem('terminator.layout');
      if (v === 'two-col' || v === 'mpc' || v === 'default') return v;
    } catch { /* */ }
    return 'default';
  });
  // Track portrait-phone so we can force the mobile layout + disable switching.
  const [isPhone, setIsPhone] = useState<boolean>(() => {
    try { return window.matchMedia('(max-width: 720px) and (orientation: portrait)').matches; } catch { return false; }
  });
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 720px) and (orientation: portrait)');
    const on = () => setIsPhone(mq.matches);
    mq.addEventListener?.('change', on);
    return () => mq.removeEventListener?.('change', on);
  }, []);
  // On a phone we always render the scroll+size layout regardless of the
  // (desktop-only) layout state.
  const effectiveLayout = isPhone ? 'scroll-size' : layout;
  const LAYOUT_LABELS = { 'default': 'DEFAULT', 'two-col': 'TWO-COL', 'mpc': 'MPC', 'scroll-size': 'SCROLL+SIZE' } as const;
  const cycleLayout = () => {
    if (isPhone) return;   // layout switching is desktop-only for now
    const list = ['default', 'two-col', 'mpc'] as const;
    const next = list[(list.indexOf(layout as any) + 1) % list.length];
    setLayout(next);
    setStatusMsg(`LAYOUT — ${LAYOUT_LABELS[next]}`);
    setTimeout(() => setStatusMsg(null), 1200);
  };
  const layoutLabel = LAYOUT_LABELS[effectiveLayout];
  const [uiSize, setUiSize] = useState<'S' | 'M' | 'L'>(() => {
    try { return (localStorage.getItem('terminator.uiSize') as any) || 'L'; } catch { return 'L'; }
  });
  useEffect(() => { try { localStorage.setItem('terminator.layout', layout); } catch { /* */ } }, [layout]);
  useEffect(() => { try { localStorage.setItem('terminator.uiSize', uiSize); } catch { /* */ } }, [uiSize]);

  // ── Section re-arrange mode (desktop / Electron only) ───────────────────────
  const chopperViewRef = useRef<HTMLDivElement>(null);
  const sectionRefs = useRef<Partial<Record<SectionId, HTMLDivElement | null>>>({});
  const [isRearranging, setIsRearranging] = useState(false);
  const [sectionLayout, setSectionLayout] = useState<SectionLayout>({});
  const [draggingSection, setDraggingSection] = useState<SectionId | null>(null);
  const [rearrangeHeight, setRearrangeHeight] = useState(0);
  const registerSectionRef = (id: SectionId, el: HTMLDivElement | null) => { sectionRefs.current[id] = el; };

  // A saved custom layout is "active" the moment it has any entries — sections
  // then stay absolutely positioned in normal mode (not just while editing).
  const hasCustomLayout = Object.keys(sectionLayout).length > 0;
  const layoutActive = isRearranging || hasCustomLayout;

  // Persisted layout lives in a JSON file in userData (via IPC). Load it once on
  // mount so a saved arrangement is applied immediately on launch.
  useEffect(() => {
    if (!ipc?.loadLayout) return;
    let cancelled = false;
    ipc.loadLayout().then(saved => {
      if (!cancelled && saved && typeof saved === 'object') setSectionLayout(saved);
    }).catch(() => { /* no saved layout yet */ });
    return () => { cancelled = true; };
  }, []);

  // Recompute the scroll height of the absolutely-positioned canvas so every
  // section stays reachable (absolute children don't grow their parent). Reads
  // live offsetHeight where available, falling back to the persisted height.
  const recomputeRearrangeHeight = (layoutMap: SectionLayout) => {
    let maxBottom = 0;
    for (const id of SECTION_IDS) {
      const p = layoutMap[id];
      if (!p) continue;
      const h = sectionRefs.current[id]?.offsetHeight || p.h || 0;
      maxBottom = Math.max(maxBottom, p.y + h);
    }
    setRearrangeHeight(maxBottom + 200);
  };

  const enterRearrange = () => {
    const view = chopperViewRef.current;
    if (!view) { setIsRearranging(true); return; }
    // Seed every section's position + size from where it currently sits, so the
    // sections don't collapse into a pile when they flip to position:absolute.
    // A previously-saved position wins; width/height are always re-measured so
    // they track the current content (collapsed state, zoom, etc.).
    const vr = view.getBoundingClientRect();
    const nextPos: SectionLayout = { ...sectionLayout };
    for (const id of SECTION_IDS) {
      const el = sectionRefs.current[id];
      if (!el) continue;
      // While already positioned the wrapper has its own box; otherwise it's
      // display:contents and we must measure the union of its children.
      const r = (el.offsetWidth || el.offsetHeight)
        ? el.getBoundingClientRect()
        : (childUnionRect(el) ?? el.getBoundingClientRect());
      if (!r || (r.width === 0 && r.height === 0)) continue;
      const w = Math.round(r.width);
      const h = Math.round(r.height);
      const existing = nextPos[id];
      nextPos[id] = existing
        ? { ...existing, w, h }
        : {
            x: Math.max(0, snap(r.left - vr.left)),
            y: Math.max(0, snap(r.top - vr.top + view.scrollTop)),
            w, h,
          };
    }
    setSectionLayout(nextPos);
    recomputeRearrangeHeight(nextPos);
    setIsRearranging(true);
  };

  const moveSection = (id: SectionId, p: { x: number; y: number }) => {
    // Preserve the section's measured w/h while updating its position.
    setSectionLayout(prev => ({ ...prev, [id]: { ...prev[id], ...p } }));
  };

  // Corner-drag resize updates the full box (x/y can shift when the top/left
  // edges move). w/h snap to the same 16px grid as positions.
  const resizeSection = (id: SectionId, p: SectionPos) => {
    setSectionLayout(prev => ({ ...prev, [id]: { ...prev[id], ...p } }));
  };

  // Once a resize gesture ends, nudge size-aware children (the waveform canvas)
  // to redraw at the new size. The canvas CSS-scales live, but a resize event
  // lets any listener re-fit to the new box.
  const handleSectionResizeEnd = () => {
    window.dispatchEvent(new Event('resize'));
  };

  // Keep the scroll canvas tall enough whenever a layout is active (editing or a
  // saved custom layout applied in normal mode). rAF so we measure post-paint.
  useEffect(() => {
    if (!layoutActive) { setRearrangeHeight(0); return; }
    const raf = requestAnimationFrame(() => recomputeRearrangeHeight(sectionLayout));
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sectionLayout, layoutActive]);

  const finishRearrange = () => {
    setDraggingSection(null);
    setIsRearranging(false);
    if (ipc?.saveLayout) ipc.saveLayout(sectionLayoutRef.current).catch(() => { /* best-effort */ });
  };

  const resetSectionLayout = () => {
    setSectionLayout({});
    setDraggingSection(null);
    setIsRearranging(false);
    if (ipc?.saveLayout) ipc.saveLayout({}).catch(() => { /* best-effort */ });
  };

  // Latest-value refs so the once-subscribed menu handlers never read stale
  // state (the IPC listeners below are wired once on mount).
  const isRearrangingRef = useRef(isRearranging);
  const sectionLayoutRef = useRef(sectionLayout);
  useEffect(() => { isRearrangingRef.current = isRearranging; }, [isRearranging]);
  useEffect(() => { sectionLayoutRef.current = sectionLayout; }, [sectionLayout]);

  // Wire the native Edit-menu items (desktop). The menu sends shortcut:* over
  // IPC; we toggle re-arrange / reset here. Subscribe once — handlers read the
  // refs above for current state.
  useEffect(() => {
    if (!ipc?.onShortcut) return;
    const offRe = ipc.onShortcut('rearrange', () => {
      if (isRearrangingRef.current) finishRearrange();
      else enterRearrange();
    });
    const offReset = ipc.onShortcut('resetLayout', () => resetSectionLayout());
    return () => { offRe(); offReset(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const [exportFormat, setExportFormat] = useState<ExportFormat>('wav-stems');
  const [exportBusy, setExportBusy] = useState(false);
  const [showExportModal, setShowExportModal] = useState(false);
  const [exportMsg, setExportMsg] = useState<string | null>(null);
  const [exportProgress, setExportProgress] = useState<number | null>(null);
  // Web: TAP tempo mode. When armed, pad taps feed the BPM-from-intervals
  // calculator instead of playing the pad. Useful on mobile where it's
  // hard to repeat-tap a tiny TAP button. Disarmed by tapping TAP again.
  const [tapArmed, setTapArmed] = useState(false);
  const tapArmedRef = useRef(false); tapArmedRef.current = tapArmed;
  const tapTimesRef = useRef<number[]>([]);
  const tapResetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const handleTapHit = () => {
    const now = performance.now();
    const last = tapTimesRef.current[tapTimesRef.current.length - 1];
    if (last !== undefined && now - last > 2000) tapTimesRef.current = [];
    tapTimesRef.current.push(now);
    if (tapTimesRef.current.length > 8) tapTimesRef.current.shift();
    if (tapTimesRef.current.length >= 2) {
      const ts = tapTimesRef.current;
      const intervals: number[] = [];
      for (let i = 1; i < ts.length; i++) intervals.push(ts[i] - ts[i - 1]);
      const avg = intervals.reduce((s, x) => s + x, 0) / intervals.length;
      const bpm = Math.round(60000 / avg);
      engine.setMetronomeBpm(Math.max(20, Math.min(300, bpm)));
    }
    if (tapResetTimerRef.current) clearTimeout(tapResetTimerRef.current);
    tapResetTimerRef.current = setTimeout(() => { tapTimesRef.current = []; }, 2000);
  };
  const [midiEnabled, setMidiEnabled] = useState(true);
  const [midiKillNote, setMidiKillNote] = useState<number | null>(null);
  const [midiLearnKill, setMidiLearnKill] = useState(false);
  // Tap-tempo via MIDI: learn a note that registers a tap each time it fires.
  const [midiTapNote, setMidiTapNote] = useState<number | null>(() => {
    const v = Number(localStorage.getItem('terminator.midiTapNote'));
    return Number.isFinite(v) && v > 0 ? v : null;
  });
  const [midiLearnTap, setMidiLearnTap] = useState(false);
  const midiEnabledRef = useRef(true);
  const midiMapRef = useRef<Record<number, number>>({});
  const midiLearnRef = useRef(false);
  const midiLearnIdxRef = useRef(0);
  const midiKillNoteRef = useRef<number | null>(null);
  const midiLearnKillRef = useRef(false);
  const midiTapNoteRef = useRef<number | null>(null);
  const midiLearnTapRef = useRef(false);
  // The MIDI effect mounts once (deps [engine]), so the free-tier pad lock has
  // to reach it through a ref or it would be frozen at its first value.
  const padLockFromRef = useRef<number | null>(null);
  midiEnabledRef.current = midiEnabled;
  midiMapRef.current = midiMap;
  midiLearnRef.current = midiLearn;
  midiLearnIdxRef.current = midiLearnIdx;
  midiKillNoteRef.current = midiKillNote;
  midiLearnKillRef.current = midiLearnKill;
  midiTapNoteRef.current = midiTapNote;
  midiLearnTapRef.current = midiLearnTap;
  padLockFromRef.current = padLockFrom;
  // NATIVE (3.5): the C++ engine plays MIDI notes on its direct driver→engine path ONLY while this page would route
  // them to pads — off for MIDI OFF, DRUM PADS mode, pad learn and bass MIDI IN (the page owns those notes); and the
  // engine's note → pad table follows the (learned) map. No-ops outside the native shell (engine.midiSink is null).
  const midiRoutingRef = useRef(true);
  const pushMidiRouting = () => {
    const on = midiEnabledRef.current && !drumPadModeRef.current && !midiLearnRef.current && !bassMidiRef.current;
    if (on === midiRoutingRef.current) return;
    midiRoutingRef.current = on;
    engine.midiSink?.routing(on);
  };
  useEffect(() => { pushMidiRouting(); }, [midiEnabled, drumPadMode, midiLearn]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { engine.midiSink?.noteMap(midiMap); }, [engine, midiMap]);

  useEffect(() => {
    const unsub = engine.subscribe(setState);
    return () => { unsub(); };
  }, [engine]);

  // Load the persisted MIDI CC → parameter map once on mount (Electron only —
  // the store is inert without the preload bridge, so this is a no-op on web).
  useEffect(() => { void midiMapStore.load(); }, []);

  // The MIDI LEARN button drives the unified CC-mapping learn mode: while it's
  // on, every mappable control highlights and can be armed by clicking it.
  // (Incoming NOTES still map to pads, as before — notes and CCs don't clash.)
  useEffect(() => { midiMapStore.setLearnMode(midiLearn); }, [midiLearn]);

  // User-added drum lanes get their own mixer strip, wired the same way the
  // five defaults are (per-track tap → channel input). Runs whenever the track
  // list changes rather than at add-time, so it also covers lanes that arrive
  // via a preset restore or an undo. addChannel is idempotent.
  // Bumped whenever a strip is created or destroyed. MixerSection renders from
  // the module-level REGULAR_CHANNELS array, and mutating an array can't wake
  // React — without this the mixer showed the channel list exactly one render
  // stale (added strips appeared late, removed ones lingered).
  const [mixerRev, setMixerRev] = useState(0);
  useEffect(() => {
    let changed = false;
    for (const t of drumState.tracks) {
      if (!t.added) continue;
      if (!mixerEngine.channels.has(t.key)) changed = true;
      mixerEngine.addChannel(t.key);
      // The strip UI has no static entry for a lane the user invented, so give
      // it the lane's own name + colour to render with.
      const metaBefore = JSON.stringify(mixerEngine.channelMeta.get(t.key) ?? null);
      mixerEngine.setChannelMeta(t.key, t.name.toUpperCase(), t.color);
      if (JSON.stringify(mixerEngine.channelMeta.get(t.key) ?? null) !== metaBefore) changed = true; // lane renamed/recoloured
      drumEngine.routeTrackOutput(t.key, mixerEngine.getChannelInput(t.key));
    }
    // Drop strips whose lane is gone (removed lane / restore without it).
    for (const name of [...mixerEngine.channels.keys()]) {
      if (DEFAULT_REGULAR_CHANNELS.includes(name) || SEND_CHANNELS.includes(name) || name === 'bass' || /^sample\d+$/.test(name)) continue;
      if (!drumState.tracks.some(t => t.key === name)) { mixerEngine.removeChannel(name); changed = true; }
    }
    if (changed) setMixerRev(v => v + 1); // the mixer is memoized — it re-renders on this prop
  }, [drumState.tracks, mixerEngine, drumEngine]);

  // MIXER ROUTING — one strip per SOURCE. Every route the engine knows
  // ('sample2'…) gets a strip right after the last SAMPLE strip, labelled
  // SAMPLE n in its source's colour, and its bus wired into the strip. A strip
  // no occupied pad plays through any more is removed — but only while it is
  // pristine (a tuned chain/fader is never thrown away; re-route a pad to it
  // or clear it by hand). SAMPLE reads "SAMPLE 1" once other SAMPLE strips exist.
  const [routesRev, setRoutesRev] = useState(0);
  useEffect(() => { engine.onRoutesChanged = () => setRoutesRev(v => v + 1); return () => { engine.onRoutesChanged = null; }; }, [engine]);
  const wiredRoutesRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    let changed = false;
    // Live truth from the engine, not React state: onRoutesChanged fires before
    // the state that carries the new route lands, and a stale snapshot would
    // prune the strip that was just created.
    const used = engine.routesInUse();
    const known = engine.routeNames().filter(r => r !== 'sample');
    for (const name of known) {
      if (!mixerEngine.channels.has(name)) {
        const last = REGULAR_CHANNELS.filter(n => /^sample\d*$/.test(n)).pop() ?? 'sample';
        mixerEngine.addChannel(name, { after: last });
        changed = true;
      }
      const src = engine.sourcesOnRoute(name)[0]
        ?? engine.padsOnRoute(name).map(i => engine.padSourceKey(i)).find(Boolean)
        ?? `route:${name}`;
      const metaBefore = JSON.stringify(mixerEngine.channelMeta.get(name) ?? null);
      mixerEngine.setChannelMeta(name, `SAMPLE ${name.slice(6)}`, sourceColor(src));
      if (JSON.stringify(mixerEngine.channelMeta.get(name) ?? null) !== metaBefore) changed = true; // name/colour moved
      if (!wiredRoutesRef.current.has(name)) {
        engine.routeOutput(name).connect(mixerEngine.getChannelInput(name));
        wiredRoutesRef.current.add(name);
      }
    }
    for (const name of [...mixerEngine.channels.keys()]) {
      if (!/^sample\d+$/.test(name) || used.has(name)) continue;
      if (!mixerEngine.isPristine(name)) continue;
      mixerEngine.removeChannel(name);
      engine.dropRoute(name);
      wiredRoutesRef.current.delete(name);
      changed = true;
    }
    const others = [...mixerEngine.channels.keys()].some(n => /^sample\d+$/.test(n));
    const meta = mixerEngine.channelMeta.get('sample');
    if (others && meta?.label !== 'SAMPLE 1') { mixerEngine.setChannelMeta('sample', 'SAMPLE 1', '#e7a977'); changed = true; }
    if (!others && meta) { mixerEngine.channelMeta.delete('sample'); changed = true; }
    if (changed) setMixerRev(v => v + 1); // the mixer is memoized — it re-renders on this prop
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.padRoutes, state.sourceRoutes, routesRev, mixerEngine, engine]);
  const mixerTracks = useMemo(() => {
    void mixerRev; void routesRev;
    return [...mixerEngine.channels.keys()].filter(n => /^sample\d*$/.test(n)).map(n => {
      const m = mixerEngine.channelMeta.get(n);
      return { name: n, label: m?.label ?? (n === 'sample' ? 'SAMPLE' : `SAMPLE ${n.slice(6)}`), color: m?.color ?? '#e7a977' };
    });
  }, [mixerEngine, mixerRev, routesRev, state.padRoutes]);

  // Enforce the free-tier pad lock in the engine so keyboard / MIDI / arp /
  // chop-click can't bypass it (CSS pointer-events only blocked the mouse).
  useEffect(() => {
    engine.setPadLock(padLockFrom);
  }, [engine, padLockFrom]);

  // Smooth playhead WITHOUT per-frame React churn: previously this drove
  // setState(engine.getState()) every rAF, which deep-cloned chops/pads/seqGrid
  // and forced a full re-render 60×/sec (GC + reconciliation jank). Now the
  // WaveformView owns a local rAF that reads engine.getPlayheadPos() and
  // repaints only the cursor — zero React commits during playback.
  //
  // Only a seed value: pad hits no longer push a new ChopperState, so this goes
  // stale the moment a voice starts. WaveformView gates its own loop off the
  // engine's activity channel — this is just what it starts with.
  const isPlaying = state.playbackPos >= 0;
  // The transport LIGHTS: PLAY is green while the sequencer or the drum
  // sequencer is running (not merely while a pad voice rings), STOP is red
  // the rest of the time. isPlaying above is voice-level and would flicker
  // between chops / stay dark for a drums-only groove.
  const transportOn = state.seqPlaying || drumState.playing;
  // ONE SWING KNOB, BOTH SEQUENCERS: the drum SWING value also swings the chop
  // seq (his "full beat from chopped samples" — a swung beat's chops and drums
  // must land on the same late off-beat).
  useEffect(() => { engine.setSeqSwing(drumState.drumSwing ?? 0); }, [engine, drumState.drumSwing]);

  useEffect(() => {
    // R2 library playlists. BOTH web and Electron build them from the R2 manifest
    // so every entry carries the Drive id that hits r2.ts's trackById directly —
    // preview then resolves instantly for ALL playlists. Web does this through its
    // ipc-browser shim (listPlaylistsForRenderer + IndexedDB cache); Electron's
    // real ipc.listPlaylists reads local bundled data/*.json keyed by YouTube id
    // (n64/atari/ps1 titles don't match the manifest, so the title bridge can't
    // resolve them), so on desktop we read the manifest directly instead. The IPC
    // path stays as the OFFLINE fallback only (local bundled library).
    const load = async () => {
      let pls: Array<{ name: string; entries: Array<{ id: string; title: string; duration?: number }> }> = [];
      if (isWeb) {
        if (!ipc?.listPlaylists) return;
        pls = await ipc.listPlaylists();
      } else {
        try {
          pls = await listPlaylistsForRenderer(); // manifest → Drive ids (loads + indexes trackById)
        } catch {
          // Manifest unreachable (offline) → fall back to the local bundled JSON.
          pls = ipc?.listPlaylists ? await ipc.listPlaylists() : [];
        }
      }
      setPlaylists(pls);
      if (pls.length === 0) return;
      if (isWeb) {
        // Web build defaults to the "Chandeliers" playlist when it's in the
        // Drive list — that's the curated starting point. Loose match folds
        // case + accents + unicode-styled characters so a stylized folder
        // name still hits. Falls back to the first playlist if absent.
        const fold = (s: string) =>
          s.normalize('NFKD').replace(/[^\p{L}\p{N}]/gu, '').toLowerCase();
        const chandeliers = pls.find(p => fold(p.name).includes('chandeliers'));
        setSelectedPlaylist((chandeliers ?? pls[0]).name);
      } else {
        setSelectedPlaylist(pls[0].name);
      }
    };
    void load();
  }, []);

  useEffect(() => {
    ipc?.getCacheDir?.().then(setCacheDirState);
  }, []);

  // Web presets live in Supabase via the KCC /api/terminator-presets route
  // (same-origin, cookie auth). The full ChopPreset blob is stored in the
  // row's `pattern` column. Desktop keeps using the Electron ipc store.
  const refreshWebPresets = async () => {
    try {
      let rows: any[];
      if (!isWeb) {
        // Electron: the main process fetches the cloud list with the device token.
        rows = (await ipc?.cloudPresetsList?.()) ?? [];
      } else {
        const r = await fetch('/api/terminator-presets', { credentials: 'same-origin' });
        if (!r.ok) { setNamedPresets([]); return; }
        rows = await r.json();
      }
      setNamedPresets(rows.map(row => ({
        id: row.id,
        name: row.name,
        trackTitle: row.pattern?.trackTitle,
        savedAt: row.created_at,
        videoId: row.pattern?.videoId ?? '',
        data: row.pattern as ChopPreset,
      })));
    } catch { /* offline or not signed in — leave list empty */ }
  };

  // Load named presets list on mount
  useEffect(() => {
    if (cloudPresets) void refreshWebPresets();
    else ipc?.listNamedPresets?.().then(setNamedPresets);
  }, []);

  useEffect(() => {
    if (!ipc?.onMpcStatus) return;
    return ipc.onMpcStatus(setMpcExportDir);
  }, []);

  // Refresh cache status whenever the selected playlist changes
  useEffect(() => {
    if (!ipc?.getCacheStatus || !selectedPlaylist) return;
    ipc.getCacheStatus(selectedPlaylist).then(setCacheStatus);
  }, [selectedPlaylist]);

  // Listen for batch-download progress events
  useEffect(() => {
    if (!ipc?.onCacheProgress) return;
    return ipc.onCacheProgress(p => {
      if (p.playlistName !== selectedPlaylist) return;
      setDlProgress({ done: p.done, total: p.total, currentTitle: p.currentTitle, active: p.active });
      if (p.done >= p.total) {
        setDlProgress(null);
        ipc.getCacheStatus!(p.playlistName).then(setCacheStatus);
      }
    });
  }, [selectedPlaylist]);

  const handleDownloadPlaylist = async () => {
    if (!ipc?.downloadPlaylist || !selectedPlaylist) return;
    const pl = playlists.find(p => p.name === selectedPlaylist);
    setDlProgress({ done: 0, total: pl?.entries.length ?? 0, currentTitle: '', active: [] });
    await ipc.downloadPlaylist(selectedPlaylist);
    setDlProgress(null);
    ipc.getCacheStatus!(selectedPlaylist).then(setCacheStatus);
  };

  const handleDeleteCache = async () => {
    if (!ipc?.deletePlaylistCache || !selectedPlaylist) return;
    await ipc.deletePlaylistCache(selectedPlaylist);
    ipc.getCacheStatus!(selectedPlaylist).then(setCacheStatus);
    flash('Cache deleted');
  };

  useEffect(() => {
    return () => { engine.dispose(); };
  }, [engine]);
  // Terminator 3.0: the pads sound through the native C++ engine (no-op in Electron / the browser)
  useEffect(() => attachNativeEngineShadow(engine, drumEngine, bassEngine), [engine, drumEngine, bassEngine]);

  // Keep keyboard focus on the document so pad keys always work after clicking UI elements
  useEffect(() => {
    const onMouseDown = (e: MouseEvent) => {
      const t = e.target as Element;
      // Allow inputs (including range/faders), textareas, and selects to handle mousedown normally
      if (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement) return;
      // Pull keyboard focus to THIS window. On the embedded KCC site the app
      // lives in an iframe — the parent page holds focus, so pad KEYS never
      // reach us until the iframe is focused. preventDefault alone can suppress
      // that focus, so request it explicitly here.
      try { window.focus(); } catch { /* */ }
      e.preventDefault(); // prevents buttons/divs from stealing keyboard focus
    };
    const onMouseUp = (e: MouseEvent) => {
      const t = e.target as Element;
      // Blur faders after interaction so arrow/pad keys work immediately
      if (t instanceof HTMLInputElement && (t as HTMLInputElement).type === 'range') {
        setTimeout(() => (t as HTMLElement).blur(), 0);
      }
    };
    // Blur selects after selection so pad keys work immediately after using a dropdown
    const onSelectChange = (e: Event) => {
      if (e.target instanceof HTMLSelectElement) (e.target as HTMLElement).blur();
    };
    document.addEventListener('mousedown', onMouseDown);
    document.addEventListener('mouseup', onMouseUp);
    document.addEventListener('change', onSelectChange);
    return () => {
      document.removeEventListener('mousedown', onMouseDown);
      document.removeEventListener('mouseup', onMouseUp);
      document.removeEventListener('change', onSelectChange);
    };
  }, []);

  // MIDI input — default map follows the MPC pad bank (note 36/C1 = pad A01,
  // note 37 = pad 1, … see midiMap init above), remappable via MIDI-learn.
  // Note-on triggers, note-off releases.
  useEffect(() => {
    // Everything below is ROUTING; the hub owns access, hot-plug, port
    // opening, status and the monitor (midiHub.ts).
    const onMessage = (e: MIDIMessageEvent) => {
      if (!midiEnabledRef.current) return;
      const [status, note, velocity] = e.data as unknown as [number, number, number];

      // ── Transport, from the hardware ────────────────────────────────────────
      // System Real-Time messages are SINGLE BYTE and must be matched on the
      // FULL status byte, before the 0xf0 channel mask — masking collapses every
      // one of them to 0xF0 and loses which it was. (Until now they fell through
      // the note checks and were silently dropped.)
      //
      // These are exactly what an MPC — or any clock master — transmits when you
      // press PLAY and STOP on the machine, so the transport follows the hardware
      // with nothing to map and nothing to configure.
      // While the hardware owns the transport (its START until its STOP) its
      // CLOCK owns the tempo too — otherwise Terminator runs at its own BPM and
      // the two drift apart within a bar (his ask 2026-08-22: "when I hit play
      // on the MPC it plays Terminator" — in time, not just at the same moment).
      // The port this message came from — an MPC sends transport + clock on
      // EVERY port it exposes, so one press must not count twice (MidiClockSourceLock).
      const port = ((e.target as MIDIInput | null)?.id) ?? ((e.currentTarget as MIDIInput | null)?.id) ?? 'midi';
      const lock = clockLockRef.current!;
      if (status === 0xfa || status === 0xfb) {                     // START (from the top) / CONTINUE
        if (!lock.onStart(port, e.timeStamp)) return;               // the same press, seen on another port
        clockFollow.reset(); clockFollowOnRef.current = true; startTransportRef.current(); return;
      }
      if (status === 0xfc) { lock.onStop(port); clockFollowOnRef.current = false; stopTransportRef.current(); return; }   // STOP
      // Clock ticks land 24× per quarter note and Active Sensing every ~300ms.
      // Return rather than fall through, so the busiest messages on the wire
      // never reach the pad path. Only the owning port's ticks count, and the
      // TEMPO only moves when Preferences → MIDI → follow tempo is on.
      if (status === 0xf8) {
        if (clockFollowOnRef.current && clockFollowTempoRef.current && lock.onTick(port)) {
          const bpm = clockFollow.onTick(e.timeStamp); if (bpm) engine.setMetronomeBpm(bpm);
        }
        return;
      }
      if (status === 0xfe) return;

      const cmd = status & 0xf0;

      // Control Change → MIDI CC mapping. Try the unified MidiMap store first
      // (BPM / pitch / mixer faders / clip). If this CC isn't one it owns, fall
      // back to the legacy per-knob FX manager (cutoff / EQ / delay / etc.).
      // Handled synchronously so there's no added latency.
      if (cmd === 0xb0) {
        if (!midiMapStore.handleCC(note, velocity)) midiCc.handleCC(note, velocity);
        return;
      }

      // Pitch bend → the bass synth, over the bass BEND range (±2 default, ±12
      // from the lane's toolbar). Only while BASS MIDI IN is on — the wheel has
      // no other home yet. With ● REC running it also writes the BEND lane.
      if (cmd === 0xe0) {
        if (bassMidiRef.current) bassEngine.setBend((((velocity << 7) | note) - 8192) / 8192 * (bassEngine.getState().bendRange ?? 2));
        return;
      }
      const isNoteOn  = cmd === 0x90 && velocity > 0;
      const isNoteOff = cmd === 0x80 || (cmd === 0x90 && velocity === 0);
      if (!isNoteOn && !isNoteOff) return;

      // Pad learn mode: map incoming note → next pad in sequence. Must be
      // checked BEFORE the tap/kill trigger checks so a stored tap/kill note
      // can still be re-mapped to a pad while learning is active.
      if (isNoteOn && midiLearnRef.current) {
        const learnIdx = midiLearnIdxRef.current;
        setMidiMap(prev => ({ ...prev, [note]: learnIdx }));
        setMidiLearnIdx(learnIdx + 1);
        return;
      }

      // Tap-tempo learn: assign incoming note as the tap trigger
      if (isNoteOn && midiLearnTapRef.current) {
        setMidiTapNote(note);
        setMidiLearnTap(false);
        try { localStorage.setItem('terminator.midiTapNote', String(note)); } catch { /* */ }
        return;
      }
      // Tap-tempo trigger
      if (isNoteOn && note === midiTapNoteRef.current) {
        handleTapHit();
        return;
      }

      // Kill learn mode: assign incoming note as kill trigger
      if (isNoteOn && midiLearnKillRef.current) {
        setMidiKillNote(note);
        setMidiLearnKill(false);
        return;
      }

      // Kill trigger
      if (isNoteOn && note === midiKillNoteRef.current) {
        engine.stopAllPads();
        return;
      }

      // TAP armed: every MIDI note-on is a tap (the note still plays below) —
      // same as the pads on screen while TAP is lit.
      if (isNoteOn && tapArmedRef.current) handleTapHit();
      // BASS MIDI IN: the controller plays the synth (scale-locked when LOCK is
      // on; records into the pattern when REC is armed and the transport runs).
      // Same handler-lag compensation as the drum path.
      if (bassMidiRef.current) {
        const ctx = engine.ctx;
        const midiLatency = (performance.now() - e.timeStamp) / 1000;
        const when = Math.max(ctx.currentTime, ctx.currentTime - midiLatency + ctx.baseLatency);
        // An MPC / MPD (pads, not keys): pad 4 = the root, every pad a different
        // note of the key — see BassEngine.mpcNoteOn. Keyboards play as written.
        const portName = (e.target as MIDIInput | null)?.name ?? '';
        const fromPads = /\bMPC\b|\bMPD\b|MPC ?(One|Live|X|Key|Studio|Sample|Touch|Element)/i.test(portName);
        if (fromPads) { if (isNoteOn) bassEngine.mpcNoteOn(note, velocity / 127, when); else bassEngine.mpcNoteOff(note, when); return; }
        if (isNoteOn) bassEngine.noteOn(note, velocity / 127, when);
        else bassEngine.noteOff(note, when);
        return;
      }
      const padIdx = midiMapRef.current[note];
      if (padIdx === undefined) return;
      // DRUM PADS mode: a note mapping to pad i fires drum lane i (every lane,
      // added ones too) and live-records into the sequencer; note-offs are
      // ignored (one-shots).
      if (drumPadModeRef.current && padIdx < drumTracksRef.current.length) {
        if (isNoteOn) {
          if (drumStepRecRef.current) {
            // Step input: play now (handler-lag comped) + fill the cursor step.
            const ctx = engine.ctx;
            const midiLatency = (performance.now() - e.timeStamp) / 1000;
            const when = Math.max(ctx.currentTime, ctx.currentTime - midiLatency + ctx.baseLatency);
            drumEngine.playLive(drumTracksRef.current[padIdx].key, 0, when);
            drumEngine.recordStepHit(padIdx);
          } else {
            // liveHit owns ALL the live timing: handler-lag backdating (MIDI
            // used to record later than the keyboard here — the play was
            // comped but the record read the handler's clock), output-latency
            // comp, and grid-ON audible quantize while recording.
            drumEngine.liveHit(padIdx, e.timeStamp);
          }
        }
        return;
      }
      // Pass the MIDI event's own timestamp through, exactly as the keyboard
      // path does. It does NOT move the audio (startVoice fires immediately
      // either way) — it is what lets LIVE record subtract the handler lag when
      // deciding which step the hit belongs on. Without it, a hit played from a
      // controller was quantized from the moment the handler happened to run
      // rather than the moment the note arrived, so MIDI hits recorded slightly
      // later than the same performance typed on the keyboard.
      if (isNoteOn) {
        // Logged before the pad lock below so the latency meter measures the
        // MIDI transport itself, which is the same whether the pad sounds.
        engine.recordInputLag(e.timeStamp);
        // Locked pad (free tier): the engine drops these SILENTLY, so without
        // this a MIDI hit on a pad past the limit is silence with no
        // explanation at all — pads 1-3 sound, the rest just don't. The
        // mouse/keyboard path has always popped the upsell here; MIDI went
        // straight to engine.triggerPad and skipped it. Re-opening an already
        // open modal is a no-op, so holding a locked pad down doesn't churn.
        const lock = padLockFromRef.current;
        if (lock !== null && padIdx >= lock) { setSubModalOpen(true); return; }
        // NATIVE (3.5): a note the C++ MidiHub mirrored was ALREADY played by the engine on its direct path —
        // run the TS hit for the LEDs / record / chokes only (nativeOwned: the voice sink does not re-trigger it)
        engine.triggerPad(padIdx, velocity / 127, e.timeStamp, (e as unknown as { nativeOwned?: boolean }).nativeOwned ? { nativeOwned: true } : undefined);
      }
      if (isNoteOff) engine.releasePad(padIdx);
    };

    const offMsg = midiHub.onMessage(onMessage);
    const offState = midiHub.subscribe((st) => setMidiInputs(st.inputs));
    return () => { offMsg(); offState(); };
  }, [engine]);

  const flash = (msg: string, ms = 4000) => {
    setStatusMsg(msg);
    setTimeout(() => setStatusMsg(s => (s === msg ? null : s)), ms);
  };
  // The engine's one-line notes (a refused chop-tap says why) land on the same status line.
  useEffect(() => { engine.onNote = (m) => flash(m, 2500); return () => { engine.onNote = null; }; }, [engine]); // eslint-disable-line react-hooks/exhaustive-deps

  // Resolve audio bytes from an IPC response — cache hits come back as a URL
  // served by the terminator-cache:// protocol (no IPC byte transfer)
  const resolveAudio = async (res: { audio?: ArrayBuffer; cacheUrl?: string }): Promise<ArrayBuffer> => {
    if (res.cacheUrl) {
      const r = await fetch(res.cacheUrl);
      if (!r.ok) throw new Error(`Cache fetch failed: ${r.status}`);
      return r.arrayBuffer();
    }
    if (res.audio) return res.audio;
    throw new Error('No audio data in response');
  };

  /** Fetch a track by id/url. Supports a `local:<staticPath>` pseudo-id so
   *  easter-egg picks can return a bundled asset (e.g. the Guile acapella)
   *  without going through yt-dlp. Falls through to the normal IPC path
   *  for real YouTube ids. */
  const fetchTrackData = async (
    idOrUrl: string,
    fallbackTitle?: string,
  ): Promise<{ ok: boolean; audio?: ArrayBuffer; cacheUrl?: string; title?: string; videoId?: string; durationSec?: number; error?: string }> => {
    // A user file kept in the ASSET STORE (projectAssets.ts) — reload it from
    // this device; if it isn't here, say which sample is missing.
    if (idOrUrl.startsWith(ASSET_PREFIX)) {
      const a = await assetStore.get(assetHash(idOrUrl));
      if (!a) return { ok: false, error: `This project's sample "${fallbackTitle ?? idOrUrl.slice(6, 14)}" isn't on this device — LOAD FILE it here, or TRANSFER the project from the device that has it` };
      return { ok: true, audio: a.data.slice(0), title: fallbackTitle ?? a.name.replace(/\.[^.]+$/, ''), videoId: idOrUrl };
    }
    if (idOrUrl.startsWith('local:')) {
      const url = idOrUrl.slice('local:'.length);
      const r = await fetch(url);
      if (!r.ok) return { ok: false, error: `Local fetch failed: ${r.status}` };
      const audio = await r.arrayBuffer();
      return { ok: true, audio, title: fallbackTitle ?? url, videoId: idOrUrl };
    }
    // Electron: R2 sample ids (Drive/synthetic, not YouTube) can't go through
    // yt-dlp — fetch the bytes straight from R2 so GET SAMPLE / OR URL / browser
    // LOAD / preset + session restore all resolve them through this one path.
    if (!isWeb && looksLikeR2Id(idOrUrl)) {
      const res = await fetchR2Audio(idOrUrl);
      return { ok: true, audio: res.audio, title: res.title, videoId: res.videoId ?? idOrUrl, durationSec: res.durationSec };
    }
    if (!ipc?.downloadYouTube) return { ok: false, error: 'IPC unavailable' };
    return ipc.downloadYouTube(idOrUrl);
  };

  // Build/apply a FULL session preset. The chopper engine owns chops/pads/FX;
  // the drum engine lives alongside it, so we attach + restore its state here.
  // Keeping both behind one pair of helpers guarantees save/load stay symmetric.
  const buildPreset = (videoId: string): ChopPreset => withAssetManifest({
    ...engine.getPresetData(videoId),
    sourceStems: engine.sourceStemsSnapshot(), // STEMS PER SOURCE — each pad sample's split rides with the project
    drums: drumEngine.serialize(),
    bass: bassEngine.serialize(),
    mixer: mixerEngine.serialize(),
  });
  // Pad samples: `padBufferMeta` was SAVED for years but never restored by any
  // load path — pads with their own sample came back empty. Fetch each one
  // (asset store / R2 / YouTube by id) and put it back on its pad, in the
  // background so the main sample + grid land first.
  const restorePadSamples = async (preset: ChopPreset): Promise<void> => {
    const meta = preset.padBufferMeta ?? {};
    const idxs = Object.keys(meta).map(Number).filter((n) => Number.isFinite(n));
    if (!idxs.length) return;
    let missing = 0;
    // A chopped source = several pads sharing one videoId with different trims:
    // fetch + decode it ONCE and hand every pad the same AudioBuffer (that is
    // also what makes them one BLOCK again — padSourceChops matches on buffer).
    const decoded = new Map<string, { buf: AudioBuffer; videoId: string; title?: string } | null>();
    const restoredStemSources = new WeakSet<AudioBuffer>();
    for (const idx of idxs) {
      const m = (meta as any)[idx] as { videoId: string; title?: string; start?: number; end?: number } | undefined;
      if (!m || !m.videoId || m.videoId.startsWith('local_')) { if (m?.videoId?.startsWith('local_')) missing++; continue; }
      try {
        let d = decoded.get(m.videoId);
        if (d === undefined) {
          const res = await fetchTrackData(m.videoId, m.title);
          if (!res.ok) { decoded.set(m.videoId, null); missing++; continue; }
          const audio = await resolveAudio(res);
          const buf = await engine.decodeAudio(audio);
          d = { buf, videoId: res.videoId ?? m.videoId, title: res.title };
          decoded.set(m.videoId, d);
        } else if (d === null) { missing++; continue; }
        engine.loadPadBuffer(idx, d.buf, d.videoId, m.title ?? d.title ?? 'sample', m.start, m.end);
        // STEMS PER SOURCE: this sample's split comes back from the asset store
        // (once per source; missing assets = its pads play the original).
        const sm = preset.sourceStems?.[m.videoId] ?? preset.sourceStems?.[d.videoId];
        if (sm && !restoredStemSources.has(d.buf)) { restoredStemSources.add(d.buf); void stemsCtl.restoreSource(d.buf, sm); }
      } catch { missing++; }
    }
    if (missing) flash(`${missing} pad sample${missing > 1 ? 's' : ''} couldn't be restored — LOAD FILE them again, or transfer the project from the device that has them`);
  };
  const applyPreset = (preset: ChopPreset): void => {
    engine.loadPreset(preset);          // chops → pads → sequencer → master/extra FX
    void restorePadSamples(preset);
    // STEMS: bring the stem audio back from the asset store (masks + ranges
    // came through loadPreset; missing assets = needs-resplit, originals play).
    stemsChopsSeenRef.current = null;   // never auto-split a freshly loaded project
    void stemsCtl.restore(preset);
    if (preset.drums) drumEngine.restore(preset.drums); // kit + samples + pattern
    if (preset.bass) bassEngine.restore(preset.bass); else bassEngine.reset(); // synth patch + note patterns + key lock
    if (preset.mixer) mixerEngine.restore(preset.mixer); // faders/pan/mute/solo/sends + insert FX
    setMixerRev(v => v + 1); // the memoized mixer UI re-reads the engine
    // engine.loadPreset no-ops without a decoded buffer (the audio-fail path still
    // restores drums/mixer above). The transport tempo + chop level don't need the
    // buffer, so re-apply them from the preset here too — otherwise the restored
    // drum loop would play at the wrong BPM when the sample couldn't be fetched.
    // Idempotent on the normal path; guards keep old presets (missing them) safe.
    if (typeof preset.metronomeBpm === 'number' && preset.metronomeBpm > 0) engine.setMetronomeBpm(preset.metronomeBpm);
    if (typeof preset.chopVolume === 'number') engine.setChopVolume(preset.chopVolume);
  };

  // iOS only: writing happens synchronously RIGHT BEFORE the export's share
  // sheet backgrounds the tab, so the snapshot is guaranteed in localStorage if
  // WebKit reloads the page on return. Gated on isIOS() — the exact condition
  // under which delivery uses the share sheet — so no other platform leaves a
  // stale snapshot. Restored + cleared by the mount effect below.
  const snapshotSessionForExport = (): void => {
    if (!isIOS() || !currentVideoId) return;
    try {
      localStorage.setItem(SNAPSHOT_KEY, JSON.stringify(buildPreset(currentVideoId)));
    } catch { /* quota / private mode → best effort */ }
  };

  // Sync the LOAD section's playlist dropdown to the playlist a restored track
  // belongs to, so GET SAMPLE continues from the same playlist after a session
  // restore (same pattern as the browser-load sync). Reads playlistsRef so it
  // works even when called before the playlist list has finished loading. No
  // match (user file, YouTube URL, etc.) → leave the dropdown as-is.
  const syncPlaylistToTrack = (trackId: string) => {
    const match = playlistsRef.current.find(pl => pl.entries.some(e => e.id === trackId));
    if (match) setSelectedPlaylist(match.name);
  };

  // Core load helper — downloads (or cache-hits) a track by id/url, then optionally restores a preset
  const loadTrackById = async (idOrUrl: string, title?: string, presetOverride?: ChopPreset | null): Promise<void> => {
    // A no-sample project (drums + bass only): nothing to fetch — restore the
    // engines and leave the waveform as it is. Covers every caller (named
    // projects, .tproj/.tprojz open, recents, transfer) in one place.
    if (idOrUrl === NO_SAMPLE_ID) {
      if (presetOverride) applyPreset(presetOverride);
      setPresetName(presetOverride?.name ?? title ?? presetName);
      setLoadedPresetId(null); setConfirmSave(null);
      flash('Project loaded — drums + bass (no sample)');
      return;
    }
    engine.setLoading(true);
    try {
      const res = await fetchTrackData(idOrUrl, title);
      if (!res.ok) {
        // The sample audio can't be re-fetched (network / deleted video). Still
        // restore everything that DOESN'T need the buffer — drums + mixer + FX —
        // so the user keeps their work. engine.loadPreset no-ops without a buffer.
        if (presetOverride) { try { applyPreset(presetOverride); } catch { /* */ } }
        setError(res.error ?? 'Download failed');
        return;
      }
      const audio = await resolveAudio(res);
      const displayTitle = res.title ?? title ?? 'untitled';
      await engine.loadFromArrayBuffer(audio, displayTitle);
      setViewStart(0); setViewEnd(1); // fit new track to full view (moved here from WaveformView so reopening the collapsed section doesn't reset zoom)
      userZoomedRef.current = false; // fresh track → first chop uses the default zoom again
      const vid = res.videoId ?? idOrUrl;
      setCurrentVideoId(vid);
      setPresetName(displayTitle);
      setLoadedPresetId(null); setConfirmSave(null); // fresh track → not editing a saved preset (named loaders re-set the id after)
      // Preset priority: explicit override > named preset passed in > auto-saved per-video preset
      let preset = presetOverride !== undefined ? presetOverride : null;
      if (preset === null && ipc.loadPreset) preset = await ipc.loadPreset(vid);
      if (preset) { applyPreset(preset); flash(`Loaded: ${displayTitle} — preset restored`); }
      else flash(`Loaded: ${displayTitle}`);
    } catch (e: any) {
      if (presetOverride) { try { applyPreset(presetOverride); } catch { /* */ } }
      setError(e?.message ?? String(e));
    } finally {
      engine.setLoading(false);
    }
  };

  /** Theme-gated easter egg picker. When the active theme is Mario and the
   *  playlist is an NES/SNES/N64 set, returns the first Mario track found.
   *  When the SF2 (vicecity slot) theme is active and the playlist is an
   *  arcade one, returns Guile's Theme (the iconic SF2 stage track). When
   *  Mario (outrun slot) + NES/SNES/N64 playlist, returns a Mario track.
   *  Falls back to a random pick otherwise. The user only sees the egg
   *  ONCE per session per playlist — after the first hit on a given
   *  playlist we revert to random so they're not permanently locked into
   *  the easter-egg track. */
  const easterEggSeen = useRef<Set<string>>(new Set());
  // Tracks last spacebar press timeStamp so a double-tap within 300ms
  // can trigger a panic-stop (kill all sounding voices).
  const lastSpaceTapRef = useRef<number>(0);
  const pickFromPlaylist = (pl: { name: string; entries: Array<{ id: string; title: string }> }) => {
    const themeId = getStoredTheme();
    const key = `${themeId}::${pl.name}`;
    if (!easterEggSeen.current.has(key)) {
      // SF2 theme + any arcade-flavoured playlist → return the bundled
      // Guile's Theme acapella mp3 directly (no yt-dlp needed). The
      // `local:` prefix is intercepted by fetchTrackData to fetch the
      // static asset from public/easter-eggs/.
      if (themeId === 'vicecity' && /\b(arcade|capcom|fighting|fighter)\b/i.test(pl.name)) {
        easterEggSeen.current.add(key);
        return {
          id: 'local:/easter-eggs/sf2-guile-acapella.mp3',
          title: "Street Fighter 2 — Guile's Theme (Acapella)",
        };
      }
      // Mario theme + retro Nintendo playlist → pull the Super Mario
      // World title theme specifically. Multi-needle covers Drive's
      // dashed filename and a few common spacings/variants.
      if (themeId === 'outrun' && /\b(snes|nes|n64)\b/i.test(pl.name)) {
        for (const needle of [
          'super-mario-world-ost-title-theme',
          'super mario world ost title theme',
          'super mario world - title theme',
          'super mario world title theme',
        ]) {
          const hit = pl.entries.find(e => e.title.toLowerCase().includes(needle));
          if (hit) {
            easterEggSeen.current.add(key);
            return hit;
          }
        }
      }
      // Transformers G1 theme + TV Show Themes playlist → pull the
      // Transformers intro. Multi-needle: prefers "transformers g1",
      // falls back to bare "transformers" in case the title varies.
      if (themeId === 'transformers' && /\b(tv|television|show|theme)\b/i.test(pl.name)) {
        for (const needle of ['transformers g1', 'transformers']) {
          const hit = pl.entries.find(e => e.title.toLowerCase().includes(needle));
          if (hit) {
            easterEggSeen.current.add(key);
            return hit;
          }
        }
      }
      // Sonic theme + Sega/Genesis playlist → pull the Green Hill Zone OST.
      // Needles cover the dashed Drive filename plus a few spacing
      // variants, with a bare "green hill zone" fallback.
      if (themeId === 'sonic' && /\b(sega|genesis|mega.?drive)\b/i.test(pl.name)) {
        for (const needle of [
          'sonic-the-hedgehog-ost-green-hill-zone',
          'sonic the hedgehog ost green hill zone',
          'sonic the hedgehog - green hill zone',
          'green hill zone',
        ]) {
          const hit = pl.entries.find(e => e.title.toLowerCase().includes(needle));
          if (hit) {
            easterEggSeen.current.add(key);
            return hit;
          }
        }
      }
      // FF7 theme + PS1 playlist → pull the Prelude. Needles cover the
      // dashed Drive filename plus a few spacing variants, with a bare
      // "prelude" fallback.
      if (themeId === 'ff7' && /\b(ps1|psx|playstation)\b/i.test(pl.name)) {
        for (const needle of [
          'final-fantasy-vii-ost-prelude',
          'final fantasy vii ost prelude',
          'final fantasy 7 prelude',
          'ff7 prelude',
          'ffvii prelude',
          'prelude',
        ]) {
          const hit = pl.entries.find(e => e.title.toLowerCase().includes(needle));
          if (hit) {
            easterEggSeen.current.add(key);
            return hit;
          }
        }
      }
    }
    return pl.entries[Math.floor(Math.random() * pl.entries.length)];
  };

  const loadRandomFromPlaylist = async () => {
    const pl = playlists.find(p => p.name === selectedPlaylist);
    if (!pl || pl.entries.length === 0) { setError('Playlist is empty'); return; }
    const pick = pickFromPlaylist(pl);
    // Pads already in play (his ask 2026-08-22): a kit you have started — the
    // main track chopped into pieces, or any pad carrying its own sample — must
    // not be swapped out under you. GET SAMPLE then pulls onto the NEXT EMPTY
    // PAD as its own source (the same path as LOAD → PAD / a pad link). A bare
    // main track (one whole-sample pad, nothing else) still gets replaced — that
    // is "still looking for the sample".
    const padsInPlay = Object.keys(state.padBufferMeta ?? {}).length > 0 || state.chops.length > 1;
    if (padsInPlay) {
      const padIdx = findNextEmptyPad();
      flash(`Pulling sample → PAD ${padIdx + 1}…`);
      await loadPadFromUrl(padIdx, pick.id); // gates the pull itself
      return;
    }
    if (!gatePull()) return;
    setError(null);
    flash('Pulling sample…');
    await loadTrackById(pick.id, pick.title);
  };

  // ── Sample Browser (Phase 5) ──────────────────────────────────────────────
  // Preview now STREAMS via the SampleBrowser's own <audio> element using the
  // direct R2 URL (resolveAudioUrl={r2AudioUrl}) — no byte fetch/decode here.
  // LOAD a chosen track from the browser → fresh load into the chopper, gated
  // by the free-tier pull counter (same as GET SAMPLE). Always closes the modal
  // so a gate-fail surfaces the upsell modal unobstructed.
  const loadFromBrowser = (entry: BrowserEntry, playlistName: string) => {
    // Your own library files (recordings / YouTube imports / imports / linked)
    // are served off disk by the main process — no pull gate, no R2.
    if (entry.id.startsWith(LIB_ID_PREFIX)) {
      setSampleBrowserOpen(false);
      setError(null);
      void (async () => {
        try {
          const res = await fetch(libFileUrl(entry.id.slice(LIB_ID_PREFIX.length)));
          if (!res.ok) throw new Error(`could not read file (${res.status})`);
          const blob = await res.blob();
          await loadAudioFile(new File([blob], entry.title || 'sample', { type: blob.type || 'audio/*' }));
        } catch (e: any) { setError(e?.message ?? String(e)); }
      })();
      return;
    }
    // fetchTrackData routes R2 ids straight to R2 on desktop, so the one
    // loadTrackById path handles web + Electron (incl. the full post-load tail).
    const ok = gatePull();
    setSampleBrowserOpen(false);
    if (ok) {
      setError(null);
      // Sync the LOAD section's playlist dropdown to the one the user loaded
      // from, so GET SAMPLE continues from the same playlist. Only applies to
      // curated R2 playlists (not user-content / Electron-local entries).
      if (playlistName && playlists.some(p => p.name === playlistName)) {
        setSelectedPlaylist(playlistName);
      }
      void loadTrackById(entry.id, entry.title);
    }
  };
  // LOAD → PAD from the browser: the sample lands on the NEXT EMPTY PAD as its
  // own source (same as IMPORT LINK / LOAD FILE onto a pad); the browser stays
  // open so several can be stacked. Library files come off disk; R2 / YouTube
  // entries go through the same pull gate + fetchTrackData as a pad link.
  const loadFromBrowserToPad = (entry: BrowserEntry, _playlistName: string) => {
    const padIdx = findNextEmptyPad();
    if (entry.id.startsWith(LIB_ID_PREFIX)) {
      setError(null);
      void (async () => {
        try {
          engine.setLoading(true);
          const res = await fetch(libFileUrl(entry.id.slice(LIB_ID_PREFIX.length)));
          if (!res.ok) throw new Error(`could not read file (${res.status})`);
          const buf = await engine.decodeAudio(await res.arrayBuffer());
          engine.loadPadBuffer(padIdx, buf, entry.id, entry.title || 'sample');
          setViewPadIdx(padIdx); // show it — a load is not "assign a chop to this pad" (no banner)
          flash(`PAD ${padIdx + 1}: ${entry.title || 'sample'}`);
        } catch (e: any) { setError(e?.message ?? String(e)); }
        finally { engine.setLoading(false); }
      })();
      return;
    }
    void loadPadFromUrl(padIdx, entry.id);
  };
  // sampleId → saved-preset name, for the browser's "LOAD PRESET" affordance.
  // Presets are one-per-sample keyed by videoId (see /api/terminator-presets),
  // and the full ChopPreset blob already rides along in namedPresets[].data.
  const presetIndex = useMemo(() => {
    const m: Record<string, string> = {};
    for (const p of namedPresets) if (p.videoId) m[p.videoId] = p.name;
    return m;
  }, [namedPresets]);
  // Stable bridge for the browser's USER SAMPLES + "+ YouTube" folders. `ipc` is
  // a module-level constant, so this is built once — a fresh object literal each
  // render would re-fire the browser's fetch effects in a loop.
  const libraryBridge = useMemo(() => (ipc !== undefined ? libraryBridgeFromWindow() : undefined), []);
  // Preview URL: library files stream from disk via terminator-lib://, the
  // TERMINATOR library from R2 (Worker-proxied).
  const browserResolveUrl = useCallback((id: string, title?: string): string | null =>
    id.startsWith(LIB_ID_PREFIX) ? libFileUrl(id.slice(LIB_ID_PREFIX.length)) : r2AudioUrl(id, title), []);
  // LOAD PRESET from the browser → fetch the sample AND restore its saved
  // chops/pads/sequences (the presetOverride path). Same pull gate as LOAD.
  const loadPresetFromBrowser = (entry: BrowserEntry) => {
    const row = namedPresets.find(p => p.videoId === entry.id);
    if (!row?.data) { setSampleBrowserOpen(false); setError('Preset not found'); return; }
    const ok = gatePull();
    setSampleBrowserOpen(false);
    if (ok) {
      setError(null);
      flash(`Loading preset: ${row.name}…`);
      void loadTrackById(row.data.videoId, row.data.trackTitle, row.data).then(() => {
        setLoadedPresetId(row.id ?? null); // editing this saved preset → SAVE updates it in place
        setPresetName(row.name);
      });
    }
  };

  const loadCustomUrl = async (url: string) => {
    if (!url.trim()) return;
    if (!gatePull()) return;
    setError(null);
    flash('Pulling sample…');
    await loadTrackById(url.trim());
  };

  // Session auto-save on close
  useEffect(() => {
    const onUnload = () => {
      if (!ipc?.saveSession || !currentVideoId) return;
      ipc.saveSession(buildPreset(currentVideoId));
    };
    window.addEventListener('beforeunload', onUnload);
    return () => window.removeEventListener('beforeunload', onUnload);
  }, [engine, currentVideoId]);

  // Session restore on first mount — reload last-used track from cache.
  // Web build skips this so each visit to the embedded /terminator route
  // starts fresh (1 pad, no chops). Electron keeps it for desktop UX.
  useEffect(() => {
    if (isWeb) return;
    if (!ipc?.loadSession) return;
    ipc.loadSession().then(async session => {
      if (!session?.videoId) return;
      flash('Restoring last session…');
      await loadTrackById(session.videoId, session.trackTitle, session);
      syncPlaylistToTrack(session.videoId);
    });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Crash recovery (web): periodic full-session autosave + auto-restore ──
  // The diagnostic traced random iOS reloads to WKWebView killing the tab during
  // playback. We time-stamp a FULL session preset every 30 s so the next load can
  // bring it back automatically. Web-only: desktop already persists via
  // ipc.saveSession and auto-restores on mount above, so a second restore would race.

  // Latest-closure ref so the 30 s interval always reads the current video/export
  // state without re-arming the timer (mirrors savePresetRef below).
  const autosaveRef = useRef<() => void>(() => {});
  autosaveRef.current = () => {
    if (!currentVideoId || exportBusy) return; // need a loaded track; never mid-export
    try {
      localStorage.setItem(AUTOSAVE_KEY, JSON.stringify({ ts: Date.now(), preset: buildPreset(currentVideoId) }));
    } catch { /* quota / private mode → best effort */ }
  };

  useEffect(() => {
    if (!isWeb) return;
    const save = () => autosaveRef.current();
    const id = setInterval(save, 30000);
    const onHidden = () => { if (document.visibilityState === 'hidden') save(); };
    document.addEventListener('visibilitychange', onHidden);
    return () => {
      clearInterval(id);
      document.removeEventListener('visibilitychange', onHidden);
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // On mount: AUTO-restore a recent autosave when starting fresh. Yields to the
  // iOS export-reset path when ITS snapshot is present (that auto-restores just
  // below, and clears SNAPSHOT_KEY) so we never double-load.
  useEffect(() => {
    if (!isWeb) return;
    try { if (localStorage.getItem(SNAPSHOT_KEY)) return; } catch { /* */ }
    let saved: { ts?: number; preset?: ChopPreset } | null = null;
    try {
      const raw = localStorage.getItem(AUTOSAVE_KEY);
      if (raw) saved = JSON.parse(raw) as { ts?: number; preset?: ChopPreset };
    } catch { /* corrupt JSON → ignore */ }
    const preset = saved?.preset;
    const recent = !!saved?.ts && (Date.now() - saved.ts!) < AUTOSAVE_MAX_AGE_MS;
    // Need a recent save, a fresh session (no track loaded), and a re-fetchable id
    // (own-file `local_` audio can't be re-downloaded, so skip it).
    if (!recent || currentVideoId || !preset?.videoId || preset.videoId.startsWith('local_')) return;

    void (async () => {
      if (!navigator.onLine) { localStorage.removeItem(AUTOSAVE_KEY); return; }
      let timer: ReturnType<typeof setTimeout> | null = null;
      try {
        // Race the restore against an 8 s watchdog so a hung download (offline
        // mid-load, stalled fetch) can never block or wedge the fresh session.
        await Promise.race([
          loadTrackById(preset.videoId, preset.trackTitle, preset),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error('restore timed out')), 8000);
          }),
        ]);
        syncPlaylistToTrack(preset.videoId);
        flash('Session restored');
      } catch {
        flash('Could not restore last session');
      } finally {
        if (timer) clearTimeout(timer);
        try { localStorage.removeItem(AUTOSAVE_KEY); } catch { /* */ }
      }
    })();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // iOS export-reset recovery (web build). A snapshot present at mount means
  // WebKit reloaded the tab while the export share sheet had it backgrounded —
  // restore the whole session. We always clear the key first so a deliberate
  // fresh load never re-applies it. If the tab merely suspended and came back
  // WITHOUT reloading, no mount happens here; the survival listener below drops
  // the now-stale snapshot instead. (AudioContext resume is already handled in
  // ChopperEngine across visibilitychange/pageshow/statechange.)
  useEffect(() => {
    if (!isWeb) return;
    let snap: ChopPreset | null = null;
    try {
      const raw = localStorage.getItem(SNAPSHOT_KEY);
      if (raw) snap = JSON.parse(raw) as ChopPreset;
    } catch { /* corrupt JSON → ignore */ }
    try { localStorage.removeItem(SNAPSHOT_KEY); } catch { /* */ }
    if (snap?.videoId) {
      if (snap.videoId.startsWith('local_')) {
        // Own-file audio isn't re-fetchable — stash so re-dropping the file
        // restores chops/pads/FX/drums via the existing pending-preset flow.
        const fileName = decodeURIComponent(snap.videoId.slice('local_'.length));
        setPendingPreset({ data: snap, fileName, presetName: snap.trackTitle ?? 'session' });
        flash(`Reload "${fileName}" to restore your session`);
      } else {
        flash('Restoring your session…');
        const restoredId = snap.videoId;
        void loadTrackById(restoredId, snap.trackTitle, snap).then(() => syncPlaylistToTrack(restoredId));
      }
    }
    // Survival cleanup: returning to the foreground without a reload means the
    // pre-export snapshot is stale — drop it so it can't restore on a later load.
    const onVisible = () => {
      if (document.visibilityState !== 'visible') return;
      try { localStorage.removeItem(SNAPSHOT_KEY); } catch { /* */ }
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Named preset handlers. On web they hit the Supabase-backed KCC API; on
  // desktop they use the Electron ipc store. On web the select passes a preset
  // `id`; on desktop it passes the preset `name`.
  // POST a preset payload, mapping the standard auth/error responses to flashes.
  // Returns the parsed JSON on success (a saved row, OR { needsConfirm, existingId }
  // when the name clashes), or null when the request failed (flash already shown).
  const postPreset = async (payload: { name: string; data: ChopPreset; id?: string; overwrite?: boolean }) => {
    if (!isWeb) {
      // Electron: proxy the save through the main process (device-token Bearer).
      // A 2xx returns the saved row OR { needsConfirm, existingId }; non-2xx
      // throws "HTTP <status>", which we map to the same flashes as web.
      try {
        return await ipc?.cloudPresetsSave?.({ ...payload, confirmable: true });
      } catch (e: any) {
        const status = Number(String(e?.message ?? '').match(/HTTP (\d+)/)?.[1] ?? 0);
        if (status === 401) { flash('Sign in (desktop sign-in) to save projects'); return null; }
        if (status === 403) { flash('Presets are a subscriber feature — upgrade to save'); return null; }
        flash('Save failed — check connection'); return null;
      }
    }
    try {
      const r = await fetch('/api/terminator-presets', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        // confirmable: this bundle handles the { needsConfirm } overwrite prompt.
        body: JSON.stringify({ ...payload, confirmable: true }),
      });
      if (r.status === 401) { flash('Sign in (bottom-right) to save projects'); return null; }
      if (r.status === 403) { flash('Presets are a subscriber feature — upgrade to save'); return null; }
      if (!r.ok) {
        let msg = 'Save failed';
        try { const j = await r.json(); if (j?.error) msg = `Save failed: ${j.error}`; } catch { /* */ }
        flash(msg);
        return null;
      }
      return await r.json();
    } catch { flash('Save failed — check connection'); return null; }
  };

  // Finalize a successful save: drop the crash-autosave, remember the row as the
  // loaded preset (so the NEXT SAVE updates it in place), refresh + flash.
  const afterSaved = async (row: any, name: string, verb: string, data?: ChopPreset) => {
    try { localStorage.removeItem(AUTOSAVE_KEY); } catch { /* */ } // real preset saved → crash autosave no longer needed
    if (row?.id) setLoadedPresetId(row.id);
    await refreshWebPresets();
    // SAVE PROJECT = the cloud row AND a `<name>.tproj` file on this computer
    // (desktop): the project is yours on disk, shows in File → Open / Recent,
    // and survives without the account. Best-effort; the cloud row is what
    // the LOAD PROJECT list reads.
    if (data && ipc?.saveProjectFile) {
      try {
        const saved = await writeProjectToDisk(`${name}`, data);
        if (saved?.path) recordRecentProject(saved.path, saved.name ?? name);
      } catch { /* disk write is a bonus, never a blocker */ }
    }
    // Own loaded files can't store their audio — the preset is a snapshot of the
    // chops/pads/sequences; the user must keep the file to restore it.
    flash(currentVideoId?.startsWith('local_')
      ? `${verb}: ${name} — keep "${state.trackTitle}" to reload it later`
      : `${verb}: ${name}`);
  };

  const [nameBlink, setNameBlink] = useState(false);
  const blinkNameInput = () => {
    setNameBlink(false);
    setTimeout(() => { setNameBlink(true); setTimeout(() => setNameBlink(false), 1000); }, 0);
    presetNameInputRef.current?.focus();
  };
  // SAVE (no arg) / SAVE AS (nameOverride): with a name, the project is saved as
  // a NEW row under that name — never the loaded row by id — so "Save As" from
  // a loaded project leaves the original alone. A clash with an existing name
  // routes into the same overwrite prompt a plain save uses.
  const doSaveProject = async (nameOverride?: string) => {
    if (saving) return;                                   // ignore double-clicks / Cmd+S spam mid-save
    if (demoBlock()) return;
    // No sample loaded (drums + bass only) is a legit project — but it has no
    // track title to fall back on, so it needs a NAME: empty → the name box
    // blinks red instead of saving.
    let vid = currentVideoId;
    if (!vid) {
      if (!(nameOverride ?? presetName).trim()) { blinkNameInput(); flash('Name the project first'); return; }
      vid = NO_SAMPLE_ID;
    }
    const name = (nameOverride ?? '').trim() || presetName.trim() || state.trackTitle || 'preset';
    const data = buildPreset(vid);
    setConfirmSave(null);
    if (nameOverride) { setPresetName(name); setLoadedPresetId(null); }   // the project is now "name"
    setSaving(true);
    try {
      if (cloudPresets) {
        // SAVE on a loaded preset whose name is UNCHANGED → update that exact row by
        // id (no overwrite prompt — the user is knowingly editing it). Renaming
        // clears loadedPresetId (see the name input), so a rename routes here as a
        // fresh upsert-by-name → a NEW preset (or a prompted overwrite of a clash).
        const loadedRow = !nameOverride && loadedPresetId ? namedPresets.find(p => p.id === loadedPresetId) : null;
        if (loadedRow && loadedRow.name === name) {
          const row = await postPreset({ id: loadedPresetId!, name, data });
          if (!row) return;
          // Stale id (preset deleted elsewhere) → server fell through to the name
          // path and hit a clash: route into the same overwrite prompt, don't no-op.
          if (row.needsConfirm) { setConfirmSave({ name, existingId: row.existingId }); return; }
          if (row.id) await afterSaved(row, name, 'Project updated', data);
          return;
        }
        const res = await postPreset({ name, data });
        if (!res) {
          // DEV Electron runs unlocked but its sign-in can't complete (the
          // terminator:// callback lands in whatever generic Electron macOS
          // picks), so the cloud row 401s. Keep SAVE working there: write the
          // `<name>.tproj` to disk — the file OPEN… lists under local projects.
          // Packaged builds are not DEV and keep the cloud-first behaviour.
          if (!isWeb && import.meta.env.DEV && ipc?.saveProjectFile) {
            try {
              const saved = await writeProjectToDisk(`${name}`, data);
              if (saved?.path) { recordRecentProject(saved.path, saved.name ?? name); try { localStorage.removeItem(AUTOSAVE_KEY); } catch { /* */ } flash(`Saved ${saved.name ?? name}.tproj on this computer (dev build — no cloud row)`); }
            } catch (e: any) { setError(e?.message ?? String(e)); }
          }
          return;
        }
        if (res.needsConfirm) { setConfirmSave({ name, existingId: res.existingId }); return; }
        await afterSaved(res, name, 'Project saved', data);
        return;
      }
      if (!ipc?.saveNamedPreset) return; // desktop Electron store is name-keyed → upsert-by-name is inherent
      // Save As onto a name that exists = overwrite; the desktop store has no
      // prompt of its own, so ask here.
      if (nameOverride && namedPresets.some(p => p.name === name) && !window.confirm(`"${name}" exists — overwrite it?`)) return;
      await ipc.saveNamedPreset(name, data);
      const updated = await ipc.listNamedPresets!();
      setNamedPresets(updated);
      try { localStorage.removeItem(AUTOSAVE_KEY); } catch { /* */ }
      // ALSO drop a plain `<name>.tproj` project file in terminator-presets so it
      // shows up in File → Open and Recent Projects (bare filename → main joins
      // it into the presets folder). Best-effort; the named-preset save above is
      // the source of truth for the LOAD PRESET dropdown.
      const saved = await writeProjectToDisk(name, data);
      if (saved?.path) recordRecentProject(saved.path, saved.name ?? name);
      flash(`Project saved: ${name}`);
    } finally {
      setSaving(false);
    }
  };

  const handleSaveNamedPreset = () => doSaveProject();
  // SAVE AS… (CMD-click SAVE PROJECT, or right-click → Save As…): the Open
  // Project list in save mode, so you can see the names you already used.
  const [saveAsOpen, setSaveAsOpen] = useState(false);
  const [saveMenu, setSaveMenu] = useState<{ x: number; y: number } | null>(null);
  const currentProjectName = () => presetName.trim() || state.trackTitle || 'project';
  /** SAVE AS COPY: the same name with the next free number — "Beat" → "Beat 2" → "Beat 3". */
  const saveProjectCopy = () => {
    const base = currentProjectName().replace(/\s+\d+$/, '');
    const taken = new Set(namedPresets.map(p => p.name.toLowerCase()));
    let n = 2, cand = `${base} ${n}`;
    while (taken.has(cand.toLowerCase())) { n++; cand = `${base} ${n}`; }
    void doSaveProject(cand);
  };

  // Confirmed overwrite of a same-name preset (from the inline prompt below SAVE).
  const confirmOverwriteSave = async () => {
    if (saving) return;
    const cs = confirmSave;
    setConfirmSave(null);
    if (!cs) return;
    setSaving(true);
    try {
      const data = buildPreset(currentVideoId ?? NO_SAMPLE_ID);
      const row = await postPreset({ name: cs.name, data, overwrite: true });
      if (row?.id) await afterSaved(row, cs.name, 'Project overwritten', data);
    } finally {
      setSaving(false);
    }
  };

  // Live ref so the Cmd/Ctrl+S shortcut always calls the latest save closure
  // (fresh sample / name / state) without re-subscribing the key listener.
  const savePresetRef = useRef(handleSaveNamedPreset);
  savePresetRef.current = handleSaveNamedPreset;

  const handleLoadNamedPreset = async (key: string) => {
    if (cloudPresets) {
      const row = namedPresets.find(p => p.id === key);
      if (!row?.data) { setError('Preset not found'); return; }
      const vid = row.data.videoId ?? '';
      if (vid.startsWith('local_')) {
        // The sample is one of the user's own loaded files — we can't fetch it
        // back. Stash the preset as a pending snapshot; the waveform will show
        // which file to reload, and loadAudioFile applies it once a file with a
        // matching name is loaded.
        const fileName = (() => { try { return decodeURIComponent(vid.slice('local_'.length)); } catch { return vid.slice('local_'.length); } })();
        setPendingPreset({ data: row.data, fileName, presetName: row.name });
        flash(`Reload "${fileName}" to restore preset "${row.name}"`);
        return;
      }
      flash(`Loading preset: ${row.name}…`);
      await loadTrackById(row.data.videoId, row.data.trackTitle, row.data);
      // Now editing THIS saved preset — show its name + mark it loaded so SAVE
      // updates it in place (loadTrackById reset both back to the track default).
      setLoadedPresetId(row.id ?? null);
      setPresetName(row.name);
      recordRecentProject(row.id ?? row.name, row.name);
      return;
    }
    if (!ipc?.loadNamedPreset) return;
    const preset = await ipc.loadNamedPreset(key);
    if (!preset) { setError(`Preset "${key}" not found`); void ipc?.removeRecentProject?.(key); return; }
    flash(`Loading preset: ${key}…`);
    await loadTrackById(preset.videoId, preset.trackTitle, preset);
    recordRecentProject(key, key);
  };

  const handleDeleteNamedPreset = async (key: string) => {
    if (cloudPresets) {
      const row = namedPresets.find(p => p.id === key);
      if (!row?.id) return;
      try {
        if (!isWeb) {
          // Electron: delete via the main process (device-token Bearer).
          await ipc?.cloudPresetsDelete?.(row.id);
        } else {
          await fetch('/api/terminator-presets', {
            method: 'DELETE',
            credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: row.id }),
          });
        }
        if (loadedPresetId === row.id) { setLoadedPresetId(null); setConfirmSave(null); } // don't keep a dead id
        await refreshWebPresets();
        flash(`Preset deleted: ${row.name}`);
      } catch { flash('Delete failed'); }
      return;
    }
    if (!ipc?.deleteNamedPreset) return;
    await ipc.deleteNamedPreset(key);
    const updated = await ipc.listNamedPresets!();
    setNamedPresets(updated);
    flash(`Preset deleted: ${key}`);
  };

  // ── File menu (Electron) ────────────────────────────────────────────────────
  // Record a just-loaded preset into the native File → Recent Projects submenu.
  const recordRecentProject = (id: string | null | undefined, name: string) => {
    if (!id) return;
    void ipc?.addRecentProject?.({ id, name });
  };

  // File → New Project. Confirms when there's something to lose (a loaded sample
  // or any chops/pads), then wipes the chopper + drums + mixer back to defaults.
  const handleNewProject = () => {
    const hasWork = state.hasBuffer || state.chops.length > 0 || !!currentVideoId;
    if (hasWork && !window.confirm('Start new project? Unsaved changes will be lost.')) return;
    stopTransport();
    engine.stopAllPads();
    engine.clearAll();                                  // sample + chops + pads + sequence
    if (defaultDrumsRef.current) drumEngine.restore(defaultDrumsRef.current);
    bassEngine.reset();
    if (defaultMixerRef.current) mixerEngine.restore(defaultMixerRef.current);
    setMixerRev(v => v + 1); // the memoized mixer UI re-reads the engine
    setCurrentVideoId(null);
    setPresetName('');
    setLoadedPresetId(null);
    setConfirmSave(null);
    setPendingPreset(null);
    flash('New project');
  };

  // Load a project file's parsed data (full session snapshot) into the engine.
  // loadTrackById re-fetches the sample audio AND applies the preset (drums +
  // mixer + FX restore even on the audio-fail path), so it covers own-file
  // (local_*) projects too. `filePath` is the on-disk path → recorded as recent.
  // Write a project to disk (desktop): plain `.tproj` JSON, or — when it uses
  // your own samples — a `.tprojz` BUNDLE with the audio inside. Absolute
  // target = the save dialog's path; bare name = the projects folder.
  const writeProjectToDisk = async (target: string, data: ChopPreset): Promise<{ path?: string; name?: string; error?: string } | undefined> => {
    if (!ipc?.saveProjectFile) return undefined;
    if (projectNeedsBundle(data) && ipc.saveProjectBundle) {
      const b = await buildProjectBundle(data);
      return ipc.saveProjectBundle(target, b.bytes);
    }
    return ipc.saveProjectFile(target.endsWith('.tproj') ? target : `${target}.tproj`, data);
  };
  // Import project bytes (a `.tprojz` bundle or a `.tproj` JSON) from a picked/
  // dropped/received file: samples into this device's asset store, then load.
  const importProjectBytes = async (bytes: Uint8Array, displayName: string): Promise<void> => {
    try {
      let preset: ChopPreset;
      // zip magic "PK" → bundle; else JSON
      if (bytes.length > 4 && bytes[0] === 0x50 && bytes[1] === 0x4b) {
        const r = await unpackProjectBundle(bytes);
        preset = r.preset;
        if (r.assets.length) flash(`Imported ${r.assets.length} sample${r.assets.length > 1 ? 's' : ''} with the project`);
      } else {
        preset = JSON.parse(new TextDecoder().decode(bytes));
      }
      const miss = await missingAssets(preset);
      if (miss.length) flash(`Missing on this device: ${miss.map((m) => m.name).join(', ')} — LOAD FILE them or transfer the project`);
      await loadTrackById(preset.videoId, preset.trackTitle, preset);
      setPresetName(preset.name ?? displayName);
    } catch (e: any) {
      setError(e?.message ?? 'Could not import project');
    }
  };
  // "⇩ PROJECT FILE" — hand the user a self-contained project file (bundle
  // when it has own samples, JSON otherwise). Web: a download / iOS share;
  // desktop too (for sending to someone / another machine by hand).
  const downloadProjectFile = async () => {
    if (!currentVideoId) { flash('Load a sample first'); return; }
    const name = presetName.trim() || state.trackTitle || 'project';
    const data = buildPreset(currentVideoId);
    try {
      const { deliverFiles } = await import('../lib/download');
      if (projectNeedsBundle(data)) {
        const b = await buildProjectBundle(data);
        if (b.totalBytes > BUNDLE_WARN_BYTES && !window.confirm(`This project bundle is ${(b.totalBytes / 1024 / 1024).toFixed(0)} MB (its samples travel inside). Continue?`)) return;
        await deliverFiles([{ name: `${name}.tprojz`, data: b.bytes, mime: 'application/zip' }]);
        flash(`Project file ready: ${name}.tprojz (${b.assets.length} sample${b.assets.length > 1 ? 's' : ''} inside)`);
      } else {
        await deliverFiles([{ name: `${name}.tproj`, data: new TextEncoder().encode(JSON.stringify(data, null, 2)), mime: 'application/json' }]);
        flash(`Project file ready: ${name}.tproj`);
      }
    } catch (e: any) { setError(e?.message ?? 'Could not build the project file'); }
  };
  const loadProjectData = async (data: ChopPreset, filePath: string, displayName: string) => {
    flash(`Opening project: ${displayName}…`);
    await loadTrackById(data.videoId, data.trackTitle, data);
    setPresetName(data.name ?? displayName);
    recordRecentProject(filePath, displayName);
  };

  // Read a .tproj at a specific path and load it (used by the Open modal's LOCAL
  // tab, by Recent Projects, and by Finder/Explorer double-click on a .tproj).
  const openProjectFromPath = async (filePath: string) => {
    const res = await ipc?.readProjectFile?.(filePath);
    if (!res || 'error' in res || (!res.data && !res.bundle)) {
      setError((res && 'error' in res && res.error) || 'Could not open project');
      return;
    }
    if (res.bundle) { recordRecentProject(res.path, res.name); await importProjectBytes(res.bundle, res.name); return; }
    await loadProjectData(res.data!, res.path, res.name);
  };

  // File → Open Project (Cmd+O) / web LOAD button → open the LOCAL|CLOUD modal.
  const handleOpenProject = () => { setOpenModalOpen(true); };

  // The modal's LOCAL "Browse…" — native open dialog to pick a .tproj anywhere.
  const handleBrowseProject = async () => {
    if (!ipc?.openProjectDialog) return;
    const res = await ipc.openProjectDialog();
    if (!res || 'error' in res || 'cancelled' in res || (!res.data && !res.bundle)) {
      if (res && 'error' in res) setError(res.error || 'Could not open project');
      return; // cancelled or errored
    }
    setOpenModalOpen(false);
    if (res.bundle) { recordRecentProject(res.path, res.name); await importProjectBytes(res.bundle, res.name); return; }
    await loadProjectData(res.data!, res.path, res.name);
  };

  // File → Save Project As. Native save dialog (defaults to terminator-presets/
  // Untitled.tproj) → write the full session JSON to the chosen path. Falls back
  // to focusing the preset-name field if the on-disk bridge isn't available.
  const handleSaveProjectAs = async () => {
    if (saving) return;
    if (!currentVideoId) { flash('Load a sample first'); return; }
    if (!ipc?.showSaveDialog || !ipc?.saveProjectFile) {
      setLoadedPresetId(null);
      setConfirmSave(null);
      const input = presetNameInputRef.current;
      if (input) { input.focus(); input.select(); }
      flash('Type a new name, then SAVE (⌘⇧S)');
      return;
    }
    const dataForDlg = buildPreset(currentVideoId);
    const dlg = await ipc.showSaveDialog({ bundle: projectNeedsBundle(dataForDlg) });
    if (!dlg || !('path' in dlg)) return; // cancelled
    setSaving(true);
    try {
      const data = dataForDlg;
      const res = await writeProjectToDisk(dlg.path, data);
      if (res?.error || !res?.path) { setError(res?.error ?? 'Could not save project'); return; }
      setPresetName(res.name ?? presetName);
      recordRecentProject(res.path, res.name ?? presetName);
      flash(`Project saved: ${res.name ?? 'project'}`);
    } finally {
      setSaving(false);
    }
  };

  // Load a project chosen from the File → Recent Projects submenu (recents store
  // file paths). Read it from disk first; if the file is gone, toast + drop it
  // from recents. Falls back to a named/cloud preset id for legacy recents.
  const handleLoadRecent = async (id: string) => {
    const file = await ipc?.readProjectFile?.(id);
    if (file && !('error' in file) && file.bundle) { await importProjectBytes(file.bundle, file.name); return; }
    if (file && !('error' in file) && file.data) {
      await loadProjectData(file.data, file.path, file.name);
      return;
    }
    if (namedPresets.some(p => (p.id ?? p.name) === id)) { await handleLoadNamedPreset(id); return; }
    setError('That project no longer exists');
    void ipc?.removeRecentProject?.(id);
  };

  // Live refs so the once-subscribed File-menu IPC handlers always call the
  // latest closures (fresh sample / preset list) without re-subscribing.
  const newProjectRef = useRef(handleNewProject);   newProjectRef.current = handleNewProject;
  const openProjectRef = useRef(handleOpenProject);  openProjectRef.current = handleOpenProject;
  const saveAsRef = useRef(handleSaveProjectAs);     saveAsRef.current = handleSaveProjectAs;
  const loadRecentRef = useRef(handleLoadRecent);    loadRecentRef.current = handleLoadRecent;
  const openFromPathRef = useRef(openProjectFromPath); openFromPathRef.current = openProjectFromPath;

  // Wire the native File menu (desktop). Subscribe once — handlers read the refs
  // above for current state. Save Project (Cmd+S) reuses the existing savePreset
  // shortcut handled by the window keydown listener, so it's not re-wired here.
  useEffect(() => {
    if (!ipc?.onShortcut) return;
    const offs: Array<() => void> = [];
    offs.push(ipc.onShortcut('new', () => newProjectRef.current()));
    offs.push(ipc.onShortcut('open', () => openProjectRef.current()));
    offs.push(ipc.onShortcut('saveAs', () => saveAsRef.current()));
    offs.push(ipc.onShortcut('savePreset', () => savePresetRef.current()));
    if (ipc.onLoadRecent) offs.push(ipc.onLoadRecent(id => { void loadRecentRef.current(id); }));
    // .tproj double-clicked in Finder/Explorer → load it through the file flow.
    if (ipc.onOpenFile) offs.push(ipc.onOpenFile(filePath => { void openFromPathRef.current(filePath); }));
    return () => { for (const off of offs) off(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Apply audio prefs from the Preferences window where the live Web Audio graph
  // allows. Buffer size / sample rate are fixed at AudioContext construction, so
  // only the OUTPUT DEVICE can be re-routed live (via the experimental
  // AudioContext.setSinkId). Applied on mount + whenever prefs change.
  useEffect(() => {
    if (!ipc) return;
    const applyOutput = (settings: Record<string, any>) => {
      // '' selects the system default sink. Goes through the engine so it
      // remembers the choice and can re-apply it after a device swap
      // (ChopperEngine.reopenOutput, wired to `devicechange`).
      void engine.setOutputDevice(settings?.audio?.outputDeviceId ?? '');
      // Sequencer resolution (PPQ) is a global preference — apply to the drum
      // engine's scheduler immediately (setPpq validates against PPQ_VALUES).
      const ppq = settings?.audio?.ppq;
      if (typeof ppq === 'number') drumEngine.setPpq(ppq);
    };
    void ipc.getSettings?.().then(applyOutput).catch(() => { /* no settings yet */ });
    const off = ipc.onSettingsChanged?.(applyOutput);
    return () => { off?.(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Load an independent sample into a specific pad (switches waveform to that pad)
  const loadPadSample = async (padIdx: number) => {
    const pl = playlists.find(p => p.name === selectedPlaylist);
    if (!pl || pl.entries.length === 0) { setError('Playlist is empty'); return; }
    if (!gatePull()) return;
    flash(`Loading sample for pad ${padIdx + 1}…`);
    engine.setLoading(true);
    try {
      const pick = pickFromPlaylist(pl);
      const res = await fetchTrackData(pick.id, pick.title);
      if (!res.ok) { setError(res.error ?? 'Download failed'); return; }
      const audio = await resolveAudio(res);
      const buf = await engine.decodeAudio(audio);
      const vid = res.videoId ?? pick.id;
      const title = res.title ?? pick.title;
      engine.loadPadBuffer(padIdx, buf, vid, title);
      setViewPadIdx(padIdx);
      flash(`PAD ${padIdx + 1}: ${title}`);
    } catch (e: any) {
      setError(e?.message ?? String(e));
    } finally {
      engine.setLoading(false);
    }
  };

  // ── SOURCES onto a pad (right-click menu) ────────────────────────────────
  // IMPORT LINK… → the app's own prompt (Electron has no window.prompt) → the
  // YouTube pull lands on THAT pad as its own source, same path as ↺ swap.
  const [linkPrompt, setLinkPrompt] = useState<{ padIdx: number } | null>(null);
  const loadPadFromUrl = async (padIdx: number, url: string) => {
    const u = url.trim();
    if (!u) return;
    if (!gatePull()) return;
    setError(null);
    flash(`Pulling sample for PAD ${padIdx + 1}…`);
    engine.setLoading(true);
    try {
      const res = await fetchTrackData(u);
      if (!res.ok) { setError(res.error ?? 'Download failed'); return; }
      const audio = await resolveAudio(res);
      const buf = await engine.decodeAudio(audio);
      const vid = res.videoId ?? u;
      const title = res.title ?? 'untitled';
      engine.loadPadBuffer(padIdx, buf, vid, title);
      setViewPadIdx(padIdx); // show it on the waveform — no assign mode, no banner
      flash(`PAD ${padIdx + 1}: ${title}`);
    } catch (e: any) {
      setError(e?.message ?? String(e));
    } finally {
      engine.setLoading(false);
    }
  };
  // ↥ MAKE MAIN TRACK (pad menu / STEMS ↥ in a pad-source view): a pad's own
  // sample (a YouTube link, a file, a recording) becomes the MAIN track — the
  // pad keeps its copy — so STEMS, which splits the main track, can split it.
  // Same path as loading a file as the main track (fresh sample: new main
  // block on the first free pad, pad sources kept; a split already cached for
  // this audio comes straight back).
  const makePadMainTrack = async (padIdx: number) => {
    const pb = engine.getPadBuffer(padIdx);
    if (!pb) { flash(`PAD ${padIdx + 1} has no sample of its own`); return; }
    setError(null);
    engine.setLoading(true);
    try {
      await engine.loadFromAudioBuffer(pb.buffer, pb.title);
      setViewPadIdx(null);
      setViewStart(0); setViewEnd(1);
      userZoomedRef.current = false;
      setCurrentVideoId(pb.videoId);
      setPresetName(pb.title);
      setPendingPreset(null);
      setLoadedPresetId(null); setConfirmSave(null);
      flash(`MAIN TRACK ← PAD ${padIdx + 1}: ${pb.title} — STEMS is on the waveform bar`);
    } catch (e: any) {
      setError(e?.message ?? String(e));
    } finally {
      engine.setLoading(false);
    }
  };
  // ⇣ LOAD LINK (pad menu): the link sitting in the clipboard goes straight onto
  // the pad — no box to paste into. Says so when nothing / no link is copied.
  const loadPadFromClipboard = async (padIdx: number) => {
    let text = '';
    try { text = await readClipboardText(); }
    catch { flash('COULD NOT READ THE CLIPBOARD — use ⇣ IMPORT LINK… and paste'); return; }
    const t = text.trim();
    if (!t) { flash('NOTHING COPIED — copy a YouTube link first, then LOAD LINK'); return; }
    if (!/^https?:\/\/\S+$/i.test(t)) { flash(`NOT A LINK — the clipboard has "${t.length > 32 ? t.slice(0, 31) + '…' : t}"`); return; }
    await loadPadFromUrl(padIdx, t);
  };
  // LOAD FILE… onto a pad: the shared hidden file input, aimed at the pad for
  // one pick (handleFilePick reads + clears the target).
  const filePadTargetRef = useRef<number | null>(null);
  const loadFileIntoPad = (padIdx: number) => {
    filePadTargetRef.current = padIdx;
    fileInputRef.current?.click();
  };
  // RECORD INTO PAD: open the RECORD SAMPLE panel aimed at the pad — the take
  // lands there instead of the main track (finalizeRecording reads the target).
  const [recordPadTarget, setRecordPadTarget] = useState<number | null>(null);
  const recordPadTargetRef = useRef<number | null>(null);
  recordPadTargetRef.current = recordPadTarget;

  // Find the first pad index that has no chop and no own sample
  const findNextEmptyPad = (): number => {
    const meta = state.padBufferMeta ?? {};
    const maxIdx = Math.max(state.pads.length - 1, ...Object.keys(meta).map(Number), -1);
    for (let i = 0; i <= maxIdx + 1; i++) {
      if (!state.pads[i]?.chopId && meta[i] === undefined) return i;
    }
    return maxIdx + 1;
  };

  const addSampleToNextEmptyPad = async () => {
    const padIdx = findNextEmptyPad();
    await loadPadSample(padIdx);
  };

  // ── Pad menu actions (Move / Resample) — invoked from PadGrid's per-pad □ menu ──
  // MOVE: relocate the pad's content to the first empty slot (the engine swaps
  // instead if that slot turns out occupied) + remap its sequencer steps.
  const doMovePad = (idx: number) => {
    const dest = findNextEmptyPad();
    if (dest === idx || dest < 0) { flash('No empty pad'); return; }
    engine.movePad(idx, dest);
    flash(`Moved to PAD ${dest + 1}`);
  };
  // RESAMPLE: render the pad's per-pad buffer offline (a clean copy) and print it
  // onto the next empty pad. Chop-only pads (no per-pad buffer) flash an error.
  // RESAMPLE (his ask 2026-08-22): take the CHOP or the pad's sample, print
  // what the pad actually PLAYS — its stem layers, pitch, reverse, attack, dry
  // — as a lossless FLAC, put it on the next empty pad as a fresh source, and
  // say where it went. The FLAC is an ASSET (content hash), so the project
  // names it, finds it again on this device and carries it in a bundle — the
  // old version re-used the SOURCE's id, so a reload brought the original back
  // instead of the resample, and it refused main-track chops outright.
  const doResamplePad = async (idx: number) => {
    const plan = engine.padRenderPlan(idx);
    if (!plan) { flash('Nothing on that pad to resample'); return; }
    const slot = findNextEmptyPad();
    const srcTitle = plan.isPad ? (engine.getPadBuffer(idx)?.title || 'sample') : (state.trackTitle || 'sample');
    const title = `${srcTitle.replace(/ \(resample\)$/, '')} — PAD ${idx + 1} (resample)`;
    try {
      flash(`RESAMPLING PAD ${idx + 1}…`);
      const rendered = await engine.renderPadAsPlayed(idx);
      if (!rendered) { flash('Nothing on that pad to resample'); return; }
      const flac = await encodeFlac16(rendered);
      const pseudoId = await assetStore.put(flac.buffer.slice(flac.byteOffset, flac.byteOffset + flac.byteLength) as ArrayBuffer, `${title}.flac`);
      engine.loadPadBuffer(slot, rendered, pseudoId, title);
      setViewPadIdx(slot);
      const kb = Math.round(flac.byteLength / 1024);
      flash(`RESAMPLED PAD ${idx + 1} → PAD ${slot + 1} · ${rendered.duration.toFixed(2)} s · FLAC ${kb} KB`);
    } catch (e: any) {
      flash(`Resample failed — ${e?.message ?? e}`);
    }
  };

  const isAudioFile = (f: File) =>
    f.type.startsWith('audio/') || /\.(mp3|wav|aiff?|flac|ogg|m4a|webm|opus)$/i.test(f.name);

  // 500 MB is plenty for a single sample and stops the browser tab from
  // hanging if someone drops a movie file by mistake.
  const MAX_DROP_BYTES = 500 * 1024 * 1024;

  // Load a user's own audio file as a sample. Shared by drag-and-drop and the
  // LOAD FILE picker (the picker matters on mobile, where there's no drag-drop).
  // padIdx set → load onto that pad; otherwise load as the main track (swapping
  // audio in place if chops already exist).
  const loadAudioFile = async (file: File | undefined | null, padIdx?: number) => {
    // Loading your own samples is a subscriber feature (free tier uses the
    // curated playlist pulls only). Covers the picker AND drag-and-drop.
    if (!isSubscribed()) { setSubModalOpen(true); return; }
    if (!file || (!isAudioFile(file) && !looksLikeProjectFile(file.name))) { setError('Pick an audio file (mp3, wav, flac…) or a Terminator project (.tproj / .tprojz)'); return; }
    if (file.size > MAX_DROP_BYTES) {
      setError(`File is ${(file.size / 1024 / 1024).toFixed(0)} MB — max is ${MAX_DROP_BYTES / 1024 / 1024} MB`);
      return;
    }
    // Cap title length so a stupidly long filename can't bloat displayed text
    // / preset payloads. React already escapes JSX so XSS isn't the concern;
    // bloat + accidental layout overflow is.
    const title = file.name.replace(/\.[^.]+$/, '').slice(0, 200);
    setError(null); // clear any prior decode error — a new file is loading
    engine.setLoading(true);
    try {
      const ab = await file.arrayBuffer();
      // A project file dropped/picked → import it (bundle or plain JSON).
      if (looksLikeProjectFile(file.name)) { engine.setLoading(false); await importProjectBytes(new Uint8Array(ab), file.name.replace(/\.[^.]+$/, '')); return; }
      // Your own audio becomes an ASSET (content hash) so the project can name
      // it, find it again on this device, and travel with it in a bundle.
      const pseudoId = await assetStore.put(ab, file.name);
      if (padIdx !== undefined) {
        const buf = await engine.decodeAudio(ab);
        engine.loadPadBuffer(padIdx, buf, pseudoId, title);
        setViewPadIdx(padIdx);
        flash(`PAD ${padIdx + 1}: ${title}`);
      } else if (pendingPreset && file.name === pendingPreset.fileName) {
        // The exact file this pending snapshot was waiting for — load it and
        // apply the saved chops/pads/sequences on top.
        const restored = pendingPreset.presetName;
        await engine.loadFromArrayBuffer(ab, title);
        applyPreset(pendingPreset.data);
        setViewStart(0); setViewEnd(1);
        userZoomedRef.current = false;
        setCurrentVideoId(pseudoId);
        setPresetName(restored);
        setPendingPreset(null);
        flash(`Preset restored: ${restored}`);
      } else if (state.chops.length > 1) {
        // Chops already exist — swap audio keeping the layout
        await engine.loadAudioKeepChops(ab, title);
        setCurrentVideoId(pseudoId);
        setPresetName(title);
        setPendingPreset(null);
        flash(`Swapped: ${title} — chops kept`);
      } else {
        await engine.loadFromArrayBuffer(ab, title);
        setViewStart(0); setViewEnd(1); // fit new track to full view
        userZoomedRef.current = false; // fresh track → first chop uses the default zoom again
        setCurrentVideoId(pseudoId);
        setPresetName(title);
        setPendingPreset(null);
        setLoadedPresetId(null); setConfirmSave(null); // brand-new sample → stop editing the prior preset
        flash(`Loaded: ${title}`);
      }
    } catch (err: any) {
      setError(err?.message ?? String(err));
    } finally {
      engine.setLoading(false);
    }
  };

  const handleFileDrop = async (e: React.DragEvent, padIdx?: number) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOverWaveform(false);
    await loadAudioFile(e.dataTransfer.files[0], padIdx);
  };

  // Hidden <input type=file> driven by the LOAD FILE button — the picker path
  // for browsers/devices without drag-and-drop (phones, tablets).
  const fileInputRef = useRef<HTMLInputElement>(null);
  const handleFilePick = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ''; // reset so picking the same file again re-fires change
    const padIdx = filePadTargetRef.current;
    filePadTargetRef.current = null;
    await loadAudioFile(file, padIdx ?? undefined);
  };

  // ── RECORD SAMPLE (Electron only) ─────────────────────────────────────────
  // Capture audio from a mic/interface input OR a desktop (system-audio) source
  // into a recording, save it under USER SAMPLES, and load it straight into the
  // waveform. Desktop-only: gated on `ipc` being defined.
  const [recordOpen, setRecordOpen] = useState(false);
  // Sentinel for "the phone's / browser's default microphone or plugged-in
  // input" — plain getUserMedia({ audio: true }), no exact deviceId. On the web
  // (and especially iOS Safari, which hides device ids until permission is
  // granted) this is the only choice that always works, so it leads the list
  // and is the default. System audio is Electron-only (loopback in main).
  const DEFAULT_INPUT_ID = 'default-input';
  const [recordInputId, setRecordInputId] = useState<string | null>(() => {
    try {
      const v = localStorage.getItem(RECORD_INPUT_KEY);
      if (isWeb && (!v || v === SYSTEM_AUDIO_ID)) return DEFAULT_INPUT_ID;
      return v;
    } catch { return isWeb ? DEFAULT_INPUT_ID : null; }
  });
  const [recordInputLabel, setRecordInputLabel] = useState('');
  const [recordState, setRecordState] = useState<'idle' | 'recording'>('idle');
  const [recordStream, setRecordStream] = useState<MediaStream | null>(null);
  // The mic/interface devices for the dropdown. System audio is a single fixed
  // option (SYSTEM_AUDIO_ID) captured via getDisplayMedia, not enumerated here.
  const [audioDevices, setAudioDevices] = useState<Array<{ id: string; name: string }>>([]);
  const [recordElapsed, setRecordElapsed] = useState(0); // seconds, for the MM:SS readout
  const [recordSaved, setRecordSaved] = useState(false);  // "Saved to USER SAMPLES" flash
  // Bumped after each save so the SampleBrowser's USER SAMPLES list re-fetches.
  const [userSamplesRefreshKey, setUserSamplesRefreshKey] = useState(0);
  // Working stores (refs — MediaRecorder callbacks need a stable handle, not
  // React state that goes stale inside a closure). recordChunksRef holds the
  // recorded webm/pcm Blob chunks for the live recording.
  const recordStreamRef = useRef<MediaStream | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const recordChunksRef = useRef<Blob[]>([]);
  const meterCtxRef = useRef<AudioContext | null>(null);
  const meterAnalyserRef = useRef<AnalyserNode | null>(null);
  const meterSrcRef = useRef<MediaStreamAudioSourceNode | null>(null);
  /** The tap used while recording Terminator's own output (INTERNAL_OUTPUT_ID). */
  const internalTapRef = useRef<{ dest: MediaStreamAudioDestinationNode; from: AudioNode } | null>(null);
  const dropInternalTap = () => {
    const t = internalTapRef.current; internalTapRef.current = null;
    if (!t) return;
    try { t.from.disconnect(t.dest); } catch { /* */ }
    try { t.dest.stream.getTracks().forEach(x => x.stop()); } catch { /* */ }
  };
  const meterRafRef = useRef<number>(0);
  const meterCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const recordStartMsRef = useRef<number>(0);
  const lastElapsedSecRef = useRef<number>(-1); // throttles the MM:SS state update to 1/s

  // Two-digit MM:SS for the elapsed counter.
  const fmtElapsed = (sec: number): string => {
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  };

  // Populate the input dropdown with mic/interface devices (enumerateDevices).
  // Re-run after the first getUserMedia so device labels (only exposed once mic
  // permission is granted) fill in. System audio is a fixed option, not enumerated.
  const loadRecordInputs = async () => {
    let devs: Array<{ id: string; name: string }> = [];
    try {
      let all = await navigator.mediaDevices.enumerateDevices();
      // Until the mic has been allowed once, browsers (and Electron) return the
      // inputs with BLANK names and ids — an interface or a Loopback device is
      // in the list but unrecognisable. Ask once (a short getUserMedia, tracks
      // stopped straight away), then list again with the real names.
      const blind = all.some(d => d.kind === 'audioinput' && (!d.label || !d.deviceId));
      if (blind && !recordPermAskedRef.current) {
        recordPermAskedRef.current = true;
        try {
          const st = await navigator.mediaDevices.getUserMedia({ audio: true });
          st.getTracks().forEach(t => t.stop());
          all = await navigator.mediaDevices.enumerateDevices();
        } catch { /* denied → the default option still records the OS default */ }
      }
      devs = all.filter(d => d.kind === 'audioinput' && d.deviceId && d.deviceId !== 'default')
        .map(d => ({ id: d.deviceId, name: d.label || `Input (${d.deviceId.slice(0, 6)}…)` }));
    } catch { /* permissions not granted yet → labels blank */ }
    setAudioDevices(devs);
  };
  const recordPermAskedRef = useRef(false);
  // Plug an interface in (or start Loopback) while the panel is open → the
  // list follows.
  useEffect(() => {
    const md = navigator.mediaDevices;
    if (!md || !recordOpen) return;
    const on = () => { void loadRecordInputs(); };
    md.addEventListener?.('devicechange', on);
    return () => md.removeEventListener?.('devicechange', on);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recordOpen]);

  // Live level meter — tap the input stream with an AnalyserNode → bar on canvas.
  const startMeter = (stream: MediaStream) => {
    try {
      const ctx = new AudioContext();
      const src = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      src.connect(analyser); // listen-only; never routed to destination (no monitoring echo)
      meterCtxRef.current = ctx;
      meterSrcRef.current = src;
      meterAnalyserRef.current = analyser;
      const data = new Uint8Array(analyser.frequencyBinCount);
      const draw = () => {
        const cv = meterCanvasRef.current;
        const an = meterAnalyserRef.current;
        if (cv && an) {
          an.getByteFrequencyData(data);
          let sum = 0;
          for (let i = 0; i < data.length; i++) sum += data[i] * data[i];
          const rms = Math.sqrt(sum / data.length) / 255; // 0..1
          const g = cv.getContext('2d');
          if (g) {
            const W = cv.width, H = cv.height;
            g.clearRect(0, 0, W, H);
            g.fillStyle = 'rgba(0,0,0,0.4)';
            g.fillRect(0, 0, W, H);
            const w = Math.min(1, rms * 1.6) * W;
            g.fillStyle = w > W * 0.85 ? '#ff5230' : '#35ff69';
            g.fillRect(0, 0, w, H);
          }
        }
        // Elapsed counter — only push a state update when the whole-second
        // value changes (the MM:SS readout needs no finer resolution), so the
        // meter RAF doesn't re-render this big component 60×/s.
        const secs = Math.floor((performance.now() - recordStartMsRef.current) / 1000);
        if (secs !== lastElapsedSecRef.current) { lastElapsedSecRef.current = secs; setRecordElapsed(secs); }
        meterRafRef.current = requestAnimationFrame(draw);
      };
      meterRafRef.current = requestAnimationFrame(draw);
    } catch { /* meter is cosmetic — ignore failures */ }
  };

  const stopMeter = () => {
    cancelAnimationFrame(meterRafRef.current);
    try { meterSrcRef.current?.disconnect(); } catch { /* */ }
    try { meterAnalyserRef.current?.disconnect(); } catch { /* */ }
    try { void meterCtxRef.current?.close(); } catch { /* */ }
    meterSrcRef.current = null;
    meterAnalyserRef.current = null;
    meterCtxRef.current = null;
  };

  // Start capture once the user clicks REC.
  const startRecording = async () => {
    if (!recordInputId) return;
    setError(null);
    try {
      if (recordInputId === SYSTEM_AUDIO_ID && IS_MAC) {
        throw new Error('System audio not available on Mac')
      }
      // System audio = electron-audio-loopback: enable loopback (main overrides
      // getDisplayMedia to return system-audio loopback), capture, then disable.
      // The display-media path returns video too, so strip it. A real device =
      // plain mic getUserMedia.
      let stream: MediaStream;
      if (recordInputId === SYSTEM_AUDIO_ID) {
        try {
          await ipc?.enableLoopback?.()
          stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true })
        } catch (err) {
          await ipc?.disableLoopback?.().catch(() => {})
          throw new Error('System audio capture needs Screen Recording permission. This works in the installed app; in dev it is unreliable. Tip: route system audio through Audio Routing Kit and pick it as a Mic/Interface input.')
        }
        await ipc?.disableLoopback?.()
        stream.getVideoTracks().forEach(t => { t.stop(); stream.removeTrack(t) })
        if (stream.getAudioTracks().length === 0) {
          throw new Error('No system audio captured.')
        }
      } else if (recordInputId === INTERNAL_OUTPUT_ID) {
        // TERMINATOR OUTPUT: tap the final mix — the mixer's master strip
        // (post-limiter, what the speakers get) on desktop, the engine's output
        // node otherwise — into a MediaStreamDestination. Same recorder as a
        // mic from here; nothing is routed back out, so no feedback loop.
        const from: AudioNode = engine.mixerEngine?.master.output ?? engine.outputNode;
        const dest = engine.ctx.createMediaStreamDestination();
        from.connect(dest);
        internalTapRef.current = { dest, from };
        stream = dest.stream;
      } else if (recordInputId === DEFAULT_INPUT_ID) {
        // RAW input: no echo cancel / noise gate / auto gain, stereo when the
        // device has it, the engine's rate (recordConstraints.ts — `audio:
        // true` is a phone-call request and mangled interface takes).
        stream = await navigator.mediaDevices.getUserMedia({ audio: recordAudioConstraints(null, engine.ctx.sampleRate) });
        void loadRecordInputs(); // permission granted → labels + ids now show up
      } else {
        stream = await navigator.mediaDevices.getUserMedia({ audio: recordAudioConstraints(recordInputId, engine.ctx.sampleRate) });
      }
      recordStreamRef.current = stream;
      setRecordStream(stream);
      if (recordInputId === INTERNAL_OUTPUT_ID) flash('RECORDING TERMINATOR OUTPUT — play pads, the seq, anything: STOP lands it on the next empty pad');
      else { const d = describeRecordTrack(stream.getAudioTracks()[0]); if (d) flash(`RECORDING · ${d}`); }
      // Capture with MediaRecorder, preferring the PCM codec when available
      // (finalizeRecording decodes whatever container this produces and re-encodes
      // to WAV).
      // PCM webm where it exists (Chromium/Electron); iOS/macOS Safari has no
      // webm at all and wants audio/mp4 — pick the first supported, else let the
      // browser choose. finalizeRecording decodes whatever container comes back.
      const mimeType = ['audio/webm;codecs=pcm', 'audio/webm', 'audio/mp4;codecs=mp4a.40.2', 'audio/mp4']
        .find(t => { try { return MediaRecorder.isTypeSupported(t); } catch { return false; } });
      const mr = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream)
      mediaRecorderRef.current = mr
      recordChunksRef.current = []
      mr.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) recordChunksRef.current.push(e.data)
      }
      mr.onstop = () => { void finalizeRecording() }
      mr.start()
      recordStartMsRef.current = performance.now();
      lastElapsedSecRef.current = -1;
      setRecordElapsed(0);
      setRecordState('recording');
      startMeter(stream);
      void loadRecordInputs(); // labels are now available — refresh the dropdown
    } catch (e: any) {
      // Release everything acquired before the throw so the mic/loopback doesn't
      // stay hot (mirrors stopRecording).
      try { recordStreamRef.current?.getTracks().forEach(t => t.stop()); } catch { /* */ }
      recordStreamRef.current = null;
      mediaRecorderRef.current = null;
      setRecordStream(null);
      stopMeter(); dropInternalTap();
      setError(`Recording failed: ${e?.message ?? String(e)}`);
      setRecordState('idle');
    }
  };

  // Stop capture — MediaRecorder.onstop fires finalizeRecording.
  const stopRecording = () => {
    const mr = mediaRecorderRef.current
    if (mr && mr.state !== 'inactive') mr.stop()
    const stream = recordStreamRef.current
    if (stream) { stream.getTracks().forEach(t => t.stop()); recordStreamRef.current = null }
    setRecordStream(null)
  };

  // Decode the MediaRecorder output (webm/pcm) → re-encode as real 16-bit WAV →
  // save under USER SAMPLES → load into the waveform.
  const finalizeRecording = async () => {
    stopMeter(); dropInternalTap();
    const chunks = recordChunksRef.current;
    recordChunksRef.current = [];
    mediaRecorderRef.current = null;
    const stream = recordStreamRef.current;
    if (stream) { stream.getTracks().forEach(t => t.stop()); recordStreamRef.current = null; }
    setRecordStream(null);
    setRecordState('idle');
    if (chunks.length === 0) return;
    const rawBlob = new Blob(chunks);
    const filename = `${recordInputId === INTERNAL_OUTPUT_ID ? 'resample' : 'recording'}-${recordTimestamp()}.wav`;
    let tmpCtx: AudioContext | null = null;
    try {
      const rawBuffer = await rawBlob.arrayBuffer();
      // Decode the recorded container to raw PCM, then re-encode as 24-bit WAV
      // (an interface's converters are 24-bit; 16 threw away the bottom bits).
      tmpCtx = new AudioContext();
      const decoded = await tmpCtx.decodeAudioData(rawBuffer);
      const data = encodeWAV(decoded, 24);
      // Into the Sample Library (RECORDINGS) when the bridge has it; older
      // preloads fall back to the legacy user-samples dir.
      const res = libraryBridge
        ? await libraryBridge.saveRecording({ filename, data })
        : await ipc?.saveUserSample?.({ filename, data });
      if (res && 'error' in (res as any)) { setError((res as any).error || 'Save failed'); return; }
      setRecordSaved(true);
      setTimeout(() => setRecordSaved(false), 2000);
      setUserSamplesRefreshKey(k => k + 1);
      // The take lands on a PAD — the one RECORD INTO aimed at, else the next
      // empty pad (his rule 2026-08-22: "whenever I record a new sample it
      // should load onto the next empty pad"). Never the main track.
      let padIdx = recordPadTargetRef.current;
      if (padIdx === null) { padIdx = 0; while (engine.padSourceKey(padIdx)) padIdx++; }
      await loadAudioFile(new File([data], filename, { type: 'audio/wav' }), padIdx);
      setRecordPadTarget(null); flash(`PAD ${padIdx + 1}: recorded`);
    } catch (e: any) {
      setError(`Save failed: ${e?.message ?? String(e)}`);
    } finally {
      try { void tmpCtx?.close(); } catch { /* */ }
    }
  };

  // recording-YYYYMMDD-HHMMSS.wav
  const recordTimestamp = (): string => {
    const d = new Date();
    const p = (n: number) => n.toString().padStart(2, '0');
    return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  };

  // REC button click — idle → recording (1 click) → (stop+save) → idle.
  const onRecClick = () => {
    if (recordState === 'idle') {
      if (!recordInputId) return; // disabled, but guard anyway
      void startRecording();
    } else {
      stopRecording();
    }
  };

  const toggleRecordPanel = () => {
    if (demoBlock()) return;
    setRecordOpen(open => {
      const next = !open;
      if (next) void loadRecordInputs(); // refresh inputs each time the panel opens
      return next;
    });
  };

  const onSelectRecordInput = (value: string, label: string) => {
    setRecordInputId(value || null);
    setRecordInputLabel(label);
    try { if (value) localStorage.setItem(RECORD_INPUT_KEY, value); else localStorage.removeItem(RECORD_INPUT_KEY); } catch { /* */ }
  };

  // Tear down any in-flight recording when the view unmounts.
  useEffect(() => () => {
    cancelAnimationFrame(meterRafRef.current);
    try { mediaRecorderRef.current?.stop(); } catch { /* */ }
    recordStreamRef.current?.getTracks().forEach(t => t.stop());
    try { void meterCtxRef.current?.close(); } catch { /* */ }
  }, []);

  // Load a saved recording back into the waveform (USER SAMPLES row click).
  const loadUserSampleIntoWaveform = async (filename: string) => {
    setSampleBrowserOpen(false);
    try {
      const ab = await ipc?.loadUserSample?.(filename);
      if (!ab) { setError('Could not load recording'); return; }
      await loadAudioFile(new File([ab], filename, { type: 'audio/wav' }));
    } catch (e: any) {
      setError(e?.message ?? String(e));
    }
  };

  // Load a saved YouTube track/url (USER → + YouTube row click) — same path as
  // GET SAMPLE (gated pull + download + load).
  const loadYouTubeFromBrowser = (idOrUrl: string, title: string) => {
    const ok = gatePull();
    setSampleBrowserOpen(false);
    if (ok) { setError(null); void loadTrackById(idOrUrl, title); }
  };

  // When chops reset (fresh load), anchor zoom on chop 1's start
  useEffect(() => {
    if (state.lastSlicedChopId !== null || !engine.buffer || state.chops.length === 0) return;
    zoomAnchorRef.current = state.chops[0].start / engine.buffer.duration;
  }, [state.chops, state.lastSlicedChopId]);

  // When a new chop is created, focus on it. Once the user has set their own
  // zoom (userZoomedRef), we KEEP that zoom and only pan to bring the chop into
  // view — we never re-zoom. Before they've touched the zoom (fresh track), the
  // first chop snaps to the default zoom so the boundary handle is easy to grab.
  const DEFAULT_CHOP_ZOOM = 6000; // zoom readout uses 100/span, so span = 100/zoom
  useEffect(() => {
    if (state.lastSlicedChopId === null || !engine.buffer) return;
    const chop = state.chops.find(c => c.id === state.lastSlicedChopId);
    if (!chop) return;
    const dur = engine.buffer.duration;
    const cs = chop.start / dur;
    const ce = chop.end / dur;
    zoomAnchorRef.current = cs;

    // Default zoom only on web/mobile, and only until the user sets their own.
    if (isWeb && !userZoomedRef.current) {
      const span = Math.max(0.005, 100 / DEFAULT_CHOP_ZOOM);
      let ns = Math.max(0, cs - span / 2); // chop start sits in the middle
      let ne = ns + span;
      if (ne > 1) { ne = 1; ns = Math.max(0, ne - span); }
      setViewStart(ns); setViewEnd(ne);
      return;
    }

    // Otherwise (desktop, or the user has set a zoom): keep the current zoom,
    // only pan if the new chop isn't already visible.
    const { viewStart: vs, viewEnd: ve } = viewRef.current;
    if (cs >= vs && ce <= ve) return; // already visible, don't move
    const span = ve - vs;
    let ns = Math.max(0, cs - span * 0.1);
    let ne = ns + span;
    if (ne > 1) { ne = 1; ns = Math.max(0, ne - span); }
    setViewStart(ns); setViewEnd(ne);
  }, [state.lastSlicedChopId]);

  const onPadTrigger = (idx: number, vel = 1, eventTimestamp?: number) => {
    // BASS MIDI IN: the 16 pad keys become a keyboard into the bass synth —
    // folded to the key when LOCK is on (every pad a different in-key note),
    // chromatic from C2 otherwise.
    if (bassMidiRef.current) { bassEngine.padOn(idx, vel); return; }
    // DRUM PADS mode: pad i fires drum lane i — EVERY lane, added ones included,
    // in lane order (his ask 2026-08-22: nine sounds → pads 1-9) — and
    // live-records into the drum sequencer when it's playing (recordLiveHit is a
    // no-op while stopped). Pads past the last lane still trigger chops normally.
    if (drumPadModeRef.current && idx < drumTracksRef.current.length) {
      const key = drumTracksRef.current[idx].key;
      if (drumStepRecRef.current) {
        drumEngine.playLive(key);
        drumEngine.recordStepHit(idx);   // step mode: fills cursor step + advances
      } else {
        // Live: one entry for play + record — lag backdating, output-latency
        // comp, grid-ON audible quantize while recording (see liveHit).
        drumEngine.liveHit(idx, eventTimestamp);
      }
      return;
    }
    // Locked pad (free tier): surface the upsell instead of triggering. The
    // engine also rejects it, but this is the common path (keyboard + tap) so
    // we pop the modal here for conversion.
    if (padLockFrom !== null && idx >= padLockFrom) { setSubModalOpen(true); return; }
    // TAP-tempo via pads: when armed (web only), pad hits also feed the BPM
    // calculator. The sample still plays so the user can tap along to it.
    if (tapArmedRef.current) handleTapHit();
    engine.triggerPad(idx, vel, eventTimestamp);
    // The waveform follows the pad you hit: its own source when it has one, the
    // main track when it is a chop of it (so tapping back onto a chop pad
    // returns you from a pad-source view).
    if (state.padBufferMeta?.[idx]) setViewPadIdx(idx);
    else if (viewPadIdx !== null && state.pads[idx]?.chopId != null) setViewPadIdx(null);
  };
  const onPadRelease = (idx: number) => {
    if (bassMidiRef.current) { bassEngine.padOff(idx); return; }
    // Drum-mode pads are one-shots — nothing to release.
    if (drumPadModeRef.current && idx < drumTracksRef.current.length) return;
    engine.releasePad(idx);
  };
  // Always-current handles so the mount-once keyboard effect below never holds a
  // stale onPadTrigger/onPadRelease (those are recreated every render).
  const onPadTriggerRef = useRef(onPadTrigger); onPadTriggerRef.current = onPadTrigger;
  const onPadReleaseRef = useRef(onPadRelease); onPadReleaseRef.current = onPadRelease;
  // P4 — keyboard → pad, ALWAYS active on web regardless of which section is
  // visible (waveform / sequencer / drums / FX / presets; PADS collapsed OR
  // expanded; pad grid on- or off-screen). This is the SINGLE keyboard owner on
  // web — PadGrid's own window handler is disabled via captureKeyboard={!isWeb},
  // and its visual bank follows padBank — so there is never a double-trigger.
  // Mirrors PadGrid's map + guards: 1234567890qwerty… → pads, −/= shift bank,
  // note-on/off, e.repeat de-dup, and the text-input guard (kept verbatim; range
  // inputs are excluded so faders still receive keys). MIDI already triggers
  // pads from any section (its handler has no section guard) — unchanged.
  useEffect(() => {
    if (!isWeb) return;   // native always mounts PadGrid, which owns the keys
    const SEQ = '1234567890qwertyuiopasdfghjklzxcvbnm';
    const BANK = SEQ.length;
    const held = new Set<string>();
    const isTyping = (t: EventTarget | null) =>
      (t instanceof HTMLInputElement && t.type !== 'range') || t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement;
    const codeToKey = (e: KeyboardEvent): string => {
      if (e.code.startsWith('Digit')) return e.code.slice(5);
      if (e.code.startsWith('Key')) return e.code.slice(3).toLowerCase();
      return e.key.toLowerCase();
    };
    const onDown = (e: KeyboardEvent) => {
      if (e.repeat || e.metaKey || e.ctrlKey || e.altKey) return;
      if (sampleBrowserOpenRef.current || finishHimOpenRef.current || helpOpenRef.current) return; // a modal owns the keyboard
      if (isTyping(e.target) || (e.target as HTMLElement | null)?.isContentEditable) return;
      // Bank shift: − previous 36, = next 36 (reach pads beyond slot 35).
      if (e.key === '-' || e.key === '=') {
        const cap = Math.max(0, Math.ceil(engine.getState().pads.length / BANK) - 1);
        setPadBank(b => Math.max(0, Math.min(cap, b + (e.key === '=' ? 1 : -1))));
        e.preventDefault();
        return;
      }
      const key = codeToKey(e);
      const slot = SEQ.indexOf(key);
      if (slot < 0) return;
      if (held.has(key)) return;
      held.add(key);
      e.preventDefault();
      onPadTriggerRef.current(padBankRef.current * BANK + slot, 1, e.timeStamp);
    };
    const onUp = (e: KeyboardEvent) => {
      const key = codeToKey(e);
      const slot = SEQ.indexOf(key);
      if (slot < 0) return;
      held.delete(key);
      onPadReleaseRef.current(padBankRef.current * BANK + slot);
    };
    const onBlur = () => held.clear();
    window.addEventListener('keydown', onDown);
    window.addEventListener('keyup', onUp);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('keydown', onDown);
      window.removeEventListener('keyup', onUp);
      window.removeEventListener('blur', onBlur);
    };
  }, [engine]);
  // Keep the keyboard bank in range when the pad count shrinks (RESET / DEL ALL).
  useEffect(() => {
    const maxBank = Math.max(0, Math.ceil(state.pads.length / 36) - 1);
    if (padBank > maxBank) setPadBank(maxBank);
  }, [state.pads.length, padBank]);
  // Right-click / clear-block: show the pad's own sample on the waveform, nothing else.
  const onPadFocus = (idx: number) => {
    if (state.padBufferMeta?.[idx]) setViewPadIdx(idx);
    else if (viewPadIdx !== null) setViewPadIdx(null);
  };
  const onPadSelect = (idx: number) => {
    engine.selectPad(state.selectedPad === idx ? null : idx);
    // Switch waveform if this pad has its own buffer
    if (state.padBufferMeta?.[idx]) setViewPadIdx(idx);
    else if (viewPadIdx !== null) setViewPadIdx(null);
  };
  // Functional update: no closure over viewPadIdx, so the callback is stable
  // and the clipboard ops can take it directly (no ref-mirror needed).
  const onPadClear = useCallback((idx: number) => {
    engine.clearPad(idx);
    setViewPadIdx(v => (v === idx ? null : v));
  }, [engine]);

  // ── Pad selection + clipboard (shared by the grid's menu and the keyboard) ──
  // One selection, one clipboard, owned here so ⌘X/C/V, DELETE and the pad menu
  // can never disagree about what is selected.
  const padSel = usePadSelection(engine);
  const padSelRef = useRef(padSel); padSelRef.current = padSel;

  // INPUT Q — one global fader (SWING's drag pattern: local state while
  // dragging, ONE engine commit + ONE history snapshot per drag; per-move
  // emits would re-render everything and starve the 25 ms scheduler). It only
  // shapes FUTURE recorded hits, never the running audio.
  const [iqDrag, setIqDrag] = useState<number | null>(null);
  const iqPct = iqDrag ?? Math.round(state.inputQuantize ?? 100);
  const iqDragRef = useRef(iqPct);
  iqDragRef.current = iqPct;
  const iqTip = useFaderTooltip(iqPct, 0, 100);
  const startIqDrag = (): void => {
    engine.recordHistory();
    iqTip.onPointerDown();
    const commit = (): void => {
      window.removeEventListener('pointerup', commit);
      window.removeEventListener('pointercancel', commit);
      engine.setInputQuantize(iqDragRef.current);
      setIqDrag(null);
    };
    window.addEventListener('pointerup', commit);
    window.addEventListener('pointercancel', commit);
  };

  // ── STEMS (per-pad source separation — STEM-SPLIT-PLAN.md Phase 3) ─────────
  // The controller owns the split session + asset round-trip; this block is
  // just UI state. Splitting runs on the DESKTOP app only (Pro): web clicks
  // funnel to the desktop download, free desktop clicks to the sub modal.
  const stemsCtl = useMemo(() => new StemsController(engine), [engine]);
  const [stemsUi, setStemsUi] = useState<StemsUiState>(stemsCtl.state);
  const [stemsMenu, setStemsMenu] = useState(false);
  if (import.meta.env.DEV) (window as any).__stems = stemsCtl; // dev probe, like __chopper
  useEffect(() => {
    stemsCtl.onState = setStemsUi;
    stemsCtl.onNote = flash;
    return () => { stemsCtl.onState = null; stemsCtl.onNote = null; };
  }, [stemsCtl]); // eslint-disable-line react-hooks/exhaustive-deps
  // GLOBAL STEMS CACHE (his ask 2026-08-20): a NEW main track asks the machine
  // whether it already split this exact audio — hit = stems back instantly, no
  // worker, no models. Debounced so a project load's own restore (which owns
  // the same buffer) goes first; tryCache no-ops once stems are installed.
  const stemsBufSeenRef = useRef<AudioBuffer | null>(null);
  const stemsCacheTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    const buf = engine.buffer;
    if (!buf || stemsBufSeenRef.current === buf) return;
    stemsBufSeenRef.current = buf;
    if (stemsCacheTimerRef.current) clearTimeout(stemsCacheTimerRef.current);
    stemsCacheTimerRef.current = setTimeout(() => { void stemsCtl.tryCache(); }, 300);
  }, [state, engine, stemsCtl]);
  useEffect(() => () => { if (stemsCacheTimerRef.current) clearTimeout(stemsCacheTimerRef.current); }, []);
  useEffect(() => { if (stemsUi.error) flash(`STEMS: ${stemsUi.error}`); }, [stemsUi.error]); // eslint-disable-line react-hooks/exhaustive-deps
  // STEMS PER SOURCE: the waveform decides what a split is about — the main
  // track, or the pad's OWN sample when a pad-source view is up. Each source
  // keeps its stems; they all coexist in the kit (his workflow 2026-08-22).
  const stemsViewTarget = (): StemsTarget | null => {
    if (padViewMeta && viewPadIdx !== null) { const b = engine.padSourceBuffer(viewPadIdx); return b ? { kind: 'source', buffer: b } : null; }
    return engine.buffer ? MAIN_TARGET : null;
  };
  const startStems = (q: StemsQuality): void => {
    setStemsMenu(false);
    if (!isSubscribed()) { setSubModalOpen(true); return; }
    const target = stemsViewTarget();
    if (!target) return;
    // His call 2026-08-21: STEMS always splits the WHOLE sample (the whole song
    // runs top to bottom in order (9fc7146)); the
    // scoped split buttons are gone. Right-click = FAST / FINE / REMOVE.
    // (no toast — StemsSplitStatus shows the live line for the whole split)
    const spanOf = (t: StemsTarget): Span => { const s = t.kind === 'main' ? (engine.sourceBuffer ?? engine.buffer!) : t.buffer; return { startSec: 0, endSec: s.duration }; }; // the split sees the ORIGINAL (pre-trim) audio
    // SEVERAL PADS SELECTED (shift-click) → every sample they play goes in the
    // queue and splits back to back (his ask 2026-08-22). One pad / none → the
    // sample on screen, as before.
    const sel = padSel.selected;
    if (sel.length > 1) {
      const jobs: Array<{ target: StemsTarget; span: Span }> = [];
      for (const i of sel) { const t = stemsCtl.targetForPad(i); if (t) jobs.push({ target: t, span: spanOf(t) }); }
      if (jobs.length > 1) { stemsCtl.startMany(q, jobs); return; }
    }
    void stemsCtl.start(q, 'all', spanOf(target), target);
  };
  // ── TRIM (his ask 2026-08-21, julienne-style): arm TRIM, drag-highlight a
  // section of the waveform, then TRIM again / DELETE / ⌘X / right-click →
  // DELETE SECTION cuts it out (gap closes). Non-destructive in the engine
  // (addTrim / restoreTrims); ⌘Z undoes, right-click TRIM restores all.
  const [trimMode, setTrimMode] = useState(false);
  const [trimSel, setTrimSel] = useState<{ a: number; b: number } | null>(null);
  const [trimMenu, setTrimMenu] = useState<{ x: number; y: number } | null>(null);
  // Context menus never leave the window: measured + nudged after render.
  const saveMenuRef = useRef<HTMLDivElement>(null);
  const trimMenuRef = useRef<HTMLDivElement>(null);
  useKeepOnScreen(saveMenuRef, saveMenu ? `${saveMenu.x},${saveMenu.y}` : null);
  useKeepOnScreen(trimMenuRef, trimMenu ? `${trimMenu.x},${trimMenu.y}` : null);     // right-click on the highlight
  const [trimRestoreMenu, setTrimRestoreMenu] = useState(false);                        // right-click on the button
  const trimRef = useRef<{ mode: boolean; sel: { a: number; b: number } | null }>({ mode: false, sel: null });
  trimRef.current = { mode: trimMode, sel: trimSel };
  const doTrim = () => {
    const sel = trimRef.current.sel;
    if (!sel) return;
    const ok = engine.addTrim(sel.a, sel.b);
    setTrimSel(null); setTrimMenu(null);
    flash(ok ? `TRIMMED ${(sel.b - sel.a).toFixed(2)}s — gap closed (⌘Z undoes · right-click TRIM restores)` : 'Nothing to trim there');
  };
  // Leaving the main-track view, or a new sample, drops the trim tool + highlight.
  useEffect(() => { if (viewPadIdx !== null || !state.hasBuffer) { setTrimMode(false); setTrimSel(null); setTrimMenu(null); } }, [viewPadIdx, state.hasBuffer]);
  useEffect(() => { setTrimSel(null); setTrimMenu(null); }, [state.bufferDuration]);
  // Clicking anywhere OUTSIDE the waveform section leaves trim mode (his call):
  // the tool is a moment, not a state you have to remember to switch off.
  useEffect(() => {
    if (!trimMode) return;
    const onDown = (e: PointerEvent) => {
      const el = e.target as Element | null;
      if (el && el.closest && el.closest('.chopper-waveform-wrap')) return;
      setTrimMode(false); setTrimSel(null); setTrimMenu(null);
    };
    window.addEventListener('pointerdown', onDown, true);
    return () => window.removeEventListener('pointerdown', onDown, true);
  }, [trimMode]);
  // A chop cut while stems exist auto-queues its window (lands in seconds) —
  // but only chops created NOW: the seen-set re-seeds on load/new-track so a
  // restored project never kicks a surprise split.
  const stemsChopsSeenRef = useRef<Set<number> | null>(null);
  useEffect(() => {
    const ids = new Set(state.chops.map(c => c.id));
    const seen = stemsChopsSeenRef.current;
    stemsChopsSeenRef.current = ids;
    if (!seen || !engine.hasStems()) return;
    for (const c of state.chops) {
      if (seen.has(c.id)) continue;
      const pad = state.pads.find(p => p.chopId === c.id);
      if (pad) void stemsCtl.ensureChopSplit(pad.index);
    }
  }, [state.chops, engine, stemsCtl]); // eslint-disable-line react-hooks/exhaustive-deps
  // STEMS PER SOURCE: (1) a pad's own sample that just landed asks the machine
  // whether it was split before (per-source twin of the main-track tryCache);
  // (2) a NEW piece chopped off a split pad source gets its span split too.
  const stemsSrcSeenRef = useRef<WeakSet<AudioBuffer>>(new WeakSet());
  const stemsSrcPadsSeenRef = useRef<Set<number> | null>(null);
  useEffect(() => {
    const meta = state.padBufferMeta ?? {};
    const idxs = Object.keys(meta).map(Number);
    const seenPads = stemsSrcPadsSeenRef.current;
    stemsSrcPadsSeenRef.current = new Set(idxs);
    for (const i of idxs) {
      const buf = engine.padSourceBuffer(i);
      if (!buf) continue;
      if (!stemsSrcSeenRef.current.has(buf)) { stemsSrcSeenRef.current.add(buf); setTimeout(() => { void stemsCtl.tryCacheSource(buf); }, 300); }
      else if (seenPads && !seenPads.has(i) && engine.hasSourceStems(buf)) void stemsCtl.ensureChopSplit(i);
    }
  }, [state.padBufferMeta, engine, stemsCtl]); // eslint-disable-line react-hooks/exhaustive-deps
  // Free-tier lock: clipboard writes never land at/after this line. Read via
  // the existing ref so the memoized callbacks below never capture a stale lock.
  const padPasteLimit = useCallback(() => padLockFromRef.current ?? PAD_GRID_MAX, []);
  /** Pads an action applies to. `explicit` is what the pad MENU aims at; with
   *  none (the keyboard) it is the selection, falling back to the pad the
   *  waveform is on. `needAudio` drops empty pads — they are paste targets, not
   *  things you can copy. */
  const padTargets = useCallback((needAudio: boolean, explicit?: number[]): number[] => {
    const s = padSelRef.current;
    let list = explicit ?? s.selected;
    if (!list.length) { const fp = engine.focusedPad(); list = fp === null ? [] : [fp]; }
    return needAudio ? list.filter(i => !isPadEmpty(engine, i)) : list;
  }, [engine]);

  const doPadCopy = useCallback((pads?: number[]) => {
    const t = padTargets(true, pads);
    const items = copyPads(engine, t);
    if (!items.length) return;
    padSelRef.current.setClipboard(items);
    flash(items.length > 1 ? `${items.length} PADS COPIED` : `PAD ${t[0] + 1} COPIED`);
  }, [engine, padTargets]);

  const doPadCut = useCallback((pads?: number[]) => {
    const t = padTargets(true, pads);
    // Cut EMPTIES the pads non-destructively (unassign) — the chop must
    // survive in the waveform for the paste. clearPad would splice it.
    const items = cutPads(engine, t, (i) => setViewPadIdx(v => (v === i ? null : v)));
    if (!items.length) return;
    padSelRef.current.setClipboard(items);
    padSelRef.current.drop(t);           // those pads are empty now — leave the selection
    flash(items.length > 1 ? `${items.length} PADS CUT` : `PAD ${t[0] + 1} CUT`);
  }, [engine, padTargets]);

  const doPadPaste = useCallback((at?: number) => {
    const s = padSelRef.current;
    if (!s.clipboard?.length) return;
    // Land where the menu was opened; from the keyboard, on the pad the user
    // last POINTED at (empty-pad click / last shift-add), else the pad the
    // waveform is on. Never the lowest selected index — ⌘V after selecting
    // 1, 5, 9 used to paste at 1 and overwrite the unselected 2 and 3.
    const aim = s.aim();
    const dest = at ?? (aim !== null && s.sel.has(aim) ? aim : s.selected.length === 1 ? s.selected[0] : engine.focusedPad());
    if (dest == null) return;
    const n = pastePads(engine, dest, s.clipboard, padPasteLimit());
    if (!n) return;
    const dropped = s.clipboard.length - n;
    flash(dropped > 0 ? `PASTED ${n} OF ${s.clipboard.length} — no room past PAD ${padPasteLimit()}`
      : n > 1 ? `${n} PADS PASTED FROM PAD ${dest + 1}` : `PASTED → PAD ${dest + 1}`);
  }, [engine, padPasteLimit]);

  const doPadDelete = useCallback((pads?: number[]) => {
    const t = padTargets(true, pads);
    const n = clearPads(engine, t, onPadClear);
    if (!n) return;
    padSelRef.current.drop(t);
    flash(n > 1 ? `${n} PADS CLEARED` : `PAD ${t[0] + 1} CLEARED`);
  }, [engine, padTargets, onPadClear]);

  const doPadDuplicate = useCallback((pads?: number[]) => {
    const t = padTargets(true, pads);
    const n = duplicatePads(engine, t, padPasteLimit());
    if (n) flash(n > 1 ? `${n} PADS DUPLICATED` : `PAD ${t[0] + 1} DUPLICATED`);
    else if (t.length) flash('Pads full');
  }, [engine, padTargets, padPasteLimit]);
  // The waveform follows the pad you HIT — from anywhere: mouse, keyboard,
  // MIDI, the sequencer's live taps. onPadTrigger covers the view's own paths;
  // this covers the engine-direct ones (MIDI → engine.triggerPad) the same way,
  // off the activity channel (no full-state re-render per note). A pad with its
  // own source → its source view; a main-track chop → back to the main track.
  useEffect(() => engine.subscribeActivity(a => {
    const idx = a.lastTriggeredPad;
    if (idx === null) return;
    // setState with the same value bails out — cheap to call on every hit.
    if (engine.getPadBuffer(idx)) setViewPadIdx(idx);
    else if (engine.resolvePadSource(idx)) setViewPadIdx(null);
  }), [engine]);
  const onPadPitch = (idx: number, s: number) => engine.setPadPitch(idx, s);

  // Waveform: in per-pad view, show that pad's buffer + virtual trim chop
  const padViewMeta = viewPadIdx !== null ? state.padBufferMeta?.[viewPadIdx] : null;
  // STEMS: with the main track split, the waveform is a per-chop COMPOSITE —
  // each chop's span drawn with ITS pad's stem mix, the rest the original
  // (engine.waveformBuffer keys + caches it). Pad-source view wins.
  const waveformBuffer = padViewMeta ? (engine.padSourceWaveformBuffer(viewPadIdx!) ?? engine.getPadBuffer(viewPadIdx!)?.buffer ?? engine.buffer) : engine.waveformBuffer();
  // Pad-source view: the waveform shows the SOURCE with EVERY pad that plays
  // from it drawn as a chop (a virtual chop id per pad: PAD_CHOP_BASE + pad),
  // so a chopped source reads like the main track — click a chop = play its
  // pad, drag its edges = trim that pad, double-click = chop it further.
  const PAD_CHOP_BASE = 100000;
  const padSourceChops = padViewMeta && viewPadIdx !== null ? engine.padSourceChops(viewPadIdx) : [];
  // The waveform bar (RESET · REV · ATTACK · PITCH · START/END) acts on the
  // source ON SCREEN: the main track, or the pad source in view.
  // Per GROUP: the viewed pad's group key (its own source, or the group it sits
  // in), so ATTACK / PITCH / FINE / REV read and write that group's settings.
  const viewSourceKey = padViewMeta && viewPadIdx !== null ? (engine.padSourceKey(viewPadIdx) ?? `src:${padViewMeta.videoId}`) : 'main';
  const viewFx = engine.sourceSettings(viewSourceKey);
  const waveformState = padViewMeta
    ? {
        ...state,
        chops: padSourceChops.map(c => ({ id: PAD_CHOP_BASE + c.padIdx, start: c.start, end: c.end })),
        pads: padSourceChops.map(c => ({
          index: c.padIdx,
          chopId: PAD_CHOP_BASE + c.padIdx,
          mode: (state.pads[c.padIdx]?.mode ?? 'oneshot') as any,
          color: state.pads[c.padIdx]?.color ?? '#00ff88',
          pitch: state.pads[c.padIdx]?.pitch ?? 0,
          gate: state.pads[c.padIdx]?.gate,
          fadeIn: state.pads[c.padIdx]?.fadeIn,
          fadeOut: state.pads[c.padIdx]?.fadeOut,
        })),
        selectedPad: viewPadIdx,
        bpm: 0,
        trackTitle: padViewMeta.title,
      }
    : state;

  // Waveform action buttons (SNAP · AUTO-CHOP · REV · RESET · DEL ALL · NORM).
  // On web they merge into the WaveformView zoom-bar (one single controls row —
  // see toolbarExtra below); on desktop/Electron they render in their own
  // .wave-actions-row strip above the waveform (Electron passes no toolbarExtra).
  const waveActionButtons = (
    <>
      <button
        className={`btn-chop-mode ${state.snapMode !== 'off' ? 'chop-mode-on' : ''}`}
        onClick={() => engine.setSnapMode(state.snapMode === 'off' ? 'transient' : 'off')}
        title="Snap chop boundaries to the nearest detected transient."
      >
        {state.snapMode !== 'off' ? '⊹ SNAP ON' : '⊹ SNAP OFF'}
      </button>
      <RevButton
        engine={engine}
        selected={padSel.selected}
        sourceKey={viewSourceKey}
        sourceReversed={viewFx.reverse}
        inSourceView={!!padViewMeta}
        disabled={!state.hasBuffer && !padViewMeta}
        flash={flash}
      />
      <button
        className="btn-reset-chops"
        onClick={() => {
          if (padViewMeta && viewPadIdx !== null) { const k = engine.resetPadSource(viewPadIdx); if (k !== null) { setViewPadIdx(k); flash(`Source back on PAD ${k + 1}, whole`); } }
          else engine.autoChop(1);
        }}
        disabled={!state.hasBuffer && !padViewMeta}
        title={padViewMeta ? 'Reset THIS source — back to one pad holding the whole audio, its other pads emptied' : 'Reset — full sample back on pad 1, clear all chop points'}
      >
        RESET
      </button>
      {/* TRIM — cut a highlighted section out of the sample (main track only). */}
      {!padViewMeta && (
        <span style={{ position: 'relative', display: 'inline-flex' }} onMouseLeave={() => setTrimRestoreMenu(false)}>
          <button
            className={`btn-chop-mode ${trimMode ? 'chop-mode-on' : ''} ${trimMode && trimSel ? 'trim-armed' : ''}`}
            disabled={!state.hasBuffer}
            onClick={() => { if (trimMode && trimSel) { doTrim(); return; } setTrimMode(m => !m); setTrimSel(null); setTrimMenu(null); }}
            onContextMenu={e => { e.preventDefault(); setTrimRestoreMenu(m => !m); }}
            title={trimMode
              ? 'TRIM ON — drag across the waveform to highlight a section, then click TRIM again (or DELETE / ⌘X, or right-click the highlight) to cut it out: the gap closes, chops after it slide along, chops inside it go with the cut. ESC, clicking TRIM with nothing highlighted, or clicking anywhere outside the waveform leaves trim mode. Right-click TRIM = RESTORE TRIM'
              : 'TRIM — cut sections out of the sample (an intro, a break, a bar you don\'t want). Click, drag across the waveform to highlight, click TRIM again to cut. Non-destructive: ⌘Z undoes, right-click TRIM restores everything. Stems and the saved project follow the cut'}
          >
            {trimMode ? (trimSel ? '✂ TRIM IT' : '✂ TRIM ON') : state.trimCount ? `✂ TRIM (${state.trimCount})` : '✂ TRIM'}
          </button>
          {trimRestoreMenu && (
            <div style={{ position: 'absolute', top: '100%', left: 0, zIndex: 40, background: 'var(--bg2, #101410)', border: '1px solid var(--border, #2a2f2a)', borderRadius: 4, minWidth: 220, padding: 4, display: 'flex', flexDirection: 'column', gap: 2 }}>
              <button className="btn-chop-mode" style={{ textAlign: 'left' }} disabled={!state.trimCount}
                title="Bring back every trimmed section — with the chops they swallowed, on their old pads when those are still empty (one undo step)"
                onClick={() => { setTrimRestoreMenu(false); if (engine.restoreTrims()) flash('TRIMS RESTORED — the whole sample is back'); }}>
                ↺ RESTORE TRIM{state.trimCount ? ` (${state.trimCount} cut${state.trimCount === 1 ? '' : 's'} · ${state.trimmedSec.toFixed(1)}s)` : ' — nothing trimmed'}
              </button>
            </div>
          )}
        </span>
      )}
      {(() => {
        // NORM follows the waveform: the main track, or the pad source it is
        // showing (that sample's OWN peak — his report 2026-08-22: NORM was
        // greyed out whenever a link on a pad was on screen).
        const srcKey = padViewMeta ? `src:${padViewMeta.videoId}` : null;
        const on = srcKey ? !!state.sourceNorm?.[srcKey] : state.normalizeOn;
        const gain = srcKey ? (state.sourceNorm?.[srcKey] ?? 1) : state.normalizeGain;
        const can = srcKey ? viewPadIdx !== null : state.hasBuffer;
        return (<>
          <button
            className={`btn-transport btn-transport-norm ${on ? 'norm-on' : ''}`}
            onClick={() => { if (srcKey && viewPadIdx !== null) engine.setSourceNormalize(viewPadIdx, !on); else engine.setNormalize(!on); }}
            disabled={!can}
            title={!can ? 'Load a sample first to normalize it'
              : srcKey ? 'NORM — peak-normalize THIS pad\'s own sample to −1 dBFS (every pad playing from it; non-destructive, next hits)'
              : 'NORM — peak-normalize the loaded sample to −1 dBFS (non-destructive)'}
          >
            NORM
          </button>
          {on && (
            <span className="norm-db" title={srcKey ? 'Gain NORM is applying to this pad source' : 'Gain NORM is applying to the loaded sample'}>
              {fmtNormDb(gain)}
            </span>
          )}
        </>);
      })()}
      {/* STEMS — split the sample locally. DESKTOP APP ONLY (his call
          2026-08-20: DMG/EXE, no webapp — the web build renders nothing here).
          Click = split the WHOLE song at the last-used quality; right-click =
          WHOLE SAMPLE FAST / FINE / REMOVE STEMS (his simplification
          2026-08-21). The 4 chips follow the pad you last HIT (StemChips
          subscribes to the activity channel) and edit it, or the selection. */}
      {/* STEMS PER SOURCE: the button works on whatever the waveform shows — the
          main track, or the pad's own sample in a pad-source view. */}
      {(() => { const t = stemsViewTarget(); const has = t ? stemsCtl.hasStemsFor(t) : false; return (stemsAvailable() || has) && (
        <span style={{ position: 'relative', display: 'inline-flex', gap: 4 }} onMouseLeave={() => setStemsMenu(false)}>
          <button
            className={`btn-chop-mode ${has ? 'chop-mode-on' : ''}`}
            disabled={!t}
            onClick={() => {
              if (stemsUi.phase === 'models' || stemsUi.phase === 'load' || stemsUi.phase === 'split') {
                if (window.confirm('Stop splitting? Finished parts are kept.')) void stemsCtl.cancel();
                return;
              }
              startStems(lastQuality());
            }}
            onContextMenu={(e) => { e.preventDefault(); setStemsMenu(m => !m); }}
            title="STEMS — split the whole song into DRUMS / BASS / OTHER / VOCALS on your machine (nothing uploads). Click = split at your last-used quality. Right-click = WHOLE SAMPLE FAST / FINE, or REMOVE STEMS. Then every pad picks its own layers with the DR · BS · OT · VX chips, which follow the pad you last hit. A song split once comes back instantly the next time you load it. Click again WHILE it runs = stop (finished parts are kept)"
          >
            {stemsUi.phase === 'models' ? `⇣ MODELS ${stemsUi.pct}%`
              : stemsUi.phase === 'load' ? '✂ LOADING…'
              : stemsUi.phase === 'split' ? `✂ ${stemsUi.pct}%`
              : stemsUi.phase === 'saving' ? '✂ SAVING…'
              : '✂ STEMS'}
          </button>
          {stemsMenu && (() => {
            return (
            <div style={{ position: 'absolute', top: '100%', left: 0, zIndex: 40, background: 'var(--bg2, #101410)', border: '1px solid var(--border, #2a2f2a)', borderRadius: 4, minWidth: 200, padding: 4, display: 'flex', flexDirection: 'column', gap: 2 }}>
              {([['fast', 'WHOLE SAMPLE — FAST'], ['fine', 'WHOLE SAMPLE — FINE (4× slower, cleanest)']] as const).map(([q, label]) => (
                <button key={q} className="btn-chop-mode" style={{ textAlign: 'left' }}
                  title={q === 'fast' ? 'Split the whole sample start to end with the FAST engine — seconds per song; each chop\'s chips light as its stretch lands' : 'Split the whole sample start to end with the FINE engine — about 4× slower, the cleanest separation'}
                  onClick={() => startStems(q)}>
                  {label}
                </button>
              ))}
              {has && (
                <button className="btn-chop-mode" style={{ textAlign: 'left' }}
                  title="Drop this sample's stems — its pads play the original again (masks reset; one undo step). The split stays saved on this computer for next time; Preferences → FOLDERS is where you really delete it"
                  onClick={() => { setStemsMenu(false); if (t) stemsCtl.removeStems(t); flash('Stems removed — pads play the original'); }}>
                  ✕ REMOVE STEMS
                </button>
              )}
            </div>
            );
          })()}
          {has && <StemChips engine={engine} selected={padSel.selected} flash={flash} />}
        </span>
      ); })()}
    </>
  );

  const onSeekChop = (chopId: number) => {
    if (padViewMeta && viewPadIdx !== null) {
      engine.triggerPad(chopId >= PAD_CHOP_BASE ? chopId - PAD_CHOP_BASE : viewPadIdx);
      return;
    }
    if (state.selectedPad !== null) {
      engine.assignChopToPad(state.selectedPad, chopId);
      engine.selectPad(null);
    } else {
      const pad = state.pads.find(p => p.chopId === chopId);
      if (pad) engine.triggerPad(pad.index);
    }
  };

  const onAdjustChop = (chopId: number, side: 'start' | 'end', timeSec: number, freeMove?: boolean) => {
    if (padViewMeta && viewPadIdx !== null) {
      const padIdx = chopId >= PAD_CHOP_BASE ? chopId - PAD_CHOP_BASE : viewPadIdx;
      const pb = engine.getPadBuffer(padIdx);
      if (!pb) return;
      engine.setPadTrim(padIdx, side === 'start' ? timeSec : pb.start, side === 'end' ? timeSec : pb.end);
    } else {
      engine.setChopBoundary(chopId, side, timeSec, freeMove);
    }
  };

  // Focused pad = whatever the WAVEFORM is showing you (engine.focusedPad:
  // explicit selection, else the pad you last hit). Read live off the engine —
  // pad hits no longer push a new ChopperState (that was a full re-render per
  // note), so a value captured at render time would be stale by the time a key
  // lands. This used to prefer a RINGING pad, which made the keyboard edit a
  // different chop than the highlighted one whenever a pad was still sounding.
  const focusedPad = (): number | null => engine.focusedPad();

  // Keyboard shortcuts
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (sampleBrowserOpenRef.current) return; // browser modal owns the keyboard
      const mod = e.metaKey || e.ctrlKey;

      // Cmd/Ctrl+S = save the current sample's preset (desktop). Handled BEFORE
      // the typing guard so it works even while focused in the preset-name
      // field; preventDefault stops the browser's "save page" dialog.
      if (mod && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 's') {
        e.preventDefault();
        savePresetRef.current();
        return;
      }

      // SPACE = transport play/stop. Handled BEFORE the typing guard below so it
      // ALWAYS drives the sequencer — even when a <button> or <select> holds
      // focus (e.g. right after changing the step-resolution dropdown), where
      // the browser would otherwise "activate" that focused control instead.
      // We skip only genuine text entry (text inputs / textareas).
      if (e.key === ' ') {
        const inTextField =
          (e.target instanceof HTMLInputElement && e.target.type !== 'range')
          || e.target instanceof HTMLTextAreaElement;
        if (inTextField) return; // let space type a literal space
        e.preventDefault(); // stop page scroll + activating the focused button/select
        // Beat Finisher modal owns SPACE while it's open (toggles preview).
        if (finishHimOpenRef.current) return;
        // Blur whatever holds focus so the keystroke can't double-act on it
        // (a focused <select>/<button> would otherwise swallow the next space).
        (document.activeElement as HTMLElement | null)?.blur?.();
        // Double-tap space (within 300ms) = panic stop: kills the sequencer,
        // drums, AND any pad voices still ringing. Single tap = normal toggle.
        const now = e.timeStamp;
        if (now - lastSpaceTapRef.current < 300) {
          lastSpaceTapRef.current = 0;
          stopTransport();
          engine.stopAllPads();
          return;
        }
        lastSpaceTapRef.current = now;
        // Unified transport: one anchor starts chops + drums phase-locked.
        if (engine.getState().seqPlaying || drumEngine.getState().playing) stopTransport();
        else startTransport();
        return;
      }

      // ← / → move the focused chop's start point — whenever the WAVEFORM is on
      // screen, and ONLY then (his rule: arrows pressed while working in another
      // section can never nudge a chop by accident). Handled BEFORE the typing
      // guard, because a dropdown or knob focused by an earlier click used to
      // silently eat the keys — only genuine text entry (the caret needs the
      // arrows) and the piano roll (arrows nudge selected notes) keep them.
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        if (isTextEntry(e.target)) return;
        if (inPianoRoll(e.target)) return;
        const wf = waveformWrapRef.current;
        if (!wf) return; // WAVEFORM collapsed (unmounted) — arrows are free for everything else
        const wr = wf.getBoundingClientRect();
        if (wr.bottom <= 0 || wr.top >= window.innerHeight || wr.width === 0) return; // scrolled off screen
        // Focused pad, or fall back to the first pad holding a chop so the
        // keys work right after a load without having to hit a pad first.
        const fp = focusedPad() ?? (() => { const i = state.pads.findIndex(p => p?.chopId != null); return i >= 0 ? i : null; })();
        if (fp === null) return;
        const dir = e.key === 'ArrowLeft' ? -1 : 1;
        const pad = state.pads[fp];
        // A pad playing its OWN source (no chop): nudge its trim START instead.
        if (pad && pad.chopId === null) {
          const pb = engine.getPadBuffer(fp);
          if (!pb) return;
          e.preventDefault();
          const { viewStart: vs, viewEnd: ve } = viewRef.current;
          const step = (ve - vs) * pb.buffer.duration * (e.shiftKey ? 0.0005 : 0.002) * dir;
          engine.setPadTrim(fp, Math.max(0, Math.min(pb.end - 0.01, pb.start + step)), pb.end);
          return;
        }
        if (!pad || pad.chopId === null || !engine.buffer) return;
        e.preventDefault();
        const { viewStart: vs, viewEnd: ve } = viewRef.current;
        const fine = (ve - vs) * engine.buffer.duration * 0.0005;
        if (e.shiftKey) {
          engine.adjustChopBoundary(pad.chopId, 'start', dir * fine);
        } else {
          // Step to the previous / next detected transient; when there is no
          // transient that way (or none at all) fall back to a visible
          // zoom-aware nudge so the key NEVER reads as dead.
          const moved = engine.stepChopBoundaryToTransient(pad.chopId, 'start', dir);
          if (!moved) engine.adjustChopBoundary(pad.chopId, 'start', dir * fine * 4);
        }
        return;
      }

      if (isTextEntry(e.target) || e.target instanceof HTMLSelectElement) return;

      // Cmd/Ctrl+Z = undo · Cmd/Ctrl+Shift+Z = redo (also Ctrl+Y on Windows).
      if (mod && !e.altKey && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) engine.redo(); else engine.undo();
        return;
      }
      if (mod && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'y') {
        e.preventDefault();
        engine.redo();
        return;
      }

      // ⌘/Ctrl + X · C · V → cut / copy / paste PADS. Acts on the shift-selected
      // pads, or the pad the waveform is on when nothing is selected. Paste lands
      // on the selected pad — click an empty pad to aim it — and a multi-pad
      // clipboard fills consecutive pads from there.
      if (mod && !e.altKey && !e.shiftKey && 'xcvXCV'.includes(e.key)) {
        // The piano roll owns its own clipboard-shaped keys for notes.
        if (inPianoRoll(e.target)) return;
        // TRIM armed with a highlight: ⌘X cuts the section, not the pads.
        if (e.key.toLowerCase() === 'x' && trimRef.current.mode && trimRef.current.sel) { e.preventDefault(); doTrim(); return; }
        // Never steal a REAL text selection (the preset-name field) — but an
        // explicit pad selection outranks a leftover collapsed-into-nothing
        // selection some browsers keep reporting after focus moved away.
        if (!padSelRef.current.selected.length && !window.getSelection()?.isCollapsed) return;
        e.preventDefault();
        const k = e.key.toLowerCase();
        if (k === 'x') doPadCut(); else if (k === 'c') doPadCopy(); else doPadPaste();
        return;
      }

      // ESC drops the pad selection too — one key to get back to a clean slate.
      // LAYERED: when a pad menu is open (.pad-pop) or MOVE mode is armed
      // (.pad-move-mode), that layer consumes this ESC (PadGrid closes it on
      // its own window listener) and the SELECTION SURVIVES — dismissing a
      // menu must not nuke the selection it was operating on. Can't be done
      // with stopPropagation: both listeners hang off window, where same-target
      // listeners all run regardless.
      if (e.key === 'Escape') {
        // TRIM goes first (his call 2026-08-21: ESC LEAVES trim mode, highlight
        // and all) — the pad selection below survives.
        if (trimRef.current.mode || trimRef.current.sel) { setTrimMode(false); setTrimSel(null); setTrimMenu(null); engine.stopAllPads(); return; }
        engine.stopAllPads(); engine.selectPad(null);
        if (!document.querySelector('.pad-pop, .pad.pad-move-mode')) padSelRef.current.clear();
        return;
      }

      // (SPACE is handled above, before the typing guard.)

      // \ → drop a chop point at the current playhead position. Same path
      // as tapping the waveform while audio is playing — quick keyboard
      // shortcut for "chop here" without leaving the keys.
      // Pass e.timeStamp so the engine can subtract any event→handler lag
      // (React/main-thread busy) from the perceived playhead position.
      if (e.key === '\\') {
        e.preventDefault();
        engine.slicePlayheadAt(findNextEmptyPad(), e.timeStamp);
        return;
      }

      // , → zoom in   . → zoom out  (centered on the last-hit pad)
      if (e.key === ',' || e.key === '.') {
        e.preventDefault();
        const { viewStart: vs, viewEnd: ve } = viewRef.current;
        const anchor = zoomCenterFrac();
        const span = e.key === ','
          ? Math.max(0.005, (ve - vs) * 0.6)
          : Math.min(1, (ve - vs) * 1.5);
        const ns = Math.max(0, anchor - span / 2);
        const ne = Math.min(1, ns + span);
        userZoomedRef.current = true;
        setViewStart(ns); setViewEnd(ne);
        return;
      }

      // (← / → are handled above, before the typing guard — they act only
      // while the WAVEFORM section is on screen.)

      // ↑ / ↓ used to pitch the whole sample — retired 2026-08-18: the BASS
      // piano roll transposes selected notes with the same keys, and the two
      // fired together (a transpose also detuned the sample). The master PITCH
      // knob (and its MIDI CC) is the way to pitch the sample now.

      // [ / ] → per-pad pitch for focused pad
      if (e.key === '[' || e.key === ']') {
        const fp = focusedPad();
        if (fp === null) return;
        e.preventDefault();
        const step = e.shiftKey ? 0.1 : 0.5;
        engine.adjustPadPitch(fp, e.key === ']' ? step : -step);
        return;
      }

      // BACKSPACE (the Mac "delete" key) and DELETE (the forward-delete key on a
      // full keyboard, which sends a different key name) → clear the selected
      // pads, or the focused one when nothing is selected. The piano roll
      // deletes its own notes on these keys WITHOUT stopping propagation —
      // never also clear a pad while the user is pruning notes.
      if (e.key === 'Backspace' || e.key === 'Delete') {
        if (inPianoRoll(e.target)) return;
        e.preventDefault();
        // TRIM armed with a highlight: DELETE cuts the section, not the pads.
        if (trimRef.current.mode && trimRef.current.sel) { doTrim(); return; }
        doPadDelete();
        return;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [engine, state.selectedPad, state.pads, state.chops]);

  const handleExportSeq = async () => {
    if (!state.hasBuffer) return;
    flash('Rendering current sequence…');
    try {
      const stem = await engine.exportSeq(24);
      if (mpcExportDir && ipc?.exportToMpc) {
        const r = await ipc.exportToMpc([stem]);
        flash(r.error ? `ERR: ${r.error}` : `SAVED → ${r.savedTo}`);
      } else if (ipc?.exportStem) {
        await ipc.exportStem(stem);
        flash('Saved sequence');
      }
    } catch (e: any) { setError(e?.message ?? String(e)); }
  };

  const handleExportMaster = async () => {
    if (!state.hasBuffer) return;
    flash('Rendering master…');
    try {
      const stem = await engine.exportMaster(24);
      if (mpcExportDir && ipc?.exportToMpc) {
        const r = await ipc.exportToMpc([stem]);
        flash(r.error ? `ERR: ${r.error}` : `SAVED → ${r.savedTo}`);
      } else if (ipc?.exportStem) {
        await ipc.exportStem(stem);
        flash('Saved master');
      }
    } catch (e: any) { setError(e?.message ?? String(e)); }
  };

  const handleExportChops = async () => {
    if (!state.hasBuffer) return;
    flash('Rendering chops…');
    try {
      const stems = await engine.exportChops(24);
      if (stems.length === 0) { setError('No assigned pads to export'); return; }
      const folderName = state.trackTitle
        ? `${state.trackTitle.replace(/[/\\:*?"<>|]/g, '-').trim()} CHOPS`
        : undefined;
      if (mpcExportDir && ipc?.exportToMpc) {
        const r = await ipc.exportToMpc(stems, folderName);
        flash(r.error ? `ERR: ${r.error}` : `SAVED ${stems.length} chops → ${r.savedTo}`);
      } else if (ipc?.exportAllStems) {
        await ipc.exportAllStems(stems, folderName);
        flash(`Saved ${stems.length} chops`);
      }
    } catch (e: any) { setError(e?.message ?? String(e)); }
  };

  // $40 one-time lifetime purchase. POST to the KCC checkout API, then send the
  // browser to the returned Stripe URL. We run inside the killaviccheatcodes.app
  // iframe, so navigate the TOP window (Stripe Checkout + our sign-in page can't
  // render framed) — mirrors goToPricing in lib/subscription.
  // Falls back to this frame if cross-frame access is blocked (e.g. standalone).
  const navTop = (dest: string) => {
    try {
      if (window.top && window.top !== window.self) { window.top.location.href = dest; return; }
    } catch { /* cross-origin top — fall through */ }
    window.location.href = dest;
  };
  // Sign out from inside the iframe. The session cookie lives on the KCC
  // origin, so we navigate the TOP window to the wrapper's GET sign-out route
  // (clears the Supabase cookie server-side, then redirects back to
  // /terminator — now signed-out, so this control disappears).
  const handleSignOut = () => {
    if (!isWeb) {
      // Electron: clear the encrypted device token in the main process, then
      // re-lock and reopen the sign-in gate.
      void signOutDesktop().then(() => {
        forceLicenseRerender((n) => n + 1);
        setShowSignIn(true);
      });
      return;
    }
    // Web: the Supabase cookie lives on the KCC origin — sign out via the wrapper.
    navTop('/auth/signout?next=/terminator');
  };
  const handleBuyLifetime = async () => {
    if (buyingLifetime) return;
    setBuyingLifetime(true);
    try {
      const r = await fetch('/api/checkout/terminator-lifetime', {
        method: 'POST',
        credentials: 'include',
      });
      // Not signed in → the checkout API 401s (the button shows to every
      // non-?sub=1 user, signed-out included). Send them to sign-in; ?next
      // returns them to /terminator to finish buying. This was the silent no-op.
      if (r.status === 401) { navTop('/signin?next=/terminator'); return; }
      const j = await r.json().catch(() => null);
      if (r.ok && j?.url) { navTop(j.url); return; } // leave button disabled through the redirect
      // Surface the failure instead of swallowing it (was a silent re-enable).
      setBuyingLifetime(false);
      flash(j?.error || `Checkout failed (${r.status}). Please try again.`);
    } catch (e: any) {
      setBuyingLifetime(false);
      flash(`Checkout error: ${e?.message ?? 'network problem'}. Please try again.`);
    }
  };

  const undoAvailable = engine.canUndo();
  const redoAvailable = engine.canRedo();

  // Common props for every <DraggableSection> wrapper in the render tree.
  const dsProps = (id: SectionId) => ({
    id,
    isRearranging,
    positioned: layoutActive,
    pos: sectionLayout[id],
    dragging: draggingSection === id,
    onMove: moveSection,
    onResize: resizeSection,
    onResizeEnd: handleSectionResizeEnd,
    onDragStateChange: setDraggingSection,
    registerRef: registerSectionRef,
  });

  // Root style merges the rearrange minHeight with the active Minimal palette's
  // --hw-* role vars (declarative so React owns them; they cascade into the
  // in-tree DAW mixer). Undefined when neither applies (Original = unchanged).
  const chopperRootStyle: CSSProperties | undefined = (() => {
    const s: Record<string, string | number> = {};
    if (layoutActive) s.minHeight = rearrangeHeight;
    if (activePalette) {
      s['--hw-bg'] = activePalette.bg; s['--hw-panel'] = activePalette.panel;
      s['--hw-pad'] = activePalette.pad; s['--hw-text'] = activePalette.text;
      s['--hw-accent'] = activePalette.accent; s['--hw-border'] = activePalette.border;
      s['--hw-muted'] = activePalette.muted; s['--hw-faint'] = activePalette.faint;
    }
    return Object.keys(s).length ? (s as CSSProperties) : undefined;
  })();

  return (
    <div
      ref={chopperViewRef}
      className={`chopper-view${isRearranging ? ' rearranging' : ''}${hasCustomLayout ? ' has-custom-layout' : ''}`}
      data-layout={effectiveLayout}
      data-uisize={uiSize}
      data-palette={activePalette ? activePalette.id : undefined}
      style={chopperRootStyle}
    >
      {/* Floating DONE button — only while re-arranging. Saves + exits. */}
      {isRearranging && (
        <div className="rearrange-bar">
          <button className="btn-rearrange-done" onClick={finishRearrange}>✓ DONE</button>
          <button className="btn-rearrange-reset" onClick={resetSectionLayout} title="Reset every section back to the default stacked layout">RESET LAYOUT</button>
        </div>
      )}
      {/* App brand bar — T-800 on the left, undo/redo on the right. Engine
       *  lives in this component, so the buttons go here rather than in App. */}
      <div className="app-mode-bar">
        <span
          className="brand"
          role="button"
          tabIndex={0}
          title="Tap to choose a theme"
          onClick={openThemeMenu}
          onKeyDown={e => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              setThemeMenuRect((e.currentTarget as HTMLElement).getBoundingClientRect());
            }
          }}
        >T-800<sup className="brand-version" title={`Terminator ${__TERMINATOR_VERSION__}`}>v{__TERMINATOR_VERSION__}</sup></span>
        {/* Layout switcher sits right next to T-800. In most themes it's a
            ▦ grid glyph; in themes that ship a mascot gif (sonic spin / ff7
            cloud) the glyph is swapped for the gif (CSS-gated). Tapping it
            cycles the LAYOUT. T-800 itself still cycles the theme. */}
        <span
          className="brand-gif"
          role="button"
          tabIndex={0}
          title={`Layout: ${layoutLabel} — tap to change`}
          onClick={cycleLayout}
          onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') cycleLayout(); }}
        >▦</span>
        {/* Free tier only (no ?sub=1): one-time $40 lifetime buy, sat next to
            the layout gif. Subscribers/trial users never see it. */}
        {!isSubscribed() && (
          <button
            className="btn-buy-lifetime"
            onClick={handleBuyLifetime}
            disabled={buyingLifetime}
            title="Buy Terminator outright — one-time $40, no subscription. Includes the desktop app for macOS + Windows."
          >
            {buyingLifetime ? '…' : 'Buy Terminator — $40'}
          </button>
        )}
        {/* Owners on the web: the desktop app is theirs — one click to the
            download page (DMG / EXE, signed in). Not on Electron (they're in it). */}
        {isWeb && isSubscribed() && (
          <button className="btn-desktop-dl" onClick={goToDesktopDownload}
            title="Download the Terminator desktop app for macOS or Windows — included with your license">
            ⬇ DESKTOP APP
          </button>
        )}
        <div className="app-mode-bar-actions">
          {/* HELP sits FIRST in the actions group — left of undo/redo, so it is
              the one that survives when the bar gets tight. */}
          <button
            className="btn-help"
            onClick={() => setHelpOpen(true)}
            title="Help — how everything works, and the keyboard shortcuts"
            aria-label="Help"
          >
            ?
          </button>
          {/* SETTINGS gear — Preferences without the File menu (desktop app only;
              his ask 2026-08-21). Same chip as HELP so the pair reads as one. */}
          {ipc?.openPreferences && (
            <button
              className="btn-help"
              onClick={() => { void ipc.openPreferences?.(); }}
              title="Settings — open Preferences (audio device & sample rate, MIDI, FOLDERS: library, projects, cache, stems engines). Also ⌘, / Ctrl+,"
              aria-label="Settings"
            >
              ⚙
            </button>
          )}
          <button
            className="btn-undo"
            onClick={() => engine.undo()}
            disabled={!undoAvailable}
            title="Undo (Cmd/Ctrl+Z)"
            aria-label="Undo"
          >
            ↺
          </button>
          <button
            className="btn-undo"
            onClick={() => engine.redo()}
            disabled={!redoAvailable}
            title="Redo (Cmd/Ctrl+Shift+Z)"
            aria-label="Redo"
          >
            ↻
          </button>
        </div>
      </div>
      {/* ── Toolbar ── */}
      <DraggableSection {...dsProps('LOAD')}>
      {(isWebUI || ipc !== undefined) && <SectionHeader
        title="LOAD"
        collapsed={collapsedToolbar}
        onToggle={() => setCollapsedToolbar(v => !v)}
      />}
      {(!isWebUI || !collapsedToolbar) && <div className="chopper-toolbar">
        <div className="toolbar-group">
          <label className="toolbar-field">
            <span className="toolbar-label">PLAYLIST</span>
            <select className="ctrl-select" value={selectedPlaylist}
              onChange={e => setSelectedPlaylist(e.target.value)}
              disabled={state.isLoading}
              title="The sample library GET SAMPLE and BROWSE pull from">
              {playlists.length === 0 && <option value="">(no playlists)</option>}
              {playlists.map((p, i) => (
                <option key={i} value={p.name}>{p.name} ({p.entries.length})</option>
              ))}
            </select>
          </label>
          <button className="btn btn-primary" onClick={loadRandomFromPlaylist}
            disabled={state.isLoading || !selectedPlaylist}
            title="Pull a random track from this playlist — the fastest way to start. Once you have pads in play (chops, or pads with their own sample) it lands on the NEXT EMPTY PAD instead of replacing your main track">
            {state.isLoading ? 'PULLING…' : '⤓ GET SAMPLE'}
          </button>
          <button className="btn btn-browse"
            onClick={() => { if (demo && demoSpent) { setSubModalOpen(true); return; } if (isWeb) void refreshWebPresets(); setSampleBrowserOpen(true); }}
            disabled={state.isLoading || playlists.length === 0}
            title="Browse the sample library, preview tracks with the waveform, and load one into the chopper">
            ⊞ BROWSE
          </button>
          {/* Load your OWN sample from the device. Works everywhere (incl.
              phones/tablets that can't drag-and-drop). If chops already exist
              it swaps the audio and keeps them; otherwise loads as a fresh
              track. Undo brings the previous sample back. */}
          {/* LOAD FILE is a <label> wrapping the (hidden) file input: a label
              click is a direct user gesture, so the picker opens reliably even
              inside the iframe on iOS Safari (programmatic input.click() is
              blocked there). The gate lives in the label onClick — free users
              get the sub modal and the picker never opens (preventDefault).
              Labels can't be `disabled`, so the loading state is the .is-busy
              class (pointer-events:none) + an onClick guard. */}
          <label
            className={`btn btn-loadfile${isSubscribed() ? '' : ' locked'}${state.isLoading ? ' is-busy' : ''}`}
            onClick={e => {
              if (state.isLoading) { e.preventDefault(); return; }
              if (!isSubscribed()) { e.preventDefault(); setSubModalOpen(true); }
            }}
            title={isSubscribed()
              ? 'Load your own audio file (mp3, wav, flac…) from this device'
              : 'Subscriber feature — load your own samples'}>
            📁 LOAD FILE{!isSubscribed() ? ' 🔒' : ''}
            <input
              ref={fileInputRef}
              type="file"
              accept="audio/*,.mp3,.wav,.aif,.aiff,.flac,.ogg,.m4a,.webm,.opus,.tproj,.tprojz"
              style={{ position: 'absolute', width: 1, height: 1, opacity: 0 }}
              onChange={handleFilePick}
            />
          </label>
          {/* RECORD SAMPLE — Electron only (needs the ipc bridge to save the
              recording + enumerate desktop sources). Toggles the panel below. */}
          {ipc !== undefined && (
            <button
              className={`btn btn-record${recordOpen ? ' on' : ''}${recordState === 'recording' ? ' is-rec' : ''}`}
              onClick={toggleRecordPanel}
              title="Record a sample from a mic / audio interface or system audio — the take lands on the NEXT EMPTY PAD as its own sample (right-click a pad → RECORD INTO to aim it)"
            >
              ● RECORD SAMPLE
            </button>
          )}
          {/* DL PLAYLIST is a desktop-only feature (yt-dlp). Hide it in the
              web build — the equivalent on web will be pre-caching Drive
              tracks into IndexedDB, which we'll add later. */}
          {import.meta.env.MODE !== 'web' && (
            <button
              className={`btn btn-cache-dl ${dlProgress ? 'cache-dl-active' : ''}`}
              onClick={handleDownloadPlaylist}
              disabled={!!dlProgress || !selectedPlaylist}
              title={cacheStatus && cacheStatus.estimatedMB > 0
                ? `~${cacheStatus.estimatedMB >= 1000 ? (cacheStatus.estimatedMB/1024).toFixed(1)+'GB' : Math.round(cacheStatus.estimatedMB)+'MB'} to download — every song in this playlist lands in the sample browser under TERMINATOR SAMPLES → DOWNLOADED PLAYLISTS → ${selectedPlaylist} (your YouTube folder stays what you pulled by hand). Songs you already have are skipped`
                : `Pull every song in this playlist onto your computer — it shows up in the sample browser under TERMINATOR SAMPLES → DOWNLOADED PLAYLISTS → ${selectedPlaylist}, so your YouTube folder stays what you pulled by hand. Loading later never downloads again`}
            >
              {dlProgress
                ? `${dlProgress.done}/${dlProgress.total}`
                : cacheStatus && cacheStatus.cached > 0
                  ? `CACHED ${cacheStatus.cached}/${cacheStatus.total}`
                  : cacheStatus && cacheStatus.estimatedMB > 0
                    ? `⬇ DL ~${cacheStatus.estimatedMB >= 1000 ? (cacheStatus.estimatedMB/1024).toFixed(1)+'GB' : Math.round(cacheStatus.estimatedMB)+'MB'}`
                    : '⬇ DL PLAYLIST'}
            </button>
          )}
          {cacheStatus && cacheStatus.cached > 0 && !dlProgress && (
            <button
              className="btn btn-cache-del"
              onClick={handleDeleteCache}
              title="Move this playlist's YouTube files (Sample Library → YouTube) to the Trash — they come back on the next pull"
            >
              DEL {cacheStatus.sizeMB >= 1000
                ? `${(cacheStatus.sizeMB / 1024).toFixed(1)}GB`
                : `${Math.round(cacheStatus.sizeMB)}MB`}
            </button>
          )}
          {/* Cache directory picker is a desktop-only feature — it opens a
              native folder dialog. Hidden on web. */}
          {!isWebUI && (
            <button
              className="btn btn-cache-dir"
              onClick={() => { void ipc?.revealCacheDir?.(); }}
              title={`YouTube pulls are saved in your Sample Library → YouTube${cacheDir ? ` (${cacheDir})` : ''} — every link you load lands there as a real file, visible in the sample browser, and reloads never download again. Click to open the folder.`}
            >
              ▶ YOUTUBE FOLDER
            </button>
          )}
        </div>

        {/* URL field (desktop only) — ADD SAMPLE / SWAP PAD buttons removed
            for now; per-pad sample swap still works via the pad's ↺ button
            in the grid itself. */}
        {import.meta.env.MODE !== 'web' && (
          <div className="toolbar-group">
            <UrlInput onLoad={loadCustomUrl} disabled={state.isLoading} />
          </div>
        )}

        {/* Metronome */}
        <div className="toolbar-group metro-group">
          <MidiMapTarget parameterId="master.bpm" min={20} max={300}
            onChange={v => engine.setMetronomeBpm(Math.round(v))}>
            <BpmInput
              bpm={state.metronome.bpm}
              onChange={bpm => engine.setMetronomeBpm(bpm)}
            />
          </MidiMapTarget>
          {isWebUI
            ? <button
                type="button"
                className={`btn-tap-tempo${tapArmed ? ' on' : ''}`}
                onClick={() => { setTapArmed(v => !v); tapTimesRef.current = []; }}
                title={tapArmed ? 'TAP armed — pads play and feed BPM. Tap TAP again to lock.' : 'Arm TAP — then tap pads to set BPM (samples still play)'}
              >
                {tapArmed ? 'TAP ON' : 'TAP'}
              </button>
            : <TapTempoButton onTempo={bpm => engine.setMetronomeBpm(bpm)} />
          }
          <select
            className="ctrl-select metro-sound-select"
            value={state.metronome.sound}
            onChange={e => engine.setMetronomeSound(e.target.value as MetronomeSound)}
            title="Metronome sound"
          >
            {METRO_SOUNDS.map(s => (
              <option key={s.value} value={s.value}>{s.label}</option>
            ))}
          </select>
          <button
            className={`btn-metro ${state.metronome.enabled ? 'metro-on' : ''}`}
            onClick={() => engine.toggleMetronome()}
            title="Toggle metronome"
          >
            {state.metronome.enabled ? '♩ ON' : '♩ OFF'}
          </button>
        </div>

        {/* INPUT Q — the ONLY thing that quantizes what you RECORD, for BOTH
            sequencers (his rule 2026-08-20). It sits by the BPM because it is
            global; the GRID each sequencer is set to decides WHERE the lines
            are (chop seq on 1/8 → chop hits land on 1/8, drum seq on 1/16 →
            drum hits on 1/16). Setting a grid never quantizes on its own. */}
        <div className="toolbar-group input-q-group">
          <MidiMapTarget parameterId="master.inputQuantize" min={0} max={100}
            onChange={v => engine.setInputQuantize(Math.round(v))}>
            <label className="input-q-fader"
              title="INPUT Q — how hard hits you RECORD pull onto the grid, in the speakers and on the page alike: 100 = dead on the line, 0 = your exact timing, 50 = halfway. One fader for BOTH sequencers, and each one quantizes to ITS OWN grid (chop seq on 1/8 records at 1/8, drum seq on 1/16 at 1/16). A grid on its own never quantizes what you play">
              <span>INPUT Q</span>
              <span style={{ position: 'relative', display: 'inline-flex' }}>
                <FaderBubble active={iqTip.active} pct={iqTip.pct}>{iqPct}%</FaderBubble>
                <input type="range" min={0} max={100} value={iqPct}
                  onPointerDown={startIqDrag}
                  onChange={e => setIqDrag(Number(e.target.value))} />
              </span>
              <span className="input-q-val">{iqPct}</span>
            </label>
          </MidiMapTarget>
        </div>

        {/* Chop mode toggle + reset */}
        <div className="toolbar-group">
          {/* SNAP · AUTO-CHOP · REV · RESET · DEL ALL moved to the WAVEFORM
              section toolbar (see .wave-actions-row) so the chop tools sit
              directly above the waveform they act on. */}
          {/* STRETCH (SoundTouch time-stretch) and TRIM (chop offset) are
              desktop-only for now — too niche for the mobile UI. */}
          {!isWebUI && (<>
            <button
              className={`btn-chop-mode ${state.stretchEnabled ? 'chop-mode-on' : ''}`}
              onClick={() => engine.toggleStretch()}
              disabled={!state.hasBuffer || state.bpm === 0}
              title="Time-stretch chops to target BPM without pitch change (SoundTouch)"
            >
              {state.stretchEnabled ? '⟳ STRETCH ON' : '⟳ STRETCH'}
            </button>
            {state.stretchEnabled && state.bpm > 0 && (
              <>
                <span className="stretch-src-bpm">{Math.round(state.bpm)}→</span>
                <BpmInput
                  bpm={state.targetBpm > 0 ? state.targetBpm : Math.round(state.bpm)}
                  onChange={v => engine.setTargetBpm(v)}
                />
                <TapTempoButton onTempo={v => engine.setTargetBpm(v)} />
              </>
            )}
            <ChopOffsetControl
              offsetMs={state.chopOffsetMs}
              onChange={ms => engine.setChopOffset(ms)}
            />
          </>)}
        </div>

        {/* PRESETS — inline at the END of LOAD row 1, right after CHOP ON.
            Constrained widths + nowrap (see .chopper-web-presets in
            terminator.css) keep it on row 1 instead of wrapping. Web only; the
            desktop/Electron build keeps its own preset-panel under the pads. */}
        {isWebUI && (
          <div className="toolbar-group tt-gated tt-gated-presets">
            <div className="preset-panel chopper-web-presets">
              <input
                ref={presetNameInputRef}
                className={`preset-name-input${nameBlink ? ' name-blink' : ''}`}
                placeholder="Project name…"
                value={presetName}
                // Manually editing the name = SAVE AS: drop the loaded id so SAVE
                // no longer overwrites the loaded row by id (it upserts by name).
                onChange={e => { setPresetName(e.target.value); setLoadedPresetId(null); setConfirmSave(null); }}
                title="Project name — SAVE PROJECT stores it in your account and, on desktop, as a .tproj file on this computer"
              />
              <button
                className="btn-preset-save"
                disabled={saving}
                title={(loadedPresetId && namedPresets.find(p => p.id === loadedPresetId)?.name === presetName.trim()
                  ? 'Update the loaded project (track + all chops/pads/FX/mixer/drums/bass) — cloud + a .tproj on this computer'
                  : 'Save project (track + all chops/pads/FX/mixer/drums/bass) — cloud + a .tproj on this computer')
                  + '. CMD-click = Save As… (see your saved names, pick a new one) · right-click = Save / Save As… / Save As Copy'}
                onClick={e => { if (e.metaKey || e.ctrlKey) { setSaveAsOpen(true); return; } void handleSaveNamedPreset(); }}
                onContextMenu={e => { e.preventDefault(); setSaveMenu({ x: e.clientX, y: e.clientY }); }}
              >
                {saving ? 'SAVING…' : (loadedPresetId && namedPresets.find(p => p.id === loadedPresetId)?.name === presetName.trim() ? 'SAVE' : 'SAVE PROJECT')}
              </button>
              {saveMenu && (
                <div className="save-ctx-menu" ref={saveMenuRef} style={{ position: 'fixed', left: saveMenu.x, top: saveMenu.y, zIndex: 9500 }}
                  onMouseLeave={() => setSaveMenu(null)}>
                  <button className="btn-preset-save" onClick={() => { setSaveMenu(null); void handleSaveNamedPreset(); }} title="Save (same as the button)">Save</button>
                  <button className="btn-preset-save" onClick={() => { setSaveMenu(null); setSaveAsOpen(true); }} title="Save As… — see your saved projects and pick a new name">Save As…</button>
                  <button className="btn-preset-save" onClick={() => { setSaveMenu(null); saveProjectCopy(); }} title="Save As Copy — the same name with the next number (Beat → Beat 2), leaving the original as it was">Save As Copy</button>
                </div>
              )}
              <button
                className="btn-preset-save"
                onClick={() => setOpenModalOpen(true)}
                title="Open a project (local files + cloud presets — .tproj / .tprojz)"
              >
                OPEN…
              </button>
              <button
                className="btn-preset-save"
                onClick={handleNewProject}
                title="Start a NEW project — clears the sample, chops, pads, sequences, drums, bass and mixer back to defaults (asks first if there is work to lose). Same as File → New Project."
              >
                NEW
              </button>
              <button
                className="btn-preset-save"
                onClick={() => { void downloadProjectFile(); }}
                title="Save a self-contained project FILE you can move by hand or AirDrop: .tprojz with your own samples inside, plain .tproj otherwise. Open it anywhere with LOAD FILE / OPEN…"
              >
                ⇩ FILE
              </button>
              <select
                ref={presetLoadSelectRef}
                className="ctrl-select preset-load-select"
                value=""
                onChange={e => { if (e.target.value) handleLoadNamedPreset(e.target.value); }}
                title="Load a saved project"
              >
                <option value="" disabled>
                  {namedPresets.length > 0 ? 'LOAD PROJECT…' : '(no saved projects yet)'}
                </option>
                {namedPresets.map(p => (
                  <option key={p.id ?? p.name} value={p.id ?? p.name}>
                    {p.name}{p.trackTitle ? ` — ${p.trackTitle}` : ''}
                  </option>
                ))}
              </select>
              {namedPresets.length > 0 && (
                <select
                  className="ctrl-select preset-load-select"
                  defaultValue=""
                  onChange={e => { if (e.target.value) handleDeleteNamedPreset(e.target.value); e.target.value = ''; }}
                  title="Delete a saved project"
                >
                  <option value="" disabled>DEL PROJECT…</option>
                  {namedPresets.map(p => (
                    <option key={p.id ?? p.name} value={p.id ?? p.name}>{p.name}</option>
                  ))}
                </select>
              )}
              {confirmSave && (
                <span className="preset-overwrite-confirm" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, whiteSpace: 'nowrap' }}>
                  <span style={{ color: '#ffb454', fontSize: 12 }}>"{confirmSave.name}" exists — overwrite?</span>
                  <button className="btn-preset-save" onClick={confirmOverwriteSave}>Overwrite</button>
                  <button className="ctrl-select" onClick={() => setConfirmSave(null)}>Cancel</button>
                </span>
              )}
            </div>
          </div>
        )}

        {/* Layout is switched from the ▦ icon next to the T-800 logo. This
            group just holds the S/M/L size control, which only applies to
            mobile and only shows in the scroll+size layout (CSS-gated). */}
        <div className="toolbar-group toolbar-layout-group">
          <div className="toolbar-size-ctl">
            {(['S', 'M', 'L'] as const).map(s => (
              <button
                key={s}
                className={`btn-size ${uiSize === s ? 'on' : ''}`}
                onClick={() => setUiSize(s)}
                title={`UI size: ${s === 'S' ? 'small' : s === 'M' ? 'medium' : 'large'}`}
              >{s}</button>
            ))}
          </div>
        </div>

        <div className="toolbar-group">
          {/* PITCH fader removed from the LOAD section — the waveform toolbar's
              PITCH/TEMPO knob is now the single master-pitch control. */}
          {/* MIDI controls — the MIDI ON toggle, the device-status indicator,
              and the LEARN/KILL/TAP buttons — only render when a MIDI input is
              actually connected. `midiInputs` is refreshed on access-grant and
              on every connect/disconnect (acc.onstatechange → refreshInputs),
              so this whole row appears when you plug a controller in and
              disappears the moment you unplug it. */}
          {/* Always-on MIDI status (BLOCKED / NO DEVICE / device + activity LED +
              RESCAN) — a controller that isn't arriving is never invisible. */}
          <MidiStatusPill />
          {midiInputs.length > 0 && (
            <>
              <button
                className={`btn-midi-learn ${midiEnabled ? 'midi-learn-on' : ''}`}
                onClick={() => setMidiEnabled(v => !v)}
                title="Toggle MIDI input on/off"
              >
                MIDI {midiEnabled ? 'ON' : 'OFF'}
              </button>
              <MidiLatencyMeter engine={engine} active={midiEnabled} />
              <button
                className={`btn-midi-learn ${midiLearn ? 'midi-learn-on' : ''}`}
                onClick={() => { setMidiLearn(v => !v); setMidiLearnIdx(0); setMidiLearnKill(false); setMidiLearnTap(false); }}
                title="MIDI Learn: hit start, then press each pad on your controller"
              >
                {midiLearn ? `LEARN ${midiLearnIdx + 1}…` : 'LEARN'}
              </button>
              <button
                className={`btn-midi-learn ${midiLearnKill ? 'midi-learn-on' : ''}`}
                onClick={() => { setMidiLearnKill(v => !v); setMidiLearn(false); setMidiLearnTap(false); }}
                title={midiKillNote !== null ? `Kill mapped to note ${midiKillNote} — click to remap` : 'Learn a MIDI button to kill all audio'}
              >
                {midiLearnKill ? 'HIT KILL BTN' : midiKillNote !== null ? 'KILL ✓' : 'KILL'}
              </button>
              <button
                className={`btn-midi-learn ${midiLearnTap ? 'midi-learn-on' : ''}`}
                onClick={() => { setMidiLearnTap(v => !v); setMidiLearn(false); setMidiLearnKill(false); }}
                title={midiTapNote !== null ? `Tap-tempo mapped to note ${midiTapNote} — click to remap` : 'Learn a MIDI button to tap tempo'}
              >
                {midiLearnTap ? 'TAP IT…' : midiTapNote !== null ? 'TAP ✓' : 'TAP TEMPO'}
              </button>
            </>
          )}
        </div>

        {/* Song title + BPM badge moved OUT of the LOAD section — they now live
            in the WAVEFORM toolbar row, after the PITCH/TEMPO knob (the
            WaveformView .waveform-track-title, un-hidden + reordered via CSS).
            The PRESETS panel moved up to sit inline right after CHOP ON. */}

        {/* Transport — PLAY / STOP on its own full-width row at the BOTTOM of the
            LOAD toolbar (.toolbar-transport is flex-basis:100% on desktop, so it
            always wraps to its own row). Kept LAST so nothing renders below it —
            no dead space between the toolbar and PLAY/STOP. */}
        <div className="toolbar-group toolbar-transport">
          <button
            className={`btn-transport btn-transport-play${transportOn ? ' is-lit' : ''}`}
            onClick={startTransport}
            title="Play — start the sequencer + drums (same as the sequencer's ▶)"
          >
            ▶ PLAY
          </button>
          <button
            className={`btn-transport btn-transport-stop${transportOn ? '' : ' is-lit'}`}
            onClick={killAllAudio}
            title="Stop — kill all audio: sequencer, drums, and any ringing pad voices"
          >
            ■ STOP
          </button>
        </div>
      </div>}

      {/* RECORD SAMPLE panel — below the LOAD toolbar (Electron only). */}
      {ipc !== undefined && recordOpen && (
        <div className="record-panel">
          <div className="record-row">
            <label className="record-field">
              <span className="record-label">INPUT</span>
              <select
                className="ctrl-select record-input-select"
                value={recordInputId ?? ''}
                disabled={recordState === 'recording'}
                onChange={e => {
                  const opt = e.target.selectedOptions[0];
                  onSelectRecordInput(e.target.value, opt ? opt.textContent ?? '' : '');
                }}
              >
                {!isWeb && <option value="">— choose an input —</option>}
                <option value={DEFAULT_INPUT_ID}>🎙 Microphone / plugged-in input (default)</option>
                {audioDevices.length > 0 && (
                  <optgroup label="Mic / Interface">
                    {audioDevices.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
                  </optgroup>
                )}
                <optgroup label="Terminator">
                  <option value={INTERNAL_OUTPUT_ID}>🔁 Terminator output — resample what you play</option>
                </optgroup>
                {!IS_MAC && !isWeb && (
                  <optgroup label="System Audio">
                    <option value={SYSTEM_AUDIO_ID}>🖥 System Audio (what's playing)</option>
                  </optgroup>
                )}
              </select>
            </label>
            <button
              className={`btn-rec-go rec-${recordState}`}
              disabled={recordState === 'idle' && !recordInputId}
              onClick={onRecClick}
              title={
                recordState === 'idle' ? (recordInputId ? 'Start recording' : 'Choose an input first')
                : 'Stop + save recording'
              }
            >
              {recordState === 'recording' ? '■ STOP' : '● REC'}
            </button>
            {recordState === 'recording' && (
              <div className="record-live">
                <canvas ref={meterCanvasRef} className="record-meter" width={120} height={14} />
                <span className="record-elapsed">{fmtElapsed(recordElapsed)}</span>
              </div>
            )}
            {recordSaved && <span className="record-saved">{isWeb ? '✓ Loaded — SAVE PROJECT keeps it' : '✓ Saved to USER SAMPLES'}</span>}
            {recordPadTarget !== null && (
              <span className="record-target" title="This take lands on that pad as its own source (right-click a pad → Record into pad). × = record to the main track instead">
                → PAD {recordPadTarget + 1}
                <button type="button" className="record-target-x" onClick={() => setRecordPadTarget(null)} aria-label="Record to the main track instead">×</button>
              </span>
            )}
          </div>
          <div className="record-hint">
            {recordState === 'idle' && (isWeb ? 'Press REC — the mic (or whatever is plugged in) records; STOP loads it into the waveform. Interfaces and virtual devices (Loopback, BlackHole) list under MIC / INTERFACE once the mic is allowed.' : 'Pick an input — your interface and virtual devices (Loopback, BlackHole) list under MIC / INTERFACE — then press REC.')}
            {recordState === 'recording' && (isWeb ? 'Recording… press STOP to load it. It is saved with the project (⇩ FILE / SAVE PROJECT).' : 'Recording… press STOP to save + load.')}
          </div>
        </div>
      )}

      {dlProgress && (
        <div className="cache-dl-panel">
          <div className="cache-dl-header">
            <span className="cache-dl-label">DOWNLOADING — {selectedPlaylist}</span>
            <span className="cache-dl-count">{dlProgress.done} / {dlProgress.total} &nbsp; {Math.round((dlProgress.done / dlProgress.total) * 100)}%</span>
          </div>
          <div className="cache-dl-bar-track">
            <div className="cache-dl-bar-fill" style={{ width: `${(dlProgress.done / dlProgress.total) * 100}%` }} />
          </div>
          {dlProgress.active.length > 0 && (
            <div className="cache-dl-active-list">
              {dlProgress.active.map((t, i) => (
                <span key={i} className="cache-dl-active-item">⬇ {t}</span>
              ))}
            </div>
          )}
          {dlProgress.active.length === 0 && dlProgress.currentTitle && (
            <div className="cache-dl-active-list">
              <span className="cache-dl-active-item cache-dl-done-item">✓ {dlProgress.currentTitle}</span>
            </div>
          )}
        </div>
      )}
      </DraggableSection>{/* /LOAD */}

      {error && <div className="chopper-error" onClick={() => setError(null)} title="Tap to dismiss" style={{ cursor: 'pointer' }}>⚠ {error} ✕</div>}
      {statusMsg && <div className="chopper-status">{statusMsg}</div>}
      {stemsUi.phase !== 'idle' && <StemsSplitStatus ui={stemsUi} />}

      {/* Two-column layout wrappers. These are `display:contents` by default
          (CSS), so in the default layout the DOM behaves exactly as before;
          only [data-layout="alt"] on desktop turns them into real columns. */}
      <div className="chopper-col chopper-col-left">

      {/* ── Waveform ── */}
      <DraggableSection {...dsProps('WAVEFORM')}>
      {(isWebUI || ipc !== undefined) && <SectionHeader
        title="WAVEFORM"
        collapsed={collapsedWaveform}
        onToggle={() => setCollapsedWaveform(v => !v)}
      />}
      {!collapsedWaveform && (
        <div
          ref={waveformWrapRef}
          className={`chopper-waveform-wrap${dragOverWaveform ? ' drag-over' : ''}`}
          onDragOver={e => { e.preventDefault(); setDragOverWaveform(true); }}
          onDragLeave={e => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragOverWaveform(false); }}
          onDrop={e => handleFileDrop(e)}
        >
          {padViewMeta && (
            <div className="pad-view-banner" style={{ '--src-color': sourceColor(viewSourceKey) } as CSSProperties}>
              <span className="pad-view-swatch" title="This group's colour — its pads wear the same bar on the grid" />
              <span className="pad-view-label" title={padViewMeta.title}>{viewSourceKey.startsWith('grp:') ? `${engine.groupLabel(viewSourceKey)} · PAD ${viewPadIdx! + 1}` : `SOURCE · PAD ${viewPadIdx! + 1} — ${padViewMeta.title}`}{padSourceChops.length > 1 ? ` · ${padSourceChops.length} pads` : ''}</span>
              <span className="pad-view-tools">
                <span className="pad-view-tools-lbl" title="Chop this source: the pad keeps the first piece, the rest fill the pads right after its block (a BLOCK of this source); anything in the way is pushed right. Double-click the waveform to chop at a point">✂ CHOP</span>
                {[2, 4, 8, 16].map(n => (
                  <button key={n} className="pad-view-tool" onClick={() => { const k = engine.autoChopPadSource(viewPadIdx!, n); const r = engine.roomAfterBlock(viewPadIdx!); flash(k > 0 ? `PAD ${viewPadIdx! + 1} → ${n} pads` : k < 0 ? `Needs ${n - 1} empty pads after PAD ${r.at} — ${r.free} free. Move the next block away to chop here` : 'Nothing to chop'); }} title={`Chop this pad's region into ${n} equal pieces — into the empty pads right after its block`}>×{n}</button>
                ))}
                <button className="pad-view-tool" onClick={() => { const k = engine.autoChopPadSource(viewPadIdx!, 'transients'); const r = engine.roomAfterBlock(viewPadIdx!); flash(k > 0 ? `PAD ${viewPadIdx! + 1} → ${k + 1} pads at transients` : k < 0 ? `No empty pad after PAD ${r.at} — move the next block away to chop here` : 'No transients found in this region'); }} title="Chop this pad's region at its transients (drum hits, note starts) — as many as fit in the empty pads after its block">HITS</button>
              </span>
              <button className="pad-view-back" onClick={() => setViewPadIdx(null)} title="Back to the main track's waveform — the pad keeps its own sample">← MAIN TRACK</button>
            </div>
          )}
          {pendingPreset && (
            <div className="preset-missing-banner">
              <span className="preset-missing-text">
                ⚠ Preset "{pendingPreset.presetName}" needs its sample —
                reload <strong>{pendingPreset.fileName}</strong> via 📁 LOAD FILE to restore it.
              </span>
              <button className="pad-view-back" onClick={() => setPendingPreset(null)}>DISMISS</button>
            </div>
          )}
          {/* Desktop/Electron: the action buttons get their own strip above the
              waveform (no toolbarExtra there). On web they instead merge into
              the WaveformView zoom-bar as a single controls row — see the
              toolbarExtra prop below. */}
          {!isWebUI && <div className="wave-actions-row">{waveActionButtons}</div>}
          <WaveformView
            state={waveformState as any}
            toolbarExtra={isWebUI ? (
              <div className="wave-actions">
                {/* SNAP · AUTO-CHOP · REV · RESET · DEL ALL · NORM, then the
                    ATTACK + PITCH/TEMPO knobs immediately after NORM — one group,
                    no gap, no separator, all in the same zoom-bar row. */}
                {waveActionButtons}
                <FXKnob label="ATTACK" value={Math.round(viewFx.attack * 1000)} unit=" ms"
                  title={padViewMeta ? 'ATTACK for THIS source — fade-in on every pad of it, 0–500 ms' : 'ATTACK — fade-in on every chop, 0–500 ms: live pads, the sequencer and exports. A few ms kills clicks; hundreds turn chops into swells'}
                  min={0} max={500} step={1} ccId="master.attack"
                  onChange={v => engine.setSourceAttack(viewSourceKey, v / 1000)} onReset={() => engine.setSourceAttack(viewSourceKey, 0)} />
                {/* RELEASE fader removed from the waveform section. */}
                <MidiMapTarget parameterId="master.pitch" min={-24} max={24}
                  onChange={v => engine.setSourcePitch(viewSourceKey, v)}>
                  <FXKnob label={padViewMeta ? 'PITCH' : 'PITCH/TEMPO'} value={viewFx.pitch} unit=" st"
                    title={padViewMeta ? 'PITCH of THIS source — every pad of it, in semitones' : undefined}
                    min={-24} max={24} step={0.5} ccId="master.pitch"
                    onChange={v => engine.setSourcePitch(viewSourceKey, v)} onReset={() => engine.setSourcePitch(viewSourceKey, 0)} />
                </MidiMapTarget>
                {/* FINE — cents on top of PITCH/TEMPO (±50 ¢), so a sample can be
                    tuned to the key exactly instead of to the nearest half step. */}
                <MidiMapTarget parameterId="master.fine" min={-50} max={50}
                  onChange={v => engine.setSourceFine(viewSourceKey, v)}>
                  <FXKnob label="FINE" value={viewFx.fine} unit=" ¢"
                    title={padViewMeta ? 'FINE tune of THIS source — cents on top of PITCH, ±50 ¢' : 'FINE tune — cents on top of PITCH/TEMPO, ±50 ¢ (100 ¢ = one semitone). Tune the sample exactly to your key; pads, the sequencer and exports all follow'}
                    min={-50} max={50} step={1} ccId="master.fine"
                    onChange={v => engine.setSourceFine(viewSourceKey, v)} onReset={() => engine.setSourceFine(viewSourceKey, 0)} />
                </MidiMapTarget>
                {/* START / END — move the FOCUSED chop's boundaries (the pad
                    that's selected, else last hit — engine.focusedPad(), the
                    same pad the waveform highlights). Each knob's range is
                    the chop's own window — from the previous boundary to its
                    other edge — so a CC 0..127 has fine resolution and can't
                    run past a neighbour. MIDI-assignable both ways (legacy
                    ccId learn + the persisted MidiMap). Respects SNAP. */}
                {(() => {
                  const fp = focusedPad();
                  // Pad-source view: the knobs trim the focused pad of THIS source
                  // (its own start/end inside the source's audio).
                  if (padViewMeta && waveformBuffer) {
                    const pbFocus = fp !== null && padSourceChops.some(c => c.padIdx === fp) ? engine.getPadBuffer(fp) : null;
                    const pf = pbFocus ? fp! : (padSourceChops[0]?.padIdx ?? viewPadIdx!);
                    const pb = engine.getPadBuffer(pf);
                    const durS = waveformBuffer.duration;
                    const round3 = (v: number) => Math.round(v * 1000) / 1000;
                    const setS = (v: number) => { if (pb) engine.setPadTrim(pf, v, pb.end); };
                    const setE = (v: number) => { if (pb) engine.setPadTrim(pf, pb.start, v); };
                    return (
                      <span className={`wave-chop-knobs${pb ? '' : ' idle'}`} title={pb ? `PAD ${pf + 1} of this source — START / END. Hit or select another pad of it to trim that one.` : 'Hit a pad of this source to trim it here'}>
                        <MidiMapTarget parameterId="chop.start" min={0} max={pb ? Math.max(0.001, pb.end - 0.01) : 1} onChange={setS}>
                          <FXKnob label="START" value={pb ? round3(pb.start) : 0} unit=" s" min={0} max={pb ? Math.max(0.001, pb.end - 0.01) : 1} step={0.001} ccId="chop.start"
                            onChange={setS} onReset={() => setS(0)} />
                        </MidiMapTarget>
                        <MidiMapTarget parameterId="chop.end" min={pb ? pb.start + 0.01 : 0} max={durS} onChange={setE}>
                          <FXKnob label="END" value={pb ? round3(pb.end) : 0} unit=" s" min={pb ? pb.start + 0.01 : 0} max={durS} step={0.001} ccId="chop.end"
                            onChange={setE} onReset={() => setE(durS)} />
                        </MidiMapTarget>
                      </span>
                    );
                  }
                  const chopId = fp !== null ? state.pads[fp]?.chopId : null;
                  const idx = chopId ? state.chops.findIndex(c => c.id === chopId) : -1;
                  const chop = idx >= 0 ? state.chops[idx] : null;
                  const dur = engine.buffer?.duration ?? 0;
                  const prev = idx > 0 && !state.chops[idx - 1].free ? state.chops[idx - 1] : null;
                  const next = idx >= 0 && idx < state.chops.length - 1 && !state.chops[idx + 1].free ? state.chops[idx + 1] : null;
                  // Hard limits: the chop's own window (previous boundary → other edge).
                  const sMin0 = chop ? (chop.free ? 0 : (prev ? prev.start + 0.01 : 0)) : 0;
                  const sMax0 = chop ? Math.max(sMin0 + 0.001, chop.end - 0.01) : 1;
                  const eMin0 = chop ? chop.start + 0.01 : 0;
                  const eMax0 = chop ? Math.max(eMin0 + 0.001, chop.free ? dur : (next ? next.end - 0.01 : dur)) : 1;
                  // FEEL: the knob's travel is the VISIBLE window, clipped to those
                  // limits — a CC's 128 steps spread over what you're looking at, so
                  // zoomed in = fine surgery, zoomed out = fast moves. (Falls back to
                  // the whole chop window when the point sits outside the view.)
                  const vs = viewStart * dur, ve = viewEnd * dur;
                  const inView = (t: number) => t >= vs - 1e-6 && t <= ve + 1e-6;
                  const clipToView = (lo: number, hi: number, t: number): [number, number] => {
                    if (!chop || !inView(t)) return [lo, hi];
                    const a = Math.max(lo, vs), b = Math.min(hi, ve);
                    return b - a > 0.002 ? [a, b] : [lo, hi];
                  };
                  const [sMin, sMax] = clipToView(sMin0, sMax0, chop?.start ?? 0);
                  const [eMin, eMax] = clipToView(eMin0, eMax0, chop?.end ?? 0);
                  const setStart = (v: number) => { if (chop) engine.setChopBoundary(chop.id, 'start', v); };
                  const setEnd = (v: number) => { if (chop) engine.setChopBoundary(chop.id, 'end', v); };
                  const round3 = (v: number) => Math.round(v * 1000) / 1000;
                  return (
                    <span className={`wave-chop-knobs${chop ? '' : ' idle'}`} title={chop ? `Chop of pad ${(fp ?? 0) + 1} — START / END. Hit or select a pad to pick another.` : 'Hit or select a pad to move its chop points here'}>
                      <MidiMapTarget parameterId="chop.start" min={sMin} max={sMax} onChange={setStart}>
                        <FXKnob label="START" value={chop ? round3(chop.start) : 0} unit=" s"
                          min={sMin} max={sMax} step={0.001} ccId="chop.start"
                          onChange={setStart} onReset={() => { if (chop) engine.setChopBoundary(chop.id, 'start', sMin, true); }} />
                      </MidiMapTarget>
                      <MidiMapTarget parameterId="chop.end" min={eMin} max={eMax} onChange={setEnd}>
                        <FXKnob label="END" value={chop ? round3(chop.end) : 0} unit=" s"
                          min={eMin} max={eMax} step={0.001} ccId="chop.end"
                          onChange={setEnd} onReset={() => { if (chop) engine.setChopBoundary(chop.id, 'end', eMax, true); }} />
                      </MidiMapTarget>
                    </span>
                  );
                })()}
              </div>
            ) : undefined}
            buffer={waveformBuffer}
            waveformRev={engine.waveformRev()}
            trimMode={!padViewMeta && trimMode}
            trimSel={!padViewMeta ? trimSel : null}
            onTrimSelect={setTrimSel}
            onTrimContextMenu={(x, y) => setTrimMenu({ x, y })}
            engine={engine}
            isPlaying={isPlaying}
            onSeekChop={onSeekChop}
            onAdjustChop={onAdjustChop}
            onAdjustFade={(padIdx, side, sec) => {
              const p = state.pads[padIdx];
              engine.setPadFades(padIdx, side === 'in' ? sec : (p?.fadeIn ?? 0), side === 'out' ? sec : (p?.fadeOut ?? 0));
            }}
            onSliceTime={timeSec => {
              if (tapArmedRef.current) handleTapHit();
              // Pad-source view: chop THAT source at the tap — the pad whose
              // region holds the tap keeps the first piece, the rest lands
              // right after its block (other blocks are pushed aside).
              if (padViewMeta && viewPadIdx !== null) {
                const hit = engine.padSourceChops(viewPadIdx).find(c => timeSec > c.start && timeSec < c.end);
                if (hit) {
                  const n = engine.chopPadSource(hit.padIdx, [timeSec]);
                  if (n > 0) flash(`Chopped PAD ${hit.padIdx + 1} — new pad after its block`);
                  else if (n < 0) { const r = engine.roomAfterBlock(hit.padIdx); flash(`PAD ${r.at + 1} is taken — move that block away to keep chopping this source`); }
                }
                return;
              }
              // Pad-assign mode preserved as before — tap a chop while a pad
              // is selected and the chop binds to that pad instead.
              if (state.selectedPad !== null) {
                const hit = state.chops.find(c => timeSec >= c.start && timeSec < c.end);
                if (hit) {
                  engine.assignChopToPad(state.selectedPad, hit.id);
                  engine.selectPad(null);
                  return;
                }
              }
              // Slice at the current PLAYHEAD position if anything's
              // playing — tap is just the "do it now" gesture, the cut
              // happens at the heard moment. Falls back to the tap
              // location when nothing is playing.
              // The new chop goes right after the main track's block (its run
              // of chop pads) — and ONLY if that pad is empty: chopping never
              // pushes another source's block (his rule); move it away first.
              const padIdx = engine.nextSlotForSource('main');
              if (engine.padSourceKey(padIdx)) { flash(`PAD ${padIdx + 1} is taken — move that block away to keep chopping the main track`); return; }
              if (!engine.slicePlayheadAt(padIdx)) {
                engine.sliceAtTime(timeSec, padIdx);
              }
            }}
            transients={padViewMeta && waveformBuffer ? engine.transientsFor(waveformBuffer) : state.transients}
            viewStart={viewStart}
            viewEnd={viewEnd}
            onViewChange={(vs, ve) => { userZoomedRef.current = true; setViewStart(vs); setViewEnd(ve); }}
          />
          {state.selectedPad !== null && (
            <div className="chopper-assign-hint">
              ASSIGNING PAD {state.selectedPad + 1} — click a chop on the waveform (Esc to cancel)
            </div>
          )}
          {state.chopMode && <ChopModeHint engine={engine} />}
          {trimMode && !padViewMeta && (
            <div className="chopper-assign-hint">
              TRIM — drag across the waveform to highlight · TRIM / DELETE / ⌘X cuts it (gap closes) · ESC or a click outside the waveform leaves trim · right-click TRIM = restore
            </div>
          )}
          {trimMenu && trimSel && (
            <div ref={trimMenuRef} style={{ position: 'fixed', left: trimMenu.x, top: trimMenu.y, zIndex: 60, background: 'var(--bg2, #101410)', border: '1px solid var(--border, #2a2f2a)', borderRadius: 4, minWidth: 180, padding: 4, display: 'flex', flexDirection: 'column', gap: 2 }}
              onMouseLeave={() => setTrimMenu(null)}>
              <button className="btn-chop-mode" style={{ textAlign: 'left' }} title="Cut the highlighted section out — the gap closes (⌘Z undoes)" onClick={doTrim}>✂ DELETE SECTION</button>
              <button className="btn-chop-mode" style={{ textAlign: 'left' }} title="Drop the highlight, keep the audio" onClick={() => { setTrimSel(null); setTrimMenu(null); }}>DESELECT</button>
            </div>
          )}
        </div>
      )}
      </DraggableSection>{/* /WAVEFORM */}

      {/* ── Pads + FX ── */}
      <DraggableSection {...dsProps('PADS')}>
      {(isWebUI || ipc !== undefined) && <SectionHeader
        title="PADS"
        collapsed={collapsedPads}
        onToggle={() => setCollapsedPads(v => !v)}
      />}
      <div className="chopper-main">
        {/* Always mount PadGrid so its window keydown listener stays active and
            pad keys fire from any section; hide visually when collapsed.
            display:'contents' keeps the grid's own layout intact when shown. */}
        <div style={{ display: collapsedPads ? 'none' : 'contents' }}>
          <PadGrid
            state={state}
            engine={engine}
            lockedFrom={padLockFrom}
            captureKeyboard={!isWeb}
            drumPadMode={drumPadMode}
            drumPadLabels={drumState.tracks.map(t => t.name)}
            bank={isWebUI ? padBank : undefined}
            onTrigger={onPadTrigger}
            onRelease={onPadRelease}
            onSelect={onPadSelect}
            onFocusPad={onPadFocus}
            onClear={onPadClear}
            onPitch={onPadPitch}
            onDropFile={(padIdx, file) => handleFileDrop({ preventDefault: () => {}, stopPropagation: () => {}, dataTransfer: { files: [file] } } as any, padIdx)}
            onSwapSample={selectedPlaylist ? (padIdx) => loadPadSample(padIdx) : undefined}
            onMovePad={doMovePad}
            onMoveTo={(from, to) => {
              const r = engine.blockRange(from);
              engine.moveBlock(from, to);
              flash(r && r[1] > r[0] ? `BLOCK ${r[0] + 1}–${r[1] + 1} → PAD ${to + 1}` : `PAD ${from + 1} → PAD ${to + 1}`);
            }}
            onImportLink={(idx) => setLinkPrompt({ padIdx: idx })}
            onLoadClipboardLink={(idx) => void loadPadFromClipboard(idx)}
            onMakeMainTrack={(idx) => void makePadMainTrack(idx)}
            mixerTracks={mixerTracks}
            padRoutes={state.padRoutes}
            chokeGroups={engine.chokeGroups()}
            padChoke={state.padChoke}
            onChokePad={(idx, g, whole) => { engine.setPadChoke(idx, g, whole); flash(g === 'none' ? `PAD ${idx + 1}${whole ? ' + block' : ''} → polyphonic` : g === 'new' ? `PAD ${idx + 1}${whole ? ' + block' : ''} → new mute group` : `PAD ${idx + 1}${whole ? ' + block' : ''} → mute group ${engine.chokeGroupLabel(g)}`); }}
            onRoutePad={(idx, route, whole) => { engine.setPadRoute(idx, route, whole); flash(route === 'new' ? `PAD ${idx + 1}${whole ? ' + block' : ''} → new mixer track` : `PAD ${idx + 1}${whole ? ' + block' : ''} → ${mixerTracks.find(t => t.name === route)?.label ?? route}`); }}
            onLoadFileInto={loadFileIntoPad}
            onRecordInto={(idx) => { if (demoBlock()) return; setRecordPadTarget(idx); setRecordOpen(true); void loadRecordInputs(); }}
            onResamplePad={doResamplePad}
            onFlash={flash}
            selection={padSel}
            onCut={doPadCut}
            onCopy={doPadCopy}
            onPaste={doPadPaste}
            onDeletePads={doPadDelete}
            onDuplicatePads={doPadDuplicate}
          />
          {linkPrompt && (
            <LinkPrompt padIdx={linkPrompt.padIdx}
              onCancel={() => setLinkPrompt(null)}
              onLoad={(url) => { const t = linkPrompt.padIdx; setLinkPrompt(null); void loadPadFromUrl(t, url); }} />
          )}
        </div>
        {/* FX panels removed — Attack/Release/Pitch moved to the waveform
            toolbar; all other FX now live in the full-width DAW Mixer below.
            The Electron preset panel still renders inline. */}
        {!isWebUI && <div className="preset-panel">
          <input
            className={`preset-name-input${nameBlink ? ' name-blink' : ''}`}
            placeholder="Project name…"
            value={presetName}
            onChange={e => { setPresetName(e.target.value); setLoadedPresetId(null); setConfirmSave(null); }}
            title="Project name — SAVE PROJECT stores it in your account and, on desktop, as a .tproj file on this computer"
          />
          <button
            className="btn-preset-save"
            disabled={saving}
            title="Save this sample's preset — ⌘S / Ctrl+S (includes chops/pads/sequences)"
            onClick={handleSaveNamedPreset}
          >
            {saving ? 'SAVING…' : 'SAVE PROJECT'}
          </button>
          {namedPresets.length > 0 && (
            <select
              className="ctrl-select preset-load-select"
              defaultValue=""
              onChange={e => { if (e.target.value) handleLoadNamedPreset(e.target.value); e.target.value = ''; }}
              title="Load a saved project"
            >
              <option value="" disabled>LOAD PRESET…</option>
              {namedPresets.map(p => (
                <option key={p.id ?? p.name} value={p.id ?? p.name}>
                  {p.name}{p.trackTitle ? ` — ${p.trackTitle}` : ''}
                </option>
              ))}
            </select>
          )}
          {namedPresets.length > 0 && (
            <select
              className="ctrl-select preset-load-select"
              defaultValue=""
              onChange={e => { if (e.target.value) handleDeleteNamedPreset(e.target.value); e.target.value = ''; }}
              title="Delete a saved project"
            >
              <option value="" disabled>DEL PROJECT…</option>
              {namedPresets.map(p => (
                <option key={p.id ?? p.name} value={p.id ?? p.name}>{p.name}</option>
              ))}
            </select>
          )}
        </div>}
      </div>
      </DraggableSection>{/* /PADS */}
      </div>{/* /chopper-col-left */}

      <div className="chopper-col chopper-col-right">

      {/* ── Step Sequencer ── */}
      <DraggableSection {...dsProps('SEQUENCER')}>
      <div className="tt-gated tt-gated-seq">
      {(isWebUI || ipc !== undefined) && <SectionHeader
        title="SEQUENCER"
        collapsed={collapsedSeq}
        onToggle={() => setCollapsedSeq(v => !v)}
      />}
      {!collapsedSeq && <Timeline
        state={state}
        engine={engine}
        onClear={() => engine.clearSeq()}
        onStartRecord={() => { if (demoBlock()) return; engine.startRecordingSeq(); }}
        onStopRecord={() => engine.stopRecordingSeq()}
        onStartLiveRecord={() => { if (demoBlock()) return; engine.startLiveRecord(); }}
        onStopLiveRecord={() => engine.stopLiveRecord()}
        onToggleCountIn={() => engine.toggleCountIn()}
        onPlay={startTransport}
        onStop={stopTransport}
        onPause={() => engine.pauseSeq()}
        onResume={() => engine.resumeSeq()}
        onToggleLoop={() => engine.toggleSeqLoop()}
        onToggleStep={(step, padIdx) => engine.toggleSeqStep(step, padIdx)}
        onSetStepVelocity={(step, padIdx, v) => engine.setSeqStepVelocity(step, padIdx, v)}
        onClearStep={(step) => engine.clearSeqStep(step)}
        onMoveNote={(from, padIdx, to) => engine.moveSeqNote(from, padIdx, to)}
        onSetBars={(bars) => engine.setSeqBars(bars)}
        onSetResolution={(res) => engine.setSeqResolution(res)}
        onSelectSequence={(idx) => engine.selectSequence(idx)}
        onAddSequence={() => engine.addSequence()}
        onDuplicateSequence={() => engine.duplicateSequence()}
        onDeleteSequence={(idx) => engine.deleteSequence(idx)}
      />}
      </div>
      </DraggableSection>{/* /SEQUENCER */}

      {/* ── DRUMS section (web only, collapsible). Lives between sequencer
          and FX so the chopper sequencer + drum sequencer feel like one
          stack; drum output feeds into the pad bus so master FX process
          both. ── */}
      <DraggableSection {...dsProps('DRUMS')}>
      <div className="tt-gated tt-gated-drums">
      {(isWebUI || ipc !== undefined) && (
        <>
          <SectionHeader
            title="DRUMS"
            collapsed={collapsedDrums}
            onToggle={() => setCollapsedDrums(v => !v)}
          />
          {!collapsedDrums && (
            <DrumSection
              engine={drumEngine}
              chopperEngine={engine}
              recGate={demo ? () => !demoBlock() : undefined}
              onTransportPlay={startTransport}
              onTransportStop={stopTransport}
              drumPadMode={drumPadMode}
              onToggleDrumPadMode={() => setDrumPadMode(v => !v)}
              onDrumPadModeOn={() => setDrumPadMode(true)}
            />
          )}
        </>
      )}
      </div>
      </DraggableSection>{/* /DRUMS */}

      {/* ── BASS — Model-D-style synth + piano roll. Third engine next to the
          chop and drum sequencers; runs off the same transport anchor and
          owns the BASS strip on the mixer. ── */}
      <DraggableSection {...dsProps('BASS')}>
      <div className="tt-gated tt-gated-bass">
      {(isWebUI || ipc !== undefined) && (
        <>
          <SectionHeader
            title="BASS"
            collapsed={collapsedBass}
            onToggle={() => setCollapsedBass(v => !v)}
          />
          {!collapsedBass && (
            <BassSection
              engine={bassEngine}
              chopperEngine={engine}
              recGate={demo ? () => !demoBlock() : undefined}
              onTransportPlay={startTransport}
              onTransportStop={stopTransport}
              transportPlaying={state.seqPlaying}
              onMidiInChange={(on) => { bassMidiRef.current = on; if (on) setDrumPadMode(false); pushMidiRouting(); }}
            />
          )}
        </>
      )}
      </div>
      </DraggableSection>{/* /BASS */}

      {/* ── FX section removed — replaced by the full-width DAW Mixer rendered
          below the two columns (see <MixerSection/>). ── */}

      {/* ── BEAT FINISHER tab (web only) — a launcher, not a panel: clicking it
          opens the themed Beat Finisher portal (intro video → arranger modal).
          Sits after FX, before PRESETS. ── */}
      <DraggableSection {...dsProps('BEAT FINISHER')}>
      <div className="tt-gated tt-gated-finishhim">
      {(isWebUI || ipc !== undefined) && (
        <SectionHeader
          title="BEAT FINISHER"
          collapsed={true}
          onToggle={openFinishHim}
        />
      )}
      </div>
      </DraggableSection>{/* /BEAT FINISHER */}

      {/* ── PRESETS — the standalone right-column section (the "Preset tab")
          was removed; its save/load/delete UI now lives inside the LOAD
          section toolbar above (see the tt-gated-presets panel there). ── */}

      {/* ── Export section (web only) ─── format dropdown + one-click export.
          Main-Terminator exports (chops / sequences / master / MPC project) —
          separate from the Beat Finisher arrangement export in the modal. */}
      <DraggableSection {...dsProps('EXPORT')}>
      <div className="tt-gated tt-gated-export">
      {(isWebUI || ipc !== undefined) && (
        <>
          <SectionHeader
            title="EXPORT"
            collapsed={collapsedExport}
            onToggle={() => setCollapsedExport(v => !v)}
          />
          {!collapsedExport && (
            <div className="export-panel chopper-web-export">
              {/* One button, one popup: every option lives in the dialog (Ableton's Export Audio box), so
                  trackouts are a thing you can RENDER rather than a separate control somewhere else. */}
              <button
                className="btn btn-export-run"
                disabled={exportBusy || !state.hasBuffer}
                onClick={() => { setExportMsg(null); setShowExportModal(true); }}
                title="Open the export options"
              >
                {exportBusy ? 'EXPORTING…' : '⬇ EXPORT…'}
              </button>
              {exportMsg && <span className="export-status">{exportMsg}</span>}
            </div>
          )}
        </>
      )}
      </div>
      </DraggableSection>{/* /EXPORT */}
      <ExportModal
        open={showExportModal}
        canExport={state.hasBuffer}
        onClose={() => setShowExportModal(false)}
        sampleRate={engine.buffer?.sampleRate}
        onRun={async (format, audioFormat, onProgress, shouldCancel, bitDepth) => {
          setExportBusy(true);
          // iOS: persist the session BEFORE the share sheet backgrounds the tab, so a WebKit reload-on-return
          // can restore it (the inline button did this too — it must not be lost with the layout change).
          snapshotSessionForExport();
          try {
            return await runExport(engine, format, onProgress, {
              drumEngine,
              arrangement: buildFinishArrangement(currentFinishSections()),
              bpm: engine.getMasterBpm() || 90,
            }, audioFormat, shouldCancel, bitDepth);
          } finally {
            setExportBusy(false);
          }
        }}
      />
      </div>{/* /chopper-col-right */}

      {/* ── DAW Mixer (full-width, below the pad/sequencer columns). Desktop
          only — ChopperView never renders on mobile (HardwareView does). ── */}
      <DraggableSection {...dsProps('MIXER')}>
      {/* The mappable master-CLIP knob is Electron-only (the whole MIDI-map
          feature is), so onClip is withheld in the web build → no new control
          appears there. */}
      <MixerSection channelsRev={mixerRev} engine={mixerEngine} bpm={engine.getMasterBpm()}
        clip={masterClip} onClip={isWeb ? undefined : handleSetClip}
        palette={activePalette} transportOn={transportOn} />
      </DraggableSection>{/* /MIXER */}

      {/* ── Export bar ── */}
      <div className="chopper-export-bar">
        <div className="export-actions">
          <button
            className="btn btn-stop"
            onClick={killAllAudio}
            disabled={!state.hasBuffer}
            title="Panic stop — kills the sequencer, the drums and every ringing pad at once"
          >
            ■ STOP
          </button>
          {/* Account: signed-in users sign out here, right beside the red STOP.
              Rendered in the (ungated) export bar so it stays clickable for
              signed-in free-tier users. Hidden when signed out — the wrapper
              shows the SIGN IN / SIGN UP pill instead. Desktop-only: ChopperView
              never renders on mobile (HardwareView does). */}
          {(isSignedIn() || (!isWeb && !!getLicense()?.unlocked)) && (
            <button
              className="btn btn-signout-export"
              onClick={handleSignOut}
              title="Sign out of your Killavic Cheat Codes account"
            >
              SIGN OUT
            </button>
          )}
          {/* Export buttons removed — export is handled by the Beat Finisher. */}
        </div>
      </div>
      {!isSubscribed() && !demo && (
        <div className="free-tier-banner" onClick={() => setSubModalOpen(true)}>
          FREE TIER · {pullsRemaining()} pulls left · <b>NOW ON macOS &amp; WINDOWS</b> · tap to unlock — $40 once, yours forever
        </div>
      )}
      <SubscribeModal open={subModalOpen} demo={demo} onClose={() => { setSubModalOpen(false); if (demo && demoSpent) setSampleBrowserOpen(false); }} onBuyLifetime={handleBuyLifetime} />

      {/* Help + tooltips. Both portal to <body>, so where they sit in this tree
          only decides when they mount, never where they paint. The tip layer
          stays mounted whatever else is open — modals have controls too — and
          bails out on its own for touch devices. */}
      {helpOpen && (
        <HelpModal tips={tips} onTips={changeTips} onClose={() => setHelpOpen(false)} />
      )}
      <TipLayer enabled={tips} />

      {/* Phase 3A.7: themed intro video (first Beat Finisher open per session). */}
      {introVideo && (
        <div
          onClick={dismissIntro}
          style={{
            position: 'fixed', inset: 0, zIndex: 10001, background: '#000',
            display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer',
          }}
        >
          <video
            src={`${import.meta.env.BASE_URL}videos/${introVideo === 'ps2' ? 'ps2-intro.mp4' : 'xbox-intro.mp4'}`}
            autoPlay
            playsInline
            onEnded={dismissIntro}
            onError={dismissIntro}
            style={{ maxWidth: '100%', maxHeight: '100%' }}
          />
          <div style={{
            position: 'absolute', bottom: 24, right: 28, color: 'rgba(255,255,255,0.7)',
            fontFamily: 'monospace', fontSize: 12, letterSpacing: 1, pointerEvents: 'none',
            textShadow: '0 1px 4px rgba(0,0,0,0.8)',
          }}>TAP TO SKIP ▶</div>
        </div>
      )}

      {finishHimOpen && (
        <div
          style={{
            position: 'fixed', inset: 0, zIndex: 10000, background: 'rgba(0,0,0,0.85)',
            display: 'flex', alignItems: 'center', justifyContent: 'center', padding: fhPhone ? 0 : 16, overflow: 'auto',
          }}
        >
          <div style={{ width: fhPhone ? '100%' : 'min(900px, 100%)' }}>
            <FinishHimPortal
              theme={finishHimTheme ?? mapPortalTheme(getStoredTheme())}
              bpm={engine.getMasterBpm()}
              chopSeqs={(engine.getState().sequences || []).map((_, i) => `Seq ${i + 1}`)}
              drumTracks={drumState.tracks.map(t => ({ key: t.key, label: t.name }))}
              drumPattern={drumState.pattern as any} drumStepsPerBar={drumEngine.stepsPerBar}
              drumSequences={(drumState.sequences && drumState.sequences.length ? drumState.sequences : [drumState.pattern]) as any}
              currentDrumSeq={drumState.seqIndex} currentChopSeq={engine.getState().currentSeqIdx}
              bassSeqs={bassEngine.getState().patterns.map((pt) => ({ dots: BassEngine.beatDots(pt) }))}
              initialSections={finishHimSavedRef.current ?? undefined}
              onPersist={(secs) => { finishHimSavedRef.current = secs; }}
              previewing={finishHimPreviewing}
              getProgress={() => ({ beat: arranger.getElapsedBeats(), total: arranger.getTotalBeats() })}
              onPreview={previewFinishHim}
              onStopPreview={stopFinishHimPreview}
              onLiveEdit={liveUpdateFinishHim}
              seekBeat={finishHimSeekBeat}
              onSeek={seekFinishHim}
              onExport={exportFinishHim}
              onClose={() => { stopFinishHimPreview(); setFinishHimSeekBeat(0); setFinishHimOpen(false); }}
              onComplete={(arrangement) => {
                // TODO(next session): wire to the export pipeline (stems + master + Ozone).
                // For now just log the chosen structure so the flow is end-to-end.
                console.log('[finish-him] arrangement complete:', arrangement);
                setFinishHimOpen(false);
              }}
            />
          </div>
        </div>
      )}

      {sampleBrowserOpen && (
        <SampleBrowser
          playlists={playlists}
          initialPlaylist={selectedPlaylist}
          isPhone={fhPhone}
          resolveAudioUrl={browserResolveUrl}
          // Electron only: playlists arrive over IPC and never load the renderer's
          // R2 manifest, so let the browser (re)load it on demand if a preview id
          // doesn't resolve. Web's manifest is already indexed → leave undefined.
          ensureAudioReady={isWeb ? undefined : () => loadManifest().then(() => {})}
          previewGate={demo ? gatePull : undefined}
          presetIndex={presetIndex}
          onLoad={loadFromBrowser}
          onLoadPreset={loadPresetFromBrowser}
          onLoadToPad={loadFromBrowserToPad}
          // The Sample Library (~/Music/Terminator) — Electron only.
          library={libraryBridge}
          onClose={() => setSampleBrowserOpen(false)}
        />
      )}
      <OpenProjectModal
        open={openModalOpen}
        onClose={() => setOpenModalOpen(false)}
        isWeb={isWeb}
        signedIn={isSignedIn()}
        cloudPresets={namedPresets}
        onRefreshCloud={() => { if (isWeb) void refreshWebPresets(); }}
        onLoadCloud={(id) => { void handleLoadNamedPreset(id); }}
        onDeleteCloud={(id) => { void handleDeleteNamedPreset(id); }}
        // LOCAL tab is Electron-only — gate every disk handler on !isWeb so the
        // web build never wires them (the modal also hides the tab when isWeb).
        listLocal={isWeb ? undefined : (() => ipc?.listProjectFiles?.() ?? Promise.resolve([]))}
        onLoadLocal={isWeb ? undefined : ((p) => { void openProjectFromPath(p); })}
        deleteLocal={isWeb ? undefined : ((p) => ipc?.deleteProjectFile?.(p) ?? Promise.resolve({ ok: true }))}
        projectsDir={isWeb || !ipc?.getProjectsDir ? undefined : {
          get: () => ipc.getProjectsDir!(),
          choose: () => ipc.chooseProjectsDir!(),
          reset: () => ipc.resetProjectsDir!(),
          reveal: () => ipc.revealProjectsDir!(),
        }}
        onBrowse={isWeb ? undefined : handleBrowseProject}
        onTransferSend={currentVideoId ? () => setTransfer('send') : undefined}
        onTransferReceive={() => setTransfer('receive')}
        onImportFile={isWeb ? () => fileInputRef.current?.click() : undefined}
      />
      <OpenProjectModal
        open={saveAsOpen}
        mode="save"
        saveName={currentProjectName()}
        onSave={(name) => { void doSaveProject(name); }}
        onClose={() => setSaveAsOpen(false)}
        isWeb={isWeb}
        signedIn={isSignedIn()}
        cloudPresets={namedPresets}
        onRefreshCloud={() => { if (isWeb) void refreshWebPresets(); }}
        onLoadCloud={() => { /* save mode: rows fill the name */ }}
        onDeleteCloud={(id) => { void handleDeleteNamedPreset(id); }}
        listLocal={isWeb ? undefined : (() => ipc?.listProjectFiles?.() ?? Promise.resolve([]))}
        deleteLocal={isWeb ? undefined : ((p) => ipc?.deleteProjectFile?.(p) ?? Promise.resolve({ ok: true }))}
        projectsDir={isWeb || !ipc?.getProjectsDir ? undefined : {
          get: () => ipc.getProjectsDir!(),
          choose: () => ipc.chooseProjectsDir!(),
          reset: () => ipc.resetProjectsDir!(),
          reveal: () => ipc.revealProjectsDir!(),
        }}
      />
      {transfer && (
        <TransferModal mode={transfer}
          getBundle={async () => {
            if (!currentVideoId) throw new Error('Load a sample first');
            const name = presetName.trim() || state.trackTitle || 'project';
            const data = buildPreset(currentVideoId);
            if (projectNeedsBundle(data)) { const b = await buildProjectBundle(data); return { bytes: b.bytes, name }; }
            return { bytes: new TextEncoder().encode(JSON.stringify(data)), name };
          }}
          onBundle={async (bytes, name) => { await importProjectBytes(bytes, name); }}
          onClose={() => setTransfer(null)} />
      )}
      {showEula && (
        <EulaModal onAccepted={() => { setShowEula(false); void checkLicenseGate(); }} />
      )}
      {showSignIn && (
        <SignInModal onContinueFree={() => setShowSignIn(false)} />
      )}
      {themeMenuRect && (
        <ThemeMenu
          anchor={themeMenuRect}
          lockedKind={lockedTheme.kind}
          lockedId={lockedTheme.id}
          finish={finish}
          finishForced={activeTheme.kind === 'original' && METAL_THEMES.has(activeTheme.id)}
          onFinish={changeFinish}
          dust={dust}
          onDust={changeDust}
          onPreview={previewThemeItem}
          onPreviewEnd={endThemePreview}
          onLock={lockThemeItem}
          onClose={closeThemeMenu}
          demo={demo}
          onLockedTheme={() => { closeThemeMenu(); setSubModalOpen(true); }}
          uiMode={getUiMode()}
          onUiMode={(m) => { switchUiMode(m); }}
        />
      )}
    </div>
  );
}

/** "hit any other pad to slice here" banner, shown while a pad is ringing in
 *  chop mode. Split out of ChopperView so subscribing to per-hit pad activity
 *  re-renders this one <div> instead of the whole view. */
function ChopModeHint({ engine }: { engine: ChopperEngine }) {
  const activity = usePadActivity(engine);
  if (!activity || activity.activePads.length === 0) return null;
  return (
    <div className="chopper-chop-hint">
      ✂ CHOP MODE — hit any other pad to slice here
    </div>
  );
}

// Plain text from the clipboard: Electron's clipboard through the preload (the
// renderer's navigator.clipboard is permission-denied in the app), the web API
// in the browser build. Rejects when neither can read.
async function readClipboardText(): Promise<string> {
  const t = (window as any).terminator;
  if (t && typeof t.clipboardReadText === 'function') return (await t.clipboardReadText()) ?? '';
  return (await navigator.clipboard.readText()) ?? '';
}
// IMPORT LINK… onto a pad — a small in-app prompt (Electron has no
// window.prompt). Enter / LOAD pulls, Escape / CANCEL closes.
function LinkPrompt({ padIdx, onLoad, onCancel }: { padIdx: number; onLoad: (url: string) => void; onCancel: () => void }) {
  const [v, setV] = useState('');
  // A link already in the clipboard is offered up front — Enter and it pulls.
  useEffect(() => {
    let alive = true;
    readClipboardText().then(t => { const s = (t ?? '').trim(); if (alive && /^https?:\/\/\S+$/i.test(s)) setV(cur => cur || s); }).catch(() => { /* no clipboard access — type it */ });
    return () => { alive = false; };
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onCancel(); } };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onCancel]);
  return createPortal(
    <div className="link-prompt-backdrop" onMouseDown={e => { if (e.target === e.currentTarget) onCancel(); }}>
      <div className="link-prompt" role="dialog" aria-label={`Import a link onto pad ${padIdx + 1}`}>
        <div className="link-prompt-title">IMPORT LINK → PAD {String(padIdx + 1).padStart(2, '0')}</div>
        <input className="ctrl-input url-input link-prompt-input" type="text" autoFocus placeholder="https://youtube.com/…"
          value={v} onChange={e => setV(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && v.trim()) onLoad(v); }} />
        <div className="link-prompt-hint">Paste a YouTube link — the audio lands on this pad as its own source. Tap the pad to see it on the waveform.</div>
        <div className="link-prompt-actions">
          <button type="button" className="btn-small" onClick={onCancel} title="Close without loading (Esc)">CANCEL</button>
          <button type="button" className="btn-small btn-primary" disabled={!v.trim()} onClick={() => onLoad(v)} title="Pull this link onto the pad as its own source (Enter)">⇣ LOAD</button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

function UrlInput({ onLoad, disabled }: { onLoad: (url: string) => void; disabled: boolean }) {
  const [v, setV] = useState('');
  return (
    <label className="toolbar-field">
      <span className="toolbar-label">OR URL</span>
      <input className="ctrl-input url-input" type="text" placeholder="https://youtube.com/…"
        value={v} onChange={e => setV(e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter' && !disabled) onLoad(v); }}
        disabled={disabled} />
    </label>
  );
}

function ChopOffsetControl({ offsetMs, onChange }: { offsetMs: number; onChange: (ms: number) => void }) {
  const [editing, setEditing] = useState(false);
  const [raw, setRaw] = useState('');
  const startY = useRef(0);
  const startVal = useRef(0);

  const handleMouseDown = (e: React.MouseEvent) => {
    startY.current = e.clientY;
    startVal.current = offsetMs;
    const onMove = (mv: MouseEvent) => {
      const delta = Math.round((startY.current - mv.clientY) * 0.5);
      onChange(Math.max(-200, Math.min(200, startVal.current + delta)));
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  if (editing) {
    return (
      <input className="ctrl-input bpm-input" type="number" value={raw} autoFocus
        onChange={e => setRaw(e.target.value)}
        onBlur={() => {
          const n = parseInt(raw, 10);
          if (!isNaN(n)) onChange(Math.max(-200, Math.min(200, n)));
          setEditing(false);
        }}
        onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
      />
    );
  }
  return (
    <div className="bpm-display chop-offset-display"
      onMouseDown={handleMouseDown}
      onDoubleClick={() => { setRaw(String(offsetMs)); setEditing(true); }}
      title="Chop timing offset in ms. Drag up/down or double-click to type. Negative = earlier, positive = later."
    >
      <span className="bpm-label">TRIM</span>
      <span className="bpm-value" style={{ fontSize: 12 }}>{offsetMs >= 0 ? '+' : ''}{offsetMs}ms</span>
    </div>
  );
}

function TransientSliceControl(props: {
  sensitivity: number; totalTransients: number; onChange: (sens: number) => void; disabled?: boolean;
}) {
  return isWebUI ? <AutoChopControlWeb {...props} /> : <TransientSliceControlDesktop {...props} />;
}

// Web: AC (auto-chop) tap-toggle. OFF when sensitivity === 0. Tapping when
// OFF sets sensitivity to 1% (0.01) and applies autoslice. Tapping again
// returns to OFF (single chop = whole sample). A small drag also adjusts
// sensitivity for fine-tuning above 1%.
function AutoChopControlWeb({
  sensitivity, totalTransients, onChange, disabled,
}: { sensitivity: number; totalTransients: number; onChange: (sens: number) => void; disabled?: boolean }) {
  const on = sensitivity > 0;
  const pct = Math.round(sensitivity * 100);
  // Mirror the engine's web cap (ChopperEngine.autoSliceTransients) so the
  // readout matches the number of chops actually created.
  const MAX_AUTO_SLICE = 256;
  const effMax = Math.min(totalTransients, MAX_AUTO_SLICE);
  const wantCount = Math.max(0,
    Math.min(effMax, Math.round(effMax * Math.pow(sensitivity, 0.7)))
  );

  // Drag-vs-tap detection: if the pointer moves more than 4px before release,
  // treat as drag; otherwise treat the release as a toggle tap.
  const handlePointerDown = (e: React.PointerEvent) => {
    if (disabled) return;
    const startY = e.clientY;
    const startVal = sensitivity;
    let dragged = false;
    const onMove = (mv: PointerEvent) => {
      const delta = (startY - mv.clientY) * 0.005;
      if (!dragged && Math.abs(mv.clientY - startY) > 4) dragged = true;
      if (dragged) onChange(Math.max(0, Math.min(1, startVal + delta)));
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      if (!dragged) {
        // Tap → toggle. OFF → 1% on; ON → 0 (off again).
        onChange(on ? 0 : 0.01);
      }
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  return (
    <div
      className={`bpm-display chop-offset-display ac-toggle${on ? ' on' : ' off'}${disabled ? ' ctrl-disabled' : ''}`}
      onPointerDown={handlePointerDown}
      style={{ touchAction: 'none' }}
      title={
        disabled
          ? 'Load a sample to enable auto-chop'
          : on
            ? `Auto-chop ON — picks the strongest ${wantCount} of ${totalTransients} transients. Tap to turn off; drag up to adjust.`
            : 'Tap to turn auto-chop ON (1%). Drag up to crank it.'
      }
    >
      <span className="bpm-label">AC</span>
      <span className="bpm-value" style={{ fontSize: 12 }}>
        {on ? `${pct}%${totalTransients > 0 ? ` · ${wantCount}` : ''}` : 'OFF'}
      </span>
    </div>
  );
}

// Original desktop SLICE knob — unchanged.
function TransientSliceControlDesktop({
  sensitivity, totalTransients, onChange, disabled,
}: { sensitivity: number; totalTransients: number; onChange: (sens: number) => void; disabled?: boolean }) {
  const [editing, setEditing] = useState(false);
  const [raw, setRaw] = useState('');
  const startY = useRef(0);
  const startVal = useRef(0);

  const pct = Math.round(sensitivity * 100);
  // Desktop engine has no cap; don't clamp the readout.
  const MAX_AUTO_SLICE = Infinity;
  const effMax = Math.min(totalTransients, MAX_AUTO_SLICE); // = totalTransients on desktop
  const wantCount = Math.max(0,
    Math.min(effMax, Math.round(effMax * Math.pow(sensitivity, 0.7)))
  );

  const handleMouseDown = (e: React.MouseEvent) => {
    if (disabled) return;
    startY.current = e.clientY;
    startVal.current = sensitivity;
    const onMove = (mv: MouseEvent) => {
      const delta = (startY.current - mv.clientY) * 0.005;
      onChange(Math.max(0, Math.min(1, startVal.current + delta)));
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  const handleWheel = (e: React.WheelEvent) => {
    if (disabled) return;
    e.preventDefault();
    onChange(Math.max(0, Math.min(1, sensitivity + (e.deltaY < 0 ? 0.02 : -0.02))));
  };

  if (editing) {
    return (
      <input className="ctrl-input bpm-input" type="number" value={raw} autoFocus min={0} max={100}
        onChange={e => setRaw(e.target.value)}
        onBlur={() => {
          const n = parseInt(raw, 10);
          if (!isNaN(n)) onChange(Math.max(0, Math.min(1, n / 100)));
          setEditing(false);
        }}
        onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
      />
    );
  }
  return (
    <div
      className={`bpm-display chop-offset-display${disabled ? ' ctrl-disabled' : ''}`}
      onMouseDown={handleMouseDown}
      onWheel={handleWheel}
      onDoubleClick={() => { if (!disabled) { setRaw(String(pct)); setEditing(true); } }}
      title={
        disabled
          ? 'Load a sample to enable transient slicing'
          : `Auto-slice sensitivity — picks the strongest ${wantCount} of ${totalTransients} detected transients. Drag up/down, scroll, or double-click to type.`
      }
    >
      <span className="bpm-label">SLICE</span>
      <span className="bpm-value" style={{ fontSize: 12 }}>
        {pct}%{totalTransients > 0 ? ` · ${wantCount}` : ''}
      </span>
    </div>
  );
}

function BpmInput({ bpm, onChange }: { bpm: number; onChange: (v: number) => void }) {
  const [editing, setEditing] = useState(false);
  const [raw, setRaw] = useState('');
  const [adjusting, setAdjusting] = useState(false); // show the big BPM popup while changing
  const startY = useRef(0);
  const startVal = useRef(0);
  const wheelTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Phase 3A.10.1: the popup is centred on the control (CSS left:50% + translateX),
  // but on a phone the wide bubble can overhang the screen edge. Clamp its centre
  // into the viewport when it first appears (no per-move re-render during drag).
  const displayRef = useRef<HTMLDivElement>(null);
  const popupRef = useRef<HTMLDivElement>(null);
  const [popupLeft, setPopupLeft] = useState<string>('50%');
  // The popup floats ABOVE the control by default (visible over the thumb on
  // mobile); flip below only when the control is too near the viewport top to
  // fit the bubble above it, so it never clips off the top of the screen.
  const [popupBelow, setPopupBelow] = useState(false);
  useLayoutEffect(() => {
    if (!adjusting) { setPopupLeft('50%'); setPopupBelow(false); return; }
    const d = displayRef.current, p = popupRef.current;
    if (!d || !p) return;
    const dr = d.getBoundingClientRect();
    const half = p.offsetWidth / 2;
    const m = 8; // viewport margin
    const centre = Math.max(m + half, Math.min(window.innerWidth - m - half, dr.left + dr.width / 2));
    setPopupLeft(`${centre - dr.left}px`);
    // Room above = control's top edge minus the bubble height + 6px gap + margin.
    setPopupBelow(dr.top < p.offsetHeight + 6 + m);
  }, [adjusting]);

  const handleWheel = (e: React.WheelEvent) => {
    e.preventDefault();
    onChange(Math.max(20, Math.min(300, bpm + (e.deltaY < 0 ? 1 : -1))));
    // Pop the value up briefly while scrolling, then hide shortly after.
    setAdjusting(true);
    if (wheelTimer.current) clearTimeout(wheelTimer.current);
    wheelTimer.current = setTimeout(() => setAdjusting(false), 700);
  };

  const handlePointerDown = (e: React.PointerEvent) => {
    e.preventDefault();
    startY.current = e.clientY;
    startVal.current = bpm;
    setAdjusting(true);
    const onMove = (mv: PointerEvent) => {
      const delta = Math.round((startY.current - mv.clientY) * 0.5);
      onChange(Math.max(20, Math.min(300, startVal.current + delta)));
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      setAdjusting(false);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  if (editing) {
    return (
      <input
        className="ctrl-input bpm-input"
        type="number"
        value={raw}
        autoFocus
        onChange={e => setRaw(e.target.value)}
        onBlur={() => {
          const n = parseInt(raw, 10);
          if (!isNaN(n)) onChange(Math.max(20, Math.min(300, n)));
          setEditing(false);
        }}
        onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
      />
    );
  }
  return (
    <div className="bpm-display"
      ref={displayRef}
      onPointerDown={handlePointerDown}
      onDoubleClick={() => { setRaw(String(bpm)); setEditing(true); }}
      onWheel={handleWheel}
      style={{ touchAction: 'none' }}
    >
      {adjusting && (
        <div className={`bpm-popup${popupBelow ? ' bpm-popup-below' : ''}`} ref={popupRef} style={{ left: popupLeft }}>{bpm}<span className="bpm-popup-unit">BPM</span></div>
      )}
      <span className="bpm-label">BPM</span>
      <span className="bpm-value">{bpm}</span>
    </div>
  );
}

function TapTempoButton({ onTempo }: { onTempo: (bpm: number) => void }) {
  const taps = useRef<number[]>([]);
  const [count, setCount] = useState(0);
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleTap = () => {
    const now = performance.now();
    const last = taps.current[taps.current.length - 1];
    // Reset if gap > 2s (BPM ≥ 30 means interval ≤ 2s)
    if (last !== undefined && now - last > 2000) taps.current = [];
    taps.current.push(now);
    if (taps.current.length > 8) taps.current.shift();
    setCount(taps.current.length);

    if (taps.current.length >= 2) {
      const intervals: number[] = [];
      for (let i = 1; i < taps.current.length; i++) {
        intervals.push(taps.current[i] - taps.current[i - 1]);
      }
      const avg = intervals.reduce((s, x) => s + x, 0) / intervals.length;
      const bpm = Math.round(60000 / avg);
      onTempo(Math.max(20, Math.min(300, bpm)));
    }

    if (resetTimer.current) clearTimeout(resetTimer.current);
    resetTimer.current = setTimeout(() => { taps.current = []; setCount(0); }, 2000);
  };

  return (
    <button
      className="btn-tap-tempo"
      onClick={handleTap}
      title="Tap a steady pulse to set BPM (resets after 2s of no taps)"
    >
      TAP{count >= 2 ? ` ${count}` : ''}
    </button>
  );
}

// Slim collapsible bar shown above each major section (Waveform / Pads /
// Sequencer). Tap to fold the section away — its body is conditionally
// rendered, so React unmounts and re-mounts cleanly.
function SectionHeader({ title, collapsed, onToggle }: {
  title: string; collapsed: boolean; onToggle: () => void;
}) {
  return (
    <button
      type="button"
      className={`chopper-section-header${collapsed ? ' collapsed' : ''}`}
      data-section={title}
      onClick={onToggle}
      title={collapsed ? `Expand ${title}` : `Collapse ${title}`}
    >
      <span className="chopper-section-arrow">{collapsed ? '▸' : '▾'}</span>
      <span className="chopper-section-title">{title}</span>
    </button>
  );
}
