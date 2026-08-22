/**
 * MIDI CLOCK (receive) — follow the tempo of the device that pressed PLAY.
 * The transport already follows MIDI START / CONTINUE / STOP from a controller
 * (an MPC in sync-send mode starts and stops Terminator). Without following its
 * CLOCK too the two run at different tempos and drift apart within a bar — so
 * while an external START is in charge, the 24-ppqn ticks set the session BPM.
 *
 * Pure estimator (gate: npm run test:midi-clock-in): feed tick receive times
 * (ms — Web MIDI's event.timeStamp, not the handler's own clock), get back a
 * BPM when there is a settled new value — at most once per beat, never from
 * fewer than a beat of ticks, reset on a drop-out so a pause can't read as a
 * crawl. Rounded to 0.1 BPM with a little hysteresis so USB jitter does not
 * wobble the display.
 */
export const PPQN_IN = 24;
const WINDOW_TICKS = 48;      // two beats of history → ~0.1 % with ±1 ms jitter
const MIN_TICKS = 25;         // a full beat before the first estimate
const DROPOUT_MS = 1000;      // a gap this long = the clock stopped; start over
const HYSTERESIS_BPM = 0.3;

/**
 * ONE PORT OWNS THE CLOCK. An MPC (the MPC Sample included) shows up as more
 * than one MIDI input — and sends its clock + transport on EVERY one of them.
 * Terminator listens to every port, so each tick arrived twice: 24 ppqn read
 * as 48, and an 89 BPM session showed 177–178 on the readout (his report
 * 2026-08-22), while PLAY restarted the transport once per port. The port that
 * sends START (or CONTINUE) owns the transport and the clock until its STOP;
 * the same message from another port inside DUPLICATE_MS is the same press
 * seen twice and is ignored; ticks from any other port are dropped. Pure —
 * gate: npm run test:midi-clock-in.
 */
const DUPLICATE_MS = 500;
export class MidiClockSourceLock {
  private owner: string | null = null;
  private startedAt = 0;
  reset(): void { this.owner = null; this.startedAt = 0; }
  /** START / CONTINUE from `port` at `atMs`: act on it? */
  onStart(port: string, atMs: number): boolean {
    if (this.owner !== null && this.owner !== port && atMs - this.startedAt < DUPLICATE_MS) return false; // the same press on another port
    this.owner = port; this.startedAt = atMs;
    return true;
  }
  /** A clock tick from `port`: count it? (Only the owner's ticks count.) */
  onTick(port: string): boolean { return this.owner === null || this.owner === port; }
  /** STOP from `port`: act on it? Any port may stop (a stray STOP is harmless
   *  when nothing runs), and the lock clears so the next START can come from
   *  anywhere. */
  onStop(_port: string): boolean { this.reset(); return true; }
  ownerPort(): string | null { return this.owner; }
}

export class MidiClockFollower {
  private times: number[] = [];
  private last = 0;
  private sinceReport = 0;
  private jumpRun = 0;
  reset(): void { this.times = []; this.sinceReport = 0; this.jumpRun = 0; }
  /** The BPM the clock has settled on, when it is NEW — else null. */
  onTick(atMs: number): number | null {
    const prevArr = this.times;
    const prev = prevArr.length ? prevArr[prevArr.length - 1] : NaN;
    // A long gap = the clock stopped and started again: start the window over
    // (never read the gap as a crawl).
    if (Number.isFinite(prev) && atMs - prev > DROPOUT_MS) this.reset();
    // A tempo JUMP on the master (the interval leaves the window's mean by
    // > 15 % for three ticks running): drop the old tempo's ticks so the new
    // one reads within a beat instead of blending across the whole window.
    if (this.times.length >= MIN_TICKS && Number.isFinite(prev)) {
      const mean = (this.times[this.times.length - 1] - this.times[0]) / (this.times.length - 1);
      const iv = atMs - prev;
      if (Math.abs(iv - mean) > 0.15 * mean) { this.jumpRun++; if (this.jumpRun >= 3) { const keep = this.times.slice(-3); this.times = keep; this.jumpRun = 0; } }
      else this.jumpRun = 0;
    }
    const t = this.times;
    t.push(atMs);
    if (t.length > WINDOW_TICKS) t.shift();
    this.sinceReport++;
    if (t.length < MIN_TICKS) return null;
    // least-squares slope (ms per tick) over the window — averages USB jitter
    const n = t.length; const mi = (n - 1) / 2;
    let mt = 0; for (let i = 0; i < n; i++) mt += t[i]; mt /= n;
    let num = 0, den = 0;
    for (let i = 0; i < n; i++) { const di = i - mi; num += di * (t[i] - mt); den += di * di; }
    const perTick = den > 0 ? num / den : 0;
    if (!(perTick > 0)) return null;
    const bpm = Math.round((60000 / (perTick * PPQN_IN)) * 10) / 10;
    if (bpm < 20 || bpm > 400) return null;
    const fresh = this.last === 0 || Math.abs(bpm - this.last) >= HYSTERESIS_BPM;
    if (!fresh || (this.last !== 0 && this.sinceReport < PPQN_IN)) return null;
    this.last = bpm; this.sinceReport = 0;
    return bpm;
  }
  current(): number { return this.last; }
}
