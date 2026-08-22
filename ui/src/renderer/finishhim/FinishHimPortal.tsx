import { useState, useRef, useEffect, useCallback, CSSProperties, MouseEvent as ReactMouseEvent } from 'react';
import { useIsPhone } from '../lib/useIsPhone';

/**
 * FINISH HIM — Beat Finisher Portal (integrated into Terminator)
 * ------------------------------------------------------------
 * Sequence:  idle → flash ("FINISH HIM!") → portal → arranger
 * Themes:    xbox | ps2 | mac  — driven by the host app's current theme
 *            (mapped in ChopperView; this component just takes a `theme` prop).
 *
 * Canvas portal is ref-based rAF only (no setState on animation frames).
 * Real session data comes in via props (chops, bpm, suggestions); falls back to
 * static structures when the AI is unavailable. `onComplete(sections)` is the
 * export hook (stubbed by the caller for now).
 * Adapted from the provided FinishHimPortal.jsx.
 * ------------------------------------------------------------
 */

export type PortalTheme = 'xbox' | 'ps2' | 'mac' | 'palette';

export interface FinishSection {
  id: string;
  label: string;
  bars: number;
  chops: number[]; // indices into the chops list
}

export interface FinishSuggestion {
  name: string;
  desc: string;
  tag: string;
  sections: FinishSection[];
}

// DAW grid output: a section references a chop SEQUENCE (index into the available
// chop sequences) and a per-track drum on/off map for that section.
export interface FinishArrangementSection {
  id: string;
  label: string;
  bars: number;
  chopSeqIdx: number;                 // index into available chop sequences (-1 = none)
  drumsOn: Record<string, boolean>;   // drum trackKey -> enabled this section
  drumSeq: Record<string, number>;    // drum trackKey -> which drum sequence index it plays (Phase 1B)
  // BASS pattern index this section plays; -1 = no bass. Optional so
  // arrangements saved before the bass existed load unchanged (the host
  // resolves absent → pattern 0, intro sections off — see bassSeqForSection).
  bassSeq?: number;
}

// Phase 1C: 808 removed from the Beat Finisher drum rows entirely.
const DEFAULT_DRUM_TRACKS = [
  { key: 'kick', label: 'KICK' }, { key: 'snare', label: 'SNARE' },
  { key: 'hihat', label: 'HI-HAT' }, { key: 'openhat', label: 'OPEN-HAT' },
  { key: 'perc', label: 'PERCS' },
];

interface Props {
  theme: PortalTheme;
  chops?: string[];
  bpm?: number;
  suggestions?: FinishSuggestion[];
  loading?: boolean;
  onRegenerate?: () => void;
  previewing?: boolean;
  chopSeqs?: string[];                               // available chop sequence labels
  drumTracks?: { key: string; label: string }[];     // drum track rows
  drumPattern?: Record<string, boolean[]>;           // current/active drum pattern (fallback cell visual)
  drumSequences?: Array<Record<string, boolean[]>>;  // all drum sequences (Phase 1B: cycle per track)
  /** The sequences currently selected in the drum / chop sequencers — what a
   *  fresh section defaults to, so the finisher plays what you were hearing. */
  currentDrumSeq?: number;
  currentChopSeq?: number;
  drumStepsPerBar?: number;                          // storage resolution of those rows (engine.stepsPerBar); absent = 16
  /** BASS patterns (desktop). Present → a BASS row renders; each entry's `dots`
   *  is the 4-beat preview of that pattern's first bar. */
  bassSeqs?: Array<{ dots: string }>;
  getProgress?: () => { beat: number; total: number }; // live preview position (beats)
  onPreview?: (sections: FinishArrangementSection[]) => void;
  onStopPreview?: () => void;
  onLiveEdit?: (sections: FinishArrangementSection[]) => void; // Phase 3A.5: live re-schedule while previewing (no restart)
  seekBeat?: number;                          // Phase 3A.6: current seek position (beats)
  onSeek?: (beat: number) => void;            // Phase 3A.6: click-to-seek / section jump
  // Phase 4A: render + download the arrangement. Returns a status message; calls
  // onProgress(0..1, label) so the modal can show a progress bar.
  onExport?: (
    target: 'master' | 'stems' | 'mpc' | 'drum-rack', format: 'wav' | 'mp3',
    sections: FinishArrangementSection[], onProgress: (pct: number, label: string) => void,
  ) => Promise<string>;
  onComplete?: (arrangement: FinishArrangementSection[]) => void;
  onClose?: () => void;
  initialSections?: FinishArrangementSection[];                 // Phase 1D: restore on re-open
  onPersist?: (sections: FinishArrangementSection[]) => void;   // Phase 1D: save snapshot on change
  // (Mixer props removed — CHOPS/DRUMS/CLIPPER/MASTER now live on the DAW mixer.)
}

const THEMES: Record<PortalTheme, any> = {
  xbox: {
    name: 'XBOX', bg: '#04140a', ink: '#b9ffcf', accent: '#53ff89', accent2: '#0aff6a',
    glow: 'rgba(40,255,120,0.55)', panel: 'rgba(10,40,22,0.55)', panelBorder: 'rgba(83,255,137,0.35)',
    font: "'Rajdhani','Segoe UI',sans-serif", enterLabel: 'BEAT FINISHER',
  },
  ps2: {
    name: 'PLAYSTATION 2', bg: '#04030a', ink: '#cdd6ff', accent: '#7aa0ff', accent2: '#b58bff',
    glow: 'rgba(120,150,255,0.5)', panel: 'rgba(14,16,40,0.5)', panelBorder: 'rgba(140,150,255,0.28)',
    font: "'Eurostile','Helvetica Neue',sans-serif", enterLabel: 'BEAT FINISHER',
  },
  mac: {
    name: 'MACINTOSH', bg: '#0a64ff', ink: '#0a2a55', accent: '#1f8bff', accent2: '#ff8a3c',
    glow: 'rgba(120,190,255,0.6)', panel: 'rgba(248,250,253,0.60)', panelBorder: 'rgba(255,255,255,0.65)',
    font: "'Charter','Georgia',serif", enterLabel: 'BEAT FINISHER',
  },
  // Mobile-palette theme (HardwareView passes theme="palette" when paletteOn).
  // Colours are CSS-var STRINGS — the 8 --hw-* vars are mirrored onto <body> by
  // HardwareView, so they resolve inside these inline styles/gradients in both
  // orientations. The xbox hex fallbacks keep it identical IF ever rendered with
  // the vars absent (it isn't — desktop never selects 'palette'). accent2 reuses
  // accent (the palette has one accent → gradients collapse to a flat tone) and
  // glow is transparent for the flat, glow-free palette aesthetic.
  palette: {
    name: 'PALETTE',
    bg: 'var(--hw-bg, #04140a)', ink: 'var(--hw-text, #b9ffcf)',
    accent: 'var(--hw-accent, #53ff89)', accent2: 'var(--hw-accent, #0aff6a)',
    glow: 'transparent', panel: 'var(--hw-panel, rgba(10,40,22,0.55))',
    panelBorder: 'var(--hw-border, rgba(83,255,137,0.35))',
    font: "'Rajdhani','Segoe UI',sans-serif", enterLabel: 'BEAT FINISHER',
  },
};

const MOCK_CHOPS = ['Chop 1', 'Chop 2', 'Chop 3', 'Chop 4'];

// Phase 1C: the fixed default arrangement a new Beat Finisher session opens on
// (used when there are no AI suggestions). Intro + 3 Verses + 2 Hooks, all 4 bars.
// Phase 3A-mod: full-song default — Intro + 3 verses + 2 hooks ×2 + Outro = 54 bars.
const DEFAULT_SECTIONS: FinishSection[] = [
  { id: 'intro',   label: 'Intro',     bars: 2, chops: [] },
  { id: 'verse1',  label: 'Verse 1',   bars: 4, chops: [] },
  { id: 'verse1b', label: 'Verse 1.2', bars: 4, chops: [] },
  { id: 'verse1c', label: 'Verse 1.3', bars: 4, chops: [] },
  { id: 'hook1',   label: 'Hook 1',    bars: 4, chops: [] },
  { id: 'hook1b',  label: 'Hook 1.2',  bars: 4, chops: [] },
  { id: 'verse2',  label: 'Verse 2',   bars: 4, chops: [] },
  { id: 'verse2b', label: 'Verse 2.2', bars: 4, chops: [] },
  { id: 'verse2c', label: 'Verse 2.3', bars: 4, chops: [] },
  { id: 'hook2',   label: 'Hook 2',    bars: 4, chops: [] },
  { id: 'hook2b',  label: 'Hook 2.2',  bars: 4, chops: [] },
  { id: 'outro',   label: 'Outro',     bars: 2, chops: [] },
];

/** The arrangement a fresh Beat Finisher session opens on, as plain sections —
 *  exported so the main EXPORT panel renders the SAME default arrangement when
 *  the modal was never opened (unified-export contract: main page == modal).
 *  Mirrors `toEdits(DEFAULT_SECTIONS)` inside the component: the current chop
 *  seq, every drum track on the current drum seq, intro sections with drums muted.
 *  Fresh sections play the sequences you are LOOKING AT — the drum sequence
 *  and chop sequence currently selected in the sequencers — so the Beat
 *  Finisher sounds like what you just heard (it used to seed Seq 1 everywhere:
 *  a beat built in Seq 2 came out as Seq 1). */
export function defaultFinishSections(tracks: Array<{ key: string }>, cur: { drumSeq?: number; chopSeq?: number } = {}): FinishArrangementSection[] {
  const d = cur.drumSeq ?? 0, c = cur.chopSeq ?? 0;
  return DEFAULT_SECTIONS.map((s) => ({
    id: s.id, label: s.label, bars: s.bars, chopSeqIdx: c,
    drumsOn: Object.fromEntries(tracks.map((tk) => [tk.key, !/intro/i.test(s.label)])),
    drumSeq: Object.fromEntries(tracks.map((tk) => [tk.key, d])),
    bassSeq: /intro/i.test(s.label) ? -1 : 0,
  }));
}

// Static fallback structures (used when the AI is unavailable). Each carries its
// own sections so the timeline renders identically to an AI result.
const DEFAULT_SUGGESTIONS: FinishSuggestion[] = [
  {
    name: 'Basic', desc: '4 · 8 · 8 · 8 · 4', tag: 'Classic boom-bap arc',
    sections: [
      { id: 'intro', label: 'Intro', bars: 4, chops: [0, 1] },
      { id: 'verse1', label: 'Verse 1', bars: 8, chops: [0, 1, 2] },
      { id: 'verse2', label: 'Verse 2', bars: 8, chops: [1, 2, 3] },
      { id: 'hook', label: 'Hook', bars: 8, chops: [3] },
      { id: 'outro', label: 'Outro', bars: 4, chops: [0] },
    ],
  },
  {
    name: 'With Bridge', desc: '4 · 8 · 4 · 8 · 4', tag: 'Adds breathing room',
    sections: [
      { id: 'intro', label: 'Intro', bars: 4, chops: [0] },
      { id: 'verse', label: 'Verse', bars: 8, chops: [0, 1, 2] },
      { id: 'bridge', label: 'Bridge', bars: 4, chops: [2, 3] },
      { id: 'hook', label: 'Hook', bars: 8, chops: [3] },
      { id: 'outro', label: 'Outro', bars: 4, chops: [0] },
    ],
  },
  {
    name: 'Trap Structure', desc: '8 · 16 · 8 · 8', tag: 'Longer hook focus',
    sections: [
      { id: 'intro', label: 'Intro', bars: 8, chops: [0, 1] },
      { id: 'verse', label: 'Verse', bars: 16, chops: [0, 1, 2] },
      { id: 'hook', label: 'Hook', bars: 8, chops: [2, 3] },
      { id: 'verse2', label: 'Verse 2', bars: 8, chops: [1, 3] },
    ],
  },
];

function prefersReducedMotion(): boolean {
  try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return false; }
}


export default function FinishHimPortal({ theme, chops, bpm, suggestions, loading, onRegenerate, previewing, chopSeqs, drumTracks, drumPattern, drumSequences, currentDrumSeq, currentChopSeq, drumStepsPerBar, bassSeqs, getProgress, onPreview, onStopPreview, onLiveEdit, seekBeat, onSeek, onExport, onComplete, onClose, initialSections, onPersist }: Props) {
  void suggestions; void loading; void onRegenerate; // AI picker replaced by local REARRANGE
  const isPhone = useIsPhone(); // Phase 3A.9
  const hasSaved = !!(initialSections && initialSections.length);
  // Phase 1D: returning to a saved arrangement skips the intro animation and lands
  // straight on the arranger.
  // Phase 3A.8: open straight onto the arranger grid. The themed intro VIDEO
  // (ChopperView, Phase 3A.7) now replaces the portal's own idle→flash→portal
  // intro, so there's no intermediate "BEAT FINISHER" button to click — the flow
  // is video → modal. (`hasSaved` no longer gates this; the intro phases below
  // are simply never entered.)
  const [phase, setPhase] = useState<'idle' | 'flash' | 'portal' | 'arranger'>('arranger');
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const rafRef = useRef(0);
  const t = THEMES[theme];

  void chops; void MOCK_CHOPS; void DEFAULT_SUGGESTIONS; // legacy props/fallbacks superseded
  // Phase 3A: AI suggestions no longer auto-apply — a new session always opens on
  // the fixed DEFAULT_SECTIONS (Phase 1C); the user pulls AI structures via the
  // Regenerate picker and accepts one explicitly.
  const seedSections = DEFAULT_SECTIONS;
  const totalBars = seedSections.reduce((a, s) => a + s.bars, 0);
  const reduced = prefersReducedMotion();

  // DAW arrangement — editable working copy. The AI provides section names + bars;
  // chop-sequence + per-track drums default and the user edits them in the grid.
  // Resets when the pick changes or new AI suggestions arrive.
  // Hide any track with no hits in ANY drum sequence — only the drums the user
  // actually programmed show up in the arranger. (808 was removed engine-wide.)
  const usedKey = (key: string): boolean =>
    drumSequences && drumSequences.length
      ? drumSequences.some((seq) => seq?.[key]?.some(Boolean))
      : !!drumPattern?.[key]?.some(Boolean);
  const baseTracks = drumTracks && drumTracks.length ? drumTracks : DEFAULT_DRUM_TRACKS;
  const usedTracks = baseTracks.filter((tk) => usedKey(tk.key));
  const tracks = usedTracks.length ? usedTracks : baseTracks; // never render an empty grid
  const seqs = chopSeqs && chopSeqs.length ? chopSeqs : ['Seq 1'];
  const drumSeqCount = Math.max(1, drumSequences?.length ?? 1); // how many drum sequences exist (Phase 1B)
  const bassSeqCount = bassSeqs?.length ?? 0;                     // 0 = no bass row (mobile / no engine)
  const defaultBassSeq = (label: string) => (bassSeqCount ? (/intro/i.test(label) ? -1 : 0) : undefined);
  const allDrumsOn = (): Record<string, boolean> => Object.fromEntries(tracks.map((tk) => [tk.key, true]));
  const noDrums = (): Record<string, boolean> => Object.fromEntries(tracks.map((tk) => [tk.key, false]));
  // A fresh row plays the sequences currently selected in the sequencers
  // (clamped: the selection can outrun the lists while they're being edited).
  const drumSeqCount0 = Math.max(1, drumSequences?.length ?? 1);
  const curDrum = Math.max(0, Math.min(drumSeqCount0 - 1, currentDrumSeq ?? 0));
  const curChop = Math.max(0, Math.min(Math.max(0, (chopSeqs?.length ?? 1) - 1), currentChopSeq ?? 0));
  const freshDrumSeq = (): Record<string, number> => Object.fromEntries(tracks.map((tk) => [tk.key, curDrum]));
  const uidRef = useRef(0);
  type Edit = FinishArrangementSection & { _uid: number };
  // Convert AI/default sections → editable working rows (chopSeq 0, Intro drums
  // muted, every drum track on the CURRENT drum seq). Shared by the initial seed and accepting
  // an AI suggestion.
  const toEdits = (secs: FinishSection[]): Edit[] => secs.map((s) => ({
    id: s.id, label: s.label, bars: s.bars, chopSeqIdx: curChop,
    drumsOn: /intro/i.test(s.label) ? noDrums() : allDrumsOn(),
    drumSeq: freshDrumSeq(),
    bassSeq: defaultBassSeq(s.label),
    _uid: uidRef.current++,
  }));
  // Phase 1D: restore a saved arrangement on mount (else start empty, seeded below).
  const [edited, setEdited] = useState<Edit[]>(() =>
    hasSaved
      ? initialSections!.map((s) => ({
          id: s.id, label: s.label, bars: s.bars, chopSeqIdx: s.chopSeqIdx,
          drumsOn: { ...s.drumsOn }, drumSeq: { ...s.drumSeq },
          bassSeq: typeof s.bassSeq === 'number' ? s.bassSeq : defaultBassSeq(s.label),
          _uid: uidRef.current++,
        }))
      : [],
  );
  const restoredRef = useRef(hasSaved);
  useEffect(() => {
    // Seed the default arrangement once on mount (unless we restored a saved one).
    // AI suggestions are applied explicitly via the picker, not here.
    if (restoredRef.current) { restoredRef.current = false; return; }
    setEdited(toEdits(seedSections));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const editTotalBars = edited.reduce((a, s) => a + s.bars, 0) || totalBars;
  // `live` edits (drum mute / sequence switch — they don't change section bar
  // lengths) re-schedule the running preview's drum timeline with no restart
  // (Phase 3A.5). Structural edits leave `live` false; they take effect on the
  // next manual preview so the chop timeline stays aligned.
  const mutate = (fn: (secs: Edit[]) => Edit[], live = false) => {
    const next = fn(cloneSections(edited));
    if (sectionsKey(edited) === sectionsKey(next)) return; // no-op (e.g. move at a boundary) — don't pollute history
    pushHistory(snapNow());                                 // Phase 3B: snapshot the pre-edit state
    setEdited(next);
    if (live && previewing) onLiveEdit?.(toPlain(next));
  };
  const setChopSeq = (si: number, idx: number) => mutate((secs) => { secs[si].chopSeqIdx = idx; return secs; });
  const toggleDrum = (si: number, key: string) => mutate((secs) => { secs[si].drumsOn[key] = !secs[si].drumsOn[key]; return secs; }, true);
  // Phase 1B: cycle which drum sequence a track plays in this section (wraps).
  // BASS row: on/off + which bass pattern this section plays (wraps).
  const toggleBass = (si: number) => mutate((secs) => {
    const cur = secs[si].bassSeq ?? -1;
    secs[si].bassSeq = cur >= 0 ? -1 : 0;
    return secs;
  }, true);
  const cycleBassSeq = (si: number, dir: -1 | 1) => mutate((secs) => {
    if (!bassSeqCount) return secs;
    const cur = Math.max(0, secs[si].bassSeq ?? 0);
    secs[si].bassSeq = ((cur + dir) % bassSeqCount + bassSeqCount) % bassSeqCount;
    return secs;
  }, true);
  const cycleDrumSeq = (si: number, key: string, dir: -1 | 1) => mutate((secs) => {
    const cur = secs[si].drumSeq[key] ?? 0;
    secs[si].drumSeq[key] = ((cur + dir) % drumSeqCount + drumSeqCount) % drumSeqCount;
    return secs;
  }, true);
  const moveSection = (si: number, dir: -1 | 1) => mutate((secs) => { const j = si + dir; if (j < 0 || j >= secs.length) return secs; const tmp = secs[si]; secs[si] = secs[j]; secs[j] = tmp; return secs; });
  const removeSection = (si: number) => mutate((secs) => (secs.length > 1 ? secs.filter((_, i) => i !== si) : secs));
  const duplicateSection = (si: number) => mutate((secs) => {
    const c: Edit = { ...secs[si], drumsOn: { ...secs[si].drumsOn }, drumSeq: { ...secs[si].drumSeq }, _uid: uidRef.current++ };
    return [...secs.slice(0, si + 1), c, ...secs.slice(si + 1)];
  });
  // P2.8: "+ Add" copies the first Verse (fallback: first section) and appends it;
  // the Arranger then opens the edit modal on the new section.
  const addVerseCopy = () => mutate((secs) => {
    const v = secs.find((s) => /verse/i.test(s.label)) ?? secs[0];
    const copy: Edit = v
      ? { ...v, drumsOn: { ...v.drumsOn }, drumSeq: { ...v.drumSeq }, label: 'Verse', _uid: uidRef.current++ }
      : { id: 'section-' + uidRef.current, label: 'Verse', bars: 8, chopSeqIdx: curChop, drumsOn: allDrumsOn(), drumSeq: freshDrumSeq(), bassSeq: defaultBassSeq('Verse'), _uid: uidRef.current++ };
    return [...secs, copy];
  });
  // P2.7: edit a section's name + bar length (1–16; sequences loop/truncate to fit).
  const editSectionMeta = (si: number, label: string, bars: number) => mutate((secs) => {
    if (!secs[si]) return secs;
    secs[si] = { ...secs[si], label: label || secs[si].label, bars: Math.max(1, Math.min(16, Math.floor(bars) || secs[si].bars)) };
    return secs;
  });
  const toPlain = (es: Edit[]): FinishArrangementSection[] =>
    es.map((s) => ({ id: s.id, label: s.label, bars: s.bars, chopSeqIdx: s.chopSeqIdx, drumsOn: { ...s.drumsOn }, drumSeq: { ...s.drumSeq }, ...(typeof s.bassSeq === 'number' ? { bassSeq: s.bassSeq } : {}) }));
  const plainSections = (): FinishArrangementSection[] => toPlain(edited);

  // ── Phase 3B: undo / redo history ──────────────────────────────────────────
  // Snapshots the arrangement so every edit is reversible (mixer values no longer
  // live here — they're on the DAW mixer). Arrangement edits push through
  // mutate/rearrange. 50-state cap.
  const HISTORY_LIMIT = 50;
  type Snapshot = { sections: Edit[] };
  const cloneSections = (es: Edit[]): Edit[] =>
    es.map((s) => ({ ...s, drumsOn: { ...s.drumsOn }, drumSeq: { ...s.drumSeq } }));
  const sectionsKey = (es: Edit[]): string =>
    JSON.stringify(es.map((s) => ({ id: s.id, label: s.label, bars: s.bars, chopSeqIdx: s.chopSeqIdx, drumsOn: s.drumsOn, drumSeq: s.drumSeq, bassSeq: s.bassSeq ?? null })));
  const [past, setPast] = useState<Snapshot[]>([]);
  const [future, setFuture] = useState<Snapshot[]>([]);
  const snapNow = (): Snapshot => ({ sections: cloneSections(edited) });
  const pushHistory = (snap: Snapshot) => {
    setPast((p) => [...p, snap].slice(-HISTORY_LIMIT));
    setFuture([]); // a fresh edit invalidates the redo branch
  };
  const applySnapshot = (s: Snapshot) => {
    setEdited(cloneSections(s.sections));
    if (previewing) onPreview?.(toPlain(s.sections)); // re-schedule the running preview on the restored arrangement
  };
  const undo = () => {
    if (!past.length) return;
    const prev = past[past.length - 1];
    const cur = snapNow();
    setPast((p) => p.slice(0, -1));
    setFuture((f) => [cur, ...f].slice(0, HISTORY_LIMIT));
    applySnapshot(prev);
  };
  const redo = () => {
    if (!future.length) return;
    const nxt = future[0];
    const cur = snapNow();
    setFuture((f) => f.slice(1));
    setPast((p) => [...p, cur].slice(-HISTORY_LIMIT));
    applySnapshot(nxt);
  };
  const undoRef = useRef(undo); undoRef.current = undo;
  const redoRef = useRef(redo); redoRef.current = redo;
  // Cmd/Ctrl+Z = undo · Cmd/Ctrl+Shift+Z or Ctrl+Y = redo. Capture phase +
  // stopPropagation so the host chopper's own undo never fires while the modal is
  // open; a keystroke inside a text field falls through to native text undo.
  useEffect(() => {
    if (phase !== 'arranger') return;
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return;
      const k = e.key.toLowerCase();
      if (k !== 'z' && k !== 'y') return;
      const el = e.target as HTMLElement | null;
      if (el && /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) { e.stopPropagation(); return; }
      e.preventDefault(); e.stopPropagation();
      if (k === 'y' || e.shiftKey) redoRef.current(); else undoRef.current();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [phase]);

  // ── Phase 3A.2: REARRANGE (instant, no popup) ──────────────────────────────
  // Shuffle a random chop-sequence + per-track drum-sequence into every section
  // from what the user has already made, applied straight to the grid. If a
  // preview is running, restart it on the shuffled arrangement so it's heard
  // immediately. Undo/redo for this lands in Phase 3B.
  const rearrange = () => {
    const shuffled: Edit[] = edited.map((s) => ({
      ...s,
      chopSeqIdx: seqs.length > 1 ? Math.floor(Math.random() * seqs.length) : s.chopSeqIdx,
      drumSeq: Object.fromEntries(tracks.map((tk) => [
        tk.key, drumSeqCount > 1 ? Math.floor(Math.random() * drumSeqCount) : (s.drumSeq?.[tk.key] ?? 0),
      ])),
      bassSeq: bassSeqCount > 1 && (s.bassSeq ?? -1) >= 0 ? Math.floor(Math.random() * bassSeqCount) : s.bassSeq,
    }));
    if (sectionsKey(edited) === sectionsKey(shuffled)) return; // nothing to shuffle (single seq + single drum seq)
    pushHistory(snapNow()); // Phase 3B: REARRANGE is undoable
    setEdited(shuffled);
    if (previewing) onPreview?.(toPlain(shuffled)); // restart preview on the new shuffle
  };

  // Phase 1D: keep the parent's snapshot current so close + re-open restores the
  // exact arrangement (sections, bars, names, per-track patterns). Cheap — writes
  // a ref in the parent, no re-render.
  useEffect(() => {
    if (edited.length) onPersist?.(plainSections());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [edited]);

  // Phase 3A.2: SPACE plays/stops the arrangement preview anywhere in the modal
  // (no focus needed). Only while the arranger is showing; ignores typing fields.
  useEffect(() => {
    if (phase !== 'arranger') return;
    const onKey = (e: KeyboardEvent) => {
      if (e.code !== 'Space' && e.key !== ' ') return;
      const el = e.target as HTMLElement | null;
      if (el && /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) return;
      e.preventDefault();
      if (previewing) onStopPreview?.(); else onPreview?.(plainSections());
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, previewing, onPreview, onStopPreview, edited]);

  // ---- sequence control ----
  const launch = useCallback(() => {
    if (reduced) {
      // Skip the heavy portal fx for reduced-motion: brief flash → arranger.
      setPhase('flash');
      setTimeout(() => setPhase('arranger'), 400);
      return;
    }
    setPhase('flash');
    setTimeout(() => setPhase('portal'), 1100);
    setTimeout(() => setPhase('arranger'), 3300);
  }, [reduced]);

  const reset = () => {
    cancelAnimationFrame(rafRef.current);
    setPhase('idle');
  };

  // ---- portal canvas animation (theme-specific, ref-based) ----
  useEffect(() => {
    if (phase !== 'portal') return;
    const cv = canvasRef.current;
    if (!cv) return;
    const ctx = cv.getContext('2d');
    if (!ctx) return;
    const DPR = Math.min(window.devicePixelRatio || 1, 2);
    const resize = () => { cv.width = cv.clientWidth * DPR; cv.height = cv.clientHeight * DPR; };
    resize();
    const W = () => cv.width, H = () => cv.height;
    const t0 = performance.now();

    const parts: any[] = [];
    const seed = () => {
      parts.length = 0;
      const n = theme === 'mac' ? 0 : theme === 'ps2' ? 90 : 140;
      for (let i = 0; i < n; i++) {
        if (theme === 'ps2') {
          const z = Math.random(); // depth → parallax: near towers rise faster, bigger, brighter
          parts.push({
            x: W() * (0.15 + Math.random() * 0.7), y: H() * (0.6 + Math.random() * 0.6),
            vy: -(0.18 + z * 0.95) * DPR, r: (0.8 + z * 2.4) * DPR,
            hue: 220 + Math.random() * 70, a: 0.14 + z * 0.5,
          });
        } else {
          const ang = Math.random() * Math.PI * 2;
          parts.push({
            ang, rad: Math.random() * 6 * DPR, spd: (1.5 + Math.random() * 5) * DPR,
            r: (0.6 + Math.random() * 2.2) * DPR, a: 0.5 + Math.random() * 0.5,
          });
        }
      }
    };
    seed();

    const draw = (now: number) => {
      const e = (now - t0) / 1000;
      ctx.clearRect(0, 0, W(), H());
      const cx = W() / 2, cy = H() / 2;

      if (theme === 'xbox') {
        // Tightened: faster eased bloom (1.0s) → sharper flash (0.5s) → crisp X-beams.
        const gp = Math.min(e / 1.0, 1);
        const grow = 1 - Math.pow(1 - gp, 3); // easeOutCubic
        const flash = e > 1.0 ? Math.max(0, 1 - (e - 1.0) / 0.5) : 0;
        const coreR = (30 + grow * 260) * DPR;
        const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, coreR);
        g.addColorStop(0, `rgba(180,255,200,${0.9 * grow})`);
        g.addColorStop(0.4, `rgba(40,255,110,${0.5 * grow})`);
        g.addColorStop(1, 'rgba(4,20,10,0)');
        ctx.fillStyle = g;
        ctx.beginPath(); ctx.arc(cx, cy, coreR, 0, 7); ctx.fill();
        parts.forEach((p) => {
          p.rad += p.spd * (0.6 + grow);
          const x = cx + Math.cos(p.ang) * p.rad;
          const y = cy + Math.sin(p.ang) * p.rad;
          ctx.fillStyle = `rgba(120,255,160,${p.a * (1 - grow * 0.3)})`;
          ctx.beginPath(); ctx.arc(x, y, p.r, 0, 7); ctx.fill();
        });
        if (flash > 0) {
          ctx.fillStyle = `rgba(220,255,230,${flash})`;
          ctx.fillRect(0, 0, W(), H());
          ctx.save();
          ctx.translate(cx, cy);
          ctx.strokeStyle = `rgba(40,255,110,${flash})`;
          ctx.lineWidth = (6 + 20 * flash) * DPR; ctx.lineCap = 'round';
          [-0.78, 0.78, Math.PI - 0.78, Math.PI + 0.78].forEach((a) => {
            ctx.beginPath(); ctx.moveTo(0, 0);
            ctx.lineTo(Math.cos(a) * W(), Math.sin(a) * H()); ctx.stroke();
          });
          ctx.restore();
        }
      } else if (theme === 'ps2') {
        parts.forEach((p) => {
          p.y += p.vy;
          if (p.y < -20) { p.y = H() + 20; p.x = W() * (0.2 + Math.random() * 0.6); }
          const grd = ctx.createLinearGradient(p.x, p.y, p.x, p.y + 60 * DPR);
          grd.addColorStop(0, `hsla(${p.hue},90%,70%,${p.a})`);
          grd.addColorStop(1, `hsla(${p.hue},90%,60%,0)`);
          ctx.fillStyle = grd;
          ctx.fillRect(p.x - p.r, p.y, p.r * 2, 60 * DPR);
          ctx.fillStyle = `hsla(${p.hue},95%,80%,${p.a})`;
          ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, 7); ctx.fill();
        });
        const colR = 80 * DPR + Math.sin(e * 1.2) * 10 * DPR;
        const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, colR * 2);
        g.addColorStop(0, `rgba(150,160,255,${0.18 + Math.sin(e * 1.2) * 0.05})`);
        g.addColorStop(1, 'rgba(4,3,10,0)');
        ctx.fillStyle = g;
        ctx.beginPath(); ctx.arc(cx, cy, colR * 2, 0, 7); ctx.fill();
      } else {
        ctx.fillStyle = '#0a64ff';
        ctx.fillRect(0, 0, W(), H());
        const r = Math.min(e / 1.6, 1) * Math.max(W(), H()) * 0.6;
        const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, r + 1);
        g.addColorStop(0, 'rgba(255,255,255,0.95)');
        g.addColorStop(0.7, 'rgba(180,220,255,0.4)');
        g.addColorStop(1, 'rgba(10,100,255,0)');
        ctx.fillStyle = g;
        ctx.beginPath(); ctx.arc(cx, cy, r, 0, 7); ctx.fill();
      }
      rafRef.current = requestAnimationFrame(draw);
    };
    rafRef.current = requestAnimationFrame(draw);
    window.addEventListener('resize', resize);
    return () => { cancelAnimationFrame(rafRef.current); window.removeEventListener('resize', resize); };
  }, [phase, theme]);

  return (
    <div style={{ ...styles.root, fontFamily: t.font, minHeight: isPhone ? 0 : 560 }}>
      <StyleTag />
      {onClose && (
        <button onClick={onClose} aria-label="Close" style={styles.closeBtn}>×</button>
      )}

      {/* Phase 3A.9: on a phone the stage fills the screen height (dynamic vh so the
          browser URL bar is accounted for) instead of a fixed 560 px box. */}
      <div style={{ ...styles.stage, background: t.bg, height: isPhone ? '88dvh' : 560 }}>
        {phase === 'idle' && (
          <div style={styles.center}>
            <div style={{ ...styles.kicker, color: t.accent }}>chops locked · drums locked</div>
            <button
              onClick={launch}
              style={{
                ...styles.finishBtn, color: t.bg,
                background: `linear-gradient(180deg, ${t.accent}, ${t.accent2})`,
                boxShadow: `0 0 0 2px ${t.accent}, 0 0 40px ${t.glow}, inset 0 2px 0 rgba(255,255,255,0.5)`,
              }}
              className="fh-pulse"
            >
              BEAT&nbsp;FINISHER
            </button>
            <div style={{ ...styles.sub, color: t.ink }}>AI arranges your sounds into a full beat</div>
          </div>
        )}

        {phase === 'flash' && (
          <div style={styles.center}>
            <div className="fh-flash" style={{ ...styles.flashText, color: t.accent, textShadow: `0 0 30px ${t.glow}, 0 0 80px ${t.glow}` }}>
              BEAT FINISHER
            </div>
          </div>
        )}

        {phase === 'portal' && (
          <>
            <canvas ref={canvasRef} style={styles.canvas} />
            <div style={styles.center}>
              <div className="fh-enter" style={{ ...styles.enterLabel, color: theme === 'mac' ? '#0a2a55' : t.ink, textShadow: theme === 'mac' ? 'none' : `0 0 24px ${t.glow}` }}>
                {t.enterLabel}
              </div>
            </div>
          </>
        )}

        {phase === 'arranger' && (
          <Arranger
            theme={theme} t={t} isPhone={isPhone}
            sections={edited} totalBars={editTotalBars} bpm={bpm ?? 90}
            tracks={tracks} seqs={seqs} drumPattern={drumPattern}
            drumSequences={drumSequences} drumSeqCount={drumSeqCount} drumStepsPerBar={drumStepsPerBar}
            bassSeqs={bassSeqs}
            onToggleBass={toggleBass} onCycleBassSeq={cycleBassSeq}
            onRearrange={rearrange}
            onUndo={undo} onRedo={redo} canUndo={past.length > 0} canRedo={future.length > 0}
            previewing={previewing} getProgress={getProgress}
            seekBeat={seekBeat} onSeek={onSeek}
            onPreview={onPreview ? () => onPreview(plainSections()) : undefined}
            onStopPreview={onStopPreview}
            onSetChopSeq={setChopSeq} onToggleDrum={toggleDrum} onCycleDrumSeq={cycleDrumSeq}
            onMoveSection={moveSection} onRemoveSection={removeSection}
            onDuplicateSection={duplicateSection} onAddVerseCopy={addVerseCopy} onEditSection={editSectionMeta}
            onExport={onExport ? (target, format, onProgress) => onExport(target, format, plainSections(), onProgress) : undefined}
            onComplete={onComplete ? () => onComplete(plainSections()) : undefined}
            onClose={onClose}
          />
        )}
      </div>
    </div>
  );
}

/* ---------------- ARRANGER (themed, DAW-style track grid) ---------------- */
function Arranger({
  theme, t, isPhone, sections, totalBars, bpm, tracks, seqs, drumPattern, drumSequences, drumSeqCount, drumStepsPerBar,
  bassSeqs, onToggleBass, onCycleBassSeq,
  onRearrange, onUndo, onRedo, canUndo, canRedo, previewing, getProgress, seekBeat, onSeek, onPreview, onStopPreview,
  onSetChopSeq, onToggleDrum, onCycleDrumSeq, onMoveSection, onRemoveSection, onDuplicateSection, onAddVerseCopy, onEditSection,
  onExport, onComplete, onClose,
}: {
  theme: PortalTheme; t: any; isPhone: boolean;
  sections: Array<FinishArrangementSection & { _uid?: number }>; totalBars: number; bpm: number;
  tracks: { key: string; label: string }[]; seqs: string[]; drumPattern?: Record<string, boolean[]>;
  drumSequences?: Array<Record<string, boolean[]>>; drumSeqCount: number; drumStepsPerBar?: number;
  bassSeqs?: Array<{ dots: string }>;
  onToggleBass?: (si: number) => void; onCycleBassSeq?: (si: number, dir: -1 | 1) => void;
  onRearrange?: () => void;
  onUndo?: () => void; onRedo?: () => void; canUndo?: boolean; canRedo?: boolean;
  previewing?: boolean; getProgress?: () => { beat: number; total: number };
  seekBeat?: number; onSeek?: (beat: number) => void;
  onPreview?: () => void; onStopPreview?: () => void;
  onSetChopSeq: (si: number, idx: number) => void; onToggleDrum: (si: number, key: string) => void;
  onCycleDrumSeq: (si: number, key: string, dir: -1 | 1) => void;
  onMoveSection: (si: number, dir: -1 | 1) => void; onRemoveSection: (si: number) => void;
  onDuplicateSection: (si: number) => void; onAddVerseCopy: () => void;
  onEditSection: (si: number, label: string, bars: number) => void;
  onExport?: (target: 'master' | 'stems' | 'mpc' | 'drum-rack', format: 'wav' | 'mp3', onProgress: (pct: number, label: string) => void) => Promise<string>;
  onComplete?: () => void; onClose?: () => void;
}) {
  const isMac = theme === 'mac';
  const ink = isMac ? '#13314f' : t.ink;
  const accent = isMac ? '#1f8bff' : t.accent;
  const border = isMac ? 'rgba(0,0,0,0.12)' : t.panelBorder;
  const LABEL_W = isPhone ? 56 : 92; // Phase 3A.9: isPhone now a reactive prop

  // P2.7 edit-section modal
  const [editIdx, setEditIdx] = useState<number | null>(null);
  const [editName, setEditName] = useState('');
  const [editBars, setEditBars] = useState(8);
  const editLastRef = useRef(false);
  const openEdit = (si: number) => { setEditIdx(si); setEditName(sections[si]?.label ?? ''); setEditBars(sections[si]?.bars ?? 8); };
  const handleAdd = () => { editLastRef.current = true; onAddVerseCopy(); };
  // After "+ Add" appends a section, open the edit modal on the new (last) one.
  useEffect(() => {
    if (editLastRef.current && sections.length > 0) { editLastRef.current = false; openEdit(sections.length - 1); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sections.length]);

  // Ref-based playhead: a rAF reads the preview position and moves the line only —
  // NO auto-scroll (Phase 3A.4), so the user can scroll the grid freely during
  // preview. No setState on the animation frame. Hides the line when stopped.
  const gridScrollRef = useRef<HTMLDivElement>(null);
  const gridInnerRef = useRef<HTMLDivElement>(null);
  const playheadRef = useRef<HTMLDivElement>(null);

  // Phase 2D: measure each section cell's actual left/width (relative to the grid
  // inner, scroll-independent) so the playhead aligns pixel-perfectly with the
  // grid — the columns aren't proportional to bars (minWidth floor + flex gaps),
  // so a linear beat→x mapping drifts off the boundaries.
  const sectionBoundsRef = useRef<Array<{ left: number; width: number }>>([]);
  const measureSections = () => {
    const inner = gridInnerRef.current;
    if (!inner) return;
    const innerLeft = inner.getBoundingClientRect().left;
    const bounds: Array<{ left: number; width: number }> = [];
    inner.querySelectorAll<HTMLElement>('[data-sec-cell]').forEach((c) => {
      const r = c.getBoundingClientRect();
      bounds.push({ left: r.left - innerLeft, width: r.width });
    });
    sectionBoundsRef.current = bounds;
  };

  // Phase 3A.6 — seeking. Section start beats + total drive both the click-to-seek
  // math and the ◀ ▶ jumps; bar = 4 beats.
  const sectionBeats = sections.map((s) => Math.max(1, Math.floor(s.bars) || 1) * 4);
  const totalBeats = sectionBeats.reduce((a, b) => a + b, 0);
  const sectionStartBeats: number[] = [];
  { let acc = 0; for (const sb of sectionBeats) { sectionStartBeats.push(acc); acc += sb; } }

  // Move the playhead line onto the measured section cells for a given beat.
  const placeHeadAtBeat = (beat: number, show = true) => {
    const head = playheadRef.current;
    const bounds = sectionBoundsRef.current;
    if (!head || !bounds.length) return;
    let idx = bounds.length - 1, frac = 1;
    for (let i = 0; i < sections.length; i++) {
      if (beat < sectionStartBeats[i] + sectionBeats[i]) { idx = i; frac = (beat - sectionStartBeats[i]) / sectionBeats[i]; break; }
    }
    frac = Math.max(0, Math.min(1, frac));
    const b = bounds[Math.min(idx, bounds.length - 1)];
    if (!b) return;
    head.style.left = `${b.left + frac * b.width}px`;
    head.style.display = show ? 'block' : 'none';
  };

  // Beat under a client-x in the grid, snapped to the nearest bar. null when the
  // x falls in the label gutter (left of the first section cell).
  const beatFromClientX = (clientX: number): number | null => {
    const inner = gridInnerRef.current;
    const bounds = sectionBoundsRef.current;
    if (!inner || !bounds.length) return null;
    const x = clientX - inner.getBoundingClientRect().left;
    for (let i = 0; i < bounds.length && i < sections.length; i++) {
      const b = bounds[i];
      if (x < b.left) break;
      if (x <= b.left + b.width) {
        const frac = Math.max(0, Math.min(1, (x - b.left) / b.width));
        const raw = sectionStartBeats[i] + frac * sectionBeats[i];
        return Math.max(0, Math.min(Math.floor(raw / 4) * 4, Math.max(0, totalBeats - 4)));
      }
    }
    return null;
  };

  // Click anywhere on the grid (not on a control) → seek to that bar.
  const handleGridClick = (e: ReactMouseEvent<HTMLDivElement>) => {
    if (!onSeek) return;
    if ((e.target as HTMLElement).closest('button, select, input, option')) return;
    const beat = beatFromClientX(e.clientX);
    if (beat !== null) onSeek(beat);
  };

  // ◀ ▶ : jump to the previous / next section's start, relative to the current
  // playhead (live position while previewing, else the seek marker).
  const jumpSection = (dir: -1 | 1) => {
    if (!onSeek || !sectionStartBeats.length) return;
    const cur = previewing && getProgress ? getProgress().beat : (seekBeat ?? 0);
    let idx = 0;
    for (let i = 0; i < sectionStartBeats.length; i++) if (sectionStartBeats[i] <= cur + 1e-3) idx = i;
    const next = Math.max(0, Math.min(sectionStartBeats.length - 1, idx + dir));
    onSeek(sectionStartBeats[next]);
  };

  useEffect(() => {
    measureSections();
    window.addEventListener('resize', measureSections);
    return () => window.removeEventListener('resize', measureSections);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sections, LABEL_W]);

  // Previewing: a rAF drives the line from the live position. (placeHeadAtBeat
  // maps the beat onto the measured cells — see Phase 2D note above.)
  useEffect(() => {
    if (!previewing || !getProgress) return;
    measureSections(); // fresh measure once the layout is settled at preview start
    let raf = 0;
    const tick = () => {
      placeHeadAtBeat(getProgress().beat, true);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [previewing, getProgress, sections]);

  // Stopped: park the line at the seek marker (Phase 3A.6) so the user sees where
  // play will start. Hidden at beat 0 (the default top-of-song start).
  useEffect(() => {
    if (previewing) return; // the rAF owns the head while previewing
    measureSections();
    const sb = seekBeat ?? 0;
    if (sb > 0) placeHeadAtBeat(sb, true);
    else if (playheadRef.current) playheadRef.current.style.display = 'none';
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [previewing, seekBeat, sections, LABEL_W]);

  // 4 beat-dots (first bar) for a track's row taken from its CHOSEN drum sequence
  // (Phase 1B). Falls back to the active pattern if the sequence list is absent.
  const beatDots = (key: string, seqIdx: number): string => {
    const pat = drumSequences?.[seqIdx] ?? drumPattern;
    const row = pat?.[key];
    if (!row) return '····';
    // Rows are stored at the engine's resolution (96/bar today; 32, then 16
    // before) — a beat is spb/4 steps, not 4. Hardcoded 4 only read the first
    // quarter of the bar at anything finer than 1/16.
    const perBeat = Math.max(1, Math.round((drumStepsPerBar || 16) / 4));
    return [0, 1, 2, 3].map((b) => (row.slice(b * perBeat, (b + 1) * perBeat).some(Boolean) ? '●' : '·')).join('');
  };

  // Phase 3A.9 — phone-aware sizing: roomier cells + bigger tap targets.
  const cellBase: CSSProperties = { ...styles.cell, minWidth: isPhone ? 88 : 66, padding: isPhone ? 7 : 6 };
  const secMiniStyle: CSSProperties = isPhone ? { ...styles.secMini, minHeight: 30, fontSize: 14, padding: '6px 0' } : styles.secMini;
  const seqArrowStyle: CSSProperties = isPhone ? { ...styles.seqArrow, width: 26, fontSize: 14 } : styles.seqArrow;
  const cellSelectStyle: CSSProperties = { ...styles.cellSelect, fontSize: isPhone ? 13 : 11, padding: isPhone ? '7px 4px' : '3px 4px' };
  const addBtnStyle: CSSProperties = { ...styles.addBtn, padding: isPhone ? '9px 11px' : '5px 8px' };

  // Phase 4A — export UI state.
  const [exportTarget, setExportTarget] = useState<'master' | 'stems' | 'mpc' | 'drum-rack'>('master');
  const [exportFmt, setExportFmt] = useState<'wav' | 'mp3'>('wav');
  const [exporting, setExporting] = useState(false);
  const [exportPct, setExportPct] = useState(0);
  const [exportMsg, setExportMsg] = useState<string | null>(null);
  const runExport = async () => {
    if (!onExport || exporting) return;
    setExporting(true); setExportPct(0); setExportMsg('Starting…');
    try {
      const msg = await onExport(exportTarget, exportFmt, (pct, label) => { setExportPct(pct); setExportMsg(label); });
      setExportPct(1); setExportMsg(msg);
    } catch (e: any) {
      setExportMsg(e?.message || 'Export failed.');
    } finally {
      setExporting(false);
    }
  };

  return (
    <div className="fh-arr-in" style={{ ...styles.arrWrap, color: t.ink, padding: isPhone ? 8 : 22 }}>
      {theme === 'xbox' && <div style={styles.xboxGrid} />}
      {theme === 'xbox' && <div style={styles.scanlines} />}
      {theme === 'ps2' && <div style={styles.ps2Void} />}
      {isMac && <div style={styles.macDesk} />}

      <div style={{
        ...styles.panel, background: t.panel, border: `1px solid ${t.panelBorder}`,
        width: isPhone ? '100%' : 'min(820px, 96%)', padding: isPhone ? 12 : 22,
        // Liquid glass: frosted blur on every portal theme, a bright specular top
        // rim + layered elevation shadow (+ theme glow) so the panel pops in 3D.
        borderRadius: isMac ? 18 : 16,
        backdropFilter: 'blur(22px) saturate(180%)',
        WebkitBackdropFilter: 'blur(22px) saturate(180%)',
        boxShadow: isMac
          ? '0 30px 70px -20px rgba(0,0,0,0.30), 0 0 50px rgba(120,190,255,0.30), inset 0 1px 0 rgba(255,255,255,0.9), inset 0 -2px 6px rgba(0,0,0,0.06)'
          : `0 36px 80px -24px rgba(0,0,0,0.70), 0 0 60px ${t.glow}, inset 0 1px 0 rgba(255,255,255,0.5), inset 0 -2px 8px rgba(0,0,0,0.35)`,
        color: ink, overflow: isMac ? 'hidden' : 'visible',
      }}>
        {isMac && <div className="fh-gloss" />}

        {/* Header — wraps on a phone so the title + REARRANGE/Close never overflow */}
        <div style={{ ...styles.panelHead, flexWrap: 'wrap', gap: 8, paddingRight: isPhone ? 38 : 0 }}>
          <span style={{ ...styles.panelTitle, color: accent, fontSize: isPhone ? 14 : 18 }}>
            {isMac ? 'Finish your beat' : 'FINISH YOUR BEAT'}
          </span>
          <div className="fh-head-ctrls" style={{ display: 'flex', alignItems: 'center', gap: isPhone ? 6 : 10, flexWrap: 'wrap' }}>
            <span style={{ ...styles.panelMeta, color: isMac ? '#5a6b80' : t.ink }}>
              {totalBars} bars · {Math.round(bpm)} BPM
            </span>
            {onUndo && (
              <button onClick={onUndo} disabled={!canUndo} title="Undo (⌘Z)"
                style={{ ...styles.regenBtn, color: isMac ? '#5a6b80' : t.ink, borderColor: border, borderRadius: isMac ? 999 : 4, padding: isPhone ? '8px 10px' : '6px 10px', opacity: canUndo ? 1 : 0.35, cursor: canUndo ? 'pointer' : 'default' }}>
                ↶<span className="fh-btn-label"> UNDO</span>
              </button>
            )}
            {onRedo && (
              <button onClick={onRedo} disabled={!canRedo} title="Redo (⇧⌘Z)"
                style={{ ...styles.regenBtn, color: isMac ? '#5a6b80' : t.ink, borderColor: border, borderRadius: isMac ? 999 : 4, padding: isPhone ? '8px 10px' : '6px 10px', opacity: canRedo ? 1 : 0.35, cursor: canRedo ? 'pointer' : 'default' }}>
                ↷<span className="fh-btn-label"> REDO</span>
              </button>
            )}
            {onRearrange && (
              <button onClick={onRearrange} title="Shuffle your chop + drum sequences across the sections"
                style={{ ...styles.regenBtn, color: isMac ? '#5a6b80' : t.ink, borderColor: border, borderRadius: isMac ? 999 : 4, padding: isPhone ? '8px 12px' : '6px 12px' }}>
                ↻ REARRANGE
              </button>
            )}
            {onClose && (
              <button onClick={onClose} className="fh-close-btn"
                style={{ ...styles.regenBtn, color: isMac ? '#5a6b80' : t.ink, borderColor: border, borderRadius: isMac ? 999 : 4, padding: isPhone ? '8px 12px' : '6px 12px' }}>
                Close
              </button>
            )}
          </div>
        </div>

        {/* Mixer strip removed — CHOPS/DRUMS/CLIPPER/MASTER now live on the DAW
            mixer. The Beat Finisher is arrangement-only. */}

        {/* DAW track grid — rows: ARRANGEMENT / CHOPS / drum tracks; columns: sections */}
        {/* Phase 3A.4: manual horizontal scroll stays enabled during preview — the
            playhead no longer auto-scrolls, so the user is free to scroll themselves. */}
        <div ref={gridScrollRef} style={styles.gridScroll}>
          <div ref={gridInnerRef} onClick={handleGridClick}
            style={{ minWidth: 'min-content', position: 'relative', cursor: onSeek ? 'pointer' : 'default' }}>
            <div ref={playheadRef} style={{ ...styles.playhead, background: accent }} />
            {/* Section header row */}
            <div style={styles.trackRow}>
              <div style={{ ...styles.rowLabel, width: LABEL_W, color: isMac ? '#5a6b80' : t.ink, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 4 }}>
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>ARRANGEMENT</span>
                {onSeek && (
                  <span style={{ display: 'flex', gap: 2, flexShrink: 0 }}>
                    <button style={secMiniStyle} title="Jump to previous section" onClick={() => jumpSection(-1)}>◀</button>
                    <button style={secMiniStyle} title="Jump to next section" onClick={() => jumpSection(1)}>▶</button>
                  </span>
                )}
              </div>
              {sections.map((sec, si) => (
                <div key={sec._uid ?? si} data-sec-cell="" style={{ ...cellBase, flexGrow: sec.bars, borderColor: border }}>
                  <div onDoubleClick={() => openEdit(si)} title="Double-click to edit"
                    style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 4, cursor: 'pointer' }}>
                    <span style={{ fontSize: isPhone ? 12 : 11, fontWeight: 800, color: accent, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{sec.label}</span>
                    <span style={{ fontSize: 9, opacity: 0.6 }}>{sec.bars}b</span>
                  </div>
                  <div style={{ display: 'flex', gap: 2, marginTop: 3 }}>
                    <button style={secMiniStyle} title="Move left" onClick={() => onMoveSection(si, -1)}>‹</button>
                    <button style={secMiniStyle} title="Edit" onClick={() => openEdit(si)}>✎</button>
                    <button style={secMiniStyle} title="Duplicate" onClick={() => onDuplicateSection(si)}>⧉</button>
                    <button style={secMiniStyle} title="Remove" onClick={() => onRemoveSection(si)}>✕</button>
                    <button style={secMiniStyle} title="Move right" onClick={() => onMoveSection(si, 1)}>›</button>
                  </div>
                </div>
              ))}
              <div style={styles.addCell}>
                <button style={{ ...addBtnStyle, color: accent, borderColor: border }} onClick={handleAdd} title="Add a section (copies the first Verse)">+ Add</button>
              </div>
            </div>

            {/* CHOPS row */}
            <div style={styles.trackRow}>
              <div style={{ ...styles.rowLabel, width: LABEL_W, color: accent }}>CHOPS</div>
              {sections.map((sec, si) => (
                <div key={sec._uid ?? si} style={{ ...cellBase, flexGrow: sec.bars, borderColor: border }}>
                  <select value={sec.chopSeqIdx} onChange={(e) => onSetChopSeq(si, Number(e.target.value))}
                    style={{ ...cellSelectStyle, color: sec.chopSeqIdx < 0 ? (isMac ? '#5a6b80' : t.ink) : ink, borderColor: border }}
                    title="Which chop sequence this section plays — NONE for a section with no chops (drums/bass only: a drum intro, a breakdown)">
                    {seqs.map((label, idx) => <option key={idx} value={idx}>{label}</option>)}
                    <option value={-1}>— none —</option>
                  </select>
                </div>
              ))}
              <div style={styles.addCell} />
            </div>

            {/* Drum track rows — each cell: ◀ [dots · Seq N] ▶  (Phase 1B) */}
            {tracks.map((tk) => (
              <div key={tk.key} style={styles.trackRow}>
                <div style={{ ...styles.rowLabel, width: LABEL_W, color: isMac ? '#5a6b80' : t.ink }}>{tk.label}</div>
                {sections.map((sec, si) => {
                  const on = !!sec.drumsOn[tk.key];
                  const seqIdx = Math.min(sec.drumSeq?.[tk.key] ?? 0, drumSeqCount - 1);
                  const dim = isMac ? 'rgba(0,0,0,0.28)' : 'var(--hw-faint, rgba(255,255,255,0.28))';
                  return (
                    <div key={sec._uid ?? si}
                      style={{
                        ...cellBase, ...styles.drumCellWrap, flexGrow: sec.bars, borderColor: border,
                        padding: 2, minHeight: isPhone ? 46 : undefined,
                        background: on ? (isMac ? '#eaf3ff' : theme === 'palette' ? `color-mix(in srgb, ${t.accent} 12%, transparent)` : `${t.accent}1f`) : 'transparent',
                        opacity: on ? 1 : 0.6,
                      }}>
                      <button style={{ ...seqArrowStyle, color: drumSeqCount > 1 ? accent : dim }}
                        disabled={drumSeqCount <= 1} onClick={() => onCycleDrumSeq(si, tk.key, -1)}
                        title="Previous drum sequence">◀</button>
                      <button onClick={() => onToggleDrum(si, tk.key)}
                        title={on ? 'On — click to mute' : 'Off — click to enable'}
                        style={{ ...styles.drumCellCenter, color: on ? accent : dim }}>
                        <span style={{ fontFamily: 'monospace', fontSize: 13, letterSpacing: '2px', lineHeight: 1 }}>{beatDots(tk.key, seqIdx)}</span>
                        <span style={{ fontSize: 8, fontWeight: 800, letterSpacing: '0.04em', opacity: on ? 0.85 : 0.6 }}>SEQ {seqIdx + 1}</span>
                      </button>
                      <button style={{ ...seqArrowStyle, color: drumSeqCount > 1 ? accent : dim }}
                        disabled={drumSeqCount <= 1} onClick={() => onCycleDrumSeq(si, tk.key, 1)}
                        title="Next drum sequence">▶</button>
                    </div>
                  );
                })}
                <div style={styles.addCell} />
              </div>
            ))}

            {/* BASS row — same cell grammar as the drum rows: ◀ [dots · SEQ N] ▶ */}
            {bassSeqs && bassSeqs.length > 0 && (
              <div style={styles.trackRow}>
                <div style={{ ...styles.rowLabel, width: LABEL_W, color: isMac ? '#5a6b80' : t.ink }}>BASS</div>
                {sections.map((sec, si) => {
                  const idx = sec.bassSeq ?? -1;
                  const on = idx >= 0;
                  const seqIdx = Math.min(Math.max(0, idx), bassSeqs.length - 1);
                  const dim = isMac ? 'rgba(0,0,0,0.28)' : 'var(--hw-faint, rgba(255,255,255,0.28))';
                  const canCycle = bassSeqs.length > 1 && on;
                  return (
                    <div key={sec._uid ?? si}
                      style={{
                        ...cellBase, ...styles.drumCellWrap, flexGrow: sec.bars, borderColor: border,
                        padding: 2, minHeight: isPhone ? 46 : undefined,
                        background: on ? (isMac ? '#eaf3ff' : theme === 'palette' ? `color-mix(in srgb, ${t.accent} 12%, transparent)` : `${t.accent}1f`) : 'transparent',
                        opacity: on ? 1 : 0.6,
                      }}>
                      <button style={{ ...seqArrowStyle, color: canCycle ? accent : dim }}
                        disabled={!canCycle} onClick={() => onCycleBassSeq?.(si, -1)}
                        title="Previous bass pattern">◀</button>
                      <button onClick={() => onToggleBass?.(si)}
                        title={on ? 'Bass on — click to mute' : 'Bass off — click to enable'}
                        style={{ ...styles.drumCellCenter, color: on ? accent : dim }}>
                        <span style={{ fontFamily: 'monospace', fontSize: 13, letterSpacing: '2px', lineHeight: 1 }}>{bassSeqs[seqIdx]?.dots ?? '····'}</span>
                        <span style={{ fontSize: 8, fontWeight: 800, letterSpacing: '0.04em', opacity: on ? 0.85 : 0.6 }}>{on ? `SEQ ${seqIdx + 1}` : 'OFF'}</span>
                      </button>
                      <button style={{ ...seqArrowStyle, color: canCycle ? accent : dim }}
                        disabled={!canCycle} onClick={() => onCycleBassSeq?.(si, 1)}
                        title="Next bass pattern">▶</button>
                    </div>
                  );
                })}
                <div style={styles.addCell} />
              </div>
            )}
          </div>
        </div>

        {/* Edit-section modal (P2.7) */}
        {editIdx !== null && (
          <div style={{ ...styles.addPop, background: isMac ? '#fff' : t.bg, borderColor: border, color: ink }}>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <span style={{ fontSize: 11, fontWeight: 700, opacity: 0.7 }}>EDIT SECTION</span>
              <input value={editName} onChange={(e) => setEditName(e.target.value)} placeholder="Name"
                style={{ ...styles.addInput, color: ink, borderColor: border, width: 120 }} />
              <label style={{ fontSize: 11, display: 'flex', alignItems: 'center', gap: 4 }}>
                bars
                <input type="number" min={1} max={16} value={editBars} onChange={(e) => setEditBars(Number(e.target.value))}
                  style={{ ...styles.addInput, color: ink, borderColor: border, width: 56 }} />
              </label>
              <button style={{ ...styles.addBtn, color: accent, borderColor: border }}
                onClick={() => { if (editIdx !== null) onEditSection(editIdx, editName, editBars); setEditIdx(null); }}>Save</button>
              <button style={{ ...styles.addBtn, color: isMac ? '#5a6b80' : t.ink, borderColor: border }}
                onClick={() => setEditIdx(null)}>Cancel</button>
            </div>
          </div>
        )}

        {/* Actions — Preview + the Phase 4A export panel. Stacks on a phone. */}
        <div style={{ ...styles.actions, flexDirection: isPhone ? 'column' : 'row', gap: isPhone ? 8 : 10, alignItems: isPhone ? 'stretch' : 'center' }}>
          {(onPreview || onStopPreview) && (
            <button onClick={() => (previewing ? onStopPreview && onStopPreview() : onPreview && onPreview())}
              style={{ ...styles.ghostBtn, color: accent, borderColor: border, borderRadius: isMac ? 999 : 4, width: isPhone ? '100%' : undefined, padding: isPhone ? '14px 18px' : '10px 18px' }}>
              {previewing ? '■ Stop' : '◀ Preview'}
            </button>
          )}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginLeft: isPhone ? 0 : 'auto' }}>
            <select value={exportTarget} disabled={exporting}
              onChange={(e) => setExportTarget(e.target.value as 'master' | 'stems' | 'mpc' | 'drum-rack')}
              title="What to export"
              style={{ ...cellSelectStyle, width: 'auto', color: ink, borderColor: border, background: 'transparent', padding: isPhone ? '9px 8px' : '6px 8px' }}>
              <option value="master">Master Mixdown</option>
              <option value="stems">Trackouts (Chops + Drums)</option>
              <option value="mpc">MPC Project (.mpcsample + WAVs)</option>
              <option value="drum-rack">Ableton Drum Rack (.adg)</option>
            </select>
            <select value={exportFmt} disabled={exporting || exportTarget === 'mpc' || exportTarget === 'drum-rack'}
              onChange={(e) => setExportFmt(e.target.value as 'wav' | 'mp3')}
              title="File format"
              style={{ ...cellSelectStyle, width: 'auto', color: ink, borderColor: border, background: 'transparent', padding: isPhone ? '9px 8px' : '6px 8px' }}>
              <option value="wav">WAV · 16-bit</option>
              <option value="mp3" disabled>MP3 (soon)</option>
            </select>
            <button onClick={runExport} disabled={exporting || !onExport}
              style={{
                ...styles.primaryBtn, color: isMac ? '#fff' : t.bg,
                background: isMac ? 'linear-gradient(180deg,#3aa0ff,#1f7bff)' : `linear-gradient(180deg, ${t.accent}, ${t.accent2})`,
                boxShadow: isMac ? '0 6px 16px rgba(31,123,255,0.4), inset 0 1px 0 rgba(255,255,255,0.6)' : `0 0 24px ${t.glow}, inset 0 1px 0 rgba(255,255,255,0.4)`,
                borderRadius: isMac ? 999 : 4, opacity: exporting ? 0.7 : 1,
                width: isPhone ? '100%' : undefined, padding: isPhone ? '14px 22px' : '12px 22px',
              }}>
              {exporting ? `Exporting… ${Math.round(exportPct * 100)}%` : 'Export ›'}
            </button>
          </div>
        </div>
        {/* Progress bar + status while/after exporting */}
        {(exporting || exportMsg) && (
          <div style={{ marginTop: 8 }}>
            <div style={{ height: 5, borderRadius: 3, background: isMac ? 'rgba(0,0,0,0.1)' : 'var(--hw-faint, rgba(255,255,255,0.12))', overflow: 'hidden' }}>
              <div style={{ height: '100%', width: `${Math.round(exportPct * 100)}%`, background: accent, transition: 'width 0.2s' }} />
            </div>
            {exportMsg && <div style={{ fontSize: 11, marginTop: 4, opacity: 0.8, color: isMac ? '#5a6b80' : t.ink }}>{exportMsg}</div>}
          </div>
        )}
      </div>
    </div>
  );
}

/* ---------------- keyframes ---------------- */
function StyleTag() {
  return (
    <style>{`
      @keyframes fhPulse { 0%,100%{transform:scale(1)} 50%{transform:scale(1.04)} }
      .fh-pulse{ animation: fhPulse 1.4s ease-in-out infinite; }
      @keyframes fhFlash { 0%{opacity:0;transform:scale(0.6)} 15%{opacity:1;transform:scale(1.1)} 70%{opacity:1} 100%{opacity:0;transform:scale(1)} }
      .fh-flash{ animation: fhFlash 1.1s ease-out forwards; }
      @keyframes fhEnter { 0%{opacity:0;letter-spacing:0.05em} 30%{opacity:1} 100%{opacity:1;letter-spacing:0.35em} }
      .fh-enter{ animation: fhEnter 2.1s ease-out forwards; }
      @keyframes fhArrIn { 0%{opacity:0;transform:translateY(18px) scale(0.98)} 100%{opacity:1;transform:none} }
      .fh-arr-in{ animation: fhArrIn 0.6s cubic-bezier(.2,.8,.2,1) forwards; }
      @keyframes fhGloss { 0%{transform:translateX(-130%) skewX(-18deg);opacity:0} 25%{opacity:0.55} 60%{opacity:0} 100%{transform:translateX(240%) skewX(-18deg);opacity:0} }
      .fh-gloss{ position:absolute; top:0; bottom:0; left:0; width:45%; pointer-events:none; z-index:3; background:linear-gradient(90deg, transparent, rgba(255,255,255,0.65), transparent); animation: fhGloss 1.8s ease-out 0.45s 1; }
      @media (prefers-reduced-motion: reduce){
        .fh-pulse,.fh-flash,.fh-enter,.fh-arr-in,.fh-gloss{ animation: none !important; }
        .fh-gloss{ display:none; }
      }
    `}</style>
  );
}

/* ---------------- styles ---------------- */
const styles: Record<string, CSSProperties> = {
  root: { width: '100%', minHeight: 560, color: '#fff', position: 'relative' },
  closeBtn: { position: 'absolute', top: 10, right: 12, zIndex: 5, width: 34, height: 34, borderRadius: 6, border: '1px solid rgba(255,255,255,0.3)', background: 'rgba(0,0,0,0.4)', color: '#fff', fontSize: 20, cursor: 'pointer' },
  stage: { position: 'relative', height: 560, borderRadius: 14, overflow: 'hidden', display: 'flex', alignItems: 'center', justifyContent: 'center', transition: 'background 0.4s' },
  center: { position: 'relative', zIndex: 2, textAlign: 'center', padding: 24 },
  kicker: { fontSize: 12, letterSpacing: '0.3em', textTransform: 'uppercase', marginBottom: 22, opacity: 0.85 },
  finishBtn: { fontSize: 46, fontWeight: 900, letterSpacing: '0.06em', padding: '22px 54px', border: 'none', borderRadius: 8, cursor: 'pointer', textTransform: 'uppercase' },
  sub: { marginTop: 22, fontSize: 13, letterSpacing: '0.16em', opacity: 0.7, textTransform: 'uppercase' },
  flashText: { fontSize: 64, fontWeight: 900, letterSpacing: '0.04em' },
  canvas: { position: 'absolute', inset: 0, width: '100%', height: '100%', zIndex: 1 },
  enterLabel: { fontSize: 26, fontWeight: 800, letterSpacing: '0.2em', textTransform: 'uppercase' },
  arrWrap: { position: 'absolute', inset: 0, display: 'flex', alignItems: 'flex-start', justifyContent: 'center', padding: 22, zIndex: 2, overflowY: 'auto' },
  xboxGrid: { position: 'absolute', inset: 0, background: 'radial-gradient(circle at 50% 40%, rgba(40,255,110,0.10), transparent 60%), repeating-linear-gradient(0deg, rgba(40,255,110,0.05) 0 1px, transparent 1px 26px), repeating-linear-gradient(90deg, rgba(40,255,110,0.05) 0 1px, transparent 1px 26px)' },
  ps2Void: { position: 'absolute', inset: 0, background: 'radial-gradient(circle at 50% 60%, rgba(120,140,255,0.12), transparent 55%)' },
  macDesk: { position: 'absolute', inset: 0, background: 'linear-gradient(180deg,#1c78ff,#0a55e6)' },
  scanlines: { position: 'absolute', inset: 0, pointerEvents: 'none', zIndex: 1, opacity: 0.5, background: 'repeating-linear-gradient(0deg, rgba(0,0,0,0.10) 0 1px, transparent 1px 3px)' },
  panel: { position: 'relative', zIndex: 2, width: 'min(820px, 96%)', borderRadius: 12, padding: 22 },
  panelHead: { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 16 },
  panelTitle: { fontSize: 18, fontWeight: 800, letterSpacing: '0.16em' },
  panelMeta: { fontSize: 12, letterSpacing: '0.1em', opacity: 0.8 },
  suggRow: { display: 'flex', gap: 10, marginBottom: 18, flexWrap: 'wrap' },
  sugg: { flex: '1 1 180px', textAlign: 'left', padding: '12px 14px', border: '1px solid', cursor: 'pointer', background: 'transparent', transition: 'all 0.2s' },
  suggName: { fontSize: 14, fontWeight: 800, marginBottom: 2 },
  suggDesc: { fontSize: 13, fontWeight: 700, opacity: 0.9, fontVariantNumeric: 'tabular-nums' },
  suggTag: { fontSize: 11, marginTop: 4 },
  timeline: { display: 'flex', gap: 6, marginBottom: 20, minHeight: 96 },
  secBlock: { flexBasis: 0, padding: 10, display: 'flex', flexDirection: 'column', gap: 6, minWidth: 70 },
  secLabel: { fontSize: 12, fontWeight: 800, letterSpacing: '0.06em' },
  secBars: { fontSize: 10, opacity: 0.6, letterSpacing: '0.08em' },
  secChips: { display: 'flex', flexDirection: 'column', gap: 3, marginTop: 'auto' },
  chip: { fontSize: 9, padding: '2px 5px', borderRadius: 3, fontWeight: 700, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
  secCtrl: { display: 'flex', gap: 2, marginBottom: 2 },
  secMini: { flex: 1, fontSize: 10, lineHeight: 1, padding: '2px 0', background: 'transparent', border: '1px solid currentColor', color: 'inherit', cursor: 'pointer', opacity: 0.65, borderRadius: 3 },
  chipRow: { display: 'flex', alignItems: 'center', gap: 2, padding: '1px 3px 1px 5px', borderRadius: 3, maxWidth: '100%' },
  chipBtn: { background: 'transparent', border: 0, color: 'inherit', font: 'inherit', fontSize: 9, fontWeight: 700, cursor: 'pointer', padding: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 64 },
  chipX: { background: 'transparent', border: 0, color: 'inherit', cursor: 'pointer', fontSize: 11, lineHeight: 1, padding: '0 1px', opacity: 0.85 },
  chipAdd: { fontSize: 9, padding: '2px 5px', borderRadius: 3, border: '1px dashed currentColor', background: 'transparent', cursor: 'pointer', opacity: 0.7 },
  addSection: { flexGrow: 1, flexBasis: 0, minWidth: 64, border: '1px dashed', background: 'transparent', cursor: 'pointer', fontSize: 11, fontWeight: 700, letterSpacing: '0.04em' },
  // DAW track grid
  gridScroll: { overflowX: 'auto', marginBottom: 14, paddingBottom: 4 },
  playhead: { position: 'absolute', top: 0, bottom: 0, width: 2, pointerEvents: 'none', display: 'none', zIndex: 4, boxShadow: '0 0 8px currentColor' },
  trackRow: { display: 'flex', alignItems: 'stretch', gap: 4, marginBottom: 4 },
  rowLabel: { flexShrink: 0, fontSize: 10, fontWeight: 800, letterSpacing: '0.06em', display: 'flex', alignItems: 'center', padding: '0 6px', textTransform: 'uppercase', opacity: 0.85 },
  cell: { flexBasis: 0, minWidth: 66, border: '1px solid', borderRadius: 4, padding: 6 },
  cellSelect: { width: '100%', background: 'transparent', border: '1px solid', borderRadius: 3, fontSize: 11, padding: '3px 4px', cursor: 'pointer' },
  drumCell: { fontFamily: 'monospace', fontSize: 14, letterSpacing: '2px', textAlign: 'center', cursor: 'pointer' },
  // Phase 1B drum cell: ◀ [dots / Seq N] ▶
  drumCellWrap: { display: 'flex', alignItems: 'stretch', gap: 1, padding: 2 },
  drumCellCenter: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 1, background: 'transparent', border: 0, cursor: 'pointer', padding: '2px 0' },
  seqArrow: { flexShrink: 0, width: 13, alignSelf: 'stretch', background: 'transparent', border: 0, cursor: 'pointer', fontSize: 9, lineHeight: 1, padding: 0, opacity: 0.85 },
  addCell: { flexShrink: 0, width: 64, display: 'flex', alignItems: 'center', justifyContent: 'center' },
  addBtn: { fontSize: 11, fontWeight: 700, padding: '5px 8px', border: '1px dashed', borderRadius: 4, background: 'transparent', cursor: 'pointer', whiteSpace: 'nowrap' },
  addPop: { border: '1px solid', borderRadius: 6, padding: 8, marginBottom: 12 },
  addInput: { background: 'transparent', border: '1px solid', borderRadius: 3, fontSize: 11, padding: '5px 6px' },
  actions: { display: 'flex', justifyContent: 'space-between', alignItems: 'center' },
  ghostBtn: { padding: '10px 18px', border: '1px solid', background: 'transparent', cursor: 'pointer', fontSize: 13, fontWeight: 700, letterSpacing: '0.08em' },
  regenBtn: { padding: '6px 12px', border: '1px solid', background: 'transparent', cursor: 'pointer', fontSize: 11, fontWeight: 700, letterSpacing: '0.06em' },
  primaryBtn: { padding: '12px 26px', border: 'none', cursor: 'pointer', fontSize: 14, fontWeight: 800, letterSpacing: '0.06em' },
  // Phase 3A suggestion picker
  trayOverlay: { position: 'absolute', inset: 0, zIndex: 6, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(0,0,0,0.6)', padding: 16 },
  trayPanel: { width: 'min(720px, 94%)', maxHeight: '88%', overflowY: 'auto', borderRadius: 12, padding: 18, boxShadow: '0 20px 60px rgba(0,0,0,0.5)' },
  trayHead: { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 12, gap: 8 },
  trayCards: { display: 'flex', gap: 10, flexWrap: 'wrap' },
  trayCard: { flex: '1 1 200px', minWidth: 160, textAlign: 'left', padding: '12px 14px', borderRadius: 8, border: '1px solid', cursor: 'pointer', transition: 'all 0.15s' },
  trayActions: { display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 16, flexWrap: 'wrap' },
};
