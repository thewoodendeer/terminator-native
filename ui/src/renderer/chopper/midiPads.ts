/**
 * MIDI note → pad index. The ONE definition, shared by both layouts.
 *
 * Akai MPC pad bank A01 = C1 = note 36. Each MPC bank is 16 pads, so its banks
 * A-D send notes 36-51, 52-67, 68-83 and 84-99 — which, offset by 36, land
 * exactly on the hardware layout's four banks of 16. A01 plays your first chop,
 * B01 plays the seventeenth, and nothing needs configuring.
 *
 * This module exists because the two views each rolled their own mapping and
 * drifted: the classic view offset by 36 (correct), while the hardware view
 * passed the raw note straight in as a pad index — so an MPC's A01 fired pad 36
 * instead of pad 1, and on the free tier (pad lock at 3) fired nothing at all.
 * One exported helper, two call sites, no room to drift again.
 */

/** C1 — Akai MPC pad bank A01. */
export const MPC_PAD_BASE_NOTE = 36;

/**
 * Pad index for an incoming note, or `null` when the note sits below the pad
 * range and addresses nothing. Callers must treat `null` as "not a pad" rather
 * than coercing it — a negative index reaches past the start of the pad array
 * and would read as an empty pad, which the engine answers by SLICING.
 */
export function padIndexForNote(note: number): number | null {
  const idx = note - MPC_PAD_BASE_NOTE;
  return idx >= 0 ? idx : null;
}
