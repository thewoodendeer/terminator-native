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
  fs: lazy<AnyRecord, AnyRecord>('terminatorFs'),
  settings: lazy<AnyRecord, AnyRecord>('terminatorSettings'),
  window: lazy<AnyRecord, { ok: boolean; error?: string }>('terminatorWindow'),
};

/** Subscribe to a shell event (`terminator.snapshot` 20 Hz, `terminator.devicesChanged`, `terminator.midiChanged`,
 *  `terminator.settingsChanged`). Returns the unsubscribe. No-op outside the shell. */
export function onNativeEvent(name: string, cb: (payload: any) => void): () => void {
  const b = backend();
  if (!b) return () => {};
  const handle = b.addEventListener(name, cb);
  return () => { try { b.removeEventListener(handle); } catch { /* page going away */ } };
}
