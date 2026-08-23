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
 *  Honest boundary (4.1): inserts / the console stage / PDC are still the page's Web Audio graph — which is NOT what
 *  is heard natively (the sources are in the engine). Phase 4.2 ports the FX; until then the native mix is dry.
 */
import { MixerEngine, ChannelName, setMixerNativeSink, SEND_CHANNELS, FADER_MIN_DB } from '../../mixer/MixerEngine';

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
    });
    // the whole page mixer, as it stands: every strip + the master + the CLICK strip + the sources
    for (const [name, strip] of this.mixer.channels) this.mirror(name, strip.isSend ? 'send' : 'channel');
    this.queue({ type: 'mixerSetFader', strip: 0, db: this.mixer.master.faderDb });
    this.activate(CLICK_STRIP, 'channel');
    this.queue({ type: 'mixerSetFader', strip: CLICK_STRIP, db: 0 });
    this.queue({ type: 'setSourceStrip', source: 'click', strip: CLICK_STRIP });
    if (this.mixer.channels.has('bass')) this.queue({ type: 'setSourceStrip', source: 'bass', strip: this.stripFor('bass') });
  }

  detach(): void {
    this.detached = true;
    setMixerNativeSink(null);
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
    if (have !== undefined) { if (!this.live.has(have) && !this.detached) this.activate(have, name.startsWith('send') ? 'send' : 'channel'); return have; }
    const used = new Set(this.names.values());
    for (let i = FIRST_DYNAMIC_STRIP; i < MAX_STRIPS; i++) {
      if (used.has(i)) continue;
      this.names.set(name, i);
      this.activate(i, 'channel');
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
    if (mx && typeof mx === 'object') this.latestMixer = mx as AnyRecord;
  }

  // ── the mirror ──
  private activate(idx: number, kind: 'channel' | 'send'): void {
    if (idx < 0 || idx >= MAX_STRIPS || this.live.has(idx)) return;
    this.live.add(idx);
    this.host.note('strips', 1);
    this.queue({ type: 'mixerSetStrip', strip: idx, kind });
  }
  private mirror(name: ChannelName, kind: 'channel' | 'send'): void {
    const strip = this.mixer.channels.get(name);
    if (!strip) return;
    const idx = this.stripFor(name);
    if (idx < 0) return;
    if (!this.live.has(idx)) this.activate(idx, kind);
    this.queue({ type: 'mixerSetFader', strip: idx, db: strip.faderDb });
    this.queue({ type: 'mixerSetPan', strip: idx, pan: strip.pan });
    this.queue({ type: 'mixerSetMute', strip: idx, on: strip.muted });
    this.queue({ type: 'mixerSetSolo', strip: idx, on: strip.soloed });
    if (!strip.isSend) for (let i = 0; i < SEND_CHANNELS.length; i++) this.send(name, i, strip.sendDbs[i] ?? FADER_MIN_DB);
  }
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
    if (target >= 0 && !this.live.has(target) && !this.detached) this.activate(target, 'send'); // the return exists natively even before the page mirrors it
    this.queue({ type: 'mixerSetSend', strip: this.stripFor(name), send: index, db, target });
  }
  private queue(c: AnyRecord): void {
    if (this.detached) return;
    if (typeof c.strip === 'number' && (c.strip as number) < 0) return;
    this.host.note('commands', 1);
    this.chain = this.chain.then(() => this.host.cmd(c)).then(() => {}).catch(() => {});
  }
}
