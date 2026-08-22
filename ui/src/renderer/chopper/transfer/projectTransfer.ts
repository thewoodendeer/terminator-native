// TRANSFER TO DEVICE — send a project (with its samples) from one Terminator
// to another: desktop app → iPad web, phone → laptop, any pair. No account, no
// upload: the sender shows an 8-character code, the receiver types it, the
// two machines meet peer-to-peer (the Board's WebRTC stack: board-signal relay
// for the handshake, STUN/TURN for the path) and the project BUNDLE streams
// over the reliable 'bulk' data channel in 16 KB frames with backpressure.
// The receiver imports it exactly like a `.tprojz` opened from disk.
//
// Frames on the bulk channel (both directions), little-endian:
//   [u32 kind][payload]   kind 1 = HEAD  JSON { name, size, sha1 }
//                          kind 2 = DATA  [u32 offset][bytes]
//                          kind 3 = END
//                          kind 4 = DONE  (receiver → sender: imported OK)
//                          kind 5 = FAIL  JSON { error }
import { NetSession } from '../../board/sim/net/session';
import { SignalHost, signalJoin, newRoomId } from '../../board/sim/net/signal';
import { WsTransport, signallingAvailable } from '../../board/sim/net/wsSignal';

const CHUNK = 16 * 1024;
const K_HEAD = 1, K_DATA = 2, K_END = 3, K_DONE = 4, K_FAIL = 5;

export type TransferPhase = 'idle' | 'waiting' | 'connecting' | 'sending' | 'receiving' | 'importing' | 'done' | 'failed' | 'busy' | 'timeout';
export interface TransferProgress { phase: TransferPhase; sent: number; total: number; detail?: string; code?: string; name?: string }
type OnProgress = (p: TransferProgress) => void;

const enc = new TextEncoder(), dec = new TextDecoder();
function frame(kind: number, payload: Uint8Array | ArrayBuffer, offset?: number): ArrayBuffer {
  const p = payload instanceof Uint8Array ? payload : new Uint8Array(payload);
  const hasOff = kind === K_DATA;
  const out = new Uint8Array(4 + (hasOff ? 4 : 0) + p.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, kind, true);
  if (hasOff) dv.setUint32(4, offset ?? 0, true);
  out.set(p, 4 + (hasOff ? 4 : 0));
  return out.buffer;
}
function parse(buf: ArrayBuffer): { kind: number; offset: number; payload: Uint8Array } {
  const dv = new DataView(buf);
  const kind = dv.getUint32(0, true);
  if (kind === K_DATA) return { kind, offset: dv.getUint32(4, true), payload: new Uint8Array(buf, 8) };
  return { kind, offset: 0, payload: new Uint8Array(buf, 4) };
}
async function sha1Hex(bytes: Uint8Array): Promise<string> {
  const copy = new Uint8Array(bytes.byteLength); copy.set(bytes);
  const d = await crypto.subtle.digest('SHA-1', copy.buffer as ArrayBuffer);
  return Array.from(new Uint8Array(d)).map((b) => b.toString(16).padStart(2, '0')).join('');
}
const waitBulk = (s: NetSession, ms = 15000) => new Promise<boolean>((res) => {
  const t0 = performance.now();
  const iv = setInterval(() => {
    if (s.bulkReady) { clearInterval(iv); res(true); }
    else if (performance.now() - t0 > ms || s.state === 'failed' || s.state === 'closed') { clearInterval(iv); res(false); }
  }, 80);
});

export const transferAvailable = (): boolean => typeof RTCPeerConnection !== 'undefined' && signallingAvailable();

/** SENDER: host a room, hand back the code, stream the bundle when a device
 *  joins. Returns a handle with the code + a cancel(). */
export function sendProject(bundle: Uint8Array, name: string, onProgress: OnProgress): { code: string; cancel: () => void } {
  const session = new NetSession();
  const transport = new WsTransport();
  const host = new SignalHost(transport, session);
  const code = newRoomId();
  let cancelled = false;
  const stop = () => { try { host.stop(); } catch { /* */ } try { session.close(); } catch { /* */ } };
  const report = (p: Partial<TransferProgress>) => onProgress({ phase: 'waiting', sent: 0, total: bundle.length, code, name, ...p });
  report({ phase: 'waiting' });
  session.onState((st, detail) => {
    if (cancelled) return;
    if (st === 'connecting' || st === 'answering' || st === 'offering') report({ phase: 'connecting', detail });
    if (st === 'failed') report({ phase: 'failed', detail: detail || 'the two devices could not reach each other' });
  });
  const offBin = session.onBinary((buf) => {
    const f = parse(buf);
    if (f.kind === K_DONE) { report({ phase: 'done', sent: bundle.length }); setTimeout(stop, 800); }
    if (f.kind === K_FAIL) { let e = 'the other device could not import it'; try { e = JSON.parse(dec.decode(f.payload)).error || e; } catch { /* */ } report({ phase: 'failed', detail: e }); }
  });
  void (async () => {
    try {
      await host.listen(code, () => true);
      // wait for a live bulk pipe
      const t0 = performance.now();
      while (!cancelled && !session.bulkReady) {
        if (session.state === 'failed') return;
        if (performance.now() - t0 > 10 * 60 * 1000) { report({ phase: 'timeout', detail: 'nobody joined' }); stop(); return; }
        await new Promise((r) => setTimeout(r, 120));
      }
      if (cancelled) return;
      report({ phase: 'sending', sent: 0 });
      const sha1 = await sha1Hex(bundle);
      if (!session.sendBulk(frame(K_HEAD, enc.encode(JSON.stringify({ name, size: bundle.length, sha1, v: 1 }))))) throw new Error('link dropped');
      for (let off = 0; off < bundle.length && !cancelled; off += CHUNK) {
        await session.drain();
        if (!session.sendBulk(frame(K_DATA, bundle.subarray(off, Math.min(bundle.length, off + CHUNK)), off))) throw new Error('link dropped mid-send');
        if ((off / CHUNK) % 8 === 0) report({ phase: 'sending', sent: Math.min(bundle.length, off + CHUNK) });
      }
      if (cancelled) return;
      await session.drain();
      session.sendBulk(frame(K_END, new Uint8Array(0)));
      report({ phase: 'sending', sent: bundle.length, detail: 'waiting for the other device to import…' });
    } catch (e: any) {
      report({ phase: 'failed', detail: e?.message ?? String(e) });
      stop();
    }
  })();
  return { code, cancel: () => { cancelled = true; offBin(); stop(); } };
}

/** RECEIVER: join a code, collect the bundle, hand the bytes to `onBundle`
 *  (which imports it); reports back DONE / FAIL to the sender. */
export function receiveProject(code: string, onProgress: OnProgress, onBundle: (bytes: Uint8Array, name: string) => Promise<void>): { cancel: () => void } {
  const session = new NetSession();
  const transport = new WsTransport();
  let cancelled = false;
  let buf: Uint8Array | null = null;
  let head: { name: string; size: number; sha1: string } | null = null;
  let got = 0;
  const stop = () => { try { transport.close(); } catch { /* */ } try { session.close(); } catch { /* */ } };
  const report = (p: Partial<TransferProgress>) => onProgress({ phase: 'connecting', sent: got, total: head?.size ?? 0, name: head?.name, ...p });
  report({ phase: 'connecting' });
  session.onState((st, detail) => {
    if (cancelled) return;
    if (st === 'failed') report({ phase: 'failed', detail: detail || 'the two devices could not reach each other' });
  });
  session.onBinary((b) => {
    if (cancelled) return;
    const f = parse(b);
    if (f.kind === K_HEAD) {
      try { head = JSON.parse(dec.decode(f.payload)); } catch { head = null; }
      if (!head || !Number.isFinite(head.size) || head.size <= 0 || head.size > 600 * 1024 * 1024) { session.sendBulk(frame(K_FAIL, enc.encode(JSON.stringify({ error: 'bad header' })))); report({ phase: 'failed', detail: 'bad transfer header' }); return; }
      buf = new Uint8Array(head.size); got = 0;
      report({ phase: 'receiving', sent: 0, total: head.size, name: head.name });
    } else if (f.kind === K_DATA && buf && head) {
      if (f.offset + f.payload.length > buf.length) return;
      buf.set(f.payload, f.offset); got += f.payload.length;
      if ((f.offset / CHUNK) % 8 === 0) report({ phase: 'receiving', sent: got, total: head.size, name: head.name });
    } else if (f.kind === K_END && buf && head) {
      const bytes = buf, h = head;
      void (async () => {
        try {
          report({ phase: 'importing', sent: got, total: h.size, name: h.name });
          const sha = await sha1Hex(bytes);
          if (sha !== h.sha1) throw new Error('the transfer arrived damaged — try again');
          await onBundle(bytes, h.name);
          session.sendBulk(frame(K_DONE, new Uint8Array(0)));
          report({ phase: 'done', sent: h.size, total: h.size, name: h.name });
          setTimeout(stop, 800);
        } catch (e: any) {
          session.sendBulk(frame(K_FAIL, enc.encode(JSON.stringify({ error: e?.message ?? String(e) }))));
          report({ phase: 'failed', detail: e?.message ?? String(e) });
          setTimeout(stop, 800);
        }
      })();
    }
  });
  void (async () => {
    try {
      const r = await signalJoin(transport, session, code.trim().toUpperCase(), { name: 'Terminator', lvl: 0 });
      if (cancelled) return;
      if (r === 'busy') { report({ phase: 'busy', detail: 'that code is taken by another device or has already been used' }); stop(); return; }
      if (r === 'timeout') { report({ phase: 'timeout', detail: 'no device answered that code — check it, and that the sender still shows it' }); stop(); return; }
      const ok = await waitBulk(session);
      if (!ok && !cancelled) { report({ phase: 'failed', detail: 'the two devices could not reach each other' }); stop(); }
    } catch (e: any) { report({ phase: 'failed', detail: e?.message ?? String(e) }); stop(); }
  })();
  return { cancel: () => { cancelled = true; stop(); } };
}
