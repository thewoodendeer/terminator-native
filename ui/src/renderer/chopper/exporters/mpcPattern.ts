/**
 * Build a `.mpcpattern` (MPC 3 / newer Akai MPC) from the current sequencer
 * pattern. The format is plain JSON — schema reverse-engineered from real
 * MPC 3 exports. PPQ is fixed at 960 (Akai standard since the MPC60).
 *
 * Pad → MIDI note mapping uses the MPC default Drum-mode layout:
 *   pad  1 = note 36 (C1)   pad  2 = 37   pad  3 = 38  pad  4 = 39
 *   pad  5 = note 40        pad  6 = 41   pad  7 = 42  pad  8 = 43
 *   pad  9 = note 44        pad 10 = 45   pad 11 = 46  pad 12 = 47
 *   pad 13 = note 48        pad 14 = 49   pad 15 = 50  pad 16 = 51
 */

import { ChopperEngine, ChopperState, SEQ_MAX_STEPS } from '../ChopperEngine';

const MPC_PPQ = 960;

function padToMidiNote(padIdx: number): number {
  return 36 + padIdx;
}

export function buildMpcPattern(engine: ChopperEngine): string {
  const state: ChopperState = engine.getState();
  const seq = state.sequences[state.currentSeqIdx];
  if (!seq) throw new Error('No sequence selected');

  const stepCount = Math.min(SEQ_MAX_STEPS, seq.bars * seq.resolution);
  // One step = (4 beats per bar / resolution) quarters; one quarter = MPC_PPQ ticks
  const stepDurTicks = (MPC_PPQ * 4) / seq.resolution;

  const events: object[] = [];
  for (let step = 0; step < stepCount; step++) {
    const row = seq.grid[step];
    if (!row || row.length === 0) continue;
    const time = Math.round(step * stepDurTicks);
    // 50% gate length — feels right for one-shot drum hits. The user can
    // resize notes inside MPC 3 if they want longer ratchets.
    const length = Math.max(1, Math.round(stepDurTicks * 0.5));
    for (const padIdx of row) {
      events.push({
        version: 2,
        time,
        type: 3,
        channel: 0,
        selected: false,
        muted: false,
        invented: false,
        note: noteShape(padToMidiNote(padIdx), 1.0, length),
      });
    }
  }

  // MPC pads' built-in "length: maxint" is documented as "play to next event";
  // we preserve that so MPC 3 doesn't try to clip the pattern length.
  const pattern = {
    pattern: {
      length: 9223372036854775807,
      events,
      version: 2,
      quantisation: { version: 1, pulses: 0, swing: 0.0, strength: 1.0 },
      numFilterTypes: 30,
    },
  };
  return JSON.stringify(pattern, null, 4);
}

/** The verbose note payload MPC emits. 16 modifier slots stay at defaults. */
function noteShape(note: number, velocity: number, length: number): object {
  const obj: any = {
    version: 1,
    note,
    velocity,
    length,
    probability: 100,
    ratchet: 1,
    articulation: 197,
  };
  for (let i = 0; i < 16; i++) {
    obj[`modifierValue${i}`] = (i === 0 || i === 1 || i === 5) ? 0.5 : (i === 6 ? 1.0 : 0.0);
    obj[`modifierActiveState${i}`] = false;
  }
  obj['EnumCerealisationWrapper(selectedModifierType)'] = 'Tuning (coarse)';
  return obj;
}
