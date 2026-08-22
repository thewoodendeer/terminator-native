// ─────────────────────────────────────────────────────────────────────────────
// SIGNALLING — how the two blobs travel.
//
// `NetSession` already does the hard part: `invite()` hands back a base64 offer,
// `join(code)` hands back an answer, `acceptJoin(code)` finishes it. Everything
// downstream — project transfer, permissions, the room sync, the collab boost —
// is built on top of that and does not care how those two strings got from one
// machine to the other. Today they get there because Victor copies one into a
// chat window and his friend pastes the reply back.
//
// This module is the courier, and NOTHING ELSE. It carries three tiny messages
// between two browsers and then gets out of the way:
//
//    knock   guest → host   "I clicked your room"
//    offer   host → guest   the base64 from invite()
//    answer  guest → host   the base64 from join()
//
// ── WHY THE OFFER IS MADE ON DEMAND ─────────────────────────────────────────
// The obvious design is to park an offer in the lobby row when the room is
// published. Two things in the code below it say no:
//
//   1. `NetSession.invite()` begins with `teardown(false)`. A host cannot bake
//      the NEXT guest's offer while the current one is connected — it would
//      hang up on them.
//   2. An offer carries ICE candidates gathered at the moment it was made
//      (`waitForIce`). One that has been sitting in a table for twenty minutes
//      is advertising a port that has since timed out.
//
// So the room advertises itself, and the offer is made the instant somebody
// knocks. Which buys the other half for free: **the claim race resolves itself.**
// Two strangers clicking the same room at once is not a database problem
// needing an atomic write — the host answers the FIRST knock and ignores the
// rest, because the host was always the authority. The lobby's open/full flag
// is a display hint, not a lock.
//
// ── WHY THE TRANSPORT IS AN INTERFACE ───────────────────────────────────────
// A key that ships inside a client bundle is the one thing this codebase has a
// standing rule against. Which backend carries these three messages — a relay
// worker, Supabase Realtime, anything else — decides whether a key has to be in
// the bundle at all, and that is a decision worth keeping OUTSIDE the protocol.
// So `SignalTransport` is four methods, and the protocol below is written
// against it. `LoopbackTransport` is what makes the whole handshake testable in
// one page with no server at all.
// ─────────────────────────────────────────────────────────────────────────────

import type { NetSession } from './session';

/** A room id. Short, unguessable, and the only thing a guest needs to arrive. */
export type RoomId = string;

export type SignalMsg =
  /** GUEST → HOST: somebody clicked the room. `from` is theirs for this knock
   *  only — it is how the host addresses the reply, not an identity. */
  | { t: 'knock'; from: string; name: string; lvl: number }
  /** HOST → GUEST: the base64 from `invite()`, addressed to one knock. */
  | { t: 'offer'; to: string; sdp: string }
  /** GUEST → HOST: the base64 from `join()`. */
  | { t: 'answer'; from: string; sdp: string }
  /** HOST → GUEST: not this time (room already taken, or the host said no). */
  | { t: 'busy'; to: string };

/**
 * WHAT A BACKEND HAS TO DO. Deliberately four methods: a room to be in, a way
 * to speak into it, a way to hear it, and a way to leave. Everything above is
 * written against this, so swapping a relay worker for Supabase Realtime is a
 * new file, not a rewrite.
 */
export interface SignalTransport {
  /** Join the room's channel. Resolves when messages can flow. */
  open(room: RoomId): Promise<void>;
  send(msg: SignalMsg): void;
  onMessage(fn: (msg: SignalMsg) => void): () => void;
  close(): void;
}

/** Room ids are read aloud and typed by hand, so: no vowels to make a word out
 *  of by accident, no 0/O/1/I. 8 characters over this alphabet is 32 bits of
 *  room to guess through, against a host that only ever answers one knock. */
const ALPHABET = '23456789BCDFGHJKMNPQRSTVWXYZ';
export function newRoomId(): RoomId {
  const n = new Uint8Array(8);
  crypto.getRandomValues(n);
  return Array.from(n, b => ALPHABET[b % ALPHABET.length]).join('');
}

function tag(): string {
  const n = new Uint8Array(6);
  crypto.getRandomValues(n);
  return Array.from(n, b => b.toString(36)).join('');
}

/** What the host learns about somebody knocking, before deciding to let them in. */
export interface Knock { from: string; name: string; lvl: number }

/**
 * THE HOST HALF. Sits in the room's channel and waits.
 *
 * `onKnock` is the door: return true to let them in. That is where "listeners
 * only" and a block list will live — this module makes no policy, it only
 * enforces the one structural rule (**one guest at a time**), because that rule
 * is what makes the 2-player cap true rather than hopeful.
 */
export class SignalHost {
  private off: (() => void) | null = null;
  private busy = false;

  constructor(
    private readonly transport: SignalTransport,
    private readonly session: NetSession,
  ) {}

  async listen(room: RoomId, onKnock: (k: Knock) => boolean | Promise<boolean>): Promise<void> {
    await this.transport.open(room);
    this.off = this.transport.onMessage((msg) => {
      if (msg.t !== 'knock' && msg.t !== 'answer') return;      // the host's own words come back
      void this.handle(msg, onKnock);
    });
  }

  private async handle(
    msg: Extract<SignalMsg, { t: 'knock' | 'answer' }>,
    onKnock: (k: Knock) => boolean | Promise<boolean>,
  ): Promise<void> {
    if (msg.t === 'answer') {
      // The last step. A stray answer from a knock we refused is harmless —
      // acceptJoin throws on a session that has no offer in flight.
      try { await this.session.acceptJoin(msg.sdp); } catch { /* not ours */ }
      return;
    }
    // THE ONE-GUEST RULE, and the claim race with it: the second knock inside
    // the same handshake is told the room is taken rather than silently
    // dropped, so a stranger sees "full" instead of a button that did nothing.
    if (this.busy || this.session.connected) {
      this.transport.send({ t: 'busy', to: msg.from });
      return;
    }
    this.busy = true;
    try {
      const welcome = await onKnock({ from: msg.from, name: msg.name, lvl: msg.lvl });
      if (!welcome) {
        this.transport.send({ t: 'busy', to: msg.from });
        return;
      }
      // Made HERE, not earlier — see the header. This is also what tears down
      // any half-finished previous attempt.
      const sdp = await this.session.invite();
      this.transport.send({ t: 'offer', to: msg.from, sdp });
    } catch {
      this.transport.send({ t: 'busy', to: msg.from });
    } finally {
      // Released either way: a knock that never sends an answer back (they
      // closed the tab mid-handshake) must not lock the room forever. The real
      // guard on a LIVE session is `session.connected` above.
      this.busy = false;
    }
  }

  stop(): void {
    this.off?.();
    this.off = null;
    this.transport.close();
  }
}

/** How long a guest waits for a host to answer a knock. Long enough for a host
 *  to be handed a popup and read it; short enough that a dead room says so. */
const KNOCK_TIMEOUT_MS = 20_000;

export type JoinResult = 'connecting' | 'busy' | 'timeout';

/**
 * THE GUEST HALF. One call: knock, take the offer, answer it, done. Resolves as
 * soon as the answer is away — `NetSession.onState` is what reports whether the
 * two machines actually met, and it already does that for the copy-paste path.
 */
export async function signalJoin(
  transport: SignalTransport,
  session: NetSession,
  room: RoomId,
  me: { name: string; lvl: number },
): Promise<JoinResult> {
  const from = tag();
  await transport.open(room);
  return await new Promise<JoinResult>((resolve) => {
    let done = false;
    const finish = (r: JoinResult) => {
      if (done) return;
      done = true;
      window.clearTimeout(timer);
      off();
      resolve(r);
    };
    const off = transport.onMessage((msg) => {
      // Addressed to THIS knock only: two people can be mid-handshake in the
      // same channel, and taking somebody else's offer would hand them a
      // session with a stranger in it.
      if (msg.t === 'busy' && msg.to === from) { finish('busy'); return; }
      if (msg.t !== 'offer' || msg.to !== from) return;
      void (async () => {
        try {
          const answer = await session.join(msg.sdp);
          transport.send({ t: 'answer', from, sdp: answer });
          finish('connecting');
        } catch {
          finish('busy');    // an offer we could not read is a room we cannot enter
        }
      })();
    });
    const timer = window.setTimeout(() => finish('timeout'), KNOCK_TIMEOUT_MS);
    transport.send({ t: 'knock', from, name: me.name, lvl: me.lvl });
  });
}

/**
 * THE TEST TRANSPORT — both sides of a room, in one page, no server.
 *
 * This is not a stub: it is the same object graph the real thing produces, so
 * the whole knock/offer/answer protocol (and the one-guest rule, and the
 * addressing) can be driven against two REAL `NetSession`s with real WebRTC
 * before a single line of backend exists. Rooms are process-global so two
 * transports built independently find each other by id, exactly as they would
 * through a relay.
 */
const LOOPBACK_ROOMS = new Map<RoomId, Set<(m: SignalMsg) => void>>();

export class LoopbackTransport implements SignalTransport {
  private room: RoomId = '';
  private readonly listeners = new Set<(m: SignalMsg) => void>();

  async open(room: RoomId): Promise<void> {
    this.room = room;
    if (!LOOPBACK_ROOMS.has(room)) LOOPBACK_ROOMS.set(room, new Set());
  }

  send(msg: SignalMsg): void {
    const peers = LOOPBACK_ROOMS.get(this.room);
    if (!peers) return;
    // Asynchronous on purpose — a synchronous delivery would let a sender see
    // its own reply before its own `send` returned, which no network does, and
    // that difference is exactly where handshake bugs hide.
    for (const fn of peers) {
      if (this.listeners.has(fn)) continue;      // never hear yourself
      setTimeout(() => fn(msg), 0);
    }
  }

  onMessage(fn: (m: SignalMsg) => void): () => void {
    this.listeners.add(fn);
    LOOPBACK_ROOMS.get(this.room)?.add(fn);
    return () => {
      this.listeners.delete(fn);
      LOOPBACK_ROOMS.get(this.room)?.delete(fn);
    };
  }

  close(): void {
    const peers = LOOPBACK_ROOMS.get(this.room);
    for (const fn of this.listeners) peers?.delete(fn);
    this.listeners.clear();
    if (peers && !peers.size) LOOPBACK_ROOMS.delete(this.room);
  }
}
