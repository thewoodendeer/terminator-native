// AUDIO CLOCK — the tick source for every look-ahead scheduler (chop
// sequencer, drums, bass, metronome).
//
// Why a Worker: a main-thread setInterval is exactly what browsers throttle.
// A hidden tab clamps it to once a second (Chrome/Safari); iOS Safari holds
// main-thread timers during a touch scroll and its momentum tail; a heavy
// React commit delays it by however long the commit takes. Each of those was
// audible — "the audio jumps when I scroll the tabs". A Worker's setInterval
// keeps firing through all of that; its message still has to be handled by
// the main thread, but it is queued the moment the thread is free instead of
// waiting for the next timer slot, and it is not subject to background
// clamping. The scheduling itself (AudioBufferSourceNode.start / OscillatorNode
// automation) stays on the main thread — Web Audio requires it — so the
// look-ahead in each engine is what covers a stall; the tick just has to keep
// coming, and this is the tick.
//
// Falls back to setInterval when a Worker can't be made (CSP, old WebView).
//
// One shared worker, many subscribers, each with its own interval.

export interface ClockHandle { stop(): void }

let worker: Worker | null = null;
let workerBroken = false;
let nextId = 1;
const subs = new Map<number, () => void>();

const WORKER_SRC = `
const timers = new Map();
onmessage = (e) => {
  const { cmd, id, ms } = e.data || {};
  if (cmd === 'start') {
    if (timers.has(id)) clearInterval(timers.get(id));
    timers.set(id, setInterval(() => postMessage(id), ms));
  } else if (cmd === 'stop') {
    const t = timers.get(id); if (t !== undefined) { clearInterval(t); timers.delete(id); }
  }
};
`;

function getWorker(): Worker | null {
  if (worker) return worker;
  if (workerBroken) return null;
  try {
    const url = URL.createObjectURL(new Blob([WORKER_SRC], { type: 'application/javascript' }));
    const w = new Worker(url);
    w.onmessage = (e: MessageEvent) => {
      const cb = subs.get(e.data as number);
      if (cb) { try { cb(); } catch { /* a scheduler throw must not kill the clock */ } }
    };
    w.onerror = () => { workerBroken = true; };
    worker = w;
    return w;
  } catch {
    workerBroken = true;
    return null;
  }
}

/** Start calling `tick` every `intervalMs`. Returns a handle to stop it. */
export function startClock(tick: () => void, intervalMs: number): ClockHandle {
  const w = getWorker();
  if (w) {
    const id = nextId++;
    subs.set(id, tick);
    w.postMessage({ cmd: 'start', id, ms: intervalMs });
    return { stop() { subs.delete(id); try { w.postMessage({ cmd: 'stop', id }); } catch { /* */ } } };
  }
  const t = setInterval(tick, intervalMs);
  return { stop() { clearInterval(t); } };
}

/** Adaptive look-ahead. Each scheduler owns one: `horizon()` returns how far
 *  ahead (seconds) to fill right now. Every tick calls `beat()`; a tick that
 *  arrives late (the main thread was held) grows the horizon to `boosted` for
 *  the next few seconds so the NEXT stall of that size is already covered,
 *  then it settles back to `base` — a small horizon keeps edits and tempo
 *  changes snappy, a big one only when the machine has shown it needs it. */
export class LookAhead {
  private lastTick = 0;
  private boostUntil = 0;
  constructor(private base: number, private boosted: number, private intervalMs: number) {}
  beat(): void {
    const now = performance.now();
    if (this.lastTick && now - this.lastTick > this.intervalMs * 3) this.boostUntil = now + 6000;
    this.lastTick = now;
  }
  reset(): void { this.lastTick = 0; }
  horizon(): number { return performance.now() < this.boostUntil ? this.boosted : this.base; }
}
