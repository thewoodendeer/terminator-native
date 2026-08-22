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
 * Not mirrored yet (honest list, also in STATUS.md): the chop SEQUENCER's scheduled voices + drums + bass (still
 * Web Audio — Phase 3 transport), mixer strips / master FX (Phase 4), time-STRETCH (plays dry natively), live
 * re-stem of a ringing voice (the next hit plays the new mix), per-hit reverse of a rendered LOOP. MIDI reaching the page does not exist in the WebView (no Web MIDI): native MIDI hits the C++
 * engine directly (MidiHub, note−36) — the UI does not light them yet.
 */
import type { ChopperEngine, ChopperState } from '../chopper/ChopperEngine';
import { isNative, native, onNativeEvent } from './juceBridge';

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
  stats: NativeShadowStats = { attached: false, buffersLive: 0, bytesUploaded: 0, uploads: 0, uploadFailures: 0, commands: 0, commandErrors: 0, padsBound: 0, triggers: 0, midiNotes: 0, lastError: null };

  constructor(private engine: ChopperEngine) {}

  attach(): void {
    this.engine.mutePadVoices = true;
    this.engine.voiceSink = {
      start: (pad, velocity, when, reverseOverride, nativeOwned) => this.onStart(pad, velocity, when, reverseOverride, nativeOwned),
      stop: (pad) => this.onStop(pad),
      release: (pad) => this.onRelease(pad),
    };
    this.unsubscribe = this.engine.subscribe((s) => this.sync(s));
    this.unsubSnapshot = onNativeEvent('terminator.snapshot', (snap) => { this.latestSnapshot = snap; });
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
    this.unsubscribe?.(); this.unsubscribe = null;
    this.unsubSnapshot?.(); this.unsubSnapshot = null;
    this.unsubMidi?.(); this.unsubMidi = null;
    this.engine.voiceSink = null;
    this.engine.mutePadVoices = false;
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
    const fire = async () => {
      const d = this.last[pad];
      const flip = reverseOverride !== undefined && d !== null && d.mode !== 'loop' && reverseOverride !== d.reverse;
      if (flip) await this.cmd({ type: 'setPadParams', pad, pitch: d!.pitch, fine: d!.fine, attack: d!.attack, release: d!.release, fadeOut: d!.mode === 'oneshot' ? d!.fadeOut : 0, gain: d!.gain, outputPair: 0, mode: d!.mode, gate: d!.gate, reverse: reverseOverride, chokeGroup: d!.choke, interpolation: 'hermite' });
      this.stats.triggers++;
      await this.cmd({ type: 'triggerPad', pad, velocity: Math.max(0, Math.min(1, velocity)) });
      if (flip) await this.cmd({ type: 'setPadParams', pad, pitch: d!.pitch, fine: d!.fine, attack: d!.attack, release: d!.release, fadeOut: d!.mode === 'oneshot' ? d!.fadeOut : 0, gain: d!.gain, outputPair: 0, mode: d!.mode, gate: d!.gate, reverse: d!.reverse, chokeGroup: d!.choke, interpolation: 'hermite' });
    };
    const delayMs = when !== undefined ? (when - this.engine.ctx.currentTime) * 1000 : 0;
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
      this.engine.removePadBuffer(62);
      for (let t = 0; t < 40 && this.last[62]; t++) await new Promise((res) => setTimeout(res, 50));
      r.syncUnbound = !this.last[62];
      r.ok = r.upload && r.bind && r.trigger && r.release && r.storeFrames === frames && r.syncBound && r.syncUnbound && (r.syncDesc?.pitch === 3) && r.midiMirrored && r.midiNoDoubleTrigger;
    } catch (e) { r.error = String((e as any)?.stack ?? e); r.ok = false; }
    r.lastError = this.stats.lastError;
    return r;
  }
}

declare global {
  interface Window { __terminatorNativeShadow?: { stats: () => NativeShadowStats; selfTest: () => Promise<AnyRecord> } }
}

/** Attach the shadow to a ChopperEngine (ChopperView / HardwareView, on mount). Returns the detach. No-op outside
 *  the shell. */
export function attachNativeEngineShadow(engine: ChopperEngine): () => void {
  if (!isNative()) return () => {};
  const shadow = new NativeEngineShadow(engine);
  shadow.attach();
  window.__terminatorNativeShadow = { stats: () => ({ ...shadow.stats }), selfTest: () => shadow.selfTest() };
  return () => {
    shadow.detach();
    delete window.__terminatorNativeShadow;
  };
}
