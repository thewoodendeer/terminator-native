// ─────────────────────────────────────────────────────────────────────────────
// THE WATCHDOG — what actually stopped the beat, said out loud.
//
// Victor, 2026-08-12, testing a real show on two machines: *"when im live i hit
// play and beat randomly stops playing. but sometimes it plays all the way
// through."* Two sessions of reading the live path have not found it, and it
// cannot be reproduced off his machines:
//
//   · nothing in the live path writes the transport (checked twice — and the
//     second pass found the first audit had MISSED two `playing` writers, so
//     "I read it and it isn't there" is not evidence any more);
//   · the probe harness can never bring its tab to the front, so `document.
//     hidden` stays true, rAF never runs, and the board's frame loop — which is
//     where the transport lives — cannot be made to run headlessly at all.
//
// So stop guessing and MEASURE IT WHERE IT HAPPENS. This samples the five
// things that can each independently silence a beat, four times a second, on
// its OWN timer — deliberately not the frame loop, because a dead frame loop is
// one of the things it has to be able to report.
//
// When the sound goes, it names the cause on screen, in words, without anybody
// opening a console mid-stream. The ten seconds LEADING UP to it are kept too:
// the interesting part of an intermittent fault is never the moment itself.
//
// It exists only while a show is on air, and one `if` is its entire cost when
// nobody is live.
// ─────────────────────────────────────────────────────────────────────────────

/** Everything that can independently make a playing beat inaudible. Read once
 *  per sample from the board, which owns all of it. */
export interface LiveVitals {
  /** The UI transport flag — `playing` in main.ts. */
  playing: boolean;
  /** The ENGINE's own flag. Diverging from `playing` means `syncTransport` is
   *  not being called, which means the frame loop is not running. */
  playingNow: boolean;
  /** AudioContext state. 'suspended'/'interrupted' = the browser took the device. */
  ctxState: string;
  /** ctx.currentTime. Frozen while 'running' = the audio thread itself died. */
  ctxTime: number;
  /** Post-fader master level. Zero while playing = signal, not transport. */
  vu: number;
  /** consolePowerGate's gain: the desk power switch AND the studio door. Zero
   *  means the mix is playing perfectly into a closed gate. */
  gate: number;
  /** Voices alive across every channel. Zero while playing = the SCHEDULER
   *  starved (the case the 150ms backstop exists to prevent). */
  voices: number;
  /** three's render counter. Not advancing = the frame loop is dead. */
  frame: number;
  /** The tab as the browser sees it — background throttling is real, and it is
   *  the first thing to rule out on an intermittent audio fault. */
  hidden: boolean;
  /** How many people are watching. A stop that lands on a join is a lead. */
  viewers: number;
}

export type StallCause =
  | 'transport-stopped'      // `playing` went false — SOMETHING wrote it
  | 'engine-stopped'         // playing true, engine false → frame loop not reconciling
  | 'context-lost'           // the browser took the AudioContext
  | 'audio-clock-frozen'     // ctx says running, currentTime is not moving
  | 'scheduler-starved'      // playing, but no voices are being spawned
  | 'gate-closed'            // console power / studio door muted the desk
  | 'frame-loop-dead';       // rAF stopped while everything else looks fine

export interface StallReport {
  cause: StallCause;
  /** Plain words, for the toast. Written for a producer mid-stream, not a dev. */
  said: string;
  /** Seconds into the show. */
  atShowSec: number;
  /** The sample that tripped it, and the ~10s before it. */
  at: LiveVitals;
  history: Array<LiveVitals & { t: number }>;
}

const SAMPLE_MS = 250;
/** ~10s of lead-up at 4Hz. The moment itself is never the interesting part. */
const HISTORY = 40;
/** How long a symptom must HOLD before it counts. Every one of these conditions
 *  is legitimately true for a frame or two in normal use — a seek empties the
 *  voice list, a door ramp passes through a low gain — and a watchdog that
 *  cries at those is one nobody reads. Two seconds is longer than any of them
 *  and far shorter than a producer's patience. */
const HOLD_MS = 2000;
/** Below this, a fader is down or the beat is genuinely silent. Not a fault on
 *  its own — only alongside "no voices". */
const VU_SILENT = 0.0005;

export class LiveWatchdog {
  private timer = 0;
  private readonly hist: Array<LiveVitals & { t: number }> = [];
  /** cause → the timestamp it first went bad, or 0 while it is fine. */
  private since: Partial<Record<StallCause, number>> = {};
  /** Reported once per episode: a stall that lasts a minute is ONE stall. */
  private reported: StallCause | null = null;
  private lastFrame = -1;
  private lastFrameAt = 0;
  private lastCtxTime = -1;
  private lastCtxAt = 0;

  /** The last thing that went wrong, kept for `__board.live.stall()` so it can
   *  still be read calmly after the toast has gone. */
  last: StallReport | null = null;

  constructor(
    private readonly read: () => LiveVitals,
    private readonly say: (text: string) => void,
    private readonly now: () => number,
  ) {}

  start(): void {
    if (this.timer) return;
    this.reset();
    // Its OWN timer, at a period the audio backstop already proves survives a
    // hidden tab (measured: a 150ms interval holds at 150ms while hidden).
    this.timer = window.setInterval(() => this.sample(), SAMPLE_MS);
  }

  stop(): void {
    if (this.timer) window.clearInterval(this.timer);
    this.timer = 0;
    this.reset();
  }

  private reset(): void {
    this.hist.length = 0;
    this.since = {};
    this.reported = null;
    this.lastFrame = -1;
    this.lastFrameAt = 0;
    this.lastCtxTime = -1;
    this.lastCtxAt = 0;
  }

  /** Exposed for tests and for the probe: one sample, scored. */
  sample(): StallReport | null {
    let v: LiveVitals;
    try { v = this.read(); } catch { return null; }   // mid-teardown: not a fault
    const t = this.now();
    this.hist.push({ ...v, t });
    if (this.hist.length > HISTORY) this.hist.shift();

    // Two vitals are only meaningful as a RATE, so derive their staleness here
    // rather than asking the caller to remember across samples.
    if (v.frame !== this.lastFrame) { this.lastFrame = v.frame; this.lastFrameAt = t; }
    if (v.ctxTime !== this.lastCtxTime) { this.lastCtxTime = v.ctxTime; this.lastCtxAt = t; }
    const frameStaleMs = this.lastFrameAt ? t - this.lastFrameAt : 0;
    const clockStaleMs = this.lastCtxAt ? t - this.lastCtxAt : 0;

    const cause = this.score(v, frameStaleMs, clockStaleMs);
    if (!cause) { this.since = {}; this.reported = null; return null; }

    // HOLD: a symptom has to persist. Anything shorter is a seek, a door, or a
    // frame the governor skipped.
    const since = this.since[cause] ?? (this.since[cause] = t);
    if (t - since < HOLD_MS) return null;
    if (this.reported === cause) return null;
    this.reported = cause;

    const report: StallReport = {
      cause,
      said: SAID[cause],
      atShowSec: 0,
      at: v,
      history: this.hist.slice(),
    };
    this.last = report;
    // Both, on purpose: the toast is for him mid-stream, the console line is
    // what he can send back afterwards.
    this.say(`AUDIO STOPPED — ${SAID[cause]}`);
    console.warn('[board] LIVE STALL:', cause, SAID[cause], report.at, report.history);
    return report;
  }

  /** ONE cause, most specific first — a starved scheduler also reads as silent
   *  VU, and naming the symptom instead of the cause is how a diagnostic wastes
   *  somebody's afternoon. */
  private score(v: LiveVitals, frameStaleMs: number, clockStaleMs: number): StallCause | null {
    // Nothing is wrong if nothing is supposed to be making sound.
    if (!v.playing) {
      // …unless the engine still thinks it is playing, which means the UI flag
      // was written by something and the two halves have come apart.
      return v.playingNow ? 'transport-stopped' : null;
    }
    if (v.ctxState !== 'running') return 'context-lost';
    if (clockStaleMs >= HOLD_MS) return 'audio-clock-frozen';
    if (!v.playingNow) return 'engine-stopped';
    if (v.gate <= 0.001) return 'gate-closed';
    if (v.voices === 0 && v.vu < VU_SILENT) return 'scheduler-starved';
    // Everything is audible — but a dead frame loop is worth saying anyway,
    // because it is the state the beat dies FROM.
    if (frameStaleMs >= HOLD_MS && !v.hidden) return 'frame-loop-dead';
    return null;
  }
}

/** What each cause means, in the words a producer would use. These are what
 *  lands on screen, so they name the NEXT STEP wherever there is one. */
const SAID: Record<StallCause, string> = {
  'transport-stopped': 'something stopped the transport',
  'engine-stopped': 'the room stopped ticking, so the transport never started',
  'context-lost': 'the computer took the audio device back',
  'audio-clock-frozen': 'the audio engine froze',
  'scheduler-starved': 'the beat ran out of scheduled notes',
  'gate-closed': 'the desk is muted — console power, or you left the studio',
  'frame-loop-dead': 'the room stopped drawing',
};
