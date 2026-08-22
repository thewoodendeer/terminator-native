// ─────────────────────────────────────────────────────────────────────────────
// THE LOBBY — the list of rooms with their doors open.
//
// ── THE SOCKET IS THE HEARTBEAT ─────────────────────────────────────────────
// The obvious design is a table of rooms with a `lastSeen` column, a host that
// re-publishes every twenty seconds, and a reaper that deletes anything stale.
// Three moving parts, one of which is a timer, and the failure mode is a list
// full of rooms that closed ten minutes ago.
//
// Instead: a host holds ONE websocket open for as long as its door is open, and
// the relay lists the room for exactly that long. Close the tab, lose the wifi,
// crash — the socket dies and the room leaves the list in the same instant, with
// nothing to reap and no clock to agree on. It also makes the list LIVE: the
// relay pushes the new list to everybody browsing whenever it changes, so rooms
// appear and vanish while you are looking at them.
//
// ── WHY IT RIDES THE SIGNALLING SOCKET'S SCHEME ─────────────────────────────
// It could have been `fetch()` against `/lobby`. That would need the relay's
// ORIGIN in `connect-src`, and the relay's address is build-time configuration
// — so the CSP would have to name a host nobody has picked yet, or be widened
// to something meaningless. A websocket is covered by the `wss:` already added
// for signalling. One transport, one CSP line, no fetch.
//
// This module holds no player data beyond what a stranger is about to see
// anyway: a handle, a level, and the name of the beat that is playing.
// ─────────────────────────────────────────────────────────────────────────────

import { signalUrl } from './wsSignal';

/** One open door, as a stranger sees it. Nothing here is private: it is the
 *  handle already printed on your posts, your public level, and the name of the
 *  beat on the board. No location, no id, nothing that outlives the socket. */
export interface RoomListing {
  room: string;
  name: string;
  lvl: number;
  beat: string;
  /** GOING LIVE (sim/net/broadcast.ts): the door is open AND the show is on.
   *  A live room is a different offer from an empty one — you are not knocking
   *  to collaborate, you are walking in to watch. */
  live?: boolean;
  /** Reported by the broadcast transport, never counted by the host. */
  viewers?: number;
}

type LobbyOut =
  | { t: 'publish'; room: string; name: string; lvl: number; beat: string; live?: boolean; viewers?: number }
  | { t: 'unpublish' }
  | { t: 'browse' };

type LobbyIn = { t: 'rooms'; rooms: RoomListing[] };

/** The pipe, so the whole thing is testable without a relay (see
 *  `LoopbackLobbySocket`). Same reasoning as `SignalTransport`. */
export interface LobbySocket {
  open(): Promise<void>;
  send(msg: LobbyOut): void;
  onMessage(fn: (msg: LobbyIn) => void): () => void;
  /** Fired on every (re)connect — optional, the loopback never reconnects. */
  onOpen?(fn: () => void): () => void;
  close(): void;
}

function clean(s: string, max: number): string {
  // A relay is an open endpoint and these strings are drawn on other people's
  // screens: control characters out, length capped, and the UI still escapes.
  // Written as an ESCAPED range on purpose — the first version of this line
  // carried literal control bytes, which turned the character class inside out
  // (`[^@-^_^?]`) and would have stripped every room name to nothing.
  return s.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, max);
}

export class WsLobbySocket implements LobbySocket {
  private ws: WebSocket | null = null;
  private readonly listeners = new Set<(m: LobbyIn) => void>();
  private readonly openFns = new Set<() => void>();
  private closed = false;
  private readonly pending: LobbyOut[] = [];

  onOpen(fn: () => void): () => void {
    this.openFns.add(fn);
    return () => { this.openFns.delete(fn); };
  }

  open(): Promise<void> {
    const base = signalUrl();
    if (!base) return Promise.reject(new Error('this build has no lobby relay configured'));
    this.closed = false;
    return new Promise<void>((resolve, reject) => {
      let ws: WebSocket;
      try { ws = new WebSocket(`${base.replace(/\/$/, '')}/lobby`); } catch (e) { reject(e); return; }
      this.ws = ws;
      ws.onerror = () => reject(new Error('could not reach the lobby'));
      let opened = false;
      ws.onopen = () => {
        opened = true;
        ws.onerror = null;
        for (const m of this.pending.splice(0)) this.raw(m);
        // Announced on EVERY connect, including the silent reconnects below —
        // a listing died with the old socket (the socket IS the heartbeat), so
        // whoever holds `mine` puts it back up from here.
        for (const fn of [...this.openFns]) { try { fn(); } catch { /* one listener must not lose the socket */ } }
        resolve();
      };
      ws.onclose = () => {
        if (this.closed || this.ws !== ws) return;
        this.ws = null;
        // A FIRST connect that never opened has already rejected `open()`;
        // retrying from under a caller who was told "no" is how an unreachable
        // relay used to leave a reconnect loop running for the life of the page.
        if (!opened) return;
        // A host whose socket dropped has left the list — reconnecting is how
        // the door goes back up.
        window.setTimeout(() => { if (!this.closed) void this.open().catch(() => { /* stay down */ }); }, 1200);
      };
      ws.onmessage = (ev) => {
        if (typeof ev.data !== 'string') return;
        let msg: LobbyIn | null = null;
        try { msg = JSON.parse(ev.data) as LobbyIn; } catch { return; }
        if (!msg || msg.t !== 'rooms' || !Array.isArray(msg.rooms)) return;
        for (const fn of [...this.listeners]) fn(msg);
      };
    });
  }

  private raw(m: LobbyOut): void {
    try { this.ws?.send(JSON.stringify(m)); } catch { /* the close handler has it */ }
  }

  send(m: LobbyOut): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.raw(m);
    else this.pending.push(m);
  }

  onMessage(fn: (m: LobbyIn) => void): () => void {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  }

  close(): void {
    this.closed = true;
    this.listeners.clear();
    this.openFns.clear();
    this.pending.length = 0;
    try { this.ws?.close(); } catch { /* already gone */ }
    this.ws = null;
  }
}

/**
 * THE LOBBY, as the board uses it. One link, two jobs — hold your own door open
 * and watch everybody else's — because both are the same socket and splitting
 * them would mean a host who is browsing holds two.
 */
export class LobbyLink {
  private rooms: RoomListing[] = [];
  private readonly watchers = new Set<(rooms: RoomListing[]) => void>();
  private mine: LobbyOut | null = null;
  private off: (() => void) | null = null;
  private opening: Promise<void> | null = null;

  constructor(private readonly sock: LobbySocket) {}

  private async ensure(): Promise<void> {
    if (!this.opening) {
      this.opening = this.sock.open().then(() => {
        this.off = this.sock.onMessage((m) => {
          this.rooms = m.rooms;
          for (const fn of [...this.watchers]) fn(this.rooms);
        });
        // A reconnect is a new socket the relay knows nothing about: the door
        // and the browse both have to be said again, or a host whose lobby
        // socket blipped silently fell off the list until they next opened the
        // SESSIONS app (which is the only place `watch()` re-sends `mine`).
        this.sock.onOpen?.(() => {
          if (this.mine) this.sock.send(this.mine);
          if (this.watchers.size) this.sock.send({ t: 'browse' });
        });
      }).catch((err: unknown) => {
        // NOT cached. A rejected open kept every later publish/watch/unpublish
        // rethrowing (and the message listener never attached) even after the
        // relay came back — open SESSIONS offline once and the list stayed
        // empty and GO LIVE never listed the room until a reload.
        this.opening = null;
        throw err;
      });
    }
    await this.opening;
  }

  /** Put your door on the list, and keep it there for as long as this link
   *  lives. Re-sent on a reconnect, because a socket that dropped took the
   *  listing with it. */
  async publish(entry: { room: string; name: string; lvl: number; beat: string; live?: boolean; viewers?: number }): Promise<void> {
    this.mine = {
      t: 'publish',
      room: clean(entry.room, 32),
      name: clean(entry.name, 24) || 'someone',
      lvl: Math.max(0, Math.min(999, Math.round(entry.lvl) || 0)),
      beat: clean(entry.beat, 40),
      live: !!entry.live,
      viewers: Math.max(0, Math.min(999999, Math.round(entry.viewers ?? 0) || 0)),
    };
    await this.ensure();
    this.sock.send(this.mine);
  }

  async unpublish(): Promise<void> {
    this.mine = null;
    if (!this.opening) return;
    await this.ensure();
    this.sock.send({ t: 'unpublish' });
  }

  /** Ask once, then keep hearing about it — the relay pushes a new list every
   *  time a door opens or closes anywhere. */
  async watch(fn: (rooms: RoomListing[]) => void): Promise<() => void> {
    this.watchers.add(fn);
    await this.ensure();
    if (this.mine) this.sock.send(this.mine);        // survived a reconnect
    this.sock.send({ t: 'browse' });
    fn(this.rooms);
    return () => { this.watchers.delete(fn); };
  }

  get listed(): RoomListing[] { return this.rooms; }

  close(): void {
    this.off?.();
    this.off = null;
    this.watchers.clear();
    this.mine = null;
    this.opening = null;
    this.sock.close();
  }
}

/** The relay's own logic, in-process — so the list, the live push and the
 *  socket-is-the-heartbeat rule can all be driven in one page. Mirrors
 *  workers/board-signal's Lobby object; keep the two honest with each other. */
const LOOPBACK: { entries: Map<object, RoomListing>; peers: Set<{ key: object; recv: (m: LobbyIn) => void }> } = {
  entries: new Map(), peers: new Set(),
};

export class LoopbackLobbySocket implements LobbySocket {
  private readonly key = {};
  private readonly listeners = new Set<(m: LobbyIn) => void>();
  private me: { key: object; recv: (m: LobbyIn) => void } | null = null;

  async open(): Promise<void> {
    this.me = { key: this.key, recv: (m) => { for (const fn of [...this.listeners]) fn(m); } };
    LOOPBACK.peers.add(this.me);
  }

  private broadcast(): void {
    const rooms = [...LOOPBACK.entries.values()];
    for (const p of LOOPBACK.peers) setTimeout(() => p.recv({ t: 'rooms', rooms }), 0);
  }

  send(m: LobbyOut): void {
    if (m.t === 'publish') {
      LOOPBACK.entries.set(this.key, { room: m.room, name: m.name, lvl: m.lvl, beat: m.beat, live: m.live, viewers: m.viewers });
      this.broadcast();
    }
    else if (m.t === 'unpublish') { LOOPBACK.entries.delete(this.key); this.broadcast(); }
    else if (m.t === 'browse') {
      const rooms = [...LOOPBACK.entries.values()];
      setTimeout(() => this.me?.recv({ t: 'rooms', rooms }), 0);
    }
  }

  onMessage(fn: (m: LobbyIn) => void): () => void {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  }

  /** The heartbeat rule, proven: closing the socket delists the room. */
  close(): void {
    LOOPBACK.entries.delete(this.key);
    if (this.me) LOOPBACK.peers.delete(this.me);
    this.me = null;
    this.listeners.clear();
    this.broadcast();
  }
}
