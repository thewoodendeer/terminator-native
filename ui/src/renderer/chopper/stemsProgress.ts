/**
 * SPLIT PROGRESS ESTIMATOR — pure, timer-free (the controller owns the
 * interval; this owns the maths), gated by test:stems-progress.
 *
 * The engine reports real progress once per 7.8 s chunk (one blocking model
 * run — nothing can tick inside it): ~2 s apart at FAST, ~8 s at FINE, and the
 * FIRST chunk used to be blind (no rate measured yet → the % sat at 0, then
 * jumped). Now the 'ready' message carries the chunk TOTAL, and the creep is
 * seeded from the LAST run's measured ms-per-chunk for that quality, so the
 * number moves from second one. Between real ticks the SHOWN pct creeps toward
 * the next expected tick at the measured rate, capped just under it; it never
 * goes backwards (queueWindow mid-run can grow the denominator).
 */
export interface SplitSm {
  shown: number;      // what the UI shows (integer pct, monotonic)
  real: number;       // last real pct from the engine
  step: number;       // pct per real tick (seeded = one chunk; then measured)
  msPerStep: number;  // ms per real tick (seeded from history; then measured)
  lastT: number;      // ms clock of the last real tick
  chunkPct: number;   // 100 / total chunks (0 = unknown)
  msPerChunk: number; // latest measured ms per CHUNK (0 = none yet)
}
export const DEFAULT_MS_PER_CHUNK: Record<'fast' | 'fine', number> = { fast: 2000, fine: 8500 };
export const freshSplitSm = (): SplitSm => ({ shown: 0, real: 0, step: 0, msPerStep: 2000, lastT: 0, chunkPct: 0, msPerChunk: 0 });
const clampMs = (ms: number) => Math.min(30000, Math.max(250, ms));

/** Engine says 'ready' with `total` chunks: seed the creep from `msPerChunk`
 *  (last run's measurement, or the quality default). */
export function seedSplitSm(s: SplitSm, total: number, msPerChunk: number, now: number): void {
  if (!(total > 0)) return;
  s.chunkPct = 100 / total;
  s.step = s.chunkPct;
  s.msPerStep = clampMs(msPerChunk > 0 ? msPerChunk : 2000);
  s.real = 0;
  s.lastT = now;
}
/** A real tick from the engine. Returns the new shown pct. */
export function tickSplitSm(s: SplitSm, real: number, now: number): number {
  if (s.lastT && real > s.real) {
    s.step = real - s.real;
    s.msPerStep = clampMs(now - s.lastT);
    if (s.chunkPct > 0) s.msPerChunk = (s.msPerStep / s.step) * s.chunkPct; // FINE ticks per specialist — normalise to a chunk
  }
  if (real !== s.real || !s.lastT) { s.real = real; s.lastT = now; }
  s.shown = Math.max(s.shown, Math.min(real, 99));
  return s.shown;
}
/** Between ticks: the creeping estimate, or null when nothing should change. */
export function creepSplitSm(s: SplitSm, now: number): number | null {
  if (!s.step || !s.lastT) return null;
  const est = s.real + Math.min(((now - s.lastT) / s.msPerStep) * s.step, s.step - 0.5);
  const next = Math.min(Math.floor(est), 99);
  if (next <= s.shown) return null;
  s.shown = next;
  return next;
}
/** What to remember for next time: a gentle average of old and measured. */
export function blendMsPerChunk(previous: number, measured: number): number {
  if (!(measured > 0)) return previous;
  if (!(previous > 0)) return measured;
  return Math.round(previous * 0.5 + measured * 0.5);
}
