/**
 * juceBridge — the typed face of the JUCE WebView bridge (docs/native/BRIDGE-PROTOCOL.md) for the React app.
 *
 * Built on the OFFICIAL `@juce-framework/webview` package (the same code JUCE ships in
 * modules/juce_gui_extra/native/typescript/webview-interop — no hand-rolled plumbing). Every call is a
 * Promise; events come from the backend's listener list. `isNative()` is synchronous at module-evaluation
 * time because JUCE injects `window.__JUCE__` in a user script that runs before any page script — so
 * ipc-native.ts can decide at boot whether it is running inside Terminator 3.0 or in a plain browser.
 */
import { getNativeFunction } from '@juce-framework/webview';

type AnyRecord = Record<string, any>;

// (`window.__JUCE__` itself is declared by @juce-framework/webview.)
declare global {
  interface Window {
    /** Injected by the shell before any page script: the synchronous boot reads (version, UI settings, dirs).
     *  Deliberately NOT `__TERMINATOR_NATIVE__` — that is Vite's build-time boolean flag, and the dev server
     *  assigns it as a real global, which would overwrite this payload with `true` under TERMINATOR_UI_URL. */
    __TERMINATOR_BOOT__?: { version: string; settings: AnyRecord; dirs: NativeDirs };
  }
}
type JuceBackend = { addEventListener: (id: string, fn: (payload: any) => void) => unknown; removeEventListener: (handle: unknown) => void; emitEvent: (id: string, payload: unknown) => void };
const backend = (): JuceBackend | undefined => (typeof window !== 'undefined' ? ((window as any).__JUCE__?.backend as JuceBackend | undefined) : undefined);

export interface NativeDirs {
  dataDir: string; projectsDir: string; projectsIsDefault: boolean; settingsFile: string; home: string; music: string; temp?: string; sep: string;
}

/** True when the page runs inside the Terminator 3.0 JUCE shell (WKWebView / WebView2). */
export const isNative = (): boolean => !!backend();
/** The shell's boot payload (null outside the shell). */
export const nativeBoot = () => (typeof window !== 'undefined' ? window.__TERMINATOR_BOOT__ ?? null : null);

/** A big reply (> ~24 KB) comes back as { __largeReply: "/blob/<token>" } — JUCE's emitEvent escapes C++→JS
 *  payloads with a quadratic String::replace, so the shell stashes large JSON and we fetch it through the resource
 *  provider instead (ShellServices::maybeLarge). Transparent to every caller. */
async function resolveLarge(res: any): Promise<any> {
  if (res && typeof res === 'object' && typeof res.__largeReply === 'string') {
    const r = await fetch(new URL(res.__largeReply, location.href).href);
    if (!r.ok) throw new Error(`large reply fetch failed (${r.status})`);
    return r.json();
  }
  return res;
}
function lazy<TArg, TRes>(name: string): (arg?: TArg) => Promise<TRes> {
  let f: ((...a: any[]) => Promise<any>) | null = null;
  return (arg?: TArg) => {
    if (!isNative()) return Promise.reject(new Error(`${name}: not running inside the Terminator shell`));
    f ??= getNativeFunction(name) as (...a: any[]) => Promise<any>;
    return (arg === undefined ? f() : f(arg)).then(resolveLarge);
  };
}

/** The native functions the shell registers (WebShell.cpp). Shapes: BRIDGE-PROTOCOL.md. */
export const native = {
  info: lazy<void, AnyRecord>('terminatorInfo'),
  command: lazy<AnyRecord, { ok: boolean; error?: string }>('terminatorCommand'),
  audio: lazy<AnyRecord, AnyRecord>('terminatorAudio'),
  midi: lazy<AnyRecord, AnyRecord>('terminatorMidi'),
  pads: lazy<AnyRecord, AnyRecord>('terminatorPads'),
  samples: lazy<AnyRecord, AnyRecord>('terminatorSamples'),
  process: lazy<AnyRecord, AnyRecord>('terminatorProcess'),
  /** Phase 7.1c: STEM SEPARATION in process (htdemucs through onnxruntime). `{verb:'status'}` ·
   *  `{verb:'split', key, quality, windows[], sweep, planes?}` (the audio is read from the SAMPLE STORE by key —
   *  the renderer never ships PCM) · `{verb:'queueWindow', span}` · `{verb:'cancel'}` ·
   *  `{verb:'downloadModels'|'deleteModels', quality}` · `{verb:'modelsDir', path}` · `{verb:'forget', key}`.
   *  Events: `terminator.stemsProgress` {phase, pct, total?} · `terminator.stemsChunk` {key, startFrame,
   *  endFrame, frames, planes, blob:"/blob/<token>"} (the span's PCM is FETCHED, never put in the payload) ·
   *  `terminator.stemsDone` · `terminator.stemsError` · `terminator.stemsModels`. */
  stems: lazy<AnyRecord, AnyRecord>('terminatorStems'),
  fs: lazy<AnyRecord, AnyRecord>('terminatorFs'),
  settings: lazy<AnyRecord, AnyRecord>('terminatorSettings'),
  window: lazy<AnyRecord, { ok: boolean; error?: string }>('terminatorWindow'),
  /** Phase 4.5e: render the project OFFLINE through the same engine + mixer and write WAVs. The page owns the
   *  project so it sends the JSON; the audio is already in the store so it sends KEY MAPS, not bytes.
   *  `{project, main?, sources?{videoId: key}, padSamples?{pad: key}, drumLanes?{lane: key}, path, bitDepth?, sampleRate?, loops?, tail?,
   *   mixer?, drums?, bass?, limiter?, stems?[channel]}` → `{ok, files[], seconds, sampleRate, bitDepth}`.
   *  `padSamples` is audio only the PAGE can make for one pad — today the TIME-STRETCHED slice: the renderer
   *  plays it whole, with the pad's stem mask and REVERSE already baked in, so a bounce is what the pads played. */
  exportProject: lazy<AnyRecord, AnyRecord>('terminatorExport'),
  /** Phase 5.1a/b/c: RECORD from the interface's own inputs, in the ENGINE — what RECORD SAMPLE uses in the shell
   *  for a real input (Terminator's own output and system audio stay on the page's getUserMedia path).
   *  `{verb:'start', path, channels?, inputs?[], bitDepth?, countIn?, atSample?, atTransport?, lengthSeconds?,
   *  source?:'inputs'|'master', compensate?}` → `{ok, path, armed, source, compensationSamples, error?}`; `{verb:'stop'}` → `{ok, frames, seconds, dropped}`; `{verb:'status'}` →
   *  `{recording, armed, complete, frames, captured, dropped, peakL, peakR, startSample, startPlayhead}`;
   *  `{verb:'monitor', enabled, inputs?[], gainDb?, strip?}` → the input through the engine, live.
   *
   *  THE ARM (5.1c): with `countIn` the shell books the clicks AND the take, and capture begins on the downbeat
   *  itself — the first frame of the file is that beat. `atSample` starts on an exact engine sample, `atTransport`
   *  on the transport's own anchor, and `lengthSeconds` punches out on its own frame: the shell then closes the
   *  file and emits `terminator.recordFinished` `{path, frames, dropped, seconds}` — nobody has to hold STOP.
   *
   *  5.1d: `source:'master'` records TERMINATOR'S OWN OUTPUT (post master fader, before the click) — the RESAMPLE
   *  take, which the page's Web Audio tap cannot make inside the shell because the TS engine's voices are muted
   *  there. A take aimed at a musical position is shifted by the round trip (the loopback calibration's measured
   *  number, else the driver's reported in + out latency) so frame 0 is the performance, not the latency;
   *  `compensate:false` turns that off, and a master take never needs it. */
  record: lazy<AnyRecord, AnyRecord>('terminatorRecord'),
  /** Phase 6.1: the VST3 / AudioUnit list. `{verb:'list'|'scan'|'cancelScan'|'remove'|'clearBlocklist'|
   *  'setFolders', …}` → `{ok, plugins[], blocklist[], folders[], formats[], scanning}`. The SCAN opens every
   *  plugin in its own CHILD PROCESS (the app relaunches itself with `--scan-plugin`), so a plugin that crashes
   *  or hangs kills the scanner and lands on the blocklist instead of taking Terminator down. Progress arrives as
   *  the `terminator.pluginScan` event `{done, total, current, found, finished}`. */
  plugins: lazy<AnyRecord, AnyRecord>('terminatorPlugins'),
};

/** Subscribe to a shell event (`terminator.snapshot` 20 Hz, `terminator.devicesChanged`, `terminator.midiChanged`,
 *  `terminator.settingsChanged`). Returns the unsubscribe. No-op outside the shell. */
export function onNativeEvent(name: string, cb: (payload: any) => void): () => void {
  const b = backend();
  if (!b) return () => {};
  const handle = b.addEventListener(name, cb);
  return () => { try { b.removeEventListener(handle); } catch { /* page going away */ } };
}
