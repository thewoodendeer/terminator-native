/**
 * Drum-pattern generation — ported as-faithfully-as-possible from Drum Dojo
 * (subscription-starter/app/drums/page.tsx) so Terminator's drum sequencer
 * matches its behaviour:
 *   - Boom Bap → fetch the shared /api/midi-files?genre=boombap endpoint
 *     (8th-hat files already sorted first there), pick one weighted toward the
 *     top of the list, parse it to a 16th-note step grid.
 *   - Trap → the built-in TRAP_PATTERNS bank (no MIDI files exist for trap).
 *
 * The note map + MIDI parser + weighting + trap banks are copied verbatim from
 * Drum Dojo so the two apps produce identical results. Only the surface (typed
 * to Terminator's TrackKey, async helpers) is new. No external dependencies —
 * the MIDI reader is hand-rolled, same as Drum Dojo.
 */

import type { TrackKey } from './DrumEngine';

// In Electron (MODE !== 'web') the /api and /midi routes aren't served locally —
// they live on the KCC site. Prefix with the live origin so the desktop app can
// pull real Boom Bap MIDI; in the web build this is '' (same-origin).
const KCC_BASE = (import.meta as any).env?.MODE !== 'web'
  ? 'https://killaviccheatcodes.app'
  : '';

export type DrumPattern = Record<TrackKey, boolean[]>;

const KEYS: TrackKey[] = ['kick', 'snare', 'hihat', 'openhat', 'perc'];

// Verbatim from Drum Dojo — maps GM-ish drum notes to the 6 tracks. Note 'perc'
// has no incoming note (kept empty from MIDI; trap banks fill it).
const MIDI_NOTE_TO_KEY: Record<number, TrackKey> = {
  35: 'kick', 36: 'kick',
  37: 'snare', 38: 'hihat', 40: 'snare',
  42: 'hihat', 44: 'hihat',
  39: 'openhat', 46: 'openhat',
};

function emptyPattern(totalSteps: number): DrumPattern {
  return {
    kick: Array(totalSteps).fill(false),
    snare: Array(totalSteps).fill(false),
    hihat: Array(totalSteps).fill(false),
    openhat: Array(totalSteps).fill(false),
    perc: Array(totalSteps).fill(false),
  };
}

/** Parse a Standard MIDI File's note-ons onto a 16th-note step grid. Verbatim
 *  port of Drum Dojo's parseMidiToSteps (raw byte reader — no library). */
export function parseMidiToSteps(buf: ArrayBuffer, totalSteps: number): DrumPattern {
  const data = new Uint8Array(buf);
  const ppq = (data[12] << 8) | data[13];
  const step16 = ppq / 4;
  const result = emptyPattern(totalSteps);

  let pos = 14;
  while (pos < data.length - 8) {
    if (!(data[pos] === 0x4D && data[pos + 1] === 0x54 && data[pos + 2] === 0x72 && data[pos + 3] === 0x6B)) { pos++; continue; }
    const trackEnd = pos + 8 + ((data[pos + 4] << 24) | (data[pos + 5] << 16) | (data[pos + 6] << 8) | data[pos + 7]);
    pos += 8;
    let tick = 0;
    let lastStatus = 0;
    const hits: Array<{ tick: number; note: number }> = [];

    while (pos < trackEnd) {
      let delta = 0;
      while (pos < trackEnd) { const b = data[pos++]; delta = (delta << 7) | (b & 0x7F); if (!(b & 0x80)) break; }
      tick += delta;

      let status = data[pos];
      if (status & 0x80) { lastStatus = status; pos++; } else { status = lastStatus; }

      const type = status & 0xF0;
      if (type === 0x90) {
        const note = data[pos++], vel = data[pos++];
        if (vel > 0) hits.push({ tick, note });
      } else if (type === 0x80) {
        pos += 2;
      } else if (type === 0xA0 || type === 0xB0 || type === 0xE0) {
        pos += 2;
      } else if (type === 0xC0 || type === 0xD0) {
        pos += 1;
      } else if (status === 0xFF) {
        pos++;
        let ml = 0; while (pos < trackEnd) { const b = data[pos++]; ml = (ml << 7) | (b & 0x7F); if (!(b & 0x80)) break; }
        pos += ml;
        lastStatus = 0;
      } else if (status === 0xF0 || status === 0xF7) {
        let ml = 0; while (pos < trackEnd) { const b = data[pos++]; ml = (ml << 7) | (b & 0x7F); if (!(b & 0x80)) break; }
        pos += ml;
        lastStatus = 0;
      } else {
        pos++;
      }
    }

    if (hits.length > 0) {
      const minTick = hits[0].tick;
      for (const { tick: t, note } of hits) {
        const key = MIDI_NOTE_TO_KEY[note];
        if (!key) continue;
        const step = Math.round((t - minTick) / step16) % totalSteps;
        if (step >= 0 && step < totalSteps) result[key][step] = true;
      }
    }
    pos = trackEnd;
  }
  return result;
}

/** Bias selection toward the front of the list (~75% from the top third). The
 *  caller pre-filters to the "8th Hat" batch, so this just varies within them. */
function pickWeightedMidi(files: string[]): string {
  if (files.length === 0) return '';
  if (files.length <= 3) return files[Math.floor(Math.random() * files.length)];
  const topThird = Math.max(1, Math.ceil(files.length / 3));
  if (Math.random() < 0.75) return files[Math.floor(Math.random() * topThird)];
  return files[topThird + Math.floor(Math.random() * (files.length - topThird))];
}

/** Boom Bap: reuse the shared KCC endpoint (same-origin in the web build) and a
 *  real Boom Bap MIDI file. Returns null on any failure so the caller can fall
 *  back to the built-in bank. */
export async function generateBoomBapFromMidi(totalSteps: number): Promise<DrumPattern | null> {
  try {
    const listRes = await fetch(`${KCC_BASE}/api/midi-files?genre=boombap`);
    if (!listRes.ok) return null;
    const { files } = (await listRes.json()) as { files: string[] };
    if (!files || files.length === 0) return null;
    // Pull from the "8th Hat" batch first — those are the intended boom-bap
    // grooves (8th-note hats). Fall back to the rest only if none are present.
    const eighth = files.filter(f => /8th/i.test(f));
    const file = pickWeightedMidi(eighth.length ? eighth : files);
    // Encode each path segment (filenames contain spaces) but keep the slashes.
    const midiRes = await fetch(`${KCC_BASE}/midi/${file.split('/').map(encodeURIComponent).join('/')}`);
    if (!midiRes.ok) return null;
    const arr = await midiRes.arrayBuffer();
    return parseMidiToSteps(arr, totalSteps);
  } catch {
    return null;
  }
}

// ── Trap pattern bank (verbatim from Drum Dojo) ──────────────────────────────
const TRAP_KICKS = [
  [1,0,0,0,0,0,0,0,1,0,0,0,0,0,0,0],[1,0,0,0,0,0,0,0,0,0,1,0,0,0,0,0],
  [1,0,0,0,1,0,0,0,0,0,0,0,1,0,0,0],[1,0,0,1,0,0,0,0,1,0,0,0,0,0,0,0],
  [1,0,0,0,0,0,0,0,1,0,1,0,0,0,0,0],[1,0,0,0,0,0,1,0,0,0,0,0,1,0,0,0],
  [1,0,0,0,0,0,0,0,1,0,0,0,1,0,0,0],[1,0,1,0,0,0,0,0,1,0,0,0,0,0,1,0],
  [1,0,0,0,0,1,0,0,1,0,0,0,0,0,0,0],[1,0,0,0,1,0,0,0,0,0,1,0,0,0,0,0],
  [1,0,0,0,0,0,0,0,0,0,1,0,1,0,0,0],[1,0,0,1,0,0,0,0,0,0,0,0,1,0,0,0],
];
const TRAP_SNARES = [
  [0,0,0,0,1,0,0,0,0,0,0,0,1,0,0,0],[0,0,0,0,1,0,0,0,0,0,0,0,1,0,1,0],
  [0,0,0,0,1,0,0,1,0,0,0,0,1,0,0,0],[0,0,0,0,1,0,0,0,0,0,0,1,1,0,0,0],
  [0,0,0,0,1,0,0,0,0,0,0,0,1,0,0,1],[0,0,0,1,1,0,0,0,0,0,0,0,1,0,0,0],
  [0,0,0,0,1,0,1,0,0,0,0,0,1,0,0,0],
];
const TRAP_HIHATS = [
  [1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0],[1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1],
  [1,1,0,1,1,0,1,0,1,1,0,1,1,0,1,0],[0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1],
  [1,0,0,1,0,0,1,0,1,0,0,1,0,0,1,0],[1,1,0,0,1,1,0,0,1,1,0,0,1,1,0,0],
  [1,0,1,1,0,1,1,0,1,0,1,1,0,1,1,0],[1,1,1,0,1,1,0,1,1,1,0,1,1,0,1,1],
  [1,0,1,0,0,1,0,1,1,0,1,0,0,1,0,1],[1,0,1,1,1,0,1,1,1,0,1,1,1,0,1,1],
  [1,0,1,0,1,1,1,0,1,0,1,0,1,1,1,0],[1,1,0,1,0,1,1,1,1,1,0,1,0,1,1,1],
];
const TRAP_OPENHATS = [
  [0,0,0,0,0,0,0,1,0,0,0,0,0,0,0,1],[0,0,0,0,0,0,1,0,0,0,0,0,0,0,1,0],
  [0,0,0,1,0,0,0,0,0,0,0,1,0,0,0,0],[0,0,0,0,0,0,0,1,0,0,0,0,0,0,0,0],
  [0,0,0,0,0,1,0,0,0,0,0,0,0,1,0,0],[0,0,0,0,0,0,0,0,0,0,0,1,0,0,0,1],
  [0,0,0,0,0,0,0,0,0,0,0,0,0,0,1,0],
];
const TRAP_PERCS = [
  [0,0,1,0,0,1,0,0,0,0,1,0,0,0,0,1],[0,0,0,1,0,0,1,0,0,0,0,1,0,0,0,0],
  [0,1,0,0,0,1,0,0,0,1,0,0,0,1,0,0],[0,0,1,0,1,0,0,0,0,0,1,0,1,0,0,0],
  [0,0,0,0,1,0,0,0,0,0,0,0,1,0,1,0],[0,0,1,0,0,0,1,0,0,1,0,0,0,0,1,0],
  [0,1,0,0,1,0,0,1,0,0,1,0,0,1,0,0],[0,0,0,0,0,0,1,0,0,0,0,0,0,1,0,0],
];

// buildPatternBank — verbatim from Drum Dojo (coprime strides so each track
// cycles independently across the 50 combinations).
function buildPatternBank(
  kicks: number[][], snares: number[][], hihats: number[][],
  openhats: number[][], percs: number[][], count = 50,
): DrumPattern[] {
  const patterns: DrumPattern[] = [];
  for (let i = 0; i < count; i++) {
    patterns.push({
      kick: kicks[i % kicks.length].map(Boolean),
      snare: snares[(i * 3) % snares.length].map(Boolean),
      hihat: hihats[(i * 7) % hihats.length].map(Boolean),
      openhat: openhats[(i * 11) % openhats.length].map(Boolean),
      perc: percs[(i * 17) % percs.length].map(Boolean),
    });
  }
  return patterns;
}

const TRAP_PATTERNS = buildPatternBank(TRAP_KICKS, TRAP_SNARES, TRAP_HIHATS, TRAP_OPENHATS, TRAP_PERCS);

/** Trap: pick a random pattern from the built-in bank, tiled to totalSteps. */
export function generateTrap(totalSteps: number): DrumPattern {
  const base = TRAP_PATTERNS[Math.floor(Math.random() * TRAP_PATTERNS.length)];
  const tile = (row: boolean[]): boolean[] => {
    const out = new Array<boolean>(totalSteps);
    for (let i = 0; i < totalSteps; i++) out[i] = row[i % 16];
    return out;
  };
  const out = emptyPattern(totalSteps);
  for (const k of KEYS) out[k] = tile(base[k]);
  return out;
}
