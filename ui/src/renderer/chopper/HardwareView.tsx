// HardwareView.tsx — opt-in "hardware" mobile layout (?v2=1).
//
// Design reference: terminator-machine.html. This is an ALTERNATE layout, not a
// rewrite: it spins up its OWN ChopperEngine + DrumEngine (ChopperView exposes
// no props to share) and REUSES the existing self-contained feature components
// (WaveformView, Timeline, DrumSection, SampleBrowser, FinishHimPortal) inside a
// hardware-styled chassis. The pad grid is a bespoke hardware grid (numbers +
// per-pad menu). The web-mode load / preset / export plumbing is ported faithfully
// from ChopperView so the two layouts behave identically. Classic ChopperView is
// left 100% untouched; the only hook is a one-line `?v2` switch at its top.
import { useEffect, useMemo, useRef, useState, PointerEvent as ReactPointerEvent } from 'react';
import { createPortal } from 'react-dom';
import './HardwareView.css';
import { ChopperEngine, ChopperState, ChopPreset, SEQ_MAX_STEPS, NO_SAMPLE_ID } from './ChopperEngine';
import { attachNativeEngineShadow } from '../native/nativeEngineShadow';
import { DrumEngine, TrackKey, Genre, GENRES, GENRE_LABELS } from '../drums/DrumEngine';
import { DrumSection } from '../drums/DrumSection';
import { DrumBrowser, type DrumSample } from '../DrumBrowser';
import { WaveformView } from './WaveformView';
// Same clipboard ops the desktop grid runs — one implementation, so the phone
// and the computer can't drift apart on what cut/copy/paste mean.
import { PadContent, getPadContent, cutPads, pastePads, duplicatePads } from './padClipboard';
import { Timeline } from './Timeline';
import SampleBrowser, { BrowserEntry } from './SampleBrowser';
import { r2AudioUrl, loadManifest } from '../r2';
import { SubscribeModal } from '../components/SubscribeModal';
import FinishHimPortal, { FinishArrangementSection, defaultFinishSections } from '../finishhim/FinishHimPortal';
import { ArrangerPreview } from '../arranger/ArrangerPreview';
import { Arrangement } from '../arranger/types';
// DRAG OUT (8.6c, native only): the pad menu is the drag source — see dragOutNative.ts for the timing rule.
import { PadDragOut, canDragOut } from '../native/dragOutNative';
import { isSubscribed, isDemo, recordPull, FREE_PAD_LIMIT } from '../lib/subscription';
import { runExport, ExportFormat } from './exporters';
import { isIOS } from '../lib/download';
import { useIsPhone } from '../lib/useIsPhone';
import { getStoredPaletteOn, getStoredPaletteId, persistPaletteOn, persistPaletteId, paletteById, getStoredHwFinish, persistHwFinish, type HwFinish } from './hwPalettes';
import { usePadActivity } from './usePadActivity';
import { HelpModal, TipLayer, readTipsEnabled, writeTipsEnabled } from './Help';
import { MidiLatencyMeter } from './MidiLatencyMeter';
import { padIndexForNote } from './midiPads';
import { midiLearn as midiCc } from './midiLearn';
import { midiHub } from './midiHub';
import { assetStore, ASSET_PREFIX, assetHash, unpackProjectBundle, missingAssets, withAssetManifest, looksLikeProjectFile, projectNeedsBundle, buildProjectBundle } from './projectAssets';
import { TransferModal } from './transfer/TransferModal';
import { MidiStatusPill } from './MidiStatus';
import { BassEngine, bassSeqForSection } from '../bass/BassEngine';
import { NOTE_NAMES, SCALES, type ScaleId } from '../bass/theory.mts';
import { BassSection } from '../bass/BassSection';
import { ThemeMenu } from './ThemeMenu';
import { getUiMode, switchUiMode } from './uiMode';
import { LoudnessTap } from '../../mixer/MixerEngine';
import { useSampleRecorder } from './useSampleRecorder';
import { sourceColor } from './PadGrid';
import { LoudnessPopup } from '../../mixer/LoudnessPopup';

const isWeb = (import.meta as any).env?.MODE === 'web';
const SNAPSHOT_KEY = 'terminator_session_snapshot';
const SCREEN_GREEN_KEY = 'terminator.screenGreen';
// Same global the classic view uses — the Electron preload OR the web shim
// (ipc-browser.ts, installed eagerly on import) both populate window.terminator.
const ipc = (window as any).terminator as any;

type Tab = 'load' | 'wave' | 'seq' | 'mixer';
type Playlist = { name: string; entries: Array<{ id: string; title: string; duration?: number }> };

const PAD_BANKS = 4;       // 4 banks × 16 = 64 pads (engine supports more)
const PADS_PER_BANK = 16;

// ── LIVE mode (finger-drum pads in the PAD section) ─────────────────────────
// When engaged, the 16-pad chop grid is replaced by a 2×2 grid of 4 big pads
// that trigger DRUM sounds with note-repeat + timing offset and record into the
// drum step grid while the sequencer plays. The chop grid is untouched when off.
type RepeatInterval = '1/4' | '1/8' | '1/16' | '1/32' | '1/64' | '1/128';
const REPEAT_INTERVALS: RepeatInterval[] = ['1/4', '1/8', '1/16', '1/32', '1/64', '1/128'];
interface LivePadConfig {
  trackIndices: number[];   // which drum tracks this pad triggers
  repeatInterval: RepeatInterval | null;  // null = note repeat OFF (no rate selected)
  triplet: boolean;
  offsetMs: number;         // -50 to +50, default 0
}
/** Note-repeat period in ms for a rate at `bpm`. 1/16 @120 = 125ms; triplet ×2/3. */
function repeatIntervalMs(interval: string, triplet: boolean, bpm: number): number {
  const denom = parseInt(interval.replace('1/', ''));
  const straight = (60000 / bpm) * (4 / denom);
  return triplet ? straight * (2 / 3) : straight;
}

// Drag-to-change pitch knob (LOAD screen). Up = pitch up, down = down; rotates
// the indicator dot ±150°. Double-tap resets to 0.
function PitchKnob({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  const drag = useRef<{ startY: number; startVal: number } | null>(null);
  // Floating value popup, shown only while dragging the knob.
  const [pitchDragging, setPitchDragging] = useState(false);
  const deg = (value / 24) * 150;
  return (
    <div className="hw-pitch-wrap">
      <div className="hw-pitch-knob" style={{ touchAction: 'none' }}
        onPointerDown={e => { e.currentTarget.setPointerCapture(e.pointerId); drag.current = { startY: e.clientY, startVal: value }; setPitchDragging(true); }}
        onPointerMove={e => { if (!drag.current) return; const d = (drag.current.startY - e.clientY) * 0.25; onChange(Math.max(-24, Math.min(24, Math.round(drag.current.startVal + d)))); }}
        onPointerUp={() => { drag.current = null; setPitchDragging(false); }}
        onPointerCancel={() => { drag.current = null; setPitchDragging(false); }}
        onDoubleClick={() => onChange(0)}>
        {pitchDragging && (
          <div className="hw-pitch-popup">{value > 0 ? `+${value}` : value} st</div>
        )}
        <div className="hw-pitch-dot" style={{ transform: `rotate(${deg}deg)` }} />
      </div>
      <span className="hw-pitch-val">{value > 0 ? '+' : ''}{value} st</span>
    </div>
  );
}

// Master meter (MIXER screen). rAF-driven; writes the bar width + readouts
// directly to the DOM so it never re-renders React. PEAK comes off the engine's
// analyser; M / S / I / TP come from a LoudnessTap (the same BS.1770-4 worklet
// the desktop DAW mixer runs) hung on the engine's post-limiter output. Tap the
// LUFS row → the full LoudnessPopup (LRA, PLR, phase, spectrum) — the same
// popup the desktop opens from its master strip.
function PeakMeter({ engine, tap, onOpen }: { engine: ChopperEngine; tap: LoudnessTap; onOpen: () => void }) {
  const fillRef = useRef<HTMLDivElement>(null);
  const valRef = useRef<HTMLSpanElement>(null);
  const lufsRefs = useRef<Record<'m' | 's' | 'i' | 'tp', HTMLSpanElement | null>>({ m: null, s: null, i: null, tp: null });
  useEffect(() => {
    let raf = 0;
    const fmt = (v: number) => (Number.isFinite(v) ? v.toFixed(1) : '−∞');
    const setTxt = (el: HTMLElement | null, v: string) => { if (el && el.textContent !== v) el.textContent = v; };
    const tick = () => {
      const p = engine.getPeakLevel?.() ?? 0;
      if (fillRef.current) fillRef.current.style.width = `${Math.min(100, p * 100)}%`;
      if (valRef.current) {
        const db = p > 0 ? 20 * Math.log10(p) : -60;
        valRef.current.textContent = db <= -60 ? '-∞' : `${db >= 0 ? '+' : ''}${db.toFixed(0)} dB`;
      }
      const lu = tap.updateLoudness();
      const r = lufsRefs.current;
      setTxt(r.m, fmt(lu.m)); setTxt(r.s, fmt(lu.s)); setTxt(r.i, fmt(lu.i));
      const tp = lu.holdTp > 0 ? 20 * Math.log10(lu.holdTp) : -Infinity;
      setTxt(r.tp, Number.isFinite(tp) ? `${tp > 0 ? '+' : ''}${tp.toFixed(1)}` : '−∞');
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [engine, tap]);
  return (
    <>
      <div className="hw-vu">
        <div className="hw-vu-fill" ref={fillRef} />
        <span className="hw-vu-lbl">PEAK</span>
        <span className="hw-vu-val" ref={valRef}>-∞</span>
      </div>
      <div className="hw-lufs" role="button" tabIndex={0} onClick={onOpen}
        onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(); } }}
        title="LOUDNESS (BS.1770-4): M = momentary, S = short-term, I = integrated since reset, TP = true peak. Tap for the full readout — LRA, PLR, phase, and a spectrum analyzer for your balance">
        <span className="hw-lufs-k">M</span><span className="hw-lufs-v" ref={el => { lufsRefs.current.m = el; }}>−∞</span>
        <span className="hw-lufs-k">S</span><span className="hw-lufs-v" ref={el => { lufsRefs.current.s = el; }}>−∞</span>
        <span className="hw-lufs-k">I</span><span className="hw-lufs-v" ref={el => { lufsRefs.current.i = el; }}>−∞</span>
        <span className="hw-lufs-k">TP</span><span className="hw-lufs-v hw-lufs-tp" ref={el => { lufsRefs.current.tp = el; }}>−∞</span>
        <span className="hw-lufs-unit">LUFS · dBTP ›</span>
      </div>
    </>
  );
}

// Pointer-capture fader. Native <input type=range> is unreliable to DRAG inside
// the KCC iframe on iOS (scroll-hijack → white screen) — the whole app moved off
// native ranges for this reason. setPointerCapture works everywhere.
function HwFader({ value, min, max, step, vertical, onChange, className, title }: {
  title?: string;
  value: number; min: number; max: number; step?: number; vertical?: boolean;
  onChange: (v: number) => void; className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  const set = (clientX: number, clientY: number) => {
    const el = ref.current; if (!el) return;
    const r = el.getBoundingClientRect();
    let frac = vertical ? 1 - (clientY - r.top) / r.height : (clientX - r.left) / r.width;
    frac = Math.max(0, Math.min(1, frac));
    let v = min + frac * (max - min);
    if (step) v = Math.round(v / step) * step;
    onChange(Math.max(min, Math.min(max, v)));
  };
  const fillPct = ((value - min) / (max - min)) * 100;
  return (
    <div ref={ref} className={className} style={{ touchAction: 'none' }} title={title}
      onPointerDown={e => { dragging.current = true; e.currentTarget.setPointerCapture?.(e.pointerId); set(e.clientX, e.clientY); }}
      onPointerMove={e => { if (dragging.current) set(e.clientX, e.clientY); }}
      onPointerUp={() => { dragging.current = false; }}
      onPointerCancel={() => { dragging.current = false; }}>
      <div className="hw-fader-fill" style={vertical ? { height: `${fillPct}%` } : { width: `${fillPct}%` }} />
    </div>
  );
}

export function HardwareView() {
  // ── Engines (own instances — classic ChopperView never mounts under ?v2) ────
  const engineRef = useRef<ChopperEngine | null>(null);
  if (!engineRef.current) engineRef.current = new ChopperEngine();
  const engine = engineRef.current!;
  // Same DEV probe ChopperView exposes — headless testing of the phone layout.
  if (import.meta.env.DEV) (window as any).__chopper = engine;

  // Loudness meter for the MIXER screen — a listener on the post-limiter master
  // (no output; nothing about the sound changes). Feeds the M/S/I/TP row and
  // the LoudnessPopup.
  const loudTapRef = useRef<LoudnessTap | null>(null);
  if (!loudTapRef.current) {
    loudTapRef.current = new LoudnessTap(engine.ctx);
    engine.outputNode.connect(loudTapRef.current.input);
  }
  const loudTap = loudTapRef.current!;
  const [loudOpen, setLoudOpen] = useState(false);

  const drumEngineRef = useRef<DrumEngine | null>(null);
  if (!drumEngineRef.current) {
    drumEngineRef.current = new DrumEngine(engine.ctx, engine.drumBusInput, () => engine.getMasterBpm(), () => engine.getInputQuantize());
    // Unified undo: drum state rides in every chop snapshot, and drum edits push
    // into the same stack (so the undo/redo buttons cover both engines).
    engine.attachDrumEngine(drumEngineRef.current);
    drumEngineRef.current.setHistorySink({
      record: g => engine.recordHistory(g),
      dropLast: () => engine.dropLastHistory(),
    });
  }
  const drumEngine = drumEngineRef.current!;
  // BASS engine (Model-D-style synth + piano roll). On mobile there is no DAW
  // mixer, so — like the drums — it sums straight into the chopper's pad bus and
  // wears the master chain. Same instance shape as the desktop view.
  const bassEngineRef = useRef<BassEngine | null>(null);
  if (!bassEngineRef.current) {
    bassEngineRef.current = new BassEngine(engine.ctx, () => engine.getMasterBpm());
    bassEngineRef.current.outputNode.connect(engine.drumBusInput);
  }
  const bassEngine = bassEngineRef.current!;

  const arrangerRef = useRef<ArrangerPreview | null>(null);
  if (!arrangerRef.current) arrangerRef.current = new ArrangerPreview(engine, drumEngine, bassEngine);
  const arranger = arrangerRef.current!;

  // ── State ───────────────────────────────────────────────────────────────────
  const [state, setState] = useState<ChopperState>(() => engine.getState());
  const [drumState, setDrumState] = useState(() => drumEngine.getState());
  const [tab, setTab] = useState<Tab>('load');
  const [seqType, setSeqType] = useState<'chop' | 'drum' | 'bass'>('chop');
  // BASS MIDI IN mirror for the mount-once MIDI listener + pad handlers.
  const bassMidiRef = useRef(false);
  // Theme / palette menu (the desktop ThemeMenu in its mobile variant).
  const [themeMenuRect, setThemeMenuRect] = useState<DOMRect | null>(null);

  // ── Help + tooltips (Help.tsx, shared with the classic view) ──────────────
  // This layout is the one phones get, and a phone has no hover — so the help
  // menu IS the manual here, and it gets a permanent home in the chassis rather
  // than a corner of a desktop toolbar. The tooltip layer is still mounted: a
  // desktop can force this layout with ?hardware, and it no-ops on touch.
  const [helpOpen, setHelpOpen] = useState(false);
  const [tips, setTips] = useState(readTipsEnabled);
  const changeTips = (on: boolean) => { setTips(on); writeTipsEnabled(on); };

  // Landscape layout (mobile rotate) — a separate tab set (LOAD · SEQ · DRUMS ·
  // MIXER) plus a content/transport reflow. Portrait state (`tab`) is left 100%
  // untouched; `lsTab` drives the landscape branch ONLY. `spectralFullscreen` =
  // the LED visualizer expanded to a full-screen overlay (landscape only).
  const [isLandscape, setIsLandscape] = useState(
    () => typeof window !== 'undefined' && window.innerWidth > window.innerHeight,
  );
  const [spectralFullscreen, setSpectralFullscreen] = useState(false);
  const [lsTab, setLsTab] = useState<'load' | 'seq' | 'drums' | 'bass' | 'mixer'>('load');

  const [viewStart, setViewStart] = useState(0);
  const [viewEnd, setViewEnd] = useState(1);
  const viewRef = useRef({ viewStart: 0, viewEnd: 1 });
  viewRef.current = { viewStart, viewEnd };
  const userZoomedRef = useRef(false);

  const [playlists, setPlaylists] = useState<Playlist[]>([]);
  const [selectedPlaylist, setSelectedPlaylist] = useState('');
  const [currentVideoId, setCurrentVideoId] = useState<string | null>(null);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);
  // Persistent (non-fading) error — upload/decode failures stay here until the
  // user dismisses them or starts loading another file. (flash/statusMsg fades
  // after 4s, which is too fast to read a decode error.)
  const [error, setError] = useState<string | null>(null);

  // TAP-tempo via pads: when armed, each pad hit feeds a BPM-from-intervals
  // calculator (the sample still plays so you can tap along). A 2s idle clears
  // the tap buffer but leaves the mode armed; tapping TAP again disarms + clears.
  // Ported from the classic ChopperView tap-tempo.
  const [tapTempoPadMode, setTapTempoPadMode] = useState(false);
  const tapArmedRef = useRef(false); tapArmedRef.current = tapTempoPadMode;
  const tapTimesRef = useRef<number[]>([]);
  const tapResetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [tapFlash, setTapFlash] = useState(false);          // brief brighten on each counted tap
  const tapFlashTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
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
      const tapBpm = Math.round(60000 / avg);
      engine.setMetronomeBpm(Math.max(20, Math.min(300, tapBpm)));
    }
    setTapFlash(true);
    if (tapFlashTimerRef.current) clearTimeout(tapFlashTimerRef.current);
    tapFlashTimerRef.current = setTimeout(() => setTapFlash(false), 140);
    if (tapResetTimerRef.current) clearTimeout(tapResetTimerRef.current);
    tapResetTimerRef.current = setTimeout(() => { tapTimesRef.current = []; }, 2000);
  };
  useEffect(() => () => {
    if (tapResetTimerRef.current) clearTimeout(tapResetTimerRef.current);
    if (tapFlashTimerRef.current) clearTimeout(tapFlashTimerRef.current);
  }, []);

  const [presetName, setPresetName] = useState('');
  const [namedPresets, setNamedPresets] = useState<Array<{ id?: string; name: string; trackTitle?: string; savedAt: string; videoId: string; data?: ChopPreset }>>([]);
  const [pendingPreset, setPendingPreset] = useState<{ data: ChopPreset; fileName: string; presetName: string } | null>(null);
  // SAVE / SAVE AS editing-state — mirrors ChopperView so the preset blob is one
  // canonical JSON shared across desktop + mobile. loadedPresetId = the row being
  // edited (null = fresh); confirmSave drives the inline "overwrite?" prompt.
  const [loadedPresetId, setLoadedPresetId] = useState<string | null>(null);
  const [confirmSave, setConfirmSave] = useState<{ name: string; existingId?: string } | null>(null);
  const [saving, setSaving] = useState(false); // in-flight guard — blocks double-click duplicate inserts
  // HardwareView has NO DAW Mixer (desktop-only), but a preset is one canonical
  // blob. Stash any mixer state that rides in on load and re-attach it on save so
  // a desktop-authored mix survives a round-trip through mobile (lossless).
  const lastMixerRef = useRef<ChopPreset['mixer']>(undefined);

  const [subModalOpen, setSubModalOpen] = useState(false);
  // DEMO (the site's /terminator/download embed, ?demo=1): the machine is
  // PLAYABLE — all 16 pads and both sequencers (CHOP SEQ + DRUM SEQ, and the
  // BASS that shares their screen) — but nothing leaves it: save, record,
  // load-your-own-file, export and the Beat Finisher stay pro. That is the
  // contract the desktop layout has always honoured (body.tt-locked.tt-demo in
  // terminator.css re-opens .tt-gated-seq / -drums / -bass); this layout simply
  // never read the flag, so a phone on the download page got the 3-pad free
  // tier instead of the demo.
  const demo = isDemo();
  /** Demo → swallow the action and sell instead. Mirrors ChopperView's. */
  const demoBlock = (): boolean => { if (!demo) return false; setSubModalOpen(true); return true; };
  // RECORD SAMPLE (LOAD screen ● REC): the phone's mic / a plugged-in input →
  // WAV → straight into the waveform, kept with the project via the asset store.
  // A pad menu can aim the recorder / the file picker at a pad (RECORD INTO
  // PAD / LOAD FILE onto this pad): the take or the file lands there as its
  // own SOURCE instead of the main track.
  const recPadTargetRef = useRef<number | null>(null);
  const filePadTargetRef = useRef<number | null>(null);
  const recorder = useSampleRecorder({
    // The take lands on a PAD — the one RECORD INTO aimed at, else the next
    // empty pad (the desktop's rule since b560e05: "whenever I record a new
    // sample it should load onto the next empty pad"). Never the main track.
    onTake: f => {
      let t = recPadTargetRef.current; recPadTargetRef.current = null;
      if (t === null) { t = 0; while (engine.padSourceKey(t)) t++; }
      return loadAudioFile(f, t);
    },
    onError: m => { recPadTargetRef.current = null; setError(m); },
  });
  const onRecClick = () => {
    if (recorder.state === 'recording') { recorder.stop(); return; }
    if (recorder.state !== 'idle') return;
    if (!isSubscribed()) { setSubModalOpen(true); return; }
    void recorder.start();
  };
  // Free tier on the phone: SEQ / DRUMS / BASS / MIXER / SAVE are pro, exactly
  // as the desktop layout greys them (tt-gated). A tab tap on the free tier
  // opens the purchase popup instead of switching — cleaner on a phone than a
  // greyed full-screen panel. isSubscribed() is read at tap time so a sign-in
  // mid-session unlocks without a reload.
  // In the demo those three playable ones open up — the same three the desktop
  // CSS re-opens. MIXER stays pro there, as does every path that saves/exports.
  const proTab = (t: string) =>
    (t === 'seq' || t === 'drums' || t === 'bass' || t === 'mixer')
    && !(demo && (t === 'seq' || t === 'drums' || t === 'bass'));
  const gateTab = (t: string): boolean => {
    if (!proTab(t) || isSubscribed()) return true;
    setSubModalOpen(true);
    return false;
  };
  const [sampleBrowserOpen, setSampleBrowserOpen] = useState(false);
  const sampleBrowserOpenRef = useRef(false);
  sampleBrowserOpenRef.current = sampleBrowserOpen;

  const [midiInputs, setMidiInputs] = useState<string[]>([]);
  const [masterClip, setMasterClip] = useState(0);
  const [exportBusy, setExportBusy] = useState(false);

  // ── Palette themes (mobile-only; see hwPalettes.ts) ─────────────────────────
  // paletteOn DEFAULT true → Linen is the default look. The original green
  // hardware look is the OFF fallback — toggling this off removes the
  // data-palette attribute + --hw-* vars so everything reverts to green/navy.
  const [paletteOn, setPaletteOn] = useState(getStoredPaletteOn);
  const [paletteId, setPaletteId] = useState(getStoredPaletteId);
  // 4K MODE (hwPalettes.ts): the mobile finish axis — data-finish="4k" on the
  // machine roots turns the flat chassis into the milled material, whatever
  // palette (or phosphor) is on. Its own switch in the theme menu.
  const [hwFinish, setHwFinish] = useState<HwFinish>(getStoredHwFinish);
  useEffect(() => { persistHwFinish(hwFinish); }, [hwFinish]);
  useEffect(() => { persistPaletteOn(paletteOn); }, [paletteOn]);
  useEffect(() => { persistPaletteId(paletteId); }, [paletteId]);
  const activePalette = useMemo(() => paletteById(paletteId), [paletteId]);
  // The 8 palette CSS vars for the active palette. Reused for the .hw-machine
  // roots AND mirrored onto <body> (effect below) so the popup windows that
  // portal to <body> (Drum Browser) or render as siblings of .hw-machine in the
  // landscape branch (Sample Browser, Beat Finisher) can read them.
  const paletteVars = useMemo<Record<string, string>>(() => ({
    '--hw-bg': activePalette.bg,
    '--hw-panel': activePalette.panel,
    '--hw-pad': activePalette.pad,
    '--hw-text': activePalette.text,
    '--hw-accent': activePalette.accent,
    '--hw-border': activePalette.border,
    '--hw-muted': activePalette.muted,
    '--hw-faint': activePalette.faint,
  }), [activePalette]);
  // Screen-green override (mobile-only) — INDEPENDENT of paletteOn/paletteId.
  // Reverts ONLY the .hw-disp display screen to the original phosphor green,
  // leaving the chassis / pads / tabs / transport / drum section in the active
  // palette. Persisted separately; never mutates the palette state.
  const [screenGreen, setScreenGreen] = useState<boolean>(() => {
    try { return localStorage.getItem(SCREEN_GREEN_KEY) === '1'; } catch { return false; }
  });
  useEffect(() => { try { localStorage.setItem(SCREEN_GREEN_KEY, screenGreen ? '1' : '0'); } catch { /* */ } }, [screenGreen]);
  // Spread onto BOTH .hw-machine roots (portrait + landscape). When paletteOn is
  // OFF there's no data-palette + no --hw-* vars → the existing green/navy look
  // renders unchanged (every themed CSS color is var(--hw-role, <original>)).
  // data-screen-green is added independently (works green-on-green too).
  const paletteRootProps: { 'data-palette'?: string; 'data-screen-green'?: string; 'data-finish'?: string; style?: React.CSSProperties } = {
    ...(paletteOn
      ? { 'data-palette': activePalette.id, style: paletteVars as React.CSSProperties }
      : {}),
    ...(screenGreen ? { 'data-screen-green': '' } : {}),
    ...(hwFinish === '4k' ? { 'data-finish': '4k' } : {}),
  };
  // Mirror the palette vars + a `data-hw-palette` marker onto <body> so the popup
  // windows can read them everywhere: the Drum Browser portals to <body>, and in
  // the LANDSCAPE branch the Sample Browser + Beat Finisher render as siblings of
  // .hw-machine (so .hw-machine-scoped vars don't reach them). Their palette CSS
  // is keyed on body[data-hw-palette]. Removed on paletteOff / unmount → the
  // original look returns (desktop ChopperView never sets these).
  useEffect(() => {
    const b = document.body;
    const apply = () => {
      if (paletteOn) {
        for (const [k, v] of Object.entries(paletteVars)) b.style.setProperty(k, v);
        b.setAttribute('data-hw-palette', activePalette.id);
      } else { clear(); }
    };
    const clear = () => {
      for (const k of Object.keys(paletteVars)) b.style.removeProperty(k);
      b.removeAttribute('data-hw-palette');
    };
    apply();
    return clear;
  }, [paletteOn, paletteVars, activePalette]);
  // The theme menu (TERMINATOR logo / ◐ tab): pick a palette, PHOSPHOR (the
  // original green look = palette off), or the UI layout. No hover on a phone,
  // so preview == lock.
  const themeMenu = themeMenuRect ? (
    <ThemeMenu mobile anchor={themeMenuRect}
      lockedKind="minimal" lockedId={paletteOn ? paletteId : 'phosphor'}
      finish={hwFinish} finishForced={false} onFinish={(f) => setHwFinish(f)} dust={false} onDust={() => {}}
      onPreview={(_k, id) => { if (id === 'phosphor') setPaletteOn(false); else { setPaletteId(id); setPaletteOn(true); } }}
      onPreviewEnd={() => {}}
      onLock={(_k, id) => { if (id === 'phosphor') setPaletteOn(false); else { setPaletteId(id); setPaletteOn(true); } setThemeMenuRect(null); }}
      onClose={() => setThemeMenuRect(null)}
      uiMode={getUiMode()} onUiMode={(m) => { switchUiMode(m); }} />
  ) : null;
  // LED spectrum colours follow the active palette (accent = lit/peak, faint =
  // unlit, no glow). When screenGreen is ON (or the palette is off) → the
  // original green/amber/dim-green + glow, so the screen reads as one coherent
  // phosphor display. Stored in a ref so the [] -deps animation loop reads the
  // latest without restarting.
  // NOTE: the screen-green CSS override is .hw-disp-scoped, and .hw-disp exists
  // ONLY in the portrait layout — so the LED green-flip is gated on !isLandscape
  // too. That keeps landscape fully palette (the LEDs never flip green where the
  // chrome can't, avoiding a half-applied look). `!paletteOn` still greens the
  // LEDs in BOTH orientations, matching the base green chassis.
  const specColorsRef = useRef({ lit: '#35ff69', peak: '#ffaa00', unlit: '#0a1f0a', glow: true });
  useEffect(() => {
    specColorsRef.current = ((screenGreen && !isLandscape) || !paletteOn)
      ? { lit: '#35ff69', peak: '#ffaa00', unlit: '#0a1f0a', glow: true }
      : { lit: activePalette.accent, peak: activePalette.accent, unlit: activePalette.faint, glow: false };
  }, [paletteOn, screenGreen, isLandscape, activePalette]);

  // Custom hardware pad grid: bank paging + per-pad menu (copy/paste/dup/move).
  const [padBank, setPadBank] = useState(0);
  const [padMenu, setPadMenu] = useState<number | null>(null);
  // DRAG OUT: one prepared file per open menu; rendering happens when the menu opens so the drag is one call.
  const dragOutRef = useRef(new PadDragOut());
  const [moveSource, setMoveSource] = useState<number | null>(null);
  // Clipboard is STATE (not a ref) so Paste can grey out reactively when empty.
  // An ARRAY to match the desktop's shape — the phone only ever cuts/copies one
  // pad (no shift-click on a touchscreen), but the ops are the same.
  const [padClipboard, setPadClipboard] = useState<PadContent[] | null>(null);

  // ── Pad SURFACE ───────────────────────────────────────────────────────────
  // What the pad grid IS right now. One button cycles it:
  //   chops (the sample pads, button says DRUMS)
  //   → drums (LIVE finger-drum 2×2, button says BASS)
  //   → bass  (16 pads playing the BASS module folded to its key/scale,
  //            button says CHOPS)
  //   → chops again.
  // 'drums' is the old boolean LIVE mode — `liveMode` stays as a derived const
  // so all its plumbing (note repeat, REC routing, the 2×2 grid) is untouched.
  const [padSurface, setPadSurface] = useState<'chops' | 'drums' | 'bass'>('chops');
  const padSurfaceRef = useRef(padSurface); padSurfaceRef.current = padSurface;
  const liveMode = padSurface === 'drums';
  // Bass state (key, scale, recording) drives the bass grid's labels + the
  // KEY/SCALE selectors in the pads header.
  const [bassState, setBassState] = useState(() => bassEngine.getState());
  useEffect(() => bassEngine.subscribe(setBassState), [bassEngine]);
  // Held bass pads — visual only (the engine remembers the note per pad).
  const [bassHeld, setBassHeld] = useState<ReadonlySet<number>>(new Set());
  const [livePads, setLivePads] = useState<LivePadConfig[]>([
    { trackIndices: [0], repeatInterval: null, triplet: false, offsetMs: 0 },
    { trackIndices: [1], repeatInterval: null, triplet: false, offsetMs: 0 },
    { trackIndices: [2], repeatInterval: null, triplet: false, offsetMs: 0 },
    { trackIndices: [3], repeatInterval: null, triplet: false, offsetMs: 0 },
  ]);
  const [activePadMenu, setActivePadMenu] = useState<number | null>(null);
  const [activeMenuTab, setActiveMenuTab] = useState<'FILL' | 'LOAD' | 'REPEAT' | 'OFFSET'>('FILL');
  // Self-rescheduling note-repeat timers (one per pad; null = not held).
  const repeatTimersRef = useRef<(ReturnType<typeof setTimeout> | null)[]>([null, null, null, null]);
  const livePadsRef = useRef(livePads);
  livePadsRef.current = livePads;             // latest config for timer callbacks
  const offsetDragRef = useRef<{ startY: number; startVal: number } | null>(null);
  // LIVE LOAD reuses the same DrumBrowser + engine bridge DrumSection uses, so
  // committing a sound permanently changes that drum track in the sequencer.
  const liveDrumSamples = useMemo<DrumSample[]>(() => drumEngine.browserManifest(), [drumEngine]);
  const [liveBrowser, setLiveBrowser] = useState<{ track: TrackKey; themeColor: string } | null>(null);
  type LiveLoaded = { kit: string; id: string } | null;
  const liveBaseRef = useRef<Partial<Record<TrackKey, LiveLoaded>>>({});
  const [liveBase, setLiveBase] = useState<Partial<Record<TrackKey, LiveLoaded>>>({});
  const setLiveBaseBoth = (m: Partial<Record<TrackKey, LiveLoaded>>) => { liveBaseRef.current = m; setLiveBase(m); };
  // LIVE recording armed (REC → precount → arm). A ref drives the firePad gate
  // (read live inside the repeat timer); the state drives the REC button glow.
  const liveRecArmedRef = useRef(false);
  const [liveRecArmed, setLiveRecArmedState] = useState(false);
  // Mirror the arm into the engine as well: recordLiveHit now gates on the
  // engine's own liveRecording flag (so the desktop REC button can punch out
  // without stopping the transport), and this local ref is mobile's only arm
  // signal. Kept as the single choke point so every existing call site —
  // toggleLiveMode, armDrumRec, onLiveRec, the stopped-transport cleanup —
  // stays in sync for free. Both engine calls self-guard on repeat.
  const setLiveRecArmed = (v: boolean) => {
    liveRecArmedRef.current = v;
    setLiveRecArmedState(v);
    if (v) drumEngine.startLiveRec(); else drumEngine.stopLiveRec();
  };
  // SAMPLE (chop) volume — local mirror: engine.setChopVolume doesn't emit, so
  // without this the fader fill would never re-render on drag.
  const [sampleVol, setSampleVol] = useState(() => engine.getChopVolume?.() ?? 1);
  // Resizable display height (drag handle at its bottom edge). Mobile / full-screen
  // layouts get a slightly taller default so the LOAD screen's full content (down to
  // the LOAD PRESET + DEL PRESET rows) fits with the display's bottom edge sitting
  // snug just below the preset buttons — 262 clipped the DEL PRESET row, 272 clears
  // it with only a small margin so the screen ends close to the buttons (Victor's
  // preferred look). The DESKTOP device-frame (≥600px landscape, fixed 860px chassis)
  // keeps 262 so its pad area is unchanged — this is a mobile-only tweak.
  const [displayHeight, setDisplayHeight] = useState(() =>
    typeof window !== 'undefined' &&
    window.matchMedia('(min-width: 600px) and (orientation: landscape)').matches
      ? 262
      : 272,
  );
  const resizeDrag = useRef<{ startY: number; startH: number } | null>(null);

  // Beat Finisher (FINISH HIM portal). No intro-video gating in this layout —
  // the button opens the portal directly.
  const [finishHimOpen, setFinishHimOpen] = useState(false);
  const finishHimOpenRef = useRef(false);
  finishHimOpenRef.current = finishHimOpen;
  const finishHimSavedRef = useRef<FinishArrangementSection[] | null>(null);
  const [finishHimPreviewing, setFinishHimPreviewing] = useState(false);
  const [finishHimSeekBeat, setFinishHimSeekBeat] = useState(0);

  const fhPhone = useIsPhone();
  const fileInputRef = useRef<HTMLInputElement>(null);

  // ── Spectrum analyser (segmented LED bar meter on the LOAD tab) ─────────────
  const specCanvasRef = useRef<HTMLCanvasElement | null>(null);
  // Second canvas for the full-screen LED visualizer overlay (landscape only).
  // Painted by the SAME draw loop as specCanvasRef.
  const specFsCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const rafRef = useRef<number | null>(null);

  const padLockFrom = isSubscribed() || demo ? null : FREE_PAD_LIMIT;
  // Per-hit pad activity rides its own channel — triggering a pad no longer
  // pushes a whole new ChopperState (see usePadActivity), so these three must
  // come from here rather than from `state`.
  const activity = usePadActivity(engine);
  const activePads = activity?.activePads ?? state.activePads;
  const lastTriggeredPad = activity?.lastTriggeredPad ?? state.lastTriggeredPad;
  const isPlaying = activity?.playing ?? (state.playbackPos >= 0);
  const transportPlaying = state.seqPlaying || drumState.playing;

  // ── Subscriptions / lifecycle ───────────────────────────────────────────────
  useEffect(() => engine.subscribe(setState), [engine]);
  useEffect(() => drumEngine.subscribe(setDrumState), [drumEngine]);
  useEffect(() => () => arranger.stop(), []);
  useEffect(() => { engine.setPadLock(padLockFrom); }, [engine, padLockFrom]);
  useEffect(() => () => { loudTap.dispose(); engine.dispose(); }, [engine, loudTap]);
  // Terminator 3.0: the pads sound through the native C++ engine (no-op in Electron / the browser)
  useEffect(() => attachNativeEngineShadow(engine, drumEngine, bassEngine), [engine, drumEngine, bassEngine]);

  // Tap the master output with an AnalyserNode for the LED spectrum display.
  // Listen-only: never connect the analyser onward to the destination (that
  // would double the audio output). One node, torn down with the view.
  useEffect(() => {
    const analyser = engine.ctx.createAnalyser();
    analyser.fftSize = 256;                 // 128 frequency bins
    analyser.smoothingTimeConstant = 0.8;
    engine.outputNode.connect(analyser);
    analyserRef.current = analyser;
    return () => {
      try { engine.outputNode.disconnect(analyser); } catch { /* already torn down */ }
      analyser.disconnect();
      analyserRef.current = null;
    };
  }, [engine]);

  // Segmented-LED bar animation. When nothing is playing, getByteFrequencyData
  // returns all zeros → every segment stays dark (no fake idle animation). The
  // LOAD canvas (specCanvasRef) and/or the full-screen overlay canvas
  // (specFsCanvasRef) are painted each frame from the SAME analyser data; a null
  // ref (canvas unmounted) is skipped, so draw() no-ops when neither is on screen.
  useEffect(() => {
    const SEGMENT_H = 4;    // px per LED segment
    const SEGMENT_GAP = 1;  // px gap between segments
    const GAP = 1;          // px gap between bars
    let data: Uint8Array<ArrayBuffer> | null = null;

    const paint = (canvas: HTMLCanvasElement, numBars: number) => {
      const ctx2d = canvas.getContext('2d');
      if (!ctx2d || !data) return;
      const sc = specColorsRef.current;   // palette-aware LED colours (accent/faint or green)
      ctx2d.clearRect(0, 0, canvas.width, canvas.height);
      // Proportional bar positions so the last bar always reaches the right
      // edge — integer Math.floor on a fixed bar width left undrawn pixels.
      const totalSegs = Math.floor(canvas.height / (SEGMENT_H + SEGMENT_GAP));
      for (let i = 0; i < numBars; i++) {
        // Map bar → frequency bin with a low-mid bias (pow 1.5, top 75% of bins).
        const bin = Math.floor(Math.pow(i / numBars, 1.5) * (data.length * 0.75));
        const level = data[bin] / 255;          // 0..1
        // Derive width from the NEXT bar's start so the row tiles edge-to-edge.
        const x = Math.round(i * canvas.width / numBars);
        const nextX = Math.round((i + 1) * canvas.width / numBars);
        const barW = nextX - x - GAP;           // last bar ends exactly at canvas.width
        const litSegs = Math.floor(level * totalSegs);
        for (let s = 0; s < totalSegs; s++) {
          const y = canvas.height - (s + 1) * (SEGMENT_H + SEGMENT_GAP);
          const lit = s < litSegs;
          const isTop = s >= totalSegs - 2;     // top 2 segments = amber peak
          if (lit) {
            ctx2d.fillStyle = isTop ? sc.peak : sc.lit;
            if (sc.glow) { ctx2d.shadowColor = isTop ? sc.peak : sc.lit; ctx2d.shadowBlur = 6; }
            else ctx2d.shadowBlur = 0;
          } else {
            ctx2d.fillStyle = sc.unlit;          // dim unlit segment
            ctx2d.shadowBlur = 0;
          }
          ctx2d.fillRect(x, y, barW, SEGMENT_H);
        }
        ctx2d.shadowBlur = 0;
      }
    };

    const draw = () => {
      rafRef.current = requestAnimationFrame(draw);
      const analyser = analyserRef.current;
      if (!analyser) return;
      if (!data || data.length !== analyser.frequencyBinCount) {
        data = new Uint8Array(analyser.frequencyBinCount);
      }
      analyser.getByteFrequencyData(data);
      const small = specCanvasRef.current;
      if (small) paint(small, 28);
      const fs = specFsCanvasRef.current;
      if (fs) {
        // Size the full-screen bitmap to its CSS box (set by the overlay) so the
        // bars stay crisp and fill the screen edge-to-edge; more bars at this size.
        const w = fs.clientWidth, h = fs.clientHeight;
        if (w && h && (fs.width !== w || fs.height !== h)) { fs.width = w; fs.height = h; }
        paint(fs, 48);
      }
    };
    rafRef.current = requestAnimationFrame(draw);
    return () => { if (rafRef.current != null) cancelAnimationFrame(rafRef.current); };
  }, []);

  // Mark <body> so v2-only CSS can hide the App-level CRT scanline + theme
  // overlays (they flash over the opaque hardware chassis) without touching the
  // classic layout.
  useEffect(() => {
    document.body.classList.add('hw-v2');
    // Orientation lock REMOVED — this layout now has a dedicated landscape layout
    // (see the `isLandscape` branch), so the device must be free to rotate.
    // Release any portrait lock a prior session/version may have set.
    (screen.orientation as any)?.unlock?.();
    return () => { document.body.classList.remove('hw-v2'); };
  }, []);

  // Track portrait ↔ landscape so the landscape branch can swap in. Close the
  // full-screen visualizer on rotate-back-to-portrait (it's landscape-only).
  useEffect(() => {
    const update = () => {
      const landscape = window.innerWidth > window.innerHeight;
      setIsLandscape(landscape);
      if (!landscape) setSpectralFullscreen(false);
    };
    window.addEventListener('resize', update);
    window.addEventListener('orientationchange', update);
    return () => {
      window.removeEventListener('resize', update);
      window.removeEventListener('orientationchange', update);
    };
  }, []);

  // Drums follow the chop sequencer's exact ctx anchor (phase-locked).
  useEffect(() => {
    engine.setTransportHooks?.(
      (at: number) => { void drumEngine.start(at); void bassEngine.start(at); },
      (restart: boolean) => { drumEngine.stop({ keepRec: restart }); bassEngine.stop(); },
      (d: number) => { drumEngine.nudge(d); bassEngine.nudge(d); }, // native transport drift (see ChopperView)
    );
  }, [engine, drumEngine, bassEngine]);

  // Every fresh web load starts with a unique kit + groove.
  const didRandomize = useRef(false);
  useEffect(() => {
    if (!isWeb || didRandomize.current) return;
    didRandomize.current = true;
    drumEngine.randomizeAllSamples?.();
    void drumEngine.generate?.('trap');
    // The default-kit randomize + generate above push history; drop them so a
    // fresh session starts with nothing to undo (generate('trap') is synchronous
    // up to its single top-of-method push, so this clears every entry it made).
    engine.clearHistory();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Transport ────────────────────────────────────────────────────────────────
  const startTransport = () => {
    engine.playSeq();
    // Drums ALWAYS run on PLAY, from any tab. When a sample is loaded the
    // seqStartHook started them phase-locked at the seq anchor; this also covers
    // the no-sample case AND any run where the hook didn't deliver. start() is
    // idempotent (its in-flight claim makes a redundant call a no-op).
    void drumEngine.start();
    void bassEngine.start();
  };
  const stopTransport = () => { engine.stopSeq(); drumEngine.stop(); bassEngine.stop(); };
  // Stable handles — the MIDI listener is bound once and would otherwise hold
  // the first render's closures forever.
  const startTransportRef = useRef(startTransport); startTransportRef.current = startTransport;
  const stopTransportRef = useRef(stopTransport); stopTransportRef.current = stopTransport;
  // Full panic STOP — kills the chop sequencer, drums, ringing pad voices, AND
  // any Beat Finisher arrangement preview. (The sample browser stops its own
  // preview on close.)
  const killAllAudio = () => {
    engine.stopSeq();
    drumEngine.stop();
    bassEngine.panic();
    engine.stopAllPads();
    try { arranger.stop(); } catch { /* */ }
    setFinishHimPreviewing(false);
  };

  const flash = (msg: string, ms = 4000) => {
    setStatusMsg(msg);
    setTimeout(() => setStatusMsg(s => (s === msg ? null : s)), ms);
  };
  // The engine's one-line notes (a refused chop-tap says why) — same flash as desktop.
  useEffect(() => { engine.onNote = (m) => flash(m, 2500); return () => { engine.onNote = null; }; }, [engine]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Sample / preset plumbing (ported from ChopperView, web + desktop) ────────
  const gatePull = (): boolean => {
    if (recordPull()) return true;
    setSubModalOpen(true);
    flash('Free tier limit reached. Subscribe for unlimited pulls.');
    return false;
  };

  const resolveAudio = async (res: { audio?: ArrayBuffer; cacheUrl?: string }): Promise<ArrayBuffer> => {
    if (res.cacheUrl) {
      const r = await fetch(res.cacheUrl);
      if (!r.ok) throw new Error(`Cache fetch failed: ${r.status}`);
      return r.arrayBuffer();
    }
    if (res.audio) return res.audio;
    throw new Error('No audio data in response');
  };

  const fetchTrackData = async (idOrUrl: string, fallbackTitle?: string): Promise<{ ok: boolean; audio?: ArrayBuffer; cacheUrl?: string; title?: string; videoId?: string; error?: string }> => {
    // Your own sample from this device's ASSET STORE (projectAssets.ts).
    if (idOrUrl.startsWith(ASSET_PREFIX)) {
      const a = await assetStore.get(assetHash(idOrUrl));
      if (!a) return { ok: false, error: `This project's sample "${fallbackTitle ?? idOrUrl.slice(6, 14)}" isn't on this device — LOAD FILE it here, or transfer the project from the device that has it` };
      return { ok: true, audio: a.data.slice(0), title: fallbackTitle ?? a.name.replace(/\.[^.]+$/, ''), videoId: idOrUrl };
    }
    if (idOrUrl.startsWith('local:')) {
      const url = idOrUrl.slice('local:'.length);
      const r = await fetch(url);
      if (!r.ok) return { ok: false, error: `Local fetch failed: ${r.status}` };
      const audio = await r.arrayBuffer();
      return { ok: true, audio, title: fallbackTitle ?? url, videoId: idOrUrl };
    }
    if (!ipc?.downloadYouTube) return { ok: false, error: 'IPC unavailable' };
    return ipc.downloadYouTube(idOrUrl);
  };

  const buildPreset = (videoId: string): ChopPreset => withAssetManifest({
    ...engine.getPresetData(videoId),
    drums: drumEngine.serialize(),
    bass: bassEngine.serialize(),
    // Carry the desktop mixer blob through a mobile save so it isn't lost.
    ...(lastMixerRef.current ? { mixer: lastMixerRef.current } : {}),
  });
  // Pad samples come back too (they were saved but never restored before).
  const restorePadSamples = async (preset: ChopPreset): Promise<void> => {
    const meta = preset.padBufferMeta ?? {};
    let missing = 0;
    for (const k of Object.keys(meta)) {
      const idx = Number(k); const m = (meta as any)[k] as { videoId: string; title?: string; start?: number; end?: number } | undefined;
      if (!Number.isFinite(idx) || !m?.videoId || m.videoId.startsWith('local_')) { if (m?.videoId?.startsWith('local_')) missing++; continue; }
      try {
        const res = await fetchTrackData(m.videoId, m.title);
        if (!res.ok) { missing++; continue; }
        const buf = await engine.decodeAudio(await resolveAudio(res));
        engine.loadPadBuffer(idx, buf, res.videoId ?? m.videoId, m.title ?? res.title ?? 'sample', m.start, m.end);
      } catch { missing++; }
    }
    if (missing) flash(`${missing} pad sample${missing > 1 ? 's' : ''} missing on this device — LOAD FILE them or transfer the project`);
  };
  const applyPreset = (preset: ChopPreset): void => {
    engine.loadPreset(preset);
    void restorePadSamples(preset);
    if (preset.drums) drumEngine.restore(preset.drums);
    if (preset.bass) bassEngine.restore(preset.bass); else bassEngine.reset();
    // Assign UNCONDITIONALLY: a mixer-less preset must CLEAR the stale blob, else a
    // previously-loaded desktop mixer would leak onto this preset's next save.
    lastMixerRef.current = preset.mixer ?? undefined;
    // engine.loadPreset no-ops without a decoded buffer (audio-fail path), so
    // re-apply transport tempo + chop level from the preset here too — otherwise
    // the restored drums would groove at the wrong BPM with no sample to fetch.
    if (typeof preset.metronomeBpm === 'number' && preset.metronomeBpm > 0) engine.setMetronomeBpm(preset.metronomeBpm);
    if (typeof preset.chopVolume === 'number') engine.setChopVolume(preset.chopVolume);
    // engine.setChopVolume / setMasterClip don't drive React state — mirror the
    // mobile SAMPLE + CLIP faders from the PRESET (engine value as fallback) so
    // they show the saved levels even on the null-buffer path.
    setSampleVol(typeof preset.chopVolume === 'number' ? preset.chopVolume : (engine.getChopVolume?.() ?? 1));
    setMasterClip(typeof preset.masterClip === 'number' ? preset.masterClip : (engine.getMasterClip?.() ?? 0));
  };

  const snapshotSessionForExport = (): void => {
    if (!isIOS() || !currentVideoId) return;
    try { localStorage.setItem(SNAPSHOT_KEY, JSON.stringify(buildPreset(currentVideoId))); } catch { /* best effort */ }
  };

  const loadTrackById = async (idOrUrl: string, title?: string, presetOverride?: ChopPreset | null): Promise<void> => {
    // No-sample project (drums + bass only): nothing to fetch — restore the
    // engines and leave the waveform as it is (see ChopperView's twin).
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
        // Audio can't be re-fetched — still restore drums + mixer + FX (they don't
        // need the buffer; engine.loadPreset no-ops without one) so work survives.
        if (presetOverride) { try { applyPreset(presetOverride); } catch { /* */ } }
        setError(res.error ?? 'Download failed');
        return;
      }
      const audio = await resolveAudio(res);
      const displayTitle = res.title ?? title ?? 'untitled';
      await engine.loadFromArrayBuffer(audio, displayTitle);
      setViewStart(0); setViewEnd(1);
      userZoomedRef.current = false;
      const vid = res.videoId ?? idOrUrl;
      setCurrentVideoId(vid);
      setPresetName(displayTitle);
      setLoadedPresetId(null); setConfirmSave(null); // fresh track (named loaders re-set the id after)
      lastMixerRef.current = undefined; // fresh track → drop any prior preset's mixer blob (applyPreset re-sets it if a preset loads)
      let preset = presetOverride !== undefined ? presetOverride : null;
      if (preset === null && ipc?.loadPreset) preset = await ipc.loadPreset(vid);
      if (preset) { applyPreset(preset); flash(`Loaded: ${displayTitle} — preset restored`); }
      else flash(`Loaded: ${displayTitle}`);
    } catch (e: any) {
      if (presetOverride) { try { applyPreset(presetOverride); } catch { /* */ } }
      setError(e?.message ?? String(e));
    } finally {
      engine.setLoading(false);
    }
  };

  const loadRandomFromPlaylist = async () => {
    const pl = playlists.find(p => p.name === selectedPlaylist);
    if (!pl || pl.entries.length === 0) { flash('Playlist is empty — drop a file or pick a list'); return; }
    const pick = pl.entries[Math.floor(Math.random() * pl.entries.length)];
    // PADS ALREADY IN PLAY (his rule 2026-08-22, and his report 2026-08-25 that this layout ignored it): a kit
    // you have started — the main track chopped into pieces, or any pad carrying its own sample — must not be
    // swapped out under you. GET SAMPLE then pulls onto the NEXT EMPTY PAD as that pad's own source. Only a bare
    // main track (one whole-sample pad, nothing else) is still replaced — that is "still looking for the sample".
    // The desktop layout (ChopperView.loadRandomFromPlaylist) has done this since the 22nd; the hardware layout
    // never got it, so it replaced the track while its own tooltip promised a pad.
    const padsInPlay = Object.keys(state.padBufferMeta ?? {}).length > 0 || state.chops.length > 1;
    if (padsInPlay) {
      const padIdx = findNextEmptyPad();
      if (!gatePull()) return;
      setError(null);
      flash(`Pulling sample → PAD ${padIdx + 1}…`);
      engine.setLoading(true);
      try {
        const res = await fetchTrackData(pick.id, pick.title);
        if (!res.ok) { setError(res.error ?? 'Download failed'); return; }
        const buf = await engine.decodeAudio(await resolveAudio(res));
        const title = pick.title ?? res.title ?? 'sample';
        engine.loadPadBuffer(padIdx, buf, res.videoId ?? pick.id, title);
        flash(`PAD ${padIdx + 1}: ${title}`);
      } catch (e: any) {
        setError(e?.message ?? String(e));
      } finally {
        engine.setLoading(false);
      }
      return;
    }
    if (!gatePull()) return;
    setError(null);
    flash('Pulling sample…');
    await loadTrackById(pick.id, pick.title);
  };

  const isAudioFile = (f: File) => f.type.startsWith('audio/') || /\.(mp3|wav|aiff?|flac|ogg|m4a|webm|opus)$/i.test(f.name);
  const MAX_DROP_BYTES = 500 * 1024 * 1024;

  const [transfer, setTransfer] = useState<'send' | 'receive' | null>(null);
  const downloadProjectFile = async () => {
    if (!currentVideoId) { flash('Load a sample first'); return; }
    const name = presetName.trim() || state.trackTitle || 'project';
    const data = buildPreset(currentVideoId);
    try {
      const { deliverFiles } = await import('../lib/download');
      if (projectNeedsBundle(data)) {
        const b = await buildProjectBundle(data);
        await deliverFiles([{ name: `${name}.tprojz`, data: b.bytes, mime: 'application/zip' }]);
        flash(`Project file ready: ${name}.tprojz`);
      } else {
        await deliverFiles([{ name: `${name}.tproj`, data: new TextEncoder().encode(JSON.stringify(data, null, 2)), mime: 'application/json' }]);
        flash(`Project file ready: ${name}.tproj`);
      }
    } catch (e: any) { setError(e?.message ?? 'Could not build the project file'); }
  };
  // Import a project file (bundle or JSON): its samples land in this device's
  // asset store (IndexedDB on the web), then it loads like any project.
  const importProjectBytes = async (bytes: Uint8Array, displayName: string): Promise<void> => {
    try {
      let preset: ChopPreset;
      if (bytes.length > 4 && bytes[0] === 0x50 && bytes[1] === 0x4b) {
        const r = await unpackProjectBundle(bytes);
        preset = r.preset;
        if (r.assets.length) flash(`Imported ${r.assets.length} sample${r.assets.length > 1 ? 's' : ''} with the project`);
      } else preset = JSON.parse(new TextDecoder().decode(bytes));
      const miss = await missingAssets(preset);
      if (miss.length) flash(`Missing on this device: ${miss.map((m) => m.name).join(', ')}`);
      await loadTrackById(preset.videoId, preset.trackTitle, preset);
      setPresetName(preset.name ?? displayName);
    } catch (e: any) { setError(e?.message ?? 'Could not import project'); }
  };
  const loadAudioFile = async (file: File | undefined | null, padIdx?: number) => {
    if (!isSubscribed()) { setSubModalOpen(true); return; }
    if (!file || (!isAudioFile(file) && !looksLikeProjectFile(file.name))) { flash('Pick an audio file (mp3, wav, flac…) or a Terminator project (.tproj / .tprojz)'); return; }
    if (file.size > MAX_DROP_BYTES) { flash(`File too big — max ${MAX_DROP_BYTES / 1024 / 1024} MB`); return; }
    setError(null); // clear any prior decode error — a new file is loading
    const title = file.name.replace(/\.[^.]+$/, '').slice(0, 200);
    engine.setLoading(true);
    try {
      const ab = await file.arrayBuffer();
      if (looksLikeProjectFile(file.name)) { engine.setLoading(false); await importProjectBytes(new Uint8Array(ab), title); return; }
      const pseudoId = await assetStore.put(ab, file.name);
      if (padIdx !== undefined) {
        const buf = await engine.decodeAudio(ab);
        engine.loadPadBuffer(padIdx, buf, pseudoId, title);
        flash(`PAD ${padIdx + 1}: ${title}`);
      } else if (pendingPreset && file.name === pendingPreset.fileName) {
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
        await engine.loadAudioKeepChops(ab, title);
        setCurrentVideoId(pseudoId);
        setPresetName(title);
        setPendingPreset(null);
        flash(`Swapped: ${title} — chops kept`);
      } else {
        await engine.loadFromArrayBuffer(ab, title);
        setViewStart(0); setViewEnd(1);
        userZoomedRef.current = false;
        setCurrentVideoId(pseudoId);
        setPresetName(title);
        setPendingPreset(null);
        // Brand-new sample, fresh session → stop editing the prior preset and drop
        // any inherited desktop mixer so it can't bleed onto this file's next save.
        setLoadedPresetId(null); setConfirmSave(null);
        lastMixerRef.current = undefined;
        flash(`Loaded: ${title}`);
      }
    } catch (err: any) {
      // Persist decode/load failures (sticky banner) — don't auto-fade them.
      setError(err?.message ?? String(err));
    } finally {
      engine.setLoading(false);
    }
  };

  const handleFilePick = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    const t = filePadTargetRef.current; filePadTargetRef.current = null;
    await loadAudioFile(file, t ?? undefined);
  };

  // ── Named presets (web → /api/terminator-presets; desktop → ipc) ─────────────
  const refreshWebPresets = async () => {
    try {
      const r = await fetch('/api/terminator-presets', { credentials: 'same-origin' });
      if (!r.ok) { setNamedPresets([]); return; }
      const rows: any[] = await r.json();
      setNamedPresets(rows.map(row => ({
        id: row.id,
        name: row.name,
        trackTitle: row.pattern?.trackTitle,
        savedAt: row.created_at,
        videoId: row.pattern?.videoId ?? '',
        data: row.pattern as ChopPreset,
      })));
    } catch { /* offline / signed out — leave empty */ }
  };

  // POST a preset payload → parsed JSON on success (a row, OR { needsConfirm,
  // existingId } on a name clash), or null on failure (a flash was shown).
  const postPreset = async (payload: { name: string; data: ChopPreset; id?: string; overwrite?: boolean }) => {
    try {
      const r = await fetch('/api/terminator-presets', {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        // confirmable: this bundle handles the { needsConfirm } overwrite prompt.
        body: JSON.stringify({ ...payload, confirmable: true }),
      });
      if (r.status === 401) { flash('Sign in to save presets'); return null; }
      if (r.status === 403) { flash('Presets are a subscriber feature'); return null; }
      if (!r.ok) { flash('Save failed'); return null; }
      return await r.json();
    } catch { flash('Save failed — check connection'); return null; }
  };
  const afterSaved = async (row: any, name: string, verb: string) => {
    if (row?.id) setLoadedPresetId(row.id);
    await refreshWebPresets();
    flash(currentVideoId?.startsWith('local_') ? `${verb} snapshot: ${name}` : `${verb}: ${name}`);
  };

  const [nameBlink, setNameBlink] = useState(false);
  const blinkNameInput = () => {
    setNameBlink(false);
    setTimeout(() => { setNameBlink(true); setTimeout(() => setNameBlink(false), 1000); }, 0);
  };
  const handleSaveNamedPreset = async () => {
    if (saving) return;                                   // ignore double-clicks mid-save
    if (!isSubscribed()) { setSubModalOpen(true); return; }   // projects are pro (desktop greys the panel)
    // No sample loaded (drums + bass only) needs a NAME: empty → blink red.
    let vid = currentVideoId;
    if (!vid) {
      if (!presetName.trim()) { blinkNameInput(); flash('Name the project first'); return; }
      vid = NO_SAMPLE_ID;
    }
    const name = presetName.trim() || state.trackTitle || 'preset';
    const data = buildPreset(vid);
    setConfirmSave(null);
    setSaving(true);
    try {
      if (isWeb) {
        // SAVE on a loaded preset (name unchanged) → update that row by id; a rename
        // clears loadedPresetId → upsert-by-name (new preset, or prompted overwrite).
        const loadedRow = loadedPresetId ? namedPresets.find(p => p.id === loadedPresetId) : null;
        if (loadedRow && loadedRow.name === name) {
          const row = await postPreset({ id: loadedPresetId!, name, data });
          if (!row) return;
          if (row.needsConfirm) { setConfirmSave({ name, existingId: row.existingId }); return; } // stale id → name clash
          if (row.id) await afterSaved(row, name, 'Preset updated');
          return;
        }
        const res = await postPreset({ name, data });
        if (!res) return;
        if (res.needsConfirm) { setConfirmSave({ name, existingId: res.existingId }); return; }
        await afterSaved(res, name, 'Preset saved');
        return;
      }
      if (!ipc?.saveNamedPreset) return;
      await ipc.saveNamedPreset(name, data);
      setNamedPresets(await ipc.listNamedPresets());
      flash(`Preset saved: ${name}`);
    } finally {
      setSaving(false);
    }
  };

  const confirmOverwriteSave = async () => {
    if (saving) return;
    const cs = confirmSave;
    setConfirmSave(null);
    if (!cs || !currentVideoId) return;
    setSaving(true);
    try {
      const data = buildPreset(currentVideoId);
      const row = await postPreset({ name: cs.name, data, overwrite: true });
      if (row?.id) await afterSaved(row, cs.name, 'Preset overwritten');
    } finally {
      setSaving(false);
    }
  };

  const handleLoadNamedPreset = async (key: string) => {
    if (!key) return;
    if (isWeb) {
      const row = namedPresets.find(p => p.id === key);
      if (!row?.data) { flash('Preset not found'); return; }
      const vid = row.data.videoId ?? '';
      if (vid.startsWith('local_')) {
        const fileName = (() => { try { return decodeURIComponent(vid.slice('local_'.length)); } catch { return vid.slice('local_'.length); } })();
        setPendingPreset({ data: row.data, fileName, presetName: row.name });
        flash(`Reload "${fileName}" to restore preset "${row.name}"`);
        return;
      }
      flash(`Loading preset: ${row.name}…`);
      await loadTrackById(row.data.videoId, row.data.trackTitle, row.data);
      // Editing THIS saved preset now — show its name + mark loaded so SAVE
      // updates it in place (loadTrackById reset both to the track default).
      setLoadedPresetId(row.id ?? null);
      setPresetName(row.name);
      return;
    }
    if (!ipc?.loadNamedPreset) return;
    const preset = await ipc.loadNamedPreset(key);
    if (!preset) { flash(`Preset "${key}" not found`); return; }
    flash(`Loading preset: ${key}…`);
    await loadTrackById(preset.videoId, preset.trackTitle, preset);
  };

  const handleDeleteNamedPreset = async (key: string) => {
    if (!key) return;
    if (isWeb) {
      const row = namedPresets.find(p => p.id === key);
      if (!row?.id) return;
      try {
        await fetch('/api/terminator-presets', {
          method: 'DELETE', credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: row.id }),
        });
        if (loadedPresetId === row.id) { setLoadedPresetId(null); setConfirmSave(null); } // don't keep a dead id
        await refreshWebPresets();
        flash(`Preset deleted: ${row.name}`);
      } catch { flash('Delete failed'); }
      return;
    }
    if (!ipc?.deleteNamedPreset) return;
    await ipc.deleteNamedPreset(key);
    setNamedPresets(await ipc.listNamedPresets());
    flash(`Preset deleted: ${key}`);
  };

  // ── Sample Browser ───────────────────────────────────────────────────────────
  // Preview STREAMS via the SampleBrowser's own <audio> element + direct R2 URL
  // (resolveAudioUrl={r2AudioUrl}) — no byte fetch/decode on this path anymore.
  const presetIndex = useMemo(() => {
    const m: Record<string, string> = {};
    for (const p of namedPresets) if (p.videoId) m[p.videoId] = p.name;
    return m;
  }, [namedPresets]);
  const loadFromBrowser = (entry: BrowserEntry) => {
    const ok = gatePull();
    setSampleBrowserOpen(false);
    if (ok) { setError(null); void loadTrackById(entry.id, entry.title); }
  };
  const loadPresetFromBrowser = (entry: BrowserEntry) => {
    const row = namedPresets.find(p => p.videoId === entry.id);
    if (!row?.data) { setSampleBrowserOpen(false); flash('Preset not found'); return; }
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

  // ── Pads / waveform ──────────────────────────────────────────────────────────
  const findNextEmptyPad = (): number => {
    const meta = state.padBufferMeta ?? {};
    const maxIdx = Math.max(state.pads.length - 1, ...Object.keys(meta).map(Number), -1);
    for (let i = 0; i <= maxIdx + 1; i++) {
      if (!state.pads[i]?.chopId && meta[i] === undefined) return i;
    }
    return maxIdx + 1;
  };
  const onPadTrigger = (idx: number, vel = 1, ts?: number) => {
    // BASS MIDI IN: the 16 pads become a keyboard — folded to the key when
    // LOCK is on (every pad a different in-key note), chromatic from C2 otherwise.
    if (bassMidiRef.current || padSurfaceRef.current === 'bass') { bassEngine.padOn(idx, vel); return; }
    if (padLockFrom !== null && idx >= padLockFrom) { setSubModalOpen(true); return; }
    if (tapArmedRef.current) handleTapHit();   // tap-tempo: count the hit; the sample still plays
    engine.triggerPad(idx, vel, ts);
  };
  const onPadRelease = (idx: number) => { if (bassMidiRef.current || padSurfaceRef.current === 'bass') { bassEngine.padOff(idx); return; } engine.releasePad(idx); };

  // ── LIVE mode handlers ────────────────────────────────────────────────────
  // Fire one big pad NOW: play each assigned drum track (offset by the pad's feel
  // nudge) and, while the drum sequencer runs, record the hit into the step grid.
  // Reads the engine + ref live so it's correct inside a repeat tick.
  const firePad = (padIdx: number) => {
    const pad = livePadsRef.current[padIdx];
    if (!pad) return;
    const offset = pad.offsetMs / 1000;
    const when = engine.ctx.currentTime + offset;
    // Record into the drum grid from the MAIN-TRANSPORT REC/STEP buttons:
    //  • STEP armed (drumEngine.stepRecording) → each hit fills the next step
    //    under the cursor (recordStepHit), advancing it — works while stopped.
    //  • LIVE armed (liveRecArmedRef, the REC → precount → arm flow) → snap the
    //    hit to the nearest 16th while the drum loop plays (recordLiveHit, which
    //    self-guards on the drum loop playing).
    // STEP and LIVE are mutually exclusive (the transport handlers disarm the
    // other when engaging one), so STEP takes priority here; each engine method
    // also no-ops unless its own mode is armed, so this stays safe regardless.
    const stepRec = drumEngine.getState().stepRecording;
    const liveRec = liveRecArmedRef.current;
    const tracks = drumEngine.getState().tracks;
    for (const idx of pad.trackIndices) {
      const key = tracks[idx]?.key;
      if (!key) continue;
      drumEngine.playLive(key, offset);
      if (stepRec) drumEngine.recordStepHit(idx);
      else if (liveRec) drumEngine.recordLiveHit(idx, when);
    }
  };
  const stopRepeat = (padIdx: number) => {
    const t = repeatTimersRef.current[padIdx];
    if (t) { clearTimeout(t); repeatTimersRef.current[padIdx] = null; }
  };
  // Self-rescheduling timeout (NOT a fixed setInterval): the period is recomputed
  // from the LIVE bpm + the pad's current rate/triplet before every tick, so a
  // held pad follows tempo changes. If a tick fires, the pad is still held
  // (pointerup/cancel would have cleared it first), so no extra guard is needed.
  const scheduleRepeat = (padIdx: number) => {
    const pad = livePadsRef.current[padIdx];
    if (!pad) return;
    if (pad.repeatInterval === null) return; // no rate selected → note repeat OFF
    const raw = repeatIntervalMs(pad.repeatInterval, pad.triplet, engine.getMasterBpm());
    const ms = Math.max(10, isFinite(raw) && raw > 0 ? raw : 1000);
    repeatTimersRef.current[padIdx] = setTimeout(() => {
      firePad(padIdx);
      scheduleRepeat(padIdx); // re-read the period for the next tick
    }, ms);
  };
  const startRepeat = (padIdx: number) => { stopRepeat(padIdx); scheduleRepeat(padIdx); };

  const cyclePadSurface = () => {
    // Switching the pad surface always lands in a clean, non-recording state —
    // REC/STEP route differently per surface, so a stale armed mode can't be
    // left running on the now-hidden surface (all stops self-guard).
    for (let i = 0; i < repeatTimersRef.current.length; i++) stopRepeat(i);
    setActivePadMenu(null);
    engine.stopLiveRecord();    // chop live-record / pending count-in
    engine.stopRecordingSeq();  // chop step-record
    drumEngine.stopStepRec();   // drum step-record
    setLiveRecArmed(false);     // drum live-record arm
    bassEngine.setRecording(false);      // bass record-arm
    try { bassEngine.releaseAllLive(); } catch { /* */ }
    setBassHeld(new Set());
    const next = padSurface === 'chops' ? 'drums' : padSurface === 'drums' ? 'bass' : 'chops';
    // The bass surface is pro like the BASS tab; the demo plays it (parity
    // with the desktop demo). A locked tap sells and stays where it was.
    if (next === 'bass' && !isSubscribed() && !demo) { setSubModalOpen(true); return; }
    setPadSurface(next);
  };

  // LIVE REC: reuse the chop sequencer's EXACT precount (engine.runCountIn →
  // same clicks / bar count / countInBeat visual), then start the DRUM sequencer
  // and arm drum recording on the downbeat. Mirrors startLiveRecord's structure
  // (already playing → arm now; count-in off → arm now; else run the precount).
  const armDrumRec = () => {
    drumEngine.stopStepRec(); // STEP / LIVE are mutually exclusive — arming LIVE clears STEP
    const onDownbeat = () => {
      const startAt = engine.takeCountInDownbeat() ?? engine.ctx.currentTime + 0.02; // the "1" where the clicks said
      if (!drumEngine.getState().playing) void drumEngine.start(startAt);
      engine.startMetronomeForDrums(startAt);
      setLiveRecArmed(true);
    };
    if (drumEngine.getState().playing) { onDownbeat(); return; }
    if (!engine.getState().countInEnabled) { onDownbeat(); return; }
    engine.runCountIn(onDownbeat);
  };
  // REC on the BASS surface: the piano-roll record flow, from the transport
  // bar. Mirrors BassSection's toggleRec — stopped: count a bar in (the
  // chopper's shared clicks + countdown), roll the whole transport and record
  // from the downbeat; rolling: punch straight in; recording: punch out
  // (transport keeps playing); counting: cancel.
  const onBassRec = () => {
    if (engine.getState().countInBeat >= 0) { engine.stopLiveRecord(); bassEngine.setRecording(false); return; }
    if (bassEngine.getState().recording) { bassEngine.setRecording(false); return; }
    bassEngine.setRecording(true);
    if (bassEngine.getState().playing || engine.getState().seqPlaying) return;
    if (engine.getState().countInEnabled) engine.runCountIn(() => startTransport());
    else startTransport();
  };

  // REC in LIVE mode. While the drum sequencer is PLAYING, REC is a pure
  // record-arm TOGGLE — the transport is NEVER interrupted (armed → disarm only;
  // not armed → arm immediately, no precount since we're already playing). While
  // STOPPED: a pending count-in cancels; otherwise precount → start playing → arm.
  const onLiveRec = () => {
    if (drumEngine.getState().playing) {
      const next = !liveRecArmedRef.current;
      if (next) drumEngine.stopStepRec(); // STEP / LIVE mutually exclusive — arming LIVE clears STEP
      setLiveRecArmed(next);
      return;
    }
    if (engine.getState().countInBeat >= 0) {
      engine.stopLiveRecord(); // cancels the pending count-in (+ emits; harmless on chop)
      drumEngine.stop();
      setLiveRecArmed(false);
      return;
    }
    armDrumRec();
  };
  const setPadField = (padIdx: number, patch: Partial<LivePadConfig>) => {
    setLivePads(pads => pads.map((p, i) => (i === padIdx ? { ...p, ...patch } : p)));
  };
  const togglePadTrack = (padIdx: number, trackIdx: number) => {
    setLivePads(pads => pads.map((p, i) => {
      if (i !== padIdx) return p;
      if (p.trackIndices.includes(trackIdx)) {
        if (p.trackIndices.length <= 1) return p; // keep at least one assigned
        return { ...p, trackIndices: p.trackIndices.filter(x => x !== trackIdx) };
      }
      return { ...p, trackIndices: [...p.trackIndices, trackIdx].sort((a, b) => a - b) };
    }));
  };
  // LIVE LOAD: open the drum browser for `track`, mirroring DrumSection's
  // snapshot-baseline → audition → commit/revert flow (same engine methods).
  const openLiveBrowser = (track: TrackKey) => {
    const snap: Partial<Record<TrackKey, LiveLoaded>> = {};
    for (const t of drumEngine.getState().tracks) {
      const id = drumEngine.currentSampleFile(t.key);
      snap[t.key] = id ? { kit: t.sampleGenre, id } : null;
    }
    setLiveBaseBoth(snap);
    // One undo snapshot for the whole browse — audition swaps are suppressed,
    // and it's discarded on CLOSE if nothing was LOADed (see endBrowseSession).
    drumEngine.beginBrowseSession();
    const themeColor = getComputedStyle(document.body).getPropertyValue('--neon').trim() || '#35ff69';
    setLiveBrowser({ track, themeColor });
    setActivePadMenu(null);
  };
  // Re-arm a HELD pad's repeat the instant its RATE/TRIPLET changes so a slow→fast
  // switch is immediate. Keyed on the rate/triplet signature ONLY — OFFSET drags
  // and FILL edits don't change it, so they never reset a held pad's phase. (BPM
  // is followed live by scheduleRepeat, so it needs no dependency here.)
  const liveRepeatSig = livePads.map(p => `${p.repeatInterval}:${p.triplet ? 't' : 's'}`).join('|');
  useEffect(() => {
    for (let i = 0; i < repeatTimersRef.current.length; i++) {
      if (repeatTimersRef.current[i] != null) startRepeat(i);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liveRepeatSig]);
  // Cancel all repeat timers if the view unmounts while a pad is held.
  useEffect(() => () => { for (let i = 0; i < repeatTimersRef.current.length; i++) stopRepeat(i); }, []);
  // Auto-disarm LIVE recording whenever the drum loop stops (STOP button /
  // killAllAudio / any other path), so the armed state never lingers.
  useEffect(() => {
    if (!drumState.playing && liveRecArmedRef.current) setLiveRecArmed(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drumState.playing]);
  // ── Pad menu (copy / paste / duplicate / clear / move-swap) ──────────────────
  // Every action is a PURE data op on the engine + clipboard state — none touch
  // `tab`/navigation/scroll (see the menu render: items act on CLICK so the
  // close doesn't let a follow-up tap fall through to the tab bar underneath).
  // (getPadContent / setPadSlot / firstEmptyAfter and the cut/paste/duplicate
  // ops are imported from padClipboard — shared with the desktop grid.)
  // A menu on a different pad means a different file: forget the last one and warm this pad's in the background.
  useEffect(() => {
    dragOutRef.current.reset();
    if (padMenu !== null && canDragOut() && engine) {
      const name = state.padBufferMeta[padMenu]?.title || `${state.trackTitle || 'terminator'} - pad ${String(padMenu + 1).padStart(2, '0')}`;
      void dragOutRef.current.prepare(engine as any, padMenu, name);
    }
  }, [padMenu]); // eslint-disable-line react-hooks/exhaustive-deps

  const handlePadMenuAction = (idx: number, action: 'cut' | 'copy' | 'paste' | 'duplicate' | 'clear' | 'clearblock' | 'move' | 'record' | 'mode' | 'gate' | 'reverse') => {
    if (action === 'copy') {
      const c = getPadContent(engine, idx);
      setPadClipboard(c ? [c] : null);
      if (c) flash(`PAD ${idx + 1} COPIED`);
    }
    // CUT = copy then empty, one undo step. Cut here, tap an empty pad, Paste:
    // that is how you move a pad on a phone without arming MOVE.
    else if (action === 'cut') {
      const items = cutPads(engine, [idx]);
      if (items.length) { setPadClipboard(items); flash(`PAD ${idx + 1} CUT`); }
    }
    // RECORD INTO PAD: start the recorder aimed at this pad (the LOAD tab's ● REC
    // button shows it rolling; tap it, or come back here, to stop). Free tier →
    // the purchase popup, like every own-sample path.
    else if (action === 'record') {
      if (recorder.state === 'recording') { recorder.stop(); }
      else if (recorder.state === 'idle') {
        if (!isSubscribed()) { setSubModalOpen(true); }
        else { recPadTargetRef.current = idx; void recorder.start(); flash(`Recording → PAD ${idx + 1} — tap ■ on LOAD (or here) to stop`); }
      }
    }
    else if (action === 'mode') engine.togglePadMode(idx);
    else if (action === 'gate') engine.setPadGate(idx, !state.pads[idx]?.gate);
    // REV — the desktop's per-source reverse (the waveform bar's ◁ REV, which
    // acts on whichever source is on screen). The phone has no source view, so
    // the pad menu is where it lives here; the engine call is the SAME one, so
    // a reversed pad plays backwards live, through the sequencer and on export,
    // and rides undo. A pad with its own sample reverses that source alone; a
    // main-track chop has no source of its own, so there it is the sample's own
    // REV — exactly what the desktop's main-track view does.
    else if (action === 'reverse') {
      const key = engine.padSourceKey(idx);
      if (key !== null) {
        const on = !engine.reversedFor(idx);
        engine.toggleSourceReverse(key);
        const r = engine.blockRange(idx);
        const span = key !== 'main' && r && r[1] > r[0] ? ` (PADS ${r[0] + 1}–${r[1] + 1})` : '';
        flash(key === 'main'
          ? (on ? 'SAMPLE REVERSED — every chop of it' : 'SAMPLE FORWARD')
          : `PAD ${idx + 1} ${on ? 'REVERSED' : 'FORWARD'}${span}`);
      }
    }
    else if (action === 'clearblock') engine.clearBlock(idx);
    // Paste/Duplicate/Move are MULTI-step engine ops (unassign + assign/load +
    // pitch + mode, ×2 for move). Bracket each so the composite is ONE clean undo
    // step — otherwise only the inner setPadPitch/loadPadBuffer push, capturing a
    // half-applied state.
    else if (action === 'paste') {
      if (padClipboard?.length) { pastePads(engine, idx, padClipboard); flash(`PASTED → PAD ${idx + 1}`); }
    }
    else if (action === 'duplicate') {
      // duplicatePads runs the empty-slot search itself; the button is disabled
      // for empty pads, so 0 can only mean the grid is full.
      if (duplicatePads(engine, [idx])) flash(`PAD ${idx + 1} DUPLICATED`);
      else flash('Pads full');
    }
    // Clear is intentionally DESTRUCTIVE: clearPad splices the chop out of the
    // waveform (merging its region into a neighbour) so the slice point is gone,
    // not just the pad pointer. Paste/Duplicate/Move stay non-destructive.
    else if (action === 'clear') engine.clearPad(idx);
    else if (action === 'move') {
      if (moveSource === null) { setMoveSource(idx); setPadMenu(null); return; }
      if (moveSource !== idx) {
        // Same rules as the desktop ghost drop: the whole BLOCK of the source
        // pad lands here, pushing what is in the way aside; two singles swap.
        const r = engine.blockRange(moveSource);
        engine.moveBlock(moveSource, idx);
        flash(r && r[1] > r[0] ? `BLOCK ${r[0] + 1}–${r[1] + 1} → PAD ${idx + 1}` : `PAD ${moveSource + 1} → PAD ${idx + 1}`);
      }
      setMoveSource(null);
    }
    setPadMenu(null);
  };

  // ── Resizable display ────────────────────────────────────────────────────────
  const onResizeDown = (e: ReactPointerEvent) => {
    resizeDrag.current = { startY: e.clientY, startH: displayHeight };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };
  const onResizeMove = (e: ReactPointerEvent) => {
    if (!resizeDrag.current) return;
    setDisplayHeight(Math.max(120, Math.min(440, resizeDrag.current.startH + (e.clientY - resizeDrag.current.startY))));
  };
  const onResizeUp = () => { resizeDrag.current = null; };

  const onSeekChop = (chopId: number) => {
    if (state.selectedPad !== null) {
      engine.assignChopToPad(state.selectedPad, chopId);
      engine.selectPad(null);
    } else {
      const pad = state.pads.find(p => p.chopId === chopId);
      if (pad) engine.triggerPad(pad.index);
    }
  };
  const onAdjustChop = (chopId: number, side: 'start' | 'end', timeSec: number, freeMove?: boolean) =>
    engine.setChopBoundary(chopId, side, timeSec, freeMove);

  // ── Export ────────────────────────────────────────────────────────────────────
  const doExport = async (format: ExportFormat) => {
    if (!isSubscribed()) { setSubModalOpen(true); return; }
    if (exportBusy) return;
    setExportBusy(true);
    snapshotSessionForExport();
    flash('Exporting…');
    try {
      // Same unified arrangement pipeline the desktop uses (chops + drums +
      // BASS through the master chain, all sections) — the legacy mixer-less
      // render inside, so the mobile sound is unchanged.
      const arrangement = buildFinishArrangement(currentFinishSections());
      flash(await runExport(engine, format, undefined, { drumEngine, arrangement, bpm: engine.getMasterBpm() || 90 }));
    }
    catch (e: any) { flash(e?.message ?? 'Export failed'); }
    finally { setExportBusy(false); }
  };

  // ── Beat Finisher (ported) ─────────────────────────────────────────────────────
  const handleSetClip = (v: number) => { setMasterClip(v); engine.setMasterClip?.(v); };
  const handleSetClipLive = (v: number) => { engine.setMasterClip?.(v); };

  const buildFinishArrangement = (secs: FinishArrangementSection[]): Arrangement => {
    const st = engine.getState();
    const ds = drumEngine.getState();
    const chopEventsFor = (seqIdx: number, sectionBars: number): Array<{ beat: number; pads: number[] }> => {
      const seq: any = (st.sequences || [])[seqIdx];
      if (!seq || !seq.grid) return [];
      const resolution = seq.resolution || 16;
      const seqBars = Math.max(1, seq.bars || 1);
      const stepCount = Math.min(SEQ_MAX_STEPS, seqBars * resolution);
      const stepBeats = 4 / resolution;
      const loopBeats = seqBars * 4;
      const sectionBeats = sectionBars * 4;
      const out: Array<{ beat: number; pads: number[] }> = [];
      for (let base = 0; base < sectionBeats; base += loopBeats) {
        for (let s = 0; s < stepCount; s++) {
          const row = seq.grid[s];
          if (!row || row.length === 0) continue;
          const beat = base + s * stepBeats;
          if (beat >= sectionBeats) break;
          out.push({ beat, pads: [...row] });
        }
      }
      return out;
    };
    const seqList = (ds.sequences && ds.sequences.length ? ds.sequences : [ds.pattern]) as Array<Record<string, boolean[]>>;
    const bs = bassEngine.getState();
    return {
      name: 'Finish Him',
      bassPatch: bassEngine.serialize().patch,
      sections: secs.map((s) => {
        const enabled = Object.keys(s.drumsOn).filter((k) => s.drumsOn[k]);
        const drumPattern: Record<string, boolean[]> = {};
        for (const key of enabled) {
          const idx = s.drumSeq?.[key] ?? 0;
          const pat = seqList[idx] || ds.pattern;
          drumPattern[key] = (pat as any)[key] || [];
        }
        const bassIdx = bassSeqForSection(s);
        return {
          name: s.label, bars: s.bars, chops: [],
          chopEvents: chopEventsFor(s.chopSeqIdx, s.bars),
          drums: 'loop' as const, enabledDrumTracks: enabled, drumPattern,
          drumStepsPerBar: drumEngine.stepsPerBar,
          bassNotes: bassIdx >= 0 ? BassEngine.notesForSection(bs.patterns[bassIdx], s.bars) : undefined,
        };
      }),
    };
  };
  // The current Beat Finisher arrangement — the saved snapshot if the modal has
  // been used, else the same default a fresh modal seeds (mirrors the desktop).
  const currentFinishSections = (): FinishArrangementSection[] => {
    if (finishHimSavedRef.current?.length) return finishHimSavedRef.current;
    const ds = drumEngine.getState();
    const seqList = (ds.sequences && ds.sequences.length ? ds.sequences : [ds.pattern]) as Array<Record<string, boolean[]>>;
    const all = ds.tracks.map(t => ({ key: t.key }));
    const used = all.filter(tk => seqList.some(seq => seq?.[tk.key]?.some(Boolean)));
    return defaultFinishSections(used.length ? used : all);
  };
  const previewFinishHim = (secs: FinishArrangementSection[]) => {
    const ds = drumEngine.getState();
    const arrangement = buildFinishArrangement(secs);
    const identity = Array.from({ length: 128 }, (_, i) => i);
    setFinishHimPreviewing(true);
    void arranger.play(arrangement, identity, ds.pattern as any, ds.bars,
      () => { setFinishHimPreviewing(false); setFinishHimSeekBeat(0); }, finishHimSeekBeat);
  };
  const liveUpdateFinishHim = (secs: FinishArrangementSection[]) => {
    if (!finishHimPreviewing) return;
    arranger.updateDrums(buildFinishArrangement(secs));
  };
  const seekFinishHim = (beat: number) => {
    const b = Math.max(0, beat);
    setFinishHimSeekBeat(b);
    if (finishHimPreviewing) arranger.seek(b);
  };
  const stopFinishHimPreview = () => { arranger.stop(); setFinishHimPreviewing(false); };
  const exportFinishHim = async (
    target: 'master' | 'stems' | 'mpc' | 'drum-rack', _format: 'wav' | 'mp3',
    secs: FinishArrangementSection[], onProgress: (pct: number, label: string) => void,
  ): Promise<string> => {
    snapshotSessionForExport();
    const title = engine.getState().trackTitle || 'beat-finisher';
    onProgress(0.05, 'Preparing…');
    arranger.stop();
    setFinishHimPreviewing(false);

    // Ableton Drum Rack: reuse the EXACT same exporter the main EXPORT section
    // uses (buildDrumRackZip → chops as an .adg + samples). It's chop-based and
    // arrangement-independent, so it bypasses the arranger render path entirely.
    if (target === 'drum-rack') {
      onProgress(0.2, 'Building drum rack…');
      const { buildDrumRackZip } = await import('./exporters/drumRack');
      const { deliverFiles } = await import('../lib/download');
      const res = await buildDrumRackZip(engine, title);
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
  const openFinishHim = () => {
    if (!isSubscribed()) { setSubModalOpen(true); return; }
    try { engine.stopSeq(); } catch { /* */ }
    try { drumEngine.stop(); } catch { /* */ }
    try { engine.stopAllPads(); } catch { /* */ }
    setFinishHimOpen(true);
  };

  // ── Effects: playlists, presets, MIDI, focus, snapshot recovery ──────────────
  useEffect(() => {
    if (!ipc?.listPlaylists) return;
    ipc.listPlaylists().then((pls: Playlist[]) => {
      setPlaylists(pls);
      if (pls.length === 0) return;
      if (isWeb) {
        const fold = (s: string) => s.normalize('NFKD').replace(/[^\p{L}\p{N}]/gu, '').toLowerCase();
        const golden = pls.find(p => fold(p.name).includes('goldenhour'));
        setSelectedPlaylist((golden ?? pls[0]).name);
      } else {
        setSelectedPlaylist(pls[0].name);
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (isWeb) void refreshWebPresets();
    else ipc?.listNamedPresets?.().then(setNamedPresets);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // MIDI input — note→pad through the shared MPC mapping (see midiPads.ts), so
  // pad bank A01 plays the FIRST chop. This used to pass the raw note as the
  // pad index: A01 (note 36) fired pad 36 instead of pad 1, note-offs released
  // a pad that was never struck, and on the free tier (pad lock at 3) an MPC
  // did nothing at all. The engine still enforces that lock.
  useEffect(() => {
    // Routing only — access / hot-plug / status live in midiHub.ts.
    const onMessage = (e: MIDIMessageEvent) => {
      const [status, note, velocity] = e.data as unknown as [number, number, number];

      // Transport from the hardware — same as the classic view. System Real-Time
      // messages are single-byte and must be matched on the FULL status byte
      // before the 0xf0 mask, which would collapse them all to 0xF0.
      if (status === 0xfa || status === 0xfb) { startTransportRef.current(); return; }
      if (status === 0xfc) { stopTransportRef.current(); return; }
      if (status === 0xf8 || status === 0xfe) return;   // clock + active sensing

      const cmd = status & 0xf0;
      // Control Change → the per-knob MIDI-learn store (bass knobs use it).
      if (cmd === 0xb0) { midiCc.handleCC(note, velocity); return; }
      const isOn = cmd === 0x90 && velocity > 0;
      const isOff = cmd === 0x80 || (cmd === 0x90 && velocity === 0);
      if (!isOn && !isOff) return;
      // TAP armed: every MIDI note-on is a tap (the note still plays below).
      if (isOn && tapArmedRef.current) handleTapHit();
      // BASS MIDI IN: the controller plays the synth (scale-locked when LOCK is
      // on; records into the pattern when REC is armed and the transport runs).
      if (bassMidiRef.current) {
        const ctx = engine.ctx;
        const midiLatency = (performance.now() - e.timeStamp) / 1000;
        const when = Math.max(ctx.currentTime, ctx.currentTime - midiLatency + ctx.baseLatency);
        if (isOn) bassEngine.noteOn(note, velocity / 127, when); else bassEngine.noteOff(note, when);
        return;
      }
      const padIdx = padIndexForNote(note);
      if (padIdx === null) return;   // below the pad range — addresses nothing
      // Timestamp threaded through for the same reason as the classic view:
      // it feeds LIVE-record quantize + the latency readout, not the audio
      // start (which is immediate regardless).
      if (isOn) {
        engine.recordInputLag(e.timeStamp);
        engine.triggerPad(padIdx, velocity / 127, e.timeStamp);
      } else engine.releasePad(padIdx);
    };
    const offMsg = midiHub.onMessage(onMessage);
    const offState = midiHub.subscribe((st) => setMidiInputs(st.inputs));
    return () => { offMsg(); offState(); };
  }, [engine]);

  // Keep keyboard focus on this window (iframe) so pad keys reach us.
  useEffect(() => {
    const onMouseDown = (e: MouseEvent) => {
      const t = e.target as Element;
      if (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement) return;
      try { window.focus(); } catch { /* */ }
      e.preventDefault();
    };
    document.addEventListener('mousedown', onMouseDown);
    return () => document.removeEventListener('mousedown', onMouseDown);
  }, []);

  // Spacebar = play/stop toggle. (The hardware grid is touch-only — no keyboard
  // pad triggering in this layout.)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (sampleBrowserOpenRef.current || finishHimOpenRef.current) return;
      const typing = (e.target instanceof HTMLInputElement && e.target.type !== 'range')
        || e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLSelectElement;
      if (typing) return;
      if (e.key === ' ') {
        e.preventDefault();
        if (engine.getState().seqPlaying || drumEngine.getState().playing) stopTransport(); else startTransport();
      }
      if (e.key === 'Escape') { engine.stopAllPads(); engine.selectPad(null); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engine, drumEngine]);

  // iOS export-reset recovery (web): a snapshot at mount means WebKit reloaded
  // the tab while the export share sheet had it backgrounded — restore it.
  useEffect(() => {
    if (!isWeb) return;
    let snap: ChopPreset | null = null;
    try { const raw = localStorage.getItem(SNAPSHOT_KEY); if (raw) snap = JSON.parse(raw) as ChopPreset; } catch { /* */ }
    try { localStorage.removeItem(SNAPSHOT_KEY); } catch { /* */ }
    if (snap?.videoId) {
      if (snap.videoId.startsWith('local_')) {
        const fileName = decodeURIComponent(snap.videoId.slice('local_'.length));
        setPendingPreset({ data: snap, fileName, presetName: snap.trackTitle ?? 'session' });
        flash(`Reload "${fileName}" to restore your session`);
      } else {
        flash('Restoring your session…');
        void loadTrackById(snap.videoId, snap.trackTitle, snap);
      }
    }
    const onVisible = () => { if (document.visibilityState === 'visible') { try { localStorage.removeItem(SNAPSHOT_KEY); } catch { /* */ } } };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Display helpers ───────────────────────────────────────────────────────────
  const bpm = Math.round(engine.getMasterBpm());
  const editBpm = () => {
    const v = prompt('BPM:', String(bpm));
    if (!v) return;
    const n = parseFloat(v);
    if (!isNaN(n)) engine.setMetronomeBpm(Math.max(20, Math.min(300, n)));
  };
  // Drag the big BPM number vertically to scrub the tempo (up = faster). A tap
  // (no movement) still opens the type-in prompt for an exact value. touch-action
  // is none so the drag doesn't scroll the display on touch.
  const bpmDrag = useRef<{ startY: number; startBpm: number; moved: boolean } | null>(null);
  const onBpmDown = (e: ReactPointerEvent) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    bpmDrag.current = { startY: e.clientY, startBpm: engine.getMasterBpm(), moved: false };
  };
  const onBpmMove = (e: ReactPointerEvent) => {
    const d = bpmDrag.current; if (!d) return;
    const dy = d.startY - e.clientY;          // up = positive
    if (Math.abs(dy) > 2) d.moved = true;
    engine.setMetronomeBpm(Math.max(20, Math.min(300, Math.round(d.startBpm + dy * 0.5))));
  };
  const onBpmUp = () => {
    const d = bpmDrag.current; bpmDrag.current = null;
    if (d && !d.moved) editBpm();             // tap (no drag) → type-in prompt
  };
  // Single SNAP toggle: off ↔ transient (snap chop edges to detected onsets).
  const snapOn = state.snapMode !== 'off';
  const toggleSnap = () => engine.setSnapMode(snapOn ? 'off' : 'transient');
  const snapLabel = `SNAP ${snapOn ? 'ON' : 'OFF'}`;

  // ── Screens ───────────────────────────────────────────────────────────────────
  const LoadScreen = (
    <>
      <div className="hw-sc-url">
        <select className="hw-sc-select" value={selectedPlaylist} onChange={e => setSelectedPlaylist(e.target.value)}>
          {playlists.length === 0 && <option value="">No playlist — drop a file</option>}
          {playlists.map((p, i) => <option key={`${p.name}-${i}`} value={p.name}>{p.name} ({p.entries.length})</option>)}
        </select>
      </div>
      <div className="hw-sc-row">
        <button className="hw-sc-btn hi" onClick={loadRandomFromPlaylist} title="Pull a random sample from the current playlist — onto the NEXT EMPTY PAD once you have pads in play, so a kit you have started is never swapped out">↻ GET SAMPLE</button>
        <button className="hw-sc-btn hi" onClick={() => setSampleBrowserOpen(true)} title="Open the sample browser — playlists, your library, recordings">≡ BROWSE</button>
        {/* LOAD FILE is a <label> wrapping the (hidden) file input: a label
            click is a direct user gesture, so the picker opens reliably even
            inside the iframe on iOS Safari (programmatic input.click() is
            blocked there). Free users never reach the picker — the onClick
            preventDefault + sub modal gates them before it opens. */}
        <label
          className={`hw-sc-btn${isSubscribed() ? '' : ' locked'}`}
          title={isSubscribed() ? 'Load your own audio file (mp3, wav, flac…)' : 'Subscriber feature — load your own samples'}
          onClick={e => { if (!isSubscribed()) { e.preventDefault(); setSubModalOpen(true); } }}
        >
          {isSubscribed() ? 'LOAD FILE' : '🔒 LOAD FILE'}
          <input
            id="hw-file-input"
            ref={fileInputRef}
            type="file"
            accept="audio/*,.mp3,.wav,.aif,.aiff,.flac,.ogg,.m4a,.webm,.opus,.tproj,.tprojz"
            style={{ position: 'absolute', width: 1, height: 1, opacity: 0 }}
            onChange={handleFilePick}
          />
        </label>
        {/* ● REC — record from the mic / a plugged-in input, straight into the
            waveform. One tap starts (the button shows the level + MM:SS), one
            tap stops and loads the take. Hidden where MediaRecorder is missing. */}
        {recorder.supported && (
          <button
            className={`hw-sc-btn hw-rec${recorder.state === 'recording' ? ' rec' : ''}${isSubscribed() ? '' : ' locked'}`}
            disabled={recorder.state === 'saving'}
            onClick={onRecClick}
            title={recorder.state === 'recording' ? 'Stop — the take lands on the next empty pad' : isSubscribed() ? 'Record a sample from the microphone or a plugged-in input (audio interfaces work — pick the input below once one is connected) — tap to start, tap again to stop; the take lands on the NEXT EMPTY PAD' : 'Subscriber feature — record your own samples'}>
            {recorder.state === 'recording' && <span className="hw-rec-lvl" style={{ width: `${Math.round(recorder.level * 100)}%` }} />}
            <span className="hw-rec-txt">
              {recorder.state === 'recording'
                ? `■ ${Math.floor(recorder.elapsed / 60).toString().padStart(2, '0')}:${(recorder.elapsed % 60).toString().padStart(2, '0')}`
                : recorder.state === 'saving' ? '…' : isSubscribed() ? '● REC' : '🔒 REC'}
            </span>
          </button>
        )}
      </div>
      {recorder.supported && recorder.inputs.length > 1 && (
        <div className="hw-sc-row">
          <span className="hw-sc-lbl">INPUT</span>
          <select className="hw-sc-select" value={recorder.inputId ?? ''}
            onChange={e => recorder.setInput(e.target.value || null)}
            title="Which input ● REC records from — the built-in mic or a connected audio interface's inputs">
            <option value="">DEFAULT INPUT</option>
            {recorder.inputs.map(d => <option key={d.id} value={d.id}>{d.name.toUpperCase()}</option>)}
          </select>
        </div>
      )}
      <div className="hw-sc-row">
        <button className={`hw-sc-btn ${state.reverseSample ? 'on' : ''}`} onClick={() => engine.toggleReverseSample()}>↺ REV</button>
        <button className="hw-sc-btn red" onClick={() => engine.clearAllChops()} title="Reset the chops — the whole sample back on pad 1, every chop point cleared">RESET</button>
        {/* Screen-green toggle: reverts ONLY the display screen to phosphor green
            (chassis/pads/drums stay in the palette). Label is unchanged (palette
            name, or GREEN when the palette is off); the text turns #35ff69 while
            screen-green is ON to signal the state. Does NOT touch paletteOn. */}
        <button className="hw-sc-btn" onClick={() => setScreenGreen(v => !v)}
          style={{ color: screenGreen ? '#35ff69' : undefined }}
          title={screenGreen ? 'Display screen is phosphor-green — tap to use palette colors' : 'Make the display screen phosphor-green'}>
          {paletteOn ? activePalette.name.toUpperCase() : 'GREEN'}
        </button>
        {/* One-tap in/out of 4K MODE — the theme menu's switch, on the screen
            itself, so the original flat look is a tap away (his ask). */}
        <button className={`hw-sc-btn ${hwFinish === '4k' ? 'on' : ''}`}
          onClick={() => setHwFinish(f => (f === '4k' ? 'classic' : '4k'))}
          title={hwFinish === '4k' ? '4K MODE is on — tap for the original flat look' : 'Tap for 4K MODE — the milled, bevelled material'}>
          4K
        </button>
        <span className="hw-sc-lbl">PITCH</span>
        <PitchKnob value={state.master.pitch} onChange={v => engine.setMasterPitch(v)} />
      </div>
      <div className="hw-sc-presets">
        <div className="hw-sc-presets-lbl">PROJECTS</div>
        <div className="hw-sc-row">
          {/* Editing the name = SAVE AS: drop the loaded id so SAVE upserts by name. */}
          <input className={`hw-sc-in${nameBlink ? ' name-blink' : ''}`} placeholder="Project name…" value={presetName}
            onChange={e => { setPresetName(e.target.value); setLoadedPresetId(null); setConfirmSave(null); }} />
          <button className="hw-sc-btn hi" disabled={saving} onClick={handleSaveNamedPreset}>
            {saving ? 'SAVING…' : (loadedPresetId && namedPresets.find(p => p.id === loadedPresetId)?.name === presetName.trim() ? 'SAVE ✓' : 'SAVE')}
          </button>
        </div>
        {confirmSave && (
          <div className="hw-sc-row" style={{ alignItems: 'center', gap: 6 }}>
            <span style={{ color: '#ffb454', fontSize: 11, flex: 1 }}>"{confirmSave.name}" exists — overwrite?</span>
            <button className="hw-sc-btn hi" onClick={confirmOverwriteSave}>YES</button>
            <button className="hw-sc-btn" onClick={() => setConfirmSave(null)}>NO</button>
          </div>
        )}
        <div className="hw-sc-row">
          <select className="hw-sc-select" value="" onChange={e => handleLoadNamedPreset(e.target.value)}>
            <option value="">LOAD PROJECT…</option>
            {namedPresets.map(p => <option key={p.id ?? p.name} value={isWeb ? (p.id ?? '') : p.name}>{p.name}</option>)}
          </select>
          <select className="hw-sc-select" value="" onChange={e => handleDeleteNamedPreset(e.target.value)}>
            <option value="">DEL PROJECT…</option>
            {namedPresets.map(p => <option key={p.id ?? p.name} value={isWeb ? (p.id ?? '') : p.name}>{p.name}</option>)}
          </select>
        </div>
        {/* Device-to-device: send THIS project (with its samples) by code, or
            receive one another device is sending. Same peer-to-peer path as
            the desktop's OPEN… → Transfer. */}
        <div className="hw-sc-row">
          <button className="hw-sc-btn" disabled={!currentVideoId} onClick={() => setTransfer('send')} title="Send this project (with its samples) to another device — it shows a code, type it there">⇄ TRANSFER</button>
          <button className="hw-sc-btn" onClick={() => setTransfer('receive')} title="Receive a project another device is sending — type its code">⇣ RECEIVE</button>
          <button className="hw-sc-btn" disabled={!currentVideoId} onClick={() => { void downloadProjectFile(); }} title="Save a self-contained project file (.tprojz with your samples inside) — share it, AirDrop it, open it anywhere">⇩ FILE</button>
        </div>
      </div>
    </>
  );

  const fitView = () => { userZoomedRef.current = true; setViewStart(0); setViewEnd(1); };
  // Center zoom on the last-hit pad's chop start (keeps the pad you just played
  // in view), falling back to the current view midpoint when no pad has been
  // triggered or it has no position on the waveform.
  const zoomCenterFrac = (): number => {
    const { viewStart: vs, viewEnd: ve } = viewRef.current;
    const mid = (vs + ve) / 2;
    const buf = engine.buffer;
    if (!buf) return mid;
    const idx = lastTriggeredPad;
    if (idx == null) return mid;
    const pad = state.pads[idx];
    if (!pad || pad.chopId == null) return mid;
    const chop = state.chops.find(c => c.id === pad.chopId);
    return chop ? chop.start / buf.duration : mid;
  };
  const zoom = (factor: number) => {
    const { viewStart: vs, viewEnd: ve } = viewRef.current;
    const mid = zoomCenterFrac();
    const span = Math.max(0.005, Math.min(1, (ve - vs) * factor));
    let ns = Math.max(0, mid - span / 2);
    let ne = Math.min(1, ns + span);
    if (ne - ns < span) ns = Math.max(0, ne - span);
    userZoomedRef.current = true;
    setViewStart(ns); setViewEnd(ne);
  };
  const WaveScreen = (
    <>
      <div className="hw-sc-row hw-wave-row">
        <button className="hw-sc-btn" onClick={() => zoom(0.6)} title="Zoom the waveform in">+</button>
        <button className="hw-sc-btn" onClick={() => zoom(1.6)} title="Zoom the waveform out">−</button>
        <button className="hw-sc-btn" onClick={fitView} title="Fit the whole sample in the screen">FIT</button>
        <button className={`hw-sc-btn ${snapOn ? 'on' : ''}`} onClick={toggleSnap}>{snapLabel}</button>
        <button className={`hw-sc-btn hi ${state.normalizeOn ? 'on' : ''}`} onClick={() => engine.setNormalize(!state.normalizeOn)}>NORM</button>
        {/* CLEAR → reset to ONE chop covering the full sample (start=0, end=dur).
            engine.autoChop(1) is the canonical "single full-span chop" path
            (wires one pad + pushes history); no-op until a sample is loaded. */}
        <button className="hw-sc-btn hi" onClick={() => engine.autoChop(1)} title="Clear every chop point — one pad holding the whole sample">CLEAR</button>
      </div>
      <div className="hw-wave-host">
        <WaveformView
          state={state as any}
          buffer={engine.buffer}
          engine={engine}
          height={300}
          isPlaying={isPlaying}
          onSeekChop={onSeekChop}
          onAdjustChop={onAdjustChop}
          onAdjustFade={(padIdx, side, sec) => {
            const p = state.pads[padIdx];
            engine.setPadFades(padIdx, side === 'in' ? sec : (p?.fadeIn ?? 0), side === 'out' ? sec : (p?.fadeOut ?? 0));
          }}
          onSliceTime={timeSec => {
            if (state.selectedPad !== null) {
              const hit = state.chops.find(c => timeSec >= c.start && timeSec < c.end);
              if (hit) { engine.assignChopToPad(state.selectedPad, hit.id); engine.selectPad(null); return; }
            }
            const padIdx = findNextEmptyPad();
            if (!engine.slicePlayheadAt(padIdx)) engine.sliceAtTime(timeSec, padIdx);
          }}
          transients={state.transients}
          viewStart={viewStart}
          viewEnd={viewEnd}
          onViewChange={(vs, ve) => { userZoomedRef.current = true; setViewStart(vs); setViewEnd(ve); }}
        />
      </div>
    </>
  );

  const SeqScreen = (
    <>
      <div className="hw-sc-stabs">
        <button className={`hw-sc-stab ${seqType === 'chop' ? 'on' : ''}`} onClick={() => setSeqType('chop')}>CHOP SEQ</button>
        <button className={`hw-sc-stab ${seqType === 'drum' ? 'on' : ''}`} onClick={() => setSeqType('drum')}>DRUM SEQ</button>
        <button className={`hw-sc-stab ${seqType === 'bass' ? 'on' : ''}`} onClick={() => setSeqType('bass')}>BASS</button>
        {/* The Finisher is pro on both layouts (desktop greys .tt-gated-finishhim
            for the demo too) — and the SEQ screen, its only door on the phone,
            is now open to the demo, so it needs the free-tier look here. */}
        <button className={`hw-sc-btn pur${isSubscribed() ? '' : ' locked'}`}
          title={isSubscribed() ? 'Beat Finisher — arrange, master and export the beat' : 'Get Terminator — the Beat Finisher arranges, masters and exports'}
          onClick={openFinishHim}>{isSubscribed() ? '⚡ FINISHER' : '🔒 FINISHER'}</button>
      </div>
      <div className="hw-seq-host">
        {seqType === 'bass' ? (
          <div className="hw-bass-skin">
            <BassSection engine={bassEngine} compact chopperEngine={engine}
              recGate={demo ? () => !demoBlock() : undefined}
              onTransportPlay={startTransport} onTransportStop={stopTransport}
              transportPlaying={state.seqPlaying}
              onMidiInChange={(on) => { bassMidiRef.current = on; }} />
          </div>
        ) : seqType === 'chop' ? (
          // Scope wrapper: re-skins the embedded chop Timeline to the
          // green-phosphor LOAD-screen aesthetic on mobile only (see
          // `.hw-chop-skin` in HardwareView.css), mirroring `.hw-drum-skin`.
          // Never present in the desktop ChopperView, so desktop + every theme
          // palette stay untouched.
          <div className="hw-chop-skin">
            <Timeline
              state={state} engine={engine}
              onClear={() => engine.clearSeq()}
              onStartRecord={() => engine.startRecordingSeq()}
              onStopRecord={() => engine.stopRecordingSeq()}
              onStartLiveRecord={() => engine.startLiveRecord()}
              onStopLiveRecord={() => engine.stopLiveRecord()}
              onToggleCountIn={() => engine.toggleCountIn()}
              onPlay={startTransport} onStop={stopTransport}
              onPause={() => engine.pauseSeq()} onResume={() => engine.resumeSeq()}
              onToggleLoop={() => engine.toggleSeqLoop()}
              onToggleStep={(step, padIdx) => engine.toggleSeqStep(step, padIdx)}
              onClearStep={(step) => engine.clearSeqStep(step)}
              onMoveNote={(from, padIdx, to) => engine.moveSeqNote(from, padIdx, to)}
              onSetBars={(bars) => engine.setSeqBars(bars)}
              onSetResolution={(res) => engine.setSeqResolution(res)}
              onSelectSequence={(idx) => engine.selectSequence(idx)}
              onAddSequence={() => engine.addSequence()}
              onDuplicateSequence={() => engine.duplicateSequence()}
              onDeleteSequence={(idx) => engine.deleteSequence(idx)}
            />
          </div>
        ) : (
          // Scope wrapper: re-skins the embedded DrumSection to the green-phosphor
          // LOAD-screen aesthetic on mobile only (see `.hw-drum-skin` in
          // HardwareView.css). Never present in the desktop ChopperView, so the
          // desktop drum sequencer + every theme palette stay untouched.
          <div className="hw-drum-skin">
            <DrumSection
              engine={drumEngine}
              chopperEngine={engine}
              recGate={demo ? () => !demoBlock() : undefined}
              onTransportPlay={startTransport}
              onTransportStop={stopTransport}
              portalBrowser
              compact
            />
          </div>
        )}
      </div>
    </>
  );

  // SAMPLE = chop volume (no solo). Drum tracks = volume + SOLO only (mute
  // removed per the phone-test feedback; the engine still summing through one
  // global chain means there are no per-track inserts here).
  // Faders only — no mute/solo (removed per phone-test feedback).
  const Strip = (name: string, vol: number, onVol: (v: number) => void) => (
    <div className="hw-mx-trk" key={name}>
      <div className="hw-mx-tnm">{name}</div>
      <HwFader className="hw-mx-fdr" vertical min={0} max={1} step={0.01} value={vol} onChange={onVol} title="Level — drag up / down; this strip's volume into the master" />
      <div className="hw-mx-fvol">{Math.round(vol * 100)}</div>
    </div>
  );
  const MixerScreen = (
    <>
      <div className="hw-mx-strips">
        {Strip('SAMPLE', sampleVol, v => { setSampleVol(v); engine.setChopVolume?.(v); })}
        {drumState.tracks.map(t => Strip(t.name.toUpperCase(), t.volume, v => drumEngine.setTrackVolume(t.key, v)))}
      </div>
      <PeakMeter engine={engine} tap={loudTap} onOpen={() => setLoudOpen(true)} />
      <div className="hw-mx-master">
        <span className="hw-export-lbl">EXPORT</span>
        <button className="hw-sc-btn amber" disabled={exportBusy} onClick={() => doExport('mpc-sample')} title="Export an MPC project — every pad's WAV + the sequences as an .mpcsample, zipped">MPC</button>
        <button className="hw-sc-btn amber" disabled={exportBusy} onClick={() => doExport('drum-rack')} title="Export an Ableton Drum Rack (.adg) with the pads' WAVs, zipped">ADG</button>
        <button className="hw-sc-btn amber" disabled={exportBusy} onClick={() => doExport('wav-stems')} title="Export trackouts — one WAV per track (sample, drums, bass, sends), mixer FX baked, zipped">STEMS</button>
        <button className="hw-sc-btn amber" disabled={exportBusy} onClick={() => doExport('master-wav')} title="Export the master mixdown as one WAV">MIX</button>
      </div>
    </>
  );

  // Help window + tooltip layer. Both portal to <body>, so this one fragment is
  // dropped into BOTH the landscape and portrait returns below and paints the
  // same either way — no duplicated wiring, no layout-specific copy.
  const helpUI = (
    <>
      {helpOpen && (
        <HelpModal tips={tips} onTips={changeTips} onClose={() => setHelpOpen(false)} />
      )}
      <TipLayer enabled={tips} />
      {themeMenu}
      {loudOpen && <LoudnessPopup source={loudTap} onClose={() => setLoudOpen(false)} />}
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
    </>
  );

  // ── LANDSCAPE LAYOUT (mobile rotate) ────────────────────────────────────────
  // Early return BEFORE the portrait JSX. Shares every engine/state/ref/handler
  // above — nothing new is initialised. Tabs on top, active content fills the
  // middle, transport + 8 pads on the bottom. Portrait is left fully intact.
  if (isLandscape) {
    const landscapeTabs = [
      ['load', 'LOAD'], ['seq', 'SEQ'], ['drums', 'DRUMS'], ['bass', 'BASS'], ['mixer', 'MIXER'],
    ] as const;

    // Full-screen LED visualizer overlay — portal'd to <body> so position:fixed
    // works inside the iframe. Tap anywhere to dismiss. Same analyser data as the
    // LOAD spectrum (painted into specFsCanvasRef by the draw loop above).
    const spectralOverlay = spectralFullscreen
      ? createPortal(
          <div className="hw-ls-spectral-overlay" onClick={() => setSpectralFullscreen(false)} aria-label="Close visualizer">
            <canvas ref={specFsCanvasRef} className="hw-ls-spectral-canvas" />
          </div>,
          document.body,
        )
      : null;

    // Modals (BROWSE, Beat Finisher, Subscribe) — the portrait return renders its
    // own inline copies; this is the landscape copy so the same triggers work
    // here. Identical props/handlers → identical behaviour.
    const overlays = (
      <>
        {sampleBrowserOpen && (
          <SampleBrowser
            playlists={playlists}
            initialPlaylist={selectedPlaylist}
            isPhone={fhPhone}
            resolveAudioUrl={r2AudioUrl}
            ensureAudioReady={isWeb ? undefined : () => loadManifest().then(() => {})}
            presetIndex={presetIndex}
            onLoad={loadFromBrowser}
            onLoadPreset={loadPresetFromBrowser}
            onClose={() => setSampleBrowserOpen(false)}
          />
        )}
        {finishHimOpen && (
          <div className="hw-fh-host" style={{ padding: fhPhone ? 0 : 16 }}>
            <FinishHimPortal
              theme={paletteOn ? 'palette' : 'xbox'}
              bpm={engine.getMasterBpm()}
              chopSeqs={(engine.getState().sequences || []).map((_, i) => `Seq ${i + 1}`)}
              drumTracks={drumState.tracks.map(t => ({ key: t.key, label: t.name }))}
              drumPattern={drumState.pattern as any} drumStepsPerBar={drumEngine.stepsPerBar}
              drumSequences={(drumState.sequences && drumState.sequences.length ? drumState.sequences : [drumState.pattern]) as any}
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
              onComplete={() => setFinishHimOpen(false)}
            />
          </div>
        )}
        <SubscribeModal open={subModalOpen} demo={demo} onClose={() => setSubModalOpen(false)} />
      </>
    );

    return (
      <>
        {spectralOverlay}

        <div className="hw-machine hw-landscape" {...paletteRootProps}>

          {/* ── top tab bar ── */}
          <div className="hw-ls-tabs">
            {landscapeTabs.map(([key, label]) => (
              <div
                key={key}
                className={`hw-ls-tab${lsTab === key ? ' hw-ls-tab--active' : ''}`}
                onClick={() => { if (gateTab(key)) setLsTab(key); }}
              >
                {proTab(key) && !isSubscribed() ? `🔒 ${label}` : label}
              </div>
            ))}
            {/* HELP rides the end of the tab row — the only bar landscape has.
                Fixed width, so it never eats into the four real tabs. */}
            <div className="hw-ls-tab hw-ls-help" onClick={(e) => setThemeMenuRect((e.currentTarget as HTMLElement).getBoundingClientRect())}
              role="button" aria-label="Theme + layout" title="Theme · palette · UI layout">◐</div>
            <div className="hw-ls-tab hw-ls-help" onClick={() => setHelpOpen(true)}
              role="button" aria-label="Help">?</div>
          </div>

          {/* ── content area ── */}
          <div className="hw-ls-content">

            {/* LOAD — same controls as portrait LOAD, with the LED spectrum on top
                wrapped in a tap-to-expand handle. */}
            {lsTab === 'load' && (
              <div className="hw-ls-scroll hw-ls-load">
                <div className="hw-ls-spec-tap" onClick={() => setSpectralFullscreen(true)} title="Tap to expand visualizer">
                  <canvas ref={specCanvasRef} className="hw-spectrum-canvas" width={180} height={90} />
                  <span className="hw-ls-spec-hint">TAP TO EXPAND</span>
                </div>
                {LoadScreen}
              </div>
            )}

            {/* SEQ — Timeline only, no waveform above it (same props as portrait). */}
            {lsTab === 'seq' && (
              <div className="hw-ls-seq">
                {/* Same green-phosphor reskin as portrait (see `.hw-chop-skin`). */}
                <div className="hw-chop-skin">
                  <Timeline
                    state={state} engine={engine}
                    onClear={() => engine.clearSeq()}
                    onStartRecord={() => engine.startRecordingSeq()}
                    onStopRecord={() => engine.stopRecordingSeq()}
                    onStartLiveRecord={() => engine.startLiveRecord()}
                    onStopLiveRecord={() => engine.stopLiveRecord()}
                    onToggleCountIn={() => engine.toggleCountIn()}
                    onPlay={startTransport} onStop={stopTransport}
                    onPause={() => engine.pauseSeq()} onResume={() => engine.resumeSeq()}
                    onToggleLoop={() => engine.toggleSeqLoop()}
                    onToggleStep={(step, padIdx) => engine.toggleSeqStep(step, padIdx)}
                    onClearStep={(step) => engine.clearSeqStep(step)}
                    onMoveNote={(from, padIdx, to) => engine.moveSeqNote(from, padIdx, to)}
                    onSetBars={(bars) => engine.setSeqBars(bars)}
                    onSetResolution={(res) => engine.setSeqResolution(res)}
                    onSelectSequence={(idx) => engine.selectSequence(idx)}
                    onAddSequence={() => engine.addSequence()}
                    onDuplicateSequence={() => engine.duplicateSequence()}
                    onDeleteSequence={(idx) => engine.deleteSequence(idx)}
                  />
                </div>
              </div>
            )}

            {/* DRUMS — DrumSection full-width (same green-phosphor reskin + props
                as portrait's DRUM SEQ). */}
            {lsTab === 'drums' && (
              <div className="hw-ls-scroll">
                <div className="hw-drum-skin">
                  <DrumSection
                    engine={drumEngine}
                    chopperEngine={engine}
                    recGate={demo ? () => !demoBlock() : undefined}
                    onTransportPlay={startTransport}
                    onTransportStop={stopTransport}
                    portalBrowser
                    compact
                  />
                </div>
              </div>
            )}

            {/* BASS — the synth + piano roll (compact). */}
            {lsTab === 'bass' && (
              <div className="hw-ls-scroll">
                <div className="hw-bass-skin">
                  <BassSection engine={bassEngine} compact chopperEngine={engine}
                    recGate={demo ? () => !demoBlock() : undefined}
                    onTransportPlay={startTransport} onTransportStop={stopTransport}
                    transportPlaying={state.seqPlaying}
                    onMidiInChange={(on) => { bassMidiRef.current = on; }} />
                </div>
              </div>
            )}

            {/* MIXER — same strips + export as portrait. */}
            {lsTab === 'mixer' && (
              <div className="hw-ls-scroll hw-ls-mixer">
                {MixerScreen}
              </div>
            )}

          </div>

          {/* ── bottom bar: transport + 8 pads (bank A, no BPM) ── */}
          <div className="hw-ls-bottom">
            <div className="hw-ls-transport">
              {/* PLAY restarts from the top (same as the portrait main PLAY). */}
              <button
                className={`hw-ls-tbtn hw-ls-tbtn--play${transportPlaying ? ' hw-ls-tbtn--playing' : ''}`}
                onClick={() => { killAllAudio(); startTransport(); }}
                title="Play (restart from top)"
              >▶</button>
              <button className="hw-ls-tbtn" onClick={killAllAudio} title="Stop">■</button>
              {/* REC = live-record toggle. */}
              <button
                className={`hw-ls-tbtn hw-ls-tbtn--rec${state.liveRecording ? ' hw-ls-tbtn--rec-active' : ''}`}
                onClick={() => engine.toggleLiveRecord()}
                title="Live record"
              >●</button>
            </div>

            <div className="hw-ls-pads">
              {Array.from({ length: 8 }, (_, i) => {
                const p = state.pads[i];
                const filled = (p && p.chopId != null) || state.padBufferMeta?.[i] !== undefined;
                const lit = activePads.includes(i);
                const locked = padLockFrom !== null && i >= padLockFrom;
                return (
                  <button
                    key={i}
                    className={`hw-ls-pad${lit ? ' hw-ls-pad--active' : ''}${filled ? ' hw-ls-pad--filled' : ''}${locked ? ' hw-ls-pad--locked' : ''}`}
                    onPointerDown={e => { if (locked) { setSubModalOpen(true); return; } e.preventDefault(); onPadTrigger(i, 1, e.timeStamp); }}
                    onPointerUp={() => onPadRelease(i)}
                    onPointerCancel={() => onPadRelease(i)}
                  >
                    <span className="hw-ls-pad-num">{i + 1}</span>
                  </button>
                );
              })}
            </div>
          </div>

        </div>

        {overlays}
        {helpUI}
      </>
    );
  }

  return (
    <div className={`hw-machine ${tab !== 'load' ? 'hw-compact' : ''}`}
      {...paletteRootProps}
      onPointerDown={() => { if (padMenu !== null) setPadMenu(null); if (activePadMenu !== null) setActivePadMenu(null); }}>
      {/* HEADER */}
      <div className="hw-hdr">
        <span className="hw-logo" onClick={(e) => setThemeMenuRect((e.currentTarget as HTMLElement).getBoundingClientRect())}
          title={`Theme: ${paletteOn ? activePalette.name : 'Phosphor'} — tap for themes + UI layout`}>TERMINATOR</span>
        <div className="hw-hdr-icons">
          {/* HELP first — on a phone this is the manual, so it gets the position
              that stays reachable no matter how narrow the header gets. */}
          <button className="hw-hdr-icon hw-hdr-help" title="Help — how everything works"
            aria-label="Help" onClick={() => setHelpOpen(true)}>?</button>
          <button className="hw-hdr-icon" title="Undo" disabled={!engine.canUndo()} onClick={() => engine.undo()}>↩</button>
          <button className="hw-hdr-icon" title="Redo" disabled={!engine.canRedo()} onClick={() => engine.redo()}>↪</button>
        </div>
      </div>

      {/* DISPLAY */}
      <div className="hw-disp-outer" style={{ paddingBottom: 0 }}>
        <div className="hw-disp" style={{ height: displayHeight }}>
          <div className="hw-d-top">
            <div className="hw-d-status">
              <span className="hw-d-track">{state.trackTitle || 'NO SAMPLE'}</span>
              <span style={{ flex: 1 }} />
              <div className="hw-sc-midi">
                <MidiStatusPill compact />
                {/* Only once a controller is actually attached — a latency
                    figure is noise to someone playing with their thumbs. */}
                {midiInputs.length > 0 && (
                  <MidiLatencyMeter engine={engine} active />
                )}
              </div>
            </div>
            <div className="hw-load-bpm-row">
              {/* existing BPM block — unchanged, just wrapped so the analyser
                  can sit to its right */}
              <div className="hw-bpm-block">
                <div className="hw-d-bpm-row">
                  <span className="hw-d-bpm" style={{ touchAction: 'none' }}
                    onPointerDown={onBpmDown} onPointerMove={onBpmMove}
                    onPointerUp={onBpmUp} onPointerCancel={() => { bpmDrag.current = null; }}>{bpm}</span>
                  <div className="hw-d-bpm-side">
                    <span className="hw-d-bpm-lbl">BPM</span>
                    <span className="hw-d-tap">DRAG</span>
                    <button
                      type="button"
                      className={`hw-d-tap-btn${tapTempoPadMode ? ' on' : ''}${tapFlash ? ' flash' : ''}`}
                      onClick={() => { setTapTempoPadMode(v => !v); tapTimesRef.current = []; }}
                      title={tapTempoPadMode
                        ? 'TAP armed — hit the pads to set the BPM (samples still play). Tap to lock.'
                        : 'Arm TAP, then tap the pads to set the BPM'}
                    >
                      {tapTempoPadMode ? '● TAP' : 'TAP'}
                    </button>
                  </div>
                </div>
              </div>

              {/* segmented LED spectrum analyser — LOAD tab only */}
              {tab === 'load' && (
                <canvas
                  ref={specCanvasRef}
                  className="hw-spectrum-canvas"
                  width={180}
                  height={90}
                />
              )}
            </div>
          </div>
          <div className="hw-d-div" />
          <div className="hw-d-content">
            {tab === 'load' && LoadScreen}
            {tab === 'wave' && WaveScreen}
            {tab === 'seq' && SeqScreen}
            {tab === 'mixer' && MixerScreen}
          </div>
          {/* Count-in countdown on the display SCREEN — reuses the chop
              sequencer's .seq-countin overlay (identical font/colour/glow/pop)
              so the drum-mode and chop-sequencer count-downs match. Both the
              chop live-record (beginCountIn) and DRUMS-mode REC (runCountIn)
              drive the same engine.countInBeat. Shown on EVERY tab (load, wave,
              seq, mixer); on the SEQ tab the embedded Timeline's own
              .seq-countin is hidden via CSS (.hw-d-content .seq-countin) so this
              single display-level number is the only one — no double. */}
          {state.countInBeat >= 0 && (
            <div key={state.countInBeat} className="seq-countin" aria-hidden>{state.countInBeat}</div>
          )}
        </div>
        <div className="hw-resize-handle"
          onPointerDown={onResizeDown} onPointerMove={onResizeMove}
          onPointerUp={onResizeUp} onPointerCancel={onResizeUp} />
      </div>

      {/* TABS */}
      <div className="hw-tabs">
        {(['load', 'wave', 'seq', 'mixer'] as Tab[]).map(t => (
          <button key={t} className={`hw-tab ${tab === t ? 'on' : ''}`} onClick={() => { if (gateTab(t)) setTab(t); }}>{proTab(t) && !isSubscribed() ? `🔒 ${t.toUpperCase()}` : t.toUpperCase()}</button>
        ))}
      </div>

      {/* PADS — bespoke hardware grid (numbers bottom-right, per-pad □ menu) */}
      <div className="hw-pads-outer">
        <div className="hw-pads-hdr">
          <span>{padSurface === 'bass' ? 'BASS' : 'PADS'}</span>
          <div className="hw-bank-row">
            {Array.from({ length: PAD_BANKS }, (_, b) => (
              <button key={b} className={`hw-bank-btn ${padBank === b ? 'on' : ''}`}
                onPointerDown={e => { e.stopPropagation(); setPadBank(b); }}>{String.fromCharCode(65 + b)}</button>
            ))}
          </div>
          {/* BASS surface: the key + scale, right where the pads are (his ask).
              CHROMATIC plays every note; picking a real scale LOCKS the pads to
              it (setLock(true)) so every pad is a right note in that key. */}
          {padSurface === 'bass' && (
            <span className="hw-bass-keyrow">
              <select className="hw-bass-key" value={bassState.key.root}
                onChange={e => bassEngine.setKey(Number(e.target.value), bassState.key.scale)}
                title="Key root — the pads fold to this key">
                {NOTE_NAMES.map((n, i) => <option key={n} value={i}>{n}</option>)}
              </select>
              <select className="hw-bass-key" value={bassState.key.scale}
                onChange={e => {
                  const sc = e.target.value as ScaleId;
                  bassEngine.setKey(bassState.key.root, sc);
                  if (sc !== 'chromatic') bassEngine.setLock(true);
                }}
                title="Scale — CHROMATIC plays every note; any scale locks the pads to the key">
                {SCALES.map(sc => <option key={sc.id} value={sc.id}>{sc.short}</option>)}
              </select>
            </span>
          )}
          {statusMsg && <span className="hw-status">{statusMsg}</span>}
          <span className="hw-pads-bpm">{bpm} BPM</span>
          <button
            className={`hw-live-btn ${padSurface !== 'chops' ? 'on' : ''}`}
            aria-pressed={padSurface !== 'chops'}
            onPointerDown={e => { e.stopPropagation(); cyclePadSurface(); }}
            title={padSurface === 'chops'
              ? 'DRUMS — the pads become finger-drum pads with note repeat; REC records into the drum grid'
              : padSurface === 'drums'
                ? 'BASS — the 16 pads play the bass synth, locked to its key and scale; REC records into the piano roll'
                : 'CHOPS — back to the sample pads'}
          >{padSurface === 'chops' ? 'DRUMS' : padSurface === 'drums' ? 'BASS' : 'CHOPS'}</button>
        </div>
        {error && (
          <div className="hw-error" onClick={() => setError(null)} title="Tap to dismiss">
            ⚠ {error} <span className="hw-error-x">✕</span>
          </div>
        )}
        <div className="hw-pad-host">
          {/* CHOPS → the normal 16-pad chop grid (completely unchanged). */}
          {padSurface === 'chops' && (
          <div className="hw-pad-grid">
            {Array.from({ length: PADS_PER_BANK }, (_, i) => {
              const idx = padBank * PADS_PER_BANK + i;
              const p = state.pads[idx];
              const filled = (p && p.chopId != null) || state.padBufferMeta?.[idx] !== undefined;
              const lit = activePads.includes(idx);
              const locked = padLockFrom !== null && idx >= padLockFrom;
              return (
                <div key={idx}
                  className={`hw-pad ${lit ? 'lit' : ''} ${filled ? 'filled' : ''} ${locked ? 'locked' : ''} ${moveSource === idx ? 'move-src' : ''}`}
                  onPointerDown={e => { if (locked) { setSubModalOpen(true); return; } e.preventDefault(); onPadTrigger(idx, 1, e.timeStamp); }}
                  onPointerUp={() => onPadRelease(idx)}
                  onPointerCancel={() => onPadRelease(idx)}
                  onDragOver={e => { e.preventDefault(); }}
                  onDrop={e => { e.preventDefault(); const f = e.dataTransfer.files[0]; if (f) loadAudioFile(f, idx); }}>
                  <button className={`hw-pad-menu-btn ${moveSource === idx ? 'move-pending' : ''}`}
                    onPointerDown={e => {
                      e.stopPropagation();
                      // While a move is armed, tapping the source pad's □ cancels it.
                      if (moveSource === idx) { setMoveSource(null); setPadMenu(null); return; }
                      setPadMenu(padMenu === idx ? null : idx);
                    }}>□</button>
                  {(() => { const k = engine.padSourceKey(idx); if (!k) return null; const r = engine.blockRange(idx)!; const pos = r[0] === r[1] ? 'solo' : idx === r[0] ? 'start' : idx === r[1] ? 'end' : 'mid'; return <span className={`hw-pad-src hw-pad-src-${pos}`} style={{ '--led': sourceColor(k) } as React.CSSProperties} />; })()}
                  <span className="hw-pad-num">{idx + 1}</span>
                  {padMenu === idx && (
                    // Items act on CLICK, not pointerdown: the handler closes the menu,
                    // and closing on pointerdown lets the follow-up click fall through to
                    // whatever the upward-opening dropdown overlaps (the tab bar) — which
                    // silently switched tabs. onClick resolves on the item itself.
                    <div className="hw-pad-dropdown"
                      onPointerDown={e => e.stopPropagation()} onClick={e => e.stopPropagation()}>
                      {/* LOAD FILE onto this pad — a <label> for the LOAD tab's hidden
                          file input, so the picker opens from a real tap even inside
                          the iframe on iOS (a programmatic click would be blocked). */}
                      <label className="hw-pad-dropdown-item" htmlFor="hw-file-input"
                        onClick={e => { if (!isSubscribed()) { e.preventDefault(); setSubModalOpen(true); return; } filePadTargetRef.current = idx; setPadMenu(null); }}>
                        📁 Load file…
                      </label>
                      {recorder.supported && (
                        <button onClick={() => handlePadMenuAction(idx, 'record')}>
                          {recorder.state === 'recording' ? '■ Stop recording' : '● Record into pad'}
                        </button>
                      )}
                      <button onClick={() => handlePadMenuAction(idx, 'cut')} disabled={!filled}
                        title="Cut this pad — it empties, and Paste drops it on the pad you paste onto">Cut</button>
                      <button onClick={() => handlePadMenuAction(idx, 'copy')} disabled={!filled}>Copy</button>
                      <button onClick={() => handlePadMenuAction(idx, 'paste')} disabled={!padClipboard?.length}
                        title="Paste the cut/copied pad onto this one">Paste</button>
                      <button onClick={() => handlePadMenuAction(idx, 'duplicate')} disabled={!filled}>Duplicate</button>
                      {canDragOut() && (
                        // PRESS AND DRAG this one: it fires on pointerdown, because the OS builds the drag from
                        // the mouse event happening right then. A plain click does nothing.
                        <button disabled={!filled}
                          onPointerDown={e => {
                            if (!filled) return;
                            e.stopPropagation();
                            const name = state.padBufferMeta[idx]?.title || `${state.trackTitle || 'terminator'} - pad ${String(idx + 1).padStart(2, '0')}`;
                            void dragOutRef.current.startDrag(engine as any, idx, name);
                          }}
                          title="Drag this straight into Finder, Ableton, Logic — anywhere that takes a file. It is what the pad PLAYS (the chop with its pitch, reverse and attack) as a 24-bit WAV. PRESS AND DRAG this item; a plain click does nothing">
                          ⇱ Drag out
                        </button>
                      )}
                      <button onClick={() => handlePadMenuAction(idx, 'move')}>
                        {moveSource === null ? 'Move…' : moveSource === idx ? 'Cancel move' : 'Move here'}
                      </button>
                      <button onClick={() => handlePadMenuAction(idx, 'gate')} disabled={!filled} className={p?.gate ? 'on' : ''}
                        title="NOTE ON — sounds only while held; let go and it fades out">
                        {p?.gate ? '■ NOTE ON: on' : '□ NOTE ON: off'}
                      </button>
                      <button onClick={() => handlePadMenuAction(idx, 'mode')} disabled={!filled} className={(p?.mode ?? 'oneshot') === 'loop' ? 'on' : ''}
                        title="LOOP — round and round between start and end; tap again to stop. Drag the FADE nodes on the waveform for a crossfade loop">
                        {(p?.mode ?? 'oneshot') === 'loop' ? '■ LOOP: on' : '□ LOOP: off'}
                      </button>
                      {(() => {
                        const key = engine.padSourceKey(idx);
                        return (
                          <button onClick={() => handlePadMenuAction(idx, 'reverse')} disabled={!filled}
                            className={engine.reversedFor(idx) ? 'on' : ''}
                            title={key !== null && key !== 'main'
                              ? "REV — this pad's own sample plays backwards (every pad of it), and the main sample is left alone"
                              : 'REV — the main sample plays backwards, so every chop of it does'}>
                            {engine.reversedFor(idx) ? '■ REV: on' : '□ REV: off'}
                          </button>
                        );
                      })()}
                      <button onClick={() => handlePadMenuAction(idx, 'clear')}>Clear</button>
                      {(() => { const r = engine.blockRange(idx); return r && r[1] > r[0] ? (
                        <button onClick={() => handlePadMenuAction(idx, 'clearblock')}>Clear block ({r[0] + 1}–{r[1] + 1})</button>
                      ) : null; })()}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
          )}

          {/* BASS → 16 pads playing the bass synth, one in-key note per pad
              (bassEngine.padNote folds to the key/scale; chromatic = C2 up).
              Banks shift the range a grid at a time. Same .hw-pad chassis, so
              every palette and the 4K material dress these for free. */}
          {padSurface === 'bass' && (
          <div className="hw-pad-grid hw-pad-grid-bass">
            {Array.from({ length: PADS_PER_BANK }, (_, i) => {
              const idx = padBank * PADS_PER_BANK + i;
              const note = bassEngine.padNote(idx);
              const isRoot = bassState.key.scale !== 'chromatic' && note % 12 === bassState.key.root;
              const held = bassHeld.has(idx);
              const release = () => {
                setBassHeld(prev => { if (!prev.has(idx)) return prev; const n2 = new Set(prev); n2.delete(idx); return n2; });
                bassEngine.padOff(idx);
              };
              return (
                <div key={idx}
                  className={`hw-pad hw-pad-bass ${held ? 'lit' : ''} ${isRoot ? 'hw-pad-bass-root' : ''}`}
                  onPointerDown={e => { e.preventDefault(); setBassHeld(prev => new Set(prev).add(idx)); bassEngine.padOn(idx, 1); }}
                  onPointerUp={release}
                  onPointerCancel={release}>
                  <span className="hw-pad-note">{NOTE_NAMES[note % 12]}<i>{Math.floor(note / 12) - 1}</i></span>
                  <span className="hw-pad-num">{idx + 1}</span>
                </div>
              );
            })}
          </div>
          )}

          {/* DRUMS → a 2×2 grid of 4 big pads (same chop-pad look, 4× size) that
              trigger DRUM sounds with note-repeat + offset + grid recording. */}
          {liveMode && (
          <div className="hw-pad-grid hw-pad-grid-live">
            {livePads.map((pad, padIdx) => {
              const first = drumState.tracks[pad.trackIndices[0]];
              const color = first?.color ?? 'var(--hw-dbright)';
              const label = pad.trackIndices
                .map(i => drumState.tracks[i]?.name)
                .filter(Boolean)
                .join(' + ') || '—';
              return (
                <div key={padIdx}
                  className="hw-pad hw-pad-live"
                  style={{ touchAction: 'none' }}
                  onPointerDown={e => {
                    e.preventDefault();
                    try { (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); } catch { /* */ }
                    firePad(padIdx);
                    startRepeat(padIdx);
                  }}
                  onPointerUp={e => { try { (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId); } catch { /* */ } stopRepeat(padIdx); }}
                  onPointerCancel={e => { try { (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId); } catch { /* */ } stopRepeat(padIdx); }}>
                  <span className="hw-pad-label" style={{ color }}>{label}</span>
                  <button className="hw-pad-menu-btn"
                    onPointerDown={e => { e.stopPropagation(); setActivePadMenu(activePadMenu === padIdx ? null : padIdx); }}>□</button>
                  {activePadMenu === padIdx && (
                    <div className="hw-live-menu"
                      onPointerDown={e => e.stopPropagation()} onClick={e => e.stopPropagation()}>
                      <div className="hw-live-tabs" role="tablist">
                        {(['FILL', 'LOAD', 'REPEAT', 'OFFSET'] as const).map(tab => (
                          <button key={tab} role="tab" aria-selected={activeMenuTab === tab}
                            className={`hw-live-tab ${activeMenuTab === tab ? 'on' : ''}`}
                            onClick={() => setActiveMenuTab(tab)}>{tab}</button>
                        ))}
                      </div>

                      {activeMenuTab === 'FILL' && (
                        <div className="hw-live-body">
                          {drumState.tracks.map((t, i) => {
                            const checked = pad.trackIndices.includes(i);
                            const lockLast = checked && pad.trackIndices.length <= 1;
                            return (
                              <label key={t.key} className="hw-live-frow">
                                <input type="checkbox" checked={checked} disabled={lockLast}
                                  onChange={() => togglePadTrack(padIdx, i)} />
                                <span style={{ color: t.color }}>{t.name}</span>
                              </label>
                            );
                          })}
                        </div>
                      )}

                      {activeMenuTab === 'LOAD' && (
                        <div className="hw-live-body">
                          {pad.trackIndices.map(i => {
                            const t = drumState.tracks[i];
                            if (!t) return null;
                            return (
                              <div key={t.key} className="hw-live-lrow">
                                <span style={{ color: t.color }}>{t.name}</span>
                                <button className="hw-live-mbtn" onClick={() => openLiveBrowser(t.key)}>Open Browser</button>
                              </div>
                            );
                          })}
                        </div>
                      )}

                      {activeMenuTab === 'REPEAT' && (
                        <div className="hw-live-body">
                          <div className="hw-live-rep">
                            {REPEAT_INTERVALS.map(iv => (
                              <button key={iv}
                                className={`hw-live-mbtn ${pad.repeatInterval === iv ? 'on' : ''}`}
                                onClick={() => setPadField(padIdx, { repeatInterval: pad.repeatInterval === iv ? null : iv })}>{iv}</button>
                            ))}
                          </div>
                          <button className={`hw-live-mbtn hw-live-trip ${pad.triplet ? 'on' : ''}`}
                            onClick={() => setPadField(padIdx, { triplet: !pad.triplet })}>TRIPLET</button>
                        </div>
                      )}

                      {activeMenuTab === 'OFFSET' && (
                        <div className="hw-live-body">
                          <div className="hw-live-scrub" style={{ touchAction: 'none' }}
                            onPointerDown={e => { (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); offsetDragRef.current = { startY: e.clientY, startVal: pad.offsetMs }; }}
                            onPointerMove={e => { const d = offsetDragRef.current; if (!d) return; const v = Math.max(-50, Math.min(50, Math.round(d.startVal + (d.startY - e.clientY) * 0.5))); setPadField(padIdx, { offsetMs: v }); }}
                            onPointerUp={() => { offsetDragRef.current = null; }}
                            onPointerCancel={() => { offsetDragRef.current = null; }}
                            onDoubleClick={() => setPadField(padIdx, { offsetMs: 0 })}>
                            <span className="hw-live-scrub-hint">drag ↕</span>
                          </div>
                          <div className="hw-live-off-val">{pad.offsetMs > 0 ? `+${pad.offsetMs}` : pad.offsetMs}ms</div>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
          )}
        </div>
      </div>

      {/* TRANSPORT */}
      <div className="hw-transport">
        {/* REC: in LIVE mode runs the SAME precount, then arms drum recording;
            otherwise the chop live-record flow, byte-identical to before. */}
        <button
          className={`hw-tbtn rec ${(padSurface === 'bass'
            ? (bassState.recording || state.countInBeat >= 0)
            : liveMode ? (liveRecArmed || state.countInBeat >= 0) : state.liveRecording) ? 'armed' : ''}`}
          onClick={() => (padSurface === 'bass' ? onBassRec() : liveMode ? onLiveRec() : engine.toggleLiveRecord())}
        >REC</button>
        {/* STEP: in DRUMS (liveMode) toggles DRUM step-input recording — each LIVE
            pad hit fills the next drum step under the cursor; otherwise the chop
            step-record flow, byte-identical to before. */}
        <button
          className={`hw-tbtn step ${(liveMode ? drumState.stepRecording : state.recording) ? 'on' : ''}`}
          disabled={padSurface === 'bass'}
          title={padSurface === 'bass' ? 'The bass records live — ● REC (step notes in on the SEQ tab\'s piano roll)' : undefined}
          onClick={() => {
            if (padSurface === 'bass') return;
            if (liveMode) {
              if (drumState.stepRecording) drumEngine.stopStepRec();
              else { setLiveRecArmed(false); drumEngine.startStepRec(); } // STEP / LIVE mutually exclusive
            } else {
              state.recording ? engine.stopRecordingSeq() : engine.startRecordingSeq();
            }
          }}
        >STEP</button>
        <button className={`hw-tbtn ${transportPlaying ? 'playing' : ''}`} onClick={() => { killAllAudio(); startTransport(); }}>{transportPlaying ? 'PLAYING▶' : 'PLAY'}</button>
        <button className="hw-tbtn" onClick={killAllAudio} title="Stop everything — every pad and both sequencers">STOP</button>
        <button className={`hw-tbtn ${state.metronome.enabled ? 'playing' : ''}`} onClick={() => engine.toggleMetronome()}>METRO</button>
      </div>

      {/* SAMPLE BROWSER */}
      {sampleBrowserOpen && (
        <SampleBrowser
          playlists={playlists}
          initialPlaylist={selectedPlaylist}
          isPhone={fhPhone}
          resolveAudioUrl={r2AudioUrl}
          ensureAudioReady={isWeb ? undefined : () => loadManifest().then(() => {})}
          presetIndex={presetIndex}
          onLoad={loadFromBrowser}
          onLoadPreset={loadPresetFromBrowser}
          onClose={() => setSampleBrowserOpen(false)}
        />
      )}

      {/* BEAT FINISHER */}
      {finishHimOpen && (
        <div className="hw-fh-host" style={{ padding: fhPhone ? 0 : 16 }}>
          <FinishHimPortal
            theme={paletteOn ? 'palette' : 'xbox'}
            bpm={engine.getMasterBpm()}
            chopSeqs={(engine.getState().sequences || []).map((_, i) => `Seq ${i + 1}`)}
            drumTracks={drumState.tracks.map(t => ({ key: t.key, label: t.name }))}
            drumPattern={drumState.pattern as any} drumStepsPerBar={drumEngine.stepsPerBar}
            drumSequences={(drumState.sequences && drumState.sequences.length ? drumState.sequences : [drumState.pattern]) as any}
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
            onComplete={() => setFinishHimOpen(false)}
          />
        </div>
      )}

      {/* LIVE LOAD drum browser — portaled to <body> (escapes the machine's
          overflow), reusing the same engine bridge DrumSection uses so a LOAD
          permanently changes that drum track in the sequencer. */}
      {liveBrowser && createPortal(
        <DrumBrowser
          open
          initialCategory={drumEngine.kitSlot(liveBrowser.track)}
          samples={liveDrumSamples}
          current={liveBase}
          themeColor={liveBrowser.themeColor}
          kits={GENRES.map(g => ({ id: g, label: GENRE_LABELS[g] }))}
          initialKit={drumEngine.getState().tracks.find(t => t.key === liveBrowser.track)?.sampleGenre ?? drumState.genre}
          onAudition={s => drumEngine.setTrackSample(s.category, (s.kit ?? drumState.genre) as Genre, s.id)}
          onPreviewPlay={s => drumEngine.previewSample(s.category, (s.kit ?? drumState.genre) as Genre, s.id)}
          onCommit={s => {
            drumEngine.setTrackSample(s.category, (s.kit ?? drumState.genre) as Genre, s.id);
            drumEngine.markBrowseCommitted(); // a real LOAD → keep the browse snapshot on close
            setLiveBaseBoth({ ...liveBaseRef.current, [s.category]: { kit: s.kit ?? drumState.genre, id: s.id } });
          }}
          onCancel={() => {
            for (const k of Object.keys(liveBaseRef.current) as TrackKey[]) {
              const b = liveBaseRef.current[k];
              if (b) drumEngine.setTrackSample(k, b.kit as Genre, b.id);
            }
            drumEngine.endBrowseSession(); // keep the snapshot iff a LOAD committed, else discard
            setLiveBrowser(null);
          }}
        />,
        document.body,
      )}

      <SubscribeModal open={subModalOpen} demo={demo} onClose={() => setSubModalOpen(false)} />
      {helpUI}
    </div>
  );
}
