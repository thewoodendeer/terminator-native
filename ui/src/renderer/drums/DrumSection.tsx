/**
 * Drum sequencer UI — 6 tracks × 16 steps/bar grid under the chopper sequencer.
 * Ported from Drum Dojo and extended: genre tabs (Boom Bap / Trap) with one-tap
 * generation, per-track sample randomize with visible sample name, mute + solo,
 * and a REF-BASED playhead (its own rAF reads engine.getStep() and writes a CSS
 * var — no per-step setState, zero React churn on the audio path). Shares
 * Terminator's transport + BPM and routes through the master FX bus.
 */

import { useEffect, useMemo, useRef, useState, CSSProperties, ReactElement } from 'react';
import { createPortal } from 'react-dom';
import { userDrumUrl } from './drumR2';
import { libFileUrl } from '../chopper/libraryBridge';
import { DrumEngine, DrumState, TrackKey, Genre, GENRES, GENRE_LABELS, GraphParam, GRAPH_DEFAULTS, REPEAT_RATES, clampGraph, STEP_DIVISIONS } from './DrumEngine';
import { ChopperState } from '../chopper/ChopperEngine';
import { useFaderTooltip } from '../chopper/useFaderTooltip';
import { FaderBubble } from '../chopper/FaderBubble';
import { DrumBrowser, type DrumSample, type DrumFolderNode } from '../DrumBrowser';
import { encodeWav, downloadBlob } from './abCapture';
import { flashCells, onCellsInColumn } from '../luxe/hitFlash';
import { SeqPager } from '../chopper/SeqPager';

interface Props {
  engine: DrumEngine;
  /** Optional transport sync — when provided, the drum play/stop button
   *  also toggles the chopper sequencer so the two grids stay locked. */
  onTransportPlay?: () => void;
  onTransportStop?: () => void;
  /** Master clipper (0..1) — shared with the Beat Finisher mixer (Phase 3A-mod).
   *  The CLIP header fader renders ONLY when these are wired, so it shows on the
   *  mobile HardwareView (which passes them) but NOT desktop ChopperView (which
   *  doesn't) — desktop sets the master clipper on the DAW mixer instead. */
  clip?: number;
  onSetClip?: (v: number) => void;
  /** Phase 3A.10.1: engine-only live update during a drag (no host re-render). */
  onSetClipLive?: (v: number) => void;
  /** Render the (already fixed/full-screen) DrumBrowser through a portal to
   *  <body>. Needed by the ?v2 HardwareView, where DrumSection lives inside an
   *  overflow scroller (.hw-seq-host) that iOS Safari uses to clip position:fixed
   *  descendants — trapping the browser inside the small CRT display. Classic
   *  ChopperView omits this, so its DOM/behaviour is unchanged. */
  portalBrowser?: boolean;
  /** Compact grid controls (mobile / HardwareView). When on, the BARS + GRID
   *  button rows collapse into a single tight row of native dropdowns
   *  ([GRID ▼] [T] [BARS ▼]) that fit a narrow phone screen. Desktop ChopperView
   *  omits it and keeps the full button-group layout. */
  compact?: boolean;
  /** DRUM PADS mode (owned by ChopperView): when on, chopper pad i (+ its keyboard
   *  key / MIDI note) fires drum lane i — EVERY lane, added sounds included — and
   *  the pad grid grows to one pad per lane.
   *  The DrumSection only renders the toggle button — the trigger routing lives in
   *  the host. Hidden when onToggleDrumPadMode is omitted (e.g. mobile). */
  drumPadMode?: boolean;
  onToggleDrumPadMode?: () => void;
  /** ChopperEngine — gives access to count-in state (countInEnabled,
   *  countInBeat) and methods (runCountIn, startMetronomeForDrums,
   *  toggleCountIn). Optional so HardwareView (which omits it) is unchanged. */
  chopperEngine?: import('../chopper/ChopperEngine').ChopperEngine;
  /** Called when LIVE or STEP engages — ensures DRUM PADS mode is on.
   *  Separate from onToggleDrumPadMode (which is a toggle); this only sets. */
  onDrumPadModeOn?: () => void;
  /** DEMO: asked before LIVE / STEP record engages; false = the host refused
   *  (it opens the purchase popup) and nothing arms. */
  recGate?: () => boolean;
}

export function DrumSection({ engine, onTransportPlay, onTransportStop, clip, onSetClip, onSetClipLive, portalBrowser, compact, drumPadMode, onToggleDrumPadMode, chopperEngine, onDrumPadModeOn, recGate }: Props) {
  const [state, setState] = useState<DrumState>(engine.getState());
  const [generating, setGenerating] = useState(false);
  const gridRef = useRef<HTMLDivElement>(null);
  // Phase 3A.10: drag tooltip for the header CLIP mini-fader.
  // Phase 3A.10.1: CLIP is shared with the host (lives in ChopperView). Drive the
  // slider from LOCAL state during a drag — engine live only — and commit the
  // shared state once on release, so the host doesn't re-render every move.
  // The CLIP <label> only renders when the host wires onSetClip (mobile only —
  // see the Props comment); these hooks run unconditionally to respect the Rules
  // of Hooks, but they're inert on desktop where no clip prop is passed.
  const [clipDrag, setClipDrag] = useState<number | null>(null);
  const clipPct = clipDrag ?? Math.round((clip ?? 0) * 100);
  const clipDragRef = useRef(clipPct);
  clipDragRef.current = clipPct;
  const clipTip = useFaderTooltip(clipPct, 0, 100);
  const startClipDrag = () => {
    clipTip.onPointerDown();
    const commit = () => {
      window.removeEventListener('pointerup', commit);
      window.removeEventListener('pointercancel', commit);
      onSetClip?.(clipDragRef.current / 100);
      setClipDrag(null);
    };
    window.addEventListener('pointerup', commit);
    window.addEventListener('pointercancel', commit);
  };

  // 16T SWING — lives entirely in the DrumEngine and persists via serialize/
  // restore. Drive the slider from LOCAL state during a drag (engine updated LIVE
  // via setSwingLive, no emit) and commit once on release with setSwing(). Same
  // split as CLIP above: calling setSwing() every move emits, which re-renders the
  // host (ChopperView) on every pointermove and starves the 25 ms audio scheduler
  // → playback glitches. The audio still updates live; only the re-render is gated.
  const [swingDrag, setSwingDrag] = useState<number | null>(null);
  const swingPct = swingDrag ?? Math.round((state.drumSwing ?? 0) * 100);
  const swingDragRef = useRef(swingPct);
  swingDragRef.current = swingPct;
  const swingTip = useFaderTooltip(swingPct, 0, 100);
  const startSwingDrag = () => {
    engine.markHistory(); // one snapshot per swing drag (setSwingLive/setSwing don't push)
    swingTip.onPointerDown();
    const commit = () => {
      window.removeEventListener('pointerup', commit);
      window.removeEventListener('pointercancel', commit);
      engine.setSwing(swingDragRef.current / 100); // publish to state + presets
      setSwingDrag(null);
    };
    window.addEventListener('pointerup', commit);
    window.addEventListener('pointercancel', commit);
  };

  // INPUT Q (mobile host only — see the fader below): SWING's drag pattern,
  // one commit + one history snapshot per drag, straight into the CHOPPER
  // engine that owns the value. Inert on desktop, where the LOAD toolbar's
  // fader is the one on screen.
  const [iqDrag, setIqDrag] = useState<number | null>(null);
  const iqPct = iqDrag ?? Math.round(chopperEngine?.getInputQuantize?.() ?? 100);
  const iqDragRef = useRef(iqPct);
  iqDragRef.current = iqPct;
  const iqTip = useFaderTooltip(iqPct, 0, 100);
  const startIqDrag = () => {
    chopperEngine?.recordHistory();
    iqTip.onPointerDown();
    const commit = () => {
      window.removeEventListener('pointerup', commit);
      window.removeEventListener('pointercancel', commit);
      chopperEngine?.setInputQuantize(iqDragRef.current);
      setIqDrag(null);
    };
    window.addEventListener('pointerup', commit);
    window.addEventListener('pointercancel', commit);
  };

  useEffect(() => engine.subscribe(setState), [engine]);

  // Hand-played hits move the bar-graph editor onto the drum you just played —
  // pad grid, computer keyboard or MIDI controller, all the same. Hit the snare
  // and its SHIFT row is already under your cursor.
  //
  // Only hand-played hits (playLive) fire this; the sequencer schedules its own
  // steps, so a playing pattern never drags the editor around while you work.
  // Re-focusing the track that is ALREADY focused is a no-op in React, so a
  // roll on one pad costs nothing.
  useEffect(() => engine.onPadHit(setFocusedTrack), [engine]);

  // Subscribe to the ChopperEngine for shared count-in state (the CUE toggle +
  // the LIVE button's beat countdown). Optional — HardwareView omits it.
  const [chopperState, setChopperState] = useState<ChopperState | null>(
    () => chopperEngine?.getState() ?? null
  );
  useEffect(() => {
    if (!chopperEngine) return;
    setChopperState(chopperEngine.getState());
    return chopperEngine.subscribe(setChopperState);
  }, [chopperEngine]);

  const countInEnabled = chopperState?.countInEnabled ?? true;
  const countInBeat = chopperState?.countInBeat ?? -1;

  // ── Drum Browser (MPC 4000-style sample picker) ───────────────────────
  // The browser is a unified kit picker: its 5 folders map 1:1 to the 5 drum
  // tracks, so auditioning a sample swaps THAT track (by the sample's category)
  // regardless of which row opened it. We snapshot every track's current sample
  // on open so CLOSE/Esc can restore the whole kit.
  // `mode` only changes which action reads as primary — ADD NEW and REPLACE are
  // both available either way, so opening from the + button doesn't trap you.
  const [browser, setBrowser] = useState<{ track: TrackKey; themeColor: string; mode: 'replace' | 'add' } | null>(null);
  // Full cross-kit sample manifest — random-looking aliases that MATCH the
  // sequencer row labels. Static (both kits), so it only depends on the engine.
  const drumSamples = useMemo<DrumSample[]>(() => engine.browserManifest(), [engine]);
  // MY DRUMS — the user's own drums folder (desktop app: the bridge has the
  // method; the web shim doesn't). Re-listed every time the browser opens.
  type UNode = { name: string; rel: string; isDir: boolean; children?: any[]; lazy?: boolean };
  const drumsBridge = (window as any).terminator as { drumsUserList?: () => Promise<{ root: UNode[]; truncated: boolean; dir: string }>; drumsUserReveal?: () => Promise<unknown>; libraryGet?: () => Promise<any>; libraryListLink?: (id: string) => Promise<any>; libraryPickFolder?: () => Promise<unknown> } | undefined;
  const [userDrums, setUserDrums] = useState<{ root: UNode[]; truncated: boolean; dir: string } | null>(null);
  // The Sample Library's USER SAMPLES + linked folders ride along in MY DRUMS
  // (his ask: both browsers pull from the user library). Shaped like the Drums
  // folder tree; files carry `lib:<node id>` so the lane can remember them.
  const [libTree, setLibTree] = useState<UNode[]>([]);
  const refreshUserDrums = () => {
    void drumsBridge?.drumsUserList?.().then(setUserDrums).catch(() => setUserDrums(null));
    void drumsBridge?.libraryGet?.().then((lib: any) => {
      if (!lib || !lib.nodes) { setLibTree([]); return; }
      const nodes = lib.nodes as Record<string, { id: string; type: string; name: string; children?: string[]; readonly?: boolean; mirrored?: boolean }>;
      const conv = (id: string): UNode | null => {
        const n = nodes[id]; if (!n) return null;
        if (n.type === 'folder' || n.type === 'link') {
          const kids = (n.children ?? []).map(conv).filter((x): x is UNode => !!x);
          // a folder inside a linked directory is LAZY: listed the moment it is opened (onExpandFolder)
          return { name: n.name, rel: `lib:${id}`, isDir: true, children: kids, lazy: !!(n as { lazy?: boolean }).lazy };
        }
        if (n.type === 'file') return { name: n.name, rel: `lib:${id}`, isDir: false };
        return null;
      };
      // EVERY folder of the sample browser rides along (his ask 2026-08-22):
      // RECORDINGS / YOUTUBE / IMPORTS / USER SAMPLES, your own folders, and the
      // linked ones (⇗) — in the sample browser's order.
      const roots: UNode[] = [];
      for (const id of lib.root as string[]) {
        const n = nodes[id]; if (!n || (n.type !== 'folder' && n.type !== 'link')) continue;
        const c = conv(id); if (c) roots.push(n.type === 'link' ? { ...c, name: `⇗ ${n.name}` } : c);
      }
      setLibTree(roots);
    }).catch(() => setLibTree([]));
  };
  const userFolders = useMemo<DrumFolderNode[]>(() => {
    const conv = (nodes: UNode[]): DrumFolderNode[] =>
      nodes.filter(n => n.isDir).map(n => ({ name: n.name, rel: n.rel, children: conv(n.children ?? []), lazy: n.lazy }));
    return [...conv(userDrums?.root ?? []), ...conv(libTree)];
  }, [userDrums, libTree]);
  // A lazy (linked) folder was opened in MY DRUMS → list one level from main and
  // graft it into the tree (files get `lib:<id>` refs like everything else).
  const expandLibFolder = (rel: string) => {
    if (!rel.startsWith('lib:') || !drumsBridge?.libraryListLink) return;
    const id = rel.slice(4);
    void drumsBridge.libraryListLink(id).then((kids: any) => {
      if (!Array.isArray(kids)) return;
      const conv = (k: any): UNode => k.type === 'file'
        ? { name: k.name, rel: `lib:${k.id}`, isDir: false }
        : { name: k.name, rel: `lib:${k.id}`, isDir: true, children: [], lazy: true };
      const graft = (nodes: UNode[]): UNode[] => nodes.map(n => n.rel === rel ? { ...n, lazy: false, children: kids.map(conv) } : n.children ? { ...n, children: graft(n.children) } : n);
      setLibTree(t => graft(t));
    });
  };
  const userSamples = useMemo<DrumSample[]>(() => {
    const out: DrumSample[] = [];
    const slot = browser ? engine.kitSlot(browser.track) : 'perc';
    const walk = (nodes: UNode[], folder: string) => {
      for (const n of nodes) {
        if (n.isDir) walk(n.children ?? [], n.rel);
        else out.push({ id: `user:${n.rel}`, category: slot, url: n.rel.startsWith('lib:') ? libFileUrl(n.rel.slice(4)) : userDrumUrl(n.rel), alias: n.name, kit: 'user', userPath: n.rel, folder });
      }
    };
    walk(userDrums?.root ?? [], '');
    walk(libTree, '');
    return out;
  }, [userDrums, libTree, browser, engine]);
  const allSamples = useMemo<DrumSample[]>(() => drumsBridge?.drumsUserList ? [...drumSamples, ...userSamples] : drumSamples, [drumSamples, userSamples]); // eslint-disable-line react-hooks/exhaustive-deps

  // BASELINE = what's actually LOADED per track. Clicking a sample in the browser
  // auditions it LIVE in the running sequence (temporary); LOAD bakes the current
  // sound into the baseline; CLOSE reverts any un-LOADed audition back to it. The
  // browser's CURRENT flag follows the baseline, not the live audition. Held in a
  // ref (for callbacks) mirrored to state (for the prop).
  type Loaded = { kit: string; id: string } | null;
  const baselineRef = useRef<Partial<Record<TrackKey, Loaded>>>({});
  const [baseline, setBaseline] = useState<Partial<Record<TrackKey, Loaded>>>({});
  const setBaselineBoth = (m: Partial<Record<TrackKey, Loaded>>) => { baselineRef.current = m; setBaseline(m); };

  const openBrowser = (track: TrackKey, mode: 'replace' | 'add' = 'replace') => {
    const snap: Partial<Record<TrackKey, Loaded>> = {};
    for (const t of engine.getState().tracks) {
      const u = engine.userSampleOf(t.key);
      const id = engine.currentSampleFile(t.key);
      snap[t.key] = u ? { kit: 'user', id: `user:${u.rel}` } : id ? { kit: t.sampleGenre, id } : null;
    }
    setBaselineBoth(snap);
    refreshUserDrums(); // MY DRUMS lists whatever is in the folder right now
    // One undo snapshot for the whole browse — audition swaps are suppressed,
    // and it's discarded on CLOSE if nothing was LOADed (see endBrowseSession).
    engine.beginBrowseSession();
    // Resolve the active theme's phosphor colour from the live CSS var.
    const themeColor =
      getComputedStyle(document.body).getPropertyValue('--neon').trim() || '#00ff88';
    setBrowser({ track, themeColor, mode });
  };

  // Tidy the double-tap timer if the section unmounts mid-tap.

  // Ref-based playhead: while playing, a rAF reads the audio-clock step and
  // writes it to a CSS var on the grid. The grid cells never re-render for this.
  useEffect(() => {
    const grid = gridRef.current;
    if (!grid) return;
    if (!state.playing) {
      grid.style.setProperty('--step', '-1');
      return;
    }
    let raf = 0;
    let lastCol = -1;
    const tick = () => {
      // getStep() counts STORED steps (internal 96/bar); --step is in columns, so
      // scale it down to the current view or the playhead runs 2-4x too fast.
      const col = Math.floor(engine.getStep() / engine.columnStride);
      grid.style.setProperty('--step', String(col));
      // 4K finish: the hits in the column just entered FIRE — every lit step
      // flares and decays (luxe/hitFlash.ts). Once per column change; inert
      // on the classic finish; no React.
      if (col !== lastCol) {
        lastCol = col;
        flashCells(onCellsInColumn(grid, '.drum-row-steps', '.drum-step', col));
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [state.playing, engine, state.stepDivision, state.triplet]);

  // Grid resolution comes from the engine (1/8 → 8, 1/16 → 16, 1/32 → 32 per bar).
  const stepsPerBar = engine.viewStepsPerBar; // columns per bar (division × triplet)
  // Columns are the VIEW; the pattern underneath is always stored at the
  // engine's internal 1/32. `stride` is how many stored steps sit behind one
  // column — the ones after the first are off-grid at this view and render as
  // ghosts rather than disappearing.
  const totalSteps = state.bars * stepsPerBar;
  // Columns per beat: the beat separator lands on real beats at every view
  // (was a fixed 4 — right only at 1/16; wrong at 1/8, 1/32 and every triplet).
  const perBeat = Math.max(1, Math.round(stepsPerBar / 4));
  const stride = engine.columnStride;
  // Length of the STORED rows (pattern + graph rows) — internal resolution.
  const storedSteps = state.bars * engine.stepsPerBar;

  // ── Per-step bar-graph editor (ported from Drum Dojo) ─────────────────────
  // One focused track at a time; clicking a track name focuses it. Four tabs:
  // VELOCITY / SHIFT / PAN / REPEAT. The drag mechanics, keyboard shortcuts and
  // Cmd-drag snapshot logic match Drum Dojo exactly. All edits go through the
  // engine (setStepGraphValue / setStepGraphRow / resetStepGraph), which clamps,
  // persists in presets and is read live by the look-ahead scheduler.
  const [focusedTrack, setFocusedTrack] = useState<TrackKey>('kick');
  const [graphParam, setGraphParam] = useState<GraphParam>('VELOCITY');
  const graphBarsRef = useRef<HTMLDivElement>(null);
  const graphDragRef = useRef<{ track: TrackKey; step: number; startY: number; startX: number; startVal: number; startArray: number[]; cmd: boolean } | null>(null);
  const [graphTip, setGraphTip] = useState<{ step: number; value: number; xPct: number } | null>(null);
  // Visual-only draft of the row being dragged. During a drag the engine is
  // updated LIVE (no emit → no host re-render → scheduler never starved); the
  // bars read this draft so they still animate smoothly via a cheap LOCAL
  // re-render. Committed (and cleared) once on pointerup. Same live/commit split
  // as the swing fader (setSwingLive / setSwing).
  const [graphDraft, setGraphDraft] = useState<{ track: TrackKey; param: GraphParam; values: number[] } | null>(null);

  const graphRowOf = (p: GraphParam, track: TrackKey): number[] =>
    p === 'VELOCITY' ? state.stepVelocity?.[track] ?? []
    : p === 'SHIFT' ? state.stepShift?.[track] ?? []
    : p === 'PAN' ? state.stepPan?.[track] ?? []
    : state.stepRepeat?.[track] ?? [];

  // The value shown for a step — the live drag draft if this row is being
  // dragged, else the committed engine/React state.
  const graphValAt = (p: GraphParam, track: TrackKey, stepIdx: number): number => {
    const d = graphDraft;
    if (d && d.track === track && d.param === p) return d.values[stepIdx] ?? GRAPH_DEFAULTS[p];
    return graphRowOf(p, track)[stepIdx] ?? GRAPH_DEFAULTS[p];
  };

  const formatGraphTip = (p: GraphParam, val: number): string => {
    if (p === 'VELOCITY') return `${Math.round(val * 100)}%`;
    if (p === 'SHIFT') return `${val > 0 ? '+' : ''}${val.toFixed(0)}ms`;
    if (p === 'PAN') return val === 0 ? 'C' : val > 0 ? `R${Math.round(val * 100)}` : `L${Math.round(Math.abs(val) * 100)}`;
    return REPEAT_RATES[Math.round(val)]?.label ?? '—';
  };

  const onGraphPointerDown = (e: React.PointerEvent) => {
    const barEl = (e.target as HTMLElement).closest('[data-step]') as HTMLElement | null;
    if (!barEl) return;
    const col = Number(barEl.dataset.step);
    if (Number.isNaN(col)) return;
    // The bar sits under a COLUMN of the grid above; the graph rows (and the
    // pattern) are stored at the engine's internal 1/32, so translate — otherwise
    // at 1/16 or 1/8 the bars edit steps that live between the visible notes.
    const step = engine.stepForColumn(col);
    const key = focusedTrack;
    // SHIFT / PAN / REPEAT: empty steps (no note) are locked — block any edit that
    // starts on one. VELOCITY stays editable on every step.
    if (graphParam !== 'VELOCITY' && !state.pattern[key]?.[step]) return;
    // Snapshot ONCE per gesture, before any mutation below (drag, reset-one,
    // reset-all). The per-move Live setters + commitStepGraph never push, so the
    // whole drag/click collapses to a single undo step.
    engine.markHistory();
    // Opt/Ctrl+Cmd+click: reset every step in the focused track for this param.
    if (e.altKey && (e.metaKey || e.ctrlKey)) {
      if (graphParam === 'VELOCITY') { engine.resetStepGraph(graphParam, key); return; }
      // SHIFT/PAN/REPEAT: reset only steps that have a note; leave empty steps as-is.
      const row = [...graphRowOf(graphParam, key)];
      while (row.length < storedSteps) row.push(GRAPH_DEFAULTS[graphParam]);
      for (let i = 0; i < storedSteps; i++) if (state.pattern[key]?.[i]) row[i] = GRAPH_DEFAULTS[graphParam];
      engine.setStepGraphRow(graphParam, key, row);
      return;
    }
    // Alt+click: reset ONE step to default.
    if (e.altKey) { engine.setStepGraphValue(graphParam, key, step, GRAPH_DEFAULTS[graphParam]); return; }
    const arr = graphRowOf(graphParam, key);
    const startVal = arr[step] ?? GRAPH_DEFAULTS[graphParam];
    graphDragRef.current = { track: key, step, startY: e.clientY, startX: e.clientX, startVal, startArray: [...arr], cmd: e.metaKey || e.ctrlKey };
    try { graphBarsRef.current?.setPointerCapture(e.pointerId); } catch { /* */ }
    // Seed the visual draft from the committed row so the bars track the drag.
    setGraphDraft({ track: key, param: graphParam, values: [...arr] });
    setGraphTip({ step, value: startVal, xPct: ((col + 0.5) / totalSteps) * 100 });
  };

  const onGraphPointerMove = (e: React.PointerEvent) => {
    const d = graphDragRef.current;
    if (!d) return;
    const deltaY = d.startY - e.clientY;   // drag up = positive (VELOCITY / REPEAT)
    const deltaX = e.clientX - d.startX;   // drag right = positive (SHIFT / PAN)
    const rawDelta =
      graphParam === 'VELOCITY' ? deltaY / 72
      : graphParam === 'SHIFT' ? (deltaX / 36) * 50  // horizontal: right = later, left = earlier
      : graphParam === 'PAN' ? deltaX / 36
      : Math.round(deltaY / 10);
    // Build the next row values (full row, off the start snapshot so a Cmd-drag
    // never compounds), update the ENGINE LIVE (no emit, no host re-render → the
    // scheduler isn't starved), and mirror into the visual draft (cheap local
    // re-render only). Committed once on pointerup.
    const values = [...d.startArray];
    while (values.length < storedSteps) values.push(GRAPH_DEFAULTS[graphParam]);
    if (d.cmd) {
      for (let i = 0; i < values.length; i++) {
        // SHIFT/PAN/REPEAT: only step the value on steps that have a note (empty
        // steps keep their start value). VELOCITY applies to all.
        if (graphParam !== 'VELOCITY' && !state.pattern[d.track]?.[i]) continue;
        values[i] = clampGraph(graphParam, (d.startArray[i] ?? GRAPH_DEFAULTS[graphParam]) + rawDelta);
      }
      engine.setStepGraphRowLive(graphParam, d.track, values);
    } else {
      values[d.step] = clampGraph(graphParam, d.startVal + rawDelta);
      engine.setStepGraphValueLive(graphParam, d.track, d.step, d.startVal + rawDelta);
    }
    setGraphDraft({ track: d.track, param: graphParam, values });
    const shown = clampGraph(graphParam, d.startVal + rawDelta);
    setGraphTip(t => t ? { ...t, value: shown } : null);
  };

  const onGraphPointerUp = (e: React.PointerEvent) => {
    const d = graphDragRef.current;
    if (d) {
      try { graphBarsRef.current?.releasePointerCapture(e.pointerId); } catch { /* */ }
      // Single commit → one emit → saves to React state + presets (and re-renders
      // the host exactly once). The live mutations are already in the engine array;
      // commitStepGraph just snapshots it to a fresh reference + emits.
      engine.commitStepGraph(graphParam, d.track);
    }
    graphDragRef.current = null;
    setGraphDraft(null);
    setGraphTip(null);
  };

  // `col` is the visible column (0..totalSteps); the value it shows/edits is the
  // stored step underneath that column, so every bar sits directly beneath the
  // note it belongs to at any grid — not just 1/32.
  const renderGraphBar = (col: number) => {
    const key = focusedTrack;
    const stepIdx = engine.stepForColumn(col);
    const active = !!state.pattern[key]?.[stepIdx];
    const offOpacity = 0.3;
    const beatBreak = col % perBeat === 0 && col > 0;
    // SHIFT / PAN / REPEAT: steps with no note are locked (dimmed, not editable).
    // VELOCITY stays editable on every step.
    const locked = graphParam !== 'VELOCITY' && !active;
    let fill: React.ReactNode = null;
    if (graphParam === 'VELOCITY') {
      const v = graphValAt('VELOCITY', key, stepIdx);
      fill = <div className="drum-graph-bar-fill" style={{ bottom: 0, height: `${v * 100}%`, backgroundColor: 'var(--neon)', opacity: active ? 0.85 : offOpacity }} />;
    } else if (graphParam === 'SHIFT' || graphParam === 'PAN') {
      const v = graphValAt(graphParam, key, stepIdx);
      const frac = graphParam === 'SHIFT' ? Math.max(-1, Math.min(1, v / 50)) : Math.max(-1, Math.min(1, v));
      const w = Math.abs(frac) * 50;
      fill = <>
        <div className="drum-graph-vcenter-line" />
        {v !== 0 && <div className="drum-graph-bar-fill" style={{
          top: '14%', bottom: '14%', width: `${w}%`, zIndex: 1,
          ...(frac >= 0 ? { left: '50%', right: 'auto' } : { right: '50%', left: 'auto' }),
          backgroundColor: frac < 0 ? 'var(--neon2)' : 'var(--neon)', opacity: active ? 0.85 : offOpacity }} />}
      </>;
    } else {
      const idx = graphValAt('REPEAT', key, stepIdx);
      const maxIdx = REPEAT_RATES.length - 1;
      fill = <>
        {Array.from({ length: maxIdx }, (_, n) => (
          <div key={n} className="drum-graph-notch-tick" style={{ bottom: `${((n + 1) / maxIdx) * 100}%` }} />
        ))}
        {idx > 0 && <div className="drum-graph-bar-fill" style={{ bottom: 0, height: `${(idx / maxIdx) * 100}%`, backgroundColor: 'var(--neon3)', opacity: active ? 0.75 : offOpacity, zIndex: 1 }} />}
      </>;
    }
    return (
      <div key={col} data-step={col} className={`drum-graph-bar${beatBreak ? ' beat' : ''}`}
        style={{
          cursor: locked ? 'not-allowed' : (graphParam === 'PAN' || graphParam === 'SHIFT') ? 'ew-resize' : 'ns-resize',
          ...(locked ? { opacity: 0.25 } : null),
        }}>
        {/* note-presence marker — SHIFT/PAN/REPEAT only, painted behind the value bar */}
        {graphParam !== 'VELOCITY' && active && (
          <div style={{
            position: 'absolute', top: 0, bottom: 0, left: '50%',
            transform: 'translateX(-50%)', width: 2,
            background: 'var(--text-dim, rgba(100,100,100,0.5))', pointerEvents: 'none', zIndex: 0,
          }} />
        )}
        {fill}
      </div>
    );
  };

  const handlePlayStop = () => {
    // Prefer the host's unified transport (starts chops + drums phase-locked);
    // fall back to driving the drum engine directly when used standalone.
    if (state.playing) {
      if (onTransportStop) onTransportStop(); else engine.stop();
    } else {
      if (onTransportPlay) onTransportPlay(); else void engine.start();
    }
  };

  // ── STEP / LIVE / CUE recording (mirrors the chop sequencer's transport row) ──
  // Engaging LIVE or STEP auto-enables DRUM PADS so the user can immediately
  // finger-drum; onDrumPadModeOn only SETS the mode (never clears), so it stays
  // on after recording is disengaged. CUE (count-in) is shared with the chop
  // sequencer — same flag, same click train (via chopperEngine).

  // "Armed" = REC is explicitly engaged. This used to be inferred from
  // `state.playing && drumPadMode`, which left no flag to clear — so the only
  // way to disarm was to stop the transport, and hitting REC again killed the
  // whole loop instead of just ending the take.
  const drumLiveActive = state.liveRecording;

  const handleStartLiveRec = () => {
    if (recGate && !recGate()) return;
    onDrumPadModeOn?.();           // auto-enable drum pads
    engine.startLiveRec();         // arm REC (also clears STEP — mutually exclusive)

    if (state.playing) return;     // already playing → pads record from here on

    const onDownbeat = () => {
      // the count-in's downbeat (3.6): the "1" is where the clicks said; else the old now + 20 ms
      const startAt = chopperEngine
        ? (chopperEngine.peekCountInDownbeat() ?? chopperEngine.ctx.currentTime + 0.02)
        : undefined;
      if (onTransportPlay) {
        onTransportPlay();         // unified transport (starts chop seq + drums; playSeq takes the downbeat itself)
      } else {
        chopperEngine?.takeCountInDownbeat();
        void engine.start(startAt);
      }
      if (chopperEngine && startAt !== undefined) {
        chopperEngine.startMetronomeForDrums(startAt);
      }
    };

    if (chopperEngine && countInEnabled) {
      chopperEngine.runCountIn(onDownbeat);
    } else {
      onDownbeat();
    }
  };

  const handleStopLiveRec = () => {
    // Mid count-in: nothing is playing yet, so this is a cancel — kill the
    // pending downbeat and the click train too.
    if (chopperEngine && countInBeat >= 0) {
      chopperEngine.stopLiveRecord(); // aborts count-in (no-op otherwise)
      engine.stopLiveRec();
      if (onTransportStop) onTransportStop(); else engine.stop();
      return;
    }
    // Already rolling: punch OUT of record and let the loop keep playing. The
    // transport is deliberately untouched — STOP is its own button.
    engine.stopLiveRec();
    // drumPadMode stays on intentionally, so you can keep playing the kit
  };

  const handleStartStepRec = () => {
    if (recGate && !recGate()) return;
    onDrumPadModeOn?.();           // auto-enable drum pads
    engine.startStepRec();
    if (!state.playing) {
      if (onTransportPlay) onTransportPlay(); else void engine.start();
    }
  };

  const handleStopStepRec = () => {
    engine.stopStepRec();
    // leave transport running; leave drumPadMode on
  };

  const handleGenerate = async () => {
    if (generating) return;
    setGenerating(true);
    try { await engine.generate(state.genre); } finally { setGenerating(false); }
  };

  // DEV (?debug=1): render the kick through reference / fixed / legacy attack
  // envelopes, log peak+RMS metrics and download WAVs for an Audacity A/B. Gated
  // so it never ships to normal users; left in place so Victor can re-run later.
  const debugAB = typeof window !== 'undefined'
    && new URLSearchParams(window.location.search).get('debug') === '1';
  const runAB = async () => {
    try {
      const { reference, sequencer, legacy, metrics: m } = await engine.captureAB('kick');
      const dB = (a: number, b: number) => 20 * Math.log10((a || 1e-9) / (b || 1e-9));
      console.log('[drum A/B] peak@50ms / rms@200ms', m);
      downloadBlob(encodeWav(reference), 'audition.wav');
      downloadBlob(encodeWav(sequencer), 'sequencer.wav');
      downloadBlob(encodeWav(legacy), 'sequencer-legacy-25ms.wav');
      alert(
        'Drum transient A/B (kick) — peak@50ms / rms@200ms\n\n' +
        `reference  : ${m.reference.peak50ms.toFixed(4)} / ${m.reference.rms200ms.toFixed(4)}\n` +
        `sequencer  : ${m.sequencer.peak50ms.toFixed(4)} / ${m.sequencer.rms200ms.toFixed(4)}` +
          `  (Δpeak ${dB(m.sequencer.peak50ms, m.reference.peak50ms).toFixed(2)} dB, Δrms ${dB(m.sequencer.rms200ms, m.reference.rms200ms).toFixed(2)} dB)\n` +
        `legacy 25ms: ${m.legacy.peak50ms.toFixed(4)} / ${m.legacy.rms200ms.toFixed(4)}` +
          `  (Δpeak ${dB(m.legacy.peak50ms, m.reference.peak50ms).toFixed(2)} dB, Δrms ${dB(m.legacy.rms200ms, m.reference.rms200ms).toFixed(2)} dB)\n\n` +
        'Downloaded audition.wav / sequencer.wav / sequencer-legacy-25ms.wav',
      );
    } catch (e) {
      alert('A/B failed: ' + (e as Error).message);
    }
  };


  // Defensive: an engine instance kept alive across an HMR reload predates the
  // multi-sequence fields. Fall back so render never crashes (refresh re-inits).
  const seqIndex = state.seqIndex ?? 0;
  const seqCount = state.sequences?.length ?? 1;

  return (
    <div className="drum-section">
      <div className="drum-header">
        <button
          className={`btn-rec ${state.playing ? 'on' : ''}`}
          onClick={handlePlayStop}
        >
          {state.playing ? '■ STOP' : '▶ PLAY'}
        </button>

        {/* STEP / LIVE / CUE record — same transport row the chop sequencer has.
            Engaging LIVE or STEP auto-enables DRUM PADS so the user can finger-
            drum straight away; CUE (count-in) is shared with the chop sequencer. */}
        {/* STEP record */}
        {state.stepRecording
          ? <button
              className="btn-rec on"
              onClick={handleStopStepRec}
              title="Step record on — each pad hit fills the next step"
            ><span className="rec-dot">●</span> STEP</button>
          : <button
              className="btn-rec"
              onClick={handleStartStepRec}
              title="Step record — pad hits fill steps one at a time; cursor advances after each hit"
            ><span className="rec-dot">○</span> STEP</button>
        }

        {/* REC — live record */}
        {(drumLiveActive || countInBeat >= 0)
          ? <button
              className="btn-rec on"
              onClick={handleStopLiveRec}
              title={countInBeat >= 0 ? 'Counting in… click to cancel' : 'Recording — click to stop recording; the loop keeps playing'}
            ><span className="rec-dot">●</span> {countInBeat >= 0 ? countInBeat : 'REC'}</button>
          : <button
              className="btn-rec"
              onClick={handleStartLiveRec}
              title="Record — hit pads in time and they snap to the nearest grid step. Click again to stop recording without stopping playback."
            ><span className="rec-dot">○</span> REC</button>
        }

        {/* CUE (count-in toggle) — only when chopperEngine is wired */}
        {chopperEngine && (
          <button
            className={`btn-rec seq-mode${countInEnabled ? ' on' : ''}`}
            onClick={() => chopperEngine.toggleCountIn()}
            title="Count-in — play a 1-bar metronome lead-in before LIVE recording arms"
          >
            <span className="rec-dot">{countInEnabled ? '●' : '○'}</span> CUE
          </button>
        )}

        {/* Genre tabs — switch the sample-kit folder AND drive generation. */}
        <div className="drum-genre-tabs" role="tablist">
          {GENRES.map(g => (
            <button
              key={g}
              className={`drum-genre-tab ${state.genre === g ? 'on' : ''}`}
              onClick={() => engine.setGenre?.(g)}
              role="tab"
              aria-selected={state.genre === g}
              title={g === 'boombap' ? 'Boom Bap kit + grooves' : g === 'trap' ? 'Trap kit + grooves' : 'West Coast kit (G-funk drums) + boom-bap grooves'}
            >{GENRE_LABELS[g]}</button>
          ))}
        </div>
        <button
          className="btn-clear drum-generate-btn"
          onClick={handleGenerate}
          disabled={generating}
          title={state.genre === 'boombap'
            ? 'Generate from a real Boom Bap MIDI file (8th-hat files first)'
            : 'Generate from the built-in Trap patterns'}
        >{generating ? 'GEN…' : 'GENERATE'}</button>
        <button
          className="btn-clear"
          onClick={() => openBrowser('kick')}
          title="Browse the full drum kit — pick a sound for any track"
        >⊞ BROWSE</button>
        {onToggleDrumPadMode && (
          <button
            className={`btn-clear btn-drum-pads${drumPadMode ? ' on' : ''}`}
            onClick={onToggleDrumPadMode}
            aria-pressed={!!drumPadMode}
            title="Drum Pads — every drum lane gets a pad: pad 1 fires lane 1, pad 2 lane 2, on through every sound you added. The grid grows to one pad per lane, and hits live-record into this sequencer while it plays"
          >🥁 DRUM PADS</button>
        )}
        {debugAB && (
          <button
            className="btn-clear"
            onClick={runAB}
            title="DEV (?debug=1): render kick via reference vs fixed vs legacy attack — logs peak/RMS + downloads WAVs"
          >A/B</button>
        )}

        {/* Sequence manager — the shared SeqPager (same buttons as the chop
            sequencer + the bass roll): ◀ SEQ n/N ▶ · + · ⧉ · ✕ */}
        <SeqPager index={seqIndex} count={seqCount}
          onSelect={(i) => engine.selectSequence(i)}
          onAdd={() => engine.addSequence()}
          onDuplicate={() => engine.duplicateSequence()}
          onDelete={() => engine.deleteSequence()}
          lastDeleteHint="Clear this sequence (the last one can’t be deleted)"
          compact={compact} />
        <button className="btn-clear" onClick={() => engine.clear()} title="Clear every step in this sequence">CLEAR</button>
        <button className="btn-clear" onClick={() => engine.randomizeAllSamples?.()} title="Randomize every drum sample at once — a fresh kit (pattern kept)" aria-label="Randomize">🎲</button>

        {/* Master clipper — mobile (HardwareView) ONLY: renders when the host
            wires onSetClip. Desktop ChopperView omits the props (the master
            clipper lives on the DAW mixer there), so this is hidden on desktop. */}
        {onSetClip && (
          <label className="drum-mini" title="Master clipper — 0 = off, 100 = caps the master at ~-1 dBFS">
            <span>CLIP</span>
            <span style={{ position: 'relative', display: 'inline-flex' }}>
              <FaderBubble active={clipTip.active} pct={clipTip.pct}>{clipPct}%</FaderBubble>
              <input type="range" min={0} max={100} value={clipPct}
                onPointerDown={startClipDrag}
                onChange={e => { const v = Number(e.target.value); setClipDrag(v); (onSetClipLive ?? onSetClip)?.(v / 100); }} />
            </span>
            <span className="drum-mini-val">{clipPct}</span>
          </label>
        )}

        {/* 16T swing — pushes the off-beat 16ths late (+ a 96-PPQ snap that fades
            in with the amount). Engine-owned, so it persists in presets. */}
        <label className="drum-mini" title="Swing — pushes off-beat 16ths late (0 = straight · 100 = full triplet feel). ONE knob for BOTH sequencers: the drum lanes and the chop sequencer swing together, so chops and drums land on the same late off-beat">
          <span>SWING</span>
          <span style={{ position: 'relative', display: 'inline-flex' }}>
            <FaderBubble active={swingTip.active} pct={swingTip.pct}>{swingPct}%</FaderBubble>
            <input type="range" min={0} max={100} value={swingPct}
              onPointerDown={startSwingDrag}
              onChange={e => { const v = Number(e.target.value); setSwingDrag(v); engine.setSwingLive(v / 100); }} />
          </span>
          <span className="drum-mini-val">{swingPct}</span>
        </label>

        {/* INPUT Q is GLOBAL now — one fader serving BOTH sequencers, each
            quantizing to its OWN grid (his rule 2026-08-20). On desktop it
            lives next to the BPM in the LOAD toolbar; the phone layout has no
            such toolbar, so the compact host keeps it here. */}
        {compact && chopperEngine && (
          <label className="drum-mini" title="INPUT Q — how hard hits you RECORD pull onto the grid, in the speakers and on the page alike: 100 = dead on the line, 0 = your exact timing. One fader for BOTH sequencers; each quantizes to its own grid">
            <span>INPUT Q</span>
            <span style={{ position: 'relative', display: 'inline-flex' }}>
              <FaderBubble active={iqTip.active} pct={iqTip.pct}>{iqPct}%</FaderBubble>
              <input type="range" min={0} max={100} value={iqPct}
                onPointerDown={startIqDrag}
                onChange={e => setIqDrag(Number(e.target.value))} />
            </span>
            <span className="drum-mini-val">{iqPct}</span>
          </label>
        )}
      </div>

      {/* PPQ / grid settings — bar count, step division, PPQ snap toggle.
          Mirrors the MPC Extractor's grid toolbar (GRID + 96 PPQ).

          Mobile (compact): one tight row — [GRID ▼] [T] [BARS ▼] — using native
          dropdowns so it fits a narrow phone screen. The GRID select carries the
          divisions PLUS an OFF option (freeform), so GRID OFF stays reachable
          without a separate button. Desktop keeps the full button-group layout. */}
      {compact ? (
        <div className="drum-gridctrl drum-gridctrl-compact">
          <span className="drum-gridctrl-lbl">GRID</span>
          <select
            className="drum-gridctrl-select"
            value={state.gridOff ? 'off' : String(state.stepDivision ?? 16)}
            onChange={e => {
              const v = e.target.value;
              if (v === 'off') engine.setGridOff(true);
              else engine.setStepDivision(Number(v));
            }}
            title="Step grid resolution — 1/8 · 1/16 · 1/32 · OFF (freeform live recording)"
          >
            {STEP_DIVISIONS.map(d => (
              <option key={d} value={d}>1/{d}{state.triplet ? 'T' : ''}</option>
            ))}
            <option value="off">OFF</option>
          </select>
          <button
            className={`drum-gridctrl-btn${state.triplet ? ' on' : ''}${state.gridOff ? ' disabled' : ''}`}
            onClick={() => { if (!state.gridOff) engine.setTriplet(!state.triplet); }}
            disabled={state.gridOff}
            title={state.gridOff ? 'Triplet unavailable while GRID OFF' : 'Triplet grid — 1/8T · 1/16T · 1/32T. Same bar length and tempo: 3 columns where the straight grid has 2'}
          >T</button>
          <span className="drum-gridctrl-lbl">BARS</span>
          <select
            className="drum-gridctrl-select"
            value={String(state.bars)}
            onChange={e => engine.setBars(Number(e.target.value))}
            title="Bars in the pattern (1 · 2 · 4)"
          >
            {[1, 2, 4].map(b => (
              <option key={b} value={b}>{b}</option>
            ))}
          </select>
        </div>
      ) : (
      <div className="drum-gridctrl">
        <span className="drum-gridctrl-lbl">BARS</span>
        {[1, 2, 4].map(b => (
          <button
            key={b}
            className={`drum-gridctrl-btn${state.bars === b ? ' on' : ''}`}
            onClick={() => engine.setBars(b)}
            title={`${b} bar${b > 1 ? 's' : ''} — ${b * stepsPerBar} steps`}
          >{b}</button>
        ))}
        <span className="drum-gridctrl-sep" />
        <span className="drum-gridctrl-lbl">GRID</span>
        {STEP_DIVISIONS.map(d => (
          <button
            key={d}
            className={`drum-gridctrl-btn${!state.gridOff && state.stepDivision === d ? ' on' : ''}`}
            onClick={() => engine.setStepDivision(d)}
            title={`1/${d}${state.triplet ? 'T (triplet)' : ''} note grid — ${state.triplet ? d * 3 / 2 : d} steps per bar, same bar length`}
          >1/{d}{state.triplet ? 'T' : ''}</button>
        ))}
        {/* OFF — disable grid quantization (freeform live recording). Mutually
            exclusive with the division buttons above. */}
        <button
          className={`drum-gridctrl-btn${state.gridOff ? ' on' : ''}`}
          onClick={() => engine.setGridOff(!state.gridOff)}
          title="Grid OFF — record live hits at their exact timing (no snap)"
        >OFF</button>
        {/* T — triplet subdivision (1/8T, 1/16T, 1/32T). Greyed while GRID OFF. */}
        <button
          className={`drum-gridctrl-btn${state.triplet ? ' on' : ''}${state.gridOff ? ' disabled' : ''}`}
          onClick={() => { if (!state.gridOff) engine.setTriplet(!state.triplet); }}
          disabled={state.gridOff}
          title={state.gridOff ? 'Triplet unavailable while GRID OFF' : 'Triplet grid — 1/8T · 1/16T · 1/32T. Same bar length and tempo: 3 columns where the straight grid has 2'}
        >T</button>
      </div>
      )}

      <div
        ref={gridRef}
        className={`drum-grid ${state.playing ? 'is-playing' : ''}`}
        style={{ '--steps': totalSteps, '--step': -1 } as CSSProperties}
      >
        {state.tracks.map(t => (
          <DrumRow
            key={t.key}
            track={t}
            row={state.pattern[t.key]}
            totalSteps={totalSteps}
            stride={stride}
            perBeat={perBeat}
            sampleName={engine.sampleName(t.key)}
            focused={focusedTrack === t.key}
            // Placing or clearing a step focuses that track, so the bar-graph
            // editor below is already on the sound you just touched — click the
            // snare's step, then drag its SHIFT, with nothing in between.
            onToggle={col => { setFocusedTrack(t.key); engine.toggleStep(t.key, engine.stepForColumn(col)); }}
            onPreview={() => { setFocusedTrack(t.key); engine.preview(t.key); }}
            onCycleSample={(dir) => engine.cycleTrackSample(t.key, dir)}
            onRandomize={() => engine.randomizeSample(t.key)}
            // off → 1 → 2 → 3 → 4 → off
            onCycleMuteGroup={() => engine.setTrackMuteGroup(t.key, (t.muteGroup ?? 0) >= 4 ? null : (t.muteGroup ?? 0) + 1)}
            onOpenBrowser={() => openBrowser(t.key)}
            onRemove={t.added ? () => engine.removeTrack(t.key) : undefined}
          />
        ))}
        {/* Add a sound — opens the browser straight into ADD NEW. Sits under the
            last row so it reads as "one more of these". */}
        <div className="drum-addrow">
          <button
            className="drum-addrow-btn"
            onClick={() => openBrowser(state.tracks[state.tracks.length - 1]?.key ?? 'perc', 'add')}
            title="Add another drum sound — picks from the browser, lands on its own sequencer row with its own mixer channel"
          >＋ ADD SOUND</button>
        </div>
      </div>

      {/* Per-step bar-graph editor — one focused track, four parameters. */}
      <div className="drum-graph">
        <div className="drum-graph-tabs">
          {(['VELOCITY', 'SHIFT', 'PAN', 'REPEAT'] as GraphParam[]).map(p => (
            <button key={p} className={`drum-graph-tab${graphParam === p ? ' on' : ''}`} onClick={() => setGraphParam(p)}>{p}</button>
          ))}
          <span className="drum-graph-track-label">
            {state.tracks.find(t => t.key === focusedTrack)?.name ?? focusedTrack}
          </span>
        </div>
        <div className="drum-graph-row">
          <div className="drum-graph-spacer" />
          <div
            className="drum-graph-bars"
            ref={graphBarsRef}
            style={{ gridTemplateColumns: `repeat(${totalSteps}, 1fr)` }}
            onPointerDown={onGraphPointerDown}
            onPointerMove={onGraphPointerMove}
            onPointerUp={onGraphPointerUp}
            onPointerCancel={onGraphPointerUp}
          >
            {graphTip && (
              <div className="drum-graph-tooltip" style={{ left: `${graphTip.xPct}%` }}>
                {formatGraphTip(graphParam, graphTip.value)}
              </div>
            )}
            {Array.from({ length: totalSteps }, (_, i) => renderGraphBar(i))}
          </div>
        </div>
      </div>

      {/* portalBrowser (?v2 HardwareView): lift the fixed full-screen browser out
          to <body> so it escapes the .hw-seq-host overflow scroller that iOS
          Safari otherwise clips it to. The element is identical either way —
          only its DOM mount point changes. */}
      {browser && ((browserEl: ReactElement) =>
        portalBrowser ? createPortal(browserEl, document.body) : browserEl
      )(
        <DrumBrowser
          open
          initialCategory={engine.kitSlot(browser.track)}
          samples={allSamples}
          current={baseline}
          themeColor={browser.themeColor}
          // WEST COAST is gone from the browser (his call 2026-08-21 — it reads
          // empty); its sounds still load for projects that use them.
          kits={[...GENRES.filter(g => g !== 'westcoast').map(g => ({ id: g, label: GENRE_LABELS[g] })), ...(drumsBridge?.drumsUserList ? [{ id: 'user', label: 'MY DRUMS' }] : [])]}
          initialKit={engine.userSampleOf(browser.track) ? 'user' : (state.tracks.find(t => t.key === browser.track)?.sampleGenre ?? state.genre)}
          userFolders={userFolders}
          userDir={userDrums?.dir}
          userTruncated={userDrums?.truncated}
          onExpandFolder={expandLibFolder}
          onAddFolder={drumsBridge?.libraryPickFolder ? () => { void drumsBridge.libraryPickFolder?.().then(() => refreshUserDrums()); } : undefined}
          onOpenUserFolder={drumsBridge?.drumsUserReveal ? () => { void drumsBridge.drumsUserReveal?.(); } : undefined}
          // Click/arrow = TEMP audition: swap it into the live sequence (+ a
          // one-shot) so you hear it in context. Nothing is committed until LOAD.
          commitLabel={browser.mode === 'add' ? 'REPLACE' : 'LOAD'}
          // ADD NEW puts the sound on its own lane (+ its own mixer strip)
          // rather than replacing whatever currently sits on that kit slot.
          onAddNew={s => {
            if (s.kit === 'user' && s.userPath) engine.addTrackFromUserSample(engine.kitSlot(browser.track), s.userPath, s.alias);
            else engine.addTrackFromSample(s.category, (s.kit ?? state.genre) as Genre, s.id);
            engine.markBrowseCommitted();
          }}
          /* The LANE the browser was opened on — not s.category (that is the
             browsable SLOT; for the five default lanes they happen to be equal,
             for an added lane LOAD used to land on the built-in lane instead). */
          onAudition={s => s.kit === 'user' && s.userPath ? engine.setTrackUserSample(browser.track, s.userPath, s.alias) : engine.setTrackSample(browser.track, (s.kit ?? state.genre) as Genre, s.id)}
          onPreviewPlay={s => s.kit === 'user' && s.userPath ? void engine.previewUserSample(browser.track, s.userPath) : void engine.previewSample(browser.track, (s.kit ?? state.genre) as Genre, s.id)}
          // LOAD = actually apply the sound (works even with PREVIEW off, where no
          // temp audition swapped it), then bake it into the baseline. Stays open
          // so you can keep loading other tracks/kits.
          onCommit={s => {
            if (s.kit === 'user' && s.userPath) engine.setTrackUserSample(browser.track, s.userPath, s.alias);
            else engine.setTrackSample(browser.track, (s.kit ?? state.genre) as Genre, s.id);
            engine.markBrowseCommitted(); // a real LOAD → keep the browse snapshot on close
            setBaselineBoth({ ...baselineRef.current, [browser.track]: { kit: s.kit ?? state.genre, id: s.id } });
          }}
          // CLOSE / Esc / click-away = revert every track to the baseline
          // (discard un-LOADed auditions), then dismiss.
          onCancel={() => {
            for (const k of Object.keys(baselineRef.current) as TrackKey[]) {
              const b = baselineRef.current[k];
              if (b) engine.setTrackSample(k, b.kit as Genre, b.id);
            }
            engine.endBrowseSession(); // keep the snapshot iff a LOAD committed, else discard
            setBrowser(null);
          }}
        />
      )}
    </div>
  );
}

function DrumRow({
  track, row, totalSteps, stride, perBeat, sampleName, focused,
  onToggle, onPreview, onCycleSample, onRandomize, onCycleMuteGroup, onOpenBrowser, onRemove,
}: {
  track: { key: TrackKey; name: string; color: string; sampleIndex: number; muted: boolean; volume: number; muteGroup?: number };
  row: boolean[];
  totalSteps: number;
  /** Stored steps per visible column (1/8 view → 12, 1/16 → 6, 1/32 → 3; triplets 8/4/2). */
  stride: number;
  /** Visible columns per BEAT — the beat separator (1/16 → 4, 1/16T → 6, 1/8 → 2, 1/32 → 8). */
  perBeat: number;
  sampleName: string;
  focused: boolean;
  onToggle: (step: number) => void;
  onPreview: () => void;
  onCycleSample: (dir: 1 | -1) => void;
  onRandomize: () => void;
  /** MUTE GROUPS — cycle this lane off → 1 → 2 → 3 → 4 → off. */
  onCycleMuteGroup: () => void;
  onOpenBrowser: () => void;
  /** Only present on user-added lanes — the five defaults can't be removed. */
  onRemove?: () => void;
}) {
  return (
    <div
      className={`drum-row ${track.muted ? 'muted' : ''} ${focused ? 'graph-focused' : ''}`}
      style={{ '--track-color': track.color } as CSSProperties}
    >
      <div className="drum-row-head">
        <button className="drum-row-name" onClick={onPreview} title="Tap to preview + focus the bar-graph editor">
          {track.name}
        </button>
        <div className="drum-row-sample">
          <button className="drum-arrow" onClick={() => onCycleSample(-1)} title={`Previous sample (${sampleName})`}>‹</button>
          <button className="drum-sample-name" onClick={onOpenBrowser} title={`Browse ${track.name} samples`}>{sampleName}</button>
          <button className="drum-arrow" onClick={() => onCycleSample(1)} title={`Next sample (${sampleName})`}>›</button>
          <button className="drum-rnd" onClick={onRandomize} title="Randomize sample">🎲</button>
          {/* MUTE GROUP — lanes sharing a number cut each other (closed hat over
              open hat). Off by default: lanes ring on as they always have. */}
          <button
            className={`drum-rnd drum-mgrp${track.muteGroup ? ' on' : ''}`}
            onClick={onCycleMuteGroup}
            title={track.muteGroup
              ? `MUTE GROUP ${track.muteGroup} — this lane and every other lane in group ${track.muteGroup} cut each other: whichever hits last is the one you hear (a closed hat stopping an open hat). Click to move it to the next group, or past 4 to switch it off. Exports cut exactly the same way`
              : 'MUTE GROUP — off: this lane rings on under everything else. Click to put it in group 1, and put a second lane in the same group so they cut each other (the classic open/closed hat pair). Exports follow'}
          >{track.muteGroup ? `G${track.muteGroup}` : 'G'}</button>
          {onRemove && (
            <button className="drum-rnd drum-remove" onClick={onRemove}
              title={`Remove the ${track.name} row (and its mixer channel)`}>✕</button>
          )}
        </div>
        {/* Per-track mute + volume fader removed — both now live on the mixer
            channel strip for this drum track. */}
      </div>
      <div className="drum-row-steps" style={{ gridTemplateColumns: `repeat(${totalSteps}, 1fr)` }}>
        {Array.from({ length: totalSteps }, (_, i) => {
          const base = i * stride;
          const on = !!row[base];
          // Notes living between this column and the next — real, audible, and
          // invisible at this view unless we draw them. Shown as small marks so
          // you can see 1/32 detail while working on an 1/8 grid instead of
          // programming over it blind.
          let ghosts = 0;
          for (let k = 1; k < stride; k++) if (row[base + k]) ghosts++;
          return (
          <div
            key={i}
            className={['drum-step', on ? 'on' : '', ghosts ? 'has-ghost' : '', i % perBeat === 0 ? 'beat' : ''].filter(Boolean).join(' ')}
            title={ghosts ? `${ghosts} off-grid note${ghosts > 1 ? 's' : ''} here — switch to a finer grid to edit` : undefined}
            // Single pointer event (mouse/touch/pen) — fires ONCE per tap. The old
            // onMouseDown+onTouchStart pair double-fired on mobile (React's
            // onTouchStart is passive so preventDefault was a no-op → the browser
            // also synthesized a mousedown → toggled twice = blink-but-no-persist).
            style={{ touchAction: 'none' }}
            onPointerDown={e => { e.preventDefault(); onToggle(i); }}
          />
          );
        })}
        {/* Ref-based playhead: position from the inherited --step / --steps vars. */}
        <div className="drum-playhead" aria-hidden="true" />
      </div>
    </div>
  );
}
