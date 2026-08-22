// ─────────────────────────────────────────────────────────────────────────────
// HOW TWO MACHINES REACH EACH OTHER.
//
// STUN tells a machine its own public address, which is enough for roughly four
// pairs in five to meet directly. The fifth is behind carrier-grade NAT — a lot
// of mobile networks, plenty of offices and campuses — where neither side can
// be reached from outside at all, and no amount of trying fixes it. Those pairs
// need a TURN server: a machine in the middle that both sides CAN reach, which
// forwards their traffic.
//
// ── WHY THE CREDENTIALS ARE FETCHED AND NOT BUILT IN ────────────────────────
// A TURN server costs money per gigabyte, so its credentials are worth stealing.
// A username and password compiled into `dist-web` is a static credential on the
// open internet: anyone who opens devtools has free bandwidth on somebody else's
// bill, forever, with no way to revoke it short of rotating the server. This is
// the same rule that keeps every other key out of this bundle, and it is the
// reason `workers/board-signal` mints these instead — the API token lives there
// as a Worker secret and the browser only ever receives credentials that expire.
//
// ── FAILING TO STUN, ALWAYS ─────────────────────────────────────────────────
// Every failure here — no relay configured, the endpoint down, TURN not set up,
// a network blip — lands on the same STUN-only answer that the board has always
// used. That matters more than it sounds: four in five pairs never needed TURN,
// and a broken credential service must not take THEM offline too. There is no
// path through this file that throws.
// ─────────────────────────────────────────────────────────────────────────────

import { signalUrl } from './wsSignal';

/** What the board has always used, and what everything falls back to. */
const STUN_ONLY: RTCConfiguration = {
  iceServers: [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }],
};

/** How long a fetched set is trusted when the worker does not say. The worker
 *  caches a minted set for TTL−10min and hands the SAME set to everyone in that
 *  window — so a client fetching late in the window may hold credentials with
 *  only ten minutes left. 45 minutes here meant up to ~35 minutes of a client
 *  building peer connections on EXPIRED relay credentials (STUN-only for the
 *  one-in-five pairs that need the relay, silently). Newer workers send
 *  `expiresIn`; this is the ceiling either way. */
const REFRESH_MS = 8 * 60 * 1000;
/** Refresh this long before the credentials the worker described run out. */
const MARGIN_MS = 3 * 60 * 1000;

let cached: { at: number; ttlMs: number; conf: RTCConfiguration; turn: boolean } | null = null;
/** One flight at a time: opening a session and going live in the same second
 *  must not become two requests. */
let inFlight: Promise<RTCConfiguration> | null = null;

/** Whether the last answer actually carried a relay. Read by the probe and by
 *  anything that wants to tell the player their connection is being relayed. */
export function turnAvailable(): boolean { return !!cached?.turn; }

/**
 * The ICE configuration for a NEW peer connection. Cheap after the first call,
 * never throws, and always returns something usable.
 */
export async function iceConfig(): Promise<RTCConfiguration> {
  if (cached && Date.now() - cached.at < cached.ttlMs) return cached.conf;
  if (inFlight) return inFlight;
  inFlight = fetchIce().finally(() => { inFlight = null; });
  return inFlight;
}

async function fetchIce(): Promise<RTCConfiguration> {
  const base = signalUrl();
  if (!base) return STUN_ONLY;
  try {
    // A short timeout on purpose: this sits in front of every handshake, and a
    // credential service that is merely SLOW must not be felt as a board that
    // will not connect. Two seconds, then go with STUN.
    const ctl = new AbortController();
    const bail = setTimeout(() => ctl.abort(), 2000);
    const res = await fetch(`${base.replace(/^ws/, 'http').replace(/\/$/, '')}/ice`, { signal: ctl.signal });
    clearTimeout(bail);
    if (!res.ok) return STUN_ONLY;
    const body = await res.json() as { iceServers?: RTCIceServer[]; turn?: boolean; expiresIn?: number };
    if (!Array.isArray(body.iceServers) || !body.iceServers.length) return STUN_ONLY;
    const conf: RTCConfiguration = { iceServers: body.iceServers };
    // Trust it for as long as the worker says minus a margin, never longer than
    // the ceiling — and a STUN-only answer is re-asked soon (the relay may be
    // back next time).
    const said = typeof body.expiresIn === 'number' && isFinite(body.expiresIn) ? body.expiresIn * 1000 - MARGIN_MS : REFRESH_MS;
    const ttlMs = body.turn ? Math.max(30_000, Math.min(REFRESH_MS, said)) : 60_000;
    cached = { at: Date.now(), ttlMs, conf, turn: !!body.turn };
    return conf;
  } catch {
    return STUN_ONLY;               // aborted, offline, blocked, malformed — all the same answer
  }
}
