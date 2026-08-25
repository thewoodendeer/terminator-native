// STEMS controller — the renderer side of a split session (STEM-SPLIT-PLAN.md
// Phase 3 glue). Owns the full-length stem AudioBuffers while the worker
// streams chunks in, keeps the engine's ready-ranges current, writes the
// finished stems into the asset store (so projects reload instantly), and
// restores them on project load. The UI talks to THIS, never to the IPC.
//
// TIME BASE: everything here is the ORIGINAL's time (engine.sourceBuffer): the
// PCM sent to the worker, the chunk ranges, the ready ranges, the cache key and
// the asset WAVs. A TRIM in the chopper never reaches this file — the engine
// maps chop spans with effToFile on the way in and cuts the stems on the way out.
//
// Scope model: the UI only ever splits the WHOLE song ('all' — every chop
// focused-first + the background sweep; his simplification 2026-08-21, the
// scoped split buttons are gone). The pad-list scope stays as an INTERNAL
// detail for `ensureChopSplit`, the new-chop hook: it queues into a live run or
// starts a scoped one for a span a cancelled split left unready.
// STEMS PER SOURCE (his workflow 2026-08-22): a session splits ONE target —
// the main track, or a pad's OWN sample (a link, a file, a recording). Every
// engine call below goes through `io(target)` so the two stay identical; the
// stems of every source live in the engine side by side (one kit, many split
// samples). One split runs at a time; the engine is free the moment it ends.
import type { ChopperEngine } from './ChopperEngine';
import { STEM_ORDER, StemName, MASK_ALL, spanReady } from './stemMask';
import { assetStore, assetHash } from './projectAssets';
import type { ChopPreset } from './ChopperEngine';
import { encodeFlac16 } from '../audio/flacEncode';
import { freshSplitSm, seedSplitSm, tickSplitSm, creepSplitSm, blendMsPerChunk, DEFAULT_MS_PER_CHUNK, type SplitSm } from './stemsProgress';
import { audioKey } from './stemsKey';
import { nativeEngineShadow } from '../native/nativeEngineShadow';

export type Span = { startSec: number; endSec: number };
/** What a split is about: the main track, or one pad source (its buffer). */
export type StemsTarget = { kind: 'main' } | { kind: 'source'; buffer: AudioBuffer };
export const MAIN_TARGET: StemsTarget = { kind: 'main' };
type CacheEntry = {
  quality: 'fast' | 'fine';
  assets: Record<string, string>;
  readyRanges: Array<[number, number]>;
  sampleRate: number;
  frames: number;
  title: string;
  savedAt: number;
};
type Bridge = {
  /** NATIVE (Terminator 3.0): the split runs in the shell and reads the audio out of its own sample store, so
   *  `key` replaces the PCM — copying 170 MB of floats across the bridge to start a split it can already see
   *  would be the slowest part of the whole feature. `stemsNative` marks that host. */
  stemsNative?: boolean;
  stemsSplit?: (opts: { pcmL?: ArrayBuffer; pcmR?: ArrayBuffer; key?: string; srcRate: number; quality: 'fast' | 'fine'; windows: Span[]; sweep: boolean }) => Promise<{ ok: boolean; error?: string }>;
  stemsQueueWindow?: (span: Span) => Promise<{ ok: boolean; error?: string }>;
  stemsCancel?: () => Promise<{ ok: boolean }>;
  stemsCacheGet?: (key: string, quality: 'fast' | 'fine') => Promise<CacheEntry | null>;
  stemsCachePut?: (key: string, entry: CacheEntry) => Promise<{ ok: boolean; error?: string }>;
  stemsCacheDrop?: (key: string, quality?: 'fast' | 'fine') => Promise<{ ok: boolean }>;
  onStemsProgress?: (cb: (p: { phase: 'models' | 'load' | 'split'; pct: number; total?: number }) => void) => () => void;
  onStemsChunk?: (cb: (c: { startFrame: number; endFrame: number; stems: Float32Array[] }) => void) => () => void;
  onStemsDone?: (cb: () => void) => () => void;
  onStemsError?: (cb: (e: { message: string }) => void) => () => void;
};
const bridge = (): Bridge | undefined => (typeof window !== 'undefined' ? (window as any).terminator : undefined);

/** Splitting exists on the desktop app only (the worker is an Electron main
 *  feature) — the web build shows the desktop-download upsell instead. */
export const stemsAvailable = (): boolean => !!bridge()?.stemsSplit;

const QUALITY_KEY = 'terminator-stems-quality';
export type StemsQuality = 'fast' | 'fine';
export function lastQuality(): StemsQuality {
  try { return localStorage.getItem(QUALITY_KEY) === 'fine' ? 'fine' : 'fast'; } catch { return 'fast'; }
}
export function rememberQuality(q: StemsQuality): void {
  try { localStorage.setItem(QUALITY_KEY, q); } catch { /* */ }
}
// Measured split speed per quality (ms per 7.8 s chunk on THIS machine) — seeds
// the progress estimate of the next run so the % moves from second one.
const RATE_KEY = 'terminator-stems-ms-per-chunk';
export function lastMsPerChunk(q: StemsQuality): number {
  try { const v = JSON.parse(localStorage.getItem(RATE_KEY) ?? '{}')?.[q]; return typeof v === 'number' && v > 0 ? v : DEFAULT_MS_PER_CHUNK[q]; } catch { return DEFAULT_MS_PER_CHUNK[q]; }
}
export function rememberMsPerChunk(q: StemsQuality, ms: number): void {
  try { const cur = JSON.parse(localStorage.getItem(RATE_KEY) ?? '{}') ?? {}; cur[q] = Math.round(ms); localStorage.setItem(RATE_KEY, JSON.stringify(cur)); } catch { /* */ }
}

export interface StemsUiState {
  phase: 'idle' | 'models' | 'load' | 'split' | 'saving';
  pct: number;
  error: string | null;
  /** BATCH: which split of how many this is (several pads selected → STEMS). */
  queue?: { n: number; total: number } | null;
}

export class StemsController {
  private engine: ChopperEngine;
  private unsubs: Array<() => void> = [];
  private stems: Record<StemName, AudioBuffer> | null = null;
  private forBuffer: AudioBuffer | null = null; // which buffer the session's stems belong to
  private target: StemsTarget = MAIN_TARGET;    // what the session is splitting
  private running = false;
  private quality: StemsQuality = lastQuality();
  state: StemsUiState = { phase: 'idle', pct: 0, error: null };
  onState: ((s: StemsUiState) => void) | null = null;
  /** One-line notices for the UI's flash line (cache hits, nothing to split). */
  onNote: ((msg: string) => void) | null = null;
  private keys = new WeakMap<AudioBuffer, string>(); // content keys, per buffer (hashing is ~10 ms)
  private restoring = false;   // a project restore owns the stems right now
  // Display smoothing: real progress lands one chunk (or FINE quarter-chunk)
  // at a time — on a long track that's a tick only every few seconds, which
  // reads as "stuck". Between real ticks the SHOWN pct creeps toward the next
  // expected tick at the measured rate, capped just under it, so a long split
  // moves 0→100 instead of jumping. Shown never goes backwards mid-run.
  private sm: SplitSm = freshSplitSm();
  private smTimer: ReturnType<typeof setInterval> | null = null;

  constructor(engine: ChopperEngine) { this.engine = engine; }

  private set(phase: StemsUiState['phase'], pct: number, error: string | null = null): void {
    this.state = { phase, pct, error, queue: this.queueInfo };
    this.onState?.(this.state);
  }
  // ── BATCH (his ask 2026-08-22: "select multiple samples and click stem") ──
  // One engine run at a time (the worker holds one source's chunk grid), so
  // several targets QUEUE and run back to back — unattended, one status line
  // saying "2 OF 5". Main keeps the finished worker parked with its models
  // loaded, so the queue pays the model load once, not per split.
  private pending: Array<{ quality: StemsQuality; target: StemsTarget; span: Span }> = [];
  private queueInfo: { n: number; total: number } | null = null;
  private draining = false;
  /** Queue a whole-sample split for every target (duplicates and already-made
   *  ones dropped) and start draining if idle. */
  startMany(quality: StemsQuality, jobs: Array<{ target: StemsTarget; span: Span }>): void {
    const seen = new Set<unknown>();
    let added = 0, made = 0;
    for (const j of jobs) {
      const id = j.target.kind === 'main' ? 'main' : j.target.buffer;
      if (seen.has(id)) continue; seen.add(id);
      if (this.pending.some(p => (p.target.kind === 'main' ? 'main' : p.target.buffer) === id)) continue;
      if (this.running && this.sameTarget(this.target, j.target)) continue;
      const io = this.io(j.target);
      const ranges = io.meta()?.readyRanges ?? [];
      if (io.has() && spanReady(ranges, j.span.startSec, j.span.endSec)) { made++; continue; }
      this.pending.push({ quality, target: j.target, span: j.span }); added++;
    }
    if (!added) { this.onNote?.(made ? 'STEMS ALREADY MADE for every selected sample' : 'NOTHING TO SPLIT'); return; }
    const total = this.pending.length + (this.running ? 1 : 0) + (this.queueInfo ? this.queueInfo.n - (this.running ? 1 : 0) : 0);
    this.queueInfo = { n: this.running ? (this.queueInfo?.n ?? 1) : 0, total: Math.max(total, this.queueInfo?.total ?? 0) };
    this.onNote?.(`QUEUED ${added} SPLIT${added === 1 ? '' : 'S'}${this.running ? ' — after the one running' : ''}${made ? ` (${made} already made)` : ''}`);
    void this.drain();
  }
  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.pending.length) {
        if (this.running) { await new Promise(r => setTimeout(r, 150)); continue; }
        const j = this.pending.shift()!;
        this.queueInfo = { n: (this.queueInfo?.n ?? 0) + 1, total: Math.max(this.queueInfo?.total ?? 1, (this.queueInfo?.n ?? 0) + 1 + this.pending.length) };
        await this.start(j.quality, 'all', j.span, j.target);
      }
    } finally {
      this.draining = false;
      this.queueInfo = null;
      this.set(this.state.phase, this.state.pct, this.state.error);
    }
  }
  /** Splits still waiting behind the running one. */
  queuedCount(): number { return this.pending.length; }

  isRunning(): boolean { return this.running; }
  /** The target a running split is about (null when idle). */
  runningTarget(): StemsTarget | null { return this.running ? this.target : null; }
  private sameTarget(a: StemsTarget, b: StemsTarget): boolean { return a.kind === b.kind && (a.kind === 'main' || a.buffer === (b as { buffer: AudioBuffer }).buffer); }
  /** The one place the two kinds differ: which buffer, which engine calls. */
  private io(t: StemsTarget) {
    const e = this.engine;
    if (t.kind === 'main') return {
      buf: () => e.sourceBuffer,
      meta: () => e.stemsMeta(),
      install: (st: Record<StemName, AudioBuffer> | null, meta?: { quality: 'fast' | 'fine'; assets: Partial<Record<StemName, string>> }, ranges?: Array<[number, number]>) => e.setStemBuffers(st, meta, ranges),
      addRange: (a: number, b: number) => e.addStemReadyRange(a, b),
      title: () => e.trackTitle || 'sample',
      has: () => e.hasStems(),
    };
    const buf = t.buffer;
    return {
      buf: () => (e.padsOnSource(buf).length ? buf : null), // gone from the kit = no target
      meta: () => e.sourceStemsMeta(buf),
      install: (st: Record<StemName, AudioBuffer> | null, meta?: { quality: 'fast' | 'fine'; assets: Partial<Record<StemName, string>> }, ranges?: Array<[number, number]>) => e.setSourceStemBuffers(buf, st, meta, ranges),
      addRange: (a: number, b: number) => e.addSourceStemReadyRange(buf, a, b),
      title: () => { const i = e.padsOnSource(buf)[0]; return (i !== undefined ? e.getPadBuffer(i)?.title : undefined) || 'sample'; },
      has: () => e.hasSourceStems(buf),
    };
  }
  /** The target a pad's stems are about (main chop → main; own sample → its source). */
  targetForPad(padIdx: number): StemsTarget | null {
    const k = this.engine.stemTargetKind(padIdx);
    if (k === 'main') return MAIN_TARGET;
    if (k === 'source') { const b = this.engine.padSourceBuffer(padIdx); return b ? { kind: 'source', buffer: b } : null; }
    return null;
  }
  hasStemsFor(t: StemsTarget): boolean { return this.io(t).has(); }

  /** The chop windows a scope means. 'all' = every main-track chop with the
   *  focused pad's first; a pad list = just those pads' chops (deduped). */
  private windowsFor(scope: number[] | 'all', target: StemsTarget = MAIN_TARGET): Span[] {
    if (target.kind === 'source') {
      // A pad source: every pad playing from that buffer, its trim = its window
      // (source time — pad sources have no trims); the focused pad first.
      const all = this.engine.padsOnSource(target.buffer);
      const padIdxs = scope === 'all' ? all : scope.filter(i => all.includes(i));
      const focused = this.engine.focusedPad();
      const ordered = focused !== null && padIdxs.includes(focused) ? [focused, ...padIdxs.filter(i => i !== focused)] : padIdxs;
      const out: Span[] = []; const seen = new Set<string>();
      for (const i of ordered) {
        const pb = this.engine.getPadBuffer(i); if (!pb) continue;
        const k = `${pb.start}:${pb.end}`; if (seen.has(k)) continue; seen.add(k);
        out.push({ startSec: pb.start, endSec: pb.end });
      }
      return out;
    }
    const st = this.engine.getState();
    const chopSpan = new Map<number, Span>();
    // chops live in the TRIMMED timeline; the worker wants the original's
    for (const c of st.chops) chopSpan.set(c.id, { startSec: this.engine.effToFile(c.start), endSec: this.engine.effToFile(c.end, true) });
    const padIdxs = scope === 'all' ? st.pads.map(p => p.index) : scope;
    const focused = this.engine.focusedPad();
    const ordered = scope === 'all' && focused !== null
      ? [focused, ...padIdxs.filter(i => i !== focused)]
      : padIdxs;
    const seen = new Set<number>();
    const out: Span[] = [];
    for (const i of ordered) {
      const chopId = st.pads[i]?.chopId;
      if (chopId == null || seen.has(chopId)) continue;
      const span = chopSpan.get(chopId);
      if (!span) continue;
      seen.add(chopId);
      out.push(span);
    }
    return out;
  }

  /** Kick a split. Selection scope → only those windows (no sweep). Keeps and
   *  EXTENDS existing stems at the same quality; a quality change starts the
   *  audio over (mixing FAST and FINE spans in one buffer would be a lie). */
  async start(quality: StemsQuality, scope: number[] | 'all', viewSpan?: Span, target: StemsTarget = MAIN_TARGET): Promise<void> {
    const b = bridge();
    const io = this.io(target);
    const buf = io.buf();
    if (!b?.stemsSplit || !buf) return;
    if (this.running) {
      // Not a refusal any more: it goes in line behind the running split.
      if (viewSpan && !this.sameTarget(this.target, target)) { this.startMany(quality, [{ target, span: viewSpan }]); return; }
      this.onNote?.('A SPLIT IS ALREADY RUNNING on this sample');
      return;
    }
    rememberQuality(quality);
    this.target = target;
    const meta = io.meta();
    if (this.stems && this.forBuffer === buf && meta && this.quality !== quality) {
      // quality changed — the old spans are the other engine's audio
      io.install(null);
      this.stems = null;
    }
    this.quality = quality;
    // Already split this exact audio at this quality? Take it off the shelf.
    // Everything the scope asked for may already be ready — then there is
    // nothing to run at all.
    if (!this.stems || this.forBuffer !== buf) {
      const key = await this.keyOf(buf);
      const entry = key ? await bridge()?.stemsCacheGet?.(key, quality).catch(() => null) : null;
      if (entry && entry.quality === quality && io.buf() === buf) await this.installEntry(key, entry, target);
    }
    // THE STEMS BUTTON ('all') splits the WHOLE song top to bottom, in order —
    // his rule 2026-08-22: "when I hit STEMS it should just stem the whole
    // song, ignoring the chops" — so the percentage is simply how far through
    // the song the engine is, and every chop lights as its stretch lands. A
    // pad list (pad menu / a fresh chop) still targets just those windows.
    const wholeSong = scope === 'all' && viewSpan ? [viewSpan] : null;
    if (this.stems && this.forBuffer === buf) {
      const want = wholeSong ?? this.windowsFor(scope, target);
      const ranges = io.meta()?.readyRanges ?? [];
      if (want.length && want.every(w => spanReady(ranges, w.startSec, w.endSec))) {
        this.set('idle', 100);
        this.onNote?.('STEMS ALREADY MADE — nothing to split');
        return;
      }
    }
    if (!this.stems || this.forBuffer !== buf) {
      const mk = (): AudioBuffer => this.engine.ctx.createBuffer(Math.min(2, buf.numberOfChannels), buf.length, buf.sampleRate);
      this.stems = { drums: mk(), bass: mk(), other: mk(), vocals: mk() };
      this.forBuffer = buf;
      io.install(this.stems, { quality, assets: {} }, []);
    }
    const windows = wholeSong ?? this.windowsFor(scope, target);
    if (!windows.length && viewSpan) windows.push(viewSpan);

    const sr = buf.sampleRate;
    // NATIVE: the shell already holds this audio (the engine shadow uploaded it to play the pads) — hand over
    // its store key instead of a copy of every sample. A key that cannot be resolved falls back to the PCM path.
    const nativeKey = b.stemsNative ? await nativeEngineShadow()?.stemsKeyFor(buf).catch(() => null) : null;
    const L = nativeKey ? null : buf.getChannelData(0);
    const R = nativeKey ? null : (buf.numberOfChannels > 1 ? buf.getChannelData(1) : L!);
    this.running = true;
    this.set('models', 0);
    // ORDER TRAP (caught by test:stems-e2e): the invoke's resolution races the
    // tail 'stems:chunk' events — they sit in the message queue while the
    // resolved promise's microtasks run, so finalizing on resolution wrote
    // assets MISSING the last spans. The event channel is ordered (chunks,
    // then done), so completion is the DONE EVENT, never the invoke result.
    let signalDone!: () => void;
    const doneEvent = new Promise<void>(r => { signalDone = r; });
    this.listen(sr, signalDone, target);
    const res = await b.stemsSplit({
      ...(nativeKey
        ? { key: nativeKey }
        : {
            pcmL: (L!.buffer as ArrayBuffer).slice(L!.byteOffset, L!.byteOffset + L!.byteLength),
            pcmR: (R!.buffer as ArrayBuffer).slice(R!.byteOffset, R!.byteOffset + R!.byteLength),
          }),
      // The worker's model is 44.1k; tell it what rate this audio actually is
      // (a Mac's AudioContext usually runs 48k) so it resamples both ways and
      // the chunks come back in OUR frames.
      srcRate: sr,
      quality,
      windows,
      sweep: scope === 'all',
    });
    if (res?.ok) await doneEvent; // every chunk precedes done on the wire
    this.unlisten();
    this.running = false;
    if (!res?.ok) {
      const cancelled = res?.error === 'cancelled';
      this.set('idle', 0, cancelled ? null : (res?.error ?? 'split failed'));
      // keep whatever spans landed — persist them so a save survives
      if (io.meta()?.readyRanges.length) await this.finalize(target);
      return;
    }
    await this.finalize(target);
    this.set('idle', 100);
  }

  /** Split-on-demand for ONE pad (pad menu, or a new chop cut while stems
   *  exist): queue into the live run, or start a scoped one. */
  async ensureChopSplit(padIdx: number): Promise<void> {
    const target = this.targetForPad(padIdx);
    if (!target || !this.io(target).has()) return;
    let f0: number, f1: number;
    if (target.kind === 'source') {
      const pb = this.engine.getPadBuffer(padIdx); if (!pb) return;
      f0 = pb.start; f1 = pb.end;
    } else {
      const st = this.engine.getState();
      const chopId = st.pads[padIdx]?.chopId;
      const chop = chopId != null ? st.chops.find(c => c.id === chopId) : undefined;
      if (!chop) return;
      f0 = this.engine.effToFile(chop.start); f1 = this.engine.effToFile(chop.end, true); // original's time
    }
    const ranges = this.io(target).meta()?.readyRanges ?? [];
    if (spanReady(ranges, f0, f1)) return;
    if (this.running) { if (this.sameTarget(this.target, target)) void bridge()?.stemsQueueWindow?.({ startSec: f0, endSec: f1 }); return; }
    await this.start(this.quality, [padIdx], undefined, target);
  }

  async cancel(): Promise<void> {
    // STOP = the running one AND everything in line.
    this.pending = []; this.queueInfo = null;
    await bridge()?.stemsCancel?.();
  }

  /** Drop the stems: buffers gone, every pad back to the ORIGINAL. The asset
   *  files stay on disk (cheap; re-split writes fresh ones). */
  removeStems(target: StemsTarget = MAIN_TARGET): void {
    if (this.running && this.sameTarget(this.target, target)) void this.cancel();
    const st = this.engine.getState();
    const mine = target.kind === 'main'
      ? st.pads.filter(p => p.stems !== undefined && this.engine.stemTargetKind(p.index) === 'main').map(p => p.index)
      : this.engine.padsOnSource(target.buffer).filter(i => st.pads[i]?.stems !== undefined);
    if (mine.length) this.engine.setPadsStems(mine, MASK_ALL);
    this.io(target).install(null);
    if (this.forBuffer === this.io(target).buf() || (target.kind === 'source' && this.forBuffer === target.buffer)) { this.stems = null; this.forBuffer = null; }
    this.set('idle', 0);
  }

  /** A buffer's content key (cached per buffer — hashing is ~10ms). */
  private async keyOf(buf: AudioBuffer | null): Promise<string> {
    if (!buf) return '';
    const hit = this.keys.get(buf);
    if (hit) return hit;
    const key = await audioKey(buf);
    this.keys.set(buf, key);
    return key;
  }

  /** Decode a cache entry's four stems into this track. Any missing asset (he
   *  deleted them in FOLDERS, or the store moved) drops the entry — a stale
   *  shortcut is a miss, never the wrong audio. */
  /** Fetch + decode the four stems of a cache entry. Shared by the eager and
   *  the LAZY install paths. Returns null (and drops the entry) if an asset is
   *  gone or the audio doesn't match the track any more. */
  private async decodeEntry(key: string, entry: CacheEntry, buf: AudioBuffer): Promise<Record<StemName, AudioBuffer> | null> {
    const decoded: Partial<Record<StemName, AudioBuffer>> = {};
    // All four at once — the decoder runs off-thread, so four FLACs come back
    // in about the time of one (a 3-minute song's stems in ~a second).
    // decodeAudio copies the bytes itself (decodeAudioData detaches its
    // input), so no slice here; and once decoded the session copy of the
    // file is dead weight — release it (the device store keeps the file).
    try {
      await Promise.all(STEM_ORDER.map(async name => {
        const id = entry.assets[name];
        const a = id ? await assetStore.get(assetHash(id)) : null;
        if (!a) throw new Error('missing');
        decoded[name] = await this.engine.decodeAudio(a.data);
        assetStore.release(a.hash);
      }));
    } catch { void bridge()?.stemsCacheDrop?.(key, entry.quality); return null; }
    const first = decoded.drums!;
    if (first.sampleRate !== buf.sampleRate || Math.abs(first.length - buf.length) > 64) {
      void bridge()?.stemsCacheDrop?.(key, entry.quality);
      return null;
    }
    return decoded as Record<StemName, AudioBuffer>;
  }

  /** LAZY install (main track): register the split as KNOWN without decoding a
   *  byte. Opening a project with saved stems used to spend ~1 s decoding four
   *  FLACs and then hold ~140 MB of AudioBuffers even if the stems were never
   *  touched. The chips light exactly as before; the audio is decoded the first
   *  time a pad actually asks for a masked slice (engine.ensureStemsDecoded). */
  private installEntryLazy(key: string, entry: CacheEntry, buf: AudioBuffer): void {
    const assets: Partial<Record<StemName, string>> = {};
    for (const name of STEM_ORDER) assets[name] = entry.assets[name];
    this.quality = entry.quality;
    this.forBuffer = buf;
    this.target = MAIN_TARGET;
    this.engine.setStemsPending({ quality: entry.quality, assets }, entry.readyRanges, async () => {
      if (this.engine.sourceBuffer !== buf) return null;   // track changed since
      const decoded = await this.decodeEntry(key, entry, buf);
      if (decoded && !this.running) this.stems = decoded;   // the controller's own handle
      return decoded;
    });
    this.set('idle', 0);
  }

  private async installEntry(key: string, entry: CacheEntry, target: StemsTarget = MAIN_TARGET): Promise<boolean> {
    const io = this.io(target);
    const buf = io.buf();
    if (!buf) return false;
    this.set('load', 0);
    const decoded = await this.decodeEntry(key, entry, buf);
    if (!decoded) { this.set('idle', 0); return false; }
    if (io.buf() !== buf) { this.set('idle', 0); return false; } // target changed mid-decode
    const assets: Partial<Record<StemName, string>> = {};
    for (const name of STEM_ORDER) assets[name] = entry.assets[name];
    if (target.kind === 'main' || !this.running) { this.stems = decoded; this.forBuffer = buf; this.target = target; this.quality = entry.quality; }
    io.install(decoded, { quality: entry.quality, assets }, entry.readyRanges);
    this.set('idle', 0);
    return true;
  }

  /** A track just loaded: if this machine already split THIS audio, put the
   *  stems straight back — no worker, no models, no wait (his ask: a song is
   *  split once, ever). Returns true when stems came back. */
  async tryCache(target: StemsTarget = MAIN_TARGET): Promise<boolean> {
    const b = bridge();
    const io = this.io(target);
    const buf = io.buf();
    if (!b?.stemsCacheGet || !buf || this.running || this.restoring || io.has()) return false;
    const key = await this.keyOf(buf);
    if (!key || io.buf() !== buf) return false;
    const entry = await b.stemsCacheGet(key, this.quality).catch(() => null);
    if (!entry || io.buf() !== buf) return false;
    // MAIN track → LAZY: the split is registered instantly and its four FLACs
    // are decoded the first time a pad asks for a masked slice. Per-SOURCE
    // stems stay eager (small, and installed while the pad is being set up).
    if (target.kind === 'main') {
      this.installEntryLazy(key, entry, buf);
      this.onNote?.(`STEMS RESTORED — ${entry.quality.toUpperCase()} split already on this machine`);
      return true;
    }
    const okNow = await this.installEntry(key, entry, target);
    if (okNow) this.onNote?.(`STEMS RESTORED — ${entry.quality.toUpperCase()} split already on this machine${target.kind === 'source' ? ` (${io.title()})` : ''}`);
    return okNow;
  }
  /** A pad's own sample just landed: if this machine already split THAT audio,
   *  its stems come straight back (the per-source twin of tryCache). */
  async tryCacheSource(buf: AudioBuffer): Promise<boolean> { return this.tryCache({ kind: 'source', buffer: buf }); }

  /** Remember this split for every future project that loads the same audio. */
  private async saveToCache(target: StemsTarget = MAIN_TARGET): Promise<void> {
    const b = bridge();
    const io = this.io(target);
    const meta = io.meta();
    const buf = io.buf();
    if (!b?.stemsCachePut || !meta || !buf) return;
    const assets = meta.assets;
    if (!STEM_ORDER.every(n => typeof assets[n] === 'string' && assets[n])) return;
    const key = await this.keyOf(buf);
    if (!key) return;
    await b.stemsCachePut(key, {
      quality: meta.quality,
      assets: Object.fromEntries(STEM_ORDER.map(n => [n, assets[n] as string])),
      readyRanges: meta.readyRanges.map(r => [r[0], r[1]] as [number, number]),
      sampleRate: buf.sampleRate,
      frames: buf.length,
      title: io.title().slice(0, 120),
      savedAt: Date.now(),
    }).catch(() => ({ ok: false }));
  }

  /** Project load: bring the stem audio back from the asset store. The engine
   *  already holds meta + readyRanges (loadPreset); missing assets = masks
   *  kept, originals play, the button shows re-split. */
  async restore(preset: ChopPreset): Promise<void> {
    const meta = preset.stems;
    const buf = this.engine.sourceBuffer;
    if (!meta?.assets || !buf) return;
    this.restoring = true;
    try {
      await this.restoreInner(meta, buf, MAIN_TARGET);
    } finally { this.restoring = false; }
  }
  /** Project load, one pad source: its stems back from the asset store. */
  async restoreSource(buf: AudioBuffer, meta: NonNullable<ChopPreset['stems']> | undefined): Promise<void> {
    if (!meta?.assets) return;
    await this.restoreInner(meta, buf, { kind: 'source', buffer: buf });
  }
  private async restoreInner(meta: NonNullable<ChopPreset['stems']>, buf: AudioBuffer, target: StemsTarget): Promise<void> {
    const io = this.io(target);
    const decoded: Partial<Record<StemName, AudioBuffer>> = {};
    for (const name of STEM_ORDER) {
      const id = meta.assets[name];
      if (!id) return;
      const a = await assetStore.get(assetHash(id));
      if (!a) return; // any missing stem = needs-resplit state (the global cache may still have it)
      try { decoded[name] = await this.engine.decodeAudio(a.data); } catch { return; } // decodeAudio copies
      assetStore.release(a.hash); // the decoded AudioBuffer is the working copy now
    }
    if (io.buf() !== buf) return; // target changed while decoding
    if (!this.running) { this.stems = decoded as Record<StemName, AudioBuffer>; this.forBuffer = buf; this.target = target; this.quality = meta.quality === 'fine' ? 'fine' : 'fast'; }
    io.install(decoded as Record<StemName, AudioBuffer>, { quality: meta.quality === 'fine' ? 'fine' : 'fast', assets: { ...meta.assets } }, meta.readyRanges);
    this.onState?.(this.state);
    void this.saveToCache(target); // a project's stems seed the machine-wide cache
  }

  /** A real split-progress tick: update the rate estimate, never regress the
   *  shown pct (queueWindow mid-run grows the denominator — honest, but the
   *  display holds instead of dropping). */
  private onSplitPct(real: number, total?: number): void {
    const now = Date.now();
    if (total && total > 0 && real === 0) {
      // the engine's 'ready': seed the creep from last run's measured rate
      seedSplitSm(this.sm, total, lastMsPerChunk(this.quality), now);
      this.set('split', this.sm.shown);
      return;
    }
    this.set('split', tickSplitSm(this.sm, real, now));
  }

  private listen(sr: number, onDone: () => void, target: StemsTarget = MAIN_TARGET): void {
    const b = bridge();
    if (!b) return;
    const io = this.io(target);
    this.sm = freshSplitSm();
    this.smTimer = setInterval(() => {
      if (this.state.phase !== 'split') return;
      const next = creepSplitSm(this.sm, Date.now());
      if (next !== null) this.set('split', next);
    }, 400);
    this.unsubs = [
      b.onStemsProgress?.(p => p.phase === 'split' ? this.onSplitPct(p.pct, p.total) : this.set(p.phase, p.pct)) ?? (() => {}),
      b.onStemsChunk?.(c => {
        const stems = this.stems;
        if (!stems) return;
        // plane order [drumsL,drumsR,bassL,bassR,otherL,otherR,vocalsL,vocalsR]
        STEM_ORDER.forEach((name, s) => {
          const buf = stems[name];
          buf.copyToChannel(c.stems[s * 2] as Float32Array<ArrayBuffer>, 0, c.startFrame);
          if (buf.numberOfChannels > 1) buf.copyToChannel(c.stems[s * 2 + 1] as Float32Array<ArrayBuffer>, 1, c.startFrame);
        });
        io.addRange(c.startFrame / sr, c.endFrame / sr);
      }) ?? (() => {}),
      b.onStemsDone?.(onDone) ?? (() => {}),
      b.onStemsError?.(() => onDone()) ?? (() => {}), // error also ends the event stream
    ].filter(Boolean);
  }
  private unlisten(): void {
    for (const u of this.unsubs) u();
    this.unsubs = [];
    if (this.smTimer) { clearInterval(this.smTimer); this.smTimer = null; }
    if (this.sm.msPerChunk > 0) rememberMsPerChunk(this.quality, blendMsPerChunk(lastMsPerChunk(this.quality), this.sm.msPerChunk));
  }

  /** Queue drained (or cancelled with spans landed): write the stems into the
   *  asset store and stamp the engine meta so SAVE PROJECT carries them. */
  private async finalize(target: StemsTarget = MAIN_TARGET): Promise<void> {
    const stems = this.stems;
    if (!stems) return;
    const io = this.io(target);
    this.set('saving', 100);
    const title = io.title().slice(0, 60);
    const assets: Partial<Record<StemName, string>> = {};
    // Lossless FLAC, 16-bit — the SAME samples the old .stems.wav held (one
    // quantiser, gated sample-exact), at roughly half the bytes for a mix and
    // far less for a sparse stem. Older .stems.wav assets keep decoding.
    // Four workers at once (one per stem) — a 3-minute song saves in ~3 s
    // instead of ~12. Playback never waits on this: the stems were installed
    // live at split start; this stamps the asset ids + the global cache.
    const encoded = await Promise.all(STEM_ORDER.map(name => encodeFlac16(stems[name])));
    for (let i = 0; i < STEM_ORDER.length; i++) {
      const name = STEM_ORDER[i];
      assets[name] = await assetStore.put(encoded[i].buffer as ArrayBuffer, `${title} — ${name.toUpperCase()}.stems.flac`);
    }
    io.install(stems, { quality: this.quality, assets });
    await this.saveToCache(target);
  }
}
