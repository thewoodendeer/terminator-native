/**
 * NativeClock — the page's view of the native engine's sample clock (Terminator 3.0, Phase 3.2).
 *
 * Three timelines meet here:
 *   • engine SAMPLES (the C++ Engine's samplesProcessed — the chop sequencer, every booked hit);
 *   • HOST time (juce::Time::getHighResolutionTicks in ns — the audio callback stamps each block's entry with it,
 *     the snapshot carries that anchor: `clockHostNs` ↔ `clockSample`);
 *   • the page's clocks: performance.now() (ms) and the AudioContext (seconds, the drums/bass/metronome clock).
 * host ↔ performance.now(): a constant offset, calibrated by round trip (`terminatorAudio {verb:'clock'}`): the
 * best-RTT sample wins (the classic NTP rule: strictly better RTT replaces; a stale best is replaced after 30 s). Every snapshot's `emitHostNs` is a one-way upper bound (receive ≥ emit) that can only
 * tighten the estimate. host ↔ samples: the snapshot's last-block anchor, exact. ctx ↔ performance: the context's
 * own `getOutputTimestamp()` pair (what is HEARD at which performance time); the native side adds its device's
 * output latency so both timelines are compared at the ear.
 * Pure math — no DOM, no bridge (the shadow feeds it): `scripts/test-native-clock.mts` gates it.
 */
export interface ClockAnchor { clockHostNs: number; clockSample: number; sampleRate: number; emitHostNs?: number }
export interface CtxPair { contextTime: number; performanceTime: number }

export class NativeClock {
  private offsetMs = NaN;        // performance.now() − hostNs/1e6
  private bestRttMs = Infinity;
  private bestAtMs = -Infinity;  // performance time of the best-RTT sample
  private anchorHostNs = 0;
  private anchorSample = 0;
  private sr = 0;
  /** The native device's output latency (ms): sample S is HEARD at hostNsAtSample(S) + this. */
  outputLatencyMs = 0;
  roundTrips = 0;
  private readonly now: () => number;

  constructor(now: () => number = () => performance.now()) { this.now = now; }

  get ready(): boolean { return Number.isFinite(this.offsetMs) && this.sr > 0 && this.anchorHostNs > 0; }
  get rttMs(): number { return this.bestRttMs; }
  get sampleRate(): number { return this.sr; }
  /** performance.now() − hostNs/1e6 (NaN until calibrated). */
  get hostOffsetMs(): number { return this.offsetMs; }

  /** One round trip: `t0` = performance time the request was sent, `hostNs` = the reply's host time, `t1` =
   *  performance time the reply arrived. */
  addRoundTrip(t0: number, hostNs: number, t1: number): void {
    if (!(t1 >= t0) || !(hostNs > 0)) return;
    const rtt = t1 - t0;
    const off = (t0 + t1) / 2 - hostNs / 1e6;
    this.roundTrips++;
    if (rtt < this.bestRttMs || t1 - this.bestAtMs > 30000 || !Number.isFinite(this.offsetMs)) {
      this.bestRttMs = rtt; this.offsetMs = off; this.bestAtMs = t1;
    }
  }

  /** A snapshot (or the clock reply): the host ↔ sample anchor, and the one-way bound from its emit time. */
  onSnapshot(s: ClockAnchor, receivedAtMs: number = this.now()): void {
    if (s.clockHostNs > 0 && s.sampleRate > 0 && Number.isFinite(s.clockSample)) {
      this.anchorHostNs = s.clockHostNs; this.anchorSample = s.clockSample; this.sr = s.sampleRate;
    }
    if (s.emitHostNs && s.emitHostNs > 0 && Number.isFinite(this.offsetMs)) {
      const bound = receivedAtMs - s.emitHostNs / 1e6; // the true offset is ≤ this (we received after they emitted)
      if (this.offsetMs > bound) this.offsetMs = bound;
    }
  }

  // ── host ↔ performance ──
  hostNsToPerfMs(hostNs: number): number { return hostNs / 1e6 + this.offsetMs; }
  perfMsToHostNs(perfMs: number): number { return (perfMs - this.offsetMs) * 1e6; }
  // ── host ↔ samples (the scheduling timeline) ──
  sampleAtHostNs(hostNs: number): number { return this.anchorSample + (hostNs - this.anchorHostNs) * this.sr / 1e9; }
  hostNsAtSample(sample: number): number { return this.anchorHostNs + (sample - this.anchorSample) * 1e9 / this.sr; }
  // ── samples ↔ performance, at the EAR (the device's output latency added) ──
  perfMsHeardAtSample(sample: number): number { return this.hostNsToPerfMs(this.hostNsAtSample(sample)) + this.outputLatencyMs; }
  sampleHeardAtPerfMs(perfMs: number): number { return this.sampleAtHostNs(this.perfMsToHostNs(perfMs - this.outputLatencyMs)); }
  // ── samples ↔ AudioContext time, through a heard-pair {contextTime, performanceTime} (ctxPair below) ──
  ctxTimeAtSample(sample: number, pair: CtxPair): number { return pair.contextTime + (this.perfMsHeardAtSample(sample) - pair.performanceTime) / 1000; }
  sampleAtCtxTime(ctxSec: number, pair: CtxPair): number { return this.sampleHeardAtPerfMs(pair.performanceTime + (ctxSec - pair.contextTime) * 1000); }
}

/** The context's heard-pair — "context time C is HEARD at performance time P". getOutputTimestamp() when the
 *  browser's pair really carries the output latency (contextTime trails currentTime); WebKit's returns contextTime
 *  ≈ currentTime (measured: delta 0 with outputLatency 16 ms) — then, and when the API is missing, the pair is built
 *  from the scheduling clock plus `outputLatency` (else `baseLatency`): C = currentTime is heard at now + latency. */
export function ctxPair(ctx: { currentTime: number; outputLatency?: number; baseLatency?: number; getOutputTimestamp?: () => { contextTime?: number; performanceTime?: number } }, now: () => number = () => performance.now()): CtxPair {
  const ots = ctx.getOutputTimestamp?.();
  if (ots && typeof ots.contextTime === 'number' && typeof ots.performanceTime === 'number' && Number.isFinite(ots.contextTime) && Number.isFinite(ots.performanceTime) && ots.contextTime > 0 && ctx.currentTime - ots.contextTime > 0.001) {
    return { contextTime: ots.contextTime, performanceTime: ots.performanceTime };
  }
  const latency = (ctx.outputLatency && ctx.outputLatency > 0) ? ctx.outputLatency : (ctx.baseLatency && ctx.baseLatency > 0 ? ctx.baseLatency : 0);
  return { contextTime: ctx.currentTime, performanceTime: now() + latency * 1000 };
}
/** What the pair puts between a scheduling time and its output right now (seconds) — the ctx output latency it knows. */
export function ctxHeardLatencySec(ctx: { currentTime: number }, pair: CtxPair, now: () => number = () => performance.now()): number {
  return Math.max(0, (ctx.currentTime - pair.contextTime) + (pair.performanceTime - now()) / 1000);
}
