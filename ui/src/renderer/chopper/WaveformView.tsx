import { useRef, useEffect, type ReactNode } from 'react';
import { ChopperState, ChopperEngine, type Chop } from './ChopperEngine';
import { usePadActivity } from './usePadActivity';

interface Props {
  state: ChopperState;
  /** Optional controls rendered into the zoom/toolbar row next to FIT (desktop
   *  ChopperView passes Attack/Release/Pitch here; HardwareView omits it). */
  toolbarExtra?: ReactNode;
  buffer: AudioBuffer | null;
  /** STEMS: bumps when the engine patched the composite buffer IN PLACE (same
   *  identity) — only engine.takeWaveformDirty()'s frame ranges re-bucket. */
  waveformRev?: number;
  /** TRIM tool (desktop chopper): while armed, a left-drag on the waveform
   *  highlights a section instead of panning / dropping a chop; the highlight
   *  is `trimSel` (seconds). Right-click on it → onTrimContextMenu(x, y). */
  trimMode?: boolean;
  trimSel?: { a: number; b: number } | null;
  onTrimSelect?: (sel: { a: number; b: number } | null) => void;
  onTrimContextMenu?: (clientX: number, clientY: number) => void;
  /** Engine handle — the cursor reads engine.getPlayheadPos() every frame so
   *  the playhead animates without per-frame React state updates. */
  engine: ChopperEngine;
  /** True while a pad voice is sounding; gates the local cursor rAF. Flips on
   *  the start/end emits, not per frame. */
  isPlaying: boolean;
  onSeekChop: (chopId: number) => void;
  onAdjustChop: (chopId: number, side: 'start' | 'end', timeSec: number, freeMove?: boolean) => void;
  /** Fired when the user taps (mobile) or double-clicks (desktop) a position
   *  on the waveform that should drop a new chop boundary there. Caller
   *  picks which pad receives the new chop. */
  onSliceTime?: (timeSec: number) => void;
  /** LOOP fades: the active pad (in LOOP mode) shows two FADE nodes — drag the
   *  fade-in node away from the chop start / the fade-out node away from the
   *  end. `seconds` is the fade length inside the chop. Called live while
   *  dragging (the engine coalesces it into one undo step). */
  onAdjustFade?: (padIdx: number, side: 'in' | 'out', seconds: number) => void;
  transients?: Float32Array;
  viewStart: number;
  viewEnd: number;
  onViewChange: (vs: number, ve: number) => void;
  width?: number;
  height?: number;
}

const HANDLE_PX = 14; // mouse hit-target half-width (was 8 — fatter to match the bigger handle)
const BUCKET = 256; // samples per precomputed peak bucket

/** The chop the user is currently "working on": the one whose boundary wins a
 *  coincident-boundary tie (e.g. a pad DUPLICATE's `free` clone sitting exactly on
 *  top of its source) and that gets the selection outline. Prefer an explicit
 *  selection; otherwise fall back to the last pad the user TRIGGERED — tapping/
 *  playing a pad is the natural "edit this one" gesture, and on mobile (no
 *  right-click) it's the only such signal. Sequencer playback schedules audio on a
 *  separate path and never calls triggerPad, so lastTriggeredPad doesn't churn
 *  during playback. */
/** Pad by its NUMBER, not its array position — the pad-source view hands the
 *  waveform a compact pads array (only that source's pads), so `pads[idx]`
 *  would be the wrong pad there. */
const padByIndex = <P extends { index: number; chopId: number | null }>(st: { pads: P[] }, idx: number): P | undefined =>
  st.pads[idx]?.index === idx ? st.pads[idx] : st.pads.find(p => p.index === idx);
/** The pad an edit acts on. MUST stay identical to ChopperEngine.focusedPad() —
 *  what the waveform highlights is what the keyboard edits. (They drifted once:
 *  the keyboard preferred a ringing pad, so a NOTE ON pad being held made the
 *  arrows move a different chop than the highlighted one.) The engine's own
 *  copy is the one to change; this mirrors it because the drawing code works
 *  from the ChopperState snapshot it was handed, not live engine reads. */
const focusedIdx = (st: ChopperState, lastTriggeredPad: number | null): number | null =>
  st.selectedPad ?? lastTriggeredPad;
function activeChop(st: ChopperState, lastTriggeredPad: number | null): Chop | null {
  const idx = focusedIdx(st, lastTriggeredPad);
  if (idx == null) return null;
  const pad = padByIndex(st, idx);
  if (!pad || pad.chopId == null) return null;
  return st.chops.find(c => c.id === pad.chopId) ?? null;
}

/** The active pad's LOOP fades, if it is in LOOP mode: where the nodes sit. */
function activeLoopFades(st: ChopperState, lastTriggeredPad: number | null): { padIdx: number; chop: Chop; fadeIn: number; fadeOut: number } | null {
  const idx = focusedIdx(st, lastTriggeredPad);
  if (idx == null) return null;
  const pad = padByIndex(st, idx);
  if (!pad || pad.chopId == null || pad.mode !== 'loop') return null;
  const chop = st.chops.find(c => c.id === pad.chopId);
  if (!chop) return null;
  const len = Math.max(0, chop.end - chop.start);
  return { padIdx: pad.index, chop, fadeIn: Math.min(len, pad.fadeIn ?? 0), fadeOut: Math.min(len, pad.fadeOut ?? 0) };
}

export function WaveformView({ state, toolbarExtra, buffer, waveformRev, trimMode, trimSel, onTrimSelect, onTrimContextMenu, engine, isPlaying, onSeekChop, onAdjustChop, onSliceTime, onAdjustFade, transients, viewStart, viewEnd, onViewChange, width = 1100, height = 200 }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const draggingRef = useRef<{ chopId: number; side: 'start' | 'end' } | null>(null);
  // LOOP fade-node drag: which pad/side, and the live fade length (seconds).
  const fadeDragRef = useRef<{ padIdx: number; side: 'in' | 'out'; sec: number; lastCommit: number } | null>(null);
  const panRef = useRef<{ clientX: number; vs: number; ve: number; moved: boolean } | null>(null);

  // Per-hit pad activity comes off the engine's own channel rather than the
  // `state` prop: the parent deliberately does NOT re-render on a pad trigger
  // (that cost 12–46ms of main thread per note and made MIDI feel late), so
  // `state.activePads` / `state.lastTriggeredPad` would sit stale here.
  const activity = usePadActivity(engine);
  const lastTriggeredPad = activity?.lastTriggeredPad ?? state.lastTriggeredPad;
  const activePad = (activity?.activePads ?? state.activePads)[0] ?? null;
  const playing = activity?.playing ?? isPlaying;

  // Always-current copies of props — draw reads these so it never has a stale closure
  const viewRef      = useRef({ viewStart, viewEnd });
  const stateRef     = useRef(state);
  const bufferRef    = useRef(buffer);
  const transientsRef = useRef(transients);
  const lastTriggeredPadRef = useRef(lastTriggeredPad);
  viewRef.current      = { viewStart, viewEnd };
  stateRef.current     = state;
  bufferRef.current    = buffer;
  transientsRef.current = transients;
  lastTriggeredPadRef.current = lastTriggeredPad;

  // Live snapMode ref — keeps the drag handlers from reading a stale closure value
  // after the RAF refactor moved them out of the normal React render cycle.
  const snapModeRef = useRef(state.snapMode);
  useEffect(() => { snapModeRef.current = state.snapMode; }, [state.snapMode]);

  // Coarse-pointer (touch / mobile) detection — drives fatter marker lines and
  // larger drag handles + hit targets so chops are finger-draggable on the
  // mobile HardwareView. Read once on mount; the pointer type doesn't change at
  // runtime, and desktop ChopperView stays on the slimmer (still improved) sizes.
  const coarseRef = useRef(false);
  useEffect(() => {
    if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
      coarseRef.current = window.matchMedia('(pointer: coarse)').matches;
    }
  }, []);

  // Precomputed peak buckets — rebuilt only when the buffer changes
  const peaksRef = useRef<{ mn: Float32Array; mx: Float32Array; buckets: number } | null>(null);

  // Drag-position tracking — updated on every pointermove without triggering any
  // React re-renders. The engine is notified only once on pointerup (mouseup).
  const dragChopPosRef = useRef<{ chopId: number; side: 'start' | 'end'; timeSec: number } | null>(null);
  const dragShiftRef   = useRef(false);
  // Throttle gate (perf.now ms) for committing the dragged boundary to the
  // engine MID-drag, so a pad tapped during a drag triggers the up-to-date chop.
  // Visual feedback still updates every frame via dragChopPosRef; this only
  // rate-limits the engine writes (≤20Hz). pointerup commits the exact final value.
  const lastChopUpdateRef = useRef(0);
  // Separate RAF handle for the continuous drag-preview animation loop.
  const dragRafRef = useRef(0);
  // TRIM: the live drag (a = anchor, b = moving edge) + the committed highlight,
  // mirrored into refs so the painter and the pointer handlers see the latest.
  const trimDragRef = useRef<{ a: number; b: number } | null>(null);
  const trimModeRef = useRef(false);
  trimModeRef.current = !!trimMode;
  const trimSelRef = useRef<{ a: number; b: number } | null>(null);
  if (!trimDragRef.current) trimSelRef.current = trimSel ?? null;

  // Offscreen canvas caching the static waveform layer: background + peaks +
  // transients + BPM grid + zoom bar. Rebuilt only when view/buffer/settings
  // change — never on individual drag frames.
  const waveformCacheRef    = useRef<HTMLCanvasElement | null>(null);
  const waveformCacheKeyRef = useRef('');

  // Bucket min/max over buckets [b0, b1) of `buf` into mn/mx.
  const bucketRange = (buf: AudioBuffer, mn: Float32Array, mx: Float32Array, b0: number, b1: number) => {
    const ch0 = buf.getChannelData(0);
    const ch1 = buf.numberOfChannels > 1 ? buf.getChannelData(1) : ch0;
    for (let b = b0; b < b1; b++) {
      const base = b * BUCKET;
      let lo = 0, hi = 0;
      for (let i = 0; i < BUCKET && base + i < buf.length; i++) {
        const s = (ch0[base + i] + ch1[base + i]) * 0.5;
        if (s < lo) lo = s;
        if (s > hi) hi = s;
      }
      mn[b] = lo; mx[b] = hi;
    }
  };
  useEffect(() => {
    if (!buffer) { peaksRef.current = null; return; }
    const buckets = Math.ceil(buffer.length / BUCKET);
    const mn = new Float32Array(buckets);
    const mx = new Float32Array(buckets);
    bucketRange(buffer, mn, mx, 0, buckets);
    engine.takeWaveformDirty(); // a full bucket pass covers any pending patch
    peaksRef.current = { mn, mx, buckets };
    // Invalidate the waveform cache so it rebuilds with the new buffer.
    waveformCacheKeyRef.current = '';
    scheduleRaf();
  }, [buffer]);
  // STEMS: the composite was patched in place — re-bucket only the dirty spans
  // (a stem toggle on one chop costs that chop, not the whole track).
  useEffect(() => {
    const peaks = peaksRef.current;
    if (!buffer || !peaks) return;
    const ranges = engine.takeWaveformDirty();
    if (!ranges.length) return;
    for (const [a, b] of ranges) {
      const b0 = Math.max(0, Math.floor(a / BUCKET));
      const b1 = Math.min(peaks.buckets, Math.ceil(b / BUCKET));
      if (b1 > b0) bucketRange(buffer, peaks.mn, peaks.mx, b0, b1);
    }
    waveformCacheKeyRef.current = '';
    scheduleRaf();
  }, [waveformRev]);

  // RAF handle — ensures at most one canvas draw per animation frame
  const rafRef = useRef(0);
  // Latest drawNow closure, for the playback cursor loop (assigned each render).
  const drawNowRef = useRef<() => void>(() => {});
  const scheduleRaf = () => {
    if (rafRef.current) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = 0;
      drawNow();
    });
  };

  // Trigger a draw whenever any render-relevant prop changes
  useEffect(() => { scheduleRaf(); });

  // Clean up pending RAFs on unmount
  useEffect(() => () => {
    cancelAnimationFrame(rafRef.current);
    cancelAnimationFrame(dragRafRef.current);
  }, []);

  // Draws the static waveform layer onto the offscreen canvas: background,
  // waveform peaks, transient markers, BPM grid, zoom indicator, duration text.
  // These never change during a chop-handle drag, so we cache them.
  const buildWaveformCache = (W: number, H: number) => {
    if (!waveformCacheRef.current) waveformCacheRef.current = document.createElement('canvas');
    const off = waveformCacheRef.current;
    if (off.width !== W || off.height !== H) { off.width = W; off.height = H; }
    const ctx = off.getContext('2d')!;
    const buf = bufferRef.current;
    const st  = stateRef.current;
    const { viewStart: vs, viewEnd: ve } = viewRef.current;

    ctx.fillStyle = '#050508';
    ctx.fillRect(0, 0, W, H);

    if (!buf) {
      ctx.fillStyle = 'rgba(0,255,136,0.4)';
      ctx.font = '11px monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('NO TRACK LOADED — pick a playlist and hit GET SAMPLE', W / 2, H / 2);
      return;
    }

    const dur = buf.duration;
    const viewDur = (ve - vs) * dur;
    const xOf = (t: number) => ((t / dur - vs) / (ve - vs)) * W;

    // Waveform — use precomputed buckets when zoomed out, raw samples when zoomed in
    const peaks = peaksRef.current;
    if (peaks) {
      const startSample = vs * buf.length;
      const endSample   = ve * buf.length;
      const spp = (endSample - startSample) / W; // samples per pixel

      ctx.strokeStyle = '#00ff88';
      ctx.lineWidth = 1;
      ctx.beginPath();

      const normG = st.normalizeGain || 1;
      const yOf = (v: number) => {
        const g = v * normG;
        const clamped = g < -1 ? -1 : g > 1 ? 1 : g;
        return (1 - (clamped + 1) / 2) * H;
      };

      if (spp >= 1) {
        for (let c = 0; c < W; c++) {
          const pxStart = startSample + c * spp;
          const pxEnd   = pxStart + spp;
          const b0 = Math.floor(pxStart / BUCKET);
          const b1 = Math.min(Math.ceil(pxEnd / BUCKET), peaks.buckets);
          let lo = 0, hi = 0;
          for (let b = b0; b < b1; b++) {
            if (peaks.mn[b] < lo) lo = peaks.mn[b];
            if (peaks.mx[b] > hi) hi = peaks.mx[b];
          }
          ctx.moveTo(c, yOf(lo));
          ctx.lineTo(c, yOf(hi));
        }
      } else {
        const ch0 = buf.getChannelData(0);
        const ch1 = buf.numberOfChannels > 1 ? buf.getChannelData(1) : ch0;
        for (let c = 0; c < W; c++) {
          const s0 = Math.max(0, Math.floor(startSample + c * spp));
          const s1 = Math.min(buf.length, Math.max(s0 + 1, Math.ceil(startSample + (c + 1) * spp)));
          let lo = 0, hi = 0;
          for (let i = s0; i < s1; i++) {
            const s = (ch0[i] + ch1[i]) * 0.5;
            if (s < lo) lo = s;
            if (s > hi) hi = s;
          }
          ctx.moveTo(c, yOf(lo));
          ctx.lineTo(c, yOf(hi));
        }
      }

      ctx.shadowBlur = 3;
      ctx.shadowColor = '#00ff88';
      ctx.stroke();
      ctx.shadowBlur = 0;
    }

    // Transient tick marks
    if (st.snapMode === 'transient') {
      const tr = transientsRef.current;
      if (tr && tr.length > 0) {
        ctx.strokeStyle = 'rgba(255, 210, 0, 0.6)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        for (let i = 0; i < tr.length; i++) {
          const x = xOf(tr[i]);
          if (x < 0 || x > W) continue;
          ctx.moveTo(x, 0);
          ctx.lineTo(x, H * 0.35);
        }
        ctx.stroke();
      }
    }

    // BPM grid lines
    if (st.bpm > 0) {
      const beatSec = 60 / st.bpm;
      ctx.strokeStyle = 'rgba(255,255,255,0.04)';
      ctx.lineWidth = 1;
      const startBeat = Math.floor((vs * dur) / beatSec);
      for (let b = startBeat; b * beatSec <= ve * dur; b++) {
        const x = xOf(b * beatSec);
        if (x < 0 || x > W) continue;
        ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke();
      }
    }

    // Zoom indicator bar
    if (ve - vs < 0.99) {
      ctx.fillStyle = 'rgba(0,255,136,0.15)';
      ctx.fillRect(vs * W, H - 4, (ve - vs) * W, 4);
      ctx.fillStyle = 'rgba(0,255,136,0.5)';
      ctx.fillRect(vs * W, H - 4, 2, 4);
      ctx.fillRect(ve * W - 2, H - 4, 2, 4);
    }

    ctx.fillStyle = 'rgba(0,255,136,0.4)';
    ctx.font = '9px monospace';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'bottom';
    ctx.fillText(`${viewDur.toFixed(2)}s view`, W - 4, H - 6);
  };

  const drawNow = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d')!;
    const W = canvas.width;
    const H = canvas.height;
    const buf = bufferRef.current;
    const st  = stateRef.current;
    const { viewStart: vs, viewEnd: ve } = viewRef.current;

    // Rebuild the offscreen waveform cache only when its inputs change —
    // not on every drag frame.
    const cacheKey = `${vs.toFixed(6)}:${ve.toFixed(6)}:${(st.normalizeGain||1).toFixed(4)}:${st.bpm}:${st.snapMode}:${W}:${H}:${buf ? buf.duration : 0}`;
    if (cacheKey !== waveformCacheKeyRef.current) {
      buildWaveformCache(W, H);
      waveformCacheKeyRef.current = cacheKey;
    }

    // Blit the static waveform layer — one cheap GPU drawImage call.
    if (waveformCacheRef.current) {
      ctx.drawImage(waveformCacheRef.current, 0, 0);
    } else {
      ctx.fillStyle = '#050508';
      ctx.fillRect(0, 0, W, H);
    }

    if (!buf) return; // "NO TRACK LOADED" text is already in the cache

    const dur = buf.duration;
    const xOf = (t: number) => ((t / dur - vs) / (ve - vs)) * W;

    // During a chop-handle drag, use the ref position (updated every pointermove)
    // instead of the engine state (not updated until mouseup).
    const liveDrag = dragChopPosRef.current;
    const resolveTime = (chopId: number, side: 'start' | 'end', defaultT: number) =>
      liveDrag && liveDrag.chopId === chopId && liveDrag.side === side
        ? liveDrag.timeSec
        : defaultT;

    // Chop region shading — drawn over the waveform (5% opacity: imperceptible vs under)
    st.chops.forEach((c, i) => {
      const x0 = xOf(resolveTime(c.id, 'start', c.start));
      const x1 = xOf(resolveTime(c.id, 'end', c.end));
      if (x1 < 0 || x0 > W) return;
      ctx.fillStyle = i % 2 === 0 ? 'rgba(0,255,136,0.05)' : 'rgba(0,200,255,0.05)';
      ctx.fillRect(Math.max(0, x0), 0, Math.min(W, x1) - Math.max(0, x0), H);
    });
    // TRIM highlight — the section about to be cut (drag-select in TRIM mode).
    const ts = trimSelRef.current;
    if (ts) {
      const x0 = Math.max(0, xOf(ts.a)), x1 = Math.min(W, xOf(ts.b));
      if (x1 > x0) {
        ctx.fillStyle = 'rgba(255,82,48,0.22)';
        ctx.fillRect(x0, 0, x1 - x0, H);
        ctx.fillStyle = 'rgba(255,82,48,0.95)';
        ctx.fillRect(x0, 0, 1, H);
        ctx.fillRect(x1 - 1, 0, 1, H);
      }
    }

    // Chop boundary lines + labels + draggable grab handles.
    // Markers are sized up (and fattened further on coarse-pointer / mobile) for
    // a finger-friendly target; the actively-dragged boundary flashes bright
    // white so it's obvious which marker is moving in real time.
    const coarse  = coarseRef.current;
    const lineW   = coarse ? 3 : 2;     // boundary line width (was 1)
    const hHalf   = coarse ? 14 : 8;    // top grab-tab half-width (28 / 16 px wide)
    const hHeight = coarse ? 24 : 20;   // top grab-tab height
    const NEON = '0,255,136';

    const roundRectPath = (rx: number, ry: number, rw: number, rh: number, r: number) => {
      const rr = Math.max(0, Math.min(r, rw / 2, rh / 2));
      ctx.beginPath();
      ctx.moveTo(rx + rr, ry);
      ctx.lineTo(rx + rw - rr, ry);
      ctx.arcTo(rx + rw, ry, rx + rw, ry + rr, rr);
      ctx.lineTo(rx + rw, ry + rh - rr);
      ctx.arcTo(rx + rw, ry + rh, rx + rw - rr, ry + rh, rr);
      ctx.lineTo(rx + rr, ry + rh);
      ctx.arcTo(rx, ry + rh, rx, ry + rh - rr, rr);
      ctx.lineTo(rx, ry + rr);
      ctx.arcTo(rx, ry, rx + rr, ry, rr);
      ctx.closePath();
    };

    // Draws one boundary marker: full-height line + a rounded top grab tab (with
    // grip lines) + a smaller bottom tab. `active` = currently being dragged.
    const drawMarker = (x: number, active: boolean) => {
      // Vertical boundary line.
      ctx.strokeStyle = active ? '#ffffff' : `rgba(${NEON},0.75)`;
      ctx.lineWidth = lineW;
      ctx.shadowBlur = active ? 10 : 4;
      ctx.shadowColor = active ? '#ffffff' : `rgba(${NEON},0.6)`;
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke();

      // Top grab handle — a rounded tab signals the marker is draggable.
      ctx.fillStyle = active ? '#ffffff' : `rgba(${NEON},0.95)`;
      roundRectPath(x - hHalf, 0, hHalf * 2, hHeight, Math.min(6, hHalf));
      ctx.fill();
      // Grip lines for affordance (drawn on top, no glow).
      ctx.shadowBlur = 0;
      ctx.strokeStyle = 'rgba(0,0,0,0.45)';
      ctx.lineWidth = 1.5;
      for (const gx of [x - 3, x, x + 3]) {
        ctx.beginPath(); ctx.moveTo(gx, hHeight * 0.32); ctx.lineTo(gx, hHeight * 0.68); ctx.stroke();
      }
      // Bottom grab tab (smaller).
      ctx.fillStyle = active ? '#ffffff' : `rgba(${NEON},0.95)`;
      ctx.shadowBlur = active ? 8 : 3;
      ctx.shadowColor = active ? '#ffffff' : `rgba(${NEON},0.6)`;
      const bH = hHeight * 0.55, bHalf = hHalf * 0.7;
      roundRectPath(x - bHalf, H - bH, bHalf * 2, bH, Math.min(5, bHalf));
      ctx.fill();
      ctx.shadowBlur = 0;
    };

    st.chops.forEach((c, i) => {
      const x0 = xOf(resolveTime(c.id, 'start', c.start));
      if (x0 >= 0 && x0 <= W) {
        const active = !!liveDrag && liveDrag.chopId === c.id && liveDrag.side === 'start';
        drawMarker(x0, active);
        const pad = st.pads.find(p => p.chopId === c.id);
        // The number on the waveform is the PAD's number (his call: a break on
        // pad 5 reads 05 on its first chop, not 01) — the chop's ordinal only
        // when no pad holds it.
        const label = String((pad ? pad.index : i) + 1).padStart(2, '0');
        ctx.fillStyle = pad ? pad.color : 'rgba(0,255,136,0.8)';
        ctx.font = '10px monospace';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'top';
        // Sit the label just below the (now taller) top grab tab.
        ctx.fillText(label, Math.max(2, x0 + hHalf + 3), hHeight + 2);
      }
    });
    // End-boundary grab handles for ends that AREN'T another chop's start: the
    // contiguous chain's final end (the buffer edge) + every `free` clone's end
    // (free chops are independent, so their end isn't a neighbour's start either).
    const lastChain = [...st.chops].reverse().find(c => !c.free);
    const endChops = st.chops.filter(c => c.free);
    if (lastChain) endChops.push(lastChain);
    for (const c of endChops) {
      const xEnd = xOf(resolveTime(c.id, 'end', c.end));
      if (xEnd >= 0 && xEnd <= W) {
        const active = !!liveDrag && liveDrag.chopId === c.id && liveDrag.side === 'end';
        drawMarker(xEnd, active);
      }
    }

    // Active-pad highlight — outlines the chop that boundary drags will target
    // (selected pad, else last-triggered). Kept in lockstep with the hit-test
    // tiebreak below so what's outlined is exactly what moves on a drag.
    const actChop = activeChop(st, lastTriggeredPadRef.current);
    if (actChop) {
      const x0 = xOf(resolveTime(actChop.id, 'start', actChop.start));
      const x1 = xOf(resolveTime(actChop.id, 'end', actChop.end));
      ctx.strokeStyle = '#cc00ff';
      ctx.lineWidth = 2;
      ctx.shadowBlur = 8; ctx.shadowColor = '#cc00ff';
      ctx.strokeRect(Math.max(1, x0 + 1), 1, x1 - x0 - 2, H - 2);
      ctx.shadowBlur = 0;
      // CHOP LENGTH in the box (his queue item "pink box chop-length"): seconds,
      // and beats at the session tempo when there is one — so a chop can be
      // trimmed to exactly a bar / two beats by eye. Inside the box, top-left,
      // on a dark tab so it reads over any waveform; hidden when the box is too
      // narrow to carry it.
      const durSec = Math.max(0, resolveTime(actChop.id, 'end', actChop.end) - resolveTime(actChop.id, 'start', actChop.start));
      const boxW = x1 - x0;
      if (boxW > 54 && durSec > 0) {
        const beats = st.bpm > 0 ? durSec / (60 / st.bpm) : 0;
        const beatTxt = beats > 0 ? (Math.abs(beats - Math.round(beats)) < 0.02 ? ` · ${Math.round(beats)} beat${Math.round(beats) === 1 ? '' : 's'}` : ` · ${beats.toFixed(2)} beats`) : '';
        const txt = `${durSec < 10 ? durSec.toFixed(2) : durSec.toFixed(1)} s${boxW > 110 ? beatTxt : ''}`;
        ctx.font = '600 9px ui-monospace, Menlo, monospace';
        const tw = ctx.measureText(txt).width;
        const tx = Math.max(1, x0 + 1) + 3, ty = 3;
        ctx.fillStyle = 'rgba(0,0,0,0.62)';
        ctx.fillRect(tx - 2, ty, tw + 6, 12);
        ctx.fillStyle = '#ff8cff';
        ctx.textBaseline = 'top';
        ctx.fillText(txt, tx + 1, ty + 2);
      }
    }

    // LOOP FADES — two nodes on the active pad's chop when it is in LOOP mode:
    // fade-in rises from the start, fade-out falls into the end. Shaded ramps
    // + a grab knob each; while dragging the live value is drawn.
    const lf = activeLoopFades(st, lastTriggeredPadRef.current);
    if (lf) {
      const fd = fadeDragRef.current;
      const fadeIn = fd && fd.padIdx === lf.padIdx && fd.side === 'in' ? fd.sec : lf.fadeIn;
      const fadeOut = fd && fd.padIdx === lf.padIdx && fd.side === 'out' ? fd.sec : lf.fadeOut;
      const xs = xOf(resolveTime(lf.chop.id, 'start', lf.chop.start));
      const xe = xOf(resolveTime(lf.chop.id, 'end', lf.chop.end));
      const secPx = W / ((viewRef.current.viewEnd - viewRef.current.viewStart) * dur);
      const xi = xs + fadeIn * secPx;
      const xo = xe - fadeOut * secPx;
      const yTop = 4, yBot = H - 4;
      ctx.save();
      // ramps
      ctx.fillStyle = 'rgba(204,0,255,0.16)';
      ctx.beginPath(); ctx.moveTo(xs, yBot); ctx.lineTo(xi, yTop); ctx.lineTo(xi, yBot); ctx.closePath(); ctx.fill();
      ctx.beginPath(); ctx.moveTo(xe, yBot); ctx.lineTo(xo, yTop); ctx.lineTo(xo, yBot); ctx.closePath(); ctx.fill();
      ctx.strokeStyle = 'rgba(204,0,255,0.9)'; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(xs, yBot); ctx.lineTo(xi, yTop); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(xe, yBot); ctx.lineTo(xo, yTop); ctx.stroke();
      // knobs (drawn on-canvas at the top of each ramp)
      const knob = (x: number, active: boolean) => {
        ctx.fillStyle = active ? '#ffffff' : '#cc00ff';
        ctx.shadowBlur = active ? 10 : 6; ctx.shadowColor = '#cc00ff';
        ctx.beginPath(); ctx.arc(x, yTop + 7, active ? 7 : 6, 0, Math.PI * 2); ctx.fill();
        ctx.shadowBlur = 0;
        ctx.fillStyle = '#000'; ctx.font = 'bold 8px monospace'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText('~', x, yTop + 7.5);
      };
      knob(xi, !!fd && fd.side === 'in');
      knob(xo, !!fd && fd.side === 'out');
      // readout
      ctx.fillStyle = 'rgba(204,0,255,0.95)'; ctx.font = '9px monospace'; ctx.textAlign = 'center'; ctx.textBaseline = 'top';
      ctx.fillText(`FADE ${Math.round(fadeIn * 1000)} ms`, xi, yTop + 17);
      ctx.fillText(`FADE ${Math.round(fadeOut * 1000)} ms`, xo, yTop + 17);
      ctx.restore();
    }

    // Playback cursor — reads live engine position, no React state involved
    const playhead = engine.getPlayheadPos();
    if (playhead >= 0 && playhead <= dur) {
      const xC = xOf(playhead);
      if (xC >= 0 && xC <= W) {
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 2;
        ctx.shadowBlur = 10; ctx.shadowColor = '#ffffff';
        ctx.beginPath(); ctx.moveTo(xC, 0); ctx.lineTo(xC, H); ctx.stroke();
        ctx.shadowBlur = 0;
        ctx.fillStyle = '#ffffff';
        ctx.beginPath();
        ctx.moveTo(xC - 5, 0); ctx.lineTo(xC + 5, 0); ctx.lineTo(xC, 6); ctx.closePath(); ctx.fill();
        ctx.beginPath();
        ctx.moveTo(xC - 5, H); ctx.lineTo(xC + 5, H); ctx.lineTo(xC, H - 6); ctx.closePath(); ctx.fill();
      }
    }
  };

  // Keep a ref to the latest drawNow so the playback loop below always calls the
  // current closure (props/refs up to date) without re-arming every render.
  drawNowRef.current = drawNow;

  // Cursor animation: while a voice is sounding, repaint every frame reading the
  // live engine.getPlayheadPos() — NO React state, NO array cloning.
  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    const tick = () => {
      drawNowRef.current();
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing]);

  // Resize canvas when dimensions change
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.width  = width;
    canvas.height = height;
    // Invalidate cache so it rebuilds at the new size.
    waveformCacheKeyRef.current = '';
    scheduleRaf();
  }, [width, height]);

  // Auto-scroll to show the active pad's chop
  const lastActivePadRef = useRef<number | null>(null);
  useEffect(() => {
    const buf = bufferRef.current;
    const st  = stateRef.current;
    if (!buf) return;
    if (activePad === lastActivePadRef.current) return;
    lastActivePadRef.current = activePad;
    if (activePad === null) return;
    const pad = padByIndex(st, activePad);
    if (!pad || pad.chopId === null) return;
    const chop = st.chops.find(c => c.id === pad.chopId);
    if (!chop) return;
    const dur = buf.duration;
    const cs = chop.start / dur, ce = chop.end / dur;
    const { viewStart: vs, viewEnd: ve } = viewRef.current;
    if (cs >= vs && ce <= ve) return;
    const span = ve - vs;
    const padding = span * 0.1;
    let ns = Math.max(0, cs - padding);
    let ne = ns + span;
    if (ne > 1) { ne = 1; ns = Math.max(0, ne - span); }
    onViewChange(ns, ne);
  }, [activePad]);

  // Trackpad + wheel on the waveform (his ask, 2026-08-19: "as smooth as my
  // fingers on the trackpad"):
  //   • two-finger scroll left/right (deltaX)      → PAN, 1:1 with the fingers
  //   • pinch (macOS/Chromium report it as a wheel with ctrlKey) → ZOOM,
  //     continuous, anchored under the pointer
  //   • plain vertical wheel (a mouse wheel, or two fingers up/down) → ZOOM,
  //     continuous too — no more 1.25× jumps per tick
  // Every event moves the view by an amount proportional to its delta, so a
  // trackpad's stream of small deltas reads as one smooth motion.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    // Wheel events arrive faster than we can re-render the view (a trackpad
    // streams 60–120/s; each view change re-renders the chopper). Coalesce
    // them: accumulate deltas, apply once per animation frame — nothing is
    // dropped, the motion stays 1:1, and the frame rate stays even.
    let pending: { dx: number; dy: number; x: number; pinch: boolean } | null = null;
    let raf = 0;
    const apply = () => {
      raf = 0;
      const p = pending; pending = null;
      if (!p) return;
      const rect = canvas.getBoundingClientRect();
      const { viewStart: vs, viewEnd: ve } = viewRef.current;
      const span = ve - vs;
      const { dx, dy, pinch } = p;
      if (!pinch && Math.abs(dx) > Math.abs(dy)) {
        // PAN: fingers move the content — drag right shows earlier audio.
        const frac = (dx / rect.width) * span;
        let ns = vs + frac, ne = ve + frac;
        if (ns < 0) { ns = 0; ne = span; }
        if (ne > 1) { ne = 1; ns = 1 - span; }
        if (ns !== vs) onViewChange(ns, ne);
        return;
      }
      // ZOOM: continuous. Pinch deltas are small (~1–10 per event) and a mouse
      // notch is ~100, so scale them differently to land at a similar feel.
      const k = pinch ? 0.012 : 0.0025;
      const factor = Math.exp(Math.max(-60, Math.min(60, dy)) * k);
      const mouseNorm = Math.max(0, Math.min(1, (p.x - rect.left) / rect.width));
      const anchor = vs + mouseNorm * span;
      const newSpan = Math.min(1, Math.max(0.002, span * factor));
      if (newSpan === span) return;
      let ns = anchor - mouseNorm * newSpan;
      let ne = ns + newSpan;
      if (ns < 0) { ns = 0; ne = newSpan; }
      if (ne > 1) { ne = 1; ns = 1 - newSpan; }
      onViewChange(ns, ne);
    };
    const onWheel = (e: WheelEvent) => {
      if (!bufferRef.current) return;
      e.preventDefault();
      const rect = canvas.getBoundingClientRect();
      // Lines/pages → pixels-ish so a mouse wheel in line mode still moves.
      const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? rect.height : 1;
      let dx = e.deltaX * unit, dy = e.deltaY * unit;
      // Shift + vertical wheel = horizontal (the usual convention).
      if (e.shiftKey && !e.ctrlKey && Math.abs(dx) < Math.abs(dy)) { dx = dy; dy = 0; }
      const pinch = e.ctrlKey || e.metaKey;
      // A gesture change (pan ↔ pinch) flushes what was pending so they never mix.
      if (pending && pending.pinch !== pinch) apply();
      if (!pending) pending = { dx: 0, dy: 0, x: e.clientX, pinch };
      pending.dx += dx; pending.dy += dy; pending.x = e.clientX;
      if (!raf) raf = requestAnimationFrame(apply);
    };
    canvas.addEventListener('wheel', onWheel, { passive: false });
    return () => { canvas.removeEventListener('wheel', onWheel); if (raf) cancelAnimationFrame(raf); };
  }, []);

  // Snap a time value to the nearest transient, mirroring ChopperEngine.snapToTransient.
  // Only called when snapModeRef.current !== 'off'.
  const snapToNearestTransient = (timeSec: number): number => {
    const tr = transientsRef.current;
    if (!tr || tr.length === 0) return timeSec;
    let lo = 0, hi = tr.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (tr[mid] < timeSec) lo = mid + 1; else hi = mid;
    }
    const windowSec = 0.25;
    let best = timeSec, bestDist = windowSec;
    for (const idx of [lo - 1, lo, lo + 1]) {
      if (idx < 0 || idx >= tr.length) continue;
      const dist = Math.abs(tr[idx] - timeSec);
      if (dist < bestDist) { bestDist = dist; best = tr[idx]; }
    }
    return best;
  };

  // Multi-pointer state for pinch-to-zoom.
  const activePtrs = useRef<Map<number, { x: number }>>(new Map());
  const pinchRef = useRef<{
    startDist: number; startVs: number; startVe: number; anchor: number;
  } | null>(null);

  const handlePointerDown = (e: React.PointerEvent) => {
    const buf = bufferRef.current;
    const st  = stateRef.current;
    if (!buf) return;
    const canvas = canvasRef.current;
    if (!canvas) return;

    activePtrs.current.set(e.pointerId, { x: e.clientX });
    if (activePtrs.current.size === 2) {
      draggingRef.current = null;
      panRef.current = null;
      const pts = Array.from(activePtrs.current.values());
      const dist = Math.max(1, Math.abs(pts[0].x - pts[1].x));
      const midX = (pts[0].x + pts[1].x) / 2;
      const rect = canvas.getBoundingClientRect();
      const anchor = Math.max(0, Math.min(1, (midX - rect.left) / rect.width));
      pinchRef.current = {
        startDist: dist,
        startVs: viewRef.current.viewStart,
        startVe: viewRef.current.viewEnd,
        anchor,
      };
      return;
    }

    try { canvas.setPointerCapture(e.pointerId); } catch { /* */ }
    const rect = canvas.getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * canvas.width;
    const { viewStart: vs, viewEnd: ve } = viewRef.current;
    // Touch / coarse-pointer (mobile) gets a 28px hit half-width (56px window);
    // mouse uses the slimmer HANDLE_PX (still wider than before).
    const cssHandleCss = (e.pointerType === 'touch' || coarseRef.current) ? 28 : HANDLE_PX;
    const handleCanvasPx = cssHandleCss * (canvas.width / rect.width);
    // Check the ACTIVE pad's chop first, so a duplicate's `free` clone (which
    // initially overlaps its source at the same boundary position) is the one
    // grabbed and dragged apart — otherwise the source (earlier in array order)
    // always wins the position tie. "Active" = explicitly selected pad, else the
    // last pad the user tapped/played (the only such signal on mobile, where
    // tapping a pad — not a right-click — is how you pick the pad to edit).
    // LOOP fade nodes win over the chop handles (they sit inside the chop, and
    // at fade 0 they overlap its boundary — the node is the thing you see).
    // TRIM armed: a left-drag highlights a section — wins over fade nodes,
    // chop handles, pan and the tap-to-slice (nothing else should fire).
    if (trimModeRef.current && e.button === 0) {
      const t = Math.max(0, Math.min(buf.duration, (vs + (px / canvas.width) * (ve - vs)) * buf.duration));
      trimDragRef.current = { a: t, b: t };
      trimSelRef.current = null;
      canvas.style.cursor = 'crosshair';
      drawNowRef.current();
      return;
    }
    const lf = onAdjustFade ? activeLoopFades(st, lastTriggeredPadRef.current) : null;
    if (lf) {
      const secPx = canvas.width / ((ve - vs) * buf.duration);
      const xs = (lf.chop.start / buf.duration - vs) / (ve - vs) * canvas.width;
      const xe = (lf.chop.end / buf.duration - vs) / (ve - vs) * canvas.width;
      const xi = xs + lf.fadeIn * secPx, xo = xe - lf.fadeOut * secPx;
      const py = ((e.clientY - rect.top) / rect.height) * canvas.height;
      const nearTop = py < canvas.height * 0.45; // the knobs live in the top half
      const dIn = Math.abs(px - xi), dOut = Math.abs(px - xo);
      if (nearTop && Math.min(dIn, dOut) < handleCanvasPx) {
        const side: 'in' | 'out' = dIn <= dOut ? 'in' : 'out';
        fadeDragRef.current = { padIdx: lf.padIdx, side, sec: side === 'in' ? lf.fadeIn : lf.fadeOut, lastCommit: 0 };
        canvas.style.cursor = 'ew-resize';
        return;
      }
    }
    const selChop = activeChop(st, lastTriggeredPadRef.current);
    const ordered = selChop ? [selChop, ...st.chops.filter(c => c !== selChop)] : st.chops;
    for (const c of ordered) {
      const xs = ((c.start / buf.duration - vs) / (ve - vs)) * canvas.width;
      const xe = ((c.end   / buf.duration - vs) / (ve - vs)) * canvas.width;
      if (Math.abs(px - xs) < handleCanvasPx) { draggingRef.current = { chopId: c.id, side: 'start' }; engine.setWaveformLive(true); return; }
      if (Math.abs(px - xe) < handleCanvasPx) { draggingRef.current = { chopId: c.id, side: 'end' }; engine.setWaveformLive(true); return; }
    }
    panRef.current = { clientX: e.clientX, vs, ve, moved: false };
  };

  const handlePointerMove = (e: React.PointerEvent) => {
    if (activePtrs.current.has(e.pointerId)) {
      activePtrs.current.set(e.pointerId, { x: e.clientX });
    }
    const td = trimDragRef.current;
    if (td) {
      const canvas = canvasRef.current; const buf = bufferRef.current;
      if (!canvas || !buf) return;
      const rect = canvas.getBoundingClientRect();
      const px = ((e.clientX - rect.left) / rect.width) * canvas.width;
      const { viewStart: vs, viewEnd: ve } = viewRef.current;
      td.b = Math.max(0, Math.min(buf.duration, (vs + (px / canvas.width) * (ve - vs)) * buf.duration));
      trimSelRef.current = { a: Math.min(td.a, td.b), b: Math.max(td.a, td.b) };
      scheduleRaf();
      return;
    }
    if (pinchRef.current && activePtrs.current.size >= 2) {
      const pts = Array.from(activePtrs.current.values()).slice(0, 2);
      const dist = Math.max(1, Math.abs(pts[0].x - pts[1].x));
      const factor = pinchRef.current.startDist / dist;
      const startSpan = pinchRef.current.startVe - pinchRef.current.startVs;
      const newSpan = Math.max(0.005, Math.min(1, startSpan * factor));
      const anchorAbs = pinchRef.current.startVs + pinchRef.current.anchor * startSpan;
      let ns = anchorAbs - pinchRef.current.anchor * newSpan;
      let ne = ns + newSpan;
      if (ns < 0) { ns = 0; ne = newSpan; }
      if (ne > 1) { ne = 1; ns = Math.max(0, ne - newSpan); }
      onViewChange(ns, ne);
      return;
    }
    const buf = bufferRef.current;
    const fd = fadeDragRef.current;
    if (fd && buf && onAdjustFade) {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const st = stateRef.current;
      const lf = activeLoopFades(st, lastTriggeredPadRef.current);
      if (!lf || lf.padIdx !== fd.padIdx) return;
      const rect = canvas.getBoundingClientRect();
      const px = ((e.clientX - rect.left) / rect.width) * canvas.width;
      const { viewStart: vs, viewEnd: ve } = viewRef.current;
      const timeSec = Math.max(0, Math.min(1, vs + (px / canvas.width) * (ve - vs))) * buf.duration;
      const len = Math.max(0, lf.chop.end - lf.chop.start);
      // The two may cross (a full crossfade): each runs the whole chop.
      const sec = Math.max(0, Math.min(len, fd.side === 'in' ? timeSec - lf.chop.start : lf.chop.end - timeSec));
      fd.sec = sec;
      // live: the engine hears the new crossfade on the next hit; the emit is
      // rAF-coalesced and pushHistory is grouped per pad — one undo step
      const now = performance.now();
      if (now - fd.lastCommit > 50) { fd.lastCommit = now; onAdjustFade(fd.padIdx, fd.side, sec); }
      drawNowRef.current();
      return;
    }
    const dragInfo = draggingRef.current;
    if (dragInfo && buf) {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
      const px = ((e.clientX - rect.left) / rect.width) * canvas.width;
      const { viewStart: vs, viewEnd: ve } = viewRef.current;
      const frac = Math.max(0, Math.min(1, vs + (px / canvas.width) * (ve - vs)));
      let dragTimeSec = frac * buf.duration;
      // Apply transient snap to the drag preview — but only when SNAP is on and
      // Shift is not held (Shift = explicit free-move override).
      if (snapModeRef.current !== 'off' && !e.shiftKey) {
        dragTimeSec = snapToNearestTransient(dragTimeSec);
      }
      // Write drag position into a ref — zero React state updates, zero re-renders.
      dragChopPosRef.current = { chopId: dragInfo.chopId, side: dragInfo.side, timeSec: dragTimeSec };
      dragShiftRef.current = e.shiftKey;
      // Live audio: also commit the boundary to the engine mid-drag (throttled to
      // ≤20Hz) so a pad tapped DURING the drag hears the up-to-date chop. No
      // pointerType gate — desktop benefits too. The engine coalesces these into a
      // single undo step (pushHistory group key), and emit() at this rate is fine
      // because the visual drag loop is ref-driven, not state-driven. pointerup
      // still commits the exact final value below, even if the last window skipped.
      const now = performance.now();
      if (now - lastChopUpdateRef.current >= 50) {
        lastChopUpdateRef.current = now;
        const freeMove = e.shiftKey || snapModeRef.current === 'off';
        onAdjustChop(dragInfo.chopId, dragInfo.side, dragTimeSec, freeMove);
      }
      // Start the drag RAF loop if not already running. The loop sustains itself
      // while draggingRef is set, then self-terminates on the frame after mouseup.
      if (!dragRafRef.current) {
        const tick = () => {
          drawNowRef.current();
          if (draggingRef.current) {
            dragRafRef.current = requestAnimationFrame(tick);
          } else {
            // Drag ended — draw one final frame with the committed position, then stop.
            dragChopPosRef.current = null;
            dragRafRef.current = 0;
          }
        };
        dragRafRef.current = requestAnimationFrame(tick);
      }
      return;
    }
    const pan = panRef.current;
    if (!pan || !buf) return;
    const dx = e.clientX - pan.clientX;
    if (Math.abs(dx) > 3) pan.moved = true;
    if (!pan.moved) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.style.cursor = 'grabbing';
    const rect = canvas.getBoundingClientRect();
    const span = pan.ve - pan.vs;
    const shift = -(dx / rect.width) * span;
    let ns = pan.vs + shift, ne = pan.ve + shift;
    if (ns < 0) { ns = 0; ne = span; }
    if (ne > 1) { ne = 1; ns = 1 - span; }
    onViewChange(ns, ne);
    pan.clientX = e.clientX; pan.vs = ns; pan.ve = ne;
  };

  const handlePointerUp = (e: React.PointerEvent) => {
    activePtrs.current.delete(e.pointerId);
    if (pinchRef.current && activePtrs.current.size < 2) {
      pinchRef.current = null;
      panRef.current = null;
      draggingRef.current = null;
      dragChopPosRef.current = null;
      engine.setWaveformLive(false);
      return;
    }
    const canvas = canvasRef.current;
    if (canvas) {
      try { if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId); } catch { /* */ }
      canvas.style.cursor = trimModeRef.current ? 'crosshair' : 'grab';
    }
    const td = trimDragRef.current;
    if (td) {
      trimDragRef.current = null;
      const a = Math.min(td.a, td.b), b = Math.max(td.a, td.b);
      const sel = b - a >= 0.02 ? { a, b } : null; // a click with no drag clears
      trimSelRef.current = sel;
      onTrimSelect?.(sel);
      panRef.current = null;
      draggingRef.current = null;
      drawNowRef.current();
      return;
    }
    draggingRef.current = null;
    engine.setWaveformLive(false); // the release commit below repaints the composite once
    const fd = fadeDragRef.current;
    if (fd) {
      fadeDragRef.current = null;
      onAdjustFade?.(fd.padIdx, fd.side, fd.sec);
      drawNowRef.current();
      return;
    }
    // Commit the final drag position to the engine — single update on mouseup,
    // not once per mousemove. The drag RAF loop clears dragChopPosRef on its
    // next tick once it sees draggingRef is null.
    const finalDrag = dragChopPosRef.current;
    if (finalDrag && bufferRef.current) {
      // Pass freeMove=true when snap is off OR shift is held — tells the engine to
      // skip its own applySnap (snap was already applied in the drag preview, or
      // snap is intentionally disabled).
      const freeMove = dragShiftRef.current || snapModeRef.current === 'off';
      onAdjustChop(finalDrag.chopId, finalDrag.side, finalDrag.timeSec, freeMove);
    }
    const pan = panRef.current;
    panRef.current = null;
    const buf = bufferRef.current;
    const st  = stateRef.current;
    if (pan && !pan.moved && buf && canvas && onSliceTime) {
      // Every tap drops a new chop boundary at the cursor.
      const rect = canvas.getBoundingClientRect();
      const px = ((e.clientX - rect.left) / rect.width) * canvas.width;
      const { viewStart: vs, viewEnd: ve } = viewRef.current;
      const t = (vs + (px / canvas.width) * (ve - vs)) * buf.duration;
      onSliceTime(t);
    }
    void onSeekChop; // kept on the props for future use; no longer fires on tap
    void st;
  };

  // Center zoom on the last-hit pad's chop start, falling back to the view midpoint.
  const zoomCenterFrac = (): number => {
    const { viewStart: vs, viewEnd: ve } = viewRef.current;
    const mid = (vs + ve) / 2;
    if (!buffer) return mid;
    const idx = lastTriggeredPad;
    if (idx == null) return mid;
    const pad = padByIndex(state, idx);
    if (!pad || pad.chopId == null) return mid;
    const chop = state.chops.find(c => c.id === pad.chopId);
    return chop ? chop.start / buffer.duration : mid;
  };
  const zoomIn  = () => { const { viewStart: vs, viewEnd: ve } = viewRef.current; const mid = zoomCenterFrac(), span = (ve-vs)*0.6; const ns = Math.max(0,mid-span/2); onViewChange(ns, Math.min(1,ns+span)); };
  const zoomOut = () => { const { viewStart: vs, viewEnd: ve } = viewRef.current; const mid = zoomCenterFrac(), span = Math.min(1,(ve-vs)*1.6); const ns = Math.max(0,mid-span/2); onViewChange(ns, Math.min(1,ns+span)); };
  const resetZoom = () => onViewChange(0, 1);

  return (
    <div className="waveform-wrap">
      <div className="waveform-zoom-bar">
        <button className="btn-zoom" onClick={zoomIn} title="Zoom in (scroll)">+</button>
        <button className="btn-zoom" onClick={zoomOut} title="Zoom out (scroll)">−</button>
        <button className="btn-zoom" onClick={resetZoom} title="Reset zoom">FIT</button>
        <span className="zoom-level">{Math.round(100 / (viewEnd - viewStart))}×</span>
        {state.trackTitle && (
          <span className="waveform-track-title" title={state.trackTitle}>
            {state.trackTitle}
            {state.bpm > 0 && <span className="waveform-track-bpm">{Math.round(state.bpm)}</span>}
          </span>
        )}
        {toolbarExtra}
      </div>
      <canvas
        ref={canvasRef}
        width={width}
        height={height}
        className="chopper-waveform"
        // touch-action: none stops mobile browsers from hijacking the gesture
        // for scrolling / pinch-zoom so the drag stays in our handlers.
        style={{ cursor: trimMode ? 'crosshair' : 'grab', touchAction: 'none' }}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        onContextMenu={e => {
          // TRIM: right-click on the highlight → DELETE SECTION / DESELECT menu.
          if (trimModeRef.current && trimSelRef.current && onTrimContextMenu) { e.preventDefault(); onTrimContextMenu(e.clientX, e.clientY); }
        }}
        onDoubleClick={e => {
          // Double-click still slices anywhere — even inside an existing chop.
          if (trimModeRef.current) return; // TRIM owns the pointer
          const buf = bufferRef.current;
          if (!buf || !onSliceTime) return;
          const canvas = canvasRef.current;
          if (!canvas) return;
          const rect = canvas.getBoundingClientRect();
          const px = ((e.clientX - rect.left) / rect.width) * canvas.width;
          const { viewStart: vs, viewEnd: ve } = viewRef.current;
          const timeSec = (vs + (px / canvas.width) * (ve - vs)) * buf.duration;
          onSliceTime(timeSec);
        }}
      />
    </div>
  );
}
