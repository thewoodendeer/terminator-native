// NativeClock gate: the page-side mapping engine samples ↔ host ns ↔ performance.now() ↔ AudioContext time
// (ui/src/renderer/native/nativeClock.ts) against a simulated host — RTT calibration picks the best round trip,
// the one-way bound only tightens, the sample mappings invert exactly, drift between two audio clocks is seen.
// Run: npm run test:clock
import { NativeClock, ctxPair, ctxHeardLatencySec } from '../src/renderer/native/nativeClock.ts';

const passed: string[] = [], failed: string[] = [];
const ok = (name: string, cond: unknown, extra?: unknown) => { (cond ? passed : failed).push(name + (extra !== undefined ? ` — ${typeof extra === 'string' ? extra : JSON.stringify(extra)}` : '')); if (!cond) console.error('FAIL', name, extra ?? ''); };
const near = (a: number, b: number, tol: number) => Math.abs(a - b) <= tol;

// a simulated world: perf ms = hostNs/1e6 + TRUE_OFFSET; engine runs at 48k anchored at (hostNs0, sample0)
const TRUE_OFFSET = -123456.789; // ms (perf.now starts near 0 at page load; host ns is since boot → negative)
const SR = 48000;
let perf = 1000; // performance.now()
const hostNsOf = (p: number) => (p - TRUE_OFFSET) * 1e6;
const clock = new NativeClock(() => perf);
ok('not ready before calibration', !clock.ready);

// round trips with varying latency: 0.4..6 ms, asymmetric (the reply comes early in the window: 30 % up, 70 %
// down → the midpoint estimate sits ABOVE the truth — the one-way bound can then pull it down); best RTT wins
const rtts = [3.1, 0.9, 5.8, 0.42, 2.2, 0.45, 4.0];
for (const r of rtts) {
  const t0 = perf; const up = r * 0.3; const hostAtReply = hostNsOf(t0 + up); const t1 = t0 + r;
  clock.addRoundTrip(t0, hostAtReply, t1);
  perf = t1 + 100;
}
ok('best RTT kept (0.42 ms)', near(clock.rttMs, 0.42, 1e-9), clock.rttMs);
// with asymmetry 0.3/0.7 the midpoint estimate is off by (0.5−0.3)·rtt = +0.084 ms for the 0.42 sample
ok('offset within 0.1 ms of the truth', near(clock.hostOffsetMs, TRUE_OFFSET, 0.1), clock.hostOffsetMs - TRUE_OFFSET);

// the snapshot anchor: block entry at host H0 = sample 960000; an emit 0.05 ms later, received 0.3 ms after that
const H0 = hostNsOf(perf);
clock.onSnapshot({ clockHostNs: H0, clockSample: 960000, sampleRate: SR, emitHostNs: H0 + 50_000 }, perf + 0.35);
ok('ready after anchor', clock.ready);
ok('one-way bound only tightens (never loosens)', clock.hostOffsetMs <= TRUE_OFFSET + 0.1 && clock.hostOffsetMs >= TRUE_OFFSET - 0.1);
// a bound tighter than the estimate pulls it down: receive exactly at emit (0 latency) → offset == truth
clock.onSnapshot({ clockHostNs: H0, clockSample: 960000, sampleRate: SR, emitHostNs: H0 + 50_000 }, perf + 0.05);
ok('a zero-latency one-way bound lands on the truth', near(clock.hostOffsetMs, TRUE_OFFSET, 1e-6), clock.hostOffsetMs - TRUE_OFFSET);

// sample ↔ host exact inverses
ok('sampleAtHostNs(anchor) = anchorSample', clock.sampleAtHostNs(H0) === 960000);
ok('hostNsAtSample(anchor+48000) = +1 s', near(clock.hostNsAtSample(960000 + 48000), H0 + 1e9, 1e-3));
ok('round trip sample→host→sample', near(clock.sampleAtHostNs(clock.hostNsAtSample(1234567.5)), 1234567.5, 1e-6));

// samples ↔ performance at the ear: output latency 10 ms
clock.outputLatencyMs = 10;
const pHeard = clock.perfMsHeardAtSample(960000);
ok('sample 960000 is heard 10 ms after its block entry', near(pHeard, perf + 10, 1e-6), pHeard - perf);
ok('perf→sample inverts', near(clock.sampleHeardAtPerfMs(pHeard), 960000, 1e-6));

// ctx mapping through a heard-pair: ctx time 5.0 s is heard at perf P; the context runs at 1× perf
const pair = { contextTime: 5.0, performanceTime: perf + 200 };
const s5 = clock.sampleAtCtxTime(5.0, pair);
ok('ctx 5.0 s ↔ the sample heard at the same instant', near(clock.perfMsHeardAtSample(s5), perf + 200, 1e-6));
ok('ctxTimeAtSample inverts sampleAtCtxTime', near(clock.ctxTimeAtSample(s5, pair), 5.0, 1e-9));
ok('20 ms later in ctx = 960 samples later', near(clock.sampleAtCtxTime(5.02, pair) - s5, 960, 1e-6));

// DRIFT: the ctx device runs 100 ppm fast vs the native device: after 60 s of native time the pair (re-read from
// getOutputTimestamp) says ctx advanced 60.006 s — the native loop point is heard at ctx 65.006, i.e. 6 ms LATER
// than the ctx-scheduled drums at 65.0: the drift reads +6 ms = the satellites must be nudged 6 ms later
const pair60 = { contextTime: 5.0 + 60.006, performanceTime: perf + 200 + 60000 };
const s65 = s5 + 60 * SR;
ok('a 100 ppm ctx-vs-native drift reads as +6 ms after 60 s (native later in ctx terms → nudge later)', near(clock.ctxTimeAtSample(s65, pair60) - (5.0 + 60), 0.006, 1e-6), clock.ctxTimeAtSample(s65, pair60) - 65);

// ctxPair: uses getOutputTimestamp when its pair carries latency, else the scheduling clock + outputLatency
const c1 = ctxPair({ currentTime: 3, getOutputTimestamp: () => ({ contextTime: 2.98, performanceTime: 777 }) }, () => 999);
ok('ctxPair prefers a latency-carrying getOutputTimestamp', c1.contextTime === 2.98 && c1.performanceTime === 777);
const c2 = ctxPair({ currentTime: 3 }, () => 999);
ok('ctxPair falls back to the scheduling pair (no latency known)', c2.contextTime === 3 && c2.performanceTime === 999);
const c3 = ctxPair({ currentTime: 3, getOutputTimestamp: () => ({ contextTime: 0, performanceTime: 0 }) }, () => 999);
ok('ctxPair ignores a zero (not-yet-running) output timestamp', c3.contextTime === 3);
// WebKit: contextTime == currentTime (no latency in the pair) while outputLatency says 16 ms → heard 16 ms later
const c4 = ctxPair({ currentTime: 3, outputLatency: 0.016, getOutputTimestamp: () => ({ contextTime: 3, performanceTime: 999 }) }, () => 999);
ok('ctxPair adds outputLatency when the browser pair carries none', c4.contextTime === 3 && near(c4.performanceTime, 1015, 1e-9), c4);
ok('ctxHeardLatencySec reads 16 ms from it', near(ctxHeardLatencySec({ currentTime: 3 }, c4, () => 999), 0.016, 1e-9));
ok('ctxHeardLatencySec reads 20 ms from a latency-carrying pair', near(ctxHeardLatencySec({ currentTime: 3 }, c1, () => 777), 0.02, 1e-9));
const c5 = ctxPair({ currentTime: 3, baseLatency: 0.003, getOutputTimestamp: () => ({ contextTime: 3, performanceTime: 999 }) }, () => 999);
ok('ctxPair uses baseLatency when outputLatency is 0', near(c5.performanceTime, 1002, 1e-9));

// stale best: after 30 s a worse RTT replaces a stale best (the offset may have moved)
perf += 31000;
clock.addRoundTrip(perf, hostNsOf(perf + 1.0), perf + 2.0);
ok('a stale best is replaced after 30 s', near(clock.rttMs, 2.0, 1e-9), clock.rttMs);

console.log(`native-clock: ${passed.length} passed, ${failed.length} failed`);
if (failed.length) { console.error(failed.join('\n')); process.exit(1); }
