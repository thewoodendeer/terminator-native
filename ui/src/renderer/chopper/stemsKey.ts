// STEMS CONTENT KEY — what the GLOBAL STEMS CACHE is filed under.
//
// His ask (2026-08-20): "if terminator already stemmed out your song/sample,
// it shouldn't have to do it ever again". So the shortcut is filed against the
// AUDIO ITSELF, not the project, the YouTube id or the filename — the same
// song loaded any other way finds the same stems, and audio that ISN'T the
// same (a trim, a different sample rate, a swapped sample) misses cleanly
// instead of reusing stems that no longer belong to it.
//
// The key hashes a strided PROBE rather than every sample: ~64k samples plus
// the rate, length and channel count. That is ~10ms on a full song instead of
// hundreds of ms, and two different songs agreeing on all of it is not a thing
// that happens. Bump PIPELINE whenever a split's OUTPUT changes (new model
// line, new overlap-add, new resampling) — old entries then miss by design.

/** Only ever goes UP. A bump retires every cached split on every machine. */
export const PIPELINE = 1;
const KEY_SAMPLES = 65536;

/** What the key needs from an AudioBuffer (so this stays testable in node). */
export interface KeyableAudio {
  sampleRate: number;
  length: number;
  numberOfChannels: number;
  getChannelData(channel: number): Float32Array;
}

export async function audioKey(buf: KeyableAudio): Promise<string> {
  const ch = Math.min(2, buf.numberOfChannels);
  const per = Math.max(1, Math.floor(KEY_SAMPLES / ch));
  const stride = Math.max(1, Math.floor(buf.length / per));
  const probe = new Float32Array(4 + per * ch);
  probe[0] = PIPELINE; probe[1] = buf.sampleRate; probe[2] = buf.length; probe[3] = ch;
  for (let c = 0; c < ch; c++) {
    const data = buf.getChannelData(c);
    for (let i = 0; i < per; i++) probe[4 + c * per + i] = data[Math.min(buf.length - 1, i * stride)];
  }
  const digest = await crypto.subtle.digest('SHA-1', probe.buffer as ArrayBuffer);
  return `s${PIPELINE}.` + Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('');
}
