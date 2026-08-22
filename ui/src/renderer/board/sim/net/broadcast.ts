// ─────────────────────────────────────────────────────────────────────────────
// GOING LIVE — the shape that survives becoming popular.
//
// Victor's call: ship the free peer-to-peer version, and build it so the day it
// needs a media server is a SWAP, not a rewrite. Everything in this file exists
// to make that true, and the way it does it is by being ruthless about one
// thing: **the host never knows how many people are watching.**
//
// ── WHY IT IS NOT VIDEO ─────────────────────────────────────────────────────
// A video stream can only ever show the camera the streamer picked. The whole
// idea — peek in and look through the board's cameras — is impossible with one.
// So a viewer's own board draws the room, from a stream of ROOM STATE, and
// points whichever of the eight cameras they like. The camera is theirs, which
// is why it is free and instant. Only the SOUND has to really travel, and that
// is also the protection: a viewer hears the mix and never receives the stems.
//
// ── THE FOUR RULES THAT MAKE 1,000 VIEWERS POSSIBLE LATER ───────────────────
//
// 1. SERIALISE ONCE, FAN OUT. `publish` takes a STRING that is already encoded.
//    The existing session code (`netSyncMix`) calls `send()` per peer, which is
//    correct for one guest and is the CPU cliff at a thousand: JSON.stringify
//    running a thousand times per tick. A sink is handed one buffer and does
//    what it likes with it.
//
// 2. THE HOST COUNTS NOTHING. `viewers()` is a number the transport reports.
//    Peer-to-peer it happens to be the size of a connection map; through a
//    media server it is a figure the server sends. No code above this line may
//    ever iterate viewers, because at scale there is no list to iterate.
//
// 3. LATE JOINERS GET A KEYFRAME, NOT A REPLAY. Somebody who taps a live room
//    twenty minutes in cannot be caught up by replaying deltas, and at scale
//    the host cannot answer per-viewer requests. So the host emits a full
//    snapshot on a cadence, the transport CACHES THE LATEST ONE, and a new
//    subscriber is handed that before any delta. This is how real broadcast
//    works and it has to be designed in now — bolting it on later means every
//    viewer joining a busy room sees a black room until the next keyframe.
//
// 4. CHAT IS A CHANNEL, NOT N CONNECTIONS. Messages arrive at the host as one
//    inbound stream. Peer-to-peer that is a merge of the data channels; through
//    a server it is one subscription. The host reads chat the same way either
//    way, so the direction that breaks first at scale — a thousand people
//    typing at one machine — never reaches game code.
//
// Nothing here opens a socket. The transports do (P2P today, an SFU when the
// bill is worth paying), and they are the only part that changes.
// ─────────────────────────────────────────────────────────────────────────────

/** Everything a viewer needs to draw the room. Deliberately small and flat:
 *  this is diffed every tick, and a shape that is expensive to compare is a
 *  shape that gets compared less often. */
export interface LiveState {
  /** Whose studio this is and what they are wearing. A viewer draws the
   *  streamer as an ordinary avatar body — the same one a session guest gets —
   *  so the body slug has to travel. Rarely changes, costs two string compares
   *  a tick, and without it the room has nobody in it. */
  host: { name: string; body: string };
  /** Where the streamer is standing, and which room they are in. `seated`
   *  because a viewer draws them as a real body: without it somebody who sits
   *  down at their own desk is drawn STANDING IN THE CHAIR for the whole show. */
  at: { x: number; z: number; yaw: number; scene: string; seated?: boolean };
  /** Transport, so a viewer's playhead matches the stream they are hearing. */
  playing: boolean;
  beat: number;
  bpm: number;
  /** The beat's name, for the overlay. */
  name: string;
  /** The desk: one number per control, flattened. Viewers draw the console
   *  moving — that IS the show — but they never receive the stems. */
  mix: number[];
  /** THE MACRO KNOBS — comp, hf, mf, lf, sat — five per channel, master last.
   *  Victor, watching: "i can see faders move not the knobs as the viewer."
   *
   *  `mix` deliberately carries only fader/pan/cut/solo, and the reasoning
   *  written there still holds for the pages BEHIND the knobs (a compressor's
   *  release time is not a performance). But the five macro knobs are on the
   *  desk, under his hands, and turning one IS the performance. So they travel
   *  — and only they.
   *
   *  A SEPARATE ARRAY rather than a wider `mix` stride on purpose: widening the
   *  stride would make an old host and a new viewer disagree about where each
   *  channel starts, and the failure mode is a silently wrong desk rather than
   *  an obvious one. A field that is simply absent is unmistakable. */
  knobs: number[];
  /** The room: lamp, overheads, curtain, screens. Same keys the session sync
   *  already uses, because it is the same room. */
  env: Record<string, number | string | boolean>;
  /** THE BRIDGE METERS. A viewer has no stems, so their own analysers read
   *  SILENCE and the desk sits dead through the whole show — Victor, watching
   *  from the other machine: "their mixing board isnt doing anything".
   *
   *  One integer 0..100 per channel with the master last. Integers on purpose:
   *  a float meter changes in the seventh decimal every tick, which would make
   *  `diffLive` fire forever and delete the "a still room costs nothing" rule
   *  that keeps an idle stream free. Quantised, a quiet desk is genuinely
   *  unchanged and sends nothing. */
  vu: number[];
  /** WHAT IS ON THEIR SCREENS. Not pixels — that would be video, and the whole
   *  design of this file is that it is not. What travels is WHICH PAGE they are
   *  on; the viewer's own board draws that page from state it already has
   *  (`mix`, `env`, bpm, the beat's name), which is why this costs six small
   *  fields rather than a second stream.
   *
   *  The honest limit: page IDENTITY travels, page CONTENT is drawn locally. A
   *  page showing something only the host's machine knows (their export list,
   *  their recordings) will render the viewer's own. The pages worth watching —
   *  home, a channel page, the master bus, tape, lighting — are all driven by
   *  state that IS on the wire, so they read true. */
  screen: {
    /** Monitor mode + which knob's page, when it is on one. */
    mon: string; mch: number; mp: string;
    /** The bridge LCD, same shape. */
    lcd: string; lch: number; lp: string;
  };
  /** THE STREAMER TALKING BACK. Chat is one-way by rule 4 — a thousand people
   *  typing at one machine is the direction that breaks first — so a reply does
   *  not travel back down a chat channel that does not exist. It travels as
   *  what it actually is: a line spoken in the room, drawn in the same bubble
   *  over the same head the crew use. `n` counts, so saying the same words
   *  twice is two lines rather than a diff that finds nothing. */
  say?: { text: string; n: number };
}

export type LiveFrame =
  /** A full snapshot. Cached by the transport and handed to every new viewer
   *  before anything else — see rule 3. */
  | { k: 'key'; n: number; s: LiveState }
  /** Only what moved since frame `n − 1`. */
  | { k: 'd'; n: number; s: Partial<LiveState> };

export interface LiveChat {
  /** Who said it — a handle, not an identity. Chat is a public room. */
  who: string;
  text: string;
}

/**
 * THE HOST'S END. Note what is absent: no `viewers` array, no `send(to, msg)`,
 * no way to address one person. That absence is the architecture.
 */
export interface BroadcastSink {
  /** Already-encoded frame. See rule 1. */
  publish(encoded: string): void;
  /** The one audio track everybody hears: the board's master, plus whatever the
   *  streamer has patched in (their DAW, their microphone). Published ONCE. */
  publishAudio(stream: MediaStream | null): void;
  /** How many are watching — reported, never counted here. See rule 2. */
  viewers(): number;
  /** Everything anybody typed, as one stream. See rule 4. */
  onChat(fn: (msg: LiveChat) => void): () => void;
  close(): void;
}

/** THE VIEWER'S END. One way, on purpose: a viewer is not a session guest and
 *  must never reach the permission code. Watching is not joining. */
export interface BroadcastSource {
  subscribe(room: string): Promise<void>;
  onFrame(fn: (frame: LiveFrame) => void): () => void;
  onAudio(fn: (stream: MediaStream) => void): () => void;
  say(text: string): void;
  close(): void;
}

/** How often a full snapshot goes out, in ticks of `LiveDirector.tick`. At the
 *  60ms cadence below that is a keyframe every ~1.8s — the worst a late viewer
 *  waits before the room is correct, and small enough that a transport cache
 *  makes even that invisible. */
const KEYFRAME_EVERY = 30;

/**
 * THE HOST SIDE OF A BROADCAST. Owns the diff, the keyframe cadence, and the
 * single serialisation. Give it a sink and call `tick(state)`; it does not know
 * whether one person or ten thousand are on the other side, and that is the
 * whole point.
 */
export class LiveDirector {
  private last: LiveState | null = null;
  private n = 0;
  private sinceKey = 0;
  /** Counted for the probe: proof that the work per tick does not grow with
   *  the audience. */
  encodes = 0;

  constructor(private readonly sink: BroadcastSink) {}

  get frame(): number { return this.n; }
  get viewers(): number { return this.sink.viewers(); }

  /**
   * One tick of the show. Emits a keyframe when it is due (or when there is no
   * previous state to diff against) and a delta otherwise — and encodes EXACTLY
   * ONCE either way, however many people are watching.
   */
  tick(state: LiveState): void {
    const keyDue = !this.last || this.sinceKey >= KEYFRAME_EVERY;
    let frame: LiveFrame;
    if (keyDue) {
      frame = { k: 'key', n: ++this.n, s: state };
      this.sinceKey = 0;
    } else {
      const patch = diffLive(this.last as LiveState, state);
      this.sinceKey++;
      // NOTHING MOVED. A still room should cost nothing at all — the keyframe
      // cadence is what keeps a late viewer correct, so silence is safe.
      if (!patch) return;
      frame = { k: 'd', n: ++this.n, s: patch };
    }
    this.last = cloneLive(state);
    this.encodes++;
    this.sink.publish(JSON.stringify(frame));
  }

  audio(stream: MediaStream | null): void { this.sink.publishAudio(stream); }
  onChat(fn: (msg: LiveChat) => void): () => void { return this.sink.onChat(fn); }
  stop(): void { this.sink.close(); }
}

function cloneLive(s: LiveState): LiveState {
  return {
    ...s, host: { ...s.host }, at: { ...s.at }, mix: s.mix.slice(), knobs: s.knobs.slice(), env: { ...s.env },
    vu: s.vu.slice(), screen: { ...s.screen },
    say: s.say ? { ...s.say } : undefined,
  };
}

/** What changed. Returns null when nothing did, which is the common case in a
 *  room where somebody is thinking. */
export function diffLive(a: LiveState, b: LiveState): Partial<LiveState> | null {
  const out: Partial<LiveState> = {};
  let any = false;
  if (a.host.name !== b.host.name || a.host.body !== b.host.body) { out.host = { ...b.host }; any = true; }
  if (a.at.x !== b.at.x || a.at.z !== b.at.z || a.at.yaw !== b.at.yaw || a.at.scene !== b.at.scene
    || !!a.at.seated !== !!b.at.seated) {
    out.at = { ...b.at }; any = true;
  }
  if (a.playing !== b.playing) { out.playing = b.playing; any = true; }
  // The playhead is sent on a CHANGE OF STATE, never as a stream — the session
  // sync learned this the expensive way (a re-seek storm at five messages a
  // second, every stem re-cut). A viewer's own clock runs between keyframes.
  if (Math.abs(a.beat - b.beat) > 1) { out.beat = b.beat; any = true; }
  if (a.bpm !== b.bpm) { out.bpm = b.bpm; any = true; }
  if (a.name !== b.name) { out.name = b.name; any = true; }
  if (a.mix.length !== b.mix.length) { out.mix = b.mix.slice(); any = true; }
  else {
    for (let i = 0; i < a.mix.length; i++) {
      if (a.mix[i] !== b.mix[i]) { out.mix = b.mix.slice(); any = true; break; }
    }
  }
  // Only moves when a hand turns one, so this is quiet between tweaks.
  if (a.knobs.length !== b.knobs.length) { out.knobs = b.knobs.slice(); any = true; }
  else {
    for (let i = 0; i < a.knobs.length; i++) {
      if (a.knobs[i] !== b.knobs[i]) { out.knobs = b.knobs.slice(); any = true; break; }
    }
  }
  for (const k of Object.keys(b.env)) {
    if (a.env[k] !== b.env[k]) { out.env = { ...b.env }; any = true; break; }
  }
  // Quantised, so this genuinely stops firing on a still desk — see LiveState.
  if (a.vu.length !== b.vu.length) { out.vu = b.vu.slice(); any = true; }
  else {
    for (let i = 0; i < a.vu.length; i++) {
      if (a.vu[i] !== b.vu[i]) { out.vu = b.vu.slice(); any = true; break; }
    }
  }
  if (a.screen.mon !== b.screen.mon || a.screen.mch !== b.screen.mch || a.screen.mp !== b.screen.mp
    || a.screen.lcd !== b.screen.lcd || a.screen.lch !== b.screen.lch || a.screen.lp !== b.screen.lp) {
    out.screen = { ...b.screen }; any = true;
  }
  if ((a.say?.n ?? 0) !== (b.say?.n ?? 0)) { out.say = b.say; any = true; }
  return any ? out : null;
}

/** Fold a delta onto what a viewer already has. */
export function applyLive(base: LiveState, patch: Partial<LiveState>): LiveState {
  return {
    ...base,
    ...patch,
    host: patch.host ? { ...patch.host } : base.host,
    at: patch.at ? { ...patch.at } : base.at,
    mix: patch.mix ? patch.mix.slice() : base.mix,
    knobs: patch.knobs ? patch.knobs.slice() : base.knobs,
    env: patch.env ? { ...patch.env } : base.env,
    vu: patch.vu ? patch.vu.slice() : base.vu,
    screen: patch.screen ? { ...patch.screen } : base.screen,
  };
}

// ── the free transport, and the seam the paid one slots into ────────────────

/**
 * IN-PROCESS BOTH ENDS. Not a stub — it enforces the same contract a real
 * transport must: it caches the latest keyframe and hands it to a subscriber
 * BEFORE any delta, it reports a viewer count the host never computed, and it
 * merges every viewer's chat into one inbound stream.
 *
 * A real transport is this class with a socket in it. That is the swap.
 */
const LIVE_ROOMS = new Map<string, LoopbackSink>();

export class LoopbackSink implements BroadcastSink {
  private readonly subs = new Set<(f: LiveFrame) => void>();
  private readonly chatFns = new Set<(m: LiveChat) => void>();
  private readonly audioFns = new Set<(s: MediaStream) => void>();
  /** RULE 3, enforced by the transport rather than trusted to the host. */
  private lastKey: string | null = null;
  private stream: MediaStream | null = null;

  constructor(private readonly room: string) { LIVE_ROOMS.set(room, this); }

  publish(encoded: string): void {
    if (encoded.startsWith('{"k":"key"')) this.lastKey = encoded;
    const frame = JSON.parse(encoded) as LiveFrame;
    for (const fn of [...this.subs]) setTimeout(() => fn(frame), 0);
  }

  publishAudio(stream: MediaStream | null): void {
    this.stream = stream;
    if (!stream) return;
    for (const fn of [...this.audioFns]) setTimeout(() => fn(stream), 0);
  }

  viewers(): number { return this.subs.size; }

  onChat(fn: (m: LiveChat) => void): () => void {
    this.chatFns.add(fn);
    return () => { this.chatFns.delete(fn); };
  }

  close(): void {
    this.subs.clear();
    this.chatFns.clear();
    this.audioFns.clear();
    LIVE_ROOMS.delete(this.room);
  }

  /** Transport-internal: what a `LoopbackViewer` calls. */
  _join(onFrame: (f: LiveFrame) => void, onAudio: (s: MediaStream) => void): () => void {
    this.subs.add(onFrame);
    this.audioFns.add(onAudio);
    // The cached keyframe FIRST — a viewer who arrives between keyframes must
    // not sit in front of an empty room.
    if (this.lastKey) { const k = this.lastKey; setTimeout(() => onFrame(JSON.parse(k) as LiveFrame), 0); }
    if (this.stream) { const s = this.stream; setTimeout(() => onAudio(s), 0); }
    return () => { this.subs.delete(onFrame); this.audioFns.delete(onAudio); };
  }

  _say(msg: LiveChat): void {
    for (const fn of [...this.chatFns]) setTimeout(() => fn(msg), 0);
  }
}

export class LoopbackViewer implements BroadcastSource {
  private sink: LoopbackSink | null = null;
  private off: (() => void) | null = null;
  private readonly frameFns = new Set<(f: LiveFrame) => void>();
  private readonly audioFns = new Set<(s: MediaStream) => void>();

  constructor(private readonly who: string) {}

  async subscribe(room: string): Promise<void> {
    const sink = LIVE_ROOMS.get(room);
    if (!sink) throw new Error('that room is not live');
    this.sink = sink;
    this.off = sink._join(
      (f) => { for (const fn of [...this.frameFns]) fn(f); },
      (s) => { for (const fn of [...this.audioFns]) fn(s); },
    );
  }

  onFrame(fn: (f: LiveFrame) => void): () => void {
    this.frameFns.add(fn);
    return () => { this.frameFns.delete(fn); };
  }

  onAudio(fn: (s: MediaStream) => void): () => void {
    this.audioFns.add(fn);
    return () => { this.audioFns.delete(fn); };
  }

  say(text: string): void {
    const t = text.trim().slice(0, 200);
    if (t) this.sink?._say({ who: this.who, text: t });
  }

  close(): void {
    this.off?.();
    this.off = null;
    this.frameFns.clear();
    this.audioFns.clear();
    this.sink = null;
  }
}

/**
 * A VIEWER'S COPY OF THE ROOM. Keeps the last state, folds deltas onto it, and
 * ignores a delta that arrives before the first keyframe — which is exactly
 * what a viewer joining mid-show sees for the few milliseconds before the
 * cached snapshot lands.
 */
export class LiveWatcher {
  state: LiveState | null = null;
  /** Frames dropped for want of a keyframe — a probe reads this to prove the
   *  cache is doing its job rather than the viewer being lucky. */
  dropped = 0;

  feed(frame: LiveFrame): void {
    if (frame.k === 'key') { this.state = frame.s; return; }
    if (!this.state) { this.dropped++; return; }
    this.state = applyLive(this.state, frame.s);
  }
}
