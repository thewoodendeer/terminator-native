// ─────────────────────────────────────────────────────────────────────────────
// MUSIC, NOT A PHONE CALL.
//
// Victor, 2026-08-12: *"how can we make live streaming and private sessions
// audio quality the best it can be? doesnt sound the best right now"*.
//
// It did not sound the best because nothing here had ever asked it to. Every
// offer and answer in this codebase went out exactly as `createOffer()` built
// it, and WebRTC's defaults are tuned for SPEECH on a bad connection:
//
//   · MONO. Opus only sends stereo if the SDP says `stereo=1` / `sprop-stereo=1`.
//     A producer's mix arriving folded to mono is the single biggest loss, and
//     it is one line of SDP.
//   · ~32 kbit/s. Absent `maxaveragebitrate`, Chrome targets a rate chosen for
//     voice. Music at 32k is the swirly, underwater sound he is describing.
//   · DTX — "discontinuous transmission" — stops sending during quiet passages
//     and fills with comfort noise. Correct for a conference call; for a beat
//     with space in it, it eats the tails and pumps.
//
// So this file states what the connection is actually carrying. It is applied
// to BOTH ends of BOTH features (a show and a private session), because these
// are negotiated parameters: the sender advertising `sprop-stereo` is only half
// of it — the receiver has to answer `stereo=1` or it will be handed a fold.
//
// ── WHY TWO BITRATES ────────────────────────────────────────────────────────
// A private session is ONE peer, so it gets the transparent setting. A show is
// up to `DEFAULT_SEATS` (12) separate encodes out of one home upload, and 12 ×
// 256k is ~3 Mbit/s up, which is more than a lot of domestic connections have
// to give. 160k stereo Opus is already excellent for music — the audible jump
// is from 32 to 160, not from 160 to 256 — so the show takes the setting that
// still works when twelve people turn up.
// ─────────────────────────────────────────────────────────────────────────────

/** ONE peer, all the headroom there is. Opus is effectively transparent here. */
export const SESSION_AUDIO_BITRATE = 256_000;
/** Up to twelve simultaneous encodes out of one home upload. See the header. */
export const LIVE_AUDIO_BITRATE = 160_000;

/** The Opus parameters that turn a voice call into a music feed. Order is not
 *  significant; the values are. */
function opusParams(bitrate: number): Record<string, string> {
  return {
    // THE BIG ONE. Both halves are required and they are not the same claim:
    // `sprop-stereo` says "I will send stereo", `stereo` says "I can receive
    // it". Every description gets both, because each end is doing both jobs.
    'stereo': '1',
    'sprop-stereo': '1',
    'maxaveragebitrate': String(bitrate),
    // Full bandwidth. Without it Opus may cap playback rate for "speech".
    'maxplaybackrate': '48000',
    // Keep the encoder's frames short — long frames add latency, and this is a
    // performance somebody is playing along with.
    'minptime': '10',
    'ptime': '20',
    // Forward error correction: cheap insurance on a home connection, and it
    // degrades far more gracefully than a dropout.
    'useinbandfec': '1',
    // OFF. See the header — DTX is why quiet passages pump.
    'usedtx': '0',
  };
}

/**
 * Rewrite an SDP so its Opus stream carries music. Returns the SDP unchanged if
 * there is no Opus m-line to tune, so this is always safe to call.
 *
 * Deliberately a MERGE rather than a replacement: Chrome puts its own
 * parameters on that fmtp line and we only own the ones we name.
 */
export function tuneOpusSdp(sdp: string, bitrate: number): string {
  if (!sdp) return sdp;
  // Opus is always 48000/2 in the rtpmap even when it ends up sending mono.
  const pts = [...sdp.matchAll(/^a=rtpmap:(\d+)\s+opus\/48000\/2/gmi)].map(m => m[1]);
  if (!pts.length) return sdp;

  const want = opusParams(bitrate);
  // \r\n is the spec, but be tolerant reading and preserve whatever was used.
  const eol = sdp.includes('\r\n') ? '\r\n' : '\n';
  const lines = sdp.split(/\r\n|\n/);
  const out: string[] = [];

  for (const pt of pts) {
    const at = lines.findIndex(l => l.startsWith(`a=fmtp:${pt} `) || l.startsWith(`a=fmtp:${pt}\t`));
    if (at >= 0) {
      const existing = lines[at].slice(`a=fmtp:${pt}`.length).trim();
      const merged: Record<string, string> = {};
      for (const kv of existing.split(';')) {
        const t = kv.trim();
        if (!t) continue;
        const eq = t.indexOf('=');
        if (eq < 0) { merged[t] = ''; continue; }
        merged[t.slice(0, eq)] = t.slice(eq + 1);
      }
      Object.assign(merged, want);                 // ours win, theirs survive
      lines[at] = `a=fmtp:${pt} ${Object.entries(merged)
        .map(([k, v]) => (v === '' ? k : `${k}=${v}`)).join(';')}`;
    } else {
      // No fmtp line for this payload: add one directly after its rtpmap.
      const rt = lines.findIndex(l => new RegExp(`^a=rtpmap:${pt}\\s+opus/48000/2`, 'i').test(l));
      if (rt >= 0) {
        lines.splice(rt + 1, 0, `a=fmtp:${pt} ${Object.entries(want)
          .map(([k, v]) => `${k}=${v}`).join(';')}`);
      }
    }
  }
  out.push(...lines);
  return out.join(eol);
}

/** The same intent said the OTHER way — SDP advertises what the codec may do,
 *  `setParameters` is what the sender is actually told to spend. Chrome honours
 *  this for audio, and without it the encoder can sit well under the ceiling
 *  the SDP allows. Failures are swallowed: this is quality, never correctness,
 *  and an older engine that refuses must not take the show down with it. */
export async function tuneAudioSender(sender: RTCRtpSender | null | undefined, bitrate: number): Promise<void> {
  if (!sender) return;
  try {
    const p = sender.getParameters();
    // `encodings` can legitimately be empty before the first negotiation.
    if (!p.encodings || !p.encodings.length) (p as RTCRtpSendParameters).encodings = [{}];
    for (const e of p.encodings) {
      e.maxBitrate = bitrate;
      // Never let the browser drop the music to save the picture — there is no
      // picture. (Ignored where unsupported.)
      (e as { networkPriority?: string }).networkPriority = 'high';
      (e as { priority?: string }).priority = 'high';
    }
    await sender.setParameters(p);
  } catch { /* quality is best-effort; the show goes on */ }
}

/** Convenience for the two call sites that build a description and immediately
 *  hand it to `setLocalDescription`. */
export function tunedDescription(
  d: RTCSessionDescriptionInit, bitrate: number,
): RTCSessionDescriptionInit {
  return d.sdp ? { type: d.type, sdp: tuneOpusSdp(d.sdp, bitrate) } : d;
}
