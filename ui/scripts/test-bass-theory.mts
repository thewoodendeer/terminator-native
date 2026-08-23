/** BASS THEORY GATE — keys/scales/snap used by the piano roll + MIDI lock (the Electron repo's
 *  scripts/bass-theory.test.mts, copied verbatim-in-logic — Node ≥ 22.6 strips the types).   npm run test:bass-theory */
import { snapToScale, inScale, scaleDegree, noteName, stepInScale, scaleNotesInRange, SCALES, mpcPadNote } from '../src/renderer/bass/theory.mts';

const failures: string[] = [];
const check = (c: boolean, m: string) => { if (!c) failures.push(m); };

const Cmin = { root: 0, scale: 'minor' as const };
const Amaj = { root: 9, scale: 'major' as const };
const chrom = { root: 4, scale: 'chromatic' as const };

// C minor = C D Eb F G Ab Bb
check(inScale(36, Cmin) && inScale(39, Cmin) && inScale(43, Cmin), 'C minor: chord tones in scale');
check(!inScale(37, Cmin) && !inScale(40, Cmin) && !inScale(47, Cmin), 'C minor: C#, E, B out of scale');
// snap: E (40) → nearest is Eb (39) or F (41): tie → DOWN
check(snapToScale(40, Cmin) === 39, `snap E→Eb (got ${snapToScale(40, Cmin)})`);
check(snapToScale(37, Cmin) === 36, `snap C#→C (got ${snapToScale(37, Cmin)})`);
check(snapToScale(47, Cmin) === 46, `snap B→Bb (got ${snapToScale(47, Cmin)})`);
check(snapToScale(42, Cmin) === 41, `snap F#→F tie down (got ${snapToScale(42, Cmin)})`);
check(snapToScale(43, Cmin) === 43, 'snap in-scale G stays');
// A major = A B C# D E F# G#
check(snapToScale(48, Amaj) === 47, `A major: C→B (tie, down) (got ${snapToScale(48, Amaj)})`);
check(inScale(56, Amaj) && !inScale(55, Amaj), 'A major: G# in, G out');
// chromatic = identity
for (let n = 20; n < 90; n++) check(snapToScale(n, chrom) === n, `chromatic identity ${n}`);
// degrees
check(scaleDegree(36, Cmin) === 1 && scaleDegree(39, Cmin) === 3 && scaleDegree(43, Cmin) === 5, 'C minor degrees 1 3 5');
check(scaleDegree(40, Cmin) === null, 'E has no degree in C minor');
// names — the repo's midiNoteToName convention (60 = C4, so 36 = C2)
check(noteName(36) === 'C2' && noteName(60) === 'C4' && noteName(42) === 'F#2' && noteName(24) === 'C1', `noteName ${noteName(36)} ${noteName(60)} ${noteName(42)}`);
// step in scale: from C up 2 degrees in C minor = Eb; down 1 from C = Bb
check(stepInScale(36, 2, Cmin) === 39, `stepInScale up 2 → ${stepInScale(36, 2, Cmin)}`);
check(stepInScale(36, -1, Cmin) === 34, `stepInScale down 1 → ${stepInScale(36, -1, Cmin)}`);
check(stepInScale(40, 1, chrom) === 41, 'chromatic step = semitone');
// range fold
const rows = scaleNotesInRange(36, 47, Cmin);
check(rows.length === 7 && rows[0] === 36 && rows[6] === 46, `scaleNotesInRange C1..B1 = ${rows.join(',')}`);
// every scale: root in scale, all steps unique + sorted + within an octave
for (const s of SCALES) {
  check(s.steps[0] === 0, `${s.id}: root missing`);
  check(s.steps.every((v, i) => i === 0 || v > s.steps[i - 1]), `${s.id}: steps not sorted`);
  check(s.steps.every((v) => v >= 0 && v < 12), `${s.id}: step out of octave`);
  for (let n = 0; n < 128; n++) check(inScale(snapToScale(n, { root: 5, scale: s.id }), { root: 5, scale: s.id }), `${s.id}: snap(${n}) not in scale`);
}

if (!failures.length) console.log('bass-theory: scale checks passed');

// Pad fold: with the lock on, the 16 pads must be 16 DIFFERENT in-key notes,
// ascending from the root — mirrors BassEngine.padNote (kept in sync by hand:
// engine code needs the DOM, this is its formula).
{
  const { scaleDef: sd } = await import('../src/renderer/bass/theory.mts');
  const padNote = (i: number, key: { root: number; scale: any }) => { const st = sd(key.scale).steps; return 36 + key.root + Math.floor(i / st.length) * 12 + st[i % st.length]; };
  for (const key of [Cmin, Amaj, { root: 7, scale: 'minorPent' as const }, { root: 2, scale: 'blues' as const }]) {
    const notes = Array.from({ length: 16 }, (_, i) => padNote(i, key));
    check(new Set(notes).size === 16, `pad fold ${key.scale}: duplicate notes ${notes.join(',')}`);
    check(notes.every((n, i) => i === 0 || n > notes[i - 1]), `pad fold ${key.scale}: not ascending`);
    check(notes.every((n) => inScale(n, key)), `pad fold ${key.scale}: out-of-key note`);
    check(notes[0] === 36 + key.root, `pad fold ${key.scale}: pad 1 is not the root`);
  }
}

// MPC pads as a bass keyboard: pad 4 (MIDI 39) = the root; with the lock on
// every pad is a different note of the key, pads 1–3 below the root.
{
  const pads = (key: any, lock: boolean) => Array.from({ length: 16 }, (_, p) => mpcPadNote(36 + p, key, lock));
  const cm = pads(Cmin, true);
  check(cm[3] === 36, `MPC: pad 4 is the root C2 (got ${cm[3]})`);
  check(cm[4] === 38 && cm[5] === 39 && cm[6] === 41, `MPC: pads 5–7 climb the scale D Eb F (got ${cm.slice(4, 7)})`);
  check(cm[2] === 34 && cm[1] === 32 && cm[0] === 31, `MPC: pads 1–3 sit below the root Bb Ab G (got ${cm.slice(0, 3)})`);
  check(new Set(cm).size === 16, 'MPC: 16 pads = 16 different notes, no duplicates');
  check(cm.every((n) => inScale(n, Cmin)), 'MPC: every pad is in the key');
  const bankB = mpcPadNote(36 + 16, Cmin, true);
  check(bankB > cm[15] && inScale(bankB, Cmin), `MPC: bank B pad 1 continues upward, still in key (got ${bankB})`);
  const chrom = pads(Cmin, false);
  check(chrom[3] === 36 && chrom[4] === 37 && chrom[2] === 35, `MPC lock off: chromatic around the root (got ${chrom.slice(2, 5)})`);
  const am = pads(Amaj, true);
  check(am[3] === 45 && am[4] === 47 && am[2] === 44, `MPC A major: pad 4 = A2, pad 5 = B, pad 3 = G# (got ${am.slice(2, 5)})`);
}

if (failures.length) { console.error(`bass-theory(pads): ${failures.length} failure(s)`); for (const f of failures) console.error('  ✗ ' + f); process.exit(1); }
console.log('bass-theory: pad fold ok');
