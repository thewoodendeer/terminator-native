import { Track } from './Track';

export type WAVBitDepth = 8 | 16 | 24 | 32;
export type ExportFormat = 'wav' | 'mp3' | 'flac';

export interface ExportOptions {
  format: ExportFormat;
  bitDepth: WAVBitDepth;
  dry: boolean; // export without effects
}

export function encodeWAV(buf: AudioBuffer, bitDepth: WAVBitDepth = 16): ArrayBuffer {
  const numCh = buf.numberOfChannels;
  const numSamples = buf.length;
  const sr = buf.sampleRate;

  const bytesPerSample = bitDepth === 32 ? 4 : bitDepth === 24 ? 3 : bitDepth === 8 ? 1 : 2;
  const blockAlign = numCh * bytesPerSample;
  const dataSize = numSamples * blockAlign;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  writeStr(view, 0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeStr(view, 8, 'WAVE');
  writeStr(view, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, bitDepth === 32 ? 3 : 1, true); // 3 = IEEE float
  view.setUint16(22, numCh, true);
  view.setUint32(24, sr, true);
  view.setUint32(28, sr * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitDepth, true);
  writeStr(view, 36, 'data');
  view.setUint32(40, dataSize, true);

  // Channels hoisted ONCE (getChannelData per sample was ~16M binding calls
  // on a 3-minute stereo stem — seconds of main-thread freeze on "Encoding").
  const chans: Float32Array[] = [];
  for (let ch = 0; ch < numCh; ch++) chans.push(buf.getChannelData(ch));

  let offset = 44;
  if (bitDepth === 32) {
    for (let i = 0; i < numSamples; i++) {
      for (let ch = 0; ch < numCh; ch++) {
        view.setFloat32(offset, Math.max(-1, Math.min(1, chans[ch][i])), true);
        offset += 4;
      }
    }
  } else if (bitDepth === 24) {
    for (let i = 0; i < numSamples; i++) {
      for (let ch = 0; ch < numCh; ch++) {
        const x = Math.max(-1, Math.min(1, chans[ch][i]));
        // Round to nearest (was truncation toward zero: a systematic −½ LSB
        // bias and a tiny DC/distortion floor on quiet tails).
        const v = Math.max(-8388608, Math.min(8388607, Math.round(x * 8388607)));
        view.setUint8(offset,     v & 0xff);
        view.setUint8(offset + 1, (v >> 8) & 0xff);
        view.setUint8(offset + 2, (v >> 16) & 0xff);
        offset += 3;
      }
    }
  } else if (bitDepth === 16) {
    // TPDF dither (±1 LSB triangular) then round: the requantisation error
    // becomes benign, signal-independent noise at ~−93 dBFS instead of the
    // correlated distortion that plain truncation leaves on reverb tails and
    // fades. Standard mastering practice for a 16-bit deliverable.
    let s1 = 0x2545f491, s2 = 0x9e3779b9;
    const rnd = () => { // two independent xorshift32 streams
      s1 ^= s1 << 13; s1 ^= s1 >>> 17; s1 ^= s1 << 5;
      s2 ^= s2 << 13; s2 ^= s2 >>> 17; s2 ^= s2 << 5;
      return ((s1 >>> 0) / 4294967296) - ((s2 >>> 0) / 4294967296); // triangular in (−1, 1)
    };
    for (let i = 0; i < numSamples; i++) {
      for (let ch = 0; ch < numCh; ch++) {
        const x = Math.max(-1, Math.min(1, chans[ch][i]));
        const v = Math.max(-32768, Math.min(32767, Math.round(x * 32767 + rnd())));
        view.setInt16(offset, v, true);
        offset += 2;
      }
    }
  } else {
    for (let i = 0; i < numSamples; i++) {
      for (let ch = 0; ch < numCh; ch++) {
        const x = Math.max(-1, Math.min(1, chans[ch][i]));
        view.setUint8(offset, Math.max(0, Math.min(255, Math.round((x + 1) * 127.5))));
        offset += 1;
      }
    }
  }
  return buffer;
}

function writeStr(view: DataView, offset: number, str: string) {
  for (let i = 0; i < str.length; i++) {
    view.setUint8(offset + i, str.charCodeAt(i));
  }
}

export async function exportStem(
  track: Track,
  loopDuration: number,
  bpm: number,
  opts: ExportOptions
): Promise<{ name: string; data: ArrayBuffer }> {
  if (!track.buffer) throw new Error('Track has no audio');

  // Dry export: the raw unaltered recording, bypassing stretch, pitch, FX, and
  // track volume/pan. Useful for saving the source take.
  // Wet export: render through the full effects chain with stretch + pitch
  // baked in, track volume/pan applied.
  const buf = opts.dry
    ? track.buffer
    : await track.renderOffline(loopDuration, bpm);

  const data = encodeWAV(buf, opts.bitDepth);
  return { name: track.name.replace(/\s+/g, '_'), data };
}

export async function exportMaster(
  tracks: Track[],
  loopDuration: number,
  bpm: number,
  opts: ExportOptions
): Promise<{ name: string; data: ArrayBuffer }> {
  // Render each non-muted track individually through its FX chain, then sum
  // into a master buffer. Respects solo (any soloed track mutes the rest).
  const anySoloed = tracks.some(t => t.soloed);
  const active = tracks.filter(t => t.buffer && !t.muted && (!anySoloed || t.soloed));
  if (active.length === 0) {
    const sr = tracks[0]?.buffer?.sampleRate ?? 44100;
    const scratch = new AudioContext();
    const empty = scratch.createBuffer(2, Math.ceil(loopDuration * sr), sr);
    const data = encodeWAV(empty, opts.bitDepth);
    scratch.close?.().catch(() => {}); // don't leak a live AudioContext (iOS caps them)
    return { name: 'MASTER', data };
  }

  // Render + sum ONE stem at a time so we never hold every full-length stem
  // buffer in memory simultaneously (iOS export heap). The wet path renders each
  // stem through its FX chain then releases it before the next render; the dry
  // path sums the raw track buffers (nulling the local ref just drops our handle,
  // it doesn't free the track's own buffer).
  const scratch = new AudioContext();
  let out: AudioBuffer | null = null;
  let sr = 0;
  let len = 0;
  for (const t of active) {
    let stem: AudioBuffer | null = opts.dry ? t.buffer! : await t.renderOffline(loopDuration, bpm);
    if (!out) {
      sr = stem.sampleRate;
      len = Math.ceil(loopDuration * sr);
      out = scratch.createBuffer(2, len, sr);
    }
    for (let ch = 0; ch < 2; ch++) {
      const dst = out.getChannelData(ch);
      const srcCh = stem.numberOfChannels > ch ? stem.getChannelData(ch) : stem.getChannelData(0);
      const limit = Math.min(len, srcCh.length);
      for (let i = 0; i < limit; i++) dst[i] += srcCh[i];
    }
    stem = null; // drop the stem ref before rendering the next (frees the wet render)
  }

  const data = encodeWAV(out!, opts.bitDepth);
  scratch.close?.().catch(() => {}); // free the scratch AudioContext — never reused, would leak on iOS
  return { name: 'MASTER', data };
}
