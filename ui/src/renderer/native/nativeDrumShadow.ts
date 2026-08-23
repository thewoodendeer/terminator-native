/**
 * nativeDrumShadow — Phase 3.3: THE DRUM MACHINE THROUGH THE C++ ENGINE.
 *
 * Sits beside the page's DrumEngine (which keeps owning its state, the grid UI, recording, the graphs and undo) and
 * mirrors it into the native DrumSequencer + Sampler over the JUCE bridge (docs/native/BRIDGE-PROTOCOL.md):
 *   • every lane gets a SLOT (0..63 → pad 64+slot); its decoded buffer (already ceilPeak'd + declicked by the
 *     DrumEngine at decode time) is uploaded ONCE through the host's SampleStore path (`terminatorSamples`) and bound
 *     with `setPadSample` + `setPadParams` (attack = the TS click-guard rule: 0 when the head is silent, else 3 ms;
 *     the 4 ms drum choke; its mute group as chokeGroup 1000+g); volume / mute+solo / group go as `setDrumLane`;
 *   • the active pattern (live edits, live-recorded hits) → `setDrumPattern`; the four graphs → `setDrumGraphs`;
 *     swing / master / PPQ → `setDrumParams` — each de-duplicated (reference / value) per state emit;
 *   • `DrumEngine.drumSink`: PLAY → `drumPlay {atSample, stepOffset}` at the page's anchor (an engine sample through
 *     NativeClock), STOP → `drumStop`, a hand-played / previewed hit → `triggerPad {pad, velocity, pan, atSample?}`,
 *     arranged swaps → `scheduleDrumPattern {atSample}` / `clearDrumPatterns`; the playhead reads `elapsedSec()`
 *     (the engine's position at the ear through NativeClock — independent of the AudioContext clock); the 20 Hz
 *     snapshot re-anchors the ctx-time grid origin the live-record landing uses (`nativeDrumUpdate`).
 * Not mirrored (honest list): the browser's audition of a sample that is not on a lane (`playPreviewBuffer`) still
 * plays through Web Audio; a graph / swing DRAG applies natively at pointer-up (the TS Live setters mutate without an
 * emit — the next emit pushes it); lane output routing to mixer strips is Phase 4 (lanes play dry to outs 1/2).
 */
import { drumHeadLevel, type DrumEngine, type DrumState, type TrackKey } from '../drums/DrumEngine';
import { ctxPair, type NativeClock } from './nativeClock';

type AnyRecord = Record<string, any>;

export const DRUM_PAD_BASE = 64;
export const DRUM_LANES = 64;
const DRUM_CHOKE_FADE = 0.004;     // DRUM_CHOKE_S
const DRUM_ATTACK = 0.003;         // DRUM_ATTACK_S (the click guard when the head is not silent)
const DRUM_HEAD_SILENCE = 0.02;    // head level below this → instant attack (full transient)
const GROUP_ID_BASE = 1000;        // drum mute groups live in their own choke-group id space (the chop pads use 0..)

/** What the pad shadow lends the drum shadow: its commands, its SampleStore uploads (refcounted) and its clock. */
export interface DrumShadowHost {
  cmd(c: AnyRecord): Promise<boolean>;
  /** 4.1: the mixer strip a lane's pad sums into (the lane key → its mixer channel); −1 / absent = the direct path. */
  stripForDrumTrack?(key: TrackKey): number;
  ensure(buf: AudioBuffer, keyHint: string): { key: string; ready: Promise<boolean>; failed: boolean };
  retain(buf: AudioBuffer): void;
  unretain(buf: AudioBuffer): void;
  clock: NativeClock;
  ctx: AudioContext;
  latestSnapshot(): AnyRecord | null;
  leadSec(): number;
  /** A transport anchor (ctx seconds) → the engine sample PLAY should use (3.6: a count-in's downbeat lands on the
   *  exact sample the engine counted to; else the clock mapping). Optional — the mapping when absent. */
  anchorSample?(ctxSec: number): number;
  /** How old the newest snapshot's position is right now (ms) + the derived tolerance for comparing a live cursor
   *  against a snapshot step field (see NativeEngineShadow.cursorToleranceSteps). */
  snapshotAgeMs(): number;
  cursorToleranceSteps(stepDurSec: number): number;
  note(stat: 'commands' | 'lanesBound' | 'hits', value: number): void;
  error(msg: string): void;
}

interface LaneDesc {
  buf: AudioBuffer | null;
  attack: number;
  volume: number;
  audible: boolean;
  group: number;
  strip: number; // the mixer strip (4.1), −1 = direct
}

export class NativeDrumShadow {
  private slots = new Map<TrackKey, number>();
  private slotKeys: Array<TrackKey | null> = new Array(DRUM_LANES).fill(null);
  private last: Array<LaneDesc | null> = new Array(DRUM_LANES).fill(null);
  private lastKey: Array<string | null> = new Array(DRUM_LANES).fill(null);
  private chain: Array<Promise<void>> = new Array(DRUM_LANES).fill(Promise.resolve());
  private seqChain: Promise<void> = Promise.resolve();
  private lastPattern: unknown = null;   // the state's pattern object last pushed (reference)
  private lastPatternBars = -1;
  private lastGraphs: unknown[] = [];    // the four graph records last pushed (references)
  private lastGraphsKeys = '';
  private lastParams = '';
  private loading = new Set<TrackKey>();
  private unsubState: (() => void) | null = null;
  private unsubBuf: (() => void) | null = null;
  private detached = false;
  playAnchorCtx = NaN;

  constructor(private drums: DrumEngine, private host: DrumShadowHost) {}

  attach(): void {
    this.drums.drumSink = {
      play: (anchor, stepOffset) => this.play(anchor, stepOffset),
      hitElapsedSec: (ts) => this.hitElapsedSec(ts),
      sampleAt: (el) => this.loopSampleAt(el),
      stop: () => this.queue(() => this.host.cmd({ type: 'drumStop' })),
      hit: (track, volume, when, pan, atSample) => this.hit(track, volume, when, pan, atSample),
      schedulePattern: (pattern, at) => this.queue(() => this.sendPattern(pattern, this.drums.getState().bars, 'scheduleDrumPattern', at)),
      clearScheduledPatterns: () => this.queue(() => this.host.cmd({ type: 'clearDrumPatterns' })),
      elapsedSec: () => this.elapsedSec(),
      leadSec: () => this.host.leadSec(),
    };
    this.unsubState = this.drums.subscribe((s) => this.sync(s));
    this.unsubBuf = this.drums.onBufferReady((t) => { if (!this.detached) this.syncLane(t, this.drums.getState()); });
  }

  detach(): void {
    this.detached = true;
    this.unsubState?.(); this.unsubState = null;
    this.unsubBuf?.(); this.unsubBuf = null;
    if (this.drums.drumSink) {
      this.drums.drumSink = null;
      if (this.drums.getState().playing) void this.host.cmd({ type: 'drumStop' });
    }
    for (let lane = 0; lane < DRUM_LANES; lane++) {
      if (this.last[lane]?.buf) { this.host.unretain(this.last[lane]!.buf!); void this.host.cmd({ type: 'setPadSample', pad: DRUM_PAD_BASE + lane }); }
      this.last[lane] = null; this.lastKey[lane] = null; this.slotKeys[lane] = null;
    }
    this.slots.clear();
  }

  private queue(fn: () => Promise<unknown>): void {
    this.host.note('commands', 1);
    this.seqChain = this.seqChain.then(fn).then(() => {}).catch(() => {});
  }

  // ── lanes ──
  private slotOf(track: TrackKey, assign = true): number {
    const s = this.slots.get(track);
    if (s !== undefined) return s;
    if (!assign) return -1;
    for (let i = 0; i < DRUM_LANES; i++) if (this.slotKeys[i] === null) { this.slotKeys[i] = track; this.slots.set(track, i); return i; }
    return -1; // 64 lanes in use
  }
  private describe(track: TrackKey, s: DrumState): LaneDesc | null {
    const t = s.tracks.find(x => x.key === track);
    if (!t) return null;
    const buf = this.drums.cachedBufferFor(track);
    if (!buf && !this.loading.has(track)) {
      // not decoded yet (a fresh kit, a restored project): ask for it — onBufferReady re-syncs the lane
      this.loading.add(track);
      this.drums.ensureLoaded(track).finally(() => this.loading.delete(track)).catch(() => {});
    }
    const anySolo = s.tracks.some(x => x.solo);
    return {
      buf,
      attack: buf ? (drumHeadLevel(buf) < DRUM_HEAD_SILENCE ? 0 : DRUM_ATTACK) : 0,
      volume: Math.max(0, Math.min(1, t.volume)),
      audible: anySolo ? !!t.solo : !t.muted,
      group: t.muteGroup && t.muteGroup > 0 ? Math.floor(t.muteGroup) : 0,
      strip: this.host.stripForDrumTrack?.(track) ?? -1,
    };
  }
  private syncLane(track: TrackKey, s: DrumState): void {
    if (this.detached) return;
    const lane = this.slotOf(track);
    if (lane < 0) return;
    const d = this.describe(track, s);
    const prev = this.last[lane];
    if (prev && d && prev.buf === d.buf && prev.attack === d.attack && prev.volume === d.volume && prev.audible === d.audible && prev.group === d.group && prev.strip === d.strip) return;
    this.last[lane] = d;
    if (d?.buf && (!prev || prev.buf !== d.buf)) this.host.retain(d.buf);
    if (prev?.buf && (!d || prev.buf !== d.buf)) this.host.unretain(prev.buf);
    this.chain[lane] = this.chain[lane].then(() => this.apply(lane, d, prev)).catch(() => {});
  }
  private async apply(lane: number, d: LaneDesc | null, prev: LaneDesc | null): Promise<void> {
    if (this.detached) return;
    const pad = DRUM_PAD_BASE + lane;
    if (!d) {
      if (prev) await this.host.cmd({ type: 'setPadSample', pad });
      this.lastKey[lane] = null;
      return;
    }
    if (d.buf) {
      const rec = this.host.ensure(d.buf, 'drum');
      const ok = await rec.ready;
      if (!ok || this.last[lane] !== d) return;
      if (!prev || prev.buf !== d.buf || this.lastKey[lane] !== rec.key) {
        await this.host.cmd({ type: 'setPadSample', pad, key: rec.key, startSec: 0, endSec: 0 });
        this.lastKey[lane] = rec.key;
        this.host.note('lanesBound', 1);
      }
    } else if (prev?.buf) {
      await this.host.cmd({ type: 'setPadSample', pad });
      this.lastKey[lane] = null;
    }
    if (!prev || prev.attack !== d.attack || prev.group !== d.group || prev.strip !== d.strip || (d.buf && prev.buf !== d.buf)) {
      await this.host.cmd({ type: 'setPadParams', pad, pitch: 0, fine: 0, attack: d.attack, release: 0, fadeOut: 0, gain: 1, outputPair: 0, mode: 'oneshot', gate: false, reverse: false, chokeGroup: d.group > 0 ? GROUP_ID_BASE + d.group : -1, interpolation: 'hermite', pan: 0, chokeFade: DRUM_CHOKE_FADE, strip: d.strip });
    }
    if (!prev || prev.volume !== d.volume || prev.audible !== d.audible || prev.group !== d.group) {
      await this.host.cmd({ type: 'setDrumLane', lane, volume: d.volume, audible: d.audible, group: d.group });
    }
  }

  // ── state → pattern / graphs / params ──
  private sync(s: DrumState): void {
    if (this.detached) return;
    // lanes: slots for every track, free the ones that went away
    for (const t of s.tracks) this.syncLane(t.key, s);
    for (let lane = 0; lane < DRUM_LANES; lane++) {
      const key = this.slotKeys[lane];
      if (key !== null && !s.tracks.some(t => t.key === key)) {
        this.syncLane(key, s); // describe() → null → unbind
        this.slots.delete(key); this.slotKeys[lane] = null;
      }
    }
    // the audible pattern (reference-diffed: writePattern / flushSequence / setBars make fresh objects)
    if (s.pattern !== this.lastPattern || s.bars !== this.lastPatternBars) {
      this.lastPattern = s.pattern; this.lastPatternBars = s.bars;
      const pat = s.pattern, bars = s.bars;
      this.queue(() => this.sendPattern(pat, bars, 'setDrumPattern'));
    }
    // the graphs (reference-diffed per record; a lane list change re-keys the rows)
    const keys = s.tracks.map(t => t.key).join('|');
    const gs = [s.stepVelocity, s.stepShift, s.stepPan, s.stepRepeat];
    if (keys !== this.lastGraphsKeys || gs.some((g, i) => g !== this.lastGraphs[i])) {
      this.lastGraphs = gs; this.lastGraphsKeys = keys;
      const lanes = s.tracks.map(t => ({ lane: this.slotOf(t.key), velocity: s.stepVelocity[t.key] ?? [], shift: s.stepShift[t.key] ?? [], pan: s.stepPan[t.key] ?? [], repeat: s.stepRepeat[t.key] ?? [] })).filter(l => l.lane >= 0);
      this.queue(() => this.host.cmd({ type: 'setDrumGraphs', lanes }));
    }
    const params = JSON.stringify({ swing: s.drumSwing, masterVolume: s.masterVolume, ppq: s.ppq });
    if (params !== this.lastParams) {
      this.lastParams = params;
      this.queue(() => this.host.cmd({ type: 'setDrumParams', swing: Math.max(0, Math.min(1, s.drumSwing)), masterVolume: Math.max(0, Math.min(1, s.masterVolume)), ppq: s.ppq }));
    }
  }
  private patternPayload(pattern: Record<TrackKey, boolean[]>, bars: number): AnyRecord {
    const spb = this.drums.stepsPerBar;
    const stepCount = Math.max(1, Math.min(4, bars)) * spb;
    const lanes: Array<{ lane: number; steps: number[] }> = [];
    for (const key of Object.keys(pattern)) {
      const lane = this.slotOf(key, false);
      if (lane < 0) continue;
      const row = pattern[key];
      const steps: number[] = [];
      for (let st = 0; st < Math.min(stepCount, row.length); st++) if (row[st]) steps.push(st);
      if (steps.length) lanes.push({ lane, steps });
    }
    return { bars: Math.max(1, Math.min(4, bars)), stepsPerBar: spb, lanes };
  }
  private async sendPattern(pattern: Record<TrackKey, boolean[]>, bars: number, type: 'setDrumPattern' | 'scheduleDrumPattern', atCtx?: number): Promise<boolean> {
    const payload = this.patternPayload(pattern, bars);
    if (type === 'scheduleDrumPattern') {
      const atSample = atCtx !== undefined && this.host.clock.ready ? Math.round(this.host.clock.sampleAtCtxTime(atCtx, ctxPair(this.host.ctx))) : 0;
      return this.host.cmd({ type, ...payload, atSample: atSample > 0 ? atSample : 0 });
    }
    return this.host.cmd({ type, ...payload });
  }

  // ── transport ──
  private play(anchorCtx: number, stepOffset: number): void {
    this.playAnchorCtx = anchorCtx;
    this.queue(async () => {
      // the pattern / graphs / params are already queued ahead of us on this chain (sync runs on every emit)
      const atSample = this.host.anchorSample ? this.host.anchorSample(anchorCtx) : (this.host.clock.ready ? Math.round(this.host.clock.sampleAtCtxTime(anchorCtx, ctxPair(this.host.ctx))) : 0);
      await this.host.cmd({ type: 'drumPlay', atSample: atSample > 0 ? atSample : 0, stepOffset: Math.max(0, Math.floor(stepOffset)) });
    });
  }
  private hit(track: TrackKey, volume: number, when: number | undefined, pan: number, atSampleExact?: number): void {
    if (this.detached) return;
    const lane = this.slotOf(track);
    if (lane < 0) return;
    try { this.syncLane(track, this.drums.getState()); } catch { /* */ }
    const pad = DRUM_PAD_BASE + lane;
    const vel = Math.max(0, Math.min(1, volume));
    const p = Math.max(-1, Math.min(1, pan || 0));
    // 3.7: a live-recorded hit arrives as the exact engine sample it landed on (no ctx round trip); else the ctx mapping
    const atSample = atSampleExact && atSampleExact > 0 ? Math.round(atSampleExact) : (when !== undefined && this.host.clock.ready ? Math.round(this.host.clock.sampleAtCtxTime(when, ctxPair(this.host.ctx))) : 0);
    const fire = async () => {
      this.host.note('hits', 1);
      const c: AnyRecord = { type: 'triggerPad', pad, velocity: vel };
      if (p !== 0) c.pan = p;
      if (atSample > 0) c.atSample = atSample;
      await this.host.cmd(c);
    };
    const delayMs = when !== undefined && atSample <= 0 ? (when - this.host.ctx.currentTime) * 1000 : 0;
    const go = () => { this.chain[lane] = this.chain[lane].then(fire).catch(() => {}); };
    if (delayMs > 2) setTimeout(go, delayMs); else go();
  }
  /** 3.7: a live hit's musical time — seconds from the audible loop start to the hit's HEARD instant on the engine
   *  clock (`ts` = the input's performance stamp, clamped to the TS 50 ms handler-lag window; undefined = now). */
  hitElapsedSec(ts?: number): number | null {
    const snap = this.host.latestSnapshot();
    if (!snap || !snap.drumPlaying || !this.host.clock.ready) return null;
    const ls = Number(snap.drumLoopStartSample);
    if (!Number.isFinite(ls)) return null;
    const now = performance.now();
    const perf = ts !== undefined && Number.isFinite(ts) && ts > 0 ? Math.max(now - 50, Math.min(now, ts)) : now;
    return (this.host.clock.sampleHeardAtPerfMs(perf) - ls) / this.host.clock.sampleRate;
  }
  /** 3.7: the absolute engine sample `el` seconds after the audible loop start (0 = unknown). */
  loopSampleAt(el: number): number {
    const snap = this.host.latestSnapshot();
    if (!snap || !snap.drumPlaying || !this.host.clock.ready || !Number.isFinite(el)) return 0;
    const ls = Number(snap.drumLoopStartSample);
    if (!Number.isFinite(ls)) return 0;
    return Math.round(ls + el * this.host.clock.sampleRate);
  }
  /** Seconds since the audible pass's step 0, at the ear — the playhead (null until the engine reports playing). */
  elapsedSec(): number | null {
    const snap = this.host.latestSnapshot();
    if (!snap || !snap.drumPlaying || !this.host.clock.ready) return null;
    const ls = Number(snap.drumLoopStartSample);
    if (!Number.isFinite(ls)) return null;
    const e = (this.host.clock.sampleHeardAtPerfMs(performance.now()) - ls) / this.host.clock.sampleRate;
    return e >= 0 ? e : null;
  }
  /** Snapshot → the ctx-time grid origin (the live-record landing's reference). */
  onSnapshot(snap: AnyRecord): void {
    if (this.detached || !snap || !this.host.clock.ready) return;
    if (!snap.drumPlaying) return;
    const ls = Number(snap.drumLoopStartSample);
    if (!Number.isFinite(ls)) return;
    const loopStartCtx = this.host.clock.ctxTimeAtSample(ls, ctxPair(this.host.ctx));
    this.drums.nativeDrumUpdate({ playing: true, loopStartCtx });
  }

  // ── probe self-test (tools/ci/probe-app.sh): a synthetic buffer primed into the first lane → the REAL path
  //    (onBufferReady → syncLane → upload → bind), a 1-bar pattern at the current BPM → drums.start() → native playing,
  //    hits, the TS playhead tracks the native step, stop ──
  async selfTest(): Promise<AnyRecord> {
    const r: AnyRecord = {};
    try {
      const s = this.drums.getState();
      const track = s.tracks[0]?.key;
      r.track = track ?? null;
      if (!track) { r.drumPageOk = false; return r; }
      const lane = this.slotOf(track);
      r.lane = lane;
      const sr = 48000, frames = 4800; // 0.1 s 200 Hz sine
      const buf = new AudioBuffer({ length: frames, sampleRate: sr, numberOfChannels: 1 });
      const d = buf.getChannelData(0);
      for (let i = 0; i < frames; i++) d[i] = Math.sin(2 * Math.PI * 200 * i / sr) * 0.5;
      this.drums.primeBuffer(track, buf);
      for (let t = 0; t < 60 && this.lastKey[lane] === null; t++) await new Promise((res) => setTimeout(res, 50));
      r.laneBound = this.lastKey[lane] !== null;
      r.laneKey = this.lastKey[lane];
      // the pattern: 4 hits per bar on the first lane (every 24th internal step), 1 bar
      const spb = this.drums.stepsPerBar;
      const row = Array.from({ length: spb }, (_, i) => i % 24 === 0);
      this.drums.setPattern({ [track]: row }, 1, false);
      r.bpm = this.drums.currentBpm();
      const snap0 = this.host.latestSnapshot();
      const hits0 = Number(snap0?.drumHitsFired ?? 0);
      void this.drums.start();
      await new Promise((res) => setTimeout(res, 600));
      const sp1 = this.host.latestSnapshot();
      r.nativePlaying = !!sp1?.drumPlaying;
      r.stepCount = sp1?.drumStepCount ?? 0;
      // the live playhead vs the snapshot's step, with the DERIVED tolerance (the snapshot's position is
      // snapshotAgeMs old and is the RENDERED one; the playhead is what is HEARD) — a 1/96 step at 240 BPM is 10.4 ms,
      // so a starved runner's late snapshot is several steps
      const stepDur = 60 / Math.max(1, this.drums.currentBpm()) * 4 / spb;
      const cur1 = this.drums.getStep(), nat1 = Number(sp1?.drumStep), age1 = this.host.snapshotAgeMs(), tol1 = this.host.cursorToleranceSteps(stepDur);
      await new Promise((res) => setTimeout(res, 300));
      const sp2 = this.host.latestSnapshot();
      const cur2 = this.drums.getStep(), nat2 = Number(sp2?.drumStep), age2 = this.host.snapshotAgeMs(), tol2 = this.host.cursorToleranceSteps(stepDur);
      const close = (a: number, b: number, tol: number) => { const dd = Math.abs(a - b); return Math.min(dd, spb - dd) <= tol; };
      r.drumPageCursor = { cur1, nat1, cur2, nat2 };
      r.drumPageCursorAgeMs = { age1, age2, tol1, tol2 };
      r.cursorTracks = close(cur1, nat1, tol1) && close(cur2, nat2, tol2);
      r.hits = Number(sp2?.drumHitsFired ?? 0) - hits0;
      this.drums.stop();
      for (let t = 0; t < 40 && this.host.latestSnapshot()?.drumPlaying; t++) await new Promise((res) => setTimeout(res, 50));
      r.stopped = !this.host.latestSnapshot()?.drumPlaying && !this.drums.getState().playing;
      r.drumPageOk = r.laneBound && r.nativePlaying && r.stepCount === spb && r.hits >= 2 && r.cursorTracks && r.stopped;
      this.drums.setPattern({ [track]: Array.from({ length: spb }, () => false) }, 1, false);
    } catch (e) { r.error = String((e as any)?.stack ?? e); r.drumPageOk = false; }
    return r;
  }
}
