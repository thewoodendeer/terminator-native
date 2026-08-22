import { useEffect, useRef, useState, CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { useKeepOnScreen } from '../hooks/useKeepOnScreen';
import { ChopperState, Pad, ChopperEngine } from './ChopperEngine';
import { usePadActivity } from './usePadActivity';
// Copy/cut/paste payload + ops live in padClipboard so the grid's menu and the
// window keyboard run the SAME code on the SAME clipboard.
import { PadContent, firstEmptyAfter } from './padClipboard';
import { STEM_ORDER, stemBit, maskHas, toggleStem, MASK_ALL } from './stemMask';

const isWeb = (import.meta as any).env?.MODE === 'web';
const isWebUI = true;

interface Props {
  state: ChopperState;
  /** Free-tier lock: pads at/after this index are greyed + un-interactable
   *  (null = no lock). Enforcement is engine-side; this is the visual cue. */
  lockedFrom?: number | null;
  onTrigger: (padIdx: number, velocity?: number, eventTimestamp?: number) => void;
  onRelease: (padIdx: number) => void;
  onSelect: (padIdx: number) => void;
  /** Show this pad's own sample on the waveform (no assign mode). Right-click + clear-block use it. */
  onFocusPad?: (padIdx: number) => void;
  onClear: (padIdx: number) => void;
  onPitch: (padIdx: number, semitones: number) => void;
  onDropFile?: (padIdx: number, file: File) => void;
  onSwapSample?: (padIdx: number) => void;
  /** When false, PadGrid does NOT attach its own window keydown→pad handler —
   *  the parent owns the keyboard (web: ChopperView's always-on handler) so the
   *  keys fire from any section with no double-trigger. Default true (native). */
  captureKeyboard?: boolean;
  /** Controlled keyboard bank (web). When set, PadGrid shows this bank's labels/
   *  banner and the parent owns the −/= shift; when omitted, PadGrid keeps its
   *  own internal bank (native). */
  bank?: number;
  /** Chopper engine — enables the per-pad □ menu (Copy / Paste / Duplicate run
   *  directly against it). When omitted the □ menu button is hidden. */
  engine?: ChopperEngine;
  /** Move the pad's content to the first empty slot (parent-owned). */
  onMovePad?: (padIdx: number) => void;
  /** Ghost-drag drop: the dragged pad's whole BLOCK lands with its first pad
   *  on `to` (parent = engine.moveBlock: push-aside, singles swap). */
  onMoveTo?: (from: number, to: number) => void;
  /** Right-click menu → put a SOURCE onto this pad: paste a YouTube link,
   *  pick a file, or record into it. Parent-owned (they open the app's own
   *  prompt / file picker / RECORD SAMPLE panel aimed at the pad). */
  onImportLink?: (padIdx: number) => void;
  /** ⇣ LOAD LINK: read the clipboard and pull that link straight onto the pad (no prompt). */
  onLoadClipboardLink?: (padIdx: number) => void;
  onLoadFileInto?: (padIdx: number) => void;
  onRecordInto?: (padIdx: number) => void;
  /** MIXER ROUTING (desktop): the SAMPLE strips a pad can play through, the
   *  current strip per occupied pad, and the re-route action ('new' = a fresh
   *  strip; wholeBlock = every pad of the source's block). */
  mixerTracks?: Array<{ name: string; label: string; color: string }>;
  padRoutes?: Record<number, string>;
  onRoutePad?: (padIdx: number, route: string, wholeBlock: boolean) => void;
  /** MUTE GROUPS: the groups in play, each pad's group, and the assign action
   *  ('none' = polyphonic, 'new' = a fresh group; wholeBlock = the run). */
  chokeGroups?: Array<{ id: string; label: string }>;
  padChoke?: Record<number, string>;
  onChokePad?: (padIdx: number, group: string, wholeBlock: boolean) => void;
  /** Resample the pad's buffer onto the next empty slot (parent-owned). */
  onResamplePad?: (padIdx: number) => void;
  /** ↥ MAKE MAIN TRACK: a pad's own sample becomes the main track (the pad keeps it) — STEMS lives there. */
  onMakeMainTrack?: (padIdx: number) => void;
  /** DRUM PADS mode: pads 1..N are visually flagged as the N drum
   *  tracks. Triggering itself is handled by the parent (onTrigger routes them to
   *  the drum engine); this only drives the on-pad label + colour. */
  drumPadMode?: boolean;
  /** DRUM PADS mode: the lane names, pad i ↔ lane i (every lane, added ones too). */
  drumPadLabels?: string[];
  /** Flash a short status line in the parent's HUD (multi-pad actions). */
  onFlash?: (msg: string) => void;
  /** THE pad selection + clipboard, owned by the parent so the grid's menu and
   *  the window keyboard (⌘X/C/V, DELETE) act on the same one. */
  selection?: {
    selected: number[];
    toggle: (idx: number) => void;
    only: (idx: number) => void;
    clear: () => void;
    clipboard: PadContent[] | null;
  };
  /** Clipboard actions — the parent runs them so the flash message, the undo
   *  batching and the view's own bookkeeping stay in one place. The explicit
   *  pad list is what the MENU aims at (the selection, or just the pad whose
   *  menu is open); the keyboard calls the same actions with no argument and
   *  they fall back to the selection. */
  onCut?: (pads?: number[]) => void;
  onCopy?: (pads?: number[]) => void;
  onPaste?: (at?: number) => void;
  onDeletePads?: (pads?: number[]) => void;
  onDuplicatePads?: (pads?: number[]) => void;
}

/** Colour of a SOURCE (see ChopperEngine.padSourceKey): the main track wears
 *  the theme accent; every other source gets a stable hue from its id, so a
 *  block's pads and its waveform header share one colour. */
export function sourceColor(key: string | null): string {
  if (!key) return 'transparent';
  if (key === 'main') return 'var(--neon)';
  // User-made GROUPS ('grp:n', from Duplicate to new group / New group): walk
  // the wheel in golden-angle steps from a fixed start, so GROUP 2, 3, 4… are
  // each far from the last — lots of clearly different bars, in order.
  const g = /^grp:(\d+)$/.exec(key);
  if (g) { const n = Number(g[1]); return `hsl(${Math.round((20 + n * 137.508) % 360)} 90% 58%)`; }
  // FNV-1a, then a golden-ratio spread: near-identical ids ('src:a' / 'src:b')
  // land far apart on the wheel instead of one hue step from each other.
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) { h ^= key.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  h = Math.imul(h ^ (h >>> 15), 0x9E3779B1) >>> 0;
  const hue = Math.floor((h / 4294967296) * 360);
  return `hsl(${hue} 85% 60%)`;
}

const KEY_SEQUENCE = '1234567890qwertyuiopasdfghjklzxcvbnm';
const BANK_SIZE = KEY_SEQUENCE.length; // 36 keyboard slots per bank
const KEY_TO_SLOT: Record<string, number> = {};
for (let i = 0; i < KEY_SEQUENCE.length; i++) KEY_TO_SLOT[KEY_SEQUENCE[i]] = i;
const KEY_LABELS = KEY_SEQUENCE.toUpperCase().split('');

export function PadGrid({ state, lockedFrom = null, onTrigger, onRelease, onSelect, onFocusPad, onClear, onPitch, onDropFile, onSwapSample, captureKeyboard = true, bank: bankProp, engine, onMovePad, onResamplePad, onMakeMainTrack, onMoveTo, onImportLink, onLoadClipboardLink, onLoadFileInto, onRecordInto, mixerTracks, padRoutes, onRoutePad, chokeGroups, padChoke, onChokePad, drumPadMode = false, drumPadLabels, onFlash, selection, onCut, onCopy, onPaste, onDeletePads, onDuplicatePads }: Props) {
  const isLocked = (padIndex: number) => lockedFrom !== null && padIndex >= lockedFrom;
  const [internalBank, setInternalBank] = useState(0);
  const bank = bankProp ?? internalBank;   // controlled (web) or internal (native)
  const bankRef = useRef(0);
  bankRef.current = bank;

  // Clamp bank when the pad count shrinks (e.g. after RESET / DEL ALL)
  const padCount = state.pads.length;
  const maxBank = Math.max(0, Math.ceil(padCount / BANK_SIZE) - 1);
  useEffect(() => {
    if (bankProp == null && bank > maxBank) setInternalBank(maxBank);
  }, [bank, maxBank, bankProp]);

  useEffect(() => {
    if (!captureKeyboard) return;   // parent owns the keyboard (web)
    // Pad keys fire from ANY section — only a genuine text-entry element should
    // swallow them. Check document.activeElement (the focused element) rather
    // than e.target, and bail ONLY for <input> (range sliders excepted so a
    // focused fader doesn't eat pad keys), <textarea>, <select>, or any
    // contentEditable host. No section/focus checks beyond these.
    const isTyping = () => {
      const el = document.activeElement as HTMLElement | null;
      if (!el) return false;
      if (el instanceof HTMLInputElement) return el.type !== 'range';
      if (el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) return true;
      return el.isContentEditable === true;
    };
    const heldKeys = new Set<string>();
    const codeToKey = (e: KeyboardEvent): string => {
      if (e.code.startsWith('Digit')) return e.code.slice(5);
      if (e.code.startsWith('Key')) return e.code.slice(3).toLowerCase();
      return e.key.toLowerCase();
    };
    const onDown = (e: KeyboardEvent) => {
      // Browser/OS auto-repeat fires keydown at ~30Hz while a key is held.
      // The `heldKeys` Set used to guard this, but the effect re-runs on
      // every render (deps change as onTrigger/onRelease are recreated),
      // which wiped the Set between repeats. `e.repeat` is set by the
      // browser on every auto-repeat event and is stable regardless.
      if (e.repeat) return;
      if (isTyping() || e.metaKey || e.ctrlKey || e.altKey) return;

      // Bank shift: `-` previous 36, `=` next 36. Lets the 36-key layout
      // reach pads beyond slot 35.
      if (e.key === '-' || e.key === '=') {
        const cap = Math.max(0, Math.ceil(state.pads.length / BANK_SIZE) - 1);
        setInternalBank(b => Math.max(0, Math.min(cap, b + (e.key === '=' ? 1 : -1))));
        e.preventDefault();
        return;
      }

      const key = codeToKey(e);
      const slot = KEY_TO_SLOT[key];
      if (slot === undefined) return;
      // Don't gate on state.pads.length — the engine grows the pad array on
      // demand (via ensurePad / sliceAtCurrentPosition) so pressing an
      // unseen slot is how chops get dropped.
      const pad = bankRef.current * BANK_SIZE + slot;
      if (heldKeys.has(key)) return;
      heldKeys.add(key);
      e.preventDefault();
      // Pass the event's own timestamp (when the key physically fired) so the
      // engine can back-date live-record quantize past any handler lag.
      onTrigger(pad, 1, e.timeStamp);
    };
    const onUp = (e: KeyboardEvent) => {
      const key = codeToKey(e);
      const slot = KEY_TO_SLOT[key];
      if (slot === undefined) return;
      const pad = bankRef.current * BANK_SIZE + slot;
      heldKeys.delete(key);
      onRelease(pad);
    };
    const onBlur = () => heldKeys.clear();
    window.addEventListener('keydown', onDown);
    window.addEventListener('keyup', onUp);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('keydown', onDown);
      window.removeEventListener('keyup', onUp);
      window.removeEventListener('blur', onBlur);
    };
  }, [onTrigger, onRelease, captureKeyboard]);

  // Lit pads come off the engine's activity channel, not the ChopperState prop:
  // the parent no longer re-renders on a pad hit (that cost 12–46ms of main
  // thread per note and made MIDI feel late), so this is what keeps the LEDs
  // live. Falls back to the prop when no engine was passed.
  const activity = usePadActivity(engine);
  const activePadSet = new Set(activity?.activePads ?? state.activePads);
  // Detect phone-portrait once per render. On mobile we always show a fixed
  // 4x4 grid of 16 pads so the user has empty slots to tap-to-slice into,
  // even with only one chop loaded. Empty slots use placeholder Pad shapes.
  const isMobile = typeof window !== 'undefined'
    && window.matchMedia('(max-width: 720px) and (orientation: portrait)').matches;

  // ── Mobile pager ──────────────────────────────────────────────────────────
  // On phone we expose pages of 16 pads, swipeable left/right. Page count
  // grows automatically as the user fills pads: always show enough pages to
  // hold every existing pad, plus one trailing empty page so the user can
  // swipe forward and chop into fresh slots. Capped at 256 pads / 16 pages
  // because the engine's auto-slice caps there too.
  const MOBILE_PAGE_SIZE = 16;
  const MOBILE_MAX_PAGES = 16;
  const filledPages = Math.max(1, Math.ceil(padCount / MOBILE_PAGE_SIZE));
  const mobilePageCount = Math.min(MOBILE_MAX_PAGES, filledPages + (filledPages < MOBILE_MAX_PAGES ? 1 : 0));
  const pagerRef = useRef<HTMLDivElement>(null);
  const [mobilePage, setMobilePage] = useState(0);

  // Track scroll position → derive current page for the dot indicator. Native
  // scroll-snap handles the actual paging; this hook just mirrors state.
  useEffect(() => {
    if (!isMobile) return;
    const el = pagerRef.current;
    if (!el) return;
    const onScroll = () => {
      const idx = Math.round(el.scrollLeft / Math.max(1, el.clientWidth));
      setMobilePage(prev => prev !== idx ? idx : prev);
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, [isMobile, mobilePageCount]);

  // Which CHOP a pad holds — its number in time order (1 = the first slice of
  // the sample). Main-track pads count through state.chops; a pad source
  // counts through its own block's pieces. Shown small in the pad's top-left.
  /** ◁ / ▷ only when the pad DIFFERS from its source — a source reversed as a
   *  whole already says so on the REV button, so marking every one of its pads
   *  would be noise. */
  /** The pad's hover line: what it holds, its MUTE GROUP and its mixer STRIP
   *  (help-audit leftover: the hover named neither). */
  const hoverTitleFor = (idx: number): string | undefined => {
    const p = state.pads[idx];
    const meta = state.padBufferMeta[idx];
    const parts: string[] = [];
    if (meta) parts.push(meta.title || 'own sample');
    else if (p?.chopId != null) { const n = chopNoFor(idx); parts.push(n != null ? `chop ${n}` : 'chop'); }
    else return undefined;
    const g = padChoke?.[idx];
    if (g && g !== 'none') { const lbl = chokeGroups?.find(c => c.id === g)?.label ?? g; parts.push(`group ${lbl}`); }
    const r = padRoutes?.[idx];
    if (r) { const lbl = mixerTracks?.find(t => t.name === r)?.label ?? r; parts.push(`strip ${lbl}`); }
    return `PAD ${idx + 1} — ${parts.join(' · ')}`;
  };
  const revMarkFor = (idx: number): '◁' | '▷' | undefined => {
    if (!engine?.padReverseOverridden?.(idx)) return undefined;
    return engine.reversedFor(idx) ? '◁' : '▷';
  };
  const chopNoFor = (idx: number): number | null => {
    const p = state.pads[idx];
    if (engine && state.padBufferMeta[idx] !== undefined) {
      const pieces = engine.padSourceChops(idx);
      const k = pieces.findIndex(c => c.padIdx === idx);
      return k >= 0 ? k + 1 : null;
    }
    if (!p || p.chopId === null) return null;
    const k = state.chops.findIndex(c => c.id === p.chopId);
    return k >= 0 ? k + 1 : null;
  };
  const labelForPad = (padIndex: number): string => {
    const bankStart = bank * BANK_SIZE;
    const bankEnd = bankStart + BANK_SIZE;
    if (padIndex < bankStart || padIndex >= bankEnd) return '';
    return KEY_LABELS[padIndex - bankStart] ?? '';
  };

  // Build a Pad descriptor for any index, falling back to an empty placeholder
  // when the engine hasn't created that pad yet. The placeholder is enough for
  // tap-to-slice in chop mode — actual pad creation happens engine-side.
  const padAt = (idx: number): Pad => state.pads[idx] ?? {
    index: idx,
    chopId: null,
    mode: 'oneshot',
    color: '#1a3a2a',
    pitch: 0,
  };

  // ── Per-pad □ menu (Copy / Paste / Duplicate / Clear / Move / Resample) ──────
  // Ported from HardwareView's hardware pad menu. The open menu + clipboard live
  // here (PadGrid) so only ONE is open at a time across the whole grid; the
  // dropdown is rendered ONCE via a portal, fixed-positioned from the □ button's
  // rect so it never clips against the pad's (overflow:hidden) or the grid edges.
  // Copy/Paste/Duplicate are pure engine ops; Clear reuses onClear; Move/Resample
  // call the parent callbacks.
  const showMenu = !!engine;
  const [padMenu, setPadMenu] = useState<{ idx: number; rect: DOMRect } | null>(null);
  // "Mixer track ▸" sub-list open in the pad menu, and whether a pick applies
  // to the whole block. Reset when the menu closes.
  const [routeOpen, setRouteOpen] = useState(false);
  const [routeBlock, setRouteBlock] = useState(false);
  const [chokeOpen, setChokeOpen] = useState(false);
  const [groupOpen, setGroupOpen] = useState(false);
  const [stemsOpen, setStemsOpen] = useState(false);
  useEffect(() => { if (!padMenu) { setRouteOpen(false); setRouteBlock(false); setChokeOpen(false); setGroupOpen(false); setStemsOpen(false); } }, [padMenu]);
  // ── SHIFT multi-select ─────────────────────────────────────────────────────
  // Shift+press toggles a pad in/out of the selection WITHOUT playing it, and a
  // plain click on an EMPTY pad aims the paste there. The selection and the
  // clipboard are owned ABOVE the grid (ChopperView's usePadSelection) so the
  // menu here and the window keyboard (⌘X/C/V, DELETE) share one of each; two
  // copies would disagree. ESC clears (handled by the view).
  // A selected pad's menu drives the whole selection.
  // chopId 0 is a real chop (the first one) — `!!0` read it as empty and greyed
  // the menu's Resample/Duplicate on that pad.
  const isLoadedPad = (i: number) => state.pads[i]?.chopId != null || state.padBufferMeta[i] !== undefined;
  const selPads = selection?.selected ?? [];
  const selSet = new Set(selPads);
  const toggleSelect = (idx: number) => selection?.toggle(idx);
  const padClipboard = selection?.clipboard ?? null;

  // Close the open menu on Escape. ESC layering (menu closes, the pad
  // SELECTION survives) lives in ChopperView's Escape handler — it skips the
  // selection-clear while .pad-pop / .pad-move-mode is in the DOM, because
  // stopPropagation can't order two listeners on the same window target.
  useEffect(() => {
    if (!padMenu) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setPadMenu(null); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [padMenu]);

  // (Reading and writing pad CONTENT — and finding empty pads — lives in
  // padClipboard.ts: the parent runs those ops so the menu and the keyboard
  // share one clipboard, and there is ONE definition of "empty pad".)
  type PadMenuAction = 'play' | 'link' | 'cliplink' | 'makemain' | 'file' | 'record' | 'cut' | 'copy' | 'paste' | 'duplicate' | 'clear' | 'clearblock' | 'move' | 'moveto' | 'mode' | 'gate' | 'resample';
  const handlePadMenuAction = (idx: number, action: PadMenuAction) => {
    // A menu opened on a SELECTED pad drives the whole selection; on any other
    // pad it stays single-pad. Single-only actions (link/file/record/move/
    // resample) are hidden from the multi menu, so `idx` is safe for them.
    const targets = selSet.has(idx) && selPads.length > 1 ? selPads : [idx];
    const multi = targets.length > 1;
    // Play only the LOADED targets — triggering an empty pad while the sample
    // runs would CHOP at that moment (tap-to-slice), not audition.
    if (action === 'play') { const t = targets.filter(isLoadedPad); t.forEach(i => onTrigger(i, 1)); setTimeout(() => t.forEach(i => onRelease(i)), 120); }
    else if (action === 'link') onImportLink?.(idx);
    else if (action === 'cliplink') onLoadClipboardLink?.(idx);
    else if (action === 'file') onLoadFileInto?.(idx);
    else if (action === 'record') onRecordInto?.(idx);
    // LOOP / NOTE ON across many pads SET every target to the base pad's next
    // state (never per-pad toggle — mixed pads would just swap places). Base =
    // the clicked pad when it holds audio, else the selection's first loaded
    // pad — a menu opened on an empty AIM pad must not read state off nothing.
    // setPadsLoop/setPadsGate are one undo step + ONE emit for the whole set.
    else if (action === 'mode') {
      const base = isLoadedPad(idx) ? idx : targets.find(isLoadedPad) ?? idx;
      const on = (state.pads[base]?.mode ?? 'oneshot') !== 'loop';
      engine?.setPadsLoop(targets, on);
      if (multi) onFlash?.(`${targets.length} PADS → LOOP ${on ? 'ON' : 'OFF'}`);
    }
    else if (action === 'gate') {
      const base = isLoadedPad(idx) ? idx : targets.find(isLoadedPad) ?? idx;
      const on = !state.pads[base]?.gate;
      engine?.setPadsGate(targets, on);
      if (multi) onFlash?.(`${targets.length} PADS → NOTE ON ${on ? 'ON' : 'OFF'}`);
    }
    // CUT / COPY / PASTE / DUPLICATE / CLEAR all run in the PARENT (padClipboard
    // ops): same code, same clipboard and same undo batching as ⌘X/C/V, so the
    // menu and the keyboard can never drift. The menu first makes `targets` the
    // selection — clicking a pad's menu aims at that pad.
    else if (action === 'cut') onCut?.(targets);
    else if (action === 'copy') onCopy?.(targets);
    else if (action === 'paste') onPaste?.(idx);          // land where the menu was opened
    else if (action === 'duplicate') onDuplicatePads?.(targets);
    else if (action === 'clear') onDeletePads?.(targets);
    else if (action === 'clearblock') { engine?.clearBlock(idx); (onFocusPad ?? onSelect)(idx); }
    // MOVE = arm move mode: the next drag on any pad carries it (ghost) and
    // drops it on another pad — moved if that pad is empty, swapped if not.
    else if (action === 'move') { setMoveMode(true); }
    else if (action === 'moveto') onMovePad?.(idx);
    else if (action === 'resample') void onResamplePad?.(idx);
    else if (action === 'makemain') onMakeMainTrack?.(idx);
    setPadMenu(null);
  };

  // ── MOVE mode + ghost drag (Julienne-style) ───────────────────────────────
  // While move mode is on (⇄ MOVE toggle, the menu's MOVE, or Alt/Option held
  // on the press) a press on a loaded pad picks it up: a ghost of the pad
  // follows the pointer, the pad under it lights, release drops it there —
  // onMoveTo(from, to) → engine.movePad (empty target = move, loaded = swap).
  // The ghost's position and the hover ring are DOM writes per pointermove
  // (no re-render); React only renders the pickup and the drop.
  const [moveMode, setMoveMode] = useState(false);
  const [dragFrom, setDragFrom] = useState<number | null>(null);
  const dragFromRef = useRef<number | null>(null);
  // The BLOCK being carried ([lo, hi] of the dragged pad's source run) — the
  // whole block moves; the landing zone lights as many pads as the block is long.
  const dragBlockRef = useRef<[number, number] | null>(null);
  const [dragBlock, setDragBlock] = useState<[number, number] | null>(null);
  const ghostRef = useRef<HTMLDivElement>(null);
  const hoverRef = useRef<HTMLElement[]>([]);
  const clearHover = () => { for (const el of hoverRef.current) el.classList.remove('pad-drop-target'); hoverRef.current = []; };
  const padAtPoint = (x: number, y: number): HTMLElement | null =>
    (document.elementFromPoint(x, y)?.closest('[data-pad-idx]') as HTMLElement | null) ?? null;
  const gridRootRef = useRef<HTMLDivElement>(null);
  // PUSH PREVIEW: while the ghost hovers a target, the pads that would be
  // pushed aside slide (CSS transform, DOM-only) onto the pads they'd land on,
  // so you see the push before you drop. planMoveBlock is a dry run of the
  // real move; the transforms are cleared on hover change / drop / cancel.
  const previewRef = useRef<HTMLElement[]>([]);
  const clearPreview = () => {
    for (const el of previewRef.current) { el.style.transform = ''; el.classList.remove('pad-push-preview'); }
    previewRef.current = [];
  };
  const showPreview = (from: number, to: number) => {
    clearPreview();
    const plan = engine?.planMoveBlock(from, to);
    if (!plan) return;
    const root = gridRootRef.current ?? document;
    const blk = dragBlockRef.current;
    for (const [a, b] of plan.moves) {
      if (blk && a >= blk[0] && a <= blk[1]) continue; // the carried block rides in the ghost
      const src = root.querySelector(`[data-pad-idx="${a}"]`) as HTMLElement | null;
      const dst = root.querySelector(`[data-pad-idx="${b}"]`) as HTMLElement | null;
      if (!src || !dst) continue;
      const rs = src.getBoundingClientRect(), rd = dst.getBoundingClientRect();
      src.classList.add('pad-push-preview');
      src.style.transform = `translate(${rd.left - rs.left}px, ${rd.top - rs.top}px)`;
      previewRef.current.push(src);
    }
  };
  const trackGhost = (x: number, y: number) => {
    const g = ghostRef.current;
    if (g) g.style.transform = `translate(${x - g.offsetWidth / 2}px, ${y - g.offsetHeight / 2}px) scale(1.06)`;
    const el = padAtPoint(x, y);
    const over = el ? Number(el.dataset.padIdx) : NaN;
    if ((hoverRef.current[0] ?? null) === el) return;
    clearHover(); clearPreview();
    const blk = dragBlockRef.current;
    if (!el || !Number.isFinite(over) || (blk && over >= blk[0] && over <= blk[1])) return;
    const len = blk ? blk[1] - blk[0] + 1 : 1;
    const root = gridRootRef.current ?? document;
    for (let k = 0; k < len; k++) {
      const t = root.querySelector(`[data-pad-idx="${over + k}"]`) as HTMLElement | null;
      if (t) { t.classList.add('pad-drop-target'); hoverRef.current.push(t); }
    }
    if (dragFromRef.current !== null) showPreview(dragFromRef.current, over);
  };
  const endDrag = () => { clearHover(); clearPreview(); dragFromRef.current = null; dragBlockRef.current = null; setDragFrom(null); setDragBlock(null); };
  const pickUp = (idx: number, e: React.PointerEvent<HTMLElement>) => {
    dragFromRef.current = idx;
    const blk = engine?.blockRange(idx) ?? [idx, idx];
    dragBlockRef.current = blk;
    setDragBlock(blk);
    setDragFrom(idx);
    const r = e.currentTarget.getBoundingClientRect();
    const x = e.clientX, y = e.clientY;
    requestAnimationFrame(() => {
      const g = ghostRef.current; if (!g) return;
      g.style.width = `${r.width}px`; g.style.height = `${r.height}px`;
      trackGhost(x, y);
    });
  };
  useEffect(() => {
    if (dragFrom === null) return;
    const onMove = (e: PointerEvent) => trackGhost(e.clientX, e.clientY);
    const onUp = (e: PointerEvent) => {
      const el = padAtPoint(e.clientX, e.clientY);
      const to = el ? Number(el.dataset.padIdx) : NaN;
      const from = dragFromRef.current;
      if (from !== null && Number.isFinite(to) && to !== from) onMoveTo?.(from, to);
      endDrag();
    };
    const onCancel = () => endDrag();
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onCancel);
    return () => { window.removeEventListener('pointermove', onMove); window.removeEventListener('pointerup', onUp); window.removeEventListener('pointercancel', onCancel); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dragFrom]);
  // ESC leaves move mode (and drops nothing).
  useEffect(() => {
    if (!moveMode) return;
    // Leaving MOVE mode keeps the pad selection — ChopperView's ESC handler
    // sees .pad-move-mode in the DOM and skips its selection-clear.
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { endDrag(); setMoveMode(false); } };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [moveMode]);
  const dragGhost = dragFrom !== null ? createPortal(
    <div ref={ghostRef} className="pad-ghost" style={{ '--pad-color': state.pads[dragFrom]?.color, '--src-color': sourceColor(engine?.padSourceKey(dragFrom) ?? null) } as CSSProperties}>
      <span className="pad-ghost-num">
        {dragBlock && dragBlock[1] > dragBlock[0]
          ? `${String(dragBlock[0] + 1).padStart(2, '0')}–${String(dragBlock[1] + 1).padStart(2, '0')} · BLOCK`
          : String(dragFrom + 1).padStart(2, '0')}
      </span>
      {(state.padBufferMeta[dragFrom]?.title || engine?.padSourceKey(dragFrom) === 'main') && (
        <span className="pad-ghost-title">{state.padBufferMeta[dragFrom]?.title ?? state.trackTitle}</span>
      )}
    </div>,
    document.body,
  ) : null;
  // Source colour + block position of a pad — the top stripe that shows which
  // pads belong together (one source = one colour, joined across the block).
  const blockInfo = (i: number): { color: string; pos: 'solo' | 'start' | 'mid' | 'end' | null } => {
    const key = engine?.padSourceKey(i) ?? null;
    if (!key) return { color: 'transparent', pos: null };
    const r = engine!.blockRange(i)!;
    const pos = r[0] === r[1] ? 'solo' : i === r[0] ? 'start' : i === r[1] ? 'end' : 'mid';
    return { color: sourceColor(key), pos };
  };
  const moveTools = (
    <div className="pad-grid-tools">
      <button type="button" className={`pad-tool-btn${moveMode ? ' on' : ''}`}
        onClick={() => { endDrag(); setMoveMode(m => !m); }}
        title={moveMode ? 'MOVE mode is ON — drag a pad onto another pad to move it (or swap when that pad is loaded). Click again or press ESC to leave' : 'MOVE mode — then drag pads to rearrange them. Tip: hold ⌘ (Ctrl on Windows) or Alt/Option and drag a pad any time without switching modes'}>
        ⇄ MOVE{moveMode ? ' · ON' : ''}
      </button>
      {moveMode && <span className="pad-tool-hint">drag a pad onto another · ESC to finish</span>}
      {!moveMode && selPads.length > 0 && (
        <span className="pad-tool-hint">
          {selPads.length} PAD{selPads.length > 1 ? 'S' : ''} selected — shift-click adds/removes · a selected pad's □/right-click menu edits them ALL · ⌘X/C/V cut·copy·paste, DELETE clears · ESC or a plain click drops the selection (keyboard/MIDI hits keep it)
        </span>
      )}
    </div>
  );

  // The single portalled dropdown — positioned from the □ button's rect, flipping
  // above/below the button; useKeepOnScreen then MEASURES it and nudges it so
  // it is never clipped (the sub-lists make it taller than any guess).
  const padPopRef = useRef<HTMLDivElement>(null);
  useKeepOnScreen(padPopRef, padMenu ? `${padMenu.idx}:${Math.round(padMenu.rect.left)},${Math.round(padMenu.rect.top)}` : null);
  const padMenuPortal = padMenu ? createPortal(
    (() => {
      const r = padMenu.rect;
      const MENU_W = 168, EST_H = 360;
      const left = Math.max(4, Math.min(r.left, window.innerWidth - MENU_W - 4));
      const openUp = r.top > EST_H + 8;   // room above the button?
      const style: CSSProperties = openUp
        ? { position: 'fixed', left, bottom: window.innerHeight - r.top + 3 }
        : { position: 'fixed', left, top: r.bottom + 3 };
      const idx = padMenu.idx;
      // Menu on a SELECTED pad while ≥2 pads are selected = MULTI menu: every
      // action left visible applies to the whole selection. Single-target
      // actions (import/load/record/move/resample/block ops) are hidden.
      const targets = selSet.has(idx) && selPads.length > 1 ? selPads : [idx];
      const multi = targets.length > 1;
      return (
        <>
          <div className="pad-pop-backdrop" onPointerDown={() => setPadMenu(null)} />
          {/* Items act on CLICK (not pointerdown): closing on pointerdown would let
              the follow-up click fall through to whatever sits under the menu. */}
          <div className="pad-pop" style={style} ref={padPopRef}
            onPointerDown={e => e.stopPropagation()} onClick={e => e.stopPropagation()}>
            {(() => {
              // Multi menu: an action is available when ANY selected pad holds
              // audio — a menu opened on an EMPTY aim pad must not grey out
              // Cut all/Copy all/Clear for the loaded pads in the selection.
              // Mode/gate display reads the same base pad the SET action uses.
              const loaded = multi ? targets.some(isLoadedPad) : isLoadedPad(idx);
              const basePad = state.pads[isLoadedPad(idx) ? idx : targets.find(isLoadedPad) ?? idx];
              const mode = basePad?.mode ?? 'oneshot';
              const gate = !!basePad?.gate;
              return (<>
                <div className="pad-pop-title">{multi ? `${targets.length} PADS SELECTED` : `PAD ${String(idx + 1).padStart(2, '0')}`}</div>
                <button onClick={() => handlePadMenuAction(idx, 'play')} disabled={!loaded} title={multi ? 'Play every selected pad at once' : 'Play this pad'}>▶ Play{multi ? ' all' : ''}</button>
                {/* SELECT from the menu — the same toggle as shift-click, so the
                    menu alone can build a multi-selection (and a touchscreen,
                    which has no shift key, gets the same power). */}
                {selection && (
                  <button className={selSet.has(idx) ? 'pad-pop-on' : ''}
                    onClick={() => { toggleSelect(idx); setPadMenu(null); }}
                    title={selSet.has(idx) ? 'Drop this pad from the selection' : 'Add this pad to the selection (same as shift-click) — a selected pad\'s menu then edits ALL selected pads. An empty pad in the selection is where Paste lands'}>
                    {selSet.has(idx) ? '☑ Selected' : '☐ Select'}{selPads.length ? ` · ${selPads.length} pad${selPads.length > 1 ? 's' : ''}` : ''}
                  </button>
                )}
                <div className="pad-pop-sep" />
                {!multi && onLoadClipboardLink && <button onClick={() => handlePadMenuAction(idx, 'cliplink')} title="Copy a YouTube link anywhere, then click this — the link in your clipboard is pulled straight onto THIS pad as its own source (it tells you if nothing / no link is copied)">⇣ Load link from clipboard</button>}
                {!multi && onImportLink && <button onClick={() => handlePadMenuAction(idx, 'link')} title="Type or paste a YouTube link into a box — the audio lands on THIS pad as its own source">⇣ Import link…</button>}
                {!multi && onLoadFileInto && <button onClick={() => handlePadMenuAction(idx, 'file')} title="Pick an audio file from this computer — it lands on THIS pad">📁 Load file…</button>}
                {!multi && onRecordInto && <button onClick={() => handlePadMenuAction(idx, 'record')} title="Open RECORD SAMPLE aimed at THIS pad — the take lands here">● Record into pad</button>}
                {!multi && (onImportLink || onLoadFileInto || onRecordInto) && <div className="pad-pop-sep" />}
                <button onClick={() => handlePadMenuAction(idx, 'cut')} disabled={!loaded} title={multi ? 'Cut every selected pad — they empty, and Paste drops them wherever you click next' : 'Cut this pad — it empties, and Paste drops it on the pad you paste on (⌘X)'}>Cut{multi ? ' all' : ''}</button>
                <button onClick={() => handlePadMenuAction(idx, 'copy')} disabled={!loaded} title={multi ? 'Copy every selected pad — Paste lands them on consecutive pads from the pad you paste on' : 'Copy this pad (⌘C)'}>Copy{multi ? ' all' : ''}</button>
                <button onClick={() => handlePadMenuAction(idx, 'paste')} disabled={padClipboard === null} title={padClipboard && padClipboard.length > 1 ? `Paste ${padClipboard.length} cut/copied pads onto consecutive pads starting HERE` : 'Paste onto this pad (⌘V)'}>Paste{padClipboard && padClipboard.length > 1 ? ` ${padClipboard.length} pads` : ''}</button>
                <button onClick={() => handlePadMenuAction(idx, 'duplicate')} disabled={!loaded} title={multi ? 'Copy every selected pad onto the free pads after the selection' : 'Copy this pad onto the next free pad'}>Duplicate{multi ? ' all' : ''}</button>
                {!multi && <button onClick={() => handlePadMenuAction(idx, 'move')} disabled={!loaded} title="Arm MOVE mode: drag this (or any) pad onto another pad — moved onto an empty pad, swapped with a loaded one. ESC to finish">Move…</button>}
                {!multi && <button onClick={() => handlePadMenuAction(idx, 'moveto')} disabled={!loaded} title="Send this pad's content to the first empty pad">Move to empty</button>}
                <div className="pad-pop-sep" />
                {/* PLAY MODE — two independent switches; both may be on (loop while held). */}
                <button className={gate ? 'pad-pop-on' : ''} onClick={() => handlePadMenuAction(idx, 'gate')} disabled={!loaded}
                  title={`NOTE ON — the pad sounds only while you hold it (pad, key or MIDI note); let go and it fades out over RELEASE. Off = one-shot: a hit plays the whole chop${multi ? `. Sets ALL ${targets.length} selected pads` : ''}`}>
                  {gate ? '■ NOTE ON: on' : '□ NOTE ON: off'} <span className="pad-pop-hint">{multi ? 'all selected' : 'hold to play'}</span>
                </button>
                <button className={mode === 'loop' ? 'pad-pop-on' : ''} onClick={() => handlePadMenuAction(idx, 'mode')} disabled={!loaded}
                  title={`LOOP — the pad plays round and round between the chop's start and end. Hit it again to stop (or hold it with NOTE ON). In LOOP the waveform shows two FADE nodes at the chop's start and end — drag them so the tail fades into the head, a crossfade loop (they can cross for a full melt): a pad or a synth out of any sample${multi ? `. Sets ALL ${targets.length} selected pads` : ''}`}>
                  {mode === 'loop' ? '■ LOOP: on' : '□ LOOP: off'} <span className="pad-pop-hint">{multi ? 'all selected' : 'start ↔ end'}</span>
                </button>
                {!multi && <button onClick={() => handlePadMenuAction(idx, 'resample')} disabled={!loaded} title="Print what this pad PLAYS — the chop or sample with its stem layers, pitch, reverse and attack, dry — as a lossless FLAC on the next empty pad: a fresh source you can chop again, saved with the project. It tells you which pad it landed on">Resample</button>}
                {!multi && onMakeMainTrack && state.padBufferMeta[idx] !== undefined && (
                  <button onClick={() => handlePadMenuAction(idx, 'makemain')}
                    title="Make this pad's own sample the MAIN track (the pad keeps it) — the main-track tools (TRIM, NORM, the chop bar) on it. STEMS no longer needs this: a pad's own sample splits right where it is">↥ Make main track</button>
                )}
                {engine && loaded && (() => {
                  // GROUP — pads in one group share a mixer strip, a mute group and a
                  // colour, and chops cut from a grouped pad stay in its group. Every
                  // source is a group on its own (automatic); here you can duplicate a
                  // pad into a NEW group, move a pad into another group, or leave one.
                  const curKey = engine.padSourceKey(idx);
                  const groups = state.groups ?? [];
                  const curLabel = curKey ? (groups.find(g => g.key === curKey)?.label ?? engine.groupLabel(curKey)) : 'none';
                  const overridden = targets.some(t => state.padGroups?.[t] !== undefined);
                  const r = engine.blockRange(idx);
                  const inBlock = !multi && !!r && r[1] > r[0];
                  const tag = multi ? `all ${targets.length} selected pads` : `this pad${routeBlock ? ' and its block' : ''}`;
                  return (<>
                    <div className="pad-pop-sep" />
                    <button className={`pad-pop-route${groupOpen ? ' open' : ''}`} onClick={() => setGroupOpen(o => !o)}
                      title="GROUP — pads in a group share the same mixer strip, mute group and colour, and any chop you cut from a grouped pad stays in its group. Every sample on a pad is a group of its own automatically; duplicate a pad into a NEW group to give the same sound its own strip + effects, or move a pad into another group">
                      <span className="pad-pop-dot" style={{ background: sourceColor(curKey) }} />
                      Group: {multi ? '…' : curLabel} <span className="pad-pop-caret">{groupOpen ? '▾' : '▸'}</span>
                    </button>
                    {groupOpen && (
                      <div className="pad-pop-sub">
                        {!multi && <button onClick={() => { const dest = firstEmptyAfter(engine, idx); if (dest >= 0) engine.duplicatePadToNewGroup(idx, dest); setPadMenu(null); }}
                          title="Copy this pad to the next empty pad AS A NEW GROUP — same sound, its own strip (starts as this pad's), own mute group, own colour; chops you cut from the copy follow the copy">⧉ Duplicate to new group</button>}
                        {/* STEMS sweetener: the drum-group / melody-group workflow in one
                            click — duplicate into a new group already set to ONE stem. */}
                        {!multi && engine.hasStems() && state.pads[idx]?.chopId != null && !state.padBufferMeta[idx] && STEM_ORDER.map(name => (
                          <button key={`stem-${name}`} onClick={() => { const dest = firstEmptyAfter(engine, idx); if (dest >= 0) { engine.duplicatePadToNewGroup(idx, dest); engine.setPadStems(dest, stemBit(name)); onFlash?.(`PAD ${dest + 1} → ${name.toUpperCase()} GROUP`); } setPadMenu(null); }}
                            title={`Duplicate to a new group playing ONLY the ${name.toUpperCase()} of this chop — same slice, its own strip/colour/mute group`}>
                            ⧉ as {name.toUpperCase()}
                          </button>
                        ))}
                        <button onClick={() => { if (multi) { engine.setPadsGroup(targets, 'new', idx); onFlash?.(`${targets.length} PADS → NEW GROUP`); } else engine.setPadGroup(idx, 'new', routeBlock); setPadMenu(null); }}
                          title={multi ? `Put ALL ${targets.length} selected pads together in ONE new group — shared strip, mute group and colour` : 'Start a new group with this pad (it keeps its current strip as the group\'s default)'}>+ New group{multi ? ' (all together)' : ''}</button>
                        {groups.filter(g => multi || g.key !== curKey).map(g => (
                          <button key={g.key} onClick={() => { if (multi) { engine.setPadsGroup(targets, g.key); onFlash?.(`${targets.length} PADS → ${g.label}`); } else engine.setPadGroup(idx, g.key, routeBlock); setPadMenu(null); }}
                            title={`Move ${tag} into ${g.label} (pads ${g.pads.map(p => p + 1).join(', ')}) — takes that group's strip and mute group`}>
                            <span className="pad-pop-dot" style={{ background: sourceColor(g.key) }} />{g.label}
                          </button>
                        ))}
                        {overridden && (
                          <button onClick={() => { if (multi) engine.setPadsGroup(targets, null); else engine.setPadGroup(idx, null, routeBlock); setPadMenu(null); }}
                            title={multi ? 'Every selected pad back to its own source\'s group' : 'Back to its own source\'s group'}>↩ Leave group</button>
                        )}
                        {inBlock && (
                          <button className={`pad-pop-toggle${routeBlock ? ' on' : ''}`} onClick={() => setRouteBlock(b => !b)}
                            title={`Apply to every pad of this block (pads ${r![0] + 1}–${r![1] + 1})`}>
                            {routeBlock ? '☑' : '☐'} whole block ({r![0] + 1}–{r![1] + 1})
                          </button>
                        )}
                      </div>
                    )}
                  </>);
                })()}
                {engine && loaded && engine.hasStemsForPad(idx) && (() => {
                  // STEMS ▸ — which layers this pad plays: of the main track, or
                  // of its OWN sample once that was split (STEMS PER SOURCE).
                  // A menu on a selected pad drives the whole selection.
                  const hasTarget = (i: number) => engine.hasStemsForPad(i);
                  const stemTargets = targets.filter(hasTarget);
                  const mask = engine.padStems(idx);
                  const ABBR: Record<string, string> = { drums: 'DR', bass: 'BS', other: 'OT', vocals: 'VX' }; // matches the waveform chips
                  const label = mask === MASK_ALL ? 'ALL' : STEM_ORDER.filter(n => maskHas(mask, n)).map(n => ABBR[n]).join('+');
                  const tag = multi ? `all ${stemTargets.length} selected pads` : 'this pad';
                  return (<>
                    <div className="pad-pop-sep" />
                    <button className={`pad-pop-route${stemsOpen ? ' open' : ''}`} onClick={() => setStemsOpen(o => !o)}
                      title="STEMS — which layers of the sample this pad plays: same chop, just its drums, its bass, the vocals, or any mix. ALL = the untouched original. Duplicate pads into stem groups from Group ▸ for the drum-kit / melody / bass workflow">
                      Stems: {multi ? '…' : label} <span className="pad-pop-caret">{stemsOpen ? '▾' : '▸'}</span>
                    </button>
                    {stemsOpen && (
                      <div className="pad-pop-sub">
                        {STEM_ORDER.map(name => (
                          <button key={name} className={maskHas(mask, name) ? 'on' : ''}
                            onClick={() => {
                              const next = toggleStem(mask, name);
                              if (next === mask) { onFlash?.('AT LEAST ONE STEM STAYS ON'); return; }
                              engine.setPadsStems(stemTargets, next);
                            }}
                            title={`${name.toUpperCase()} on/off for ${tag} — the last lit stem stays on`}>
                            {maskHas(mask, name) ? '☑' : '☐'} {name.toUpperCase()}
                          </button>
                        ))}
                        <button className={mask === MASK_ALL ? 'on' : ''}
                          onClick={() => engine.setPadsStems(stemTargets, MASK_ALL)}
                          title={`Back to the untouched original for ${tag}`}>
                          {mask === MASK_ALL ? '☑' : '☐'} ALL (original)
                        </button>
                      </div>
                    )}
                  </>);
                })()}
                {mixerTracks && onRoutePad && loaded && (() => {
                  const cur = padRoutes?.[idx] ?? 'sample';
                  const curT = mixerTracks.find(t => t.name === cur);
                  const r = engine?.blockRange(idx);
                  const inBlock = !multi && !!r && r[1] > r[0];
                  const tag = multi ? `all ${targets.length} selected pads` : `this pad${routeBlock ? ' and its block' : ''}`;
                  return (<>
                    <div className="pad-pop-sep" />
                    <button className={`pad-pop-route${routeOpen ? ' open' : ''}`} onClick={() => setRouteOpen(o => !o)}
                      title="Which mixer strip this pad plays through. Every source gets its own SAMPLE strip by default; pick another, or a new one. To undo a move, pick the source's own SAMPLE strip again — the pad goes back to following its group">
                      <span className="pad-pop-dot" style={{ background: curT?.color ?? '#e7a977' }} />
                      Mixer: {multi ? '…' : (curT?.label ?? cur)} <span className="pad-pop-caret">{routeOpen ? '▾' : '▸'}</span>
                    </button>
                    {routeOpen && (
                      <div className="pad-pop-sub">
                        {mixerTracks.map(t => (
                          <button key={t.name} className={!multi && t.name === cur ? 'on' : ''} onClick={() => { if (multi) { engine?.setPadsRoute(targets, t.name); onFlash?.(`${targets.length} PADS → ${t.label}`); } else onRoutePad(idx, t.name, routeBlock); setPadMenu(null); }}
                            title={`Play ${tag} through ${t.label}`}>
                            <span className="pad-pop-dot" style={{ background: t.color }} />{t.label}{!multi && t.name === cur ? ' ✓' : ''}
                          </button>
                        ))}
                        <button onClick={() => { if (multi) { engine?.setPadsRoute(targets, 'new'); onFlash?.(`${targets.length} PADS → NEW MIXER TRACK`); } else onRoutePad(idx, 'new', routeBlock); setPadMenu(null); }}
                          title={multi ? `Send ALL ${targets.length} selected pads through ONE new strip (a new SAMPLE n)` : 'Give this pad a strip of its own (a new SAMPLE n)'}>+ New mixer track{multi ? ' (all together)' : ''}</button>
                        {inBlock && (
                          <button className={`pad-pop-toggle${routeBlock ? ' on' : ''}`} onClick={() => setRouteBlock(b => !b)}
                            title={`Apply the pick to every pad of this block (pads ${r![0] + 1}–${r![1] + 1}) instead of just this one`}>
                            {routeBlock ? '☑' : '☐'} whole block ({r![0] + 1}–{r![1] + 1})
                          </button>
                        )}
                      </div>
                    )}
                  </>);
                })()}
                {chokeGroups && onChokePad && loaded && (() => {
                  const cur = padChoke?.[idx] ?? 'none';
                  const curLabel = cur === 'none' ? 'none' : (chokeGroups.find(g => g.id === cur)?.label ?? cur);
                  const colorOf = (id: string) => (id === 'none' ? 'transparent' : id.includes(':') ? sourceColor(id) : id.startsWith('grp') ? sourceColor(`grp:${id}`) : sourceColor(id));
                  const r = engine?.blockRange(idx);
                  const inBlock = !multi && !!r && r[1] > r[0];
                  const tag = multi ? `all ${targets.length} selected pads` : `this pad${routeBlock ? ' and its block' : ''}`;
                  return (<>
                    <button className={`pad-pop-route${chokeOpen ? ' open' : ''}`} onClick={() => setChokeOpen(o => !o)}
                      title="Which pads cut this one off (and it cuts). Default: the pads of its own source — chops of one sample choke each other, other sources don't">
                      <span className="pad-pop-dot" style={{ background: colorOf(cur), boxShadow: cur === 'none' ? 'none' : undefined, border: cur === 'none' ? '1px solid currentColor' : 'none' }} />
                      Mute group: {multi ? '…' : curLabel} <span className="pad-pop-caret">{chokeOpen ? '▾' : '▸'}</span>
                    </button>
                    {chokeOpen && (
                      <div className="pad-pop-sub">
                        {chokeGroups.map(g => (
                          <button key={g.id} className={!multi && g.id === cur ? 'on' : ''} onClick={() => { if (multi) { engine?.setPadsChoke(targets, g.id); onFlash?.(`${targets.length} PADS → MUTE GROUP ${g.label}`); } else onChokePad(idx, g.id, routeBlock); setPadMenu(null); }}
                            title={`${multi ? `All ${targets.length} selected pads choke` : `This pad${routeBlock ? ' and its block' : ''} chokes`} with ${g.label}`}>
                            <span className="pad-pop-dot" style={{ background: colorOf(g.id) }} />{g.label}{!multi && g.id === cur ? ' ✓' : ''}
                          </button>
                        ))}
                        <button className={!multi && cur === 'none' ? 'on' : ''} onClick={() => { if (multi) { engine?.setPadsChoke(targets, 'none'); onFlash?.(`${targets.length} PADS → POLYPHONIC`); } else onChokePad(idx, 'none', routeBlock); setPadMenu(null); }}
                          title={`Polyphonic — nothing cuts ${tag}`}>No group (polyphonic){!multi && cur === 'none' ? ' ✓' : ''}</button>
                        <button onClick={() => { if (multi) { engine?.setPadsChoke(targets, 'new'); onFlash?.(`${targets.length} PADS → NEW MUTE GROUP`); } else onChokePad(idx, 'new', routeBlock); setPadMenu(null); }}
                          title={multi ? `Put ALL ${targets.length} selected pads in ONE new mute group — they cut each other off` : 'Start a new group with this pad — put others in it from their own menus'}>+ New group{multi ? ' (all together)' : ''}</button>
                        {inBlock && (
                          <button className={`pad-pop-toggle${routeBlock ? ' on' : ''}`} onClick={() => setRouteBlock(b => !b)}
                            title={`Apply to every pad of this block (pads ${r![0] + 1}–${r![1] + 1})`}>
                            {routeBlock ? '☑' : '☐'} whole block ({r![0] + 1}–{r![1] + 1})
                          </button>
                        )}
                      </div>
                    )}
                  </>);
                })()}
                <div className="pad-pop-sep" />
                <button className="pad-pop-danger" onClick={() => handlePadMenuAction(idx, 'clear')} disabled={!loaded}
                  title={multi ? `Clear ALL ${targets.length} selected pads` : 'Empty this pad — its chop stays on the waveform, the pad lets go of it'}>Clear{multi ? ` ${targets.length} pads` : ''}</button>
                {!multi && (() => { const r = engine?.blockRange(idx); return r && r[1] > r[0] ? (
                  <button className="pad-pop-danger" onClick={() => handlePadMenuAction(idx, 'clearblock')} title={`Clear pads ${r[0] + 1}–${r[1] + 1} — this whole block of one source`}>Clear block ({r[0] + 1}–{r[1] + 1})</button>
                ) : null; })()}
              </>);
            })()}
          </div>
        </>
      );
    })(),
    document.body,
  ) : null;

  if (isMobile) {
    return (
      <div className="pad-grid-wrap pad-grid-wrap-mobile" ref={gridRootRef}>
        {padMenuPortal}{dragGhost}
        {moveTools}
        <div ref={pagerRef} className="pad-pager">
          {Array.from({ length: mobilePageCount }, (_, page) => {
            const start = page * MOBILE_PAGE_SIZE;
            return (
              <div key={page} className="pad-page">
                <div className="pad-grid" style={{ gridTemplateColumns: 'repeat(4, 1fr)' }} data-cols={4}>
                  {Array.from({ length: MOBILE_PAGE_SIZE }, (_, i) => {
                    const p = padAt(start + i);
                    return (
                      <PadButton
                        key={p.index}
                        pad={p}
                        keyLabel={labelForPad(p.index)}
                        chopNo={chopNoFor(p.index)}
                        revMark={revMarkFor(p.index)}
                        hoverTitle={hoverTitleFor(p.index)}
                        selected={state.selectedPad === p.index}
                        assigned={p.chopId !== null}
                        active={activePadSet.has(p.index)}
                        locked={isLocked(p.index)}
                        ownSample={state.padBufferMeta[p.index] !== undefined}
                        ownTitle={state.padBufferMeta[p.index]?.title}
                        onTrigger={ts => onTrigger(p.index, 1, ts)}
                        onRelease={() => onRelease(p.index)}
                        onSelect={() => onSelect(p.index)}
                        onFocus={() => (onFocusPad ?? onSelect)(p.index)}
                        onClear={() => onClear(p.index)}
                        onPitch={(s) => onPitch(p.index, s)}
                        onDropFile={onDropFile ? (file) => onDropFile(p.index, file) : undefined}
                        onSwapSample={onSwapSample ? () => onSwapSample(p.index) : undefined}
                        drumPadMode={drumPadMode}
                        drumPadLabels={drumPadLabels}
                        showMenu={showMenu}
                        menuOpen={padMenu?.idx === p.index}
                        onMenuToggle={(rect) => setPadMenu(cur => (cur?.idx === p.index ? null : { idx: p.index, rect }))}
                        moveMode={moveMode}
                        dragging={dragBlock ? p.index >= dragBlock[0] && p.index <= dragBlock[1] : dragFrom === p.index}
                        onPickUp={onMoveTo ? (e) => pickUp(p.index, e) : undefined}
                        srcColor={blockInfo(p.index).color}
                        blockPos={blockInfo(p.index).pos}
                        multiSelected={selSet.has(p.index)}
                        onShiftSelect={() => toggleSelect(p.index)}
                        isEmptyPad={!isLoadedPad(p.index)}
                        onAimPaste={() => selection?.only(p.index)}
                        onDeselect={selPads.length ? () => selection?.clear() : undefined}
                      />
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
        {mobilePageCount > 1 && (
          <div className="pad-page-dots" role="tablist" aria-label="Pad pages">
            {Array.from({ length: mobilePageCount }, (_, i) => (
              <button
                key={i}
                role="tab"
                aria-selected={i === mobilePage}
                className={`pad-page-dot${i === mobilePage ? ' on' : ''}`}
                onClick={() => {
                  const el = pagerRef.current;
                  if (!el) return;
                  el.scrollTo({ left: i * el.clientWidth, behavior: 'smooth' });
                }}
                title={`Page ${i + 1} (pads ${i * MOBILE_PAGE_SIZE + 1}–${(i + 1) * MOBILE_PAGE_SIZE})`}
              />
            ))}
          </div>
        )}
      </div>
    );
  }

  // ── Web desktop layout (Option A: fixed 16-wide grid, mobile-style) ───────
  // One wide MPC-style row of 16 pads that grows downward (rows of 16) as pads
  // are added, with empty placeholder slots staying visible + tappable so you
  // can chop into them — same model as the mobile pager, but a single grid
  // since desktop has the vertical room. Fixed cell size (no sqrt stretch), so
  // pad 1 is never huge. Scoped to web so the Electron desktop (FX panel beside
  // the pads) keeps its compact sqrt layout below.
  if (isWebUI) {
    const DESKTOP_COLS = 16;
    const DESKTOP_MAX_ROWS = 5; // 80-pad cap, matches the engine's web auto-slice cap
    const filledRows = Math.max(1, Math.ceil(padCount / DESKTOP_COLS));
    const desktopRows = Math.min(DESKTOP_MAX_ROWS, filledRows + (filledRows < DESKTOP_MAX_ROWS ? 1 : 0));
    const desktopSlots = desktopRows * DESKTOP_COLS;
    const wBankStart = bank * BANK_SIZE;
    const wBankEnd = wBankStart + BANK_SIZE;
    const wShowBanner = padCount > BANK_SIZE || bank > 0;
    return (
      <div className="pad-grid-wrap" ref={gridRootRef}>
        {padMenuPortal}{dragGhost}
        {moveTools}
        {wShowBanner && (
          <div className="pad-bank-banner">
            <span className="pad-bank-label">KEYBOARD</span>
            <span className="pad-bank-range">
              {`pads ${wBankStart + 1}–${Math.min(wBankEnd, padCount)} of ${padCount}`}
            </span>
            <span className="pad-bank-hint">{'− prev / = next'}</span>
            <span className="pad-bank-num">{`BANK ${bank + 1}/${maxBank + 1}`}</span>
          </div>
        )}
        <div
          className="pad-grid pad-grid-fixed"
          style={{ gridTemplateColumns: `repeat(${DESKTOP_COLS}, 1fr)` }}
          data-cols={DESKTOP_COLS}
        >
          {Array.from({ length: desktopSlots }, (_, idx) => {
            const p = padAt(idx);
            return (
              <PadButton
                key={p.index}
                pad={p}
                keyLabel={labelForPad(p.index)}
                        chopNo={chopNoFor(p.index)}
                        revMark={revMarkFor(p.index)}
                        hoverTitle={hoverTitleFor(p.index)}
                selected={state.selectedPad === p.index}
                assigned={p.chopId !== null}
                active={activePadSet.has(p.index)}
                locked={isLocked(p.index)}
                ownSample={state.padBufferMeta[p.index] !== undefined}
                ownTitle={state.padBufferMeta[p.index]?.title}
                onTrigger={ts => onTrigger(p.index, 1, ts)}
                onRelease={() => onRelease(p.index)}
                onSelect={() => onSelect(p.index)}
                onFocus={() => (onFocusPad ?? onSelect)(p.index)}
                onClear={() => onClear(p.index)}
                onPitch={(s) => onPitch(p.index, s)}
                onDropFile={onDropFile ? (file) => onDropFile(p.index, file) : undefined}
                onSwapSample={onSwapSample ? () => onSwapSample(p.index) : undefined}
                drumPadMode={drumPadMode}
                drumPadLabels={drumPadLabels}
                showMenu={showMenu}
                menuOpen={padMenu?.idx === p.index}
                onMenuToggle={(rect) => setPadMenu(cur => (cur?.idx === p.index ? null : { idx: p.index, rect }))}
                moveMode={moveMode}
                dragging={dragBlock ? p.index >= dragBlock[0] && p.index <= dragBlock[1] : dragFrom === p.index}
                onPickUp={onMoveTo ? (e) => pickUp(p.index, e) : undefined}
                srcColor={blockInfo(p.index).color}
                blockPos={blockInfo(p.index).pos}
                multiSelected={selSet.has(p.index)}
                onShiftSelect={() => toggleSelect(p.index)}
                isEmptyPad={!isLoadedPad(p.index)}
                onAimPaste={() => selection?.only(p.index)}
                        onDeselect={selPads.length ? () => selection?.clear() : undefined}
              />
            );
          })}
        </div>
      </div>
    );
  }

  // ── Electron desktop layout (unchanged) ───────────────────────────────────
  const visiblePads: Pad[] = state.pads.filter(
    p => p.chopId !== null || state.padBufferMeta?.[p.index] !== undefined
  );
  const n = Math.max(1, visiblePads.length);
  const cols = Math.ceil(Math.sqrt(n));

  const bankStart = bank * BANK_SIZE;
  const bankEnd = bankStart + BANK_SIZE;
  const showBanner = padCount > BANK_SIZE || bank > 0;

  return (
    <div className="pad-grid-wrap" ref={gridRootRef}>
      {padMenuPortal}{dragGhost}
      {moveTools}
      {showBanner && (
        <div className="pad-bank-banner">
          <span className="pad-bank-label">KEYBOARD</span>
          <span className="pad-bank-range">
            {`pads ${bankStart + 1}–${Math.min(bankEnd, padCount)} of ${padCount}`}
          </span>
          <span className="pad-bank-hint">
            {'− prev / = next'}
          </span>
          <span className="pad-bank-num">{`BANK ${bank + 1}/${maxBank + 1}`}</span>
        </div>
      )}
      <div
        className="pad-grid"
        style={{ gridTemplateColumns: `repeat(${cols}, 1fr)` }}
        data-cols={cols}
      >
      {visiblePads.map(p => (
        <PadButton
          key={p.index}
          pad={p}
          keyLabel={labelForPad(p.index)}
                        chopNo={chopNoFor(p.index)}
                        revMark={revMarkFor(p.index)}
                        hoverTitle={hoverTitleFor(p.index)}
          selected={state.selectedPad === p.index}
          assigned={p.chopId !== null}
          active={activePadSet.has(p.index)}
          locked={isLocked(p.index)}
          ownSample={state.padBufferMeta[p.index] !== undefined}
          ownTitle={state.padBufferMeta[p.index]?.title}
          onTrigger={ts => onTrigger(p.index, 1, ts)}
          onRelease={() => onRelease(p.index)}
          onSelect={() => onSelect(p.index)}
          onFocus={() => (onFocusPad ?? onSelect)(p.index)}
          onClear={() => onClear(p.index)}
          onPitch={(s) => onPitch(p.index, s)}
          onDropFile={onDropFile ? (file) => onDropFile(p.index, file) : undefined}
          onSwapSample={onSwapSample ? () => onSwapSample(p.index) : undefined}
          drumPadMode={drumPadMode}
          drumPadLabels={drumPadLabels}
          showMenu={showMenu}
          menuOpen={padMenu?.idx === p.index}
          onMenuToggle={(rect) => setPadMenu(cur => (cur?.idx === p.index ? null : { idx: p.index, rect }))}
          moveMode={moveMode}
          dragging={dragBlock ? p.index >= dragBlock[0] && p.index <= dragBlock[1] : dragFrom === p.index}
          onPickUp={onMoveTo ? (e) => pickUp(p.index, e) : undefined}
          srcColor={blockInfo(p.index).color}
          blockPos={blockInfo(p.index).pos}
          multiSelected={selSet.has(p.index)}
          onShiftSelect={() => toggleSelect(p.index)}
          isEmptyPad={!isLoadedPad(p.index)}
          onAimPaste={() => selection?.only(p.index)}
                        onDeselect={selPads.length ? () => selection?.clear() : undefined}
        />
      ))}
      </div>
    </div>
  );
}


function PadButton({ pad, keyLabel, chopNo, revMark, hoverTitle, selected, assigned, active, locked, ownSample, ownTitle, onTrigger, onRelease, onSelect, onFocus, onClear, onDropFile, onSwapSample, showMenu, menuOpen, onMenuToggle, drumPadMode, drumPadLabels, moveMode, dragging, onPickUp, srcColor, blockPos, multiSelected, onShiftSelect, onAimPaste, onDeselect, isEmptyPad }: {
  pad: Pad;
  keyLabel: string;
  selected: boolean;
  assigned: boolean;
  active: boolean;
  locked: boolean;
  ownSample: boolean;
  ownTitle?: string;
  onTrigger: (eventTimestamp?: number) => void;
  onRelease: () => void;
  onSelect: () => void;
  /** focus only — its sample on the waveform, no assign mode (right-click) */
  onFocus?: () => void;
  onClear: () => void;
  /** Retained for the PadGrid prop chain; the per-pad pitch UI was removed. */
  onPitch: (semitones: number) => void;
  onDropFile?: (file: File) => void;
  onSwapSample?: () => void;
  /** DRUM PADS mode — flags pads 1..N as drum lanes (label + colour). */
  drumPadMode?: boolean;
  /** DRUM PADS mode: the lane names, pad i ↔ lane i (every lane, added ones too). */
  drumPadLabels?: string[];
  /** ◁ / ▷ when this pad plays the OPPOSITE way to its source (per-pad REV). */
  revMark?: '◁' | '▷';
  /** Hover line: content · mute group · mixer strip. */
  hoverTitle?: string;
  /** Show the per-pad □ options-menu button (bottom-left). */
  showMenu: boolean;
  /** Whether this pad's menu is the currently-open one (highlights the □). */
  menuOpen: boolean;
  /** The pad's chop number in time order (1-based) — small, top-left. */
  chopNo?: number | null;
  /** MOVE mode: a press on a loaded pad picks it up (ghost) instead of playing. */
  moveMode?: boolean;
  /** This pad is the one being carried — drawn hollow while the ghost has its face. */
  dragging?: boolean;
  onPickUp?: (e: React.PointerEvent<HTMLElement>) => void;
  /** Source colour stripe + where in its block this pad sits. */
  srcColor?: string;
  blockPos?: 'solo' | 'start' | 'mid' | 'end' | null;
  /** SHIFT multi-select: this pad is in the selection (ring), and the toggle
   *  fired by a shift+press (which never plays the pad). */
  multiSelected?: boolean;
  onShiftSelect?: () => void;
  /** Plain click on an EMPTY pad: aim the paste here (there is nothing to play,
   *  so the click is free to mean "this is the target"). */
  onAimPaste?: () => void;
  /** Plain PLAY press with a multi-selection live: drop it (his rule 2026-08-21:
   *  clicking a pad deselects; keyboard/MIDI hits never do — they don't come
   *  through this pointer handler — and ESC still clears). */
  onDeselect?: () => void;
  /** This pad holds nothing — drives the aim-paste click and its tooltip. */
  isEmptyPad?: boolean;
  /** Toggle this pad's menu; receives the □ button's rect for positioning. */
  onMenuToggle: (rect: DOMRect) => void;
}) {
  const [dragOver, setDragOver] = useState(false);
  // Brief green flash after a file is dropped onto the pad (cosmetic feedback).
  const [justLoaded, setJustLoaded] = useState(false);
  // Drum-mode badge: lane i's name on pad i (short form; the full name is the tooltip).
  const drumLaneName = drumPadMode ? drumPadLabels?.[pad.index] : undefined;
  const drumLabel = drumLaneName ? drumLaneName.replace(/^open hat$/i, 'OHAT').replace(/^hi-hat$/i, 'HAT').toUpperCase().slice(0, 7) : null;

  return (
    <div
      className={[
        'pad',
        selected ? 'pad-selected' : '',
        assigned ? 'pad-assigned' : '',
        active ? 'pad-active' : '',
        locked ? 'pad-locked' : '',
        ownSample ? 'pad-own-sample' : '',
        dragOver ? 'pad-drag-over' : '',
        justLoaded ? 'pad-loaded' : '',
        drumLabel ? 'pad-drum-mode' : '',
        moveMode ? 'pad-move-mode' : '',
        dragging ? 'pad-dragging' : '',
        multiSelected ? 'pad-msel' : '',
      ].filter(Boolean).join(' ')}
      data-pad-idx={pad.index}
      title={hoverTitle ?? (ownSample && ownTitle ? ownTitle : undefined)}
      // touchAction: 'pan-x' lets horizontal swipes pass through to the
      // mobile pager (so the user can swipe between pages of pads) while
      // still letting tap-and-hold work for ARP. Vertical scroll is blocked
      // so a hold doesn't get hijacked by page scroll. Desktop unaffected.
      style={{ '--pad-color': pad.color, '--src-color': srcColor ?? 'transparent', touchAction: 'pan-x' } as React.CSSProperties}
      onPointerDown={e => {
        e.preventDefault();
        // Right / middle button: the contextmenu handler owns it (menu) — never
        // play the pad or start a drag from it.
        if (e.button !== 0) return;
        // SHIFT+press = multi-select toggle — the pad never plays.
        if (e.shiftKey && onShiftSelect) { onShiftSelect(); return; }
        // Plain press on an EMPTY pad AIMS the paste there (and keeps it
        // selected so you can see where it will land). It still falls through
        // to onTrigger, because tapping an empty pad while a sample plays is
        // how you chop at that moment — aiming must not cost you that.
        if (isEmptyPad && onAimPaste) onAimPaste();
        // MOVE mode (or Alt/Option held): pick the pad up instead of playing it.
        // Empty pads are drop targets only. No pointer capture — PadGrid tracks
        // the drag on window pointermove/up and reads the drop from elementFromPoint.
        // (CMD/CTRL-click-and-hold does the same — his ask: rearrange pads
        // without arming MOVE.)
        if ((moveMode || e.altKey || e.metaKey || e.ctrlKey) && onPickUp && !locked) {
          if (assigned || ownSample) onPickUp(e);
          return;
        }
        // A plain PLAY press drops the multi-selection (a MOVE pick-up above
        // keeps it, and an empty-pad press already re-aimed it via onAimPaste).
        if (!isEmptyPad) onDeselect?.();
        // Capture the pointer so we get the matching pointerup even if the
        // finger drifts off the pad. Without this, finger jitter would fire
        // a premature pointerleave/up and break a held ARP.
        try { (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); } catch { /* */ }
        // Pass the pointer event's own timestamp (when the touch fired) so the
        // engine can back-date live-record quantize past handler lag on mobile.
        onTrigger(e.timeStamp);
      }}
      onPointerUp={e => {
        try { (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId); } catch { /* */ }
        onRelease();
      }}
      onPointerCancel={e => {
        try { (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId); } catch { /* */ }
        onRelease();
      }}
      // Right-click = focus this pad (its source on the waveform) AND open the
      // pad menu at the pointer — the same menu as the □ button, no hunting.
      onContextMenu={e => {
        e.preventDefault(); e.stopPropagation();
        (onFocus ?? onSelect)(); // focus, never assign mode — the purple banner was the old side effect of every right-click
        if (showMenu) onMenuToggle(new DOMRect(e.clientX, e.clientY, 0, 0));
      }}
      onDragOver={e => { e.preventDefault(); e.stopPropagation(); setDragOver(true); }}
      onDragLeave={e => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragOver(false); }}
      onDrop={e => {
        e.preventDefault(); e.stopPropagation(); setDragOver(false);
        const file = e.dataTransfer.files[0];
        if (file) {
          onDropFile?.(file);
          setJustLoaded(true);
          setTimeout(() => setJustLoaded(false), 500);
        }
      }}
    >
      {showMenu && (
        // Bottom-left corner (top/bottom-right are clear/swap). pointerDown stops
        // propagation so opening the menu never triggers the pad. The dropdown
        // itself is portalled at PadGrid level.
        <button
          className={`pad-menu-btn${menuOpen ? ' active' : ''}`}
          title="Pad menu — play, import a link / load a file / record onto this pad, copy, paste, duplicate, move, NOTE ON (hold to play) / LOOP, resample, clear (right-click the pad opens it too). Tip: shift-click pads to select several — then a selected pad's menu edits them all at once"
          onPointerDown={e => { e.preventDefault(); e.stopPropagation(); onMenuToggle(e.currentTarget.getBoundingClientRect()); }}
        >□</button>
      )}
      {blockPos && <div className={`pad-src-stripe pad-src-${blockPos}`} />}
      {chopNo != null && <div className="pad-chop-no" title={`Chop ${chopNo} — this pad's slice, counted in time order`}>{chopNo}</div>}
      {revMark && <div className="pad-rev-mark" title={revMark === '◁' ? 'This pad plays BACKWARDS on its own — hit it and press ◁ REV on the waveform to flip it back' : 'This pad plays FORWARDS while the rest of its source is reversed — hit it and press ◁ REV on the waveform to flip it back'}>{revMark}</div>}
      <div className="pad-key">{keyLabel}</div>
      <div className="pad-num">{String(pad.index + 1).padStart(2, '0')}</div>
      {drumLabel && <div className="pad-drum-label" title={`DRUM PADS: this pad fires the ${drumLaneName} lane`}>{drumLabel}</div>}
      {ownSample && <div className="pad-own-dot" title={ownTitle ?? 'Own sample'} />}
      {ownSample && onSwapSample && (
        <button
          className="pad-swap"
          onClick={e => { e.stopPropagation(); onSwapSample(); }}
          title="Swap this pad's sample with a new one from the playlist"
        >↺</button>
      )}
      {(assigned || ownSample) && (
        <button
          className="pad-clear"
          // pointerDown (not click): the pad div captures the pointer and calls
          // preventDefault on its own pointerdown, which swallows a child button's
          // click. Stopping propagation here keeps the pad from triggering and lets
          // the clear actually fire. onClear → ChopperView.onPadClear →
          // engine.clearPad(idx), which deletes this pad's buffer (and padBufferMeta,
          // which is derived from padBuffers) — or splices its chop if it has one.
          onPointerDown={e => { e.preventDefault(); e.stopPropagation(); onClear(); }}
          title="Clear this pad"
        >×</button>
      )}
    </div>
  );
}
