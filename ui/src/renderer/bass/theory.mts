// Keys + scales for the BASS piano roll and its MIDI input lock. Pure, import-
// free, headless-testable (scripts/bass-theory.test.mts). Lives as .mts so plain node can import it (package.json is "type": "commonjs").
//
// A "key" is a root pitch class (0..11, C=0) + a scale. `snapToScale` moves any
// MIDI note to the nearest in-scale note (ties go DOWN — bass players resolve
// downward), which is what both the piano roll (drawing/dragging) and the MIDI
// input use when the lock is on. CHROMATIC = no lock.

export const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'] as const;

export type ScaleId =
  | 'chromatic' | 'major' | 'minor' | 'harmonicMinor' | 'melodicMinor'
  | 'dorian' | 'phrygian' | 'lydian' | 'mixolydian' | 'locrian'
  | 'majorPent' | 'minorPent' | 'blues' | 'phrygianDom' | 'wholeTone';

export interface ScaleDef { id: ScaleId; name: string; short: string; steps: number[] }

/** Interval sets (semitones from the root). Order = the picker order. */
export const SCALES: ScaleDef[] = [
  { id: 'chromatic',     name: 'Chromatic',        short: 'CHROM',  steps: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11] },
  { id: 'minor',         name: 'Natural minor',    short: 'MIN',    steps: [0, 2, 3, 5, 7, 8, 10] },
  { id: 'major',         name: 'Major',            short: 'MAJ',    steps: [0, 2, 4, 5, 7, 9, 11] },
  { id: 'minorPent',     name: 'Minor pentatonic', short: 'MIN P',  steps: [0, 3, 5, 7, 10] },
  { id: 'majorPent',     name: 'Major pentatonic', short: 'MAJ P',  steps: [0, 2, 4, 7, 9] },
  { id: 'blues',         name: 'Blues',            short: 'BLUES',  steps: [0, 3, 5, 6, 7, 10] },
  { id: 'harmonicMinor', name: 'Harmonic minor',   short: 'HARM',   steps: [0, 2, 3, 5, 7, 8, 11] },
  { id: 'melodicMinor',  name: 'Melodic minor',    short: 'MELO',   steps: [0, 2, 3, 5, 7, 9, 11] },
  { id: 'dorian',        name: 'Dorian',           short: 'DOR',    steps: [0, 2, 3, 5, 7, 9, 10] },
  { id: 'phrygian',      name: 'Phrygian',         short: 'PHRY',   steps: [0, 1, 3, 5, 7, 8, 10] },
  { id: 'phrygianDom',   name: 'Phrygian dominant',short: 'PHR D',  steps: [0, 1, 4, 5, 7, 8, 10] },
  { id: 'lydian',        name: 'Lydian',           short: 'LYD',    steps: [0, 2, 4, 6, 7, 9, 11] },
  { id: 'mixolydian',    name: 'Mixolydian',       short: 'MIXO',   steps: [0, 2, 4, 5, 7, 9, 10] },
  { id: 'locrian',       name: 'Locrian',          short: 'LOC',    steps: [0, 1, 3, 5, 6, 8, 10] },
  { id: 'wholeTone',     name: 'Whole tone',       short: 'WHOLE',  steps: [0, 2, 4, 6, 8, 10] },
];

export function scaleDef(id: ScaleId): ScaleDef {
  return SCALES.find((s) => s.id === id) ?? SCALES[0];
}

export interface KeyLock { root: number; scale: ScaleId }

/** True when `midi` sits in the key. Chromatic → always true. */
export function inScale(midi: number, key: KeyLock): boolean {
  const steps = scaleDef(key.scale).steps;
  if (steps.length === 12) return true;
  const pc = (((midi - key.root) % 12) + 12) % 12;
  return steps.includes(pc);
}

/** Nearest in-scale note. Equidistant → the LOWER note. Chromatic → identity. */
export function snapToScale(midi: number, key: KeyLock): number {
  const steps = scaleDef(key.scale).steps;
  if (steps.length === 12) return midi;
  if (inScale(midi, key)) return midi;
  for (let d = 1; d <= 6; d++) {
    if (inScale(midi - d, key)) return midi - d;
    if (inScale(midi + d, key)) return midi + d;
  }
  return midi;
}

/** Scale degree (1-based) of an in-scale note, else null. Used for the roll's
 *  row labels ("1 · 3 · 5" reads faster than note names when you're locked). */
export function scaleDegree(midi: number, key: KeyLock): number | null {
  const steps = scaleDef(key.scale).steps;
  const pc = (((midi - key.root) % 12) + 12) % 12;
  const i = steps.indexOf(pc);
  return i < 0 ? null : i + 1;
}

/** "C2", "F#2" … MIDI 60 = C4 — the same convention as audio/MidiInput.ts
 *  midiNoteToName (36 = C2). */
export function noteName(midi: number): string {
  const n = Math.round(midi);
  return `${NOTE_NAMES[((n % 12) + 12) % 12]}${Math.floor(n / 12) - 1}`;
}

export const isBlackKey = (midi: number): boolean => [1, 3, 6, 8, 10].includes(((midi % 12) + 12) % 12);

/** All in-scale MIDI notes within [lo, hi] — the rows the roll shows when
 *  "fold to scale" is on. */
export function scaleNotesInRange(lo: number, hi: number, key: KeyLock): number[] {
  const out: number[] = [];
  for (let n = lo; n <= hi; n++) if (inScale(n, key)) out.push(n);
  return out;
}

/** Move a note by `steps` scale degrees (chromatic: semitones). Used by the
 *  roll's ↑/↓ transpose so a locked melody stays locked. */
export function stepInScale(midi: number, steps: number, key: KeyLock): number {
  const def = scaleDef(key.scale);
  if (def.steps.length === 12) return midi + steps;
  let n = snapToScale(midi, key);
  const dir = steps > 0 ? 1 : -1;
  for (let i = 0; i < Math.abs(steps); i++) {
    n += dir;
    while (!inScale(n, key)) n += dir;
  }
  return n;
}

// ── MPC pads as a bass keyboard ──────────────────────────────────────────
/** The MPC's first pad (A01) sends MIDI 36 (C1); banks stack upward in 16s. */
export const MPC_PAD_BASE_NOTE = 36;
/** Which pad (0-based) carries the ROOT: pad 4 — so pads 1–3 sit below it. */
export const MPC_ROOT_PAD = 3;

/** Note a bass pad-controller pad plays. `midiNote` is what the MPC sent
 *  (36 = pad A01, 37 = A02 … banks continue upward). Pad 4 is the ROOT (root
 *  in octave 2, like the on-screen pads); with the LOCK on every pad is a
 *  DIFFERENT note of the key — pad 5 the next scale note up, pad 3 the one
 *  below — so sixteen pads never repeat a note. Chromatic / lock off: pad 4 =
 *  root, a semitone per pad either side. */
export function mpcPadNote(midiNote: number, key: KeyLock, lock: boolean): number {
  const i = midiNote - MPC_PAD_BASE_NOTE - MPC_ROOT_PAD;   // 0 = the root pad
  const base = 36 + key.root;                              // root, octave 2
  let n: number;
  if (!lock || key.scale === 'chromatic') n = base + i;
  else {
    const steps = scaleDef(key.scale).steps, L = steps.length;
    const oct = Math.floor(i / L);
    const deg = ((i % L) + L) % L;
    n = base + oct * 12 + steps[deg];
  }
  return Math.max(0, Math.min(127, n));
}
