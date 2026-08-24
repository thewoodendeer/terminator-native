/**
 * PLUGIN SLOTS (Phase 6.2) — the thin bridge between the page's mixer UI and the hosted plugins.
 *
 * The page owns the CHOICE (a `plugin` insert's PLUGIN param is the plugin's id, and rides the chain into the
 * project like any other param); the app owns the INSTANCE. This module is what the two use to find each other:
 * the native mixer shadow registers which native strip index a page channel got, so a button in the mixer can say
 * "open the editor of the plugin in slot 2 of channel sample3" without the UI knowing anything about strips.
 *
 * Outside the shell every function here is a no-op and the list is empty, so the browser build renders nothing.
 */
import { isNative, native } from './juceBridge';

export type ScannedPlugin = { id: string; name: string; manufacturer: string; format: string; isInstrument: boolean };

let cache: ScannedPlugin[] | null = null;
let inflight: Promise<ScannedPlugin[]> | null = null;
/** page channel name (or 'master') -> the native strip index the shadow gave it. */
const stripOf = new Map<string, number>();

/** The scanned effects, once per session (Preferences → PLUGINS re-scans and calls `refreshPlugins`). */
export async function listPlugins(): Promise<ScannedPlugin[]> {
  if (!isNative()) return [];
  if (cache) return cache;
  inflight ??= native.plugins({ verb: 'list' })
    .then((r: any) => {
      // instruments are listed too (6.3): picking one makes it that strip's INSTRUMENT rather than an insert
      cache = (r?.plugins ?? []) as ScannedPlugin[];
      return cache;
    })
    .catch(() => [])
    .finally(() => { inflight = null; });
  return inflight;
}
export function refreshPlugins(): void { cache = null; }
/** What listPlugins() last returned — for a synchronous render before the promise lands. */
export function cachedPlugins(): ScannedPlugin[] { return cache ?? []; }

/** The shadow's side: which native strip a page channel is mirrored onto. */
export function noteStrip(channel: string, strip: number): void { stripOf.set(channel, strip); }
export function forgetStrip(channel: string): void { stripOf.delete(channel); }
export function stripIndex(channel: string): number { return stripOf.get(channel) ?? -1; }

/** Open (or front) the plugin's own window. */
export async function openPluginEditor(channel: string, slot: number): Promise<{ ok: boolean; error?: string }> {
  const strip = stripIndex(channel);
  if (!isNative() || strip < 0) return { ok: false, error: 'not running natively' };
  const r: any = await native.plugins({ verb: 'editor', strip, slot, show: true });
  return { ok: !!r?.ok, error: r?.error };
}

/** Is this plugin an instrument? (the picker labels it, and the shadow loads it differently) */
export function isInstrumentId(id: string): boolean {
  return cachedPlugins().some(p => p.id === id && p.isInstrument);
}

/** MIDI notes play the hosted INSTRUMENT instead of the pads. OFF by default — the standing rule is that keys and
 *  MIDI trigger pads, so this is a deliberate choice, made in the plugin's own panel. */
export function setInstrumentMidi(on: boolean): void {
  if (isNative()) void native.command({ type: 'setInstrumentMidi', on });
}

/** The mixer shadow registers its own state-pull here, so a project save can wait for it (see doSaveProject). */
let syncStates: (() => Promise<void>) | null = null;
export function registerPluginStateSync(fn: (() => Promise<void>) | null): void { syncStates = fn; }
/** Pull every hosted plugin's own settings back into the page's chain. No-op outside the shell. */
export async function syncNativePluginStates(): Promise<void> { if (syncStates) await syncStates(); }

/** Every loaded plugin's own state, for a project save: `{ 'sample1:2': '<base64>' }`. */
export async function collectPluginStates(): Promise<Record<string, string>> {
  if (!isNative()) return {};
  const out: Record<string, string> = {};
  const rack: any = await native.plugins({ verb: 'rack' }).catch(() => null);
  for (const entry of (rack?.rack ?? []) as Array<{ strip: number; slot: number }>) {
    const channel = [...stripOf.entries()].find(([, idx]) => idx === entry.strip)?.[0];
    if (!channel) continue;
    const st: any = await native.plugins({ verb: 'state', strip: entry.strip, slot: entry.slot }).catch(() => null);
    if (st?.ok && typeof st.state === 'string') out[`${channel}:${entry.slot}`] = st.state;
  }
  return out;
}
