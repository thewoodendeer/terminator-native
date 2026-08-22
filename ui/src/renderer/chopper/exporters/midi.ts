/**
 * Standard MIDI File exporter — format 1 (multi-track).
 *
 * Track layout:
 *   Track 0:  tempo + time signature meta events only (the conductor track).
 *   Track 1..N: one per Terminator sequence (A / B / C / …), each with its
 *               note events and a track-name meta tag.
 *
 * Resolution is 960 PPQ to match the rest of Terminator's exporters and
 * Akai's standard. Most DAWs (Live, Logic, FL, Reaper, Cubase, …) accept
 * any PPQ in the header.
 *
 * Pad N → MIDI note 36 + N (the same MPC drum-mode mapping as the other
 * exporters), so swapping back and forth between MIDI and MPC formats
 * lines up cleanly on the keyboard.
 */

import { ChopperEngine, ChopperState, SeqPattern, SEQ_MAX_STEPS } from '../ChopperEngine';

const PPQ = 960;

function padToMidiNote(padIdx: number): number {
  return 36 + padIdx;
}

/** MIDI variable-length quantity: 7 bits per byte, MSB set when more follow. */
function writeVarLen(out: number[], value: number): void {
  if (value < 0) value = 0;
  let buffer = value & 0x7F;
  while ((value >>= 7) > 0) {
    buffer <<= 8;
    buffer |= ((value & 0x7F) | 0x80);
  }
  // eslint-disable-next-line no-constant-condition
  while (true) {
    out.push(buffer & 0xFF);
    if (buffer & 0x80) buffer >>= 8;
    else break;
  }
}

function pushUint32BE(out: number[], v: number): void {
  out.push((v >>> 24) & 0xFF, (v >>> 16) & 0xFF, (v >>> 8) & 0xFF, v & 0xFF);
}
function pushUint16BE(out: number[], v: number): void {
  out.push((v >>> 8) & 0xFF, v & 0xFF);
}
function pushString(out: number[], s: string): void {
  for (let i = 0; i < s.length; i++) out.push(s.charCodeAt(i) & 0xFF);
}

/** Tempo meta event: FF 51 03 <microseconds-per-quarter:24bit BE>. */
function tempoMetaBytes(bpm: number): number[] {
  const upq = Math.max(1, Math.round(60_000_000 / Math.max(1, bpm)));
  return [0xFF, 0x51, 0x03, (upq >> 16) & 0xFF, (upq >> 8) & 0xFF, upq & 0xFF];
}

/** Time sig meta: FF 58 04 num denom-power clocks notes32 — fixed 4/4 for now. */
function timeSig44Bytes(): number[] {
  // 4 (num) / 2^2 (denom=4) / 24 clocks per beat / 8 32nd-notes per quarter
  return [0xFF, 0x58, 0x04, 0x04, 0x02, 0x18, 0x08];
}

/** Track-name meta: FF 03 <len-varlen> <ascii-bytes>. */
function trackNameBytes(name: string): number[] {
  const bytes: number[] = [];
  pushString(bytes, name);
  const out: number[] = [0xFF, 0x03];
  writeVarLen(out, bytes.length);
  out.push(...bytes);
  return out;
}

function endOfTrack(): number[] {
  return [0xFF, 0x2F, 0x00];
}

interface TimedEvent { time: number; bytes: number[]; order: number }

function buildTempoTrack(bpm: number): number[] {
  const out: number[] = [];
  writeVarLen(out, 0); out.push(...trackNameBytes('Tempo'));
  writeVarLen(out, 0); out.push(...tempoMetaBytes(bpm));
  writeVarLen(out, 0); out.push(...timeSig44Bytes());
  writeVarLen(out, 0); out.push(...endOfTrack());
  return out;
}

function buildSequenceTrack(name: string, seq: SeqPattern): number[] {
  const stepCount = Math.min(SEQ_MAX_STEPS, seq.bars * seq.resolution);
  const stepDur = (PPQ * 4) / seq.resolution; // ticks per step

  const events: TimedEvent[] = [];
  // order is a tiebreaker so a note-off at the same tick as a note-on sorts
  // by event ordinal — guarantees deterministic output across runs.
  let ord = 0;

  events.push({ time: 0, order: ord++, bytes: trackNameBytes(name) });

  for (let step = 0; step < stepCount; step++) {
    const row = seq.grid[step];
    if (!row || row.length === 0) continue;
    const time = Math.round(step * stepDur);
    const length = Math.max(1, Math.round(stepDur * 0.5)); // 50% gate
    for (const padIdx of row) {
      const note = padToMidiNote(padIdx);
      // Note-on channel 0 (status 0x90), velocity 100. We could derive velocity
      // from chop strength later — fixed 100 is a clean default for now.
      events.push({ time, order: ord++, bytes: [0x90, note, 100] });
      events.push({ time: time + length, order: ord++, bytes: [0x80, note, 64] });
    }
  }

  // Stable sort by time, then by original ord so simultaneous events keep
  // a deterministic order (note-on then note-off if both at same tick,
  // which doesn't happen here but the invariant is cheap to keep).
  events.sort((a, b) => a.time - b.time || a.order - b.order);

  const out: number[] = [];
  let last = 0;
  for (const e of events) {
    writeVarLen(out, e.time - last);
    out.push(...e.bytes);
    last = e.time;
  }
  writeVarLen(out, 0); out.push(...endOfTrack());
  return out;
}

function seqLetter(i: number): string {
  // 0 = A, 25 = Z, then AA, AB, …
  let s = '';
  let n = i;
  do { s = String.fromCharCode(65 + (n % 26)) + s; n = Math.floor(n / 26) - 1; } while (n >= 0);
  return s;
}

export function buildMidi(engine: ChopperEngine): Uint8Array {
  const state: ChopperState = engine.getState();
  const bpm = state.metronome.bpm > 0 ? state.metronome.bpm : (state.bpm > 0 ? state.bpm : 120);
  const sequences = state.sequences.length > 0 ? state.sequences : [{ bars: 1, resolution: 16, grid: [], loop: true }];

  const trackBytes: number[][] = [];
  trackBytes.push(buildTempoTrack(bpm));
  for (let i = 0; i < sequences.length; i++) {
    trackBytes.push(buildSequenceTrack(`Sequence ${seqLetter(i)}`, sequences[i]));
  }

  const out: number[] = [];
  // MThd header
  pushString(out, 'MThd');
  pushUint32BE(out, 6);                     // header length
  pushUint16BE(out, 1);                     // format 1 (multi-track)
  pushUint16BE(out, trackBytes.length);     // ntrks
  pushUint16BE(out, PPQ);                   // division (PPQ)
  // Track chunks
  for (const t of trackBytes) {
    pushString(out, 'MTrk');
    pushUint32BE(out, t.length);
    for (const b of t) out.push(b);
  }
  return new Uint8Array(out);
}
