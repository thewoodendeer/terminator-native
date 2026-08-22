// ─────────────────────────────────────────────────────────────────────────────
// THE RELAY TRANSPORT — a websocket to a room, and no key in the bundle.
//
// This is the `SignalTransport` the shipped build uses. It talks to the tiny
// relay in `workers/board-signal/` (a Cloudflare Worker + one Durable Object
// per room), whose entire job is to forward JSON between the two people in a
// room and forget it.
//
// ── WHY A RELAY AND NOT SUPABASE REALTIME ───────────────────────────────────
// Supabase was the obvious pick: it is already in the stack and already in the
// board's CSP. But its client authenticates with a publishable key, and a
// publishable key is still a key that ships inside `dist-web`, guarded only by
// row-level security being right — and this codebase has already been bitten
// once by a policy that looked locked and was not (`REVOKE FROM PUBLIC` on an
// RPC, which left `anon` and `authenticated` reachable by name).
//
// A relay needs no credential at all. The room id IS the credential: eight
// characters the host hands out, and a host that only ever answers one knock.
// It also costs nothing at this scale, adds no npm dependency (`WebSocket` is
// in the platform), and keeps the whole signalling story inside one 60-line
// worker that can be read in a sitting.
//
// ── WHAT IT DELIBERATELY DOES NOT DO ────────────────────────────────────────
// No history, no auth, no storage. A message that arrives when the other side
// is not listening is GONE — which is correct here, because every message in
// the protocol is part of a live handshake that has its own timeout. Nothing
// in this file is allowed to become a database.
// ─────────────────────────────────────────────────────────────────────────────

import type { RoomId, SignalMsg, SignalTransport } from './signal';

/**
 * WHERE THE RELAY LIVES — and why it is a DEFAULT rather than only an env var.
 *
 * This is a URL, not a secret. It carries no credential, holds nothing, and the
 * room id is the only thing that gets anybody into a room; publishing the
 * address gives away exactly as much as publishing the name of a phone exchange.
 * So the standing rule about keys in client bundles does not apply, and the
 * thing that WOULD go wrong if this were env-only is real: the build happens on
 * two different machines and in a GitHub Actions runner, and any one of them
 * missing a `.env` ships a board where matchmaking silently does not exist.
 * A default that every build inherits cannot be forgotten on one machine.
 *
 * `VITE_BOARD_SIGNAL_URL` still wins when it is set — that is how you point a
 * build at a staging relay, or at nothing.
 */
const DEFAULT_RELAY = 'wss://board-signal.killavicbeats.workers.dev';

export function signalUrl(): string {
  const set = import.meta.env?.VITE_BOARD_SIGNAL_URL as string | undefined;
  // An explicitly EMPTY value is a choice ("this build has no relay"), which is
  // why the test is for undefined rather than falsiness.
  return set === undefined ? DEFAULT_RELAY : set;
}

export function signallingAvailable(): boolean { return !!signalUrl(); }

/** A socket that went quiet is a socket that is gone. The relay pings; this is
 *  the client half — if nothing arrives for this long, reconnect rather than
 *  sit on a pipe the OS has already given up on. */
const IDLE_MS = 45_000;

/**
 * ONE SOCKET TO A RELAY PATH, with the retry and the idle watchdog. Generic over
 * the message shape because the board now opens two different kinds of room on
 * the same relay — the 2-player handshake (`/room/…`) and a live show's stage
 * (`/live/…`) — and a second hand-written copy of this reconnect logic is
 * exactly how two implementations drift apart.
 *
 * Subclasses supply the path and the allowlist of message types. Everything a
 * relay hands back is untrusted: only shapes the protocol knows get through.
 */
export class WsRelay<T extends { t: string }> {
  private ws: WebSocket | null = null;
  private readonly listeners = new Set<(m: T) => void>();
  protected room: RoomId = '';
  private closed = false;
  private idleTimer = 0;
  /** Sends made before the socket finished opening. Signalling is three
   *  messages long; dropping the first one because a handshake was 40ms slow
   *  would look exactly like a room that does not exist. */
  private readonly pending: T[] = [];
  /** Run on EVERY successful connect, including the silent reconnects below. */
  private readonly openFns = new Set<() => void>();

  constructor(
    /** Path under the relay, room id already substituted by `pathFor`. */
    private readonly pathFor: (room: RoomId) => string,
    private readonly allow: ReadonlySet<string>,
  ) {}

  /**
   * ANNOUNCE YOURSELF AGAIN. A reconnect is a NEW socket, and the relay knows
   * nothing about a socket it has not been told about — anything this client
   * claimed on the old one (a stage, a listing) died with it.
   *
   * This is not a rare path. The idle watchdog below closes a socket that has
   * heard nothing for 45s, and a live streamer with no viewers yet hears
   * nothing BY DESIGN — so a host reliably recycles its socket about a minute
   * into a show. Without a re-announce the room stays on the public list, looks
   * live, and every viewer who knocks is answered by nobody.
   */
  onOpen(fn: () => void): () => void {
    this.openFns.add(fn);
    return () => { this.openFns.delete(fn); };
  }

  async open(room: RoomId): Promise<void> {
    const base = signalUrl();
    if (!base) throw new Error('signalling is not configured in this build');
    this.room = room;
    this.closed = false;
    try {
      await this.connect();
    } catch (err) {
      // A FIRST connect that fails is a failure the caller hears about — and
      // then nobody holds this object to close it. Without this, `onerror`
      // rejected the promise while `onclose` still scheduled the 600ms retry,
      // and every tap on a room with the relay unreachable left one more
      // immortal reconnect loop running until the page was reloaded.
      this.close();
      throw err;
    }
  }

  private connect(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const url = `${signalUrl().replace(/\/$/, '')}${this.pathFor(this.room)}`;
      let ws: WebSocket;
      try { ws = new WebSocket(url); } catch (err) { reject(err); return; }
      this.ws = ws;
      const fail = () => reject(new Error('could not reach the lobby'));
      ws.onopen = () => {
        ws.onerror = null;
        this.touch();
        // The re-announce goes FIRST, before anything queued behind it — a
        // stage claim that arrives after a knock has already been forwarded to
        // nobody is a claim that arrived too late.
        for (const fn of [...this.openFns]) { try { fn(); } catch { /* one bad listener must not lose the socket */ } }
        for (const msg of this.pending.splice(0)) this.rawSend(msg);
        resolve();
      };
      ws.onerror = fail;
      ws.onclose = () => {
        window.clearTimeout(this.idleTimer);
        if (this.closed || this.ws !== ws) return;
        // One quiet retry. A handshake that outlives a dropped socket is worth
        // more than a tidy error, and the guest's knock has its own timeout to
        // give up on.
        this.ws = null;
        window.setTimeout(() => { if (!this.closed) void this.connect().catch(() => { /* gave up */ }); }, 600);
      };
      ws.onmessage = (ev) => {
        this.touch();
        if (typeof ev.data !== 'string') return;
        let msg: T | null = null;
        try { msg = JSON.parse(ev.data) as T; } catch { return; }
        // A relay is a dumb pipe on the open internet: anything can arrive.
        // Only shapes the protocol knows are handed on.
        if (!msg || typeof (msg as { t?: unknown }).t !== 'string') return;
        if (!this.allow.has(msg.t)) return;
        for (const fn of [...this.listeners]) fn(msg);
      };
    });
  }

  private touch(): void {
    window.clearTimeout(this.idleTimer);
    this.idleTimer = window.setTimeout(() => {
      if (this.closed) return;
      try { this.ws?.close(); } catch { /* already gone */ }
    }, IDLE_MS);
  }

  private rawSend(msg: T): void {
    try { this.ws?.send(JSON.stringify(msg)); } catch { /* the close handler reports it */ }
  }

  send(msg: T): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.rawSend(msg);
    else this.pending.push(msg);
  }

  onMessage(fn: (m: T) => void): () => void {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  }

  close(): void {
    this.closed = true;
    window.clearTimeout(this.idleTimer);
    this.listeners.clear();
    this.pending.length = 0;
    try { this.ws?.close(); } catch { /* already gone */ }
    this.ws = null;
  }
}

const SIGNAL_TYPES: ReadonlySet<string> = new Set(['knock', 'offer', 'answer', 'busy']);

/** The 2-player handshake's socket. */
export class WsTransport extends WsRelay<SignalMsg> implements SignalTransport {
  constructor() {
    super((room) => `/room/${encodeURIComponent(room)}`, SIGNAL_TYPES);
  }
}
