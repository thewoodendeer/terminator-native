/**
 * `.mpcsample` exporter — MPC 3 / Drum Dojo "AC50" sample-program format.
 *
 * Wire format:
 *   gzip(
 *     "ACVS\n3.8.0.25\nSerialisableAC50ExportData\njson\nOSX\n" +
 *     JSON.stringify({ data: { sequences, muteGroups, simultPlayTargets }})
 *   )
 *
 * `sequences` is a fixed 128-slot array, keyed 0..127 — MPC's pattern bank.
 * `muteGroups` and `simultPlayTargets` are parallel 128-int arrays (all 0 by
 * default; mute group 0 = no group, simultPlayTarget 0 = no link).
 *
 * Terminator's current sequences (typically 1-4 of them, named A/B/C/…) go
 * into the low keys; the rest stay empty but with valid bpm/length stubs so
 * MPC 3 doesn't choke on the bank.
 *
 * PPQ = 960 (Akai standard). Pad N → MIDI note 36+N (standard MPC Drum mode).
 */

import { ChopperEngine, ChopperState, SeqPattern, SEQ_MAX_STEPS } from '../ChopperEngine';

const MPC_PPQ = 960;
const SLOT_COUNT = 128;
// MPC's eventList.length is the int64 max (9223372036854775807). That exceeds
// JS's Number.MAX_SAFE_INTEGER, so a numeric literal gets mangled to
// 9223372036854776000 by JSON.stringify and the MPC then rejects the file.
// Emit a string placeholder and swap in the exact integer literal afterwards
// (same trick the working Drum Dojo exporter uses).
const INT64_MAX_PLACEHOLDER = '__INT64_MAX__';

function padToMidiNote(padIdx: number): number {
  return 36 + padIdx;
}

function emptyNote(note: number, length: number, velocity = 1.0): any {
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

function buildSequenceValue(bpm: number, pattern: SeqPattern | null): any {
  const bars = pattern?.bars ?? 1;
  const resolution = pattern?.resolution ?? 16;
  const lengthPulses = bars * 4 * MPC_PPQ;     // 4 quarter-notes per bar × 960
  const stepDurTicks = (MPC_PPQ * 4) / resolution;

  const events: any[] = [];
  if (pattern) {
    const stepCount = Math.min(SEQ_MAX_STEPS, bars * resolution);
    for (let step = 0; step < stepCount; step++) {
      const row = pattern.grid[step];
      if (!row || row.length === 0) continue;
      const time = Math.round(step * stepDurTicks);
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
          note: emptyNote(padToMidiNote(padIdx), length),
        });
      }
    }
  }

  return {
    bpm,
    lengthBars: bars,
    lengthPulses,
    tempoEnable: true,
    timeSignatureList: {
      timeSignatures: [
        { beatsPerBar: 4, beatLength: MPC_PPQ, barStart: 0 },
      ],
    },
    eventList: {
      length: INT64_MAX_PLACEHOLDER, // swapped for the int64 literal post-stringify
      events,
      version: 2,
      quantisation: { version: 1, pulses: 0, swing: 0.0, strength: 1.0 },
      numFilterTypes: 30,
    },
  };
}

// Phase 4A.1 — one explicit note event for the Beat Finisher arrangement
// sequence. time/length are in PPQ ticks; note is the MIDI note (36 + padIdx).
export interface MpcArrNote { time: number; note: number; length: number; velocity?: number }

function buildSequenceFromNotes(bpm: number, bars: number, notes: MpcArrNote[]): any {
  const lengthPulses = bars * 4 * MPC_PPQ;
  const events = notes
    .slice()
    .sort((a, b) => a.time - b.time)
    .map((n) => ({
      version: 2, time: Math.round(n.time), type: 3, channel: 0,
      selected: false, muted: false, invented: false,
      note: emptyNote(n.note, Math.max(1, Math.round(n.length)), Math.max(0.01, Math.min(1, n.velocity ?? 1))),
    }));
  return {
    bpm, lengthBars: bars, lengthPulses, tempoEnable: true,
    timeSignatureList: { timeSignatures: [{ beatsPerBar: 4, beatLength: MPC_PPQ, barStart: 0 }] },
    eventList: {
      length: INT64_MAX_PLACEHOLDER, events, version: 2,
      quantisation: { version: 1, pulses: 0, swing: 0.0, strength: 1.0 }, numFilterTypes: 30,
    },
  };
}

/** Phase 4A.1 — build an `.mpcsample` with ONE MPC sequence per Beat Finisher
 *  section (section 0 → slot 0, section 1 → slot 1, …; each carries that
 *  section's chop + drum notes, length = its bars), the remaining slots empty
 *  stubs. `muteGroups` is indexed by pad position (chops → 1 for mono choke,
 *  drums → 0 so they ring independently). PPQ = 960; pad N → MIDI note 36 + N. */
export async function buildArrangementMpcSample(opts: {
  bpm: number; sequences: Array<{ bars: number; notes: MpcArrNote[] }>; muteGroups: number[];
}): Promise<Uint8Array> {
  const built = opts.sequences.slice(0, SLOT_COUNT).map((s) => buildSequenceFromNotes(opts.bpm, s.bars, s.notes));
  const sequences: Array<{ key: number; value: any }> = [];
  for (let k = SLOT_COUNT - 1; k >= 0; k--) {
    sequences.push({ key: k, value: k < built.length ? built[k] : buildSequenceValue(opts.bpm, null) });
  }
  const muteGroups = new Array(SLOT_COUNT).fill(0);
  for (let i = 0; i < Math.min(opts.muteGroups.length, SLOT_COUNT); i++) muteGroups[i] = opts.muteGroups[i];
  const payload = { data: { sequences, muteGroups, simultPlayTargets: new Array(SLOT_COUNT).fill(0) } };
  const json = JSON.stringify(payload).replaceAll(`"${INT64_MAX_PLACEHOLDER}"`, '9223372036854775807');
  return await gzipBytes(ACVS_HEADER + json);
}

const ACVS_HEADER = 'ACVS\n3.8.0.25\nSerialisableAC50ExportData\njson\nOSX\n';

async function gzipBytes(s: string): Promise<Uint8Array> {
  // CompressionStream lands on Safari 16.4 / Chrome 80 / Firefox 113. The
  // user's iPhone is well past that. No polyfill needed.
  const stream = new Blob([s]).stream().pipeThrough(new CompressionStream('gzip'));
  const buf = await new Response(stream).arrayBuffer();
  return new Uint8Array(buf);
}

export async function buildMpcSample(engine: ChopperEngine): Promise<Uint8Array> {
  const state: ChopperState = engine.getState();
  const bpm = state.metronome.bpm > 0 ? state.metronome.bpm : (state.bpm > 0 ? state.bpm : 120);

  // Map Terminator's sequences (A/B/C/…) into the lowest 128 slots; pad the
  // rest with empty stubs. Each MPC slot still needs valid bpm + length info
  // even when empty, otherwise the bank panel renders as zero-bar slots.
  // Descending key order (127 → 0) to match the MPC's own native export. Our
  // sequences map onto the low slots (0 = sequence A, 1 = B, …); the rest are
  // valid empty stubs so the pattern bank renders.
  const sequences: Array<{ key: number; value: any }> = [];
  for (let k = SLOT_COUNT - 1; k >= 0; k--) {
    const pattern = state.sequences[k] ?? null;
    sequences.push({ key: k, value: buildSequenceValue(bpm, pattern) });
  }

  // Put every assigned chop in mute group 1 so the MPC chokes them mono-style —
  // triggering one chop cuts the others off, matching Drum Dojo's exporter and
  // Terminator's own in-app mono behaviour. muteGroups is indexed by PAD
  // position (= midiNote - 36 = pad index); 0 = no group, 1 = group 1.
  const muteGroups = new Array(SLOT_COUNT).fill(0);
  for (const pad of state.pads) {
    if (pad.chopId !== null && pad.index >= 0 && pad.index < SLOT_COUNT) {
      muteGroups[pad.index] = 1;
    }
  }

  const payload = {
    data: {
      sequences,
      muteGroups,
      simultPlayTargets: new Array(SLOT_COUNT).fill(0),
    },
  };

  // No indent — MPC 3 doesn't care about whitespace and gzip handles the size.
  // Swap the int64-max placeholder for the exact literal JS can't hold natively.
  const json = JSON.stringify(payload).replaceAll(`"${INT64_MAX_PLACEHOLDER}"`, '9223372036854775807');
  return await gzipBytes(ACVS_HEADER + json);
}
