// PIANO ROLL — canvas note editor for the BASS engine's patterns.
//
// Built to make bass lines fast: click = note (last length), drag on empty =
// draw a length, drag a note = move (pitch snaps to the KEY when the lock is
// on), drag its right edge = resize, right-click / ALT-click = erase (drag to
// erase a run), CMD/CTRL-drag up-down on a note = velocity, CMD/CTRL-drag on
// empty = RECTANGLE SELECT (SHIFT adds), SHIFT-click = add to the selection,
// ALT-drag a SELECTED note = duplicate the selection and drag the copies,
// DOUBLE-CLICK a note = delete it, DELETE = remove, ↑/↓ = transpose the
// selection by a SCALE step (semitone when chromatic; SHIFT = octave), ←/→ =
// nudge by a grid step (a 1/16 beat when the grid is OFF), S = toggle SLIDE on
// the selection, CMD/CTRL-A = all. GRID OFF = nothing snaps (drawing, moving,
// live recording). The SLIDE tool draws FL-style slide notes (◢): they trigger
// nothing — what's sounding bends to their pitch over their length. The
// keyboard column auditions. FOLD hides out-of-key rows. The playhead is a
// ref-driven rAF read of the engine — no per-tick setState.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { BassEngine, BassNote, BassState, BASS_HIGH, BASS_LOW, bendAt } from './BassEngine';
import { inScale, isBlackKey, noteName, scaleDegree, scaleNotesInRange, snapToScale, stepInScale } from './theory.mts';

export type RollTool = 'draw' | 'erase' | 'vel' | 'slide';

interface Props {
  engine: BassEngine;
  state: BassState;
  fold: boolean;
  height?: number;
  accent: string;   // resolved CSS colour for notes
  /** Touch-friendly tool switch (the toolbar): DRAW = default; ERASE = tap/drag
   *  removes (what right-click does with a mouse); VEL = drag up/down on a note
   *  sets velocity (what CMD-drag does). */
  tool?: RollTool;
  compact?: boolean;
  /** Show the PITCH BEND automation lane under the roll (draw: click/drag;
   *  erase: right-click/ALT drag). Range comes from state.bendRange. */
  bendLane?: boolean;
}


type Drag =
  | { kind: 'move'; x0: number; y0: number; snapshot: BassNote[]; moved: boolean; rowIdx0: number;
      /** TOUCH: this tap landed on the already-selected note — released without
       *  moving it deletes (tap a note, tap it again = gone). */
      retap?: boolean }
  | { kind: 'resize'; x0: number; snapshot: BassNote[] }
  | { kind: 'draw'; id: number; startBeat: number }
  | { kind: 'erase' }
  | { kind: 'vel'; y0: number; snapshot: BassNote[] }
  | { kind: 'marquee'; x0: number; y0: number; x1: number; y1: number; base: Set<number> }
  | { kind: 'scroll'; y0: number; top0: number };

export function PianoRoll({ engine, state, fold, height = 234, accent, tool = 'draw', compact, bendLane = false }: Props) {
  // Row height: 13px with a mouse; 18px for fingers.
  const ROW_H = compact ? 18 : 13;
  const KEY_W = compact ? 44 : 50;
  const LANE_H = compact ? 72 : 60;
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const laneRef = useRef<HTMLCanvasElement>(null);
  // BEND lane drag: 'draw' writes a point per move, 'erase' clears the swept range.
  const [laneDrag, setLaneDrag] = useState<null | { kind: 'draw' | 'erase'; lastBeat: number }>(null);
  const [width, setWidth] = useState(800);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [topRow, setTopRow] = useState<number | null>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const lastDurRef = useRef<number>(0);
  const hoverRef = useRef<{ x: number; y: number } | null>(null);
  const [, bump] = useState(0);

  const pat = state.patterns[state.currentIdx] ?? state.patterns[0];
  const bars = pat.bars;
  const loopBeats = bars * 4;
  // 0 = grid OFF: nothing snaps. `stepBeats` is what drawing / nudging fall
  // back to for a default length / nudge when there is no grid.
  const gridBeats = state.grid > 0 ? 1 / state.grid : 0;
  const stepBeats = gridBeats || 0.25;
  const nudgeBeats = gridBeats || 1 / 16;
  const key = state.key;
  const lock = state.lock;

  // Rows: top = highest note.
  const rows = useMemo(() => {
    const list = fold && key.scale !== 'chromatic' ? scaleNotesInRange(BASS_LOW, BASS_HIGH, key) : Array.from({ length: BASS_HIGH - BASS_LOW + 1 }, (_, i) => BASS_LOW + i);
    return list.reverse();
  }, [fold, key]);
  const rowOf = useCallback((midi: number) => rows.indexOf(midi), [rows]);
  const visibleRows = Math.floor(height / ROW_H);
  // default: centre on C2 (36) — where bass lives
  const defaultTop = Math.max(0, Math.min(rows.length - visibleRows, rowOf(36) - Math.floor(visibleRows * 0.55)));
  const top = Math.max(0, Math.min(Math.max(0, rows.length - visibleRows), topRow ?? defaultTop));

  useEffect(() => {
    const el = wrapRef.current; if (!el) return;
    const ro = new ResizeObserver(() => setWidth(Math.max(320, el.clientWidth)));
    ro.observe(el);
    setWidth(Math.max(320, el.clientWidth));
    return () => ro.disconnect();
  }, []);

  const gridW = width - KEY_W;
  const beatW = gridW / loopBeats;
  const xOfBeat = (b: number) => KEY_W + b * beatW;
  const beatOfX = (x: number) => (x - KEY_W) / beatW;
  const yOfRow = (r: number) => (r - top) * ROW_H;
  const rowOfY = (y: number) => Math.floor(y / ROW_H) + top;
  const snapBeat = (b: number, floor = true) => gridBeats > 0 ? (floor ? Math.floor(b / gridBeats + 1e-6) : Math.round(b / gridBeats)) * gridBeats : b;

  const hitNote = (x: number, y: number): { note: BassNote; edge: boolean } | null => {
    const r = rowOfY(y);
    const midi = rows[r];
    if (midi === undefined) return null;
    const b = beatOfX(x);
    // last-drawn wins → iterate reversed so overlapping later notes are picked
    for (let i = pat.notes.length - 1; i >= 0; i--) {
      const n = pat.notes[i];
      if (n.note !== midi) continue;
      if (b >= n.start && b < n.start + n.dur) {
        const x1 = xOfBeat(n.start + n.dur);
        const w = n.dur * beatW;
        const edge = x >= x1 - Math.min(7, Math.max(3, w * 0.35));
        return { note: n, edge };
      }
    }
    return null;
  };

  // ── draw ──
  const draw = useCallback(() => {
    const cv = canvasRef.current; if (!cv) return;
    const dpr = window.devicePixelRatio || 1;
    if (cv.width !== Math.round(width * dpr) || cv.height !== Math.round(height * dpr)) {
      cv.width = Math.round(width * dpr); cv.height = Math.round(height * dpr);
      cv.style.width = `${width}px`; cv.style.height = `${height}px`;
    }
    const g = cv.getContext('2d'); if (!g) return;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    const css = getComputedStyle(cv);
    const panel = css.getPropertyValue('--bass-panel').trim() || '#0a0a10';
    const ink = css.getPropertyValue('--bass-ink').trim() || '#b0ffd0';
    const dim = css.getPropertyValue('--bass-dim').trim() || 'rgba(255,255,255,0.35)';
    const line = css.getPropertyValue('--bass-line').trim() || 'rgba(255,255,255,0.08)';
    g.fillStyle = panel; g.fillRect(0, 0, width, height);

    // rows
    for (let r = top; r < Math.min(rows.length, top + visibleRows + 1); r++) {
      const midi = rows[r]; const y = yOfRow(r);
      const black = isBlackKey(midi);
      const out = lock && !inScale(midi, key);
      g.fillStyle = black ? 'rgba(0,0,0,0.28)' : 'rgba(255,255,255,0.025)';
      g.fillRect(KEY_W, y, gridW, ROW_H);
      if (out) { g.fillStyle = 'rgba(0,0,0,0.35)'; g.fillRect(KEY_W, y, gridW, ROW_H); }
      // C rows get a stronger line
      if (midi % 12 === 0) { g.fillStyle = line; g.fillRect(KEY_W, y + ROW_H - 1, gridW, 1); }
      // keyboard column
      g.fillStyle = black ? '#111' : '#e8e4da';
      g.fillRect(0, y, KEY_W - 4, ROW_H - 1);
      if (out) { g.fillStyle = 'rgba(0,0,0,0.5)'; g.fillRect(0, y, KEY_W - 4, ROW_H - 1); }
      const deg = lock && key.scale !== 'chromatic' ? scaleDegree(midi, key) : null;
      const label = midi % 12 === 0 || deg === 1 ? noteName(midi) : (deg ? String(deg) : (black ? '' : noteName(midi)));
      if (label) {
        g.fillStyle = black ? '#aaa' : (deg === 1 || midi % 12 === 0 ? accent : '#333');
        g.font = `${deg && deg !== 1 && midi % 12 !== 0 ? 8 : 9}px ${css.fontFamily}`;
        g.textBaseline = 'middle';
        g.fillText(label, 4, y + ROW_H / 2);
      }
    }
    // grid lines (grid OFF: beats + bars only, so the eye still has a ruler)
    const div = state.grid > 0 ? state.grid : 1;
    for (let b = 0; b <= loopBeats * div; b++) {
      const beat = b / div;
      const x = Math.round(xOfBeat(beat)) + 0.5;
      const isBar = Math.abs(beat % 4) < 1e-6, isBeat = Math.abs(beat % 1) < 1e-6;
      g.strokeStyle = isBar ? 'rgba(255,255,255,0.28)' : isBeat ? 'rgba(255,255,255,0.14)' : line;
      g.lineWidth = isBar ? 1.5 : 1;
      g.beginPath(); g.moveTo(x, 0); g.lineTo(x, height); g.stroke();
    }
    // notes
    for (const n of pat.notes) {
      const r = rowOf(n.note);
      if (r < 0 || r < top - 1 || r > top + visibleRows + 1) continue;
      const x = xOfBeat(n.start), y = yOfRow(r), w = Math.max(3, n.dur * beatW - 1.5);
      const sel = selected.has(n.id);
      g.globalAlpha = 0.45 + n.vel * 0.55;
      g.fillStyle = accent;
      roundRect(g, x + 0.5, y + 1.5, w, ROW_H - 3, 2);
      if (n.slide) {
        // SLIDE note: outlined body + the ◢ right-triangle mark (FL's sign for
        // "this bends what is playing")
        g.globalAlpha = 0.2; g.fill(); g.globalAlpha = 0.9;
        g.strokeStyle = accent; g.lineWidth = 1; g.stroke();
        g.fillStyle = accent;
        const th = ROW_H - 5, tw = Math.min(th, Math.max(4, w - 3));
        g.beginPath(); g.moveTo(x + 2, y + ROW_H - 2.5); g.lineTo(x + 2 + tw, y + ROW_H - 2.5); g.lineTo(x + 2 + tw, y + ROW_H - 2.5 - th); g.closePath(); g.fill();
      } else {
        g.fill();
      }
      g.globalAlpha = 1;
      if (sel) { g.strokeStyle = ink; g.lineWidth = 1.5; roundRect(g, x + 0.5, y + 1.5, w, ROW_H - 3, 2); g.stroke(); }
      // velocity tick + edge grip
      g.fillStyle = 'rgba(0,0,0,0.45)';
      g.fillRect(x + w - 2, y + 2, 1.5, ROW_H - 4);
      if (w > 26 && !n.slide) { g.fillStyle = 'rgba(0,0,0,0.6)'; g.font = `8px ${css.fontFamily}`; g.textBaseline = 'middle'; g.fillText(noteName(n.note), x + 3, y + ROW_H / 2); }
    }
    // rectangle select
    if (drag?.kind === 'marquee') {
      const mx = Math.min(drag.x0, drag.x1), my = Math.min(drag.y0, drag.y1);
      const mw = Math.abs(drag.x1 - drag.x0), mh = Math.abs(drag.y1 - drag.y0);
      g.fillStyle = ink; g.globalAlpha = 0.12; g.fillRect(mx, my, mw, mh);
      g.globalAlpha = 0.9; g.strokeStyle = ink; g.lineWidth = 1; g.setLineDash([3, 3]); g.strokeRect(mx + 0.5, my + 0.5, mw, mh); g.setLineDash([]);
      g.globalAlpha = 1;
    }
    // hover cell ghost
    const hv = hoverRef.current;
    if (hv && !drag && hv.x > KEY_W) {
      const r = rowOfY(hv.y); const b = snapBeat(beatOfX(hv.x));
      if (rows[r] !== undefined && b >= 0 && b < loopBeats && !hitNote(hv.x, hv.y)) {
        g.strokeStyle = dim; g.lineWidth = 1;
        g.strokeRect(xOfBeat(b) + 0.5, yOfRow(r) + 1.5, Math.max(3, (lastDurRef.current || stepBeats) * beatW - 1.5), ROW_H - 3);
      }
    }
    // playhead
    const ph = engine.getPlayheadBeats();
    if (ph >= 0 && state.playingIdx === state.currentIdx) {
      const x = xOfBeat(ph);
      g.fillStyle = ink; g.globalAlpha = 0.9; g.fillRect(x - 0.5, 0, 1.5, height); g.globalAlpha = 1;
    }
    // lit keys — what you're holding (MIDI / computer keyboard / pads) lights
    // its key bright; what the sequencer is sounding glows dimmer.
    const held = engine.heldNotes();
    const sounding = state.playing ? engine.soundingNotes() : [];
    if (held.size || sounding.length) {
      const litRow = (midi: number, alpha: number) => {
        const r = rowOf(midi); if (r < 0 || r < top || r > top + visibleRows) return;
        const y = yOfRow(r);
        g.globalAlpha = alpha; g.fillStyle = accent; g.fillRect(0, y, KEY_W - 4, ROW_H - 1);
        g.globalAlpha = 1; g.fillStyle = '#111'; g.font = `9px ${css.fontFamily}`; g.textBaseline = 'middle';
        g.fillText(noteName(midi), 4, y + ROW_H / 2);
      };
      for (const n of sounding) if (!held.has(n)) litRow(n, 0.55);
      for (const n of held) litRow(n, 1);
    }
    // key column border
    g.fillStyle = 'rgba(0,0,0,0.5)'; g.fillRect(KEY_W - 4, 0, 4, height);
  }, [width, height, top, rows, visibleRows, lock, key, accent, state, loopBeats, pat, selected, drag, beatW, engine, rowOf]);

  // redraw on state change; rAF while playing; and on every live note on/off
  useEffect(() => { draw(); }, [draw]);
  const drawRef = useRef(draw); drawRef.current = draw;
  useEffect(() => engine.onLive(() => drawRef.current()), [engine]);
  useEffect(() => {
    if (!state.playing) return;
    let raf = 0;
    const loop = () => { draw(); raf = requestAnimationFrame(loop); };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [state.playing, draw]);

  // ── BEND lane (pitch automation) ──
  const bendRange = state.bendRange === 12 ? 12 : 2;
  const semisOfLaneY = (y: number) => Math.max(-bendRange, Math.min(bendRange, (1 - 2 * y / LANE_H) * bendRange));
  const laneYOfSemis = (v: number) => (1 - v / bendRange) / 2 * LANE_H;
  const drawLane = useCallback(() => {
    const cv = laneRef.current; if (!cv) return;
    const dpr = window.devicePixelRatio || 1;
    if (cv.width !== Math.round(width * dpr) || cv.height !== Math.round(LANE_H * dpr)) {
      cv.width = Math.round(width * dpr); cv.height = Math.round(LANE_H * dpr);
      cv.style.width = `${width}px`; cv.style.height = `${LANE_H}px`;
    }
    const g = cv.getContext('2d'); if (!g) return;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    const css = getComputedStyle(cv);
    const panel = css.getPropertyValue('--bass-panel').trim() || '#0a0a10';
    const ink = css.getPropertyValue('--bass-ink').trim() || '#b0ffd0';
    const line = css.getPropertyValue('--bass-line').trim() || 'rgba(255,255,255,0.08)';
    g.fillStyle = panel; g.fillRect(0, 0, width, LANE_H);
    // label column
    g.fillStyle = 'rgba(0,0,0,0.5)'; g.fillRect(0, 0, KEY_W - 4, LANE_H);
    g.fillStyle = accent; g.font = `8px ${css.fontFamily}`; g.textBaseline = 'middle';
    g.fillText('BEND', 4, 8); g.fillText(`+${bendRange}`, 4, LANE_H / 2 - 10); g.fillText(`−${bendRange}`, 4, LANE_H / 2 + 12);
    g.fillStyle = 'rgba(0,0,0,0.5)'; g.fillRect(KEY_W - 4, 0, 4, LANE_H);
    // grid (beats / bars) + the zero line
    const div = state.grid > 0 ? state.grid : 1;
    for (let b = 0; b <= loopBeats * div; b++) {
      const beat = b / div;
      const x = Math.round(xOfBeat(beat)) + 0.5;
      const isBar = Math.abs(beat % 4) < 1e-6, isBeat = Math.abs(beat % 1) < 1e-6;
      g.strokeStyle = isBar ? 'rgba(255,255,255,0.28)' : isBeat ? 'rgba(255,255,255,0.14)' : line;
      g.lineWidth = isBar ? 1.5 : 1;
      g.beginPath(); g.moveTo(x, 0); g.lineTo(x, LANE_H); g.stroke();
    }
    g.strokeStyle = 'rgba(255,255,255,0.22)'; g.lineWidth = 1;
    g.beginPath(); g.moveTo(KEY_W, Math.round(LANE_H / 2) + 0.5); g.lineTo(width, Math.round(LANE_H / 2) + 0.5); g.stroke();
    // the curve
    const pts = pat.bend ?? [];
    if (pts.length) {
      g.strokeStyle = accent; g.lineWidth = 1.5; g.globalAlpha = 0.9;
      g.beginPath();
      for (let px = KEY_W; px <= width; px += 2) {
        const v = bendAt(pts, beatOfX(px));
        const y = laneYOfSemis(v);
        if (px === KEY_W) g.moveTo(px, y); else g.lineTo(px, y);
      }
      g.stroke();
      // fill to zero
      g.globalAlpha = 0.15; g.lineTo(width, LANE_H / 2); g.lineTo(KEY_W, LANE_H / 2); g.closePath(); g.fillStyle = accent; g.fill();
      g.globalAlpha = 1;
      for (const p of pts) { g.fillStyle = ink; g.fillRect(xOfBeat(p.beat) - 1.5, laneYOfSemis(p.semis) - 1.5, 3, 3); }
    } else {
      g.fillStyle = 'rgba(255,255,255,0.3)'; g.font = `9px ${css.fontFamily}`; g.textBaseline = 'middle';
      g.fillText('pitch bend lane — draw here (right-click / ALT erases) · the wheel records here with ● REC', KEY_W + 8, LANE_H / 2);
    }
    // playhead
    const ph = engine.getPlayheadBeats();
    if (ph >= 0 && state.playingIdx === state.currentIdx) { g.fillStyle = ink; g.globalAlpha = 0.9; g.fillRect(xOfBeat(ph) - 0.5, 0, 1.5, LANE_H); g.globalAlpha = 1; }
  // `state` itself is a dep: the engine mutates patterns in place and emits a
  // fresh state object, so the object — not `pat` — is what changes on an edit.
  }, [width, LANE_H, KEY_W, accent, state, loopBeats, pat, beatW, engine, bendRange]);
  useEffect(() => { if (bendLane) drawLane(); }, [bendLane, drawLane]);
  const drawLaneRef = useRef(drawLane); drawLaneRef.current = drawLane;
  useEffect(() => {
    if (!state.playing || !bendLane) return;
    let raf = 0;
    const loop = () => { drawLaneRef.current(); raf = requestAnimationFrame(loop); };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [state.playing, bendLane]);
  const lanePos = (e: { clientX: number; clientY: number }) => {
    const rect = laneRef.current!.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  };
  const onLaneDown = (e: React.PointerEvent) => {
    const { x, y } = lanePos(e);
    if (x < KEY_W) return;
    try { (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId); } catch { /* */ }
    wrapRef.current?.focus();
    const beat = Math.max(0, Math.min(loopBeats, beatOfX(x)));
    const erase = e.button === 2 || e.altKey || tool === 'erase';
    if (erase) { engine.clearBend(beat - 1 / 32, beat + 1 / 32); setLaneDrag({ kind: 'erase', lastBeat: beat }); return; }
    if (e.button !== 0) return;
    const snapped = snapBeat(beat, false);
    engine.addBendPoint(snapped, semisOfLaneY(y));
    setLaneDrag({ kind: 'draw', lastBeat: snapped });
  };
  useEffect(() => {
    if (!laneDrag) return;
    const move = (e: PointerEvent) => {
      const { x, y } = lanePos(e);
      const beat = Math.max(0, Math.min(loopBeats, beatOfX(x)));
      if (laneDrag.kind === 'erase') { engine.clearBend(laneDrag.lastBeat, beat); setLaneDrag({ ...laneDrag, lastBeat: beat }); return; }
      // draw: a point at the pointer (free when the grid is OFF, snapped otherwise)
      const b = snapBeat(beat, false);
      engine.addBendPoint(b, semisOfLaneY(y));
      setLaneDrag({ ...laneDrag, lastBeat: b });
    };
    const up = () => setLaneDrag(null);
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
    return () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', up); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [laneDrag, beatW, loopBeats, gridBeats, bendRange]);

  // ── mouse ──
  const posOf = (e: { clientX: number; clientY: number }) => {
    const rect = canvasRef.current!.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  };
  // TOUCH gestures on notes (his ask): tap a selected note again = delete;
  // HOLD a note (~350 ms without moving) = the drag becomes RESIZE, so a
  // finger can pull the note's length without hunting the 2px edge handle.
  // Mouse flows (double-click delete, edge-resize, alt-dup…) are untouched.
  const dragRef = useRef<Drag | null>(null); dragRef.current = drag;
  const holdTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clearHold = () => { if (holdTimerRef.current !== null) { clearTimeout(holdTimerRef.current); holdTimerRef.current = null; } };

  const onPointerDown = (e: React.PointerEvent) => {
    const { x, y } = posOf(e);
    wrapRef.current?.focus();
    try { (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId); } catch { /* */ }
    if (x < KEY_W) {
      // key column: tap = audition; drag = scroll the rows (touch has no wheel)
      const m = rows[rowOfY(y)]; if (m !== undefined) engine.preview(m);
      setDrag({ kind: 'scroll', y0: y, top0: top });
      return;
    }
    const hit = hitNote(x, y);
    // DOUBLE-CLICK a note = delete it
    if (hit && e.button === 0 && (e.nativeEvent as MouseEvent).detail >= 2 && !e.altKey && !e.metaKey && !e.ctrlKey) {
      e.preventDefault();
      engine.removeNotes([hit.note.id]);
      setSelected((s) => { const n = new Set(s); n.delete(hit.note.id); return n; });
      return;
    }
    // ALT on a SELECTED note = duplicate the selection and drag the copies
    if (hit && e.button === 0 && e.altKey && selected.has(hit.note.id) && tool !== 'erase') {
      e.preventDefault();
      const copies = engine.duplicateNotes([...selected]);
      const sel = new Set(copies.map((n) => n.id));
      setSelected(sel);
      setDrag({ kind: 'move', x0: x, y0: y, snapshot: copies.map((n) => ({ ...n })), moved: false, rowIdx0: rowOfY(y) });
      return;
    }
    const erase = e.button === 2 || e.altKey || tool === 'erase';
    if (erase) {
      e.preventDefault();
      if (hit) engine.removeNotes([hit.note.id]);
      setDrag({ kind: 'erase' });
      return;
    }
    if (e.button !== 0) return;
    if (hit) {
      const touch = e.pointerType === 'touch';
      const wasSelected = selected.has(hit.note.id);
      let sel = new Set(selected);
      if (e.shiftKey) { if (sel.has(hit.note.id)) sel.delete(hit.note.id); else sel.add(hit.note.id); }
      else if (!sel.has(hit.note.id)) sel = new Set([hit.note.id]);
      setSelected(sel);
      const snapshot = pat.notes.filter((n) => sel.has(n.id)).map((n) => ({ ...n }));
      if (e.metaKey || e.ctrlKey || tool === 'vel') { setDrag({ kind: 'vel', y0: y, snapshot }); return; }
      // The right-edge resize handle is a MOUSE affordance — on a 1/16 grid it
      // is ~3px of a ~9px note, so a finger lands in it half the time and the
      // tap/hold gestures never fire. Touch resizes by HOLDING instead.
      if (hit.edge && e.pointerType !== 'touch') setDrag({ kind: 'resize', x0: x, snapshot });
      else {
        setDrag({ kind: 'move', x0: x, y0: y, snapshot, moved: false, rowIdx0: rowOfY(y),
          retap: touch && wasSelected && !e.shiftKey });
        engine.preview(hit.note.note, hit.note.vel);
        if (touch) {
          // HOLD: still an unmoved move after the delay → grab the length.
          clearHold();
          holdTimerRef.current = setTimeout(() => {
            holdTimerRef.current = null;
            const d = dragRef.current;
            if (d?.kind === 'move' && !d.moved) setDrag({ kind: 'resize', x0: d.x0, snapshot: d.snapshot });
          }, 350);
        }
      }
      return;
    }
    // CMD/CTRL-drag on empty = rectangle select (SHIFT keeps what's selected)
    if (e.metaKey || e.ctrlKey) {
      e.preventDefault();
      setDrag({ kind: 'marquee', x0: x, y0: y, x1: x, y1: y, base: e.shiftKey ? new Set(selected) : new Set() });
      if (!e.shiftKey) setSelected(new Set());
      return;
    }
    if (tool === 'vel') { setSelected(new Set()); return; }
    // empty: new note (SLIDE tool = a slide note)
    const midi = rows[rowOfY(y)];
    const b = snapBeat(beatOfX(x));
    if (midi === undefined || b < 0 || b >= loopBeats) { setSelected(new Set()); return; }
    const dur = lastDurRef.current || stepBeats;
    const n = engine.addNote(midi, b, dur, 0.9, { raw: !lock, slide: tool === 'slide' });
    engine.preview(n.note);
    setSelected(new Set([n.id]));
    setDrag({ kind: 'draw', id: n.id, startBeat: b });
  };
  useEffect(() => {
    if (!drag) return;
    const move = (e: PointerEvent) => {
      const { x, y } = posOf(e);
      if (drag.kind === 'scroll') {
        const dRows = Math.round((drag.y0 - y) / ROW_H);
        setTopRow(Math.max(0, Math.min(Math.max(0, rows.length - visibleRows), drag.top0 + dRows)));
        return;
      }
      if (drag.kind === 'marquee') {
        const m = { ...drag, x1: x, y1: y };
        setDrag(m);
        // notes whose rectangle touches the marquee
        const bx0 = beatOfX(Math.min(m.x0, m.x1)), bx1 = beatOfX(Math.max(m.x0, m.x1));
        const ry0 = rowOfY(Math.min(m.y0, m.y1)), ry1 = rowOfY(Math.max(m.y0, m.y1));
        const sel = new Set(m.base);
        for (const n of pat.notes) {
          const r = rowOf(n.note);
          if (r < ry0 || r > ry1) continue;
          if (n.start + n.dur <= bx0 || n.start >= bx1) continue;
          sel.add(n.id);
        }
        setSelected(sel);
        return;
      }
      if (drag.kind === 'erase') {
        const hit = hitNote(x, y);
        if (hit) engine.removeNotes([hit.note.id]);
      } else if (drag.kind === 'draw') {
        const b = snapBeat(beatOfX(x));
        // grid on: the note grows a step at a time; grid OFF: it follows the pointer
        const minLen = gridBeats || 0.05;
        const end = gridBeats > 0 ? Math.max(drag.startBeat + gridBeats, b + gridBeats) : Math.max(drag.startBeat + minLen, b);
        engine.updateNote(drag.id, { dur: Math.min(loopBeats - drag.startBeat, end - drag.startBeat) });
        lastDurRef.current = Math.min(loopBeats - drag.startBeat, end - drag.startBeat);
      } else if (drag.kind === 'resize') {
        const dBeats = snapBeat((x - drag.x0) / beatW, false);
        const minLen = gridBeats || 0.05;
        engine.updateNotes(drag.snapshot.map((n) => ({ id: n.id, changes: { dur: Math.max(minLen, snapBeat(n.dur + dBeats, false) || minLen) } })));
        if (drag.snapshot.length === 1) lastDurRef.current = Math.max(minLen, snapBeat(drag.snapshot[0].dur + dBeats, false) || minLen);
      } else if (drag.kind === 'move') {
        const dBeats = snapBeat((x - drag.x0) / beatW, false);
        const dRows = rowOfY(y) - drag.rowIdx0;
        if (!drag.moved && Math.abs(dBeats) < 1e-9 && dRows === 0) return;
        if (!drag.moved) setDrag({ ...drag, moved: true });
        engine.updateNotes(drag.snapshot.map((n) => {
          const r0 = rowOf(n.note);
          // The note FOLLOWS the pointer: rows[] is top-down (row 0 = highest
          // note) and rowOfY grows with screen y, so a downward drag (dRows>0)
          // means a HIGHER row index = lower note → r0 + dRows. Subtracting
          // here inverted the drag (his report: drag down, note went up).
          const r1 = Math.max(0, Math.min(rows.length - 1, r0 + dRows));
          let midi = rows[r1] ?? n.note;
          if (lock) midi = snapToScale(midi, key);
          return { id: n.id, changes: { note: midi, start: Math.max(0, Math.min(loopBeats - n.dur, n.start + dBeats)) } };
        }));
      } else if (drag.kind === 'vel') {
        const dv = (drag.y0 - y) / 90;
        engine.updateNotes(drag.snapshot.map((n) => ({ id: n.id, changes: { vel: Math.max(0.05, Math.min(1, n.vel + dv)) } })));
      }
    };
    const up = () => {
      clearHold();
      // TOUCH retap: tapped the already-selected note and released without
      // moving it → delete. A HOLD survived past the timer is a resize by the
      // time it gets here, so holding never deletes.
      if (drag.kind === 'move' && !drag.moved && drag.retap && drag.snapshot.length === 1) {
        engine.removeNotes([drag.snapshot[0].id]);
        setSelected((s) => { const n = new Set(s); n.delete(drag.snapshot[0].id); return n; });
        setDrag(null);
        return;
      }
      if (drag.kind === 'move' && drag.moved && drag.snapshot.length === 1) {
        const n = engine.currentPattern.notes.find((x) => x.id === drag.snapshot[0].id);
        if (n && n.note !== drag.snapshot[0].note) engine.preview(n.note, n.vel);
      }
      setDrag(null);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
    return () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', up); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drag, beatW, gridBeats, loopBeats, rows, lock, key, visibleRows, pat]);

  const onWheel = (e: React.WheelEvent) => {
    if (e.ctrlKey || e.metaKey) return;
    e.preventDefault();
    const d = Math.sign(e.deltaY) * (Math.abs(e.deltaY) > 40 ? 3 : 1);
    setTopRow((t) => Math.max(0, Math.min(Math.max(0, rows.length - visibleRows), (t ?? defaultTop) + d)));
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    const ids = [...selected];
    const k = e.key;
    if ((k === 'Delete' || k === 'Backspace') && ids.length) { e.preventDefault(); engine.removeNotes(ids); setSelected(new Set()); return; }
    if ((e.metaKey || e.ctrlKey) && (k === 'a' || k === 'A')) { e.preventDefault(); setSelected(new Set(pat.notes.map((n) => n.id))); return; }
    if (k === 'Escape') { setSelected(new Set()); return; }
    if (!ids.length) return;
    if (k === 'ArrowUp' || k === 'ArrowDown') {
      e.preventDefault();
      const dir = k === 'ArrowUp' ? 1 : -1;
      engine.updateNotes(pat.notes.filter((n) => selected.has(n.id)).map((n) => {
        let midi: number;
        if (e.shiftKey) midi = n.note + 12 * dir;
        else midi = lock ? stepInScale(n.note, dir, key) : n.note + dir;
        if (lock) midi = snapToScale(midi, key);
        return { id: n.id, changes: { note: Math.max(BASS_LOW, Math.min(BASS_HIGH, midi)) } };
      }));
      if (ids.length === 1) { const n = engine.currentPattern.notes.find((x) => x.id === ids[0]); if (n) engine.preview(n.note, n.vel); }
      return;
    }
    if (k === 's' || k === 'S') {
      // toggle SLIDE on the selection (stopPropagation: S is also a pad key on
      // the window handler — with notes selected in the roll it means slide)
      e.preventDefault(); e.stopPropagation();
      const sel = pat.notes.filter((n) => selected.has(n.id));
      const allSlide = sel.every((n) => n.slide);
      engine.updateNotes(sel.map((n) => ({ id: n.id, changes: { slide: !allSlide } })));
      return;
    }
    if (k === 'ArrowLeft' || k === 'ArrowRight') {
      e.preventDefault();
      const d = (k === 'ArrowRight' ? 1 : -1) * nudgeBeats;
      engine.updateNotes(pat.notes.filter((n) => selected.has(n.id)).map((n) => ({ id: n.id, changes: { start: Math.max(0, Math.min(loopBeats - n.dur, n.start + d)) } })));
    }
  };

  // drop selection ids that vanished (delete / pattern switch)
  useEffect(() => {
    const ids = new Set(pat.notes.map((n) => n.id));
    if ([...selected].some((id) => !ids.has(id))) setSelected(new Set([...selected].filter((id) => ids.has(id))));
  }, [pat, selected]);
  useEffect(() => { setSelected(new Set()); }, [state.currentIdx]);

  return (
    <div ref={wrapRef} className="pr-wrap" tabIndex={0} onKeyDown={onKeyDown}
      title="Click: note · drag empty: draw · drag note: move · drag right edge: length · right-click/ALT: erase · CMD-drag on empty: rectangle select (SHIFT adds) · ALT-drag a selected note: duplicate · double-click a note: delete · CMD-drag ↕ on a note: velocity · ↑↓ transpose in key · ←→ nudge · S: toggle slide · DEL remove · GRID OFF = nothing snaps · the keys on the left light up for the notes you play (MIDI, computer keys, pads)">
      <canvas ref={canvasRef} className="pr-canvas"
        onPointerDown={onPointerDown}
        onContextMenu={(e) => e.preventDefault()}
        onMouseMove={(e) => { hoverRef.current = posOf(e); if (!state.playing) bump((n) => n + 1); }}
        onMouseLeave={() => { hoverRef.current = null; if (!state.playing) bump((n) => n + 1); }}
        onWheel={onWheel}
        style={{ cursor: drag?.kind === 'resize' ? 'ew-resize' : drag?.kind === 'move' ? 'grabbing' : drag?.kind === 'marquee' ? 'cell' : tool === 'erase' ? 'not-allowed' : 'crosshair', touchAction: 'none' }} />
      {bendLane && (
        <canvas ref={laneRef} className="pr-canvas pr-lane"
          onPointerDown={onLaneDown}
          onContextMenu={(e) => e.preventDefault()}
          title="PITCH BEND lane — click/drag draws the bend (semitones, linear between points), right-click / ALT drag erases, the wheel records into it with ● REC. Range: ±2 / ±12 in the toolbar. Plays live and in exports."
          style={{ cursor: laneDrag?.kind === 'erase' ? 'not-allowed' : 'crosshair', touchAction: 'none', borderTop: '1px solid rgba(255,255,255,0.15)' }} />
      )}
      {/* row scroll buttons — the wheel's touch stand-in */}
      <div className="pr-scroll">
        <button className="bb bb-sq" onPointerDown={(e) => { e.preventDefault(); setTopRow((t) => Math.max(0, (t ?? defaultTop) - (compact ? 6 : 4))); }} title="Scroll up (higher notes)">▲</button>
        <button className="bb bb-sq" onPointerDown={(e) => { e.preventDefault(); setTopRow((t) => Math.min(Math.max(0, rows.length - visibleRows), (t ?? defaultTop) + (compact ? 6 : 4))); }} title="Scroll down (lower notes)">▼</button>
      </div>
    </div>
  );
}

function roundRect(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  const rr = Math.min(r, w / 2, h / 2);
  g.beginPath();
  g.moveTo(x + rr, y);
  g.lineTo(x + w - rr, y); g.quadraticCurveTo(x + w, y, x + w, y + rr);
  g.lineTo(x + w, y + h - rr); g.quadraticCurveTo(x + w, y + h, x + w - rr, y + h);
  g.lineTo(x + rr, y + h); g.quadraticCurveTo(x, y + h, x, y + h - rr);
  g.lineTo(x, y + rr); g.quadraticCurveTo(x, y, x + rr, y);
  g.closePath();
}
