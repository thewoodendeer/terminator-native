import { useCallback, useRef, useState } from 'react';
import { ChopperEngine, PadMode } from './ChopperEngine';

/** What a pad holds, in a form that can be copied to another pad. A chop entry
 *  remembers its REGION as well as its id: clearing the source after a copy
 *  splices the chop out of the waveform, and a paste of the bare id would land
 *  a silent, dead pad — engine.reviveChop rebuilds it from the region. */
export type PadContent =
  | { type: 'chop'; chopId: number; start: number; end: number; pitch: number; mode: PadMode; gate?: boolean; fadeIn: number; fadeOut: number; stems?: number; reverse?: boolean }
  | { type: 'buffer'; buffer: AudioBuffer; videoId: string; title: string; start: number; end: number; pitch: number; mode: PadMode; gate?: boolean; fadeIn: number; fadeOut: number };

/** The clipboard/paste grid bound. The engine itself grows pads on demand;
 *  this matches the 64 pads every layout actually shows (HardwareView's
 *  4 banks × 16, PadGrid's banks). One place to raise when the grids grow. */
export const PAD_GRID_MAX = 64;

/** Read a pad's content straight off the engine (no getState() deep clone).
 *  Returns null for an empty pad. */
export function getPadContent(engine: ChopperEngine, idx: number): PadContent | null {
  const p = engine.padLite(idx);
  if (!p) return null;
  const base = { pitch: p.pitch, mode: p.mode, gate: p.gate, fadeIn: p.fadeIn, fadeOut: p.fadeOut };
  const pb = engine.getPadBuffer?.(idx);
  if (pb) return { type: 'buffer', buffer: pb.buffer, videoId: pb.videoId, title: pb.title, start: pb.start, end: pb.end, ...base };
  if (p.chopId != null) {
    const r = engine.chopRegion(p.chopId);
    if (!r) return null;
    // STEM mask travels with the pad (main-track chops only — pad-source
    // buffers have no stems). 15 = ALL = omitted.
    return { type: 'chop', chopId: p.chopId, start: r.start, end: r.end, ...base, ...(p.stems !== 15 ? { stems: p.stems } : {}), ...(p.reverse !== undefined ? { reverse: p.reverse } : {}) };
  }
  return null;
}

/** Drop content onto a pad, replacing whatever is there. Non-destructive:
 *  unassignPad empties the slot WITHOUT splicing the chop out of the waveform
 *  (that is clearPad's job), so pasting never mangles the chop layout. The
 *  pad's play settings — pitch, NOTE ON, LOOP, fades — travel with the content
 *  and are always written, so a paste can't inherit the target's stale ones. */
export function setPadSlot(engine: ChopperEngine, idx: number, c: PadContent | null): void {
  engine.unassignPad(idx);
  if (!c) return;
  if (c.type === 'buffer') engine.loadPadBuffer(idx, c.buffer, c.videoId, c.title, c.start, c.end);
  else engine.assignChopToPad(idx, engine.reviveChop(c.chopId, c.start, c.end));
  engine.setPadPitch(idx, c.pitch);
  engine.setPadMode(idx, c.mode);
  engine.setPadGate(idx, !!c.gate);
  engine.setPadFades(idx, c.fadeIn, c.fadeOut);
  engine.setPadStems(idx, c.type === 'chop' ? (c.stems ?? 15) : 15);
  // The per-pad REV override travels with the pad (undefined = follow source).
  engine.setPadsReverse([idx], c.type === 'chop' && c.reverse !== undefined ? c.reverse : null);
}

export function isPadEmpty(engine: ChopperEngine, idx: number): boolean {
  return !engine.hasPadContent(idx);
}

/** First empty pad after `idx`, wrapping to the front, below `limit` (the
 *  free-tier lock line caps it below PAD_GRID_MAX). -1 when full. `taken`
 *  holds slots already claimed earlier in the same operation — the engine's
 *  state lags within a batch, so a multi-pad op must track its own. */
export function firstEmptyAfter(engine: ChopperEngine, idx: number, taken?: Set<number>, limit = PAD_GRID_MAX): number {
  const cap = Math.min(limit, PAD_GRID_MAX);
  const free = (i: number) => !taken?.has(i) && !engine.hasPadContent(i);
  for (let i = idx + 1; i < cap; i++) if (free(i)) return i;
  for (let i = 0; i < idx && i < cap; i++) if (free(i)) return i;
  return -1;
}

/** Copy pads in pad order, skipping empties. */
export function copyPads(engine: ChopperEngine, idxs: number[]): PadContent[] {
  return [...idxs].sort((a, b) => a - b)
    .map(i => getPadContent(engine, i))
    .filter((c): c is PadContent => c !== null);
}

/** Paste onto consecutive pads starting at `at`, never past `limit` (the
 *  free-tier lock). One undo step. Returns how many actually landed — the
 *  caller should tell the user when items were dropped at the boundary. */
export function pastePads(engine: ChopperEngine, at: number, items: PadContent[], limit = PAD_GRID_MAX): number {
  const cap = Math.min(limit, PAD_GRID_MAX);
  if (!items.length || at >= cap) return 0;
  let n = 0;
  engine.beginHistoryBatch();
  try {
    items.forEach((c, k) => { const dest = at + k; if (dest < cap) { setPadSlot(engine, dest, c); n++; } });
  } finally { engine.endHistoryBatch(); }
  return n;
}

/** Clear pads back-to-front: clearPad splices a chop out of the waveform and
 *  merges its region into a neighbour, so clearing low-to-high would move the
 *  ground under later targets. One undo step. */
export function clearPads(engine: ChopperEngine, idxs: number[], onClear?: (i: number) => void): number {
  const list = [...idxs].filter(i => engine.hasPadContent(i)).sort((a, b) => b - a);
  if (!list.length) return 0;
  engine.beginHistoryBatch();
  try { for (const i of list) { if (onClear) onClear(i); else engine.clearPad(i); } }
  finally { engine.endHistoryBatch(); }
  return list.length;
}

/** CUT = copy, then EMPTY the pads — with unassignPad, never clearPad: cut is
 *  a move in two halves, so the chop must survive in the waveform for the
 *  paste (clearPad would splice it and merge its region into a neighbour —
 *  destroying the very thing sitting in the clipboard). One undo step.
 *  `onEmptied` lets the view run its own bookkeeping per emptied pad. */
export function cutPads(engine: ChopperEngine, idxs: number[], onEmptied?: (i: number) => void): PadContent[] {
  const items = copyPads(engine, idxs);
  if (!items.length) return [];
  engine.beginHistoryBatch();
  try { for (const i of idxs) { if (!engine.hasPadContent(i)) continue; engine.unassignPad(i); onEmptied?.(i); } }
  finally { engine.endHistoryBatch(); }
  return items;
}

/** Duplicate pads onto the free slots after them (never past `limit`). A chop
 *  pad's copy gets its OWN chop (fresh id, same region) so trimming the copy
 *  leaves the original alone; buffer pads already own their audio. */
export function duplicatePads(engine: ChopperEngine, idxs: number[], limit = PAD_GRID_MAX): number {
  const list = [...idxs].sort((a, b) => a - b);
  if (!list.length) return 0;
  const taken = new Set<number>();
  let dest = list[list.length - 1];
  let n = 0;
  engine.beginHistoryBatch();
  try {
    for (const t of list) {
      const c = getPadContent(engine, t);
      if (!c) continue;
      dest = firstEmptyAfter(engine, dest, taken, limit);
      if (dest < 0) break;
      taken.add(dest);
      setPadSlot(engine, dest, c.type === 'chop' ? { ...c, chopId: engine.cloneChop(c.chopId) } : c);
      n++;
    }
  } finally { engine.endHistoryBatch(); }
  return n;
}

/** THE pad selection + clipboard for the whole chopper.
 *
 *  Lives above the pad grid so the grid's menu, the window keyboard handler
 *  (delete, cmd X/C/V) and any other layout all read ONE selection and ONE
 *  clipboard — two copies would silently disagree about what is selected.
 *
 *  EMPTY pads may be selected: that is how you aim a paste. Actions that only
 *  make sense on audio (copy, cut, group, mute group…) filter at use time. */
export function usePadSelection(engine: ChopperEngine) {
  const [sel, setSel] = useState<Set<number>>(new Set());
  const [clipboard, setClipboard] = useState<PadContent[] | null>(null);
  // The pad the user most recently pointed at (empty-pad click, or the last
  // shift-added pad) — where a keyboard paste lands. Lowest-selected-index
  // was wrong: ⌘V after selecting 1, 5, 9 pasted at 1 and overwrote 2 and 3.
  const aimRef = useRef<number | null>(null);

  const selected = [...sel].sort((a, b) => a - b);

  const toggle = useCallback((idx: number) => {
    setSel(prev => {
      const n = new Set(prev);
      if (n.has(idx)) { n.delete(idx); if (aimRef.current === idx) aimRef.current = null; }
      else { n.add(idx); aimRef.current = idx; }
      return n;
    });
  }, []);
  const only = useCallback((idx: number) => { aimRef.current = idx; setSel(new Set([idx])); }, []);
  const clear = useCallback(() => { aimRef.current = null; setSel(new Set()); }, []);
  /** Pads whose content just moved/vanished drop out of the selection. */
  const drop = useCallback((idxs: number[]) => {
    setSel(prev => { const n = new Set(prev); for (const i of idxs) n.delete(i); return n; });
  }, []);
  const aim = useCallback((): number | null => aimRef.current, []);

  return { sel, selected, toggle, only, clear, drop, aim, clipboard, setClipboard };
}
