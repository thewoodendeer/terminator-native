/**
 * nativeEngineShadow — audio through the C++ engine (Phase 2.5, EngineClient step 1: the SHADOW).
 *
 * The React app's ChopperEngine keeps owning its state (chops, pads, sources, params, undo, the sequencer, the
 * playhead, the LEDs). This module sits beside it and MIRRORS what the pads play into the native engine over the
 * JUCE bridge (docs/native/BRIDGE-PROTOCOL.md):
 *   • every AudioBuffer a pad resolves to (`resolvePadSource` — the main track, a pad's own sample, or a stem-mix
 *     slice) is uploaded ONCE into the SampleStore under a page-chosen key (`terminatorSamples` begin/chunk/end,
 *     chunked base64 float32) and refcounted; released when no pad uses it any more;
 *   • each pad's region + params (pitch + source pitch/fine, attack, release, NORM gain, one-shot/loop, NOTE ON
 *     gate, REV, mute group, loop fades) are diffed against what was last sent and pushed as `setPadSample` /
 *     `setPadParams` / `setPadLoop` — in order, per pad;
 *   • every live hit / stop / note-off the TS engine performs (`voiceSink`) becomes `triggerPad` / `stopPad` /
 *     `releasePad`, and the TS engine's live-hit voices are routed into a silent bus (`mutePadVoices`) — so the
 *     native engine is what you hear while the UI keeps working unchanged.
 *   • Phase 3.2 — the CHOP SEQUENCER runs natively: `ChopperEngine.seqSink` (PLAY/STOP/PAUSE/RESUME → seqPlay/
 *     seqStop/seqPause/seqResume), the playing pattern / a queued switch / BPM / swing diffed from the state →
 *     setSequence / queueSequence / setBpm, and the native position pushed back at 20 Hz (nativeSeqUpdate) through
 *     NativeClock (engine samples ↔ host ns ↔ performance.now ↔ AudioContext, at the ear) so the TS cursor,
 *     live-record landing and metronome read the native anchor; quantized live hits go out as `triggerPad{atSample}`
 *     (sample-exact); the measured native-vs-ctx drift nudges the drums/bass/MIDI-clock grids (phase-preserving).
 *   • Phase 3.3 — the DRUM MACHINE runs natively too (`nativeDrumShadow.ts`, lanes = pads 64..127 on the same clock):
 *     the DrumEngine's sink; the page cursors (chop + drums) read the ENGINE's position at the ear through NativeClock
 *     (`nativeCursorHook`) — not the AudioContext clock.
 * Not mirrored yet (honest list, also in STATUS.md): bass + metronome + count-in (still Web Audio on the page's
 * AudioContext — Phase 3.4/3.6; kept phase-locked by the nudge, the ear-alignment is as good as the clock
 * mapping ≈ 1 ms + the two devices' latency reports), mixer strips / master FX (Phase 4), time-STRETCH (plays
 * dry natively), live re-stem of a ringing voice (the next hit plays the new mix), per-hit reverse of a rendered
 * LOOP. Native MIDI hits the C++ engine directly (MidiHub, note−36) and is mirrored to the page (2.5e).
 */
import { SEQ_MAX_STEPS, type ChopperEngine, type ChopperState, type SeqPattern } from '../chopper/ChopperEngine';
import type { DrumEngine } from '../drums/DrumEngine';
import { isNative, native, onNativeEvent } from './juceBridge';
import { NativeClock, ctxPair, ctxHeardLatencySec } from './nativeClock';
import { NativeDrumShadow } from './nativeDrumShadow';

type AnyRecord = Record<string, any>;

const CHUNK_BYTES = 3 * 1024 * 1024; // float32 bytes per upload chunk (≈ 4 MB of base64 through the bridge)
const RELEASE_GRACE_MS = 2000;       // an unreferenced buffer is released after this (a reshuffle re-references it)
const MAX_PADS = 64;

interface PadDesc {
  buf: AudioBuffer;
  start: number;   // buffer seconds
  end: number;
  pitch: number;   // semitones: pad PITCH + source PITCH (the C++ pad clamps ±48)
  fine: number;    // cents: source FINE
  attack: number;  // seconds (source ATTACK, or the one-shot fade-in stretched by rate — as startVoice does)
  release: number; // master RELEASE
  gain: number;    // NORM (× CHOP level) — the velocity multiplies it per hit
  mode: 'oneshot' | 'loop';
  gate: boolean;
  reverse: boolean;
  choke: number;   // −1 own pad · −2 poly ('none') · ≥0 group id
  fadeIn: number;  // LOOP crossfade (seconds) — render inputs
  fadeOut: number;
}

interface BufRec {
  key: string;
  ready: Promise<boolean>;
  refs: number;
  frames: number;
  sampleRate: number;
  channels: number;
  bytes: number;
  releaseTimer: ReturnType<typeof setTimeout> | null;
  failed: boolean;
}

const bytesToBase64 = (bytes: Uint8Array): Promise<string> =>
  new Promise((resolve, reject) => {
    // FileReader does the base64 off the main thread; the data: prefix is stripped
    const r = new FileReader();
    r.onerror = () => reject(r.error ?? new Error('base64 failed'));
    r.onload = () => { const s = String(r.result); resolve(s.slice(s.indexOf(',') + 1)); };
    r.readAsDataURL(new Blob([bytes as unknown as BlobPart]));
  });

function sameDesc(a: PadDesc | null, b: PadDesc | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.buf === b.buf && a.start === b.start && a.end === b.end && a.pitch === b.pitch && a.fine === b.fine
    && a.attack === b.attack && a.release === b.release && a.gain === b.gain && a.mode === b.mode && a.gate === b.gate
    && a.reverse === b.reverse && a.choke === b.choke && a.fadeIn === b.fadeIn && a.fadeOut === b.fadeOut;
}
const sameParams = (a: PadDesc, b: PadDesc) =>
  a.pitch === b.pitch && a.fine === b.fine && a.attack === b.attack && a.release === b.release && a.gain === b.gain
  && a.mode === b.mode && a.gate === b.gate && a.reverse === b.reverse && a.choke === b.choke && a.fadeOut === b.fadeOut;
const sameRegion = (a: PadDesc, b: PadDesc) => a.buf === b.buf && a.start === b.start && a.end === b.end;
const loopOf = (d: PadDesc | null) => (d && d.mode === 'loop' && (d.fadeIn > 0 || d.fadeOut > 0))
  ? { start: d.start, end: d.end, fadeIn: d.fadeIn, fadeOut: d.fadeOut, reverse: d.reverse, buf: d.buf } : null;
const sameLoop = (a: ReturnType<typeof loopOf>, b: ReturnType<typeof loopOf>) =>
  a === b || (!!a && !!b && a.buf === b.buf && a.start === b.start && a.end === b.end && a.fadeIn === b.fadeIn && a.fadeOut === b.fadeOut && a.reverse === b.reverse);

export interface NativeShadowStats {
  attached: boolean;
  buffersLive: number;
  bytesUploaded: number;
  uploads: number;
  uploadFailures: number;
  commands: number;
  commandErrors: number;
  padsBound: number;
  triggers: number;
  midiNotes: number;
  /** Phase 3.2 — the native transport binding */
  seqCommands: number;
  seqNudges: number;
  clockReady: boolean;
  clockRttMs: number;
  /** How old the newest snapshot's POSITION is right now (ms): the 20 Hz emit interval + the message thread's
   *  scheduling + the WebView delivery. Everything read out of a snapshot (`seqStep`, `drumStep`, `activePads`) is
   *  this far in the past — the live cursors do NOT use it (they read the engine clock), but any test that compares
   *  a live cursor to a snapshot field has to allow for it. Starved runners have measured > 100 ms. */
  snapshotAgeMs: number;
  driftMs: number; // the last measured native-vs-ctx drift (ms, + = native later) — what the nudge corrects
  /** Phase 3.3 — the native drum machine */
  drumCommands: number;
  drumLanesBound: number;
  drumHits: number;
  lastError: string | null;
}

class NativeEngineShadow {
  private recs = new WeakMap<AudioBuffer, BufRec>();
  private liveRecs = new Set<BufRec>();
  private nextKey = 1;
  private last: Array<PadDesc | null> = new Array(MAX_PADS).fill(null);
  private lastKey: Array<string | null> = new Array(MAX_PADS).fill(null); // the store key the pad was bound to
  private chain: Array<Promise<void>> = new Array(MAX_PADS).fill(Promise.resolve());
  private chokeIds = new Map<string, number>();
  private unsubscribe: (() => void) | null = null;
  private unsubSnapshot: (() => void) | null = null;
  private unsubMidi: (() => void) | null = null;
  private masterGainSent = -1;
  private detached = false;
  latestSnapshot: AnyRecord | null = null;
  // ── Phase 3.2: the native transport ──
  readonly clock = new NativeClock();
  private clockTimer: ReturnType<typeof setInterval> | null = null;
  private seqChain: Promise<void> = Promise.resolve();            // transport commands + pattern pushes, in order
  private sentPatterns = new Map<number, { bars: number; resolution: number; json: string }>(); // what the engine holds per index
  private lastQueued: { idx: number; json: string } | null = null;
  private lastBpmSent = -1;
  private driftFilt = NaN;       // low-passed drift (performance.now is 1 ms-coarse in WebKit — single reads jitter)
  private playAnchorCtx = NaN;   // the ctx time we asked the native seq to start at
  private playAckAt = Infinity;  // performance.now() when the seqPlay command was accepted
  private playStartSample = NaN; // the engine sample the run started at (its first loop start)
  private nudgeApplied = 0;      // seconds of satellite nudge applied this run
  private snapEmitPerfMs = NaN;  // performance.now() the newest snapshot's position was stamped at (its emit)
  stats: NativeShadowStats = { attached: false, buffersLive: 0, bytesUploaded: 0, uploads: 0, uploadFailures: 0, commands: 0, commandErrors: 0, padsBound: 0, triggers: 0, midiNotes: 0, seqCommands: 0, seqNudges: 0, clockReady: false, clockRttMs: Infinity, snapshotAgeMs: 0, driftMs: 0, drumCommands: 0, drumLanesBound: 0, drumHits: 0, lastError: null };
  private drumShadow: NativeDrumShadow | null = null;

  constructor(private engine: ChopperEngine, private drums: DrumEngine | null = null) {}

  attach(): void {
    this.engine.mutePadVoices = true;
    this.engine.voiceSink = {
      start: (pad, velocity, when, reverseOverride, nativeOwned) => this.onStart(pad, velocity, when, reverseOverride, nativeOwned),
      stop: (pad) => this.onStop(pad),
      release: (pad) => this.onRelease(pad),
    };
    // the native transport (Phase 3.2): the TS engine's PLAY/STOP/PAUSE/RESUME drive the C++ ChopSequencer
    this.engine.seqSink = {
      play: (anchor) => this.seqPlay(anchor),
      stop: () => this.queueSeq(() => this.cmd({ type: 'seqStop' })),
      pause: () => this.queueSeq(() => this.cmd({ type: 'seqPause' })),
      resume: () => this.queueSeq(() => this.cmd({ type: 'seqResume' })),
      leadSec: () => this.playLeadSec(),
    };
    // the cursor at the EAR from the engine's own clock (3.3): the TS Timeline/grid playheads stop depending on the
    // AudioContext's clock quality (a headless / virtual device runs it fast or slow; the native position is the truth)
    this.engine.nativeCursorHook = () => this.seqElapsedSec();
    // the drum machine (3.3)
    if (this.drums) {
      this.drumShadow = new NativeDrumShadow(this.drums, {
        cmd: (c) => this.cmd(c),
        ensure: (buf, hint) => this.ensure(buf, hint),
        retain: (buf) => this.retain(this.ensure(buf, 'drum')),
        unretain: (buf) => { const r = this.recs.get(buf); if (r) this.unretain(r); },
        clock: this.clock,
        ctx: this.engine.ctx,
        latestSnapshot: () => this.latestSnapshot,
        leadSec: () => this.playLeadSec(),
        snapshotAgeMs: () => this.snapshotAgeMs(),
        cursorToleranceSteps: (stepDurSec) => this.cursorToleranceSteps(stepDurSec),
        note: (stat, v) => { if (stat === 'commands') this.stats.drumCommands += v; else if (stat === 'lanesBound') this.stats.drumLanesBound += v; else this.stats.drumHits += v; },
        error: (msg) => { this.stats.lastError = msg; },
      });
      this.drumShadow.attach();
    }
    void this.calibrateClock(8);
    this.clockTimer = setInterval(() => { void this.calibrateClock(1); }, 4000);
    this.unsubscribe = this.engine.subscribe((s) => this.sync(s));
    this.unsubSnapshot = onNativeEvent('terminator.snapshot', (snap) => { this.latestSnapshot = snap; this.onSnapshot(snap); });
    // MIDI from the devices: the engine already played the note on the direct MidiHub → engine path; the page
    // runs the same hit through the TS engine (LEDs, playhead, chokes, step/live record) marked nativeOwned so
    // the shadow does not trigger it twice. Note → pad = the engine's default map (note − 36).
    this.unsubMidi = onNativeEvent('terminator.midiNote', (m) => {
      if (!m || typeof m.note !== 'number') return;
      const pad = m.note - 36;
      if (pad < 0 || pad >= MAX_PADS) return;
      this.stats.midiNotes++;
      try {
        if (m.on && Number(m.velocity) > 0) this.engine.triggerPad(pad, Math.max(0, Math.min(1, Number(m.velocity) / 127)), undefined, { nativeOwned: true });
        else this.engine.releasePad(pad);
      } catch (e) { this.stats.lastError = `midiNote: ${String((e as any)?.message ?? e)}`; }
    });
    this.stats.attached = true;
  }

  detach(): void {
    this.detached = true;
    this.stats.attached = false;
    this.engine.nativeCursorHook = null;
    this.drumShadow?.detach(); this.drumShadow = null;
    this.unsubscribe?.(); this.unsubscribe = null;
    this.unsubSnapshot?.(); this.unsubSnapshot = null;
    this.unsubMidi?.(); this.unsubMidi = null;
    this.engine.voiceSink = null;
    this.engine.mutePadVoices = false;
    if (this.clockTimer) { clearInterval(this.clockTimer); this.clockTimer = null; }
    if (this.engine.seqSink) { this.engine.seqSink = null; if (this.engine.isSeqPlaying()) void this.cmd({ type: 'seqStop' }); }
    for (let i = 0; i < MAX_PADS; i++) {
      if (this.last[i]) { void this.cmd({ type: 'setPadSample', pad: i }); void this.cmd({ type: 'setPadLoop', pad: i, clear: true }); }
      this.last[i] = null; this.lastKey[i] = null;
    }
    for (const rec of [...this.liveRecs]) { if (rec.releaseTimer) clearTimeout(rec.releaseTimer); void this.releaseRec(rec); }
  }

  // ── commands ──
  private async cmd(c: AnyRecord): Promise<boolean> {
    this.stats.commands++;
    try {
      const r = await native.command(c);
      if (!r?.ok) { this.stats.commandErrors++; this.stats.lastError = `${c.type}: ${r?.error ?? 'failed'}`; return false; }
      return true;
    } catch (e) {
      this.stats.commandErrors++; this.stats.lastError = `${c.type}: ${String((e as any)?.message ?? e)}`; return false;
    }
  }

  // ── uploads ──
  /** The SampleStore key for a page AudioBuffer, uploading it on first sight (begin / chunk… / end). */
  ensure(buf: AudioBuffer, keyHint = 'buf'): BufRec {
    let rec = this.recs.get(buf);
    if (rec && !rec.failed) { if (rec.releaseTimer) { clearTimeout(rec.releaseTimer); rec.releaseTimer = null; } return rec; }
    const key = `${keyHint}:${this.nextKey++}`;
    const r: BufRec = { key, ready: Promise.resolve(false), refs: 0, frames: buf.length, sampleRate: buf.sampleRate, channels: buf.numberOfChannels, bytes: buf.length * buf.numberOfChannels * 4, releaseTimer: null, failed: false };
    r.ready = this.upload(buf, r);
    this.recs.set(buf, r);
    this.liveRecs.add(r);
    this.stats.buffersLive = this.liveRecs.size;
    return r;
  }

  private async upload(buf: AudioBuffer, rec: BufRec): Promise<boolean> {
    const ch = buf.numberOfChannels, frames = buf.length;
    try {
      const b = await native.samples({ verb: 'begin', key: rec.key, sampleRate: buf.sampleRate, channels: ch, frames });
      if (!b?.ok) throw new Error(b?.error ?? 'begin failed');
      const framesPerChunk = Math.max(1, Math.floor(CHUNK_BYTES / (4 * ch)));
      const chans: Float32Array[] = [];
      for (let c = 0; c < ch; c++) chans.push(buf.getChannelData(c));
      for (let off = 0; off < frames; off += framesPerChunk) {
        if (this.detached) throw new Error('detached');
        const n = Math.min(framesPerChunk, frames - off);
        let bytes: Uint8Array;
        if (ch === 1) {
          bytes = new Uint8Array(chans[0].buffer, chans[0].byteOffset + off * 4, n * 4);
        } else {
          const inter = new Float32Array(n * ch);
          for (let c = 0; c < ch; c++) { const d = chans[c]; for (let i = 0; i < n; i++) inter[i * ch + c] = d[off + i]; }
          bytes = new Uint8Array(inter.buffer);
        }
        const data = await bytesToBase64(bytes);
        const r = await native.samples({ verb: 'chunk', key: rec.key, offset: off, data });
        if (!r?.ok) throw new Error(r?.error ?? 'chunk failed');
      }
      const e = await native.samples({ verb: 'end', key: rec.key });
      if (!e?.ok) throw new Error(e?.error ?? 'end failed');
      this.stats.uploads++;
      this.stats.bytesUploaded += rec.bytes;
      return true;
    } catch (err) {
      rec.failed = true;
      this.stats.uploadFailures++;
      this.stats.lastError = `upload ${rec.key}: ${String((err as any)?.message ?? err)}`;
      void native.samples({ verb: 'release', key: rec.key }).catch(() => {});
      this.liveRecs.delete(rec);
      this.stats.buffersLive = this.liveRecs.size;
      return false;
    }
  }

  private retain(rec: BufRec) { rec.refs++; if (rec.releaseTimer) { clearTimeout(rec.releaseTimer); rec.releaseTimer = null; } }
  private unretain(rec: BufRec) {
    rec.refs = Math.max(0, rec.refs - 1);
    if (rec.refs === 0 && !rec.releaseTimer) {
      rec.releaseTimer = setTimeout(() => { rec.releaseTimer = null; if (rec.refs === 0) void this.releaseRec(rec); }, RELEASE_GRACE_MS);
    }
  }
  private async releaseRec(rec: BufRec) {
    if (!this.liveRecs.has(rec)) return;
    this.liveRecs.delete(rec);
    this.stats.buffersLive = this.liveRecs.size;
    rec.failed = true; // a later use re-uploads under a fresh key
    await rec.ready;
    try { await native.samples({ verb: 'release', key: rec.key }); } catch { /* shell gone */ }
  }

  // ── state → pads ──
  private chokeId(group: string): number {
    if (group === 'none') return -2;
    let id = this.chokeIds.get(group);
    if (id === undefined) { id = this.chokeIds.size; this.chokeIds.set(group, id); }
    return id;
  }

  private describe(i: number, s: ChopperState): PadDesc | null {
    const pad = s.pads[i];
    if (!pad) return null;
    const src = this.engine.resolvePadSource(i);
    if (!src) return null;
    const fx = this.engine.sourceSettings(this.engine.padSourceKey(i) ?? 'main');
    const pitchTotal = pad.pitch + fx.pitch + fx.fine / 100;
    const rate = Math.pow(2, pitchTotal / 12);
    const dur = Math.max(0, src.end - src.start);
    const looping = pad.mode === 'loop';
    const fadeIn = Math.max(0, Math.min(dur, pad.fadeIn ?? 0));
    const fadeOut = Math.max(0, Math.min(dur, pad.fadeOut ?? 0));
    const attack = Math.max(fx.attack, looping ? 0 : fadeIn / rate);
    // busFor: main chops ride chopGain (CHOP level × main NORM); pad sources ride their route bus (CHOP level) and
    // carry their own NORM per voice (normGainFor)
    const chop = this.engine.getChopVolume();
    const gain = src.isPad
      ? chop * (s.sourceNorm[`src:${s.padBufferMeta[i]?.videoId ?? ''}`] ?? 1)
      : chop * (s.normalizeGain || 1);
    return {
      buf: src.buffer, start: src.start, end: src.end,
      pitch: pad.pitch + fx.pitch, fine: fx.fine, attack, release: s.master.release, gain,
      mode: looping ? 'loop' : 'oneshot', gate: !!pad.gate, reverse: this.engine.reversedFor(i),
      choke: this.chokeId(this.engine.chokeGroupOf(i)), fadeIn, fadeOut,
    };
  }

  private sync(s: ChopperState): void {
    if (this.detached) return;
    const vol = Math.max(0, Math.min(1, s.master.volume));
    if (vol !== this.masterGainSent) { this.masterGainSent = vol; void this.cmd({ type: 'setMasterGain', gain: vol }); }
    for (let i = 0; i < MAX_PADS; i++) this.syncPad(i, s); // describe() is a cheap null for pads past the grid
    this.syncTransport(s);
  }

  // ── Phase 3.2: the native transport ──
  private queueSeq(fn: () => Promise<unknown>): void {
    this.stats.seqCommands++;
    this.seqChain = this.seqChain.then(fn).then(() => {}).catch(() => {});
  }
  /** The engine's `SeqPattern` → the bridge's setSequence/queueSequence payload (stored steps, aligned velocities). */
  private patternPayload(idx: number, p: SeqPattern, swing: number): AnyRecord {
    const stepCount = Math.min(SEQ_MAX_STEPS, p.bars * p.resolution);
    const grid: number[][] = [], velGrid: number[][] = [];
    for (let st = 0; st < stepCount; st++) {
      const row = p.grid[st];
      if (!row || row.length === 0) { grid.push([]); velGrid.push([]); continue; }
      const vr = p.velGrid?.[st];
      grid.push([...row]);
      velGrid.push(row.map((_, k) => Math.max(0.05, Math.min(1, Number(vr?.[k] ?? 1) || 1))));
    }
    return { index: idx, bars: p.bars, resolution: p.resolution, loop: p.loop, swing: Math.max(0, Math.min(1, swing)), grid, velGrid };
  }
  /** Push pattern `idx` (live replace or queued switch); the same bytes already held natively are not re-sent. */
  private async sendPattern(idx: number, p: SeqPattern | null, swing: number, type: 'setSequence' | 'queueSequence'): Promise<boolean> {
    if (!p) return false;
    const payload = this.patternPayload(idx, p, swing);
    const json = JSON.stringify(payload);
    if (type === 'setSequence') {
      const held = this.sentPatterns.get(idx);
      const nativeIdx = Number(this.latestSnapshot?.seqPatternIndex ?? -1);
      if (held && held.json === json && nativeIdx === idx) return true; // unchanged and already the audible one
    } else if (this.lastQueued && this.lastQueued.idx === idx && this.lastQueued.json === json) return true;
    const ok = await this.cmd({ type, ...payload });
    if (ok) {
      this.sentPatterns.set(idx, { bars: payload.bars, resolution: payload.resolution, json });
      if (type === 'queueSequence') this.lastQueued = { idx, json };
    }
    return ok;
  }
  /** The lead PLAY needs so the native engine RENDERS the anchor's sample in time: its device's output latency (the
   *  anchor is a heard time) + 1.5 blocks (command → block boundary) + the bridge, minus what the context's own
   *  heard-pair already puts between a scheduling time and its output; never under the TS 20 ms. */
  private playLeadSec(): number {
    if (!this.clock.ready) return 0.02;
    const sr = this.clock.sampleRate || 48000;
    const blockSec = (Number(this.latestSnapshot?.clockBlockSize) || 512) / sr;
    const ctxLat = ctxHeardLatencySec(this.engine.ctx, ctxPair(this.engine.ctx)); // the ctx output latency the pair knows
    return Math.max(0.02, this.clock.outputLatencyMs / 1000 + 1.5 * blockSec + 0.004 - ctxLat);
  }
  private seqPlay(anchorCtx: number): void {
    this.playAnchorCtx = anchorCtx; this.playAckAt = Infinity; this.playStartSample = NaN; this.nudgeApplied = 0; this.driftFilt = NaN;
    this.lastQueued = null;
    const idx = this.engine.getPlayingSeqIdx();
    const p = this.engine.peekSequence(idx);
    const swing = this.engine.getSeqSwing();
    const bpm = this.engine.getMasterBpm();
    this.queueSeq(async () => {
      if (bpm !== this.lastBpmSent) { this.lastBpmSent = bpm; await this.cmd({ type: 'setBpm', bpm }); }
      await this.sendPattern(idx, p, swing, 'setSequence');
      // the anchor the satellites start at, as an engine sample heard at the same instant (0 = next block when the
      // clock is not calibrated yet — the first ~100 ms after attach; the drift nudge then pulls the drums in)
      const atSample = this.clock.ready ? Math.round(this.clock.sampleAtCtxTime(anchorCtx, ctxPair(this.engine.ctx))) : 0;
      await this.cmd({ type: 'seqPlay', atSample: atSample > 0 ? atSample : 0 });
      this.playAckAt = performance.now();
    });
  }
  /** State → the native sequencer: the audible pattern (live edits), a queued switch, BPM, swing. */
  private syncTransport(s: ChopperState): void {
    if (!this.engine.seqSink) return;
    const bpm = this.engine.getMasterBpm();
    if (bpm !== this.lastBpmSent) { this.lastBpmSent = bpm; this.queueSeq(() => this.cmd({ type: 'setBpm', bpm })); }
    if (!s.seqPlaying) { this.lastQueued = null; return; }
    const idx = s.playingSeqIdx;
    const p = s.sequences[idx] ?? null; // the state's deep copy — free to keep
    if (p) this.queueSeq(() => this.sendPattern(idx, p, s.seqSwing, 'setSequence'));
    const q = s.queuedSeqIdx;
    if (q === null) {
      if (this.lastQueued) { this.lastQueued = null; this.queueSeq(() => this.cmd({ type: 'queueSequence', cancel: true })); }
    } else if (q !== idx) {
      const qp = s.sequences[q] ?? null;
      if (qp) this.queueSeq(() => this.sendPattern(q, qp, s.seqSwing, 'queueSequence'));
    }
  }
  /** How old the newest snapshot's position is, right now (ms; 0 when the clock is not calibrated). */
  snapshotAgeMs(): number {
    const age = performance.now() - this.snapEmitPerfMs;
    return Number.isFinite(age) && age > 0 ? age : 0;
  }
  /** The tolerance (in steps) for comparing a LIVE cursor against a snapshot's step field: the snapshot's position is
   *  `snapshotAgeMs` old (the cursor has moved on since), and the cursor is the HEARD position while the snapshot's is
   *  the RENDERED one (the cursor sits one output latency behind). Either way ±1 step of rounding. */
  cursorToleranceSteps(stepDurSec: number): number {
    const stepMs = Math.max(1e-6, stepDurSec * 1000);
    return Math.ceil((this.snapshotAgeMs() + this.clock.outputLatencyMs) / stepMs) + 1;
  }
  /** The chop cursor: seconds since the audible loop start, at the ear, on the engine's clock (null = not known). */
  private seqElapsedSec(): number | null {
    const s = this.latestSnapshot;
    if (!s || !s.seqPlaying || s.seqPaused || !this.clock.ready) return null;
    const ls = Number(s.seqLoopStartSample);
    if (!(ls > 0)) return null;
    return (this.clock.sampleHeardAtPerfMs(performance.now()) - ls) / this.clock.sampleRate;
  }
  /** Snapshot → clock anchor, the engine's position push, the satellite drift nudge. */
  private onSnapshot(s: AnyRecord): void {
    const recv = performance.now();
    if (s && typeof s.clockHostNs === 'number' && s.clockHostNs > 0) {
      this.clock.onSnapshot({ clockHostNs: s.clockHostNs, clockSample: Number(s.clockSample), sampleRate: Number(s.sampleRate), emitHostNs: Number(s.emitHostNs) }, recv);
    }
    this.stats.clockReady = this.clock.ready;
    if (s && this.clock.ready && Number(s.emitHostNs) > 0) this.snapEmitPerfMs = this.clock.hostNsToPerfMs(Number(s.emitHostNs));
    this.stats.snapshotAgeMs = this.snapshotAgeMs();
    this.drumShadow?.onSnapshot(s);
    if (!s || this.detached || !this.engine.seqSink || typeof s.seqPlaying !== 'boolean') return;
    const idx = Number(s.seqPatternIndex);
    const held = this.sentPatterns.get(idx);
    const bpm = Number(s.seqBpm) > 0 ? Number(s.seqBpm) : 120;
    const res = held?.resolution ?? 16;
    const stepDur = (60 / bpm) * (4 / res);
    const pair = this.clock.ready ? ctxPair(this.engine.ctx) : null;
    const loopStartSample = Number(s.seqLoopStartSample);
    const loopStartCtx = pair && loopStartSample > 0 ? this.clock.ctxTimeAtSample(loopStartSample, pair) : NaN;
    const step = Number(s.seqStep);
    const pausedElapsed = step >= 0 ? (step + (Number(s.seqStepPhase) || 0)) * stepDur : 0;
    this.engine.nativeSeqUpdate({ playing: !!s.seqPlaying, paused: !!s.seqPaused, loopStartCtx, stepDur, playingIdx: idx, pausedElapsed, receivedAt: recv });
    // drift: where the native grid is heard vs where the ctx-clocked satellites (started at playAnchorCtx) expect it
    if (!s.seqPlaying) { this.playStartSample = NaN; return; }
    if (!pair || s.seqPaused || !Number.isFinite(this.playAnchorCtx) || recv < this.playAckAt + 60) return;
    if (!Number.isFinite(this.playStartSample)) { if (loopStartSample > 0) { this.playStartSample = loopStartSample; this.nudgeApplied = 0; } return; }
    const sNow = Number(s.clockSample);
    if (!(sNow > 0) || this.clock.sampleRate <= 0) return;
    const drift = this.clock.ctxTimeAtSample(sNow, pair) - (this.playAnchorCtx + (sNow - this.playStartSample) / this.clock.sampleRate);
    this.stats.driftMs = drift * 1000;
    // the first reading seeds (a real start offset is corrected at once); later ones are low-passed (1 ms clock
    // granularity) and corrected with 2 ms hysteresis — musical drift is 0.6–3 ms/min, so a nudge every minute or so
    this.driftFilt = Number.isFinite(this.driftFilt) ? this.driftFilt * 0.7 + drift * 0.3 : drift;
    const c = this.driftFilt - this.nudgeApplied;
    if (Math.abs(c) > 0.002 && Math.abs(c) < 0.5) { this.nudgeApplied += c; this.stats.seqNudges++; this.engine.nudgeSatellites(c); }
  }
  /** host ↔ performance.now() by round trip (best RTT wins); also refreshes the sample anchor + output latency. */
  private async calibrateClock(rounds: number): Promise<void> {
    for (let i = 0; i < rounds && !this.detached; i++) {
      const t0 = performance.now();
      let r: AnyRecord | null = null;
      try { r = await native.audio({ verb: 'clock' }); } catch { return; }
      const t1 = performance.now();
      if (!r || typeof r.hostNs !== 'number' || !(r.hostNs > 0)) return;
      this.clock.addRoundTrip(t0, r.hostNs, t1);
      if (typeof r.outputLatencyMs === 'number' && r.outputLatencyMs >= 0) this.clock.outputLatencyMs = r.outputLatencyMs;
      if (Number(r.clockHostNs) > 0 && Number(r.sampleRate) > 0) this.clock.onSnapshot({ clockHostNs: Number(r.clockHostNs), clockSample: Number(r.clockSample), sampleRate: Number(r.sampleRate) }, t1);
    }
    this.stats.clockRttMs = this.clock.rttMs;
    this.stats.clockReady = this.clock.ready;
  }

  /** Diff one pad against what was last sent; queue the apply (per-pad ordered). */
  private syncPad(i: number, s: ChopperState): void {
    let d: PadDesc | null = null;
    try { d = this.describe(i, s); } catch (e) { this.stats.lastError = `describe ${i}: ${String((e as any)?.message ?? e)}`; }
    const prev = this.last[i];
    if (sameDesc(prev, d)) return;
    this.last[i] = d;
    if (d && (!prev || prev.buf !== d.buf)) this.retain(this.ensure(d.buf, i < s.pads.length && s.padBufferMeta[i] ? 'src' : 'main'));
    if (prev && (!d || prev.buf !== d.buf)) { const r = this.recs.get(prev.buf); if (r) this.unretain(r); }
    this.chain[i] = this.chain[i].then(() => this.apply(i, d, prev)).catch(() => {});
  }

  private async apply(i: number, d: PadDesc | null, prev: PadDesc | null): Promise<void> {
    if (this.detached) return;
    if (!d) {
      if (prev) {
        await this.cmd({ type: 'setPadSample', pad: i });
        if (loopOf(prev)) await this.cmd({ type: 'setPadLoop', pad: i, clear: true });
      }
      this.lastKey[i] = null;
      this.stats.padsBound = this.last.filter(Boolean).length;
      return;
    }
    const rec = this.ensure(d.buf);
    const ok = await rec.ready;
    if (!ok || this.last[i] !== d) return; // upload failed, or a newer descriptor already queued behind us
    if (!prev || !sameRegion(prev, d) || this.lastKey[i] !== rec.key) {
      await this.cmd({ type: 'setPadSample', pad: i, key: rec.key, startSec: d.start, endSec: d.end });
      this.lastKey[i] = rec.key;
    }
    if (!prev || !sameParams(prev, d)) {
      await this.cmd({ type: 'setPadParams', pad: i, pitch: d.pitch, fine: d.fine, attack: d.attack, release: d.release, fadeOut: d.mode === 'oneshot' ? d.fadeOut : 0, gain: d.gain, outputPair: 0, mode: d.mode, gate: d.gate, reverse: d.reverse, chokeGroup: d.choke, interpolation: 'hermite' });
    }
    const lp = loopOf(d);
    if (!sameLoop(loopOf(prev), lp) || (lp && prev && !sameRegion(prev, d))) {
      await this.cmd(lp ? { type: 'setPadLoop', pad: i, key: rec.key, startSec: lp.start, endSec: lp.end, fadeInSec: lp.fadeIn, fadeOutSec: lp.fadeOut, reverse: lp.reverse } : { type: 'setPadLoop', pad: i, clear: true });
    }
    this.stats.padsBound = this.last.filter(Boolean).length;
  }

  // ── voices ──
  private onStart(pad: number, velocity: number, when: number | undefined, reverseOverride: boolean | undefined, nativeOwned: boolean): void {
    if (this.detached || pad < 0 || pad >= MAX_PADS) return;
    // a hit right after an edit: make sure THIS pad's latest state is queued before the trigger (the subscribe
    // cadence is rAF-coalesced; the hit is now)
    try { this.syncPad(pad, this.engine.getState()); } catch { /* */ }
    if (nativeOwned) return; // the engine played it already (direct MIDI path) — only the bookkeeping above
    // a hit booked AHEAD (the live-record quantize, triggerPadAt): with the clock calibrated it goes out as an engine
    // sample (sample-exact, the engine books it — no timer jitter); otherwise the old timer path
    const atSample = when !== undefined && this.clock.ready ? Math.round(this.clock.sampleAtCtxTime(when, ctxPair(this.engine.ctx))) : 0;
    const fire = async () => {
      const d = this.last[pad];
      const flip = reverseOverride !== undefined && d !== null && d.mode !== 'loop' && reverseOverride !== d.reverse;
      if (flip) await this.cmd({ type: 'setPadParams', pad, pitch: d!.pitch, fine: d!.fine, attack: d!.attack, release: d!.release, fadeOut: d!.mode === 'oneshot' ? d!.fadeOut : 0, gain: d!.gain, outputPair: 0, mode: d!.mode, gate: d!.gate, reverse: reverseOverride, chokeGroup: d!.choke, interpolation: 'hermite' });
      this.stats.triggers++;
      await this.cmd(atSample > 0 ? { type: 'triggerPad', pad, velocity: Math.max(0, Math.min(1, velocity)), atSample } : { type: 'triggerPad', pad, velocity: Math.max(0, Math.min(1, velocity)) });
      if (flip) await this.cmd({ type: 'setPadParams', pad, pitch: d!.pitch, fine: d!.fine, attack: d!.attack, release: d!.release, fadeOut: d!.mode === 'oneshot' ? d!.fadeOut : 0, gain: d!.gain, outputPair: 0, mode: d!.mode, gate: d!.gate, reverse: d!.reverse, chokeGroup: d!.choke, interpolation: 'hermite' });
    };
    const delayMs = when !== undefined && atSample <= 0 ? (when - this.engine.ctx.currentTime) * 1000 : 0;
    const go = () => { this.chain[pad] = this.chain[pad].then(fire).catch(() => {}); };
    if (delayMs > 2) setTimeout(go, delayMs); else go();
  }
  private onStop(pad: number): void {
    if (this.detached) return;
    this.chain[pad] = this.chain[pad].then(() => this.cmd({ type: 'stopPad', pad })).then(() => {}).catch(() => {});
  }
  private onRelease(pad: number): void {
    if (this.detached) return;
    this.chain[pad] = this.chain[pad].then(() => this.cmd({ type: 'releasePad', pad })).then(() => {}).catch(() => {});
  }

  // ── probe self-test (tools/ci/probe-app.sh): a synthetic buffer → upload → bind pad 63 → trigger → read back ──
  async selfTest(): Promise<AnyRecord> {
    const r: AnyRecord = {};
    try {
      const sr = 48000, frames = 12000; // 0.25 s mono 1 kHz sine
      const buf = new AudioBuffer({ length: frames, sampleRate: sr, numberOfChannels: 1 });
      const d = buf.getChannelData(0);
      for (let i = 0; i < frames; i++) d[i] = Math.sin(2 * Math.PI * 1000 * i / sr) * 0.5;
      const rec = this.ensure(buf, 'probe');
      r.upload = await rec.ready;
      r.key = rec.key;
      const list = await native.samples({ verb: 'list' });
      r.keysInStore = Array.isArray(list?.keys) ? list.keys.length : -1;
      r.storeFrames = Array.isArray(list?.keys) ? (list.keys.find((k: any) => k.key === rec.key)?.frames ?? -1) : -1;
      r.params = await this.cmd({ type: 'setPadParams', pad: 63, pitch: 0, fine: 0, attack: 0, release: 0, gain: 1, mode: 'oneshot', gate: false, reverse: false, chokeGroup: -1 });
      r.bind = await this.cmd({ type: 'setPadSample', pad: 63, key: rec.key, startSec: 0, endSec: 0 });
      r.loop = await this.cmd({ type: 'setPadLoop', pad: 63, key: rec.key, startSec: 0, endSec: 0.1, fadeInSec: 0.01, fadeOutSec: 0.01, reverse: false });
      r.loopClear = await this.cmd({ type: 'setPadLoop', pad: 63, clear: true });
      r.trigger = await this.cmd({ type: 'triggerPad', pad: 63, velocity: 1 });
      await new Promise((res) => setTimeout(res, 400));
      r.enginePrepared = !!this.latestSnapshot?.prepared;
      r.lastTriggeredPad = this.latestSnapshot?.lastTriggeredPad ?? null;
      r.padActiveMask = this.latestSnapshot?.padActiveMask ?? null;
      // the native chop sequencer (Phase 3.1 bridge smoke): a 16-step pattern hitting pad 63 on every step at
      // 240 BPM (stepDur 62.5 ms) → seqPlaying, the step cursor advances, hits fire; then stop
      r.seqSet = await this.cmd({ type: 'setSequence', index: 0, bars: 1, resolution: 16, loop: true, swing: 0, grid: Array.from({ length: 16 }, () => [63]), velGrid: Array.from({ length: 16 }, () => [1]) });
      r.seqBpm = await this.cmd({ type: 'setBpm', bpm: 240 });
      r.seqPlay = await this.cmd({ type: 'seqPlay' });
      await new Promise((res) => setTimeout(res, 350));
      const s1 = this.latestSnapshot;
      r.seqPlaying = !!s1?.seqPlaying;
      r.seqStepA = s1?.seqStep ?? -1;
      r.seqStepCount = s1?.seqStepCount ?? 0;
      await new Promise((res) => setTimeout(res, 300));
      const s2 = this.latestSnapshot;
      r.seqStepB = s2?.seqStep ?? -1;
      r.seqHits = Number(s2?.seqHitsFired ?? 0);
      r.seqAdvances = r.seqPlaying && r.seqStepCount === 16 && r.seqHits >= 8 && r.seqStepB !== r.seqStepA;
      r.seqStop = await this.cmd({ type: 'seqStop' });
      // the snapshot is 20 Hz and a loaded CI runner can starve the timer — poll (up to 2 s) instead of one fixed wait
      for (let t = 0; t < 40 && this.latestSnapshot?.seqPlaying; t++) await new Promise((res) => setTimeout(res, 50));
      r.seqStopped = !this.latestSnapshot?.seqPlaying;
      r.unbind = await this.cmd({ type: 'setPadSample', pad: 63 });
      const rel = await native.samples({ verb: 'release', key: rec.key });
      r.release = !!rel?.ok;
      this.liveRecs.delete(rec); rec.failed = true;
      this.stats.buffersLive = this.liveRecs.size;
      this.last[63] = null; this.lastKey[63] = null; // the real pad 63 (if any) re-binds on the next state emit
      // part 2 — the REAL path: a pad source lands in the TS engine → subscribe → describe/diff → upload → bind
      const buf2 = new AudioBuffer({ length: frames, sampleRate: sr, numberOfChannels: 2 });
      for (let c = 0; c < 2; c++) { const d2 = buf2.getChannelData(c); for (let i = 0; i < frames; i++) d2[i] = Math.sin(2 * Math.PI * 220 * i / sr) * 0.4; }
      const padsBefore = this.stats.padsBound;
      this.engine.loadPadBuffer(62, buf2, 'probe-sync', 'probe sync');
      this.engine.setPadPitch(62, 3); // a param edit on top (pitch 3 → the bound pad carries it)
      for (let t = 0; t < 40 && !(this.stats.padsBound > padsBefore && this.lastKey[62]); t++) await new Promise((res) => setTimeout(res, 50));
      const list2 = await native.samples({ verb: 'list' });
      const bound = Array.isArray(list2?.pads) ? list2.pads.find((p: any) => p.pad === 62) : null;
      r.syncBound = !!bound && bound.key === this.lastKey[62];
      r.syncKey = this.lastKey[62];
      r.syncDesc = this.last[62] ? { start: this.last[62]!.start, end: this.last[62]!.end, pitch: this.last[62]!.pitch, mode: this.last[62]!.mode } : null;
      r.ctxState = this.engine.ctx.state;
      const trig = this.stats.triggers;
      this.engine.triggerPad(62, 1);
      await new Promise((res) => setTimeout(res, 300));
      r.syncTrigger = this.stats.triggers > trig; // only when the page AudioContext runs (a real session); headless may be suspended
      // a MIDI note from a device: the engine plays it directly and the page mirrors it (LED/record) — no double trigger
      const trig2 = this.stats.triggers, notes0 = this.stats.midiNotes;
      await native.midi({ verb: 'inject', note: 62 + 36, velocity: 100, on: true });
      await new Promise((res) => setTimeout(res, 250));
      r.midiMirrored = this.stats.midiNotes > notes0 && this.engine.getActivity().lastTriggeredPad === 62;
      r.midiNoDoubleTrigger = this.stats.triggers === trig2;
      r.midiNativeHit = this.latestSnapshot?.lastTriggeredPad === 62;
      await native.midi({ verb: 'inject', note: 62 + 36, velocity: 0, on: false });
      // part 3 — Phase 3.2: the PAGE's transport drives the NATIVE chop sequencer. The current sequence becomes a
      // 1-bar/16-step pattern hitting pad 62 on steps 0/4/8/12 at 240 BPM (a hit every 250 ms); engine.playSeq()
      // → native seqPlaying with the page's pattern index, hits fire, the TS cursor (read from the native anchor
      // through NativeClock) tracks the native step; engine.stopSeq() stops it natively.
      r.clockReady = this.clock.ready; r.clockRttMs = this.clock.rttMs; r.clockOutLatencyMs = this.clock.outputLatencyMs;
      { const pr = ctxPair(this.engine.ctx); r.ctxPairDeltaMs = (this.engine.ctx.currentTime - pr.contextTime) * 1000; r.ctxHeardLatencyMs = ctxHeardLatencySec(this.engine.ctx, pr) * 1000; r.ctxOutputLatencyMs = (this.engine.ctx.outputLatency || 0) * 1000; r.ctxBaseLatencyMs = (this.engine.ctx.baseLatency || 0) * 1000; r.seqPageLeadMs = this.playLeadSec() * 1000; }
      if (this.engine.seqSink && this.latestSnapshot?.prepared) {
        this.engine.setSeqBars(1); this.engine.setSeqResolution(16);
        for (const step of [0, 4, 8, 12]) if (!(this.engine.getState().seqGrid[step] ?? []).includes(62)) this.engine.toggleSeqStep(step, 62);
        this.engine.setMetronomeBpm(240);
        const hits0 = Number(this.latestSnapshot?.seqHitsFired ?? 0);
        this.engine.playSeq();
        await new Promise((res) => setTimeout(res, 500));
        const sp1 = this.latestSnapshot;
        r.seqPageNativePlaying = !!sp1?.seqPlaying;
        r.seqPagePatternIndex = sp1?.seqPatternIndex ?? -9;
        r.seqPagePlayingIdx = this.engine.getPlayingSeqIdx();
        r.seqPageStepCount = sp1?.seqStepCount ?? 0;
        // the live cursor vs the snapshot's step: the snapshot's position is snapshotAgeMs old and is the RENDERED
        // one (the cursor is what is HEARD) — the tolerance is derived, not guessed (a starved CI runner delivers
        // snapshots > 100 ms late = 2 steps at 240 BPM; a real device lands on 0)
        const stepDur = 60 / 240 * 4 / 16; // the probe's pattern: 240 BPM, 16 steps/bar
        const cur1 = this.engine.getSeqCursorStep(), nat1 = Number(sp1?.seqStep), age1 = this.snapshotAgeMs(), tol1 = this.cursorToleranceSteps(stepDur);
        await new Promise((res) => setTimeout(res, 300));
        const sp2 = this.latestSnapshot;
        const cur2 = this.engine.getSeqCursorStep(), nat2 = Number(sp2?.seqStep), age2 = this.snapshotAgeMs(), tol2 = this.cursorToleranceSteps(stepDur);
        const close = (a: number, b: number, tol: number) => { const d = Math.abs(a - b); return Math.min(d, 16 - d) <= tol; };
        r.seqPageCursor = { cur1, nat1, cur2, nat2 };
        r.seqPageCursorAgeMs = { age1, age2, tol1, tol2 };
        r.seqPageCursorTracks = close(cur1, nat1, tol1) && close(cur2, nat2, tol2);
        r.seqPageHits = Number(sp2?.seqHitsFired ?? 0) - hits0; // ≥ 3 over 800 ms
        r.seqPageDriftMs = this.stats.driftMs; r.seqPageNudges = this.stats.seqNudges;
        this.engine.stopSeq();
        for (let t = 0; t < 40 && this.latestSnapshot?.seqPlaying; t++) await new Promise((res) => setTimeout(res, 50));
        r.seqPageStopped = !this.latestSnapshot?.seqPlaying && !this.engine.isSeqPlaying();
        r.seqPageOk = r.seqPageNativePlaying && r.seqPagePatternIndex === r.seqPagePlayingIdx && r.seqPageStepCount === 16
          && r.seqPageHits >= 2 && (this.clock.ready ? r.seqPageCursorTracks : true) && r.seqPageStopped;
      } else r.seqPageOk = null; // no audio device → the engine is not prepared: the transport cannot be observed
      // part 4 — Phase 3.3: the DRUM MACHINE drives the native DrumSequencer (nativeDrumShadow.selfTest)
      if (this.drumShadow && this.latestSnapshot?.prepared) {
        r.drums = await this.drumShadow.selfTest();
        r.drumPageOk = r.drums?.drumPageOk === true;
      } else r.drumPageOk = null;
      this.engine.removePadBuffer(62);
      for (let t = 0; t < 40 && this.last[62]; t++) await new Promise((res) => setTimeout(res, 50));
      r.syncUnbound = !this.last[62];
      r.ok = r.upload && r.bind && r.trigger && r.release && r.storeFrames === frames && r.syncBound && r.syncUnbound && (r.syncDesc?.pitch === 3) && r.midiMirrored && r.midiNoDoubleTrigger && (r.enginePrepared ? (r.seqAdvances && r.seqStopped && r.seqPageOk === true && (this.drumShadow ? r.drumPageOk === true : true)) : true);
    } catch (e) { r.error = String((e as any)?.stack ?? e); r.ok = false; }
    r.lastError = this.stats.lastError;
    return r;
  }
}

declare global {
  interface Window { __terminatorNativeShadow?: { stats: () => NativeShadowStats; selfTest: () => Promise<AnyRecord> } }
}

/** Attach the shadow to a ChopperEngine (+ its DrumEngine — Phase 3.3) (ChopperView / HardwareView, on mount).
 *  Returns the detach. No-op outside the shell. */
export function attachNativeEngineShadow(engine: ChopperEngine, drums: DrumEngine | null = null): () => void {
  if (!isNative()) return () => {};
  const shadow = new NativeEngineShadow(engine, drums);
  shadow.attach();
  window.__terminatorNativeShadow = { stats: () => ({ ...shadow.stats }), selfTest: () => shadow.selfTest() };
  return () => {
    shadow.detach();
    delete window.__terminatorNativeShadow;
  };
}
