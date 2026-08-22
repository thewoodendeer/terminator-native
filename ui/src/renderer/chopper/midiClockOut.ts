/**
 * MIDI CLOCK (send) — Terminator as the master clock for outboard gear / a DAW.
 * Preferences → MIDI → "MIDI Clock (send)" (settings.midi.clock) + the MIDI
 * Outputs toggles choose where it goes. Rides the SAME transport anchor the
 * drums and bass phase-lock to (ChopperEngine.setTransportHooks): on PLAY we
 * send Song Position 0 + START stamped at the anchor and then 24 ticks per
 * quarter note, scheduled a little ahead off the audio clock (ticks carry a
 * performance-time stamp — Web MIDI queues future sends, so they land on the
 * audio grid, not on the main thread's mood); STOP on stop. Tempo changes take
 * effect at the next tick — the spacing is re-read per tick from the same
 * running timeline, so a BPM move never jumps or doubles a tick.
 *
 * Pure maths is exported for the gate (npm run test:midi-clock).
 */
import { startClock, type ClockHandle } from '../lib/audioClock';

export const MIDI_CLOCK = 0xf8, MIDI_START = 0xfa, MIDI_CONTINUE = 0xfb, MIDI_STOP = 0xfc, MIDI_SPP = 0xf2;
export const PPQN = 24;
/** How far ahead ticks are booked (s). Bigger = safer against main-thread
 *  stalls, smaller = a tempo change lands sooner. 0.15 s ≈ 4-7 ticks. */
export const CLOCK_LOOKAHEAD_S = 0.15;
export const CLOCK_PUMP_MS = 25;
/** A stall shorter than this still delivers every tick (late, bunched — gear
 *  averages them and the TICK COUNT, which IS the song position, stays true).
 *  Longer than this the slave is lost anyway: skip forward whole ticks rather
 *  than sprint through seconds of stale ones. */
export const CLOCK_STALL_SKIP_S = 1.0;

export const secondsPerTick = (bpm: number): number => 60 / Math.max(20, Math.min(400, bpm || 120)) / PPQN;

/** Book every tick time from `nextTickTime` up to (not incl.) `horizon`, the
 *  spacing read per tick from `bpmAt` (a tempo change mid-window takes effect
 *  at the next tick). Returns the booked times and where the next one goes. */
export function bookTicks(nextTickTime: number, horizon: number, bpmAt: () => number): { times: number[]; next: number } {
  const times: number[] = [];
  let t = nextTickTime;
  while (t < horizon) { times.push(t); t += secondsPerTick(bpmAt()); }
  return { times, next: t };
}

export interface ClockOutput { send(data: number[] | Uint8Array, timestamp?: number): void }
export interface ClockCtx { currentTime: number; getOutputTimestamp?: () => { contextTime?: number; performanceTime?: number } }

export class MidiClockSender {
  private running = false;
  private nextTickTime = 0;
  private timer: ClockHandle | null = null;
  private enabled = false;
  constructor(
    private ctx: ClockCtx,
    private getBpm: () => number,
    private outputs: () => ClockOutput[],
    private now: () => number = () => (typeof performance !== 'undefined' ? performance.now() : Date.now()),
  ) {}

  isEnabled(): boolean { return this.enabled; }
  isRunning(): boolean { return this.running; }
  /** The Preferences toggle. Turning it off mid-run sends STOP and goes quiet. */
  setEnabled(on: boolean): void {
    if (this.enabled === on) return;
    this.enabled = on;
    if (!on && this.running) this.stop();
  }

  /** ctx seconds → MIDI (performance) milliseconds, via the context's own
   *  output timestamp pair when the browser offers it. */
  toMidiTime(ctxSec: number): number {
    const ots = this.ctx.getOutputTimestamp?.();
    if (ots && typeof ots.performanceTime === 'number' && typeof ots.contextTime === 'number' && Number.isFinite(ots.performanceTime) && Number.isFinite(ots.contextTime)) return ots.performanceTime + (ctxSec - ots.contextTime) * 1000;
    return this.now() + (ctxSec - this.ctx.currentTime) * 1000;
  }
  private send(data: number[], ctxSec: number): void {
    const ts = this.toMidiTime(ctxSec);
    for (const o of this.outputs()) { try { o.send(data, ts); } catch { /* a port that just vanished */ } }
  }

  /** PLAY: the transport's anchor (ctx seconds). Song Position 0, START, then
   *  ticks from the anchor. A stop() → start() pair (a restart) does the same. */
  start(atCtxTime: number): void {
    if (!this.enabled) return;
    if (this.running) this.stop();
    this.running = true;
    this.nextTickTime = atCtxTime;
    this.send([MIDI_SPP, 0, 0], atCtxTime);
    this.send([MIDI_START], atCtxTime);
    this.pump();
    this.timer = startClock(() => this.pump(), CLOCK_PUMP_MS);
  }
  /** STOP now. Ticks already booked past now still go out (a few ms) — gear
   *  ignores ticks after STOP, and a hard cut would need a port flush Web
   *  MIDI does not offer (MIDIOutput.clear() is not implemented anywhere). */
  stop(): void {
    if (!this.running) return;
    this.running = false;
    if (this.timer) { this.timer.stop(); this.timer = null; }
    this.send([MIDI_STOP], this.ctx.currentTime);
  }
  /** Book ticks up to the look-ahead horizon. Public for the gate. */
  pump(): void {
    if (!this.running) return;
    const now = this.ctx.currentTime;
    // Fell behind by a LONG stall? Skip forward whole ticks from the same
    // timeline. (A short one delivers its late ticks — see CLOCK_STALL_SKIP_S.)
    if (now - this.nextTickTime > CLOCK_STALL_SKIP_S) {
      const spt = secondsPerTick(this.getBpm());
      const missed = Math.floor((now - this.nextTickTime) / spt);
      this.nextTickTime += missed * spt;
    }
    const { times, next } = bookTicks(this.nextTickTime, now + CLOCK_LOOKAHEAD_S, this.getBpm);
    for (const t of times) this.send([MIDI_CLOCK], t);
    this.nextTickTime = next;
  }
  dispose(): void { this.stop(); }
}
