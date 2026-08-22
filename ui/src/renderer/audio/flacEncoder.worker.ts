/// <reference lib="webworker" />
/** FLAC encode off the main thread — see flacEncode.ts. Quantises (TPDF 16-bit,
 *  encodeWAV's quantiser) AND encodes here, so the UI thread does nothing but
 *  hand over the float channels. */
import { encodeFLAC, quantizeTPDF16 } from './flacEncoder';

interface Msg { chans: Float32Array[]; length: number; sampleRate: number }
self.addEventListener('message', (e: MessageEvent<Msg>) => {
  const { chans, length, sampleRate } = e.data;
  const out = encodeFLAC(quantizeTPDF16(chans, length), sampleRate, 16);
  (self as DedicatedWorkerGlobalScope).postMessage(out, [out.buffer]);
});
