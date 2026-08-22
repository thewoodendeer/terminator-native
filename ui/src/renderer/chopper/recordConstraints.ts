/**
 * RECORD SAMPLE — what we ask the browser for when opening an audio input.
 *
 * THE TRAP (his ask 2026-08-22, "make sure recording from an interface sounds
 * amazing"): `getUserMedia({ audio: true })` is a PHONE-CALL request. Chromium
 * then switches on echo cancellation, noise suppression and automatic gain
 * control, and downmixes the input to MONO — so a stereo interface came in as
 * one pumping, gated, filtered channel. None of that belongs on a sample.
 *
 * So every recorder asks for the RAW input: the three processors OFF, stereo
 * when the device has it, at the engine's sample rate when we know it. Only
 * `deviceId` is `exact`; channels and rate are `ideal`, so a mono mic or a
 * fixed-rate device still opens instead of failing the whole request.
 * Gate: npm run test:record-constraints.
 */
export function recordAudioConstraints(deviceId?: string | null, sampleRate?: number | null): MediaTrackConstraints {
  const c: MediaTrackConstraints = {
    echoCancellation: false,
    noiseSuppression: false,
    autoGainControl: false,
    channelCount: { ideal: 2 },
  };
  if (deviceId) c.deviceId = { exact: deviceId };
  if (sampleRate && sampleRate > 0) c.sampleRate = { ideal: Math.round(sampleRate) };
  return c;
}

/** One line for the UI about what the input actually delivered. */
export function describeRecordTrack(track: MediaStreamTrack | undefined | null): string {
  if (!track) return '';
  let s: MediaTrackSettings = {};
  try { s = track.getSettings(); } catch { /* not all UAs */ }
  const parts: string[] = [];
  if (s.sampleRate) parts.push(`${Math.round(s.sampleRate / 100) / 10} kHz`);
  if (s.channelCount) parts.push(s.channelCount >= 2 ? 'stereo' : 'mono');
  const proc = [s.echoCancellation ? 'echo cancel' : '', s.noiseSuppression ? 'noise gate' : '', s.autoGainControl ? 'auto gain' : ''].filter(Boolean);
  parts.push(proc.length ? `⚠ ${proc.join(' + ')} ON` : 'raw');
  return parts.join(' · ');
}
