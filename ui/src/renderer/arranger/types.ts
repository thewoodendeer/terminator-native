// AI Beat Arranger — shared types. An "arrangement" is a song structure that
// lays out the producer's EXISTING chops + drum loop over time. No new audio is
// ever generated; sections only reference chop indices and a drum behaviour.
// The matching JSON shape is produced by the /api/arranger route on the KCC site.

export type DrumVariation =
  | 'loop'            // the loop as-is
  | 'loop_with_fill'  // loop + a fill on the last bar
  | 'loop_variation'  // a busier/altered take on the loop
  | 'breakdown'       // stripped down (kick + snare only)
  | 'hi_hats_only'    // hats only — tension before a drop
  | 'loop_fade'       // loop tailing out
  | 'none';           // no drums this section

export type Dynamics = 'build' | 'drop' | 'steady' | 'fill';

export interface ArrangementSection {
  name: string;        // intro, verse, hook, bridge, breakdown, outro...
  bars: number;        // length in bars
  chops: number[];     // pad indices to trigger this section
  drums: DrumVariation;
  dynamics?: Dynamics;
  // Optional explicit per-section drum tracks (DAW grid: per-section on/off).
  // When present it overrides `drums`: only these tracks of the base pattern play.
  enabledDrumTracks?: string[];
  // Optional fully-resolved chop step events: beat offset within the section +
  // the pad indices to fire. When present the preview schedules these (so a
  // section plays its chop SEQUENCE in full, looped to the section's bars)
  // instead of cycling `chops` once per bar.
  /** `rev` (optional, parallel to `pads`) = the sequencer's per-cell REVERSE. */
  chopEvents?: Array<{ beat: number; pads: number[]; rev?: boolean[] }>;
  // Optional fully-resolved per-track drum pattern for this section — each row
  // already taken from the drum SEQUENCE chosen for that track (Beat Finisher
  // Phase 1B). When present it overrides enabledDrumTracks/drums: exactly these
  // rows play this section.
  drumPattern?: Partial<Record<string, boolean[]>>;
  // Steps per bar the drumPattern rows are written at. The DrumEngine stores at
  // a fixed internal 1/32 and the builders stamp its value here; absent = 16,
  // the historical contract (older callers, the export test fixtures). A row is
  // NOT necessarily one section long — the drum loop keeps its own length and
  // tiles — so the resolution can't be inferred from row.length / bars. It has
  // to travel with the data.
  drumStepsPerBar?: number;
  // BASS (desktop): the bass pattern chosen for this section, resolved to
  // beat-stamped notes (beat offset within the section, MIDI note, length in
  // beats, velocity 0..1), looped/truncated to the section like chopEvents.
  // Absent/empty = no bass this section.
  bassNotes?: Array<{ beat: number; note: number; dur: number; vel: number; slide?: boolean }>;
  /** The bass pattern's BEND lane laid over the section (beat offsets, semitones). */
  bassBends?: Array<{ beat: number; semis: number }>;
}

export interface Arrangement {
  name: string;
  sections: ArrangementSection[];
  // The bass synth patch every section's bassNotes render through (the export
  // spins the same worklet up offline). Travels WITH the arrangement so the
  // main-page EXPORT and the Beat Finisher modal bake identical bass.
  bassPatch?: import('../bass/BassEngine').BassPatch;
}
