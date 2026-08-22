/**
 * FLAC off-thread: a float AudioBuffer goes to a Web Worker that quantises it
 * to 16-bit (TPDF, the same quantiser as encodeWAV 16) and encodes it — a 3-minute stem
 * takes a second or two, which would otherwise freeze the UI on "SAVING
 * STEMS". The worker is INLINED (blob URL) so it loads under file:// in the
 * packaged app and under the web CSP (worker-src 'self' blob:) alike; if a
 * worker can't start, the encode runs on the caller's thread — same bytes.
 */
import FlacWorker from './flacEncoder.worker?worker&inline';
import { encodeFLAC, quantizeTPDF16 } from './flacEncoder';

export async function encodeFlac16(buf: AudioBuffer): Promise<Uint8Array> {
  const chans: Float32Array[] = [];
  for (let c = 0; c < buf.numberOfChannels; c++) chans.push(buf.getChannelData(c));
  const sync = () => encodeFLAC(quantizeTPDF16(chans, buf.length), buf.sampleRate, 16);
  return new Promise<Uint8Array>((resolve) => {
    let w: Worker;
    try { w = new FlacWorker(); } catch { resolve(sync()); return; }
    w.onmessage = (e: MessageEvent<Uint8Array>) => { resolve(e.data); w.terminate(); };
    w.onerror = () => { resolve(sync()); w.terminate(); };
    // Cloned, not transferred: the engine keeps playing these buffers, and the
    // fallback still needs them if the worker dies.
    w.postMessage({ chans, length: buf.length, sampleRate: buf.sampleRate });
  });
}
