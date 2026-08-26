/**
 * nativeBassShadow — Phase 3.4: THE BASS THROUGH THE C++ ENGINE.
 *
 * Sits beside the page's BassEngine (which keeps owning the patch, the patterns the piano roll edits, KEY LOCK, the
 * recording, the arranger hand-off and the UI) and mirrors it into the native BassSynth + BassSequencer over the JUCE
 * bridge (docs/native/BRIDGE-PROTOCOL.md):
 *   • `BassEngine.bassSink.message` receives every message the TS would have posted to the AudioWorklet and translates
 *     it: `patch` → `setBassPatch` (the engine deep-merges it over the worklet's defaults); `note` → `bassNote` /
 *     `bassSlide` (its ctx-time `at` → an ENGINE SAMPLE through NativeClock; 0 / the past = now); `notes` + `bends`
 *     tagged `arr` (the arranger's playTimeline) → ONE `setBassTimeline` (absolute events, flushed in a microtask so
 *     the bends posted first and the notes posted next land together); `bend` → `bassBend` (now or timed); `mod` →
 *     `bassMod`; `clear` → `bassClear` / `clearBassTimeline`; `panic` → `bassPanic`;
 *   • PLAY → `bassPlay {atSample, offsetTicks}` at the page's anchor (the chopper transport's — an engine sample
 *     through NativeClock), STOP → `bassStop` (the engine releases the seq notes + unbends); the audible pattern goes as
 *     `setBassPattern {bars, notes[{id,note,start,dur,vel,slide}], bend[per tick]}` on PLAY and on every edit
 *     (signature-diffed — the TS mutates the pattern in place), + `bassBendLane {on}` (false while ● REC: the wheel
 *     owns the lane); `arrangerDriven` → `bassArrangerDriven`;
 *   • the playhead (`getPlayheadBeats`) reads `elapsedSec()` = the engine's position at the ear through NativeClock;
 *     the 20 Hz snapshot re-anchors the ctx-time tick origin the live-record landing uses + pushes the engine's
 *     sounding notes (the roll's dim keys) + its meter (`nativeBassUpdate` / `nativeMeter`).
 * Not mirrored (honest list): exports still render through the TS worklet offline (`renderBassOffline` — Phase 8 moves
 * exports into the engine); the bass plays DRY to outs 1/2 (its mixer strip is Phase 4).
 */
import { bendAt, PPQ, type BassEngine, type BassPattern } from '../bass/BassEngine';
import { ctxPair, type NativeClock } from './nativeClock';

type AnyRecord = Record<string, any>;

/** What the pad shadow lends the bass shadow: its commands, its clock and the snapshot. */
export interface BassShadowHost {
  /** A self-test poll step: the next native snapshot or ~50 ms, whichever first (optional). */
  tick?(ms?: number): Promise<void>;
  cmd(c: AnyRecord): Promise<boolean>;
  clock: NativeClock;
  ctx: AudioContext;
  latestSnapshot(): AnyRecord | null;
  leadSec(): number;
  /** A transport anchor (ctx seconds) → the engine sample PLAY should use (3.6: a count-in's downbeat = the exact
   *  sample the engine counted to; else the clock mapping). Optional — the mapping when absent. */
  anchorSample?(ctxSec: number): number;
  snapshotAgeMs(): number;
  cursorToleranceSteps(stepDurSec: number): number;
  note(stat: 'commands' | 'events', value: number): void;
  error(msg: string): void;
}

export class NativeBassShadow {
  private chain: Promise<void> = Promise.resolve();
  private lastPatch: unknown = null;
  private lastPatternSig = '';
  private lastBendLane: boolean | null = null;
  private lastArranger: boolean | null = null;
  private arrBuffer: AnyRecord[] = [];   // the timeline's events accumulating within one macrotask
  private arrFlushQueued = false;
  private unsubState: (() => void) | null = null;
  private detached = false;
  playAnchorCtx = NaN;

  constructor(private bass: BassEngine, private host: BassShadowHost) {}

  attach(): void {
    this.bass.bassSink = {
      message: (m) => this.message(m),
      play: (anchor, offsetTicks) => this.play(anchor, offsetTicks),
      stop: () => this.queue(() => this.host.cmd({ type: 'bassStop' })),
      pattern: (p, bendLane) => this.pattern(p, bendLane),
      arrangerDriven: (on) => { if (this.lastArranger !== on) { this.lastArranger = on; this.queue(() => this.host.cmd({ type: 'bassArrangerDriven', on })); } },
      elapsedSec: () => this.elapsedSec(),
      leadSec: () => this.host.leadSec(),
    };
    // the patch: on attach and whenever it changes (BassEngine.setPatch/setParam/loadFactory/restore make a new object)
    this.unsubState = this.bass.subscribe((s) => {
      if (this.detached) return;
      if (s.patch !== this.lastPatch) { this.lastPatch = s.patch; const patch = s.patch; this.queue(() => this.host.cmd({ type: 'setBassPatch', patch })); }
    });
  }

  detach(): void {
    this.detached = true;
    this.unsubState?.(); this.unsubState = null;
    if (this.bass.bassSink) {
      const wasPlaying = this.bass.getState().playing;
      this.bass.bassSink = null;
      if (wasPlaying) void this.host.cmd({ type: 'bassStop' });
      void this.host.cmd({ type: 'bassClear', tag: 'any', release: true });
    }
  }

  private queue(fn: () => Promise<unknown>): void {
    this.host.note('commands', 1);
    this.chain = this.chain.then(fn).then(() => {}).catch(() => {});
  }
  /** A ctx time → an engine sample (0 = now / the past / the clock not calibrated yet). */
  private sampleAt(ctxTime: number | undefined): number {
    if (ctxTime === undefined || !(ctxTime > this.host.ctx.currentTime) || !this.host.clock.ready) return 0;
    const s = Math.round(this.host.clock.sampleAtCtxTime(ctxTime, ctxPair(this.host.ctx)));
    return s > 0 ? s : 0;
  }

  // ── the worklet messages ──
  private message(m: AnyRecord): void {
    if (this.detached || !m || typeof m !== 'object') return;
    switch (m.type) {
      case 'patch': {
        // pushPatch() — the state emit covers it too, but a direct push (e.g. before the first emit) must not be lost
        if (m.patch !== this.lastPatch) { this.lastPatch = m.patch; const patch = m.patch; this.queue(() => this.host.cmd({ type: 'setBassPatch', patch })); }
        break;
      }
      case 'note': this.noteMessage(m); break;
      case 'notes': for (const n of m.list ?? []) this.noteMessage(n); break;
      case 'bend': {
        if (m.tag === 'arr') { this.arrPush({ kind: 'bend', atSample: this.sampleAt(m.at), semis: +m.semis || 0 }); break; }
        const atSample = this.sampleAt(m.at);
        const semis = +m.semis || 0;
        this.host.note('events', 1);
        this.queue(() => this.host.cmd(atSample > 0 ? { type: 'bassBend', semis, atSample, tag: m.tag ?? 'live' } : { type: 'bassBend', semis }));
        break;
      }
      case 'bends': for (const b of m.list ?? []) this.message({ type: 'bend', semis: b.semis, at: b.at, tag: b.tag }); break;
      case 'mod': { const value = Math.max(0, Math.min(1, +m.value || 0)); this.queue(() => this.host.cmd({ type: 'bassMod', value })); break; }
      case 'clear': {
        const release = m.release !== false;
        if (m.tag === 'arr') { this.arrBuffer = []; this.queue(() => this.host.cmd({ type: 'clearBassTimeline' })); }
        else this.queue(() => this.host.cmd({ type: 'bassClear', tag: m.tag ?? 'any', release }));
        break;
      }
      case 'panic': this.queue(() => this.host.cmd({ type: 'bassPanic' })); break;
      default: break;
    }
  }
  private noteMessage(n: AnyRecord): void {
    const note = Math.max(0, Math.min(127, n.note | 0));
    const tag = n.tag ?? 'live';
    if (tag === 'arr') {
      if (n.slide) this.arrPush({ kind: 'slide', atSample: this.sampleAt(n.at), note, dur: Math.max(0.005, +n.dur || 0) });
      else this.arrPush({ kind: n.on ? 'on' : 'off', atSample: this.sampleAt(n.at), note, vel: Math.max(0.05, Math.min(1, typeof n.vel === 'number' ? n.vel : 1)) });
      return;
    }
    const atSample = this.sampleAt(n.at);
    this.host.note('events', 1);
    if (n.slide) { const dur = Math.max(0.005, +n.dur || 0); this.queue(() => this.host.cmd({ type: 'bassSlide', note, dur, atSample, tag })); return; }
    const on = !!n.on;
    const velocity = Math.max(0.05, Math.min(1, typeof n.vel === 'number' ? n.vel : 1));
    this.queue(() => this.host.cmd({ type: 'bassNote', on, note, velocity, atSample, tag }));
  }
  /** The arranger's timeline: playTimeline posts `bends` then `notes` (tag arr) in one macrotask — gather, send once. */
  private arrPush(ev: AnyRecord): void {
    this.arrBuffer.push(ev);
    if (this.arrFlushQueued) return;
    this.arrFlushQueued = true;
    queueMicrotask(() => {
      this.arrFlushQueued = false;
      const events = this.arrBuffer; this.arrBuffer = [];
      if (!events.length || this.detached) return;
      this.host.note('events', events.length);
      this.queue(() => this.host.cmd({ type: 'setBassTimeline', events }));
    });
  }

  // ── transport + pattern ──
  private patternPayload(p: BassPattern): AnyRecord {
    const bars = Math.max(1, Math.min(8, Math.round(p.bars) || 2));
    const loopTicks = Math.max(PPQ, Math.round(bars * 4 * PPQ));
    const notes = p.notes.map((n) => ({ id: n.id, note: n.note, start: n.start, dur: n.dur, vel: n.vel, ...(n.slide ? { slide: true } : {}) }));
    const bend: number[] = [];
    if (p.bend && p.bend.length) for (let t = 0; t < loopTicks; t++) bend.push(bendAt(p.bend, t / PPQ));
    return { bars, notes, bend };
  }
  private pattern(p: BassPattern, bendLane: boolean): void {
    if (this.detached) return;
    const payload = this.patternPayload(p);
    const sig = JSON.stringify(payload);
    if (sig !== this.lastPatternSig) { this.lastPatternSig = sig; this.queue(() => this.host.cmd({ type: 'setBassPattern', ...payload })); }
    if (bendLane !== this.lastBendLane) { this.lastBendLane = bendLane; this.queue(() => this.host.cmd({ type: 'bassBendLane', on: bendLane })); }
  }
  private play(anchorCtx: number, offsetTicks: number): void {
    this.playAnchorCtx = anchorCtx;
    this.queue(async () => {
      // the pattern + lane flag are already queued ahead of us on this chain (BassEngine.start sends pattern() first)
      const atSample = this.host.anchorSample ? this.host.anchorSample(anchorCtx) : (this.host.clock.ready ? Math.round(this.host.clock.sampleAtCtxTime(anchorCtx, ctxPair(this.host.ctx))) : 0);
      await this.host.cmd({ type: 'bassPlay', atSample: atSample > 0 ? atSample : 0, offsetTicks: Math.max(0, Math.floor(offsetTicks)) });
    });
  }
  /** Seconds since the audible pass's tick 0, at the ear — the playhead (null until the engine reports playing). */
  elapsedSec(): number | null {
    const snap = this.host.latestSnapshot();
    if (!snap || !snap.bassPlaying || !this.host.clock.ready) return null;
    const ls = Number(snap.bassLoopStartSample);
    if (!Number.isFinite(ls)) return null;
    const e = (this.host.clock.sampleHeardAtPerfMs(performance.now()) - ls) / this.host.clock.sampleRate;
    return e >= 0 ? e : null;
  }
  /** Snapshot → the ctx-time tick origin + the sounding notes + the meter. */
  onSnapshot(snap: AnyRecord): void {
    if (this.detached || !snap) return;
    if (typeof snap.bassLevel === 'number') this.bass.nativeMeter(Number(snap.bassLevel), Number(snap.bassVoices) || 0);
    if (!this.host.clock.ready) return;
    const playing = !!snap.bassPlaying;
    const ls = Number(snap.bassLoopStartSample);
    const loopStartCtx = playing && Number.isFinite(ls) ? this.host.clock.ctxTimeAtSample(ls, ctxPair(this.host.ctx)) : NaN;
    this.bass.nativeBassUpdate({ playing, loopStartCtx, sounding: Array.isArray(snap.bassNotes) ? snap.bassNotes.map(Number) : undefined });
  }

  // ── probe self-test (tools/ci/probe-app.sh): a fresh pattern with 4 notes at the current BPM → bass.start() → native
  //    playing, notes fire, the synth sounds (meter > 0), the TS playhead tracks the native tick, stop ──
  async selfTest(): Promise<AnyRecord> {
    const r: AnyRecord = {};
    let addedIdx = -1;
    try {
      const before = this.bass.getState();
      r.patchSent = this.lastPatch === before.patch;
      this.bass.addPattern(false);
      addedIdx = this.bass.getState().currentIdx;
      this.bass.setBars(1);
      for (let b = 0; b < 4; b++) this.bass.addNote(36 + b * 2, b, 0.5, 0.9, { raw: true });
      const snap0 = this.host.latestSnapshot();
      const fired0 = Number(snap0?.bassNotesFired ?? 0);
      await this.bass.start();
      await new Promise((res) => setTimeout(res, 700));
      const sp1 = this.host.latestSnapshot();
      r.nativePlaying = !!sp1?.bassPlaying;
      r.loopTicks = sp1?.bassLoopTicks ?? 0;
      r.level = Number(sp1?.bassLevel ?? 0);
      // the live playhead (beats) vs the snapshot's tick, with the DERIVED tolerance (the snapshot is snapshotAgeMs old
      // and is the RENDERED position; the playhead is what is HEARD)
      const tickDur = 60 / Math.max(20, this.currentBpm()) / PPQ;
      const loop = Number(sp1?.bassLoopTicks) || 384;
      const close = (a: number, b: number, tol: number) => { const dd = Math.abs(a - b); return Math.min(dd, loop - dd) <= tol; };
      const skew = (s: { cur: number; nat: number }) => { const dd = Math.abs(s.cur - s.nat); return Math.min(dd, loop - dd); };
      // ONE SAMPLE ON A STARVED MACHINE MEASURES THE STALL, NOT THE APP. The tolerance is derived from the
      // snapshot's age, but that age is read AFTER both halves of the pair — so a stall BETWEEN reading the
      // page's playhead and reading the engine's tick is invisible to it and the tolerance comes out too small.
      // A loaded arm64 CI runner failed here by 2 ticks out of 242 (age 174 ms against a 68-tick tolerance)
      // while the Intel and Windows runners passed the identical build, with 55 xruns and 507 ms of transport
      // drift in the same report — i.e. the runner, not the bass. So the pair is sampled as tightly as possible
      // and RETRIED, keeping the closest attempt, exactly as the live-record check already does.
      const sampleCursor = () => {
        const cur = Math.floor(this.bass.getPlayheadBeats() * PPQ);
        const nat = Number(this.host.latestSnapshot()?.bassTick);
        return { cur, nat, age: this.host.snapshotAgeMs(), tol: this.host.cursorToleranceSteps(tickDur) };
      };
      const bestOf = async (attempts: number) => {
        let best = sampleCursor();
        for (let a = 1; a < attempts && !close(best.cur, best.nat, best.tol); a++) {
          await new Promise((res) => setTimeout(res, 120));
          const next = sampleCursor();
          if (skew(next) - next.tol < skew(best) - best.tol) best = next;
        }
        return best;
      };
      const s1 = await bestOf(3);
      await new Promise((res) => setTimeout(res, 300));
      const s2 = await bestOf(3);
      const sp2 = this.host.latestSnapshot();
      const cur1 = s1.cur, nat1 = s1.nat, age1 = s1.age, tol1 = s1.tol;
      const cur2 = s2.cur, nat2 = s2.nat, age2 = s2.age, tol2 = s2.tol;
      r.bassPageCursor = { cur1, nat1, cur2, nat2 };
      r.bassPageCursorAgeMs = { age1, age2, tol1, tol2 };
      r.cursorTracks = close(cur1, nat1, tol1) && close(cur2, nat2, tol2);
      r.notesFired = Number(sp2?.bassNotesFired ?? 0) - fired0;
      r.level = Math.max(r.level, Number(sp2?.bassLevel ?? 0));
      r.eventsDropped = Number(sp2?.bassEventsDropped ?? 0);
      this.bass.stop();
      for (let t = 0; t < 40 && this.host.latestSnapshot()?.bassPlaying; t++) await (this.host.tick ? this.host.tick() : new Promise((res) => setTimeout(res, 50)));
      r.stopped = !this.host.latestSnapshot()?.bassPlaying && !this.bass.getState().playing;
      r.bassPageOk = r.nativePlaying && r.loopTicks === 384 && r.notesFired >= 2 && r.level > 0.001 && r.cursorTracks && r.stopped && r.eventsDropped === 0;
    } catch (e) { r.error = String((e as any)?.stack ?? e); r.bassPageOk = false; }
    finally { if (addedIdx >= 0) { try { this.bass.deletePattern(addedIdx); } catch { /* */ } } }
    return r;
  }
  private currentBpm(): number {
    // the BassEngine's tempo source is private — the snapshot carries the shared transport BPM
    const snap = this.host.latestSnapshot();
    const b = Number(snap?.seqBpm);
    return b > 0 ? b : 120;
  }
}
