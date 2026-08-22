import { useRef, useState, useEffect, useMemo, useCallback, PointerEvent as ReactPointerEvent } from 'react';

/**
 * SAMPLE BROWSER — Phase 5 (Winamp-style interactive sample browser).
 * ------------------------------------------------------------------
 * A modal that replaces the old "⇄ SWAP" button. Browse the R2 sample
 * library as a folder tree (playlist → track), preview any track, then LOAD it
 * into the chopper.
 *
 * Blob-URL preview (no decoded PCM):
 *  - Plays each sample through a SINGLE shared <audio> element routed into Web
 *    Audio (MediaElementAudioSourceNode → gain → analyser → destination). The
 *    compressed MP3 bytes are fetch()ed and wrapped in a same-origin Blob URL
 *    (R2's CORS blocks a cross-origin <audio crossOrigin> request, but fetch()
 *    is allowed) — so there is NO decoded AudioBuffer in memory (~5–10MB
 *    compressed vs ~70MB PCM); the old decodeAudioData path was the iOS OOM cause.
 *  - The visual stacks on ONE canvas (continuous RAF): a faded MATRIX
 *    digital-rain background + a solid static WAVEFORM (tiny pre-decoded peaks,
 *    no PCM scan per frame) + a phosphor PLAYHEAD. Click/drag the canvas to seek
 *    ANY position in the full song (audio.currentTime).
 *  - The audio graph (ctx/gain/analyser/element/media-source) is a MODULE-LEVEL
 *    singleton: createMediaElementSource throws if called twice on an element,
 *    and reusing one suspended context avoids accumulating AudioContexts across
 *    BROWSE open/close cycles (the other half of the iOS crash). The analyser
 *    stays wired for routing but no longer drives a visual.
 *  - rAF render reads refs only (no setState per frame) per the project's
 *    animation rule; the mm:ss readout is written via a ref; the rain steps once
 *    per frame and rain/waveform/playhead are painted in drawSpectrum.
 *
 * LOAD is delegated to the host (onLoad) which runs the canonical
 * loadTrackById path (subscription gate + IndexedDB cache + preset restore).
 */

import LibraryTree, { LAST_LOADED_LS } from './LibraryTree';
import type { LibraryBridge } from './libraryBridge';

export interface BrowserEntry { id: string; title: string; duration?: number }
export interface BrowserPlaylist { name: string; entries: BrowserEntry[] }

interface Props {
  playlists: BrowserPlaylist[];
  /** Playlist to auto-expand on open (the one selected in the toolbar). */
  initialPlaylist?: string;
  isPhone?: boolean;
  /** The Sample Library bridge (Electron only): RECORDINGS / YOUTUBE / IMPORTS /
   *  USER SAMPLES (a real, editable folder) / your folders / linked folders
   *  live in the tree under TERMINATOR. */
  library?: LibraryBridge;
  /** Resolve a sample id → public streaming URL for the <audio> element.
   *  SYNCHRONOUS (the manifest is already indexed when this UI is open) so the
   *  resulting `audio.play()` runs inside the user's click gesture — iOS rejects
   *  a play() that comes after an await. The optional `title` lets the resolver
   *  fall back to a title match when the id misses (the desktop case: local
   *  playlists are keyed by YouTube id, not the R2 manifest's Drive id). Returns
   *  null if unresolvable. */
  resolveAudioUrl: (id: string, title?: string) => string | null;
  /** Electron-only: ensure the R2 audio manifest is loaded so resolveAudioUrl
   *  can resolve ids. On web the manifest is already indexed by the time the
   *  browser is open (listing the playlists loads it), so the host leaves this
   *  undefined and the preview path is unchanged. In Electron the playlists come
   *  over IPC (main process) and never touch the renderer's manifest, so a slow
   *  background prime can leave trackById empty when the user clicks — this lets
   *  the browser (re)load the manifest on demand and retry the URL resolution. */
  ensureAudioReady?: () => Promise<void>;
  /** DEMO (the site's download-page embed): called before every preview.
   *  Return false to refuse it (the host counts listens against the demo's
   *  10-sample allowance and opens the purchase popup). */
  previewGate?: () => boolean;
  /** sampleId → saved-preset name. Rows with a preset get a ★; the selected one
   *  shows a LOAD PRESET button. Empty/undefined when signed-out or none saved. */
  presetIndex?: Record<string, string>;
  /** Load the chosen track into the chopper (host gates the pull + closes).
   *  `playlistName` is the R2 curated playlist the entry belongs to, or ''
   *  for user-content / unresolved entries. */
  onLoad: (entry: BrowserEntry, playlistName: string) => void;
  /** Load the chosen track AND restore its saved chops/sequences. */
  onLoadPreset?: (entry: BrowserEntry) => void;
  /** Load the chosen track onto the NEXT EMPTY PAD as its own source — the
   *  browser stays open so several samples can be stacked onto pads. */
  onLoadToPad?: (entry: BrowserEntry, playlistName: string) => void;
  onClose: () => void;
}

const fmtTime = (sec?: number): string => {
  if (sec == null || !isFinite(sec) || sec < 0) return '--:--';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
};

// Preview pitch readout, e.g. "±0 st", "−2 st", "+5 st".
const fmtPitch = (st: number): string =>
  st === 0 ? '±0 st' : `${st > 0 ? '+' : '−'}${Math.abs(st)} st`;

// Compact file size for the USER SAMPLES rows.
const fmtBytes = (n: number): string => {
  if (!isFinite(n) || n <= 0) return '0 KB';
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(n / 1024))} KB`;
};

// Disable time-stretch so playbackRate pitch-shifts the preview (matches the
// old buffer-source varispeed). Vendor flags cover older Safari/Firefox.
function applyPreservesPitch(audio: HTMLAudioElement): void {
  try {
    (audio as any).preservesPitch = false;
    (audio as any).webkitPreservesPitch = false;
    (audio as any).mozPreservesPitch = false;
  } catch { /* */ }
}

// Waveform peaks: min/max per column, computed ONCE per sample from a TRANSIENT
// decode (the decoded PCM is dropped immediately — only the ~4KB of peaks are
// kept). PEAK_COLS columns ≈ canvas width; cache the most-recent PEAK_CACHE_MAX.
type WavePeaks = { min: Float32Array; max: Float32Array };
const PEAK_COLS = 512;
const PEAK_CACHE_MAX = 10;

function computePeaksFixed(buf: AudioBuffer, cols: number): WavePeaks {
  const ch0 = buf.getChannelData(0);
  const ch1 = buf.numberOfChannels > 1 ? buf.getChannelData(1) : ch0;
  const min = new Float32Array(cols);
  const max = new Float32Array(cols);
  const per = buf.length / cols;
  for (let c = 0; c < cols; c++) {
    const start = Math.floor(c * per);
    const end = Math.min(buf.length, Math.floor((c + 1) * per));
    let lo = 0, hi = 0;
    for (let i = start; i < end; i++) {
      const s = (ch0[i] + ch1[i]) * 0.5;
      if (s < lo) lo = s;
      if (s > hi) hi = s;
    }
    min[c] = lo; max[c] = hi;
  }
  return { min, max };
}

// ── Matrix digital rain (background visual) ──────────────────────────────────
// Module-level so the rain keeps scrolling across mount/unmount (rotation /
// reopen don't reset it mid-fall).
const MATRIX_CHARS =
  'ｦｧｨｩｪｫｬｭｮｯｰｱｲｳｴｵｶｷｸｹｺｻｼｽｾｿﾀﾁﾂﾃﾄﾅﾆﾇﾈﾉﾊﾋﾌﾍﾎﾏﾐﾑﾒﾓﾔﾕﾖﾗﾘﾙﾚﾛﾜﾝ' +
  '0123456789ABCDEFZ$+-*/=<>[]{}#%@';
// Precompute trail colours (lightness 0–60%) → the per-frame draw allocates no strings.
const MATRIX_TRAIL_COLORS = Array.from({ length: 61 }, (_, l) => `hsl(140, 100%, ${l}%)`);
const MATRIX_FONT_PX = 11;

interface RainColumn {
  x: number;        // pixel x position
  y: number;        // head row (float, advances by speed each frame)
  speed: number;    // rows per frame
  length: number;   // trail length in chars
  chars: string[];  // current trail characters (mutated in place — no per-frame alloc)
  timer: number;    // delay before this column activates (frames)
}
let _rainCols: RainColumn[] = [];
let _rainCanvasW = 0;
let _rainCanvasH = 0;

function initRain(w: number, h: number, fontSize: number): void {
  // Re-init only when the canvas size changed meaningfully (or never built yet).
  if (_rainCols.length > 0 && Math.abs(w - _rainCanvasW) < 2 && Math.abs(h - _rainCanvasH) < 2) return;
  _rainCanvasW = w;
  _rainCanvasH = h;
  const colCount = Math.max(1, Math.floor(w / fontSize));
  _rainCols = Array.from({ length: colCount }, (_, i) => ({
    x: i * fontSize,
    y: -(Math.random() * 20),          // start above the canvas
    speed: 0.3 + Math.random() * 0.7,  // slow–medium scroll
    length: 6 + Math.floor(Math.random() * 10),
    chars: Array.from({ length: 16 }, () => MATRIX_CHARS[Math.floor(Math.random() * MATRIX_CHARS.length)]),
    timer: Math.floor(Math.random() * 80),
  }));
}

// Advance the rain one frame (mutates in place — zero allocation). Called ONCE
// per RAF frame so manual repaints (seek/peaks) don't double its speed.
function stepRain(): void {
  if (_rainCols.length === 0) return;
  for (const col of _rainCols) {
    if (col.timer > 0) { col.timer--; continue; }
    col.y += col.speed;
    const mutIdx = Math.floor(Math.random() * col.chars.length); // flicker one char
    col.chars[mutIdx] = MATRIX_CHARS[Math.floor(Math.random() * MATRIX_CHARS.length)];
    if (col.y * MATRIX_FONT_PX > _rainCanvasH + col.length * MATRIX_FONT_PX) {
      col.y = -(Math.random() * 10);
      col.speed = 0.3 + Math.random() * 0.7;
      col.length = 6 + Math.floor(Math.random() * 10);
      col.timer = Math.floor(Math.random() * 60);
    }
  }
}

// Render the current rain state (no stepping here). Bright head + fading trail.
function drawMatrixRain(canvas: HTMLCanvasElement, ctx: CanvasRenderingContext2D): void {
  initRain(canvas.width, canvas.height, MATRIX_FONT_PX);
  ctx.font = `bold ${MATRIX_FONT_PX}px "DM Mono", monospace`;
  ctx.textBaseline = 'top';
  for (const col of _rainCols) {
    if (col.timer > 0) continue;
    const headRow = Math.floor(col.y);
    for (let t = 0; t < col.length; t++) {
      const row = headRow - t;
      if (row < 0) continue;
      const py = row * MATRIX_FONT_PX;
      if (py > canvas.height) continue; // char below the canvas — skip (trail above may still show)
      const ch = col.chars[t % col.chars.length];
      if (t === 0) {
        ctx.fillStyle = '#ccffcc';       // bright head
        ctx.shadowColor = '#35ff69';
        ctx.shadowBlur = 8;
      } else {
        const fade = 1 - t / col.length;
        ctx.fillStyle = MATRIX_TRAIL_COLORS[Math.floor(15 + fade * 45)]; // 15%–60%
        ctx.shadowBlur = 0;
      }
      ctx.fillText(ch, col.x, py);
    }
  }
  ctx.shadowBlur = 0; // reset after drawing
}

// Module-level singleton preview audio graph — survives component unmount so iOS
// Safari doesn't accumulate AudioContexts across BROWSE open/close cycles, and
// the <audio> element + media-element source are created ONCE (a 2nd
// createMediaElementSource on the same element throws InvalidStateError). The
// graph (element → gain → analyser → destination) is wired once; mounts re-use
// it and only suspend()/resume() the hardware tap.
let _previewCtx: AudioContext | null = null;
let _previewGain: GainNode | null = null;
let _previewAnalyser: AnalyserNode | null = null;
let _previewAudioEl: HTMLAudioElement | null = null;
let _previewMediaSrc: MediaElementAudioSourceNode | null = null;

// Snapshot of the in-flight preview, saved on unmount so a phone ROTATION
// (HardwareView swaps its portrait↔landscape branches → unmount + remount) resumes
// the same sample at the same position instead of dropping it. Module-level so it
// survives the unmount; consumed exactly once on the next mount. Streaming is a
// direct Worker URL (no blob), so the URL + position + entry is all we need.
interface PreviewSnapshot {
  url: string;
  currentTime: number;
  wasPlaying: boolean;
  selKey: string;     // `${plName}::${id}` — re-highlights the exact row
  entryId: string;
  entryTitle: string;
  peaks: WavePeaks | null;
}
let _previewSnapshot: PreviewSnapshot | null = null;

function getPreviewGraph(): { ctx: AudioContext; gain: GainNode; analyser: AnalyserNode; audio: HTMLAudioElement } {
  if (!_previewCtx || _previewCtx.state === 'closed') {
    _previewCtx = new AudioContext();
    _previewGain = _previewCtx.createGain();
    _previewAnalyser = _previewCtx.createAnalyser();
    _previewAnalyser.fftSize = 512;            // 256 bins — dense enough for a full-width log spectrum
    _previewAnalyser.smoothingTimeConstant = 0.8;
    _previewGain.connect(_previewAnalyser);
    _previewAnalyser.connect(_previewCtx.destination);
  }
  if (!_previewAudioEl) {
    _previewAudioEl = new Audio();
    _previewAudioEl.crossOrigin = 'anonymous'; // REQUIRED before any src so the analyser can read the cross-origin R2 stream
    _previewAudioEl.preload = 'auto';
    _previewMediaSrc = _previewCtx!.createMediaElementSource(_previewAudioEl);
    _previewMediaSrc.connect(_previewGain!); // element → gain → analyser → destination
  }
  return { ctx: _previewCtx, gain: _previewGain!, analyser: _previewAnalyser!, audio: _previewAudioEl };
}

export default function SampleBrowser({ playlists, initialPlaylist, isPhone, library, resolveAudioUrl, ensureAudioReady, previewGate, presetIndex, onLoad, onLoadPreset, onLoadToPad, onClose }: Props) {
  // ── Tree state ─────────────────────────────────────────────────────────
  const [selKey, setSelKey] = useState<string | null>(null); // `${plName}::${id}`
  const [selectedEntry, setSelectedEntry] = useState<BrowserEntry | null>(null);
  const [query, setQuery] = useState('');
  // The tree publishes its visible items (in order) for ↑/↓ navigation.
  const [flatVisible, setFlatVisible] = useState<Array<{ plName: string; entry: BrowserEntry }>>([]);
  const onVisibleItems = useCallback((items: Array<{ plName: string; entry: BrowserEntry }>) => setFlatVisible(items), []);

  // ── Preview / transport state (React = infrequent updates only) ─────────
  const [isPlaying, setIsPlaying] = useState(false);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(0.85);
  const [loadingPreview, setLoadingPreview] = useState(false);
  const [streamErr, setStreamErr] = useState<string | null>(null);
  const [status, setStatus] = useState('Select a sample to preview');
  // Preview pitch in semitones (−24..+24). Keyboard ←/→ adjust it; it resets to
  // 0 on every new selection and feeds the <audio> playbackRate.
  const [previewPitch, setPreviewPitch] = useState(0);

  // ── Audio refs (no re-render) ───────────────────────────────────────────
  const ctxRef = useRef<AudioContext | null>(null);
  const gainRef = useRef<GainNode | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const unmountedRef = useRef(false); // true after teardown → late callbacks must not touch a dead instance
  const specDataRef = useRef<Uint8Array<ArrayBuffer> | null>(null);
  const spectrumRef = useRef<HTMLCanvasElement>(null); // primary visual (spectral analyzer)
  const playingRef = useRef(false);
  const reqIdRef = useRef(0);       // guards against out-of-order preview switches

  // ── Visual / interaction refs ───────────────────────────────────────────
  const colorsRef = useRef({ wave: '#00ff88', head: '#00ccff', bg: '#050508', dim: '#00ff8855' });
  const rafRef = useRef(0);
  const timeRef = useRef<HTMLSpanElement>(null);
  const draggingRef = useRef(false);   // dragging the playhead across the spectrum to seek
  const pitchRef = useRef(0);          // latest previewPitch (read by play paths — keeps deps stable)
  const selectedElRef = useRef<HTMLDivElement | null>(null); // highlighted row → scrollIntoView
  // Waveform overlay: tiny per-sample peaks (decode → peaks → discard PCM).
  const peaksRef = useRef<WavePeaks | null>(null);                 // peaks for the on-screen sample
  const peaksCacheRef = useRef<Map<string, WavePeaks>>(new Map()); // id → peaks (capped, LRU-ish by insertion)
  const decodeQueueRef = useRef<Promise<void>>(Promise.resolve()); // serialize decodes — one at a time
  // The on-screen sample's identity (refs so the unmount closure reads the latest,
  // not a stale value) — feeds the rotation snapshot.
  const currentSelKeyRef = useRef<string | null>(null);
  const currentEntryIdRef = useRef<string | null>(null);
  const currentEntryTitleRef = useRef<string | null>(null);

  const selected = selectedEntry;

  // ── Colour cache (theme-aware) — read off the spectrum canvas ───────────
  const refreshColors = useCallback(() => {
    const el = spectrumRef.current;
    if (!el) return;
    const cs = getComputedStyle(el);
    const v = (name: string, fb: string) => cs.getPropertyValue(name).trim() || fb;
    colorsRef.current = {
      wave: v('--neon', '#00ff88'),
      head: v('--neon2', '#00ccff'),
      bg: v('--bg', '#050508'),
      dim: v('--neon-dim', '#00ff8855'),
    };
  }, []);

  // ── Composite visual on ONE canvas: MATRIX RAIN behind (faded, always
  //    animating) + solid static WAVEFORM in front + PLAYHEAD on top. The
  //    waveform is the tiny pre-computed peaks (no PCM scan per frame). The rain
  //    is driven by the continuous RAF; reads refs only. ───────────────────────
  const drawSpectrum = useCallback(() => {
    const cv = spectrumRef.current;
    if (!cv) return;
    const g = cv.getContext('2d');
    if (!g) return;
    const W = cv.width, H = cv.height;
    g.clearRect(0, 0, W, H);

    // STEP 2 — Matrix digital rain, FADED, behind (animates every frame,
    // independent of playback — stepping happens once per frame in tick()).
    g.save();
    g.globalAlpha = 0.55;
    drawMatrixRain(cv, g);
    g.restore(); // globalAlpha → 1.0

    // STEP 3 — static waveform, SOLID, in front (once peaks have decoded).
    const peaks = peaksRef.current;
    if (peaks) {
      const { min, max } = peaks;
      const cols = min.length;
      const mid = H / 2;
      g.save();
      g.strokeStyle = '#35ff69';
      g.lineWidth = 1.5;
      g.shadowColor = '#35ff69';
      g.shadowBlur = 4;
      g.beginPath();
      for (let i = 0; i < cols; i++) {
        const x = (i / cols) * W;
        const yMin = mid - min[i] * mid; // min ≤ 0 → below centre
        const yMax = mid - max[i] * mid; // max ≥ 0 → above centre
        g.moveTo(x, yMin);
        g.lineTo(x, yMax);
      }
      g.stroke();
      g.restore();
    }

    // STEP 4 — playhead, ON TOP, in both states.
    const audio = audioRef.current;
    const dur = audio?.duration ?? 0;
    if (audio && dur > 0 && isFinite(dur)) {
      const progress = Math.min(1, Math.max(0, audio.currentTime / dur));
      const x = Math.floor(progress * W);
      g.save();
      g.strokeStyle = '#35ff69';
      g.lineWidth = 2;
      g.shadowColor = '#35ff69';
      g.shadowBlur = 6;
      g.beginPath();
      g.moveTo(x + 0.5, 0);
      g.lineTo(x + 0.5, H);
      g.stroke();
      g.restore();
    }

    // STEP 5 — YouTube-style load bar (final, thin, at the bottom edge): dim =
    // buffered range, bright = playhead position. `audio`/`dur` reused from above.
    if (audio && dur > 0 && isFinite(dur)) {
      const barY = H - 2, barH = 3;
      if (audio.buffered.length > 0) {
        const bufferedEnd = audio.buffered.end(audio.buffered.length - 1);
        const bufferedFrac = Math.min(1, bufferedEnd / dur);
        g.fillStyle = 'rgba(53, 255, 105, 0.25)'; // dim green = buffered amount
        g.fillRect(0, barY, bufferedFrac * W, barH);
      }
      const playFrac = Math.min(1, (audio.currentTime || 0) / dur);
      g.save();
      g.fillStyle = '#35ff69'; // bright phosphor = played
      g.shadowColor = '#35ff69';
      g.shadowBlur = 4;
      g.fillRect(0, barY, playFrac * W, barH);
      g.restore();
    }
  }, []);

  // ── CONTINUOUS rAF — runs from mount to unmount so the Matrix rain scrolls
  //    even when idle/paused. Advances the rain ONE step per frame, then redraws
  //    rain + waveform + playhead, then updates the time readout. ──────────────
  const tick = useCallback(() => {
    stepRain();
    drawSpectrum();
    const audio = audioRef.current;
    if (audio && timeRef.current) timeRef.current.textContent = fmtTime(audio.currentTime || 0);
    rafRef.current = requestAnimationFrame(tick);
  }, [drawSpectrum]);

  const startRaf = useCallback(() => {
    cancelAnimationFrame(rafRef.current);
    rafRef.current = requestAnimationFrame(tick);
  }, [tick]);

  // Decode a sample's bytes ONCE to extract waveform peaks, then drop the PCM
  // (only the ~4KB peaks survive). Cached by id (capped). Serialized by the
  // caller via decodeQueueRef so rapid clicking never stacks concurrent decodes.
  // Writes the on-screen peaksRef only if this id is STILL the active selection.
  const decodeForPeaks = useCallback(async (id: string, url: string, myReq: number): Promise<void> => {
    const cached = peaksCacheRef.current.get(id);
    if (cached) {
      if (myReq === reqIdRef.current && !unmountedRef.current) { peaksRef.current = cached; drawSpectrum(); }
      return;
    }
    const ctx = ctxRef.current ?? _previewCtx;
    if (!ctx) return;
    let peaks: WavePeaks;
    try {
      const res = await fetch(url);                // Worker URL — HTTP-cache hit (the element already requested it)
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const ab = await res.arrayBuffer();
      if (unmountedRef.current) return;
      const buf = await ctx.decodeAudioData(ab); // buf is block-scoped → PCM GC-eligible right after
      peaks = computePeaksFixed(buf, PEAK_COLS);
    } catch {
      return; // fetch/decode failed → no waveform; playback still works
    }
    if (unmountedRef.current) return;
    peaksCacheRef.current.set(id, peaks);
    while (peaksCacheRef.current.size > PEAK_CACHE_MAX) { // evict oldest (insertion order)
      const oldest = peaksCacheRef.current.keys().next().value;
      if (oldest === undefined) break;
      peaksCacheRef.current.delete(oldest);
    }
    if (myReq === reqIdRef.current) { peaksRef.current = peaks; drawSpectrum(); }
  }, [drawSpectrum]);

  // ── Audio plumbing ──────────────────────────────────────────────────────
  // Pull the SHARED singleton graph (element → gain → analyser → destination
  // already wired) instead of building a new AudioContext per mount. resume()
  // un-parks a context a prior close suspended (must run in a user gesture).
  const ensureCtx = useCallback((): AudioContext => {
    if (!ctxRef.current) {
      const { ctx, gain, analyser, audio } = getPreviewGraph();
      gain.gain.value = volume; // re-apply this session's volume to the shared gain
      ctxRef.current = ctx;
      gainRef.current = gain;
      analyserRef.current = analyser;
      audioRef.current = audio;
      specDataRef.current = new Uint8Array(analyser.frequencyBinCount);
    }
    ctxRef.current.resume().catch(() => {});
    return ctxRef.current;
  }, [volume]);

  // Hard stop — pause the element (used on LOAD / select-new / close).
  const stopPreview = useCallback(() => {
    const audio = audioRef.current;
    if (audio) audio.pause();
    playingRef.current = false;
    setIsPlaying(false);
  }, []);

  // Resume the already-loaded element from its current position.
  const resume = useCallback(() => {
    const audio = audioRef.current;
    if (!audio || !audio.src) return;
    ensureCtx(); // resume the shared context (in-gesture)
    applyPreservesPitch(audio);
    audio.playbackRate = Math.pow(2, pitchRef.current / 12);
    const p = audio.play();
    if (p && typeof p.then === 'function') {
      p.then(() => { if (unmountedRef.current) return; playingRef.current = true; setIsPlaying(true); startRaf(); }).catch(() => {});
    } else {
      playingRef.current = true; setIsPlaying(true); startRaf();
    }
  }, [ensureCtx, startRaf]);

  // ── Preview pitch (semitones, clamped −24..+24) ─────────────────────────
  const setPitch = useCallback((next: number) => {
    const clamped = Math.max(-24, Math.min(24, Math.round(next)));
    pitchRef.current = clamped;
    setPreviewPitch(clamped);
    const audio = audioRef.current;
    if (audio) { applyPreservesPitch(audio); audio.playbackRate = Math.pow(2, clamped / 12); }
  }, []);

  // Start playback of the freshly-loaded element. Split out so the play() retry
  // path is shared. `entry`/`myReq` guard against a superseded selection.
  const startElementPlayback = useCallback((entry: BrowserEntry, myReq: number) => {
    const audio = audioRef.current;
    if (!audio) return;
    applyPreservesPitch(audio);
    audio.playbackRate = Math.pow(2, pitchRef.current / 12);
    const p = audio.play();
    if (p && typeof p.then === 'function') {
      p.then(() => {
        if (myReq !== reqIdRef.current) { audio.pause(); return; } // superseded by a newer click
        playingRef.current = true; setIsPlaying(true);
        setLoadingPreview(false); setStatus(entry.title);
        startRaf();
      }).catch((err: any) => {
        if (myReq !== reqIdRef.current) return;       // a newer selection interrupted this — ignore
        setLoadingPreview(false);
        if (err && err.name === 'AbortError') return; // interrupted by the next load() — not an error
        // iOS can reject play() when the fetch outran the gesture's activation
        // window — the ▶ button is then a fresh gesture that works.
        if (err && err.name === 'NotAllowedError') { setStatus(`${entry.title} — tap ▶ to play`); return; }
        setStreamErr('Preview failed — could not play this sample');
        setStatus('Preview failed');
      });
    } else {
      playingRef.current = true; setIsPlaying(true);
      setLoadingPreview(false); setStatus(entry.title);
      startRaf();
    }
  }, [startRaf]);

  // ── Select + preview a track ────────────────────────────────────────────
  // Direct URL streaming via the Cloudflare CORS Worker (r2AudioUrl): the Worker
  // adds Access-Control-Allow-Origin to 206 range responses, so the cross-origin
  // <audio crossOrigin> element streams natively — every preview is instant
  // regardless of file size, no blob fetch/decode. `entries`/`idx` are unused now
  // (no prefetch needed with the Worker).
  const selectEntry = useCallback((plName: string, entry: BrowserEntry, _entries?: BrowserEntry[], _idx?: number) => {
    if (previewGate && !previewGate()) return;   // demo allowance spent → the host takes over
    const key = `${plName}::${entry.id}`;
    setSelKey(key);
    setSelectedEntry(entry);
    setStreamErr(null);
    pitchRef.current = 0; // new sample → reset preview pitch
    setPreviewPitch(0);
    refreshColors();
    peaksRef.current = peaksCacheRef.current.get(entry.id) ?? null; // instant waveform if cached, else blank until decode

    if (!audioRef.current) ensureCtx();        // lazily wire the shared graph + element
    const audio = audioRef.current;
    const myReq = ++reqIdRef.current;

    // Commit to playing a resolved URL. Split out so it can run either
    // synchronously (URL already resolvable — the iOS click-gesture path) or
    // after an async manifest (re)load on Electron (see below).
    const proceed = (url: string) => {
      if (!audio) return;
      // Track the sample we're committing to load (drives the rotation snapshot).
      // Set only AFTER the URL resolves so a failed selection can't snapshot a stale url.
      currentSelKeyRef.current = key;
      currentEntryIdRef.current = entry.id;
      currentEntryTitleRef.current = entry.title;
      audio.pause();
      // A new selection is authoritatively "not playing" until startElementPlayback
      // confirms play(). Without this reset a slow/failed/NotAllowedError load would
      // leave the prior sample's transport flags set → the first ▶ press becomes a
      // dead no-op (togglePlay sees playingRef true → stopPreview an already-paused
      // element) and a later press could resume the WRONG (previous) sample.
      playingRef.current = false;
      setIsPlaying(false);
      setLoadingPreview(true);
      setStatus(`Loading "${entry.title}"…`);
      setDuration(entry.duration ?? 0); // optimistic; refined on loadedmetadata
      if (timeRef.current) timeRef.current.textContent = '0:00';

      ensureCtx(); // resume the shared context within the gesture

      // Direct Worker URL → the browser streams it progressively (CORS headers on
      // 206 range responses are guaranteed by the Worker). Synchronous assignment
      // keeps audio.play() inside the click gesture (iOS-friendly — no await).
      audio.src = url;
      audio.load(); // reset + start buffering
      audio.addEventListener('canplay', () => { if (!unmountedRef.current) setDuration(audio.duration || 0); }, { once: true });
      startElementPlayback(entry, myReq); // play() in-gesture; NotAllowedError → ▶ fallback
      // Serialized waveform-peak decode from the same Worker URL (HTTP-cache hit —
      // the streaming element already requested it): fetch → decode → peaks → drop PCM.
      decodeQueueRef.current = decodeQueueRef.current
        .catch(() => {})
        .then(() => decodeForPeaks(entry.id, url, myReq));
    };

    const fail = () => {
      if (audio) audio.pause();
      playingRef.current = false; setIsPlaying(false);
      setLoadingPreview(false);
      setStreamErr('Preview unavailable — sample URL not found');
      setStatus('Preview failed');
    };

    if (!audio) { fail(); return; }

    const url = resolveAudioUrl(entry.id, entry.title);
    if (url) { proceed(url); return; }

    // URL didn't resolve. On Electron the playlists arrive over IPC (main process)
    // and never populate the renderer's R2 manifest, so a slow/failed background
    // prime can leave the id unresolvable here — load the manifest on demand and
    // retry once. (Web leaves ensureAudioReady undefined: its manifest is always
    // indexed by the time the browser is open, so we fail straight away as before.
    // The async await would break iOS's click-gesture chain, but Electron desktop
    // has no such constraint and is the only caller that passes ensureAudioReady.)
    if (ensureAudioReady) {
      setLoadingPreview(true);
      setStatus(`Loading "${entry.title}"…`);
      ensureAudioReady()
        .then(() => {
          if (unmountedRef.current || reqIdRef.current !== myReq) return; // superseded / torn down
          const retry = resolveAudioUrl(entry.id, entry.title);
          if (retry) proceed(retry); else fail();
        })
        .catch(() => { if (!unmountedRef.current && reqIdRef.current === myReq) fail(); });
      return;
    }
    fail();
  }, [resolveAudioUrl, ensureAudioReady, previewGate, ensureCtx, refreshColors, startElementPlayback, decodeForPeaks]);

  const togglePlay = useCallback(() => {
    if (playingRef.current) { stopPreview(); drawSpectrum(); return; }
    const audio = audioRef.current;
    if (audio && audio.src) { resume(); return; }
    // Nothing loaded yet but a row is highlighted → preview it.
    if (selKey && selected) {
      const plName = selKey.slice(0, selKey.length - selected.id.length - 2); // strip "::id"
      selectEntry(plName || selKey.split('::')[0], selected);
    }
  }, [stopPreview, drawSpectrum, resume, selKey, selected, selectEntry]);

  // ── Seek by clicking / dragging anywhere on the spectrum ────────────────
  // The playhead line lives ON the spectrum canvas, so the canvas IS the seek
  // surface. Seeks set audio.currentTime and repaint immediately so the line
  // tracks the pointer even while paused.
  const seekFromPointer = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    const cv = spectrumRef.current;
    const audio = audioRef.current;
    if (!cv || !audio) return;
    const rect = cv.getBoundingClientRect();
    const frac = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    const dur = audio.duration || 0;
    if (dur > 0 && isFinite(dur)) {
      try { audio.currentTime = frac * dur; } catch { /* not seekable yet */ }
      if (timeRef.current) timeRef.current.textContent = fmtTime(frac * dur);
    }
    drawSpectrum(); // repaint the playhead now (covers the paused case)
  };
  const onSpectrumDown = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    if (!audioRef.current?.src) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    draggingRef.current = true;
    seekFromPointer(e);
  };
  const onSpectrumMove = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    if (!draggingRef.current) return;
    seekFromPointer(e);
  };
  const onSpectrumUp = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    if (!draggingRef.current) return;
    draggingRef.current = false;
    try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* */ }
  };

  // ── Volume ──────────────────────────────────────────────────────────────
  const onVolume = (v: number) => {
    setVolume(v);
    if (gainRef.current) gainRef.current.gain.value = v;
  };

  // ── Tree interactions ───────────────────────────────────────────────────
  const doLoad = useCallback((entry: BrowserEntry | null) => {
    if (!entry) return;
    stopPreview();
    // Extract the playlist name from selKey (`${plName}::${id}`) so the host
    // can sync its playlist dropdown on explicit LOAD (not on preview).
    const plName = selKey ? selKey.split('::')[0] : '';
    try { sessionStorage.setItem(LAST_LOADED_LS, JSON.stringify({ id: entry.id, pl: plName })); } catch { /* */ }
    onLoad(entry, plName);
  }, [onLoad, stopPreview, selKey]);

  const doLoadToPad = useCallback((entry: BrowserEntry | null) => {
    if (!entry || !onLoadToPad) return;
    stopPreview();
    const plName = selKey ? selKey.split('::')[0] : '';
    try { sessionStorage.setItem(LAST_LOADED_LS, JSON.stringify({ id: entry.id, pl: plName })); } catch { /* */ }
    onLoadToPad(entry, plName);
  }, [onLoadToPad, stopPreview, selKey]);

  const doLoadPreset = useCallback((entry: BrowserEntry | null) => {
    if (!entry || !onLoadPreset) return;
    stopPreview();
    onLoadPreset(entry);
  }, [onLoadPreset, stopPreview]);

  // ── Keyboard control — scoped to the open browser ────────────────────────
  // This component only mounts while the browser is open, so this window
  // listener is inherently scoped to "browser focused". It runs in the CAPTURE
  // phase and calls preventDefault + stopPropagation on every key it handles,
  // so none of them ever reach the host's global sequencer/pad shortcuts.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); onClose(); return; }
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return;

      switch (e.key) {
        case ' ': // Space — toggle preview playback of the highlighted sample
          e.preventDefault(); e.stopPropagation();
          togglePlay();
          break;
        case 'Enter': // load the highlighted sample (same as the LOAD button)
          e.preventDefault(); e.stopPropagation();
          doLoad(selected);
          break;
        case 'ArrowDown':
        case 'ArrowUp': { // move the highlight through the visible list (clamped)
          e.preventDefault(); e.stopPropagation();
          if (flatVisible.length === 0) break;
          const down = e.key === 'ArrowDown';
          const cur = flatVisible.findIndex(f => `${f.plName}::${f.entry.id}` === selKey);
          const nextIdx = cur < 0
            ? (down ? 0 : flatVisible.length - 1)
            : Math.max(0, Math.min(flatVisible.length - 1, cur + (down ? 1 : -1)));
          const f = flatVisible[nextIdx];
          if (f) selectEntry(f.plName, f.entry);
          break;
        }
        case 'ArrowLeft': // pitch the preview down a semitone
          e.preventDefault(); e.stopPropagation();
          setPitch(pitchRef.current - 1);
          break;
        case 'ArrowRight': // pitch the preview up a semitone
          e.preventDefault(); e.stopPropagation();
          setPitch(pitchRef.current + 1);
          break;
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose, togglePlay, doLoad, selected, flatVisible, selKey, selectEntry, setPitch]);

  // Keep the highlighted row visible when navigating with ↑/↓.
  useEffect(() => {
    selectedElRef.current?.scrollIntoView({ block: 'nearest' });
  }, [selKey]);

  // Spectrum canvas backing store — fixed-ish (capped width, NO devicePixelRatio
  // multiply) so a Retina iPhone can't blow up the canvas memory.
  useEffect(() => {
    const cv = spectrumRef.current;
    if (!cv) return;
    const fit = () => {
      const w = Math.max(1, Math.min(1024, Math.floor(cv.clientWidth || 0)));
      const h = 120;
      if (cv.width !== w || cv.height !== h) {
        cv.width = w; cv.height = h;
        refreshColors();
        drawSpectrum();
      }
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(cv);
    return () => ro.disconnect();
  }, [refreshColors, drawSpectrum]);

  // Mount/teardown: wire the shared singleton graph + element event handlers to
  // THIS instance. On unmount we SUSPEND the shared context (never close it) and
  // clear the element src to stop background streaming — the singleton element +
  // media-source persist for the next open.
  useEffect(() => {
    unmountedRef.current = false;
    const { audio, ctx, gain, analyser } = getPreviewGraph();
    audioRef.current = audio;
    if (!ctxRef.current) {
      ctxRef.current = ctx;
      gainRef.current = gain;
      analyserRef.current = analyser;
      specDataRef.current = new Uint8Array(analyser.frequencyBinCount);
      gain.gain.value = volume;
    }

    const onMeta = () => { if (!unmountedRef.current) setDuration(audio.duration || 0); };
    const onEnd = () => {
      if (unmountedRef.current) return;
      playingRef.current = false;
      setIsPlaying(false);
      try { audio.currentTime = 0; } catch { /* */ }
      if (timeRef.current) timeRef.current.textContent = fmtTime(0);
      drawSpectrum(); // redraws idle bars + playhead reset to the left edge
    };
    const onErr = () => {
      if (unmountedRef.current || !audio.src) return;
      playingRef.current = false;
      setIsPlaying(false);
      setLoadingPreview(false);
      setStreamErr('Preview failed — could not stream this sample (check connection)');
      setStatus('Preview failed');
    };
    audio.addEventListener('loadedmetadata', onMeta);
    audio.addEventListener('ended', onEnd);
    audio.addEventListener('error', onErr);

    startRaf(); // begin the continuous Matrix-rain loop (runs until unmount)

    // Rotation restore: if the prior unmount saved a snapshot, resume that sample
    // at its position on this fresh mount (the singleton element kept its src, so
    // no re-fetch). Consumed once.
    if (_previewSnapshot) {
      const snap = _previewSnapshot;
      _previewSnapshot = null;
      peaksRef.current = snap.peaks;
      currentSelKeyRef.current = snap.selKey;
      currentEntryIdRef.current = snap.entryId;
      currentEntryTitleRef.current = snap.entryTitle;
      setSelKey(snap.selKey);                 // re-highlight the row
      setStatus(snap.entryTitle);
      setDuration(audio.duration || 0);        // element retained metadata across the remount
      if (audio.src !== snap.url) { audio.src = snap.url; audio.load(); }
      const doResume = () => {
        if (unmountedRef.current) return;
        try { audio.currentTime = snap.currentTime; } catch { /* not seekable yet */ }
        if (snap.wasPlaying) {
          ensureCtx(); // resume the shared context (best-effort; iOS may need a gesture)
          audio.play()
            .then(() => { if (!unmountedRef.current) { playingRef.current = true; setIsPlaying(true); } })
            .catch(() => { playingRef.current = false; setIsPlaying(false); }); // ▶ fallback
        }
      };
      if (audio.readyState >= 1) doResume();
      else audio.addEventListener('loadedmetadata', doResume, { once: true });
    }

    return () => {
      unmountedRef.current = true; // FIRST — late callbacks must not touch a dead instance
      // Snapshot the in-flight preview BEFORE teardown so the next mount (rotation)
      // can resume it. Only when a real sample is loaded and hasn't ended.
      if (audio.src && !audio.ended && currentEntryIdRef.current && currentSelKeyRef.current) {
        _previewSnapshot = {
          url: audio.src,
          currentTime: audio.currentTime,
          wasPlaying: !audio.paused,
          selKey: currentSelKeyRef.current,
          entryId: currentEntryIdRef.current,
          entryTitle: currentEntryTitleRef.current ?? '',
          peaks: peaksRef.current,
        };
      } else {
        _previewSnapshot = null;
      }
      cancelAnimationFrame(rafRef.current);
      audio.removeEventListener('loadedmetadata', onMeta);
      audio.removeEventListener('ended', onEnd);
      audio.removeEventListener('error', onErr);
      audio.pause();
      // Keep the src when we snapshotted (lets the next mount resume without a
      // re-fetch); otherwise clear it to stop background streaming.
      if (!_previewSnapshot) { try { audio.removeAttribute('src'); audio.load(); } catch { /* */ } }
      peaksRef.current = null; // drop the on-screen waveform ref (cache Map dies with the instance)
      _previewCtx?.suspend().catch(() => {}); // park the shared hardware tap; keep the context alive
      ctxRef.current = null;
      gainRef.current = null;
      analyserRef.current = null;
      audioRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drawSpectrum]);

  const selPresetName = selected && presetIndex ? presetIndex[selected.id] : undefined;

  return (
    <div className="sb-overlay" onMouseDown={onClose}>
      <div
        className={`sb-modal${isPhone ? ' sb-modal--phone' : ''}`}
        role="dialog"
        aria-label="Sample Browser"
        onMouseDown={e => e.stopPropagation()}
      >
        {/* ── Title bar ── */}
        <div className="sb-titlebar">
          <span className="sb-title">SAMPLE BROWSER</span>
          <button className="sb-x" onClick={onClose} title="Close (Esc)">✕</button>
        </div>

        {/* ── LCD display (time · track · duration) ── */}
        <div className="sb-display">
          <div className="sb-lcd-time"><span ref={timeRef}>0:00</span></div>
          <div className="sb-lcd-meta">
            <div className={`sb-lcd-title${selected ? '' : ' sb-lcd-title--idle'}`}>
              {selected ? selected.title : '··· no sample selected ···'}
            </div>
            <div className="sb-lcd-tags">
              <span className="sb-tag sb-tag--dur">{fmtTime(duration || undefined)}</span>
            </div>
          </div>
        </div>

        {/* ── Spectral analyzer (primary visual) — click/drag to seek ── */}
        <div className="sb-spectrum-wrap">
          <canvas
            ref={spectrumRef}
            className="sb-spectrum-main"
            onPointerDown={onSpectrumDown}
            onPointerMove={onSpectrumMove}
            onPointerUp={onSpectrumUp}
            title="Click or drag to seek"
          />
          {loadingPreview && <div className="sb-wave-msg">◌ BUFFERING…</div>}
          {!loadingPreview && !selected && <div className="sb-wave-msg sb-wave-msg--idle">▸ SELECT A SAMPLE TO PREVIEW</div>}
          {!loadingPreview && streamErr && <div className="sb-wave-msg sb-wave-msg--err">{streamErr}</div>}
        </div>

        {/* ── Transport ── */}
        <div className="sb-transport">
          <button className="sb-play" onClick={togglePlay} disabled={!selected} title="Play / Pause (Space)">
            {isPlaying ? '❚❚' : '▶'}
          </button>
          <div className="sb-vol">
            <span className="sb-vol-lbl">VOL</span>
            <input type="range" min={0} max={100} value={Math.round(volume * 100)}
              onChange={e => onVolume(Number(e.target.value) / 100)} />
          </div>
          <div className="sb-pitch" title="Preview pitch — ← / → (semitones)">
            <span className="sb-vol-lbl">PITCH</span>
            <button className="sb-pitch-btn" onClick={() => setPitch(pitchRef.current - 1)}
              disabled={!selected} aria-label="Pitch down one semitone">−</button>
            <span className="sb-pitch-val">{fmtPitch(previewPitch)}</span>
            <button className="sb-pitch-btn" onClick={() => setPitch(pitchRef.current + 1)}
              disabled={!selected} aria-label="Pitch up one semitone">+</button>
          </div>
        </div>

        {/* ── Filter ── */}
        <div className="sb-filterbar">
          <input
            className="sb-search"
            type="text"
            placeholder="filter samples…"
            value={query}
            onChange={e => setQuery(e.target.value)}
          />
          {query && <button className="sb-search-clear" onClick={() => setQuery('')}>✕</button>}
        </div>

        {/* ── Folder / sample list — TERMINATOR (R2) + your library ── */}
        <div className="sb-browser">
          <LibraryTree
            playlists={playlists}
            library={library}
            query={query}
            selKey={selKey}
            isPlaying={isPlaying}
            presetIndex={presetIndex}
            initialPlaylist={initialPlaylist}
            onSelectEntry={(plName, entry) => selectEntry(plName, entry)}
            onLoadEntry={entry => doLoad(entry)}
            onLoadToPad={onLoadToPad ? entry => doLoadToPad(entry) : undefined}
            onPreviewEntry={(plName, entry) => { if (selected && selected.id === entry.id) { togglePlay(); return; } selectEntry(plName, entry); /* selecting starts the preview */ }}
            onVisibleItems={onVisibleItems}
            onStatus={setStatus}
            selectedElRef={el => { selectedElRef.current = el; }}
          />
        </div>

        {/* ── Footer ── */}
        <div className="sb-footer">
          <div className="sb-status" title={status}>{status}</div>
          {selPresetName && onLoadPreset && (
            <button
              className="sb-load sb-load-preset"
              onClick={() => doLoadPreset(selected)}
              disabled={loadingPreview}
              title={`Restore saved preset "${selPresetName}" — loads this sample with its chops + sequences`}
            >
              ★ LOAD PRESET
            </button>
          )}
          {onLoadToPad && (
            <button className="sb-load sb-load-pad" onClick={() => doLoadToPad(selected)} disabled={!selected}
              title="Load this sample onto the NEXT EMPTY PAD as its own source — the browser stays open, so you can stack several samples onto pads (right-click a row for the same)">
              ⤓ LOAD → PAD
            </button>
          )}
          <button className="sb-load" onClick={() => doLoad(selected)} disabled={!selected} title="Load this sample as the main track (replaces the current sample; your pads' own sources stay)">
            ⤓ LOAD
          </button>
        </div>
      </div>
    </div>
  );
}
