// TRIM — non-destructive section deletion over the ORIGINAL decoded audio
// (his ask 2026-08-21: "a trim button like julienne"; the model is ported from
// julienne/src/audio/trim.ts).
//
// MODEL: `TrimRegion[]` is the list of DELETED spans in FILE time (the decoded
// original's timeline), sorted, non-overlapping, merged. The EFFECTIVE timeline
// = the kept ranges concatenated — that buffer is what every downstream
// consumer already treats as "the sample": chops, pads, the waveform, stems,
// the sequencer, exports.
//
// TIME BASES — the one rule that keeps this sane:
//   • Chops / pads / transients / the engine's `buffer` live in EFFECTIVE time,
//     so every existing consumer works unchanged against the trimmed buffer.
//   • The trim list (and the chops a trim swallowed, so RESTORE can bring them
//     back) lives in FILE time — durable across further trims — and so do the
//     stems: the split worker, the asset store and the "split once, ever" cache
//     all see the ORIGINAL audio; the engine cuts the stems to the effective
//     timeline the same way it cuts the sample.
//   • fileToEff / effToFile are the ONLY bridge, exercised at the boundaries:
//     a trim edit, restore, project load, and the stems controller's spans.
//
// A file position inside a deleted span maps to the seam it collapsed into
// (fileToEff is total, never NaN); effToFile is exact on the kept ranges.

/** A chop swallowed by a trim, in FILE time — restored with the region. */
export interface TrimChop {
  id: number;
  startSec: number; // FILE time
  endSec: number;   // FILE time
  padIdx?: number;  // the pad it sat on (restored there if still empty)
  stems?: number;   // its stem mask, if any
}

/** One deleted span, FILE time. `chops` = the chops it swallowed. */
export interface TrimRegion {
  startSec: number;
  endSec: number;
  chops: TrimChop[];
}

/** Seam anti-click: short in-place ramps on each side of every interior
 *  join. Amplitude-only (no overlap), so the mapping stays sample-exact. */
const SEAM_FADE_SEC = 0.003;

export const totalTrimmedSec = (trims: TrimRegion[]): number =>
  trims.reduce((s, t) => s + (t.endSec - t.startSec), 0);

export const cloneTrims = (trims: TrimRegion[]): TrimRegion[] =>
  trims.map(t => ({ startSec: t.startSec, endSec: t.endSec, chops: t.chops.map(c => ({ ...c })) }));

export const sameTrims = (a: TrimRegion[], b: TrimRegion[]): boolean =>
  a.length === b.length && a.every((t, i) => t.startSec === b[i].startSec && t.endSec === b[i].endSec);

/** FILE seconds → EFFECTIVE seconds. Points inside a deleted span collapse
 *  to its seam. Assumes `trims` sorted + non-overlapping (the invariant
 *  addTrimRegion maintains). */
export function fileToEff(trims: TrimRegion[], fileSec: number): number {
  let removed = 0;
  for (const t of trims) {
    if (fileSec <= t.startSec) break;
    removed += Math.min(fileSec, t.endSec) - t.startSec;
  }
  return fileSec - removed;
}

/** EFFECTIVE seconds → FILE seconds (exact on kept ranges). A point sitting
 *  exactly on a seam is ambiguous — it is both the cut's start and its end in
 *  file time. `end` = true picks the BEFORE side (for region ENDS: a chop that
 *  ends at a seam ends where the cut begins); default picks the AFTER side
 *  (for region STARTS). */
export function effToFile(trims: TrimRegion[], effSec: number, end = false): number {
  let file = effSec;
  for (const t of trims) {
    if (end ? file <= t.startSec : file < t.startSec) break;
    file += t.endSec - t.startSec;
  }
  return file;
}

/** Add a deleted span (FILE time) to the list: insert, then merge every
 *  overlapping/touching neighbor — swallowed-chop lists merge with it
 *  (deduped by id; a chop can only be swallowed once). Returns a NEW sorted
 *  non-overlapping list. */
export function addTrimRegion(trims: TrimRegion[], startSec: number, endSec: number, chops: TrimChop[]): TrimRegion[] {
  let s = Math.min(startSec, endSec);
  let e = Math.max(startSec, endSec);
  let swallowed = [...chops];
  const out: TrimRegion[] = [];
  for (const t of [...trims].sort((a, b) => a.startSec - b.startSec)) {
    if (t.endSec < s || t.startSec > e) {
      out.push(t);
    } else {
      s = Math.min(s, t.startSec);
      e = Math.max(e, t.endSec);
      swallowed = [...swallowed, ...t.chops.filter(c => !swallowed.some(x => x.id === c.id))];
    }
  }
  out.push({ startSec: s, endSec: e, chops: swallowed.sort((a, b) => a.startSec - b.startSec) });
  return out.sort((a, b) => a.startSec - b.startSec);
}

/** The kept ranges of a `length`-frame source at `rate`, in FILE frames. A
 *  trim spanning the whole file still leaves one frame so a buffer can exist. */
export function keptRanges(length: number, rate: number, trims: TrimRegion[]): Array<[number, number]> {
  const clampF = (sec: number) => Math.max(0, Math.min(length, Math.round(sec * rate)));
  const kept: Array<[number, number]> = [];
  let cursor = 0;
  for (const t of [...trims].sort((a, b) => a.startSec - b.startSec)) {
    const s = clampF(t.startSec);
    const e = clampF(t.endSec);
    if (s > cursor) kept.push([cursor, s]);
    cursor = Math.max(cursor, e);
  }
  if (cursor < length) kept.push([cursor, length]);
  if (!kept.length) kept.push([0, Math.min(1, length)]);
  return kept;
}

/**
 * Build the EFFECTIVE buffer: kept regions of `src` concatenated, with a
 * short amplitude ramp on each side of every interior seam (sides merge
 * click-free). `trims` empty → the SAME buffer object (zero copy, and the
 * caller's identity checks keep working). Used for the sample AND for each
 * stem, so they stay sample-aligned through every cut.
 */
export function buildEffectiveBuffer(ctx: BaseAudioContext, src: AudioBuffer, trims: TrimRegion[]): AudioBuffer {
  if (trims.length === 0) return src;
  const rate = src.sampleRate;
  const kept = keptRanges(src.length, rate, trims);
  const totalFrames = Math.max(1, kept.reduce((n, [a, b]) => n + (b - a), 0));
  const nCh = src.numberOfChannels;
  const out = ctx.createBuffer(nCh, totalFrames, rate);
  const fade = Math.round(SEAM_FADE_SEC * rate);
  for (let c = 0; c < nCh; c++) {
    const srcData = src.getChannelData(c);
    const dst = out.getChannelData(c);
    let w = 0;
    for (let k = 0; k < kept.length; k++) {
      const [a, b] = kept[k];
      dst.set(srcData.subarray(a, b), w);
      const len = b - a;
      // ramp OUT into an interior seam (not at the true file end)…
      if (k < kept.length - 1) {
        const n = Math.min(fade, len);
        for (let i = 0; i < n; i++) dst[w + len - n + i] *= 1 - (i + 1) / n;
      }
      // …and ramp IN out of one (not at the true file start).
      if (k > 0) {
        const n = Math.min(fade, len);
        for (let i = 0; i < n; i++) dst[w + i] *= (i + 1) / n;
      }
      w += len;
    }
  }
  return out;
}

/** Cut [t0, t1) (EFFECTIVE seconds) out of parallel time/strength arrays that
 *  live in effective time: entries inside are dropped, entries after slide. */
export function cutTimes(times: Float32Array, strengths: Float32Array, t0: number, t1: number): { times: Float32Array; strengths: Float32Array } {
  const removed = t1 - t0;
  const outT: number[] = []; const outS: number[] = [];
  for (let i = 0; i < times.length; i++) {
    const t = times[i];
    if (t >= t0 && t < t1) continue;
    outT.push(t >= t1 ? t - removed : t);
    outS.push(strengths[i] ?? 0);
  }
  return { times: Float32Array.from(outT), strengths: Float32Array.from(outS) };
}

/** FILE-time arrays → EFFECTIVE (entries inside a trim dropped, the rest
 *  mapped). For detection results computed on the original. */
export function mapTimesFileToEff(times: Float32Array, strengths: Float32Array, trims: TrimRegion[]): { times: Float32Array; strengths: Float32Array } {
  if (!trims.length) return { times, strengths };
  const outT: number[] = []; const outS: number[] = [];
  for (let i = 0; i < times.length; i++) {
    const t = times[i];
    if (trims.some(r => t >= r.startSec && t < r.endSec)) continue;
    outT.push(fileToEff(trims, t));
    outS.push(strengths[i] ?? 0);
  }
  return { times: Float32Array.from(outT), strengths: Float32Array.from(outS) };
}

/** FILE-time ranges (e.g. the stems' ready spans) → EFFECTIVE ranges: each
 *  range is clipped to the kept parts and mapped; touching pieces merge. */
export function mapFileRangesToEff(ranges: Array<[number, number]>, trims: TrimRegion[]): Array<[number, number]> {
  if (!trims.length) return ranges.map(r => [r[0], r[1]]);
  const out: Array<[number, number]> = [];
  for (const [s, e] of ranges) {
    // walk the kept pieces of [s, e)
    let cur = s;
    const sorted = [...trims].sort((a, b) => a.startSec - b.startSec);
    for (const t of sorted) {
      if (t.endSec <= cur) continue;
      if (t.startSec >= e) break;
      if (t.startSec > cur) out.push([fileToEff(trims, cur), fileToEff(trims, t.startSec)]);
      cur = Math.max(cur, t.endSec);
    }
    if (cur < e) out.push([fileToEff(trims, cur), fileToEff(trims, e)]);
  }
  out.sort((a, b) => a[0] - b[0]);
  const merged: Array<[number, number]> = [];
  for (const r of out) {
    const last = merged[merged.length - 1];
    if (last && r[0] <= last[1] + 1e-6) last[1] = Math.max(last[1], r[1]);
    else if (r[1] > r[0]) merged.push([r[0], r[1]]);
  }
  return merged;
}
