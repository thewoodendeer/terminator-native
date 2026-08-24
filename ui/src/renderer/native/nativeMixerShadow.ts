/**
 * Terminator 3.0 — the MIXER shadow (Phase 4.1): the page's MixerEngine strips ARE the native engine's strips.
 *
 *  • Every ChannelStrip / MasterStrip setter reports through `setMixerNativeSink` (src/mixer/MixerEngine.ts) and lands
 *    here as a bridge command: `mixerSetStrip` (a strip appears / goes away), `mixerSetFader` / `mixerSetPan` /
 *    `mixerSetMute` / `mixerSetSolo` / `mixerSetSend` (the 4 post-fader sends → the send1..4 returns). The engine
 *    computes the solo law itself (silent = mute || (anySolo && !solo)) — the page's applySolo() is UI only.
 *  • Strips are INDICES natively (0 = the master; engine/core/Mixer.h); the page names them. The fixed names get fixed
 *    indices (sample 1 · kick 2 · snare 3 · hat 4 · openhat 5 · perc 6 · bass 7 · send1..4 8..11 · CLICK 12) so a
 *    project's strip is the same strip session after session; `sampleN` / user-lane strips take 13.. on demand (a pad
 *    or a lane can ask for its strip BEFORE the view's effect creates the page strip — the index is the same either
 *    way) and give the slot back when the page removes the channel.
 *  • The SOURCES follow: the pads' `setPadParams.strip` (nativeEngineShadow reads `stripFor(engine.padRoute(i))`),
 *    the drum lanes' (nativeDrumShadow, lane key → strip name), the bass (`setSourceStrip bass` → 'bass') and the
 *    CLICK (`setSourceStrip click` → strip 12, a native-only strip at 0 dB until the UI grows its CLICK strip — the
 *    metronome + count-in now ride the mix instead of bypassing it).
 *  • Read-back: the snapshot's `mixer` object (`active` / `silent` / `strips[idx] = [preL, preR, postL, postR, rmsPre,
 *    rmsPost, gain]` / `rejected` / `orderValid` / `mainOut` / `bassStrip` / `clickStrip`) — `levels(name)` serves the
 *    meters (the UI binding is 4.3); the probe (part 8, `mixerPageOk`) asserts the round trips.
 *  • The INSERT CHAINS (4.2): `fxAdd` / `fxRemove` / `fxBypass` / `fxParam` / `fxReorder` / `fxClear` from the sink →
 *    (4.2b: every page device is real natively; the SC COMP's SOURCE channel NAME becomes the key strip's INDEX here) →
 *  • CONSOLE (4.2c): `mixerSetConsole` follows MixerEngine.setConsole; every strip activation carries its seed =
 *    FNV-1a(name), the page's own per-strip tolerance seed; `mixerSetLimiter` puts the master's safety limiter in →
 *  • METERS (4.3): `setMixerNativeMeters` — the strips' peaks, the master's BS.1770 loudness (`mixer.loudness`) and the
 *    dynamics devices' GR (`mixer.fxGr`) come from the snapshot while attached; `loudnessReset` = the popup's RESET →
 *    `mixerAddFx {strip, fx}` (+ every current param, immediate) / `mixerRemoveFx` / `mixerSetFxBypass` /
 *    `mixerSetFxParam {strip, index, fx, key, value}` / `mixerReorderFx` / `mixerClearFx`; the master's chain is strip 0.
 *    Devices the engine has not ported yet (4.2a ports utility / eq / filter / wide / mseq / pan) take their slot as a
 *    PASS-THROUGH placeholder natively (the slot indices stay aligned; the device does nothing until its port lands).
 *  • PDC (4.4): `mixerSetPdc {on}` follows MixerEngine.setPdc (and goes out at attach with the saved setting). Only
 *    the switch crosses — the engine owns every chain's latency, so it builds the same two-tier plan itself and
 *    publishes it back in the snapshot (`mixer.pdc` / `pdcMaxChan` / `pdcToMaster` / `pdcPlan[idx]`, whole samples).
 */
import { MixerEngine, ChannelName, setMixerNativeSink, setMixerNativeMeters, SEND_CHANNELS, FADER_MIN_DB } from '../../mixer/MixerEngine';
import type { FxId } from '../../mixer/fx';

type AnyRecord = Record<string, unknown>;

export interface MixerShadowHost {
  cmd(c: AnyRecord): Promise<boolean>;
  note(stat: 'commands' | 'strips', value: number): void;
  error(msg: string): void;
}

/** The fixed strip indices (engine/core/Mixer.h: 0 = the master). */
export const FIXED_STRIPS: Readonly<Record<string, number>> = Object.freeze({
  sample: 1, kick: 2, snare: 3, hat: 4, openhat: 5, perc: 6, bass: 7, send1: 8, send2: 9, send3: 10, send4: 11,
});
export const CLICK_STRIP = 12;
const FIRST_DYNAMIC_STRIP = 13;
const MAX_STRIPS = 64;
/** DrumEngine track key → mixer channel name (ChopperView's drumMap); user lanes use their key as the channel name. */
export const DRUM_TRACK_STRIP: Readonly<Record<string, string>> = Object.freeze({ kick: 'kick', snare: 'snare', hihat: 'hat', openhat: 'openhat', perc: 'perc' });

/** The console-worklet's seed: FNV-1a (32-bit) over the name's UTF-16 code units (the page's `toleranceFor`). */
export function fnv1a(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h >>> 0;
}
function nameOf(names: Map<string, number>, idx: number): string | undefined {
  for (const [n, i] of names) if (i === idx) return n;
  return undefined;
}

export class NativeMixerShadow {
  private names = new Map<string, number>(Object.entries(FIXED_STRIPS));
  private live = new Set<number>();         // strips we activated natively
  private chain: Promise<void> = Promise.resolve();
  private detached = false;
  latestMixer: AnyRecord | null = null;     // the snapshot's `mixer` object

  constructor(private mixer: MixerEngine, private host: MixerShadowHost) {}

  attach(): void {
    setMixerNativeSink({
      channel: (name, kind, present) => this.channel(name, kind, present),
      fader: (name, db) => this.queue({ type: 'mixerSetFader', strip: name === 'master' ? 0 : this.stripFor(name), db }),
      pan: (name, pan) => this.queue({ type: 'mixerSetPan', strip: this.stripFor(name), pan }),
      send: (name, index, db) => this.send(name, index, db),
      mute: (name, on) => this.queue({ type: 'mixerSetMute', strip: this.stripFor(name), on }),
      solo: (name, on) => this.queue({ type: 'mixerSetSolo', strip: this.stripFor(name), on }),
      fxAdd: (name, index, id, params) => this.fxAdd(name, index, id, params),
      fxRemove: (name, index) => this.queue({ type: 'mixerRemoveFx', strip: this.idxOf(name), index }),
      fxBypass: (name, index, on) => this.queue({ type: 'mixerSetFxBypass', strip: this.idxOf(name), index, on }),
      // M/S everywhere (4.7a): the SLOT's route. The engine owns the split (and the delay that keeps the untouched
      // half aligned when the device has latency), so only the choice crosses.
      fxRoute: (name, index, route) => this.queue({ type: 'mixerSetFxRoute', strip: this.idxOf(name), index, route }),
      fxParam: (name, index, id, key, value) => this.queue({ type: 'mixerSetFxParam', strip: this.idxOf(name), index, fx: id, key, value: this.fxValue(id, key, value) }),
      fxReorder: (name, from, to) => this.queue({ type: 'mixerReorderFx', strip: this.idxOf(name), from, to }),
      fxClear: (name) => this.queue({ type: 'mixerClearFx', strip: this.idxOf(name) }),
      console: (settings) => this.queue({ type: 'mixerSetConsole', on: settings.on, flavour: settings.flavour, amount: settings.amount }),
      pdc: (on) => this.queue({ type: 'mixerSetPdc', on }),
    });
    // the whole page mixer, as it stands: every strip + the master + the CLICK strip + the sources + CONSOLE
    for (const [name, strip] of this.mixer.channels) this.mirror(name, strip.isSend ? 'send' : 'channel');
    this.queue({ type: 'mixerSetFader', strip: 0, db: this.mixer.master.faderDb });
    this.mirrorChain('master');
    this.queue({ type: 'mixerSetConsole', on: this.mixer.console.on, flavour: this.mixer.console.flavour, amount: this.mixer.console.amount });
    this.queue({ type: 'mixerSetLimiter', on: true }); // the page's master always carries its −1 dBFS safety limiter
    this.queue({ type: 'mixerSetPdc', on: this.mixer.pdcOn }); // PDC (4.4) — the engine builds the plan itself
    this.installMeters();
    this.activate(CLICK_STRIP, 'channel', 'click');
    this.queue({ type: 'mixerSetFader', strip: CLICK_STRIP, db: 0 });
    this.queue({ type: 'setSourceStrip', source: 'click', strip: CLICK_STRIP });
    if (this.mixer.channels.has('bass')) this.queue({ type: 'setSourceStrip', source: 'bass', strip: this.stripFor('bass') });
  }

  detach(): void {
    this.detached = true;
    setMixerNativeSink(null);
    setMixerNativeMeters(null);
    // the sources back to their direct paths, the strips off (the pads are unbound by the engine shadow's detach)
    void this.host.cmd({ type: 'setSourceStrip', source: 'bass', strip: -1 });
    void this.host.cmd({ type: 'setSourceStrip', source: 'click', strip: -1 });
    for (const idx of this.live) void this.host.cmd({ type: 'mixerSetStrip', strip: idx, kind: 'off' });
    this.live.clear();
  }

  /** The strip index for a page channel name — allocated (and activated natively, at the engine's defaults) the first
   *  time anyone asks, so a pad / lane routed to a strip the view has not created yet already sums into the right
   *  place. −1 when the pool is exhausted (63 strips). */
  stripFor(name: ChannelName): number {
    const have = this.names.get(name);
    if (have !== undefined) { if (!this.live.has(have) && !this.detached) this.activate(have, name.startsWith('send') ? 'send' : 'channel', name); return have; }
    const used = new Set(this.names.values());
    for (let i = FIRST_DYNAMIC_STRIP; i < MAX_STRIPS; i++) {
      if (used.has(i)) continue;
      this.names.set(name, i);
      this.activate(i, 'channel', name);
      return i;
    }
    this.host.error(`mixer: no free strip for '${name}' (${MAX_STRIPS - 1} in use)`);
    return -1;
  }

  /** The snapshot's meter row for a page channel (or 'master'): [preL, preR, postL, postR, rmsPre, rmsPost, gain]. */
  levels(name: ChannelName | 'master'): number[] | null {
    const idx = name === 'master' ? 0 : this.names.get(name);
    if (idx === undefined) return null;
    const strips = this.latestMixer?.strips as Record<string, number[]> | undefined;
    const row = strips?.[String(idx)];
    return Array.isArray(row) ? row : null;
  }

  onSnapshot(s: AnyRecord): void {
    const mx = s.mixer;
    if (mx && typeof mx === 'object') {
      this.latestMixer = mx as AnyRecord;
      // the SC COMP panels read `gainReductionDb` off the page's device — keep it at the engine's number
      const gr = (mx as AnyRecord).fxGr as Record<string, number[]> | undefined;
      if (gr) {
        for (const [name, strip] of this.mixer.channels) {
          const idx = this.names.get(name);
          const row = idx === undefined ? undefined : gr[String(idx)];
          if (!row) continue;
          for (let i = 0; i < strip.fx.length && i < row.length; i++) {
            // every device that SHOWS gain reduction reads it off the page object; the engine is the only one
            // that knows the number (the page's copy of these devices does not compress at all)
            if (strip.fxIds[i] === 'sccomp' || strip.fxIds[i] === 'fetcomp' || strip.fxIds[i] === 'limiter')
              (strip.fx[i] as { gainReductionDb?: number }).gainReductionDb = row[i];
          }
        }
      }
    }
  }

  // ── the meters (4.3): the page reads the engine's numbers while attached ──
  private installMeters(): void {
    setMixerNativeMeters({
      levels: (name) => {
        const row = this.levels(name);
        return row ? { preL: row[0], preR: row[1], postL: row[2], postR: row[3] } : null;
      },
      loudness: () => {
        const lo = this.latestMixer?.loudness as Record<string, number> | undefined;
        if (!lo) return null;
        const v = (k: string) => { const x = Number(lo[k]); return x <= -999 ? -Infinity : x; };
        return { m: v('m'), s: v('s'), i: v('i'), lra: Number(lo.lra) || 0, peakL: Number(lo.peakL) || 0, peakR: Number(lo.peakR) || 0,
          tpL: Number(lo.tpL) || 0, tpR: Number(lo.tpR) || 0, holdPeak: Number(lo.holdPeak) || 0, holdTp: Number(lo.holdTp) || 0,
          maxM: v('maxM'), maxS: v('maxS'), corr: Number.isFinite(Number(lo.corr)) ? Number(lo.corr) : 1, worklet: true };
      },
      gainReduction: (name, index) => {
        const idx = name === 'master' ? 0 : this.names.get(name);
        if (idx === undefined) return null;
        const gr = this.latestMixer?.fxGr as Record<string, number[]> | undefined;
        const row = gr?.[String(idx)];
        return row && index < row.length ? row[index] : null;
      },
      resetLoudness: () => this.queue({ type: 'loudnessReset' }),
    });
  }

  // ── the mirror ──
  private activate(idx: number, kind: 'channel' | 'send', name?: string): void {
    if (idx < 0 || idx >= MAX_STRIPS || this.live.has(idx)) return;
    this.live.add(idx);
    this.host.note('strips', 1);
    // the CONSOLE seed = the page's FNV-1a of the strip NAME (ConsoleStage seeds by name: "kick" is always the same kick)
    this.queue({ type: 'mixerSetStrip', strip: idx, kind, seed: fnv1a(name ?? nameOf(this.names, idx) ?? 'strip') });
  }
  private mirror(name: ChannelName, kind: 'channel' | 'send'): void {
    const strip = this.mixer.channels.get(name);
    if (!strip) return;
    const idx = this.stripFor(name);
    if (idx < 0) return;
    if (!this.live.has(idx)) this.activate(idx, kind, name);
    this.queue({ type: 'mixerSetFader', strip: idx, db: strip.faderDb });
    this.queue({ type: 'mixerSetPan', strip: idx, pan: strip.pan });
    this.queue({ type: 'mixerSetMute', strip: idx, on: strip.muted });
    this.queue({ type: 'mixerSetSolo', strip: idx, on: strip.soloed });
    if (!strip.isSend) for (let i = 0; i < SEND_CHANNELS.length; i++) this.send(name, i, strip.sendDbs[i] ?? FADER_MIN_DB);
    this.mirrorChain(name);
  }
  /** The strip's whole insert chain, as it stands (attach / a channel re-created): clear natively, then add + params
   *  + bypass per slot (an unported type becomes a pass-through placeholder natively, so the indices line up). */
  private mirrorChain(name: ChannelName | 'master'): void {
    const strip = name === 'master' ? this.mixer.master : this.mixer.channels.get(name);
    if (!strip) return;
    const idx = this.idxOf(name);
    if (idx < 0) return;
    this.queue({ type: 'mixerClearFx', strip: idx });
    for (let i = 0; i < strip.fx.length; i++) {
      this.fxAdd(name, i, strip.fxIds[i], strip.fx[i].params);
      if (strip.fxRoutes[i] && strip.fxRoutes[i] !== 'STEREO')
        this.queue({ type: 'mixerSetFxRoute', strip: this.idxOf(name), index: i, route: strip.fxRoutes[i] });
      if (strip.fxBypassed[i]) this.queue({ type: 'mixerSetFxBypass', strip: idx, index: i, on: true });
    }
  }
  private fxAdd(name: ChannelName | 'master', index: number, id: FxId, params: Record<string, number | string>): void {
    const strip = this.idxOf(name);
    if (strip < 0) return;
    this.queue({ type: 'mixerAddFx', strip, fx: id });
    for (const [key, value] of Object.entries(params)) this.queue({ type: 'mixerSetFxParam', strip, index, fx: id, key, value: this.fxValue(id, key, value), immediate: true });
  }
  /** A page param value as the engine takes it. Enum strings go through as-is (the shell maps them by the device's
   *  option table); the SC COMP's SOURCE is a page channel NAME here and the key strip's INDEX natively (−1 = NONE). */
  private fxValue(id: FxId, key: string, value: number | string): number | string {
    if (id !== 'sccomp' || key !== 'SOURCE') return value;
    if (typeof value !== 'string' || value === 'NONE' || value === '') return typeof value === 'number' ? value : -1;
    return this.names.get(value) ?? this.stripFor(value as ChannelName);
  }
  private idxOf(name: ChannelName | 'master'): number { return name === 'master' ? 0 : this.stripFor(name); }
  private channel(name: ChannelName, kind: 'channel' | 'send', present: boolean): void {
    if (this.detached) return;
    if (present) { this.mirror(name, kind); return; }
    const idx = this.names.get(name);
    if (idx === undefined) return;
    if (idx >= FIRST_DYNAMIC_STRIP) this.names.delete(name); // a dynamic slot goes back to the pool; fixed names keep theirs
    if (this.live.delete(idx)) this.queue({ type: 'mixerSetStrip', strip: idx, kind: 'off' });
  }
  private send(name: ChannelName, index: number, db: number): void {
    const ret = SEND_CHANNELS[index];
    if (!ret) return;
    const target = this.names.get(ret) ?? -1;
    if (target >= 0 && !this.live.has(target) && !this.detached) this.activate(target, 'send', ret); // the return exists natively even before the page mirrors it
    this.queue({ type: 'mixerSetSend', strip: this.stripFor(name), send: index, db, target });
  }
  private queue(c: AnyRecord): void {
    if (this.detached) return;
    if (typeof c.strip === 'number' && (c.strip as number) < 0) return;
    this.host.note('commands', 1);
    this.chain = this.chain.then(() => this.host.cmd(c)).then(() => {}).catch(() => {});
  }
}
