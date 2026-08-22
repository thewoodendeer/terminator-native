/**
 * Export-format metadata — kept in its own lightweight module (no heavy
 * builder imports) so the UI can show the format dropdown without pulling the
 * zip/MPC/MIDI encoders into the initial bundle. The actual `runExport`
 * (which imports those encoders) lives in ./index.ts and is loaded on demand.
 */

export type ExportFormat =
  | 'original-wav'
  | 'wav-stems'
  | 'seq-wav'
  | 'seqs-zip'
  | 'master-wav'
  | 'mpc-pattern'
  | 'mpc-sample'
  | 'drum-rack'
  | 'midi';

export interface ExportFormatMeta {
  value: ExportFormat;
  label: string;
  description: string;
  available: boolean;
}

// Standardized to four options. The hidden rows below keep their handlers in
// index.ts — re-add the row here to restore one. Labels map to the SAME existing
// export functions (only the dropdown text + which rows are visible changed).
export const EXPORT_FORMATS: ExportFormatMeta[] = [
  { value: 'master-wav',  label: 'Master Mixdown',              description: 'The full Beat Finisher arrangement as one stereo WAV — mixer FX, send effects and the master strip all baked in.', available: true },
  { value: 'wav-stems',   label: 'Trackouts (Chops + Drums)',   description: 'The full arrangement as one WAV per track — SAMPLE 1 and every extra SAMPLE strip, kick, snare, hihat, openhat, perc and every drum lane you added, the bass, plus any active send return — mixer FX baked, zipped.', available: true },
  { value: 'mpc-sample',  label: 'MPC Project (.mpcsample + WAVs)', description: 'A zip with drum + chop one-shot WAVs (mixer FX baked) + the .mpcsample arrangement. Unzip onto your MPC — pads + sequences load ready to play.', available: true  },
  { value: 'drum-rack',   label: 'Ableton Drum Rack (.adg)',  description: 'Self-contained drum rack + samples in one folder — drums first (kick/snare/hat/openhat/perc), then chops. Unzip anywhere, drag the .adg into a track.', available: true  },
  // Hidden (handlers still exist in index.ts — re-add the row to restore):
  // { value: 'original-wav',label: 'Original Song (.wav)',         description: 'The loaded track as-is — no chops, no FX, no sequencing. Raw buffer.', available: true },
  // { value: 'seq-wav',     label: 'Current Sequence WAV (.wav)',   description: 'Just the currently-selected sequence rendered through master FX.', available: true },
  // { value: 'seqs-zip',    label: 'All Sequences — separate WAVs', description: 'Each sequence rendered as its own WAV file, bundled in a zip.', available: true },
  // { value: 'mpc-pattern', label: 'MPC Pattern (.mpcpattern)', description: 'Current sequence as a newer-MPC pattern file.',          available: true  },
  // { value: 'midi',        label: 'MIDI Sequence (.mid)',      description: 'Standard MIDI File — every sequence as a track at 960 PPQ. Imports into any DAW.', available: true },
];
