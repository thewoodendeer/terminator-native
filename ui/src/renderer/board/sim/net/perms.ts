// ─────────────────────────────────────────────────────────────────────────────
// THE SHARED BOARD — who is allowed to touch it.
//
// ONE RULE, and every other line here follows from it: THE HOST DECIDES. The
// guest holds a copy of what it was told, purely so its own screen can stop a
// gesture early and say why — but the host validates every change that arrives
// against its OWN copy before letting it near the console. A client that lies
// about its permissions changes nothing on the other machine.
//
// The levels are Victor's, verbatim:
//   NONE  — you are in the room, you hear the beat, the board is not yours
//   MIX   — knobs and faders (and cuts and solos: they are the mix too)
//   FULL  — the mix, plus the right to export the beat
// Transport ownership rides ALONGSIDE the level rather than inside it, because
// it is handed over and taken back on its own: "only the host can take it back"
// is the whole point of it being separate.
// ─────────────────────────────────────────────────────────────────────────────

import type { PermLevel } from './session';

export interface Grant {
  level: PermLevel;
  /** They hold play/stop and the playhead. Only the host clears this. */
  transport: boolean;
  /** Their chat is off. (Voice, when it exists, lands under the same switch.) */
  muted: boolean;
}

export const NO_GRANT: Grant = { level: 'none', transport: false, muted: false };

/** May they move the desk — knobs, faders, cuts, solos? */
export function canMix(g: Grant): boolean { return g.level === 'mix' || g.level === 'full'; }

/** May they export the beat? FULL only, and only ever by the owner's choice.
 *  Enforced on the guest's own client, which is a social contract with friction
 *  and a receipt attached, NOT a vault — the honest limit, stated where the
 *  decision is made rather than buried in a design doc. */
export function canExport(g: Grant): boolean { return g.level === 'full'; }

/** May they load a beat onto the shared board without asking first? Nobody can:
 *  a guest's load always raises the popup on the host's screen. Kept as a named
 *  function so the day that becomes a level, there is one place to change. */
export function canLoadUnasked(_g: Grant): boolean { return false; }

export function levelLabel(g: Grant): string {
  if (g.level === 'full') return 'FULL ACCESS';
  if (g.level === 'mix') return 'MIX ONLY';
  return 'LISTENING';
}
