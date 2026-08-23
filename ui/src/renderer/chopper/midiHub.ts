// MIDI HUB — the one place Terminator opens Web MIDI.
//
// Before this, each view called navigator.requestMIDIAccess itself and set
// `input.onmidimessage = …` — a single-slot property that the last caller
// wins, with no status the user could see when it silently failed (denied
// permission, no device, a port left `connection: closed`). Now:
//   • ONE requestMIDIAccess, re-requestable (rescan) — a dismissed browser
//     prompt is not the end of the story.
//   • per-port `addEventListener('midimessage')` — many subscribers, none can
//     clobber another; ports are opened explicitly (`port.open()`).
//   • hot-plug via onstatechange, plus a rescan when the tab becomes visible
//     again (some hosts drop the enumeration while backgrounded).
//   • a STATUS the UI can show ('unsupported' | 'requesting' | 'denied' |
//     'ready' | 'nodevice'), the connected input names, and the LAST MESSAGE
//     (a monitor: "CC 74 = 100 · MPK mini") + an activity timestamp for an LED.
// Views subscribe with onMessage(fn) and keep their own routing logic.

export type MidiStatus = 'unsupported' | 'requesting' | 'denied' | 'ready' | 'nodevice';
export interface MidiLastMsg { at: number; status: number; d1: number; d2: number; port: string; text: string }
export interface MidiHubState {
  status: MidiStatus;
  inputs: string[];        // connected input names
  last: MidiLastMsg | null;
  activityAt: number;      // performance.now() of the last message
  error: string | null;
}

type MsgHandler = (e: MIDIMessageEvent) => void;

function describe(status: number, d1: number, d2: number): string {
  if (status === 0xf8) return 'clock';
  if (status === 0xfa) return 'START';
  if (status === 0xfb) return 'CONTINUE';
  if (status === 0xfc) return 'STOP';
  if (status === 0xfe) return 'active sensing';
  const cmd = status & 0xf0, ch = (status & 0x0f) + 1;
  if (cmd === 0x90 && d2 > 0) return `note ${d1} on · vel ${d2} · ch ${ch}`;
  if (cmd === 0x80 || cmd === 0x90) return `note ${d1} off · ch ${ch}`;
  if (cmd === 0xb0) return `CC ${d1} = ${d2} · ch ${ch}`;
  if (cmd === 0xe0) return `pitch bend ${((d2 << 7) | d1) - 8192} · ch ${ch}`;
  if (cmd === 0xd0) return `aftertouch ${d1} · ch ${ch}`;
  if (cmd === 0xc0) return `program ${d1} · ch ${ch}`;
  return `status 0x${status.toString(16)}`;
}

class MidiHub {
  private access: MIDIAccess | null = null;
  private bound = new Map<MIDIInput, MsgHandler>();
  private handlers = new Set<MsgHandler>();
  private listeners = new Set<(s: MidiHubState) => void>();
  private state: MidiHubState = { status: 'requesting', inputs: [], last: null, activityAt: 0, error: null };
  private started = false;
  private requesting: Promise<void> | null = null;

  getState(): MidiHubState { return this.state; }
  /** Connected MIDI OUTPUT ports (opened on first ask) — the clock sender
   *  filters these by the Preferences toggles. Empty until access is granted. */
  outputs(): MIDIOutput[] {
    const acc = this.access; if (!acc) return [];
    const out: MIDIOutput[] = [];
    acc.outputs.forEach((o) => {
      if (o.state !== 'connected') return;
      if (o.connection !== 'open') { try { void o.open().catch(() => { /* */ }); } catch { /* */ } }
      out.push(o);
    });
    return out;
  }
  subscribe(fn: (s: MidiHubState) => void): () => void { this.listeners.add(fn); fn(this.state); return () => { this.listeners.delete(fn); }; }

  /** NATIVE (Terminator 3.0, Phase 3.5): a message the C++ MidiHub mirrored from a device (`terminator.midiMessage`),
   *  dispatched to the same handlers as a Web MIDI event — the page keeps ONE MIDI router (ChopperView's onMessage:
   *  transport, CC learn, bass MIDI IN, DRUM PADS, learn, pads). The event carries `timeStamp` in performance ms (the
   *  driver's stamp mapped through NativeClock), `target.id/name` = the port, and `nativeOwned: true` so the pad path
   *  does not trigger the native pad a second time (the engine already played it on the direct path). */
  injectNative(msg: { data: ArrayLike<number>; timeStamp: number; portId: string; portName: string }): void {
    const data = Uint8Array.from(msg.data);
    const port = { id: msg.portId, name: msg.portName } as unknown as MIDIInput;
    const e = { data, timeStamp: msg.timeStamp, target: port, currentTarget: port, nativeOwned: true, type: 'midimessage' } as unknown as MIDIMessageEvent;
    this.nativeCount++;
    this.dispatch(e, port);
  }
  /** Messages injected from the native hub (diagnostic). */
  nativeCount = 0;
  private set(patch: Partial<MidiHubState>): void { this.state = { ...this.state, ...patch }; for (const l of this.listeners) l(this.state); }

  /** Add a message handler. Starts the hub on first use. */
  onMessage(fn: MsgHandler): () => void {
    this.handlers.add(fn);
    this.start();
    return () => { this.handlers.delete(fn); };
  }

  /** Request access once (idempotent). */
  start(): void {
    if (this.started) return;
    this.started = true;
    if (typeof navigator === 'undefined' || !navigator.requestMIDIAccess) {
      this.set({ status: 'unsupported', error: 'Web MIDI is not available in this browser' });
      return;
    }
    void this.request();
    // Come back to the tab → make sure the ports are still bound (some hosts
    // re-enumerate while hidden). Cheap: rebind + refresh the list.
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') this.rebind(); });
    }
  }

  /** Ask again — the button behind "RESCAN": a dismissed permission prompt, a
   *  device plugged in that never showed up, or a stuck port. */
  rescan(): Promise<void> {
    if (!this.started) { this.start(); return this.requesting ?? Promise.resolve(); }
    if (this.access) { this.rebind(); return Promise.resolve(); }
    return this.request();
  }

  private request(): Promise<void> {
    if (this.requesting) return this.requesting;
    this.set({ status: 'requesting', error: null });
    this.requesting = navigator.requestMIDIAccess({ sysex: false }).then((acc) => {
      this.access = acc;
      acc.onstatechange = () => this.rebind();
      this.rebind();
    }).catch((err: any) => {
      this.access = null;
      const msg = err?.name === 'NotAllowedError' || err?.name === 'SecurityError'
        ? 'MIDI access was blocked — allow it in the browser’s site settings (the icon left of the address bar), then RESCAN'
        : `MIDI failed to open: ${err?.message ?? err}`;
      this.set({ status: 'denied', inputs: [], error: msg });
    }).finally(() => { this.requesting = null; });
    return this.requesting;
  }

  /** (Re)attach the dispatcher to every input, open the ports, refresh the list. */
  private rebind(): void {
    const acc = this.access; if (!acc) return;
    const seen = new Set<MIDIInput>();
    const names: string[] = [];
    acc.inputs.forEach((input) => {
      seen.add(input);
      if (!this.bound.has(input)) {
        const h: MsgHandler = (e) => this.dispatch(e, input);
        input.addEventListener('midimessage', h as EventListener);
        this.bound.set(input, h);
      }
      // A port can sit connected-but-closed; opening is what makes it deliver.
      if (input.state === 'connected' && input.connection !== 'open') { try { void input.open().catch(() => { /* */ }); } catch { /* */ } }
      if (input.state === 'connected') names.push(input.name ?? 'MIDI input');
    });
    // forget ports that vanished from the map entirely
    for (const [input, h] of [...this.bound]) {
      if (!seen.has(input)) { try { input.removeEventListener('midimessage', h as EventListener); } catch { /* */ } this.bound.delete(input); }
    }
    this.set({ status: names.length ? 'ready' : 'nodevice', inputs: names, error: null });
  }

  private dispatch(e: MIDIMessageEvent, port: MIDIInput): void {
    const d = e.data;
    if (d && d.length) {
      const status = d[0], d1 = d[1] ?? 0, d2 = d[2] ?? 0;
      // don't let the clock flood the monitor
      if (status !== 0xf8 && status !== 0xfe) {
        // Mutate WITHOUT notifying: a CC stream would re-render the whole view
        // per message. The status pill polls this at ~10 Hz for the LED/monitor.
        this.state = { ...this.state, last: { at: performance.now(), status, d1, d2, port: port.name ?? '', text: describe(status, d1, d2) }, activityAt: performance.now() };
      }
    }
    for (const h of this.handlers) { try { h(e); } catch (err) { console.warn('[MIDI] handler threw', err); } }
  }
  /** NATIVE: the C++ hub's input list (names) — shown where the Web MIDI list would be. */
  setNativeInputs(names: string[]): void {
    this.set({ status: names.length ? 'ready' : 'nodevice', inputs: names, error: null });
  }
}

export const midiHub = new MidiHub();
