// STEM MASKS — the pure half of per-pad stem separation (STEM-SPLIT-PLAN.md
// Phase 2). A pad carries a 4-bit mask saying which stems of the MAIN track it
// plays; the engine resolves the mask to a buffer at trigger time. This module
// owns everything testable without an AudioContext: mask bit math, the
// channel-data mixdown for combo masks, and the ready-ranges set (stems are
// PARTIAL by design — selection-scoped splits fill spans over time).
//
// Bit order == the MODEL's stem order (htdemucs output rows), so worker
// results, masks and mixdowns can never disagree:
//   bit 0 = drums, bit 1 = bass, bit 2 = other, bit 3 = vocals.

export type StemName = 'drums' | 'bass' | 'other' | 'vocals';
export const STEM_ORDER: StemName[] = ['drums', 'bass', 'other', 'vocals'];
export type StemMask = number; // 1..15
export const MASK_ALL: StemMask = 0b1111;

export const stemBit = (s: StemName): StemMask => 1 << STEM_ORDER.indexOf(s);
export const maskHas = (m: StemMask, s: StemName): boolean => (m & stemBit(s)) !== 0;
/** Toggle one stem, refusing to turn the LAST lit stem off (mask 0 = silence
 *  — not representable from the UI; returns the input mask unchanged). */
export function toggleStem(m: StemMask, s: StemName): StemMask {
  const next = m ^ stemBit(s);
  return (next & MASK_ALL) === 0 ? m : next & MASK_ALL;
}
/** Normalize a persisted value: anything not a real partial mask means ALL. */
export const normalizeMask = (v: unknown): StemMask =>
  typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= 15 ? v : MASK_ALL;

/** Sum the enabled stems' channel data into fresh arrays. `stems` holds one
 *  Float32Array per channel per stem; every array must be the same length.
 *  Single-bit masks never need this (the engine plays that stem's buffer
 *  directly) — this is the 2-or-3-stem combo path, rendered once and cached. */
export function mixMaskChannels(
  stems: Record<StemName, Float32Array[]>,
  mask: StemMask,
  channels: number,
  length: number,
): Float32Array[] {
  const out: Float32Array[] = Array.from({ length: channels }, () => new Float32Array(length));
  for (const name of STEM_ORDER) {
    if (!maskHas(mask, name)) continue;
    const src = stems[name];
    for (let ch = 0; ch < channels; ch++) {
      const s = src[Math.min(ch, src.length - 1)];
      const d = out[ch];
      const n = Math.min(length, s.length);
      for (let i = 0; i < n; i++) d[i] += s[i];
    }
  }
  return out;
}

// ── ready ranges ─────────────────────────────────────────────────────────────
// Seconds, sorted, non-overlapping. A pad's chop plays its STEM mix only when
// its whole span is ready; otherwise the ORIGINAL plays (never silence).

export type ReadyRange = [start: number, end: number];

/** Merge a new range into a sorted, disjoint set (touching ranges join). */
export function addReadyRange(ranges: ReadyRange[], add: ReadyRange): ReadyRange[] {
  const EPS = 1e-4;
  let [a, b] = add;
  if (!(b > a)) return ranges;
  const out: ReadyRange[] = [];
  for (const [x, y] of ranges) {
    if (y < a - EPS || x > b + EPS) { out.push([x, y]); continue; }
    a = Math.min(a, x); b = Math.max(b, y);
  }
  out.push([a, b]);
  out.sort((p, q) => p[0] - q[0]);
  return out;
}

/** Whole span covered by one ready range? (EPS forgives float edges — a chop
 *  boundary sitting exactly on a chunk edge must not flicker to "unready".) */
export function spanReady(ranges: ReadyRange[], start: number, end: number): boolean {
  const EPS = 1e-3;
  return ranges.some(([a, b]) => a <= start + EPS && b >= end - EPS);
}

/** Sanitize a persisted ranges list (old/foreign presets). */
export function normalizeRanges(v: unknown): ReadyRange[] {
  if (!Array.isArray(v)) return [];
  let out: ReadyRange[] = [];
  for (const r of v) {
    if (Array.isArray(r) && Number.isFinite(r[0]) && Number.isFinite(r[1]) && r[1] > r[0]) {
      out = addReadyRange(out, [Math.max(0, r[0]), r[1]]);
    }
  }
  return out;
}
