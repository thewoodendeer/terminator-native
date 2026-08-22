// ─────────────────────────────────────────────────────────────────────────────
// WHAT THE AUDIENCE HEARS.
//
// Victor's picture of going live: *"a producer who doesn't like to go live in
// his real studio — going live in your VIRTUAL studio, with your virtual avatar,
// with your own real music."* Three sources, one stream:
//
//   THE BOARD     the desk's master, the same tap a recorded take uses
//   THE COMPUTER  whatever is coming out of the machine — a beat playing in his
//                 DAW, a reference, an interface. On Windows that can be the
//                 system mix itself; on macOS it is a routed input device, and
//                 the picker below says why.
//   THE MIC       him, talking to the room
//
// ── THE LAW, WRITTEN DOWN THE DAY THE FIRST LINE WAS WRITTEN ────────────────
// **The microphone and the computer input must NEVER reach `tapMaster()` or the
// offline export renderer.** He records takes in that room and posts them; a
// friend saying "turn the hats up" landing inside a bounce is a disaster, and a
// stray desktop notification baked into an export is worse.
//
// This file makes that STRUCTURAL rather than careful. The board's master
// reaches the broadcast through `tapMasterNode(dest)` — a FAN-OUT, which adds a
// destination and changes nothing about where master already goes. The mic and
// the system capture connect ONLY to `dest`, which is a
// MediaStreamAudioDestinationNode that nothing but the peer connection reads.
// There is no edge from either of them back toward `masterGain`, so there is no
// path to the recorder and none to an export. Exports run in an entirely
// separate OfflineAudioContext, which cannot see a live input at all.
//
// The one thing to hold on to when editing: `dest` is a LEAF. Never connect it
// onward, and never connect a live input to anything else.
// ─────────────────────────────────────────────────────────────────────────────

/** The desktop shell's loopback toggles (`electron-audio-loopback`, driven the
 *  same way the Chopper's recorder drives them). Absent in the web build. */
function loopbackApi(): { enableLoopback?: () => Promise<void>; disableLoopback?: () => Promise<void> } | null {
  const w = window as unknown as { terminator?: { enableLoopback?: () => Promise<void>; disableLoopback?: () => Promise<void> } };
  return w.terminator?.enableLoopback ? w.terminator : null;
}

const IS_MAC = typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform || navigator.userAgent);

/** THE COMPUTER'S OUTPUT IS NOT ONE BUTTON, and pretending otherwise would
 *  ship a switch that does nothing on his own machine.
 *
 *  Windows/Electron can capture the system mix directly (`'system'`). **macOS
 *  cannot** — the Chopper's recorder refuses it outright on Mac for the same
 *  reason — so on a Mac the way a beat playing in Logic reaches the stream is
 *  the way it reaches every other app: routed out through a virtual device
 *  (Audio Routing Kit, BlackHole) and picked here as an INPUT. One picker
 *  covers both, and covers "an interface with a keyboard plugged into it" for
 *  free, which is a thing he will want on day two. */
export type LiveInput = { kind: 'system' } | { kind: 'device'; id: string; label: string } | null;

export interface LiveMixState {
  mic: boolean;
  /** Which device the mic uses — null is the machine's default. Set BEFORE the
   *  mic goes on, or while it is on (it re-grabs); his mic lives on channel 1
   *  of an interface, and "the default mic" on a Mac is the laptop's own. */
  micDevice: string | null;
  input: LiveInput;
  /** The two source gains, 0..2 with 1 = unity. The board's own level is not
   *  here on purpose — the mix IS the show, and balancing happens against it. */
  micLevel: number;
  inputLevel: number;
  /** Whether the system mix is capturable at all on this build + platform. */
  systemAvailable: boolean;
}

/** Whether the system mix is capturable on this build + platform — true only
 *  in the desktop shell off a Mac. The Mac answer is a routed virtual device
 *  picked as an input; see the LiveInput note above. */
export function systemCaptureAvailable(): boolean { return !!loopbackApi() && !IS_MAC; }

/** HIS SETUP, REMEMBERED. Which device is the mic, what was patched in, and
 *  where the two levels sat — so every show does not begin by rebuilding the
 *  same rig. Plain localStorage rather than the save: device ids are this
 *  MACHINE's business, and a save that roams should not carry them.
 *  What is deliberately NOT here: whether the mic was ON. An open mic is a
 *  deliberate press every time — see setMic. */
export interface LiveAudioPrefs {
  micDevice: string | null;
  input: LiveInput;
  micLevel: number;
  inputLevel: number;
}
const PREF_KEY = 'board-live-audio';
export function audioPrefs(): LiveAudioPrefs {
  const base: LiveAudioPrefs = { micDevice: null, input: null, micLevel: 1, inputLevel: 1 };
  try {
    const raw = localStorage.getItem(PREF_KEY);
    if (!raw) return base;
    const p = JSON.parse(raw) as Partial<LiveAudioPrefs>;
    return {
      micDevice: typeof p.micDevice === 'string' ? p.micDevice : null,
      input: p.input && typeof p.input === 'object' ? p.input : null,
      micLevel: clampLevel(p.micLevel, 1),
      inputLevel: clampLevel(p.inputLevel, 1),
    };
  } catch { return base; }
}
/** Written from the PORT verbs — a user's choice — never from inside LiveMix:
 *  an unplugged cable fires `ended` → `setInput(null)`, and that must not
 *  erase what he picked (next show still restores the interface). */
export function rememberAudio(patch: Partial<LiveAudioPrefs>): void {
  try { localStorage.setItem(PREF_KEY, JSON.stringify({ ...audioPrefs(), ...patch })); } catch { /* private mode */ }
}
function clampLevel(v: unknown, fallback: number): number {
  return typeof v === 'number' && isFinite(v) ? Math.min(2, Math.max(0, v)) : fallback;
}

/** Every audio input the machine will admit to, for the picker. Labels are
 *  empty until a permission has been granted once — that is the browser's rule,
 *  not ours, and the caller falls back to the id. */
let labelPrimed = false;
export async function liveInputDevices(): Promise<Array<{ id: string; label: string }>> {
  try {
    const pick = (all: MediaDeviceInfo[]) => all.filter(d => d.kind === 'audioinput' && d.deviceId)
      .map(d => ({ id: d.deviceId, label: d.label || 'input' }));
    let ins = pick(await navigator.mediaDevices.enumerateDevices());
    // A picker full of "unnamed input" is unpickable. In the DESKTOP shell the
    // permission auto-grants, so one throwaway grab unlocks every label for
    // the life of the origin — once, and never on the web build, where the
    // same call would raise a permission prompt nobody pressed for.
    if (!labelPrimed && ins.length && ins.every(d => d.label === 'input')
      && (window as unknown as { terminator?: unknown }).terminator) {
      labelPrimed = true;
      try {
        const s = await navigator.mediaDevices.getUserMedia({ audio: true });
        for (const t of s.getTracks()) t.stop();
        ins = pick(await navigator.mediaDevices.enumerateDevices());
      } catch { /* refused — ids still work, labels stay generic */ }
    }
    return ins;
  } catch { return []; }
}

/**
 * ONE STREAM OUT, built inside the BOARD'S OWN AudioContext.
 *
 * Deliberately not its own context: bringing the desk's master into a second
 * context means a MediaStream round trip (encode, jitter buffer, decode) for
 * audio that is already sitting on a node three feet away. One context also
 * means one clock, so the mic and the beat cannot drift apart.
 */
export class LiveMix {
  readonly dest: MediaStreamAudioDestinationNode;
  private micStream: MediaStream | null = null;
  private micNode: MediaStreamAudioSourceNode | null = null;
  private micId: string | null = null;
  private inStream: MediaStream | null = null;
  private inNode: MediaStreamAudioSourceNode | null = null;
  private input: LiveInput = null;
  private micGain: GainNode;
  private inGain: GainNode;
  private unTap: (() => void) | null = null;

  constructor(
    private readonly ctx: AudioContext,
    tapMasterNode: ((dest: AudioNode) => () => void) | null,
  ) {
    this.dest = ctx.createMediaStreamDestination();
    // THE BOARD → the stream. A fan-out from master: master keeps going exactly
    // where it went before, and this is one more place it also goes.
    // NULL for a SESSION mix: the project transfers and both machines render
    // it, so putting master on the wire would play the beat twice — only the
    // mic and the computer input travel between collaborators.
    this.unTap = tapMasterNode ? tapMasterNode(this.dest) : null;
    // Talking over your own beat only works if the beat is not fighting you,
    // but ducking is a decision for later — these exist so there IS a place to
    // put it, and so a hot mic can be pulled down without tearing the graph up.
    this.micGain = ctx.createGain();
    this.inGain = ctx.createGain();
    this.micGain.connect(this.dest);
    this.inGain.connect(this.dest);
  }

  get stream(): MediaStream { return this.dest.stream; }
  /** Which context this mix lives in — the board rebuilds the mix when the
   *  engine (and its context) is swapped under it; see main.ts netAudioRebind. */
  get context(): AudioContext { return this.ctx; }

  state(): LiveMixState {
    return {
      mic: !!this.micNode, micDevice: this.micId, input: this.input,
      micLevel: this.micGain.gain.value, inputLevel: this.inGain.gain.value,
      systemAvailable: systemCaptureAvailable(),
    };
  }

  /** The talk-over-the-beat balance the constructor comment promised a place
   *  for. 0..2 — up to a doubling, which is +6dB of "they can't hear me". */
  setMicLevel(v: number): void { this.micGain.gain.value = clampLevel(v, 1); }
  setInputLevel(v: number): void { this.inGain.gain.value = clampLevel(v, 1); }

  /** WHICH mic. `null` = the machine's default. A live mic re-grabs on the new
   *  device in place — the audience hears a swap, not a dropout-and-a-press. */
  async setMicDevice(id: string | null): Promise<boolean> {
    this.micId = id;
    if (!this.micNode) return false;
    await this.setMic(false);
    return this.setMic(true);
  }

  /** THE MICROPHONE. Off by default and on by a deliberate press — an open mic
   *  beside loud nearfields is feedback, and a producer who does not like going
   *  live should not discover he has been broadcasting the room. */
  /** Bumped by every setMic call. A grab that lands after a newer call — a
   *  double-tap, `setMicDevice` re-grabbing, or OFF pressed while ON's
   *  getUserMedia is still up — is stopped, not connected: two grabs in flight
   *  used to leave the first stream connected to micGain with nothing holding
   *  it (a hot mic OFF could not reach), and OFF during a pending ON returned
   *  early and the mic then came on anyway. */
  private micGen = 0;

  async setMic(on: boolean): Promise<boolean> {
    const gen = ++this.micGen;
    if (!on) {
      this.micNode?.disconnect();
      this.micNode = null;
      for (const t of this.micStream?.getTracks() ?? []) t.stop();
      this.micStream = null;
      return false;
    }
    if (this.micNode) return true;
    try {
      // Echo cancellation ON: the monitors are in the room the mic is in.
      const s = await navigator.mediaDevices.getUserMedia({
        audio: {
          ...(this.micId ? { deviceId: { exact: this.micId } } : {}),
          echoCancellation: true, noiseSuppression: true, autoGainControl: true,
        },
      });
      if (gen !== this.micGen || this.micNode) {
        // Superseded while we waited — this stream is nobody's.
        for (const t of s.getTracks()) t.stop();
        return !!this.micNode;
      }
      this.micStream = s;
      this.micNode = this.ctx.createMediaStreamSource(s);
      this.micNode.connect(this.micGain);
      return true;
    } catch {
      return !!this.micNode;
    }
  }

  /** THE COMPUTER, INTO THE VIRTUAL STUDIO — a beat playing in his DAW, a
   *  reference, an interface with a keyboard on it. `null` unpatches. Returns
   *  what is actually patched, which is not always what was asked for. */
  private inGen = 0;

  async setInput(want: LiveInput): Promise<LiveInput> {
    const gen = ++this.inGen;
    this.dropInput();
    if (!want) { this.input = null; return null; }
    try {
      let s: MediaStream;
      if (want.kind === 'system') {
        const api = loopbackApi();
        // Refused rather than attempted: on a Mac this path returns silence or
        // an error, and a switch that flips on and broadcasts nothing is worse
        // than one that says it cannot.
        if (!api?.enableLoopback || IS_MAC) { this.input = null; return null; }
        await api.enableLoopback();
        try {
          // Video is requested because some builds refuse an audio-only capture
          // outright, and dropped immediately: nothing here wants a picture —
          // the audience renders the room themselves.
          s = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
        } finally {
          // Toggled OFF straight after the grab, exactly as the Chopper's
          // recorder does it — the flag is for the request, not the session.
          await api.disableLoopback?.().catch(() => { /* never got there */ });
        }
        for (const t of s.getVideoTracks()) { t.stop(); s.removeTrack(t); }
        if (!s.getAudioTracks().length) { this.input = null; return null; }
      } else {
        s = await navigator.mediaDevices.getUserMedia({
          // A routed desk output is not a voice: every "helpful" processor has
          // to be off or the beat arrives gated and pumping.
          audio: { deviceId: { exact: want.id }, echoCancellation: false, noiseSuppression: false, autoGainControl: false },
        });
      }
      if (gen !== this.inGen) {          // a newer setInput won while we waited
        for (const t of s.getTracks()) t.stop();
        return this.input;
      }
      this.inStream = s;
      this.inNode = this.ctx.createMediaStreamSource(s);
      this.inNode.connect(this.inGain);
      // Pulling the cable — or stopping the capture from the browser's own bar
      // — has to leave the button honest.
      s.getAudioTracks()[0]?.addEventListener('ended', () => { void this.setInput(null); });
      this.input = want;
      return want;
    } catch {
      if (gen === this.inGen) { this.dropInput(); this.input = null; return null; }
      return this.input;                 // a newer patch already owns the graph
    }
  }

  private dropInput(): void {
    this.inNode?.disconnect();
    this.inNode = null;
    for (const t of this.inStream?.getTracks() ?? []) t.stop();
    this.inStream = null;
  }

  close(): void {
    void this.setMic(false);
    this.dropInput();
    this.input = null;
    this.unTap?.();
    this.unTap = null;
    try { this.micGain.disconnect(); } catch { /* already gone */ }
    try { this.inGain.disconnect(); } catch { /* already gone */ }
    try { this.dest.disconnect(); } catch { /* a leaf, but be certain */ }
  }
}
