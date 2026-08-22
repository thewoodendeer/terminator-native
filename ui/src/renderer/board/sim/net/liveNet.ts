// ─────────────────────────────────────────────────────────────────────────────
// GOING LIVE — the transport. Peer-to-peer today, a media server the day the
// bill is worth paying, and `broadcast.ts` cannot tell the difference.
//
// That file defined the shape and proved it in one process (`LoopbackSink`).
// This one is the same contract with real sockets in it: a `BroadcastSink` that
// is a fan of `RTCPeerConnection`s, and a `BroadcastSource` that is one.
//
// ── WHY THE STAGE IS ITS OWN ROOM ON THE RELAY ──────────────────────────────
// The 2-player handshake (`/room/…`) forwards blindly to everybody and caps at
// four sockets, which is exactly right for two people meeting. A show is the
// opposite shape: one host and many strangers who must never hear each other,
// and a knock that has to reach ONE machine rather than the room. So the stage
// gets its own path (`/live/…`), where the relay routes by the `to` field and
// anything unaddressed goes to the host.
//
// ── WHY THIS ONE TRICKLES ICE AND THE INVITE CODES DO NOT ───────────────────
// `NetSession` gathers every candidate before handing back a code, because a
// human copies one string and will not copy a second. Here there IS a live
// channel between the two machines, so the offer goes out immediately and the
// candidates follow it. That is the difference between tapping a live room and
// being in it, and tapping a live room and watching a spinner for four seconds.
// Both sides buffer candidates that arrive before the description they belong
// to — the relay makes no ordering promise and the answer is the slower message.
//
// ── THE CAP IS UPLOAD, NOT POLICY ───────────────────────────────────────────
// Every viewer is a separate audio encode out of one home connection. A dozen
// is comfortable; a hundred is not, and no amount of client code changes that.
// `seats` is that ceiling, stated in one place — it is the number an SFU swap
// exists to delete, and until then a room that is full says so.
//
// Rule 2 from broadcast.ts is load-bearing here: `viewers()` is the size of the
// connection map, and nothing above this file is allowed to see the map.
// ─────────────────────────────────────────────────────────────────────────────

import { LIVE_AUDIO_BITRATE, tuneAudioSender, tunedDescription } from './audioQuality';
import type { BroadcastSink, BroadcastSource, LiveChat, LiveFrame } from './broadcast';
import { iceConfig } from './ice';
import { waitForIce } from './session';
import type { RoomId } from './signal';
import { WsRelay } from './wsSignal';

/** What travels the stage channel. Every message either carries `to` (the relay
 *  routes it to that seat) or does not (the relay routes it to the host). */
export type StageMsg =
  /** HOST → relay: this socket is the stage. Sent once, on open. */
  | { t: 'stage' }
  /** VIEWER → HOST: somebody tapped a live room. */
  | { t: 'watch'; from: string; who: string }
  /** HOST → VIEWER: the offer, addressed to one seat. */
  | { t: 'show'; to: string; sdp: RTCSessionDescriptionInit }
  /** VIEWER → HOST: the answer. */
  | { t: 'seat'; from: string; sdp: RTCSessionDescriptionInit }
  /** Either way: one more route to try. `to` when the host sends it, `from`
   *  when the viewer does. */
  | { t: 'ice'; to?: string; from?: string; c: RTCIceCandidateInit }
  /** HOST → VIEWER: not this time, and why. */
  | { t: 'shut'; to: string; why: string };

const STAGE_TYPES: ReadonlySet<string> = new Set(['stage', 'watch', 'show', 'seat', 'ice', 'shut']);

/** The pipe between a streamer and their audience's handshakes. Same four
 *  methods as `SignalTransport`, different room on the same relay. */
export interface StageWire {
  open(room: RoomId): Promise<void>;
  send(msg: StageMsg): void;
  onMessage(fn: (msg: StageMsg) => void): () => void;
  /** Optional: run on every successful connect, so a host can re-claim the
   *  stage after a reconnect. A transport with no reconnects need not offer it. */
  onOpen?(fn: () => void): () => void;
  close(): void;
}

export class WsStage extends WsRelay<StageMsg> implements StageWire {
  constructor() {
    super((room) => `/live/${encodeURIComponent(room)}`, STAGE_TYPES);
  }
}

/** How many peers one home connection feeds. See the header — this is a
 *  bandwidth ceiling wearing a number, not a product decision. */
export const DEFAULT_SEATS = 12;

/** A viewer waiting on an offer. Long enough for a host mid-frame to answer,
 *  short enough that a dead room says so rather than spinning. */
const WATCH_TIMEOUT_MS = 15_000;

/** KNOCK AGAIN. The relay stores nothing, so a knock that arrives while the
 *  host's socket is between lives is simply gone — and one silent attempt turns
 *  a 600ms reconnect into "that room may have ended". Re-knocking is free: the
 *  host admits by `from`, and a repeat from a seat it already has is ignored. */
const KNOCK_AGAIN_MS = 3_500;

/** Chat, per seat. A public room needs this and the relay cannot do it — the
 *  chat rides the peer connection, which is the whole point of rule 4. */
const CHAT_MIN_GAP_MS = 700;
const CHAT_MAX = 200;

function tag(): string {
  const n = new Uint8Array(6);
  crypto.getRandomValues(n);
  return Array.from(n, b => b.toString(36)).join('');
}

/** Chat is typed by strangers and drawn on other people's screens. ESCAPED
 *  range on purpose: written with literal control BYTES the character class
 *  inverts (`[^@-^_^?]`) and strips everything except them — the same mistake
 *  the lobby's first draft made, caught there before it ran and made here
 *  again while writing this file. If a regex is meant to match control
 *  characters, write the escapes. */
function cleanLine(s: string): string {
  return String(s ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, CHAT_MAX);
}

interface Seat {
  id: string;
  who: string;
  pc: RTCPeerConnection;
  ch: RTCDataChannel;
  audio: RTCRtpSender;
  /** Candidates that beat the answer here. */
  pending: RTCIceCandidateInit[];
  answered: boolean;
  lastChat: number;
}

/**
 * THE HOST'S END, over real peers.
 *
 * Note what it still does not have: a way to address one viewer, or to hand
 * anything above it the list. `publish` takes the one already-encoded string and
 * pushes the same bytes down every open channel; `viewers()` reports a number.
 * That is rule 1 and rule 2 surviving contact with sockets.
 */
export class PeerSink implements BroadcastSink {
  private readonly seats = new Map<string, Seat>();
  private readonly chatFns = new Set<(m: LiveChat) => void>();
  /** RULE 3: the transport caches the keyframe, so a viewer whose channel opens
   *  between snapshots is handed the room instead of an empty studio. */
  private lastKey: string | null = null;
  private stream: MediaStream | null = null;
  private off: (() => void) | null = null;
  private shut = false;

  constructor(
    private readonly wire: StageWire,
    private readonly seatCap = DEFAULT_SEATS,
  ) {}

  /** Open the stage and start answering knocks. */
  async open(room: RoomId): Promise<void> {
    // RE-CLAIM ON EVERY CONNECT, not just the first. The relay's idea of "the
    // host" is a SOCKET, and a socket that drops takes the claim with it — so a
    // show whose socket was recycled stays on the public list, still says LIVE,
    // and answers nobody. Registered BEFORE `open` so the very first connect
    // goes through the same path as every later one and there is only one
    // claim-sending line to be right.
    this.off = this.wire.onOpen?.(() => this.wire.send({ t: 'stage' })) ?? null;
    await this.wire.open(room);
    if (!this.off) this.wire.send({ t: 'stage' });      // a transport that never reconnects
    const offMsg = this.wire.onMessage((msg) => { void this.handle(msg); });
    const offOpen = this.off;
    this.off = () => { offOpen?.(); offMsg(); };
  }

  private async handle(msg: StageMsg): Promise<void> {
    if (this.shut) return;
    if (msg.t === 'watch') { await this.admit(msg.from, msg.who); return; }
    if (msg.t === 'seat') {
      const seat = this.seats.get(msg.from);
      if (!seat || seat.answered) return;
      try {
        await seat.pc.setRemoteDescription(msg.sdp);
        seat.answered = true;
        for (const c of seat.pending.splice(0)) {
          try { await seat.pc.addIceCandidate(c); } catch { /* a route that no longer exists */ }
        }
      } catch { this.drop(msg.from); }
      return;
    }
    if (msg.t === 'ice' && msg.from) {
      const seat = this.seats.get(msg.from);
      if (!seat) return;
      // Before the answer there is no remote description to hang a candidate
      // off, and adding one throws. Hold it.
      if (!seat.answered) { seat.pending.push(msg.c); return; }
      try { await seat.pc.addIceCandidate(msg.c); } catch { /* stale route */ }
    }
  }

  private async admit(id: string, who: string): Promise<void> {
    if (!id || this.seats.has(id)) return;
    if (this.seats.size >= this.seatCap) {
      this.wire.send({ t: 'shut', to: id, why: 'this room is full' });
      return;
    }
    const pc = new RTCPeerConnection(await iceConfig());
    // The audio m-line is negotiated UP FRONT, with or without a track in hand.
    // That is what lets the streamer patch in their DAW, unmute a microphone or
    // change the mix mid-show with `replaceTrack` and no renegotiation — a
    // renegotiation per viewer per change is the thing that falls over at scale.
    const track = this.stream?.getAudioTracks()[0] ?? null;
    const tr = pc.addTransceiver(track ?? 'audio', { direction: 'sendonly' });
    const ch = pc.createDataChannel('live', { ordered: true });
    const seat: Seat = { id, who: cleanLine(who) || 'someone', pc, ch, audio: tr.sender, pending: [], answered: false, lastChat: 0 };
    this.seats.set(id, seat);

    pc.onicecandidate = (ev) => {
      if (ev.candidate) this.wire.send({ t: 'ice', to: id, c: ev.candidate.toJSON() });
    };
    let grace = 0;
    pc.onconnectionstatechange = () => {
      const s = pc.connectionState;
      if (s === 'failed' || s === 'closed') { window.clearTimeout(grace); this.drop(id); return; }
      // Same patience as the viewer's side: a blip is not a walk-out.
      if (s === 'disconnected') {
        window.clearTimeout(grace);
        grace = window.setTimeout(() => { if (this.seats.get(id) === seat && pc.connectionState === 'disconnected') this.drop(id); }, 8000);
      } else if (s === 'connected') window.clearTimeout(grace);
    };
    ch.onopen = () => {
      if (this.lastKey) { try { ch.send(this.lastKey); } catch { /* gone already */ } }
    };
    ch.onclose = () => this.drop(id);
    ch.onmessage = (ev) => this.heard(seat, ev.data);
    // A KNOCK THAT NEVER ANSWERS IS A ZOMBIE. If the viewer backs out during
    // the handshake (their 15s timeout, a closed tab, a re-tap that knocks with
    // a fresh id) this pc sits in 'new' forever: no ICE ever starts, so no
    // connectionstatechange, so `drop()` never runs — and twelve of those said
    // "this room is full" to a stage nobody was watching.
    window.setTimeout(() => {
      const cur = this.seats.get(id);
      if (cur === seat && !seat.answered) this.drop(id);
    }, 30_000);

    try {
      const offer = await pc.createOffer();
      // MUSIC, NOT A PHONE CALL — stereo, 160k, no DTX. Applied to the offer so
      // the viewer is told what is coming; their answer says it back.
      await pc.setLocalDescription(tunedDescription(offer, LIVE_AUDIO_BITRATE));
      void tuneAudioSender(tr.sender, LIVE_AUDIO_BITRATE);
      // Sent NOW, candidates behind it — see the header.
      this.wire.send({ t: 'show', to: id, sdp: pc.localDescription as RTCSessionDescriptionInit });
    } catch {
      this.drop(id);
      this.wire.send({ t: 'shut', to: id, why: 'could not open a seat' });
    }
  }

  private heard(seat: Seat, data: unknown): void {
    if (typeof data !== 'string' || data.length > 2048) return;
    let msg: { t?: string; text?: string } | null = null;
    try { msg = JSON.parse(data) as { t?: string; text?: string }; } catch { return; }
    if (!msg || msg.t !== 'chat') return;
    const now = Date.now();
    // Dropped, never queued: a queue is a way for one person to keep typing
    // into everybody else's screen a second later.
    if (now - seat.lastChat < CHAT_MIN_GAP_MS) return;
    const text = cleanLine(msg.text ?? '');
    if (!text) return;
    seat.lastChat = now;
    for (const fn of [...this.chatFns]) {
      try { fn({ who: seat.who, text }); } catch { /* one bad listener must not silence the room */ }
    }
  }

  private drop(id: string): void {
    const seat = this.seats.get(id);
    if (!seat) return;
    this.seats.delete(id);
    try { seat.ch.close(); } catch { /* already gone */ }
    try { seat.pc.close(); } catch { /* already gone */ }
  }

  // ── BroadcastSink ─────────────────────────────────────────────────────────

  publish(encoded: string): void {
    if (encoded.startsWith('{"k":"key"')) this.lastKey = encoded;
    for (const seat of this.seats.values()) {
      if (seat.ch.readyState !== 'open') continue;
      try { seat.ch.send(encoded); } catch { /* the close handler prunes it */ }
    }
  }

  publishAudio(stream: MediaStream | null): void {
    this.stream = stream;
    const track = stream?.getAudioTracks()[0] ?? null;
    for (const seat of this.seats.values()) {
      // No renegotiation: the m-line was reserved at admit().
      void seat.audio.replaceTrack(track).catch(() => { /* seat is on its way out */ });
    }
  }

  viewers(): number {
    let n = 0;
    for (const seat of this.seats.values()) if (seat.ch.readyState === 'open') n++;
    return n;
  }

  onChat(fn: (m: LiveChat) => void): () => void {
    this.chatFns.add(fn);
    return () => { this.chatFns.delete(fn); };
  }

  close(): void {
    this.shut = true;
    for (const id of [...this.seats.keys()]) this.drop(id);
    this.chatFns.clear();
    this.off?.();
    this.off = null;
    this.lastKey = null;
    this.stream = null;
    this.wire.close();
  }
}

/**
 * THE VIEWER'S END. One connection, one way. A viewer is not a session guest:
 * there is no project channel, no permission message and no path from here into
 * the code that owns the board. Watching is not joining.
 */
export class PeerViewer implements BroadcastSource {
  private pc: RTCPeerConnection | null = null;
  private ch: RTCDataChannel | null = null;
  private readonly frameFns = new Set<(f: LiveFrame) => void>();
  private readonly audioFns = new Set<(s: MediaStream) => void>();
  private readonly endFns = new Set<() => void>();
  private ended = false;
  private readonly id = tag();
  private pending: RTCIceCandidateInit[] = [];
  private described = false;
  private off: (() => void) | null = null;
  /** Held so a viewer who subscribes before anything is playing still gets the
   *  stream the moment the host publishes one. */
  private stream: MediaStream | null = null;

  constructor(private readonly wire: StageWire, private readonly who: string) {}

  async subscribe(room: RoomId): Promise<void> {
    await this.wire.open(room);
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (err?: Error) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timer);
        window.clearInterval(again);
        if (err) { this.close(); reject(err); } else resolve();
      };
      this.off = this.wire.onMessage((msg) => {
        if (msg.t === 'shut' && msg.to === this.id) { finish(new Error(msg.why || 'that room is not taking anybody')); return; }
        if (msg.t === 'ice' && msg.to === this.id) {
          if (!this.described || !this.pc) { this.pending.push(msg.c); return; }
          void this.pc.addIceCandidate(msg.c).catch(() => { /* stale route */ });
          return;
        }
        if (msg.t !== 'show' || msg.to !== this.id) return;
        void (async () => {
          try { await this.answer(msg.sdp); finish(); }
          catch { finish(new Error('could not join that room')); }
        })();
      });
      // KNOCK AGAIN. The relay forgets nothing and stores nothing: a knock that
      // arrives while the host's socket is between lives is simply gone, and
      // one silent attempt would turn a 600ms reconnect into "that room may
      // have ended". Re-knocking is free — the host admits by `from`, and a
      // repeat from a seat it already has is ignored by `admit`.
      const knock = () => this.wire.send({ t: 'watch', from: this.id, who: cleanLine(this.who) || 'someone' });
      const again = window.setInterval(knock, KNOCK_AGAIN_MS);
      const timer = window.setTimeout(() => finish(new Error('nobody answered — that room may have ended')), WATCH_TIMEOUT_MS);
      knock();
    });
  }

  private async answer(offer: RTCSessionDescriptionInit): Promise<void> {
    const pc = new RTCPeerConnection(await iceConfig());
    this.pc = pc;
    pc.onicecandidate = (ev) => {
      if (ev.candidate) this.wire.send({ t: 'ice', from: this.id, c: ev.candidate.toJSON() });
    };
    pc.ontrack = (ev) => {
      const stream = ev.streams[0] ?? new MediaStream([ev.track]);
      this.stream = stream;
      for (const fn of [...this.audioFns]) { try { fn(stream); } catch { /* keep the show */ } }
    };
    let grace = 0;
    pc.onconnectionstatechange = () => {
      const st = pc.connectionState;
      if (st === 'failed' || st === 'closed') { window.clearTimeout(grace); this.end(); return; }
      // 'disconnected' is a blip until it is not: a viewer's wifi hiccup used
      // to end the show for them on the spot. Wait for ICE to fail (or the
      // blip to outlast a patient timer) — the channel closing is still the
      // first word when the host really ends it.
      if (st === 'disconnected') {
        window.clearTimeout(grace);
        grace = window.setTimeout(() => { if (pc.connectionState === 'disconnected') this.end(); }, 8000);
      } else if (st === 'connected') window.clearTimeout(grace);
    };
    pc.ondatachannel = (ev) => {
      if (ev.channel.label !== 'live') return;
      this.ch = ev.channel;
      // The channel closing is the FIRST and cleanest word that the show ended:
      // the host's sink closes every seat's channel on its way out, and that
      // arrives well before the peer connection notices anything.
      ev.channel.onclose = () => this.end();
      ev.channel.onmessage = (m) => {
        if (typeof m.data !== 'string') return;
        let frame: LiveFrame | null = null;
        try { frame = JSON.parse(m.data) as LiveFrame; } catch { return; }
        if (!frame || (frame.k !== 'key' && frame.k !== 'd')) return;
        for (const fn of [...this.frameFns]) { try { fn(frame); } catch { /* keep the show */ } }
      };
    };
    await pc.setRemoteDescription(offer);
    this.described = true;
    for (const c of this.pending.splice(0)) {
      try { await pc.addIceCandidate(c); } catch { /* stale route */ }
    }
    const answer = await pc.createAnswer();
    // THE OTHER HALF OF STEREO. `sprop-stereo` in their offer only says what
    // they will send; without `stereo=1` coming back the encoder is entitled to
    // fold the whole mix to mono, which is the loss he would hear first.
    await pc.setLocalDescription(tunedDescription(answer, LIVE_AUDIO_BITRATE));
    this.wire.send({ t: 'seat', from: this.id, sdp: pc.localDescription as RTCSessionDescriptionInit });
    // The candidates trickle behind it, but a build whose `onicecandidate` never
    // fires still connects off the ones in the description.
    void waitForIce(pc, 4000);
  }

  onFrame(fn: (f: LiveFrame) => void): () => void {
    this.frameFns.add(fn);
    return () => { this.frameFns.delete(fn); };
  }

  onAudio(fn: (s: MediaStream) => void): () => void {
    this.audioFns.add(fn);
    if (this.stream) { const s = this.stream; setTimeout(() => fn(s), 0); }
    return () => { this.audioFns.delete(fn); };
  }

  onEnd(fn: () => void): () => void {
    this.endFns.add(fn);
    return () => { this.endFns.delete(fn); };
  }

  /** Said ONCE. A show ending trips the channel close AND the connection state
   *  a moment later, and telling the room twice would put the viewer back in
   *  their own studio and then announce it again. */
  private end(): void {
    if (this.ended) return;
    this.ended = true;
    for (const fn of [...this.endFns]) { try { fn(); } catch { /* leaving anyway */ } }
  }

  say(text: string): void {
    const t = cleanLine(text);
    if (!t || this.ch?.readyState !== 'open') return;
    try { this.ch.send(JSON.stringify({ t: 'chat', text: t })); } catch { /* the show goes on */ }
  }

  close(): void {
    this.off?.();
    this.off = null;
    try { this.ch?.close(); } catch { /* already gone */ }
    try { this.pc?.close(); } catch { /* already gone */ }
    this.ch = null;
    this.pc = null;
    this.frameFns.clear();
    this.audioFns.clear();
    this.pending = [];
    this.described = false;
    this.stream = null;
    this.wire.close();
  }
}

/**
 * THE STAGE, IN ONE PAGE. Mirrors the relay's routing exactly — addressed to a
 * seat, or to the host — so the whole many-viewer handshake can be driven
 * against REAL `RTCPeerConnection`s with no worker deployed. Keep this honest
 * with `workers/board-signal`'s `Stage` object; they are the same twelve lines.
 */
const LOOPBACK_STAGES = new Map<RoomId, { host: ((m: StageMsg) => void) | null; seats: Map<string, (m: StageMsg) => void> }>();

export class LoopbackStage implements StageWire {
  private room: RoomId = '';
  private readonly listeners = new Set<(m: StageMsg) => void>();
  private mine: string | null = null;
  private isHost = false;

  async open(room: RoomId): Promise<void> {
    this.room = room;
    if (!LOOPBACK_STAGES.has(room)) LOOPBACK_STAGES.set(room, { host: null, seats: new Map() });
  }

  private recv(m: StageMsg): void {
    for (const fn of [...this.listeners]) fn(m);
  }

  send(msg: StageMsg): void {
    const stage = LOOPBACK_STAGES.get(this.room);
    if (!stage) return;
    if (msg.t === 'stage') {
      // FIRST CLAIM WINS, exactly as the worker does it.
      if (!stage.host) { stage.host = (m) => this.recv(m); this.isHost = true; }
      return;
    }
    // Registering by `from` is what the relay does too: the first message a
    // seat sends is how its socket becomes addressable.
    const from = (msg as { from?: string }).from;
    if (from && !stage.seats.has(from)) { this.mine = from; stage.seats.set(from, (m) => this.recv(m)); }
    const to = (msg as { to?: string }).to;
    const target = to ? stage.seats.get(to) : stage.host;
    if (!target) return;
    // Asynchronous for the same reason `LoopbackTransport` is: no network hands
    // a sender its own reply before `send` returns.
    setTimeout(() => target(msg), 0);
  }

  onMessage(fn: (m: StageMsg) => void): () => void {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  }

  close(): void {
    const stage = LOOPBACK_STAGES.get(this.room);
    this.listeners.clear();
    if (!stage) return;
    if (this.mine) stage.seats.delete(this.mine);
    if (this.isHost) { stage.host = null; this.isHost = false; }
    if (!stage.host && !stage.seats.size) LOOPBACK_STAGES.delete(this.room);
  }
}
