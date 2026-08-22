// MIDI LEARN — which CC to bind when the user moves "the control".
//
// Binding the FIRST CC message that arrives is how a learn ends up on the wrong
// thing: a Launchkey-class controller sends extra messages around a fader move
// (a 14-bit LSB partner on cc+32 whose value jumps 0..127 on every step, a
// fader-touch / button CC that only ever says 0 or 127), and the mapping then
// reads as ON/OFF while the Akai knob next to it is smooth. So a learn waits
// for a message that can only be a real, continuous control:
//   • a value between 1 and 126 — a fader / knob caught mid-travel — binds at once;
//   • a 14-bit LSB (cc 32–63 right after a message on cc−32) never binds;
//   • a CC that only says 0 / 127 binds only after it has spoken 3 times
//     (a button press is 127 then 0 — two messages; a fader slammed end to end
//     and back says more).
// Pure + headless-testable (scripts/midi-learn.test.mts).

export class LearnPicker {
  private seen = new Map<string, number[]>();
  private lastAt = new Map<string, number>();

  reset(): void { this.seen.clear(); this.lastAt.clear(); }

  /** Feed one CC; returns true when THIS message should complete the learn. */
  feed(ch: number, cc: number, val: number, now: number): boolean {
    const key = `${ch}:${cc}`;
    this.lastAt.set(key, now);
    // 14-bit LSB partner: cc−32 spoke within the last 80 ms → this is its low byte.
    if (cc >= 32 && cc <= 63) {
      const msbAt = this.lastAt.get(`${ch}:${cc - 32}`);
      if (msbAt !== undefined && now - msbAt < 80) return false;
    }
    const vals = this.seen.get(key) ?? [];
    vals.push(val);
    this.seen.set(key, vals);
    if (val > 0 && val < 127) return true;          // mid-travel: a real continuous control
    return vals.length >= 3;                        // end-stop values only: wait for a third
  }
}
