// ─────────────────────────────────────────────────────────────────────────────
// THE SHARED BOARD — the connection.
//
// One WebRTC peer connection between two machines, carrying a single reliable
// data channel. No server holds the audio, the project, or anything else: the
// files never touch our infrastructure, which is what makes this affordable and
// what keeps us out of the business of hosting other people's music.
//
// SIGNALING IS MANUAL IN THIS SLICE, on purpose. WebRTC needs the two sides to
// swap one blob of text ("here is how to reach me") before it can connect, and
// that swap normally wants a server. Making the user copy an INVITE code and
// paste back a JOIN code needs no server, no account and no key in the bundle —
// so the peer layer can be built and PROVEN first, and the seamless invite-link
// version (Supabase Realtime, already in the CSP) becomes a swap of this one
// module's `hostOffer`/`acceptAnswer` plumbing rather than a rewrite.
//
// The codes are base64 of the SDP + ICE candidates, gathered before the code is
// handed over (see `waitForIce`) — "trickle ICE" would mean a second round of
// copy-paste, which no human would do.
// ─────────────────────────────────────────────────────────────────────────────

import { SESSION_AUDIO_BITRATE, tunedDescription } from './audioQuality';
import { iceConfig } from './ice';

/** How much of the board a guest has been handed. The host owns this value for
 *  the whole session and the guest is only ever TOLD it — see perms.ts. */
export type PermLevel = 'none' | 'mix' | 'full';

/** One asset in a project transfer: a single decoded buffer, compressed. */
export interface AssetHead {
  /** Packed payload size in bytes — the receiver knows it is done by this. */
  bytes: number;
  /** Sample rate of the ORIGINAL buffer (opus always packs at 48k). */
  rate: number;
  ch: number;
  /** Frame count of the ORIGINAL buffer, so a lossy round trip can be trimmed
   *  back to the exact length the arrangement was built against. */
  frames: number;
  codec: 'opus' | 'pcm16';
}

/** What travels the wire. Small, flat, and versioned by shape rather than a
 *  number: an unknown `t` is IGNORED, so an older build never crashes on a
 *  message a newer one added. */
export type NetMsg =
  /** Sent once by each side the moment the channel opens. `lvl` is the sender's
   *  career level: a photo or video shot with someone further up the ladder
   *  than you carries their weight when it is posted, so the room has to know
   *  who is standing in it. Absent from older builds — treat missing as 0. */
  | { t: 'hello'; name: string; body: string; lvl?: number }
  /** Where the sender is standing. ~15/s, the only high-rate message. */
  /** `seated` is absent from older builds — treat missing as false, which is
   *  exactly what those builds could draw anyway. */
  | { t: 'pose'; x: number; z: number; yaw: number; moving: boolean; seated?: boolean }
  /** The console's transport, sent by whoever owns it. `seek` marks the beat as
   *  one to OBEY — a start, a stop, a scrub, or the first word to a new arrival.
   *  Without it a message is only a heartbeat, and a follower that is already
   *  rolling ignores the number: adopting a beat that arrived a moment ago is
   *  what makes the desk re-cut every voice. Absent from older builds — treat
   *  missing as false. */
  | { t: 'transport'; playing: boolean; beat: number; bpm: number; seek?: boolean }
  /** A line of chat, drawn as a bubble over the sender's head. */
  | { t: 'say'; text: string }
  /** Whether the sender is standing in the studio, at the board — as opposed to
   *  out in the hallway or in someone else's session. Transport follows it:
   *  you cannot run a console you are not standing at. Sent on every crossing,
   *  and once when the link comes up. Older builds never send it, so a peer we
   *  have not heard from is assumed to be at the desk. */
  | { t: 'where'; studio: boolean; scene?: string }
  /** THE BUILDING ITSELF. Every door down the hallway, the rooms behind them
   *  and the sessions leaking under each one are derived from one seed, so the
   *  host's is the session's — otherwise two people who walk out of the studio
   *  together walk into two different corridors. Host → guest, once. */
  | { t: 'building'; seed: number }
  // ── ONE BOARD: the mix ─────────────────────────────────────────────────────
  /** Channel state that CHANGED, and only what changed. `ch` -1 is the pinned
   *  master strip. Sent by whoever is allowed to move the board; see the shadow
   *  in main.ts for why this can never echo back and forth forever. */
  | { t: 'mix'; ch: number; f: Record<string, number | string | boolean> }
  /** The whole desk at once — sent right after a project lands, so both sides
   *  start from the same mix rather than from whatever each had lying around. */
  | { t: 'mixall'; chans: Array<Record<string, number | string | boolean>>; master: Record<string, number | string | boolean> }
  /** Settings that change how the SAME mix renders (saturator oversampling,
   *  master clipper). They live in the room's settings, not the project, so a
   *  session carries the host's values or the two boards quietly disagree. */
  | { t: 'dsp'; oversample: string; masterClip: boolean }
  /** THE ROOM ITSELF — the lamp, the overheads, the curtain, the daylight, the
   *  air. Sent as a diff, exactly like the mix, because being in a session is
   *  supposed to feel like being in one room: someone drops the lights and
   *  they drop for both of you. Whoever may move the board may move the room. */
  | { t: 'env'; f: Record<string, number | string | boolean> }
  // ── ONE BOARD: permissions ─────────────────────────────────────────────────
  /** Guest → host: "let me touch the board." Sent on the first refused move. */
  | { t: 'perm-ask' }
  /** Host → guest: what they are allowed to do now. The host's word is final;
   *  the guest never decides this for itself. */
  | { t: 'perm'; level: PermLevel; transport: boolean; muted: boolean }
  /** Host → guest: the session is over for them, and it was deliberate. */
  | { t: 'kick' }
  // ── ONE BOARD: the project ─────────────────────────────────────────────────
  /** Guest → host: "can I put this on the board?" The host answers with
   *  `proj-answer`. A guest never pushes a beat unasked. */
  | { t: 'proj-ask'; name: string; tracks: number; mb: number }
  /** Host → guest: the verdict on `proj-ask`. */
  | { t: 'proj-answer'; ok: boolean }
  /** A transfer is starting. Everything after it on the bulk channel belongs to
   *  this transfer until `proj-end`. */
  | { t: 'proj-begin'; sid: number; name: string; metaBytes: number; assets: AssetHead[] }
  /** All bytes are away. */
  | { t: 'proj-end'; sid: number }
  /** The board is on the bundled demo beat — both sides ship it, so 25MB of
   *  wire is replaced by three words. */
  | { t: 'proj-demo' }
  /** Nothing is loaded over here. */
  | { t: 'proj-none' }
  /** Receiver → sender: it landed, and the board is playing it. */
  | { t: 'proj-ack'; name: string };

export type NetState = 'idle' | 'offering' | 'answering' | 'connecting' | 'live' | 'closed' | 'failed';

/** The STUN-only fallback, kept as the shape every path degrades to. The live
 *  configuration — which may carry a TURN relay for the ~1 pair in 5 that
 *  cannot meet directly — comes from `ice.ts`, because its credentials expire
 *  and must never be compiled into the bundle. */
export const ICE: RTCConfiguration = {
  iceServers: [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }],
};

/** Every candidate gathered, THEN the code — for the paths that hand a human one
 *  string. Exported because the broadcast transport needs the same fallback
 *  behaviour on the one code path where it cannot trickle. `icegatheringstate
 *  change` can miss on some builds, so the poll and a hard timeout back it up: a
 *  description built from the candidates we have beats no description at all. */
export function waitForIce(pc: RTCPeerConnection, ms = 4000): Promise<void> {
  if (pc.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => { clearInterval(poll); clearTimeout(bail); resolve(); };
    const poll = setInterval(() => { if (pc.iceGatheringState === 'complete') done(); }, 120);
    const bail = setTimeout(done, ms);
  });
}

/** Bulk-channel backpressure marks, in bytes. Push until HIGH is in the buffer,
 *  then wait for it to fall past LOW. 4MB in flight keeps the pipe saturated on
 *  a fast link without ever handing the connection a whole project at once. */
const BULK_HIGH = 4 * 1024 * 1024;
const BULK_LOW = 1024 * 1024;

/** Codes are pasted by hand between two people, so they must survive a chat app:
 *  base64 with the padding and the URL-hostile characters swapped out. */
function encode(obj: unknown): string {
  const json = JSON.stringify(obj);
  const b64 = btoa(unescape(encodeURIComponent(json)));
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function decode<T>(code: string): T | null {
  try {
    const b64 = code.trim().replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(decodeURIComponent(escape(atob(b64)))) as T;
  } catch { return null; }
}

/** ONE connection to ONE other person.
 *
 *  Deliberately not a mesh: two people sharing a board is the thing to get
 *  right first, and a mesh built before a pair works is a mesh of broken pairs.
 *  The message API (`send` / `on`) is what a room of several would keep, so
 *  growing this into a host-and-guests star later does not change its callers. */
export class NetSession {
  private pc: RTCPeerConnection | null = null;
  private chan: RTCDataChannel | null = null;
  /** THE VOICE WIRE. One audio m-line, reserved in the OFFER whether or not a
   *  mic is on — the same trick liveNet plays at admit(): a track patched in
   *  mid-session is `replaceTrack` on a lane that already exists, never a
   *  renegotiation (which this copy-paste handshake could not do anyway).
   *  Carries the mic and the computer/interface input, both directions. The
   *  BEAT is deliberately NOT on it: a session transfers the project and both
   *  machines render it, so streaming the master would play it twice. */
  private audioTx: RTCRtpTransceiver | null = null;
  private audioCbs = new Set<(stream: MediaStream | null) => void>();
  /** What the other side is sending — their mic / their DAW. Null until their
   *  first track arrives. */
  remoteAudio: MediaStream | null = null;
  /** THE SECOND PIPE. A project is tens of megabytes and the control channel
   *  is ordered — pushed down the same stream, one transfer would sit in front
   *  of every pose, knob move and chat line until it finished, and the room
   *  would freeze for the length of the send. A separate channel is a separate
   *  SCTP stream, so the small messages keep flowing past the big one. */
  private bulk: RTCDataChannel | null = null;
  private binHandlers = new Set<(buf: ArrayBuffer) => void>();
  private handlers = new Set<(m: NetMsg, from: string) => void>();
  private stateCbs = new Set<(s: NetState, detail: string) => void>();
  private _state: NetState = 'idle';
  /** Their name, learned from `hello`. Empty until then. */
  peerName = '';
  /** Their body slug, learned from `hello`. */
  peerBody = '';
  /** Their career level, learned from `hello`. 0 = unknown / older build. */
  peerLevel = 0;
  /** True for the side that created the invite. The host owns the console in
   *  this slice — see the transport rules in main.ts. */
  isHost = false;

  get state(): NetState { return this._state; }
  get connected(): boolean { return this._state === 'live'; }

  onMessage(fn: (m: NetMsg, from: string) => void): () => void {
    this.handlers.add(fn);
    return () => this.handlers.delete(fn);
  }
  /** Raw frames off the bulk channel — project bytes, nothing else. */
  onBinary(fn: (buf: ArrayBuffer) => void): () => void {
    this.binHandlers.add(fn);
    return () => this.binHandlers.delete(fn);
  }
  onState(fn: (s: NetState, detail: string) => void): () => void {
    this.stateCbs.add(fn);
    return () => this.stateCbs.delete(fn);
  }
  /** The other side's voice/input arriving (or going away — null on teardown).
   *  What to DO with it is the board's decision, and the law lives there: it
   *  goes to an element, never into the audio graph, so it cannot reach a take
   *  or an export. */
  onAudio(fn: (stream: MediaStream | null) => void): () => void {
    this.audioCbs.add(fn);
    return () => this.audioCbs.delete(fn);
  }
  /** Where an outgoing track goes. Null against an older build whose offer had
   *  no audio lane — the caller says "they need to update", not silence. */
  audioSender(): RTCRtpSender | null { return this.audioTx?.sender ?? null; }
  get audioReady(): boolean { return !!this.audioTx; }
  private setState(s: NetState, detail = ''): void {
    if (this._state === s) return;
    this._state = s;
    for (const cb of this.stateCbs) { try { cb(s, detail); } catch { /* a listener must not break the link */ } }
  }

  /** Every candidate gathered, THEN the code. Trickle ICE would need a second
   *  paste in each direction; a human will do one. Shared with the broadcast
   *  transport — see `waitForIce` above. */
  private waitForIce(pc: RTCPeerConnection, ms = 4000): Promise<void> {
    return waitForIce(pc, ms);
  }

  private wireChannel(ch: RTCDataChannel): void {
    this.chan = ch;
    // Identity-guarded: `teardown()` closes the old channel but its close event
    // is delivered LATER — after invite()/join() has already moved on to
    // 'offering'/'answering' with a new channel — and an unguarded onclose then
    // announced SESSION ENDED (giving the beat back, clearing grants) in the
    // middle of connecting the next one.
    ch.onopen = () => { if (this.chan === ch) this.setState('live'); };
    ch.onclose = () => { if (this.chan === ch) this.setState('closed'); };
    ch.onmessage = (ev) => {
      if (this.chan !== ch) return;
      let msg: NetMsg | null = null;
      try { msg = JSON.parse(String(ev.data)) as NetMsg; } catch { return; }
      if (!msg || typeof (msg as { t?: unknown }).t !== 'string') return;
      if (msg.t === 'hello') {
        this.peerName = msg.name || 'someone';
        this.peerBody = msg.body || '';
        this.peerLevel = Math.max(0, Math.round(msg.lvl ?? 0));
      }
      for (const h of this.handlers) {
        try { h(msg, this.peerName); } catch { /* one bad listener must not stop the rest */ }
      }
    };
  }

  private wireBulk(ch: RTCDataChannel): void {
    this.bulk = ch;
    ch.binaryType = 'arraybuffer';
    // The drain promise (see `sendBulk`) waits on this: the sender stops pushing
    // when the buffer is deep and starts again the moment it has drained. Without
    // it a 25MB project is handed to the connection in one burst, which on some
    // builds is simply dropped and on the rest costs a hundred megabytes of RAM.
    ch.bufferedAmountLowThreshold = BULK_LOW;
    ch.onmessage = (ev) => {
      const data = ev.data;
      if (!(data instanceof ArrayBuffer)) return;
      for (const h of this.binHandlers) {
        try { h(data); } catch { /* one bad listener must not stop the transfer */ }
      }
    };
  }

  private wirePc(pc: RTCPeerConnection): void {
    let graceTimer = 0;
    pc.onconnectionstatechange = () => {
      if (this.pc !== pc) return;                       // a torn-down attempt
      const st = pc.connectionState;
      if (st === 'failed') { window.clearTimeout(graceTimer); this.setState('failed', 'the two machines could not reach each other'); return; }
      if (st === 'closed') { window.clearTimeout(graceTimer); this.setState('closed'); return; }
      if (st === 'disconnected') {
        // 'disconnected' is TRANSIENT — a two-second wifi blip on either end
        // reports it and usually recovers to 'connected' on its own. Treating
        // it as the end put the board back on its own beat and cleared the
        // grants while the peer carried on sending into a session it still
        // had. Give it a moment; only a real 'failed'/'closed' — or a blip that
        // does not clear — is an ending.
        window.clearTimeout(graceTimer);
        graceTimer = window.setTimeout(() => {
          if (this.pc === pc && pc.connectionState === 'disconnected') this.setState('closed');
        }, 8000);
        return;
      }
      if (st === 'connected') window.clearTimeout(graceTimer);
    };
    pc.ontrack = (ev) => {
      if (ev.track.kind !== 'audio') return;
      const stream = ev.streams[0] ?? new MediaStream([ev.track]);
      this.remoteAudio = stream;
      for (const cb of this.audioCbs) { try { cb(stream); } catch { /* a listener must not break the link */ } }
    };
  }

  /** HOST: build the invite code. Give it to your friend; they hand back a
   *  join code for `acceptJoin`. */
  async invite(): Promise<string> {
    this.teardown(false);          // replacing an attempt is not an ENDED session
    this.isHost = true;
    this.setState('offering');
    const pc = new RTCPeerConnection(await iceConfig());
    this.pc = pc;
    this.wirePc(pc);
    // The host opens the channel; the guest receives it via ondatachannel.
    // Ordered + reliable: pose updates are small and frequent, but a dropped
    // 'transport' or 'hello' is a broken session, and at 15 messages/second
    // reliability costs nothing worth measuring.
    this.wireChannel(pc.createDataChannel('board', { ordered: true }));
    this.wireBulk(pc.createDataChannel('bulk', { ordered: true }));
    // The voice lane, reserved now so a mic later is replaceTrack, never a
    // second copy-paste. An older guest answers it recvonly and simply never
    // sends — nothing breaks.
    this.audioTx = pc.addTransceiver('audio', { direction: 'sendrecv' });
    const offer = await pc.createOffer();
    // MUSIC, NOT A PHONE CALL. One peer, so a session takes the transparent
    // setting — stereo, 256k, no DTX. See audioQuality.ts.
    await pc.setLocalDescription(tunedDescription(offer, SESSION_AUDIO_BITRATE));
    await this.waitForIce(pc);
    return encode({ v: 1, role: 'host', sdp: pc.localDescription });
  }

  /** GUEST: take the host's invite code, return the join code to send back. */
  async join(inviteCode: string): Promise<string> {
    const parsed = decode<{ v: number; role: string; sdp: RTCSessionDescriptionInit }>(inviteCode);
    // CHECK THE CODE BEFORE TEARING ANYTHING DOWN. Pressing CONNECT a second
    // time hands us back OUR OWN reply (the box still holds it), and joining
    // with an answer killed the live session and reported it as "not readable".
    // The role is stamped into every code, so say which one this is instead.
    if (!parsed?.sdp) { this.setState('failed', 'that invite code is not readable'); throw new Error('bad invite code'); }
    if (parsed.role === 'guest') {
      this.setState('failed', 'that is a JOIN code — the other side pastes it, not you');
      throw new Error('join code pasted into join');
    }
    this.teardown(false);          // replacing an attempt is not an ENDED session
    this.isHost = false;
    this.setState('answering');
    const pc = new RTCPeerConnection(await iceConfig());
    this.pc = pc;
    this.wirePc(pc);
    // Both channels arrive here, in whatever order the host's offer put them —
    // the LABEL says which is which, never the arrival order.
    pc.ondatachannel = (ev) => {
      if (ev.channel.label === 'bulk') this.wireBulk(ev.channel);
      else this.wireChannel(ev.channel);
    };
    await pc.setRemoteDescription(parsed.sdp);
    // The host's offer may carry a voice lane (see invite). Claim it and turn
    // it both ways so this side can send too. An OLDER host offers none — the
    // guest cannot add a lane the offer lacks, so audioReady stays false and
    // the screen says so instead of a mic switch that does nothing.
    this.audioTx = pc.getTransceivers().find(t => t.receiver.track.kind === 'audio') ?? null;
    if (this.audioTx) this.audioTx.direction = 'sendrecv';
    const answer = await pc.createAnswer();
    // Both ends, or the stereo claim is one-sided and the mix folds to mono.
    await pc.setLocalDescription(tunedDescription(answer, SESSION_AUDIO_BITRATE));
    await this.waitForIce(pc);
    this.setState('connecting');
    return encode({ v: 1, role: 'guest', sdp: pc.localDescription });
  }

  /** HOST: the last step — paste the code your friend sent back. */
  async acceptJoin(joinCode: string): Promise<void> {
    const parsed = decode<{ v: number; role: string; sdp: RTCSessionDescriptionInit }>(joinCode);
    if (!parsed?.sdp) { this.setState('failed', 'that join code is not readable'); throw new Error('bad join code'); }
    if (parsed.role === 'host') {
      this.setState('failed', 'that is an INVITE code — you need the reply they sent back');
      throw new Error('invite code pasted into accept');
    }
    if (!this.pc) { this.setState('failed', 'make an invite first'); throw new Error('no offer in flight'); }
    await this.pc.setRemoteDescription(parsed.sdp);
    this.setState('connecting');
  }

  /** Fire-and-forget. Never throws: a send on a half-closed channel is a
   *  normal event at the end of a session, not an error the room should see. */
  send(msg: NetMsg): void {
    const ch = this.chan;
    if (!ch || ch.readyState !== 'open') return;
    try { ch.send(JSON.stringify(msg)); } catch { /* the state change will report it */ }
  }

  /** True once the bulk pipe can carry a project. */
  get bulkReady(): boolean { return this.bulk?.readyState === 'open'; }

  /** Push one frame of project bytes. Returns false when the pipe is gone, so a
   *  transfer can give up instead of spinning against a closed channel. */
  sendBulk(data: ArrayBuffer): boolean {
    const ch = this.bulk;
    if (!ch || ch.readyState !== 'open') return false;
    try { ch.send(data); return true; } catch { return false; }
  }

  /** Wait until the bulk pipe has drained enough to take more. This is the ONLY
   *  thing standing between a project transfer and a browser holding the whole
   *  file in a send buffer. Resolves immediately when there is nothing to wait
   *  for, and gives up (rather than hanging) if the channel dies mid-send. */
  drain(): Promise<void> {
    const ch = this.bulk;
    if (!ch || ch.readyState !== 'open' || ch.bufferedAmount < BULK_HIGH) return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => { ch.removeEventListener('bufferedamountlow', done); clearInterval(poll); resolve(); };
      ch.addEventListener('bufferedamountlow', done);
      // The event is the fast path; the poll is what catches a channel that
      // closes mid-transfer, which fires no drain event at all.
      const poll = setInterval(() => {
        if (ch.readyState !== 'open' || ch.bufferedAmount < BULK_HIGH) done();
      }, 60);
    });
  }

  /** Tear the peer down. `announce` false = we are about to build a NEW one, so
   *  listeners must not be told the session ENDED — invite() and join() both
   *  start by clearing whatever came before, and announcing that as an ending
   *  put "SESSION ENDED" on screen in the middle of connecting. */
  private teardown(announce: boolean): void {
    try { this.chan?.close(); } catch { /* already gone */ }
    try { this.bulk?.close(); } catch { /* already gone */ }
    try { this.pc?.close(); } catch { /* already gone */ }
    this.chan = null;
    this.bulk = null;
    this.pc = null;
    this.audioTx = null;
    if (this.remoteAudio) {
      this.remoteAudio = null;
      for (const cb of this.audioCbs) { try { cb(null); } catch { /* gone is gone */ } }
    }
    this.peerName = '';
    this.peerBody = '';
    this.peerLevel = 0;
    if (announce && this._state !== 'idle') this.setState('closed');
    else if (!announce) this._state = 'idle';
  }

  close(): void { this.teardown(true); }
}
