/**
 * DrumBrowser.tsx
 * ----------------------------------------------------------------------------
 * MPC 4000-style drum sample picker for Terminator.
 *
 * - Pop-up modal, portal-mountable, theme-color aware (one CSS var drives all).
 * - Left sidebar = the drum category folders (KICK / SNARE / HIHAT / OPENHAT /
 *   PERC, then CLAPS & SNAPS and RIM, which have no default lane — ADD NEW
 *   grafts one on).
 * - Right pane  = aliased sample list (real filenames never displayed).
 * - Tapping a sample auditions it (swaps into live sequence on next loop)
 *   AND, if PREVIEW is on, plays a one-shot immediately.
 * - LOAD commits. CLOSE / Esc cancels and restores the original sample.
 * - RANDOM picks + auditions a random sample in the current category.
 * - Keyboard: up/down nav, 1-5 folders, R random, P preview, Enter load, Esc cancel.
 * - CRT effect: scanlines, vignette, soft flicker, phosphor glow.
 *
 * INTEGRATION
 * ----------------------------------------------------------------------------
 *   import { DrumBrowser, makeDrumSamples } from './DrumBrowser';
 *
 *   // Build the sample list ONCE from your /drums/ manifest. Aliasing is
 *   // deterministic - same filename always maps to same alias across reloads.
 *   const allSamples = useMemo(() => makeDrumSamples(rawManifest), [rawManifest]);
 *
 *   // When user clicks the kick row's sample slot in your sequencer:
 *   setBrowser({ open: true, category: 'kick', trackIndex: 0 });
 *
 *   <DrumBrowser
 *     open={browser.open}
 *     initialCategory={browser.category}
 *     samples={allSamples}
 *     currentSampleId={tracks[browser.trackIndex]?.sampleId ?? null}
 *     themeColor={theme.phosphor}              // e.g. '#ff5230', '#00ff41'
 *     onAudition={(s) => swapTrackSample(browser.trackIndex, s.url)}
 *     onPreviewPlay={(s) => previewOneShot(s.url)}
 *     onCommit={(s) => { commitTrackSample(browser.trackIndex, s); close(); }}
 *     onCancel={() => { restoreTrackSample(browser.trackIndex); close(); }}
 *   />
 *
 *   swapTrackSample should set the track's "next loop" source. Your DrumEngine
 *   already supports per-track buffer swap - this is the same mechanism the
 *   Randomize-sounds button uses, just driven from the browser.
 *
 *   restoreTrackSample reads back the saved-on-open id and swaps it back.
 *   Keep that snapshot in the parent (one ref is enough).
 * ----------------------------------------------------------------------------
 */

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';

// ============================================================================
// Types
// ============================================================================

export type DrumCategory = 'kick' | 'snare' | 'hihat' | 'openhat' | 'perc' | 'clapsnap' | 'rim';

export interface DrumSample {
  /** Real filename or path - never rendered to the DOM. */
  id: string;
  category: DrumCategory;
  /** Playable URL (R2, local, blob, whatever your engine accepts). */
  url: string;
  /** Display name shown in the list — a random-looking but stable alias
   *  (kick_thunder). The host sets the SAME name the sequencer row shows, so a
   *  loaded sound reads identically in both places. */
  alias: string;
  /** Which kit/disk this sample belongs to (e.g. 'boombap' | 'trap'). Lets the
   *  browser hold several kits and filter the list by the active one. */
  kit?: string;
  /** MY DRUMS (kit 'user'): the user's own file — `alias` IS its filename,
   *  `userPath` the relative path inside the drums folder; `folder` = the
   *  relative path of the folder it sits in ('' = the folder itself). */
  userPath?: string;
  folder?: string;
}

/** One folder of the user's drums folder (MY DRUMS sidebar). */
export interface DrumFolderNode { name: string; rel: string; children?: DrumFolderNode[]; /** contents not listed yet (a linked folder) — onExpandFolder lists it */ lazy?: boolean }

export interface DrumBrowserProps {
  open: boolean;
  initialCategory: DrumCategory;
  /** All samples across every kit; the browser filters by folder + active kit. */
  samples: DrumSample[];
  /** Currently-LOADED sample per folder/track ({ kit, id }) — drives the CURRENT
   *  flag and the initial highlight. Nothing here changes until the user LOADs. */
  current?: Partial<Record<DrumCategory, { kit: string; id: string } | null>>;
  themeColor: string;
  /** Preview a sample (one-shot). Does NOT change the live kit — audition only. */
  onPreviewPlay: (sample: DrumSample) => void;
  /** LOAD — commit the chosen sample onto its track (drops it into the sequencer). */
  onCommit: (sample: DrumSample) => void;
  /** CLOSE / Esc. Nothing is live until LOAD, so this is just "dismiss". */
  onCancel: () => void;
  /** Optional notify when the selected candidate changes (host need not act). */
  onAudition?: (sample: DrumSample) => void;
  /** ADD NEW — put the chosen sample on a NEW sequencer lane instead of
   *  replacing the sound on an existing one. Omit to hide the button (mobile,
   *  where the lane list is fixed). */
  onAddNew?: (sample: DrumSample) => void;
  /** Label for the primary action. The + button opens the browser in "add"
   *  mode, where replacing isn't what you came for. */
  commitLabel?: string;
  /** Kit/disk switcher shown by the FOLDERS label (e.g. Boom Bap / Trap).
   *  Switching is DISPLAY-ONLY — it changes which kit you browse; nothing loads
   *  until LOAD, so you can mix kits (boombap kick + trap snare). */
  kits?: ReadonlyArray<{ id: string; label: string }>;
  initialKit?: string;
  /** MY DRUMS: the user's drums folder as a tree (desktop app). When the 'user'
   *  kit is on screen the sidebar lists these folders instead of the kit
   *  categories and the list shows the files inside the chosen one. */
  userFolders?: DrumFolderNode[] | null;
  userDir?: string;
  userTruncated?: boolean;
  onOpenUserFolder?: () => void;
  /** A lazy (linked) folder was opened in the sidebar — list its contents. */
  onExpandFolder?: (rel: string) => void;
  /** ＋ ADD FOLDER: link a folder from the computer (lands in both browsers). */
  onAddFolder?: () => void;
}

// ============================================================================
// Component
// ============================================================================

const CATEGORIES: ReadonlyArray<{ key: DrumCategory; label: string }> = [
  { key: 'kick', label: 'KICK' },
  { key: 'snare', label: 'SNARE' },
  { key: 'hihat', label: 'HIHAT' },
  { key: 'openhat', label: 'OPEN HAT' },
  { key: 'perc', label: 'PERC' },
  // Folders with no default LANE: pick a sound here and ADD NEW puts it on its
  // own lane (with its own mixer strip). The five above stay the kit every
  // project is born with, so nothing saved changes shape.
  { key: 'clapsnap', label: 'CLAPS & SNAPS' },
  { key: 'rim', label: 'RIM' },
];

// Bottom action bar in cursor order (←/→ move between them, Enter activates).
const ACTIONS = ['load', 'preview', 'random', 'close'] as const;
const DB_LAYOUT_LS = 'terminator.drumbrowser.layout.v1';

export function DrumBrowser(props: DrumBrowserProps) {
  const {
    open,
    initialCategory,
    samples,
    current,
    themeColor,
    onPreviewPlay,
    onCommit,
    onCancel,
    onAudition,
    onAddNew,
    commitLabel,
    kits,
    initialKit,
    userFolders,
    userDir,
    userTruncated,
    onOpenUserFolder,
    onExpandFolder,
    onAddFolder,
  } = props;
  // MY DRUMS sidebar: folders from the Drums folder show fully (bounded); the
  // library's linked folders (`lib:…`) open one level at a time on click.
  const [openFolders, setOpenFolders] = useState<Set<string>>(() => new Set());
  // ── layout: the frame and the folder column are RESIZABLE (desktop), and
  // remembered. Phones keep the CSS defaults (the media query wins there).
  const [layout, setLayout] = useState<{ w: number; h: number; side: number } | null>(() => {
    try { const j = JSON.parse(localStorage.getItem(DB_LAYOUT_LS) || 'null'); if (j && typeof j.w === 'number') return j; } catch { /* */ }
    if (typeof window !== 'undefined' && window.innerWidth >= 1100) return { w: Math.min(1320, Math.round(window.innerWidth * 0.92)), h: Math.min(900, Math.round(window.innerHeight * 0.88)), side: 280 };
    return null;
  });
  useEffect(() => { if (layout) { try { localStorage.setItem(DB_LAYOUT_LS, JSON.stringify(layout)); } catch { /* */ } } }, [layout]);
  const dragRef = useRef<null | { kind: 'frame' | 'side'; x: number; y: number; w: number; h: number; side: number }>(null);
  const startDrag = (kind: 'frame' | 'side') => (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault(); e.stopPropagation();
    const cur = layout ?? { w: Math.min(900, window.innerWidth * 0.92), h: Math.min(620, window.innerHeight * 0.86), side: 200 };
    dragRef.current = { kind, x: e.clientX, y: e.clientY, ...cur };
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
  };
  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      const d = dragRef.current; if (!d) return;
      if (d.kind === 'frame') {
        // the frame is centred, so the corner moves twice as fast as the pointer
        setLayout({ w: Math.max(640, Math.min(window.innerWidth - 24, d.w + (e.clientX - d.x) * 2)), h: Math.max(420, Math.min(window.innerHeight - 24, d.h + (e.clientY - d.y) * 2)), side: d.side });
      } else {
        setLayout({ w: d.w, h: d.h, side: Math.max(160, Math.min(Math.round(d.w * 0.6), d.side + (e.clientX - d.x))) });
      }
    };
    const onUp = () => { dragRef.current = null; };
    window.addEventListener('pointermove', onMove); window.addEventListener('pointerup', onUp);
    return () => { window.removeEventListener('pointermove', onMove); window.removeEventListener('pointerup', onUp); };
  }, []);
  const frameStyle = layout ? ({ '--db-w': `${layout.w}px`, '--db-h': `${layout.h}px`, '--db-side': `${layout.side}px` } as CSSProperties) : undefined;

  const [category, setCategory] = useState<DrumCategory>(initialCategory);
  // The kit/disk being BROWSED — display-only, independent of what's loaded.
  const [displayKit, setDisplayKit] = useState<string | undefined>(initialKit ?? kits?.[0]?.id);
  // MY DRUMS: which folder (relative path, '' = the drums folder itself).
  const [userFolder, setUserFolder] = useState<string>('');
  const isUserKit = displayKit === 'user';
  const [selectedId, setSelectedId] = useState<string | null>(
    () => current?.[initialCategory]?.id ?? null,
  );
  const [previewOn, setPreviewOn] = useState(true);
  const [flash, setFlash] = useState(false); // brief "LOADED" pulse after a commit
  // Which pane the arrow keys drive: the kit toggle, the folder column, the
  // sample list, or the bottom action bar (kits→folders→actions stack down the
  // left column; the list is the right column).
  const [focus, setFocus] = useState<'kits' | 'folders' | 'list' | 'actions'>('list');
  const [actionIndex, setActionIndex] = useState(0); // highlighted button in the actions zone
  const listRef = useRef<HTMLDivElement>(null);
  const rowRefs = useRef<Map<string, HTMLButtonElement>>(new Map());
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (flashTimer.current) clearTimeout(flashTimer.current); }, []);

  // The browser is mounted fresh on each open (the host conditionally renders
  // it), so the useState initialisers above already seed category / kit /
  // selection — no open-reset effect needed.

  // Currently-LOADED sample for the folder on screen (drives the CURRENT flag).
  const curForFolder = current?.[category] ?? null;

  // Filter to the active folder AND the kit being browsed.
  const inCategory = useMemo(
    () => isUserKit
      ? samples.filter((s) => s.kit === 'user' && (s.folder ?? '') === userFolder)
      : samples.filter((s) => s.category === category && (s.kit == null || s.kit === displayKit)),
    [samples, category, displayKit, isUserKit, userFolder],
  );

  // MY DRUMS folder counts — one pass, not a filter per sidebar row.
  const countByFolder = useMemo(() => {
    const m = new Map<string, number>();
    for (const s of samples) if (s.kit === 'user') { const f = s.folder ?? ''; m.set(f, (m.get(f) ?? 0) + 1); }
    return m;
  }, [samples]);
  // Lookup helpers.
  const selectedSample = useMemo(
    () => inCategory.find((s) => s.id === selectedId) ?? null,
    [inCategory, selectedId]
  );

  // ---- Actions ----------------------------------------------------------

  const audition = useCallback(
    (s: DrumSample) => {
      setSelectedId(s.id);
      // PREVIEW is the master switch: it gates BOTH the one-shot AND the
      // temporary live load into the sequence. Off = highlight only (you audition
      // nothing and load blind — no sound, no temp swap).
      if (previewOn) {
        onAudition?.(s);    // temp-load into the running sequence (hear in context)
        onPreviewPlay(s);   // one-shot so you hear it on its own
      }
      // Scroll into view if outside viewport.
      requestAnimationFrame(() => {
        const el = rowRefs.current.get(s.id);
        if (el) el.scrollIntoView({ block: 'nearest' });
      });
    },
    [onAudition, onPreviewPlay, previewOn]
  );

  // ↑/↓ step the highlight to the next sample and audition it. audition() gates
  // the actual sound + temp-load on PREVIEW, so with preview OFF this is just a
  // silent highlight move.
  const step = useCallback((dir: 1 | -1) => {
    if (inCategory.length === 0) return;
    const idx = selectedId ? inCategory.findIndex((s) => s.id === selectedId) : -1;
    const nextIdx = idx < 0
      ? (dir === 1 ? 0 : inCategory.length - 1)
      : (idx + dir + inCategory.length) % inCategory.length;
    audition(inCategory[nextIdx]);
  }, [inCategory, selectedId, audition]);

  // ←/→ on the kit toggle switch genre LIVE (clamped, no wrap). No Enter needed —
  // highlighting a kit IS selecting it; you just move back down into the folders.
  const switchKit = useCallback((dir: 1 | -1) => {
    if (!kits || kits.length === 0) return;
    const i = Math.max(0, kits.findIndex((k) => k.id === displayKit));
    const ni = Math.min(kits.length - 1, Math.max(0, i + dir));
    setDisplayKit(kits[ni].id);
  }, [kits, displayKit]);

  const commit = useCallback(() => {
    if (!selectedSample) return;
    onCommit(selectedSample);
    // Stay open so you can keep loading other tracks/kits; flash for feedback.
    setFlash(true);
    if (flashTimer.current) clearTimeout(flashTimer.current);
    flashTimer.current = setTimeout(() => setFlash(false), 850);
  }, [selectedSample, onCommit]);

  const addNew = useCallback(() => {
    if (!selectedSample || !onAddNew) return;
    onAddNew(selectedSample);
    // Same flash as LOAD, so adding several sounds in a row reads the same way.
    setFlash(true);
    if (flashTimer.current) clearTimeout(flashTimer.current);
    flashTimer.current = setTimeout(() => setFlash(false), 850);
  }, [selectedSample, onAddNew]);

  const cancel = useCallback(() => {
    onCancel();
  }, [onCancel]);

  const randomize = useCallback(() => {
    if (inCategory.length === 0) return;
    // Avoid picking the same one twice in a row when possible.
    let pick = inCategory[Math.floor(Math.random() * inCategory.length)];
    if (inCategory.length > 1 && pick.id === selectedId) {
      pick = inCategory[(inCategory.indexOf(pick) + 1) % inCategory.length];
    }
    audition(pick);
  }, [inCategory, selectedId, audition]);

  // ---- Keyboard ---------------------------------------------------------

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      // Ignore when typing in inputs (defensive - modal owns focus, but still).
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return;

      // The host (chopper) binds pad/chop triggers on Digit1-9, R, P, arrows
      // via BUBBLE-phase window listeners. We listen in CAPTURE phase and
      // stopPropagation on every key we own, so browsing the kit never also
      // triggers a pad or a transport shortcut underneath the modal.
      const handled = () => { e.preventDefault(); e.stopPropagation(); };

      if (e.key === 'Escape') {
        handled();
        cancel();
        return;
      }
      if (e.key === 'Enter') {
        handled();
        if (focus === 'actions') {
          const a = ACTIONS[actionIndex];
          if (a === 'load') commit();
          else if (a === 'preview') setPreviewOn((v) => !v);
          else if (a === 'random') randomize();
          else cancel();
        } else {
          commit(); // Enter elsewhere = quick LOAD
        }
        return;
      }
      // Arrow-key cursor: ↑/↓ move within the focused pane; → triggers a sound
      // (or enters the list from the folders); ← jumps the cursor to the folders.
      const hasKits = !!kits && kits.length > 1;
      if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        handled();
        const dir = e.key === 'ArrowDown' ? 1 : -1;
        if (focus === 'list') {
          step(dir);
        } else if (focus === 'folders') {
          const i = Math.max(0, CATEGORIES.findIndex((c) => c.key === category));
          if (dir === -1 && i === 0) {
            if (hasKits) setFocus('kits'); // ↑ past the top folder → the kit toggle
          } else if (dir === 1 && i === CATEGORIES.length - 1) {
            setFocus('actions'); setActionIndex(0); // down past last folder -> action bar
          } else {
            setCategory(CATEGORIES[i + dir].key);
          }
        } else if (focus === 'kits') {
          if (dir === 1) setFocus('folders'); // down drops into the folders
        } else { // focus === 'actions'
          if (dir === -1) setFocus('folders'); // up goes back into the folders
        }
        return;
      }
      if (e.key === 'ArrowLeft') {
        handled();
        if (focus === 'kits') switchKit(-1);       // pick the left kit (live)
        else if (focus === 'actions') setActionIndex((i) => Math.max(0, i - 1));
        else if (focus === 'list') setFocus('folders'); // cursor → folder column
        return;
      }
      if (e.key === 'ArrowRight') {
        handled();
        if (focus === 'kits') {
          switchKit(1);                            // pick the right kit (live)
        } else if (focus === 'actions') {
          setActionIndex((i) => Math.min(ACTIONS.length - 1, i + 1));
        } else if (focus === 'folders') {
          setFocus('list'); // step into the list, auditioning the landing sample
          const target = inCategory.find((s) => s.id === selectedId) ?? inCategory[0];
          if (target) audition(target);
        } else if (selectedSample) {
          audition(selectedSample); // re-trigger the highlighted sample
        }
        return;
      }
      if (e.key.toLowerCase() === 'r') {
        handled();
        randomize();
        return;
      }
      if (e.key.toLowerCase() === 'p') {
        handled();
        setPreviewOn((v) => !v);
        return;
      }
      // 1-5 switch folders
      const n = parseInt(e.key, 10);
      if (n >= 1 && n <= CATEGORIES.length) {
        handled();
        setCategory(CATEGORIES[n - 1].key);
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [open, focus, category, inCategory, selectedId, selectedSample, audition, step, switchKit, commit, cancel, randomize, actionIndex, kits]);

  if (!open) return null;

  // ---- Render -----------------------------------------------------------

  // One CSS var feeds the entire skin. color-mix derives everything else.
  const skinStyle = {
    ['--phosphor' as never]: themeColor,
  } as CSSProperties;

  return (
    <div
      className="db-overlay"
      style={skinStyle}
      role="dialog"
      aria-modal="true"
      // Click the dimmed backdrop (outside the frame) to close — same as CLOSE/Esc.
      onMouseDown={(e) => { if (e.target === e.currentTarget) cancel(); }}
    >
      <DrumBrowserStyles />

      <div className="db-frame" style={frameStyle}>
        {/* Header */}
        <div className="db-header">
          <div className="db-title">DRUM BROWSER</div>
          <div className="db-disk">
            Disk: {kits?.find((k) => k.id === displayKit)?.label ?? 'TERMINATOR_R2'}
          </div>
        </div>

        {/* Body: left folders, right list */}
        <div className="db-body">
          <div className="db-splitter" onPointerDown={startDrag('side')} title="Drag to resize the folder column" />
          <aside className={`db-sidebar ${focus === 'folders' ? 'is-focused' : ''}`}>
            <div className="db-sidebar-label">FOLDERS</div>
            {kits && kits.length > 1 && (
              <div className={`db-kits ${focus === 'kits' ? 'is-focused' : ''}`} role="tablist" aria-label="Drum kit">
                {kits.map((k) => (
                  <button
                    key={k.id}
                    className={`db-kit ${k.id === displayKit ? 'is-active' : ''}`}
                    onClick={() => { setFocus('kits'); setDisplayKit(k.id); }}
                    type="button"
                    role="tab"
                    aria-selected={k.id === displayKit}
                    title={k.id === 'user' ? 'MY DRUMS — your own one-shots from the Drums folder in your Sample Library, plus USER SAMPLES and every linked folder from the sample browser' : `Browse the ${k.label} kit`}
                  >
                    {k.label}
                  </button>
                ))}
              </div>
            )}
            {isUserKit && (() => {
              // MY DRUMS — the folder tree (all levels shown, indented). The
              // drums folder itself is the first row.
              const rows: Array<{ rel: string; name: string; depth: number; lib: boolean; open: boolean; lazy: boolean; hasKids: boolean }> = [{ rel: '', name: 'MY DRUMS', depth: 0, lib: false, open: true, lazy: false, hasKids: false }];
              const walk = (nodes: DrumFolderNode[] | undefined, depth: number) => {
                for (const n of nodes ?? []) {
                  const lib = n.rel.startsWith('lib:');
                  const open = lib ? openFolders.has(n.rel) : true;
                  rows.push({ rel: n.rel, name: n.name, depth, lib, open, lazy: !!n.lazy, hasKids: !!n.lazy || !!(n.children && n.children.length) });
                  if (open) walk(n.children, depth + 1);
                }
              };
              walk(userFolders ?? undefined, 1);
              return (<>
                {rows.map(r => {
                  const isActive = r.rel === userFolder;
                  return (
                    <button key={`u:${r.rel}`} className={`db-folder ${isActive ? 'is-active' : ''}`}
                      style={{ paddingLeft: 10 + r.depth * 12 }}
                      onClick={() => {
                        setFocus('folders'); setUserFolder(r.rel);
                        if (r.lib) {
                          // library folders open / close on click; a lazy one is listed the first time
                          setOpenFolders(o => { const n = new Set(o); if (n.has(r.rel)) n.delete(r.rel); else n.add(r.rel); return n; });
                          if (r.lazy && !r.open) onExpandFolder?.(r.rel);
                        }
                      }} type="button"
                      title={r.rel.startsWith('lib:') ? (r.depth === 0 ? `${r.name} — from the sample browser's library (USER SAMPLES or a linked folder); drop one-shots there and they show up here too` : `Folder ${r.name} inside ${r.rel.startsWith('lib:user') ? 'USER SAMPLES' : 'a linked folder'} from the sample browser`) : r.rel ? `Folder ${r.rel} inside your drums folder` : (userDir ? `Your drums folder — ${userDir}` : 'Your drums folder')}>
                      <span className="db-folder-icon" aria-hidden>{r.lib && r.hasKids ? (r.open ? '▾' : '▸') : isActive ? '▶' : '▷'}</span>
                      <span className="db-folder-label">{r.name}</span>
                      <span className="db-folder-count">{r.lazy ? '…' : (countByFolder.get(r.rel) ?? 0)}</span>
                    </button>
                  );
                })}
                {onOpenUserFolder && (
                  <button className="db-folder db-folder--tool" type="button" onClick={onOpenUserFolder}
                    title="Open your drums folder in Finder / Explorer — drop your own one-shots (and sub-folders) in here; the browser lists them next time it opens">
                    <span className="db-folder-icon" aria-hidden>↗</span>
                    <span className="db-folder-label">OPEN FOLDER</span>
                  </button>
                )}
                {onAddFolder && (
                  <button className="db-folder db-folder--tool" type="button" onClick={onAddFolder}
                    title="Link a folder from your computer — it stays where it is and shows up here AND in the sample browser">
                    <span className="db-folder-icon" aria-hidden>＋</span>
                    <span className="db-folder-label">ADD FOLDER</span>
                  </button>
                )}
                {userTruncated && <div className="db-sidebar-label" title="The folder has more files than the browser lists (50,000) — split it into sub-folders">…TRUNCATED</div>}
              </>);
            })()}
            {!isUserKit && CATEGORIES.map((c, i) => {
              const isActive = c.key === category;
              const count = samples.filter(
                (s) => s.category === c.key && (s.kit == null || s.kit === displayKit),
              ).length;
              return (
                <button
                  key={c.key}
                  className={`db-folder ${isActive ? 'is-active' : ''}`}
                  onClick={() => { setFocus('folders'); setCategory(c.key); }}
                  type="button"
                  title={`${c.label} — ${count} sounds in this kit (key ${i + 1})`}
                >
                  <span className="db-folder-icon" aria-hidden>
                    {isActive ? '▶' : '▷'}
                  </span>
                  <span className="db-folder-label">{c.label}</span>
                  <span className="db-folder-count">{count}</span>
                  <span className="db-folder-hotkey" aria-hidden>{i + 1}</span>
                </button>
              );
            })}
            <div className="db-sidebar-foot">
              <div className="db-sidebar-foot-label">TYPE</div>
              <div className="db-sidebar-foot-value">SAMPLE</div>
            </div>
          </aside>

          <section className="db-main">
            <div className="db-loadline">
              <span className="db-loadline-key">Load:</span>
              <span className="db-loadline-value">
                {selectedSample ? selectedSample.alias : '—'}
              </span>
              {selectedSample && curForFolder && curForFolder.kit === displayKit
                && curForFolder.id === selectedSample.id && (
                <span className="db-loadline-tag">CURRENT</span>
              )}
            </div>

            <div className="db-list-wrap">
              <div className={`db-list ${focus === 'list' ? 'is-focused' : ''}`} ref={listRef}>
                {inCategory.length === 0 && (
                  <div className="db-empty">{isUserKit ? (userFolder ? '— NO SOUNDS IN THIS FOLDER —' : '— DROP YOUR OWN ONE-SHOTS IN THE DRUMS FOLDER (OPEN FOLDER) —') : '— EMPTY —'}</div>
                )}
                {inCategory.map((s) => {
                  const isSel = s.id === selectedId;
                  const isCurrent = !!curForFolder && curForFolder.kit === displayKit
                    && curForFolder.id === s.id;
                  return (
                    <button
                      key={s.id}
                      ref={(el) => {
                        if (el) rowRefs.current.set(s.id, el);
                        else rowRefs.current.delete(s.id);
                      }}
                      className={`db-row ${isSel ? 'is-selected' : ''}`}
                      onClick={() => { setFocus('list'); audition(s); }}
                      type="button"
                    >
                      <span className="db-row-icon" aria-hidden>{'♪'}</span>
                      <span className="db-row-name">{s.alias}</span>
                      {isCurrent && (
                        <span className="db-row-flag">{'✓'}</span>
                      )}
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="db-statusline">
              <span>View: ALL SAMPLES</span>
              <span>Samples: {inCategory.length}</span>
              <span>Preview: {previewOn ? 'ON' : 'OFF'}</span>
            </div>
          </section>
        </div>

        {/* Action bar */}
        <div className="db-actions">
          <button
            className={`db-btn db-btn--primary ${flash ? 'is-flash' : ''} ${focus === 'actions' && actionIndex === 0 ? 'is-cursor' : ''}`}
            onClick={() => { setFocus('actions'); setActionIndex(0); commit(); }}
            disabled={!selectedSample}
            type="button"
            title={commitLabel === 'REPLACE' ? 'Put the highlighted sound on the lane you came from, replacing what it played (Enter). Until you do, clicking sounds only auditions them' : 'Put the highlighted sound on the lane you opened the browser from (Enter). Until you LOAD, clicking sounds only auditions them — CLOSE puts the old sound back'}
          >
            {flash ? 'LOADED ✓' : (commitLabel ?? 'LOAD')}
          </button>
          {onAddNew && (
            <button
              className="db-btn"
              onClick={() => { setFocus('actions'); addNew(); }}
              disabled={!selectedSample}
              type="button"
              title="Add this sound as a NEW row in the drum sequencer, with its own mixer channel — instead of replacing an existing sound"
            >
              ＋ ADD NEW
            </button>
          )}
          <button
            className={`db-btn ${previewOn ? 'is-on' : ''} ${focus === 'actions' && actionIndex === 1 ? 'is-cursor' : ''}`}
            onClick={() => { setFocus('actions'); setActionIndex(1); setPreviewOn((v) => !v); }}
            type="button"
            aria-pressed={previewOn}
            title="PREVIEW on: clicking a sound (or stepping with ↑ ↓) plays it and puts it on the lane to try in the beat. Off: the list moves in silence, nothing changes until LOAD (key P)"
          >
            PREVIEW <span className="db-led" data-on={previewOn} />
          </button>
          <button
            className={`db-btn ${focus === 'actions' && actionIndex === 2 ? 'is-cursor' : ''}`}
            onClick={() => { setFocus('actions'); setActionIndex(2); randomize(); }}
            type="button"
            title="Pick a random sound from this folder (key R)"
          >
            RANDOM
          </button>
          <button
            className={`db-btn ${focus === 'actions' && actionIndex === 3 ? 'is-cursor' : ''}`}
            onClick={() => { setFocus('actions'); setActionIndex(3); cancel(); }}
            type="button"
            title="Close the browser and put back whatever the lane played before — anything you only auditioned is dropped; a LOAD sticks (Esc)"
          >
            CLOSE
          </button>
        </div>
        <div className="db-resize" onPointerDown={startDrag('frame')} title="Drag to resize the browser (it remembers)" />
      </div>
    </div>
  );
}

// ============================================================================
// Styles - kept inline so the file drops in without touching the build config.
// ============================================================================

function DrumBrowserStyles() {
  return (
    <style>{`
      /* Pixel-ish bitmap font. Falls back gracefully without Google Fonts. */
      @import url('https://fonts.googleapis.com/css2?family=VT323&family=Share+Tech+Mono&display=swap');

      .db-overlay {
        position: fixed;
        inset: 0;
        z-index: 9999;
        display: flex;
        align-items: center;
        justify-content: center;
        /* Dim the scene but stay translucent so the glass panel has something
           colourful to refract through its blur. */
        background: radial-gradient(ellipse at center,
          rgba(0,0,0,0.40) 0%,
          rgba(0,0,0,0.70) 100%);
        backdrop-filter: blur(7px) saturate(1.1);
        -webkit-backdrop-filter: blur(7px) saturate(1.1);
        font-family: 'VT323', 'Share Tech Mono', ui-monospace, monospace;
        color: var(--phosphor);
        animation: db-fade-in 220ms ease-out;
        /* Depth context so the panel can pop toward the viewer. */
        perspective: 1800px;
        /* iOS Safari: keep the panel clear of the notch/home indicator, and
           scroll instead of clipping if it's ever taller than the visible
           viewport (prevents the bottom of the popup being cut off). */
        padding: max(8px, env(safe-area-inset-top)) 8px max(8px, env(safe-area-inset-bottom));
        box-sizing: border-box;
        overflow: auto;
      }

      @keyframes db-fade-in {
        from { opacity: 0; }
        to   { opacity: 1; }
      }

      /* The "device" frame — Apple-style LIQUID GLASS:
         frosted translucent material (blurs the scene behind), a phosphor-tinted
         wash, a bright specular rim, a layered elevation shadow + phosphor halo
         so it floats, and a barely-there scanline texture so it still reads
         "Terminator". */
      .db-frame {
        position: relative;
        /* desktop: the remembered, resizable size (--db-w/--db-h); otherwise the defaults */
        width: var(--db-w, min(900px, 92vw));
        height: var(--db-h, min(620px, 86dvh)); /* dvh = visible viewport on iOS Safari (was 86vh → overflowed under the URL bar) */
        max-width: 96vw;
        max-height: 94dvh;
        flex: none;
        /* margin:auto (not just align/justify center) so that if the frame is
           ever taller than the overlay it can scroll to reveal its TOP edge on
           iOS Safari instead of clipping it. */
        margin: auto;
        display: flex;
        flex-direction: column;
        border-radius: 24px;
        background:
          /* top-left specular sheen */
          linear-gradient(135deg,
            color-mix(in srgb, var(--phosphor) 16%, rgba(255,255,255,0.12)) 0%,
            transparent 38%),
          /* whisper-faint scanline texture */
          repeating-linear-gradient(to bottom,
            transparent 0px, transparent 2px,
            rgba(0,0,0,0.045) 3px, rgba(0,0,0,0.045) 3px),
          /* phosphor-tinted frosted body */
          linear-gradient(to bottom,
            color-mix(in srgb, var(--phosphor) 12%, rgba(22,24,28,0.55)),
            color-mix(in srgb, var(--phosphor) 6%, rgba(8,9,11,0.62)));
        backdrop-filter: blur(26px) saturate(190%) brightness(1.06);
        -webkit-backdrop-filter: blur(26px) saturate(190%) brightness(1.06);
        border: 1px solid color-mix(in srgb, var(--phosphor) 28%, rgba(255,255,255,0.28));
        box-shadow:
          /* elevation — the panel floats well above the scene (the 3D pop) */
          0 40px 90px -24px rgba(0,0,0,0.80),
          0 16px 40px -16px rgba(0,0,0,0.58),
          /* phosphor halo */
          0 0 70px color-mix(in srgb, var(--phosphor) 20%, transparent),
          /* specular rim: bright top edge, soft inner glow, dark base thickness */
          inset 0 1px 0 rgba(255,255,255,0.55),
          inset 0 6px 22px rgba(255,255,255,0.10),
          inset 0 -2px 0 rgba(0,0,0,0.45),
          inset 0 -26px 44px -28px color-mix(in srgb, var(--phosphor) 32%, transparent);
        animation: db-glass-in 360ms cubic-bezier(0.18, 0.9, 0.22, 1.08);
        overflow: hidden;
      }

      /* Soft top-corner light bloom — kept gentle. The edge rim (border + inset
         highlights, below) does the heavy lifting of lifting the panel off the
         screen. */
      .db-frame::before {
        content: '';
        position: absolute;
        inset: 0;
        pointer-events: none;
        border-radius: inherit;
        background:
          radial-gradient(90% 60% at 16% -10%,
            rgba(255,255,255,0.10) 0%,
            rgba(255,255,255,0.03) 16%,
            transparent 42%);
        z-index: 2;
      }

      @keyframes db-glass-in {
        from { opacity: 0; transform: translateY(16px) scale(0.94); }
        to   { opacity: 1; transform: translateY(0) scale(1); }
      }

      /* Header */
      .db-header {
        display: flex;
        align-items: baseline;
        justify-content: space-between;
        padding: 14px 18px 10px;
        border-bottom: 1px solid color-mix(in srgb, var(--phosphor) 35%, #000);
        text-transform: uppercase;
        letter-spacing: 0.08em;
        position: relative;
        z-index: 4;
      }
      .db-title {
        font-size: 22px;
        text-shadow: 0 0 8px color-mix(in srgb, var(--phosphor) 60%, transparent);
      }
      .db-disk {
        font-size: 16px;
        opacity: 0.7;
      }

      /* Body */
      .db-body {
        flex: 1;
        display: grid;
        grid-template-columns: var(--db-side, 200px) minmax(0, 1fr);
        min-height: 0;
        position: relative;
        z-index: 4;
      }

      /* Sidebar */
      .db-sidebar {
        border-right: 1px solid color-mix(in srgb, var(--phosphor) 35%, #000);
        padding: 12px 8px;
        display: flex;
        flex-direction: column;
        gap: 2px;
        min-height: 0;
        min-width: 0;
        overflow-y: auto;   /* long folder lists scroll inside the column — never under the buttons */
        overflow-x: hidden;
        overscroll-behavior: contain;
      }
      /* drag handles: the folder-column edge and the frame's corner */
      .db-splitter {
        position: absolute; top: 0; bottom: 0; left: calc(var(--db-side, 200px) - 4px); width: 8px;
        cursor: col-resize; z-index: 6;
      }
      .db-splitter:hover { background: color-mix(in srgb, var(--phosphor) 25%, transparent); }
      .db-resize {
        position: absolute; right: 6px; bottom: 6px; width: 18px; height: 18px;
        cursor: nwse-resize; z-index: 8; opacity: 0.55;
        background: linear-gradient(135deg, transparent 50%, color-mix(in srgb, var(--phosphor) 70%, #fff) 50%, color-mix(in srgb, var(--phosphor) 70%, #fff) 58%, transparent 58%, transparent 72%, color-mix(in srgb, var(--phosphor) 70%, #fff) 72%, color-mix(in srgb, var(--phosphor) 70%, #fff) 80%, transparent 80%);
      }
      .db-resize:hover { opacity: 1; }
      @media (hover: none) { .db-splitter, .db-resize { display: none; } }
      .db-sidebar-label {
        font-size: 14px;
        opacity: 0.55;
        padding: 0 10px 8px;
        letter-spacing: 0.12em;
        text-transform: uppercase;
      }
      /* Kit/disk switcher (Boom Bap / Trap) — a glass segmented control that
         sits right under the FOLDERS label. */
      .db-kits {
        display: flex;
        gap: 4px;
        margin: 0 8px 10px;
      }
      .db-kit {
        all: unset;
        flex: 1;
        text-align: center;
        cursor: pointer;
        font-size: 11px;
        letter-spacing: 0.05em;
        padding: 5px 4px;
        border: 1px solid color-mix(in srgb, var(--phosphor) 30%, transparent);
        border-radius: 8px;
        color: color-mix(in srgb, var(--phosphor) 72%, #888);
        background: rgba(255,255,255,0.03);
        box-shadow: inset 0 1px 0 rgba(255,255,255,0.12);
        transition: background 120ms, color 120ms, box-shadow 120ms;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .db-kit:hover {
        color: var(--phosphor);
        background: color-mix(in srgb, var(--phosphor) 10%, transparent);
      }
      .db-kit.is-active {
        color: #000;
        background: var(--phosphor);
        border-color: var(--phosphor);
        box-shadow: 0 0 10px color-mix(in srgb, var(--phosphor) 45%, transparent);
      }
      .db-folder {
        all: unset;
        cursor: pointer;
        display: grid;
        grid-template-columns: 18px minmax(0, 1fr) auto 22px;
        min-width: 0;
        align-items: center;
        gap: 8px;
        padding: 7px 10px;
        font-size: 18px;
        color: color-mix(in srgb, var(--phosphor) 72%, #888);
        border: 1px solid transparent;
        transition: background 120ms, color 120ms;
        position: relative;
      }
      .db-folder:hover {
        color: var(--phosphor);
        background: color-mix(in srgb, var(--phosphor) 8%, transparent);
      }
      .db-folder.is-active {
        color: #000;
        background: var(--phosphor);
        text-shadow: none;
      }
      .db-folder-icon {
        font-size: 14px;
        opacity: 0.9;
      }
      .db-folder-label {
        letter-spacing: 0.06em;
        white-space: nowrap;       /* one line per folder — the full name is in the tooltip */
        overflow: hidden;
        text-overflow: ellipsis;
        min-width: 0;
      }
      .db-folder--tool { opacity: 0.8; margin-top: 4px; }
      .db-folder-count {
        font-size: 13px;
        opacity: 0.55;
      }
      .db-folder.is-active .db-folder-count {
        opacity: 0.7;
        color: #000;
      }
      .db-folder-hotkey {
        font-size: 11px;
        opacity: 0.4;
        text-align: right;
      }
      .db-folder.is-active .db-folder-hotkey {
        color: #000;
        opacity: 0.5;
      }
      .db-sidebar-foot {
        margin-top: auto;
        padding: 10px;
        border-top: 1px dashed color-mix(in srgb, var(--phosphor) 25%, #000);
        font-size: 14px;
        opacity: 0.7;
      }
      .db-sidebar-foot-label {
        font-size: 12px;
        opacity: 0.55;
        letter-spacing: 0.12em;
      }
      .db-sidebar-foot-value {
        font-size: 16px;
        margin-top: 2px;
      }

      /* Main pane */
      .db-main {
        display: flex;
        flex-direction: column;
        min-height: 0;
        min-width: 0;
      }

      .db-loadline {
        display: flex;
        align-items: center;
        gap: 10px;
        padding: 10px 16px;
        font-size: 18px;
        border-bottom: 1px solid color-mix(in srgb, var(--phosphor) 25%, #000);
        background: color-mix(in srgb, var(--phosphor) 4%, transparent);
      }
      .db-loadline-key { opacity: 0.55; }
      .db-loadline-value {
        text-shadow: 0 0 6px color-mix(in srgb, var(--phosphor) 50%, transparent);
        letter-spacing: 0.04em;
      }
      .db-loadline-tag {
        margin-left: auto;
        font-size: 12px;
        padding: 2px 6px;
        border: 1px solid var(--phosphor);
        color: var(--phosphor);
        letter-spacing: 0.1em;
        opacity: 0.85;
      }

      .db-list-wrap {
        flex: 1;
        min-height: 0;
        padding: 8px 8px 0;
      }
      .db-list {
        height: 100%;
        overflow-y: auto;
        padding-right: 4px;
        scrollbar-width: thin;
        scrollbar-color: color-mix(in srgb, var(--phosphor) 45%, #000) transparent;
      }
      .db-list::-webkit-scrollbar { width: 10px; }
      .db-list::-webkit-scrollbar-track { background: transparent; }
      .db-list::-webkit-scrollbar-thumb {
        background: color-mix(in srgb, var(--phosphor) 35%, #000);
        border: 2px solid transparent;
        background-clip: padding-box;
      }

      .db-empty {
        padding: 40px 16px;
        text-align: center;
        opacity: 0.45;
        font-size: 16px;
        letter-spacing: 0.1em;
      }

      .db-row {
        all: unset;
        display: grid;
        grid-template-columns: 22px 1fr auto;
        align-items: center;
        gap: 10px;
        padding: 5px 12px;
        font-size: 18px;
        cursor: pointer;
        color: color-mix(in srgb, var(--phosphor) 75%, #777);
        border: 1px solid transparent;
        transition: background 80ms, color 80ms;
      }
      .db-row:hover {
        color: var(--phosphor);
        background: color-mix(in srgb, var(--phosphor) 6%, transparent);
      }
      .db-row.is-selected {
        background: var(--phosphor);
        color: #000;
        text-shadow: none;
      }
      .db-row-icon { opacity: 0.7; font-size: 14px; }
      .db-row.is-selected .db-row-icon { color: #000; opacity: 1; }
      .db-row-name { letter-spacing: 0.04em; }
      .db-row-flag {
        font-size: 10px;
        color: var(--phosphor);
        opacity: 0.85;
      }
      .db-row.is-selected .db-row-flag { color: #000; }

      /* Keyboard cursor: the focused pane's active item gets a phosphor glow so
         it's obvious whether the arrows are driving the FOLDERS or the LIST. */
      .db-sidebar.is-focused .db-folder.is-active,
      .db-list.is-focused .db-row.is-selected,
      .db-kits.is-focused .db-kit.is-active {
        box-shadow: 0 0 11px 1px color-mix(in srgb, var(--phosphor) 78%, transparent);
      }
      /* Keyboard cursor on the action bar (LOAD / PREVIEW / RANDOM / CLOSE). */
      .db-btn.is-cursor {
        color: var(--phosphor);
        box-shadow: inset 0 0 0 2px var(--phosphor),
          0 0 12px color-mix(in srgb, var(--phosphor) 50%, transparent);
      }

      .db-statusline {
        display: flex;
        gap: 24px;
        padding: 8px 16px;
        font-size: 14px;
        border-top: 1px solid color-mix(in srgb, var(--phosphor) 25%, #000);
        opacity: 0.7;
        letter-spacing: 0.05em;
      }

      /* Action bar — a translucent glass shelf with a bright top seam. */
      .db-actions {
        display: flex;
        gap: 1px;
        background: rgba(0,0,0,0.18);
        border-top: 1px solid color-mix(in srgb, var(--phosphor) 35%, rgba(255,255,255,0.20));
        box-shadow: inset 0 1px 0 rgba(255,255,255,0.16);
        position: relative;
        z-index: 4;
      }
      .db-btn {
        all: unset;
        flex: 1;
        text-align: center;
        padding: 13px 8px;
        font-size: 18px;
        letter-spacing: 0.14em;
        cursor: pointer;
        background: rgba(255,255,255,0.03);
        color: color-mix(in srgb, var(--phosphor) 80%, #cfcfcf);
        text-transform: uppercase;
        transition: background 140ms, color 140ms;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        gap: 8px;
      }
      .db-btn:hover {
        background: color-mix(in srgb, var(--phosphor) 16%, rgba(255,255,255,0.04));
        color: var(--phosphor);
      }
      .db-btn:active {
        background: var(--phosphor);
        color: #000;
      }
      .db-btn:disabled {
        opacity: 0.35;
        cursor: not-allowed;
      }
      .db-btn--primary {
        color: var(--phosphor);
        text-shadow: 0 0 8px color-mix(in srgb, var(--phosphor) 60%, transparent);
      }
      .db-btn--primary:hover {
        background: var(--phosphor);
        color: #000;
        text-shadow: none;
      }
      /* Brief confirmation pulse when a sample is LOADed (the browser stays open
         so you can keep loading other tracks/kits). */
      .db-btn--primary.is-flash {
        background: var(--phosphor);
        color: #000;
        text-shadow: none;
        box-shadow: inset 0 0 0 1px #000, 0 0 18px color-mix(in srgb, var(--phosphor) 60%, transparent);
      }
      .db-btn.is-on {
        color: var(--phosphor);
      }
      .db-led {
        display: inline-block;
        width: 8px;
        height: 8px;
        border-radius: 50%;
        background: #222;
        box-shadow: inset 0 0 2px rgba(0,0,0,0.8);
      }
      .db-led[data-on="true"] {
        background: var(--phosphor);
        box-shadow:
          0 0 6px var(--phosphor),
          0 0 12px color-mix(in srgb, var(--phosphor) 50%, transparent);
      }

      /* Tablet / narrower */
      @media (max-width: 720px) {
        .db-frame { width: 96vw; height: 92dvh; }
        .db-body { grid-template-columns: 140px 1fr; }
        .db-folder { font-size: 16px; padding: 6px 8px; }
        .db-folder-hotkey { display: none; }
        .db-row { font-size: 16px; }
        .db-title { font-size: 18px; }
        .db-disk { font-size: 13px; }
        .db-btn { font-size: 15px; letter-spacing: 0.1em; padding: 11px 4px; }
      }

      /* ── Palette match (mobile-only) ─────────────────────────────────────
         body[data-hw-palette] is set by HardwareView (mobile) when a palette is
         active, alongside the 8 --hw-* vars mirrored onto <body> — which is how
         this PORTALED-to-body browser receives them. Desktop ChopperView and
         palette-off mobile never set the marker, so the phosphor look above is
         byte-identical there (no fallback drift — these are separate, scoped
         override rules, not edits to the base). The phosphor monochrome is
         mapped to roles: surfaces→panel, text→text, muted→muted, lit/active→
         accent (with bg-coloured text on the accent fill so it stays legible on
         BOTH light and dark palettes), borders→border, glow dropped (flat). */
      body[data-hw-palette] .db-frame {
        background: var(--hw-panel);
        border-color: var(--hw-border);
        box-shadow: 0 40px 90px -24px rgba(0,0,0,0.5), inset 0 1px 0 rgba(255,255,255,0.06);
        color: var(--hw-text);
      }
      body[data-hw-palette] .db-frame::before { display: none; }
      body[data-hw-palette] .db-header,
      body[data-hw-palette] .db-sidebar { border-color: var(--hw-border); }
      body[data-hw-palette] .db-title { color: var(--hw-text); text-shadow: none; }
      body[data-hw-palette] .db-disk,
      body[data-hw-palette] .db-sidebar-label,
      body[data-hw-palette] .db-sidebar-foot,
      body[data-hw-palette] .db-sidebar-foot-label,
      body[data-hw-palette] .db-loadline-key,
      body[data-hw-palette] .db-statusline,
      body[data-hw-palette] .db-empty { color: var(--hw-muted); }
      body[data-hw-palette] .db-sidebar-foot { border-top-color: var(--hw-border); }
      body[data-hw-palette] .db-loadline { border-bottom-color: var(--hw-border); background: transparent; }
      body[data-hw-palette] .db-loadline-value { color: var(--hw-text); text-shadow: none; }
      body[data-hw-palette] .db-loadline-tag { border-color: var(--hw-accent); color: var(--hw-accent); }
      body[data-hw-palette] .db-folder,
      body[data-hw-palette] .db-row { color: var(--hw-text); }
      body[data-hw-palette] .db-kit { color: var(--hw-muted); border-color: var(--hw-border); background: transparent; box-shadow: none; }
      body[data-hw-palette] .db-kit:hover,
      body[data-hw-palette] .db-folder:hover,
      body[data-hw-palette] .db-row:hover,
      body[data-hw-palette] .db-btn:hover {
        color: var(--hw-accent);
        background: color-mix(in srgb, var(--hw-accent) 12%, transparent);
      }
      body[data-hw-palette] .db-kit.is-active,
      body[data-hw-palette] .db-folder.is-active,
      body[data-hw-palette] .db-row.is-selected,
      body[data-hw-palette] .db-btn:active,
      body[data-hw-palette] .db-btn--primary:hover,
      body[data-hw-palette] .db-btn--primary.is-flash {
        background: var(--hw-accent);
        border-color: var(--hw-accent);
        color: var(--hw-bg);
        text-shadow: none;
        box-shadow: none;
      }
      body[data-hw-palette] .db-folder.is-active .db-folder-count,
      body[data-hw-palette] .db-folder.is-active .db-folder-hotkey,
      body[data-hw-palette] .db-row.is-selected .db-row-icon,
      body[data-hw-palette] .db-row.is-selected .db-row-flag { color: var(--hw-bg); }
      body[data-hw-palette] .db-row-flag { color: var(--hw-accent); }
      body[data-hw-palette] .db-actions { border-top-color: var(--hw-border); box-shadow: none; background: transparent; }
      body[data-hw-palette] .db-btn { color: var(--hw-text); background: transparent; }
      body[data-hw-palette] .db-btn--primary,
      body[data-hw-palette] .db-btn.is-on { color: var(--hw-accent); text-shadow: none; }
      body[data-hw-palette] .db-led[data-on="true"] { background: var(--hw-accent); box-shadow: 0 0 6px var(--hw-accent); }
      body[data-hw-palette] .db-sidebar.is-focused .db-folder.is-active,
      body[data-hw-palette] .db-list.is-focused .db-row.is-selected,
      body[data-hw-palette] .db-kits.is-focused .db-kit.is-active { box-shadow: inset 0 0 0 2px var(--hw-bg); }
      body[data-hw-palette] .db-btn.is-cursor { color: var(--hw-accent); box-shadow: inset 0 0 0 2px var(--hw-accent); }
      body[data-hw-palette] .db-statusline { border-top-color: var(--hw-border); }
      body[data-hw-palette] .db-list { scrollbar-color: var(--hw-border) transparent; }
      body[data-hw-palette] .db-list::-webkit-scrollbar-thumb { background: var(--hw-border); }
    `}</style>
  );
}
