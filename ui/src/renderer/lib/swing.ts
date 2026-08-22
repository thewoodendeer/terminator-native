/**
 * 16T SWING — one formula for BOTH sequencers (the drum lanes and the chop
 * seq), so a swung beat's chops and drums land on the same late off-beat.
 * Odd 16ths are pushed late by `swing × half a 16th`, snapped toward the 96-PPQ
 * pulse grid as the amount rises (MPC-style). Downbeats never move.
 */
export function swingOffsetSec(step16: number, bpm: number, swing: number): number {
  const s = swing;
  if (s <= 0 || step16 % 2 === 0) return 0;
  if (bpm <= 0) return 0;
  const stepDurMs = (60000 / bpm) / 4;            // 16th-note duration
  const pulseDurMs = 60000 / bpm / 96;            // one 96-PPQ pulse
  const swung = s * (stepDurMs / 2);              // push the off-beat late
  const quantized = Math.round(swung / pulseDurMs) * pulseDurMs; // snap the offset to a pulse
  const finalMs = swung + s * (quantized - swung); // crossfade the snap in with the amount
  return finalMs / 1000;                          // → seconds
}
