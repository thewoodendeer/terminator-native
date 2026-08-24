import { memo, useEffect, useReducer, useRef, useState, type CSSProperties, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { useKeepOnScreen } from '../renderer/hooks/useKeepOnScreen';

const STRIP_W_LS = 'terminator.mixer.stripWidths.v1';
import {
  MixerEngine, ChannelName, REGULAR_CHANNELS, SEND_CHANNELS,
  FADER_MIN_DB, FADER_MAX_DB, SEND_MIN_DB, CONSOLE_FLAVOURS, CONSOLE_FLAVOUR_HELP, FX_ROUTES, FX_ROUTE_HELP, type FxRoute,
  BUS_CHANNELS,
} from './MixerEngine';
import { FX_REGISTRY, FX_ORDER, FxId, ParamSpec, WET_PARAM_KEYS } from './fx';
import { MidiMapTarget } from '../renderer/chopper/MidiMap';
import type { HwPalette } from '../renderer/chopper/hwPalettes';
import { LoudnessPopup } from './LoudnessPopup';
import { LearnPicker } from '../renderer/chopper/midiLearnPick.mts';
import './MixerSection.css';

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** Pointer capture keeps a drag alive when the cursor leaves the control, but
 *  it THROWS (NotFoundError) whenever the id isn't an active pointer. Unguarded
 *  it took the rest of the handler down with it, so the fader never applied the
 *  value at all — the control looked dead rather than merely uncaptured.
 *  Capture is an optimisation; losing it must never lose the gesture. */
const capture = (e: ReactPointerEvent) => {
  try { (e.target as HTMLElement).setPointerCapture(e.pointerId); } catch { /* drag still tracks */ }
};
const release = (e: ReactPointerEvent) => {
  try { (e.target as HTMLElement).releasePointerCapture?.(e.pointerId); } catch { /* never captured */ }
};

// ── meter canvas colors — palette-aware ─────────────────────────────────────
// The VU meters are drawn on <canvas>, so a CSS var can't reach them; a Minimal
// (Baethoven) palette is threaded in and recolors them in JS instead. Original
// (no palette) keeps the exact green/amber/red literals → pixel-identical.
type MeterColors = {
  fillLo: string; fillMid: string; fillHi: string;
  gutter: string; ghost: string; peak: string;
  clipOn: string; clipOff: string; numeric: string; ticks: string;
};
const DEFAULT_METER_COLORS: MeterColors = {
  fillLo: '#35ff69', fillMid: '#e7a977', fillHi: '#ff4444',
  gutter: '#0a0e1a', ghost: 'rgba(255,255,255,0.2)', peak: '#ffffff',
  clipOn: '#ff2222', clipOff: '#241015', numeric: '#9fb0c4', ticks: '#5a6b7e',
};
function hexToRgba(hex: string, a: number): string {
  const h = hex.replace('#', '');
  const n = h.length === 3 ? h.split('').map(c => c + c).join('') : h;
  const r = parseInt(n.slice(0, 2), 16), g = parseInt(n.slice(2, 4), 16), b = parseInt(n.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${a})`;
}
// Under a Minimal palette the meters collapse to a single accent fill (no
// green/amber/red zones — mirrors HardwareView), clip alarm stays red.
function meterColorsFor(p: HwPalette | null | undefined): MeterColors {
  if (!p) return DEFAULT_METER_COLORS;
  return {
    fillLo: p.accent, fillMid: p.accent, fillHi: p.accent,
    gutter: p.bg, ghost: hexToRgba(p.muted, 0.28), peak: p.muted,
    clipOn: '#ff2222', clipOff: p.bg, numeric: p.muted, ticks: p.faint,
  };
}

interface ChMeta { label: string; color: string; }
/** Fixed table for the built-in strips. Dynamic (user-added) channels aren't in
 *  here — always go through chMeta() below, never index this directly, or a
 *  user lane reads `undefined.label` and takes the whole view down. */
const CH_META: Record<ChannelName, ChMeta> = {
  sample:  { label: 'SAMPLE',   color: '#e7a977' },
  kick:    { label: 'KICK',     color: '#ff5252' },
  snare:   { label: 'SNARE',    color: '#ff9800' },
  hat:     { label: 'HI-HAT',   color: '#4fc3f7' },
  openhat: { label: 'OPEN HAT', color: '#ce93d8' },
  perc:    { label: 'PERC',     color: '#a5d6a7' },
  bass:    { label: 'BASS',     color: '#f2c94c' },
  send1:   { label: 'SEND 1',   color: '#cf9a6f' },
  send2:   { label: 'SEND 2',   color: '#cf9a6f' },
  send3:   { label: 'SEND 3',   color: '#cf9a6f' },
  send4:   { label: 'SEND 4',   color: '#cf9a6f' },
};
const MASTER_COLOR = '#bbb8b2';

/** Label + colour for ANY channel: the fixed table first, then whatever the
 *  engine was told about a user-added lane, then a last-resort fallback so a
 *  strip can never render as a crash. */
function chMeta(engine: MixerEngine, name: ChannelName): ChMeta {
  // What the engine was told wins (a source strip's colour/label, 'sample'
  // relabelled SAMPLE 1 once other SAMPLE strips exist), then the fixed table.
  return engine.channelMeta.get(name)
    ?? CH_META[name]
    ?? { label: String(name).toUpperCase(), color: '#8899aa' };
}

const fmtDb = (db: number): string => (db <= FADER_MIN_DB + 0.4 ? '−∞' : (db >= 0 ? '+' : '') + db.toFixed(1));
const fmtPan = (p: number): string => (Math.abs(p) < 0.01 ? 'C' : p < 0 ? `L${Math.round(-p * 100)}` : `R${Math.round(p * 100)}`);

// ── Rotary knob ──────────────────────────────────────────────────────────
function Knob({ value, min, max, step, log, onChange, onReset, format, accent, bipolar, hint }: {
  value: number; min: number; max: number; step?: number; log?: boolean;
  onChange: (v: number) => void; onReset?: () => void; format: (v: number) => string; accent?: string;
  /** Tooltip prose, shown before the live value. */
  hint?: string;
  /** Centre-detent knob (pan, ± trims): the value arc grows from 12 o'clock
   *  either way instead of from the 7 o'clock stop. */
  bipolar?: boolean;
}) {
  const [drag, setDrag] = useState(false);
  const start = useRef({ y: 0, norm: 0 });
  const toNorm = (v: number) => log
    ? (Math.log(clamp(v, min, max)) - Math.log(min)) / (Math.log(max) - Math.log(min))
    : (clamp(v, min, max) - min) / (max - min);
  const fromNorm = (n: number) => {
    const c = clamp(n, 0, 1);
    let v = log ? Math.exp(Math.log(min) + c * (Math.log(max) - Math.log(min))) : min + c * (max - min);
    if (step) v = Math.round(v / step) * step;
    return clamp(v, min, max);
  };
  const norm = toNorm(value);
  const angle = -135 + norm * 270;
  // Value arc (CSS conic-gradient on ::after): start angle + sweep.
  const a0 = bipolar ? Math.min(angle, 0) : -135;
  const asw = bipolar ? Math.abs(angle) : angle + 135;
  return (
    <div
      className={`mx-knob${drag ? ' dragging' : ''}`}
      style={{ '--a0': `${a0}deg`, '--asw': `${asw}deg`, '--arc-col': accent ?? 'var(--neon, #35ff69)' } as CSSProperties}
      onPointerDown={e => {
        capture(e);
        start.current = { y: e.clientY, norm: toNorm(value) };
        setDrag(true);
      }}
      onPointerMove={e => {
        if (!drag) return;
        const dn = -(e.clientY - start.current.y) / 150;
        onChange(fromNorm(start.current.norm + dn));
      }}
      onPointerUp={e => { release(e); setDrag(false); }}
      onDoubleClick={() => onReset?.()}
      title={hint ? `${hint} — ${format(value)}` : format(value)}
    >
      <div className="mx-knob-dial">
        <div className="mx-knob-dot" style={{ transform: `rotate(${angle}deg)`, background: accent ?? '#35ff69' }} />
      </div>
      {drag && <div className="mx-knob-bubble">{format(value)}</div>}
    </div>
  );
}

// ── Vertical fader ───────────────────────────────────────────────────────
/** The fader's taper, shared with the gang logic: track position 0..1 ↔ dB.
 *  The top 20% is 0..+6 dB, the rest -60..0 (−∞ at the floor). Positions are
 *  what a pointer moves in, so a gang keeps its balance in POSITION space. */
export const faderDbToPos = (d: number) => (d >= 0 ? 0.8 + clamp(d, 0, FADER_MAX_DB) / FADER_MAX_DB * 0.2 : clamp((d + 60) / 60, 0, 1) * 0.8);
export const faderPosToDb = (p: number) => {
  const c = clamp(p, 0, 1);
  if (c >= 0.8) return (c - 0.8) / 0.2 * FADER_MAX_DB;
  const d = (c / 0.8) * 60 - 60;
  return d <= FADER_MIN_DB + 0.5 ? FADER_MIN_DB : d;
};
function Fader({ db, onChange, onDrag, onDragStart, onDragEnd, accent, learning, mapped, onMidiLearn, onMidiClear }: {
  db: number; onChange: (db: number) => void; accent: string;
  /** During a drag: the RAW track position (may run below 0 or past 1) — for a
   *  gang, so it can be dragged below the bottom and come back whole. When
   *  present it replaces onChange for drag moves; onChange still serves the
   *  menu, the reset and MIDI. */
  onDrag?: (rawPos: number) => void; onDragStart?: () => void; onDragEnd?: () => void;
  /** MIDI learn (right-click menu): pulsing ring while waiting for a CC, amber
   *  dot once mapped — the same language as the FX device-panel knobs. */
  learning?: boolean; mapped?: boolean; onMidiLearn?: () => void; onMidiClear?: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState(false);
  const [menu, setMenu] = useState(false);
  const dbToPos = faderDbToPos;
  const posToDb = faderPosToDb;
  const apply = (clientY: number) => {
    const r = ref.current?.getBoundingClientRect();
    if (!r) return;
    const raw = 1 - (clientY - r.top) / r.height;      // NOT clamped
    if (onDrag) onDrag(raw);
    else onChange(posToDb(raw));
  };
  // Type an exact value (right-click → "Set value…"). Was the double-click
  // action; double-click now resets to unity, matching the knobs/pan faders.
  const promptValue = () => {
    const v = window.prompt('Fader level (dB, or -inf):', db <= FADER_MIN_DB + 0.4 ? '-inf' : db.toFixed(1));
    if (v == null) return;
    if (/inf/i.test(v)) onChange(FADER_MIN_DB);
    else { const n = parseFloat(v); if (!Number.isNaN(n)) onChange(clamp(n, FADER_MIN_DB, FADER_MAX_DB)); }
  };
  const pos = dbToPos(db);
  return (
    <div className="mx-fader-col">
      <div
        ref={ref}
        className={`mx-fader${learning ? ' mx-param-learning' : ''}`}
        onPointerDown={e => { capture(e); setDrag(true); onDragStart?.(); apply(e.clientY); }}
        onPointerMove={e => { if (drag) apply(e.clientY); }}
        onPointerUp={e => { release(e); if (drag) onDragEnd?.(); setDrag(false); }}
        onDoubleClick={() => onChange(0)} // reset to unity (0 dB)
        onContextMenu={e => { e.preventDefault(); setMenu(true); }}
        title="Double-click to reset to 0 dB · right-click for options / MIDI Learn"
      >
        <div className="mx-fader-track">
          <div className="mx-fader-fill" style={{ height: `${pos * 100}%`, background: `linear-gradient(0deg, color-mix(in srgb, ${accent} 70%, black), ${accent})`, boxShadow: `0 0 8px color-mix(in srgb, ${accent} 40%, transparent)` }} />
          <div className="mx-fader-unity" style={{ bottom: `${faderDbToPos(0) * 100}%` }} />
        </div>
        <div className="mx-fader-thumb" style={{ bottom: `calc(${pos * 100}% - 7px)`, '--cap-line': accent } as CSSProperties} />
        {drag && <div className="mx-fader-bubble">{fmtDb(db)} dB</div>}
        {mapped && <span className="mx-midi-dot mx-fader-midi-dot" title="MIDI mapped" />}
        {learning && <span className="mx-fader-learn-hint">MOVE A FADER…</span>}
      </div>
      {menu && (
        <>
          <div className="mx-menu-backdrop" onPointerDown={() => setMenu(false)} />
          <div className="mx-fader-menu">
            <button onClick={() => { onChange(0); setMenu(false); }}>Set to 0 dB</button>
            <button onClick={() => { onChange(FADER_MIN_DB); setMenu(false); }}>Set to −∞</button>
            <button onClick={() => { setMenu(false); promptValue(); }}>Set value…</button>
            {onMidiLearn && (
              <button className="mx-midi-learn" onClick={() => { setMenu(false); onMidiLearn(); }}>MIDI Learn</button>
            )}
            {mapped && onMidiClear && (
              <button className="mx-midi-clear" onClick={() => { setMenu(false); onMidiClear(); }}>Clear MIDI</button>
            )}
          </div>
        </>
      )}
    </div>
  );
}

// ── Horizontal pan fader (replaces the rotary pan knob) ───────────────────
function PanFader({ value, onChange, onReset, accent }: {
  value: number; onChange: (v: number) => void; onReset: () => void; accent: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState(false);
  const apply = (clientX: number) => {
    const r = ref.current?.getBoundingClientRect();
    if (!r || r.width === 0) return;
    // Center detent: snap to 0 within ±3px of the track centre.
    if (Math.abs(clientX - (r.left + r.width / 2)) <= 3) { onChange(0); return; }
    onChange(clamp((clientX - r.left) / r.width, 0, 1) * 2 - 1);
  };
  const pos = (clamp(value, -1, 1) + 1) / 2; // 0 (L) … 1 (R)
  return (
    <div className="mx-pan">
      <span className="mx-pan-lbl mx-pan-lbl-l">L</span>
      <span className="mx-pan-lbl mx-pan-lbl-r">R</span>
      <div
        ref={ref}
        className="mx-pan-track"
        onPointerDown={e => { capture(e); setDrag(true); apply(e.clientX); }}
        onPointerMove={e => { if (drag) apply(e.clientX); }}
        onPointerUp={e => { release(e); setDrag(false); }}
        onDoubleClick={() => onReset()}
        onContextMenu={e => { e.preventDefault(); onReset(); }}
        title="Pan — double-click / right-click to centre"
      >
        <div className="mx-pan-center" />
        <div className="mx-pan-thumb" style={{ left: `${pos * 100}%`, borderTopColor: accent }} />
        {drag && <div className="mx-pan-bubble" style={{ left: `${pos * 100}%` }}>{fmtPan(value)}</div>}
      </div>
    </div>
  );
}

// ── One FX parameter control (device panel) ──────────────────────────────
function ParamControl({ spec, value, onChange, locked, paramKey, learning, mapped, onMidiMenu }: {
  spec: ParamSpec; value: number | string; onChange: (v: number | string) => void; locked?: boolean;
  // MIDI learn (knob / slider params only): right-click → menu, pulsing ring
  // while learning, amber dot once mapped.
  paramKey?: string; learning?: boolean; mapped?: boolean;
  onMidiMenu?: (e: ReactMouseEvent, paramKey: string) => void;
}) {
  const midiLabel = (label: string) => (
    <span className="mx-param-label">{label}{mapped && <span className="mx-midi-dot" title="MIDI mapped" />}</span>
  );
  // No MIDI learn on locked params (e.g. the send-channel WET lock).
  const midiCtx = paramKey && !locked ? (e: ReactMouseEvent) => onMidiMenu?.(e, paramKey) : undefined;
  if (spec.kind === 'select') {
    return (
      <label className="mx-param">
        <span className="mx-param-label">{spec.label}</span>
        <select className="mx-param-select" value={String(value)} disabled={locked}
          onChange={e => {
            const opt = spec.options.find(o => String(o.value) === e.target.value);
            if (opt) onChange(opt.value);
          }}>
          {spec.options.map(o => <option key={String(o.value)} value={String(o.value)}>{o.label}</option>)}
        </select>
      </label>
    );
  }
  if (spec.kind === 'toggle') {
    const on = value === spec.onValue;
    return (
      <label className="mx-param">
        <span className="mx-param-label">{spec.label}</span>
        <button className={`mx-param-toggle${on ? ' on' : ''}`} disabled={locked}
          onClick={() => onChange(on ? spec.offValue : spec.onValue)}>{on ? 'ON' : 'OFF'}</button>
      </label>
    );
  }
  const num = Number(value);
  const fmt = (v: number) => `${v.toFixed(spec.step && spec.step < 1 ? 1 : 0)}${spec.unit ? spec.unit : ''}`;
  if (spec.kind === 'knob') {
    return (
      <label className={`mx-param${learning ? ' mx-param-learning' : ''}`} onContextMenu={midiCtx}>
        {midiLabel(spec.label)}
        <Knob value={num} min={spec.min} max={spec.max} step={spec.step} log={spec.log}
          bipolar={spec.center !== undefined && spec.center > spec.min && spec.center < spec.max}
          onChange={v => !locked && onChange(v)}
          onReset={() => !locked && onChange(spec.center ?? spec.min)}
          format={fmt} />
        <span className="mx-param-val">{fmt(num)}</span>
        {learning && <span className="mx-midi-wait">Waiting for CC…</span>}
      </label>
    );
  }
  // slider — normalized 0..1000 input mapped lin/log so log scales feel right.
  const toNorm = (v: number) => spec.log
    ? (Math.log(clamp(v, spec.min, spec.max)) - Math.log(spec.min)) / (Math.log(spec.max) - Math.log(spec.min))
    : (clamp(v, spec.min, spec.max) - spec.min) / (spec.max - spec.min);
  const fromNorm = (n: number) => spec.log
    ? Math.exp(Math.log(spec.min) + n * (Math.log(spec.max) - Math.log(spec.min)))
    : spec.min + n * (spec.max - spec.min);
  return (
    <label className={`mx-param mx-param-slider${learning ? ' mx-param-learning' : ''}`} onContextMenu={midiCtx}>
      {midiLabel(spec.label)}
      <input type="range" min={0} max={1000} step={1} value={Math.round(toNorm(num) * 1000)} disabled={locked}
        onChange={e => onChange(fromNorm(Number(e.target.value) / 1000))} />
      <span className="mx-param-val">{fmt(num)}</span>
      {learning && <span className="mx-midi-wait">Waiting for CC…</span>}
    </label>
  );
}

// ── Main mixer section ───────────────────────────────────────────────────
interface Hold { peak: number; peakDb: number; peakAt: number; clip: boolean; /** performance.now() of the last true clip; the light latches then fades. */ clipAt: number; /** performance.now() of the last draw — the peak-hold decay is time-based (not per-frame: 120 Hz displays decayed it twice as fast). */ lastAt?: number; }

function MixerSectionImpl({ engine, clip, onClip, palette, transportOn }: {
  engine: MixerEngine;
  bpm?: number;
  // Master clipper (drive) — lives on the chopper engine, not the mixer, so it's
  // threaded in as props. Optional: absent in any caller that has no clipper.
  clip?: number;
  onClip?: (v: number) => void;
  /** Sequencer / drums running. A falling edge clears every strip's clip
   *  light — stopping playback resets the alarm. */
  transportOn?: boolean;
  // Active Minimal palette (desktop ChopperView). null/undefined = Original
  // theme → the mixer keeps its hardwired green/navy look. CSS surfaces retint
  // via var(--hw-*) cascade; the inline accents + canvas meters retint here.
  palette?: HwPalette | null;
  /** Bumped by the host when a channel is created or destroyed. Not read —
   *  it exists purely so a change to the module-level channel list (which React
   *  cannot observe) still forces this component to re-render. */
  channelsRev?: number;
}) {
  // Effective accent / head-fill for a Minimal palette (flatten the per-channel
  // identity colors to the monochrome palette); fall back to the original.
  const accentOr = (orig: string) => (palette ? palette.accent : orig);
  const headBgOr = (orig: string) => (palette ? palette.pad : orig);
  const [, force] = useReducer((c: number) => c + 1, 0);
  // device panels open below the strips: keys like "kick:2" or "master:0"
  const [openPanels, setOpenPanels] = useState<string[]>([]);
  // subset of openPanels that are collapsed to a thin vertical tab
  const [collapsedPanels, setCollapsedPanels] = useState<string[]>([]);
  const [names, setNames] = useState<Record<string, string>>({});
  const [renaming, setRenaming] = useState<string | null>(null);

  // ── strip sizing / sends collapse ──────────────────────────────────
  // With more channels than fit, the sends are usually the first thing you
  // aren't using — collapse them to a narrow label+fader instead of full
  // strips, and shrink everything else a notch when it's still crowded.
  const [stripSize, setStripSize] = useState<'s' | 'm' | 'l'>('m');
  const [sendsCollapsed, setSendsCollapsed] = useState(false);

  // ── multi-select ───────────────────────────────────────────────────
  // Ctrl (Windows) / Cmd (Mac) + click adds a strip to the selection; dragging
  // a box over the strips selects what it touches. Moving ANY selected fader
  // then moves them all by the same dB DELTA — relative, not absolute, so a
  // balance you've already dialled in survives the gang move.
  const [selected, setSelected] = useState<Set<ChannelName>>(new Set());
  const [marquee, setMarquee] = useState<null | { x0: number; y0: number; x1: number; y1: number }>(null);
  const stripEls = useRef(new Map<ChannelName, HTMLDivElement | null>());
  const stripsWrapRef = useRef<HTMLDivElement | null>(null);

  const toggleSelect = (name: ChannelName, additive: boolean) => {
    setSelected(prev => {
      const next = new Set(additive ? prev : []);
      if (additive && prev.has(name)) next.delete(name); else next.add(name);
      return next;
    });
  };
  // Click on a strip's title: plain = select just this one (and it becomes the
  // range anchor); Shift = select everything between the anchor and it;
  // Ctrl/Cmd = toggle it in/out. Double-click renames.
  const selAnchor = useRef<ChannelName | null>(null);
  const clickSelect = (name: ChannelName, e: { shiftKey: boolean; metaKey: boolean; ctrlKey: boolean }) => {
    if (e.metaKey || e.ctrlKey) { toggleSelect(name, true); selAnchor.current = name; return; }
    if (e.shiftKey && selAnchor.current) {
      const order = [...REGULAR_CHANNELS, ...SEND_CHANNELS];
      const a = order.indexOf(selAnchor.current), b = order.indexOf(name);
      if (a >= 0 && b >= 0) {
        const [lo, hi] = a < b ? [a, b] : [b, a];
        setSelected(new Set(order.slice(lo, hi + 1)));
        return;
      }
    }
    // Plain click on a strip that is already pushed in pops it back out (the
    // caps are buttons: click = in, click again = out — with several selected,
    // only that one leaves). A plain click on a raised one selects it alone.
    if (selected.has(name)) {
      setSelected(prev => { const n = new Set(prev); n.delete(name); return n; });
      return;
    }
    setSelected(new Set([name]));
    selAnchor.current = name;
  };
  // Renaming ends on Enter, Escape, or any click outside the box.
  const renameInput = useRef<HTMLInputElement | null>(null);
  const commitRename = (name: ChannelName, value: string) => {
    setNames(n => ({ ...n, [name]: value.trim() || chMeta(engine, name).label }));
    setRenaming(null);
  };
  useEffect(() => {
    if (!renaming) return;
    const name = renaming;
    const onDown = (ev: PointerEvent) => {
      const t = ev.target as HTMLElement | null;
      if (t && t.closest('.mx-head-edit')) return;
      // Commit directly — don't rely on blur (an input that never took focus
      // never blurs, and the box used to stay open forever).
      commitRename(name, renameInput.current?.value ?? '');
    };
    document.addEventListener('pointerdown', onDown, true);
    return () => document.removeEventListener('pointerdown', onDown, true);
  }, [renaming]);

  // ── per-strip widths (drag the strip's right edge) ─────────────────
  // Dragging the edge of a SELECTED strip resizes every selected strip
  // together. Cleared by the S/M/L buttons. Persisted.
  const [stripW, setStripW] = useState<Record<string, number>>(() => {
    try { return JSON.parse(localStorage.getItem(STRIP_W_LS) || '{}') || {}; } catch { return {}; }
  });
  useEffect(() => { try { localStorage.setItem(STRIP_W_LS, JSON.stringify(stripW)); } catch { /* */ } }, [stripW]);
  const startResize = (name: ChannelName, e: ReactPointerEvent) => {
    e.preventDefault(); e.stopPropagation();
    const targets = selected.has(name) && selected.size > 1 ? [...selected] : [name];
    const startX = e.clientX;
    const startW = new Map(targets.map(n => [n, stripEls.current.get(n)?.getBoundingClientRect().width ?? 76]));
    const el = e.currentTarget as HTMLElement;
    try { el.setPointerCapture(e.pointerId); } catch { /* */ }
    const onMove = (ev: PointerEvent) => {
      const dx = ev.clientX - startX;
      setStripW(w => {
        const next = { ...w };
        for (const n of targets) next[n] = clamp((startW.get(n) ?? 76) + dx, 44, 260);
        return next;
      });
    };
    const onUp = () => {
      el.removeEventListener('pointermove', onMove);
      el.removeEventListener('pointerup', onUp);
      el.removeEventListener('pointercancel', onUp);
    };
    el.addEventListener('pointermove', onMove);
    el.addEventListener('pointerup', onUp);
    el.addEventListener('pointercancel', onUp);
  };

  /** Apply a fader move (dB) to every selected strip — the NON-drag path
   *  (MIDI, the menu, a reset). `name` is the one being moved; when it isn't
   *  part of the selection this is an ordinary single move. The group moves
   *  by a shared dB delta, each member clamped. */
  const applyFader = (name: ChannelName, db: number) => {
    const strip = engine.getChannel(name);
    // scheduleForce (≤1 re-render/frame): the fader's audio param is applied
    // right here; a 120 Hz mouse used to re-render every strip per pointer move.
    if (!selected.has(name) || selected.size <= 1) { strip.setFaderDb(db); scheduleForce(); return; }
    const delta = clamp(db, FADER_MIN_DB, FADER_MAX_DB) - strip.faderDb;
    for (const n of selected) {
      const s = engine.getChannel(n);
      s.setFaderDb(clamp(s.faderDb + delta, FADER_MIN_DB, FADER_MAX_DB));
    }
    scheduleForce();
  };

  /** A GANG DRAG KEEPS ITS BALANCE — PAST THE RAILS. The Extractor's mixer and
   *  THE BOARD's desk both work this way (Victor: "make sure this is how the
   *  mixer works in the board as well" — it already did; this is the Chopper
   *  catching up). At drag start every selected fader's POSITION on its track
   *  is snapshotted; each move sets member j to start_j + (rawPos − start_i)
   *  where rawPos is the dragged fader's UNCLAMPED pointer position, and only
   *  the applied dB is clamped. So faders floor one by one going down while
   *  the rest keep travelling, the dragged one runs "below the bottom", and
   *  coming back up they lift off one by one in reverse — the balance is
   *  preserved by construction. Position space, not dB, because that is what
   *  the pointer moves in (the taper is non-linear). Previously the whole
   *  group stopped at the first rail. */
  const gangStart = useRef<Map<ChannelName, number> | null>(null);   // name → track position at drag start
  const gangDragStart = (name: ChannelName) => {
    if (!selected.has(name) || selected.size <= 1) { gangStart.current = null; return; }
    gangStart.current = new Map([...selected].map(n => [n, faderDbToPos(engine.getChannel(n).faderDb)]));
  };
  const gangDragEnd = () => { gangStart.current = null; };
  const dragFader = (name: ChannelName, rawPos: number) => {
    const s = gangStart.current;
    if (!s || !s.has(name)) { applyFader(name, faderPosToDb(rawPos)); return; }
    const d = rawPos - s.get(name)!;
    for (const [n, startPos] of s) engine.getChannel(n).setFaderDb(faderPosToDb(startPos + d));
    scheduleForce();
  };

  // ── MIDI learn for FX device-panel params (knobs / sliders) ──
  // mappings persist while the page is open (not saved to preset yet):
  //   paramKey `${ch}:${fxIdx}:${param}` → { midiCh, cc, fxId }
  // fxId is captured so an incoming CC only drives the SAME effect it was learnt
  // on — guards against the chain being rebuilt under it (preset restore, etc.).
  // Keys: `${ch}:${fxIdx}:${param}` for FX params (fxId guards staleness) and
  // `fader:${ch}` (ch = channel name or 'master') for the strip faders.
  // Persisted in localStorage so a controller layout survives a reload.
  type MidiMapping = { midiCh: number; cc: number; fxId?: FxId };
const MIDI_MAP_LS = 'terminator.mixer.midiMap.v1';
  const midiMappings = useRef<Map<string, MidiMapping>>(new Map());
  const midiMapLoaded = useRef(false);
  if (!midiMapLoaded.current) {
    midiMapLoaded.current = true;
    try {
      const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(MIDI_MAP_LS) : null;
      if (raw) {
        const obj = JSON.parse(raw) as Record<string, MidiMapping>;
        for (const [k, v] of Object.entries(obj)) {
          if (v && Number.isFinite(v.cc) && Number.isFinite(v.midiCh)) midiMappings.current.set(k, v);
        }
      }
    } catch { /* ignore a bad blob */ }
  }
  const saveMidiMap = () => {
    try { localStorage.setItem(MIDI_MAP_LS, JSON.stringify(Object.fromEntries(midiMappings.current))); } catch { /* */ }
  };
  const isFaderKey = (k: string) => k.startsWith('fader:');
  const [learnTarget, setLearnTarget] = useState<string | null>(null); // paramKey currently learning
  const learnTargetRef = useRef<string | null>(null);
  const learnPicker = useRef(new LearnPicker());
  const setLearn = (key: string | null) => { learnTargetRef.current = key; setLearnTarget(key); learnPicker.current.reset(); };
  const [midiMenu, setMidiMenu] = useState<{ paramKey: string; x: number; y: number } | null>(null);
  const midiMenuRef = useRef<HTMLDivElement>(null);
  useKeepOnScreen(midiMenuRef, midiMenu ? `${midiMenu.x},${midiMenu.y}` : null);
  // Coalesce the visual refresh during a fast CC sweep to ≤1 re-render / frame
  // (the audio param is applied immediately; force() only refreshes the readout).
  const forceRaf = useRef(0);
  const scheduleForce = () => {
    if (forceRaf.current) return;
    forceRaf.current = requestAnimationFrame(() => { forceRaf.current = 0; force(); });
  };

  // ── drag-to-reorder the FX insert chain (pointer-based, one strip at a time) ──
  // state = render mirror (drives placeholder / floating ghost / drop line);
  // ref = live geometry read by the window pointer handlers.
  const [fxDrag, setFxDrag] = useState<null | { key: string; from: number; over: number; topPx: number; step: number; gap: number }>(null);
  // Cmd/Ctrl-drag COPY of an effect: a ghost follows the pointer anywhere over
  // the mixer; releasing over a strip's insert chain duplicates the effect
  // (params + bypass) into that strip's next free slot. Same strip = duplicate.
  const [fxCopy, setFxCopy] = useState<null | { fxId: FxId; params: Record<string, number | string>; bypassed: boolean; x: number; y: number; over: string | null; overFull: boolean }>(null);
  const fxCopyRef = useRef<typeof fxCopy>(null);
  const fxDragRef = useRef<null | {
    key: string; from: number; filled: number; chainTop: number; grabDy: number;
    step: number; slotH: number; gap: number; over: number; topPx: number;
  }>(null);

  const canvasRefs = useRef<Map<string, HTMLCanvasElement | null>>(new Map());
  const holds = useRef<Map<string, Hold>>(new Map());
  const [loudOpen, setLoudOpen] = useState(false);
  const lufsRefs = useRef<{ m: HTMLSpanElement | null; s: HTMLSpanElement | null; i: HTMLSpanElement | null; tp: HTMLSpanElement | null }>({ m: null, s: null, i: null, tp: null });
  // SC COMP gain-reduction readouts, keyed by open-panel key — painted from the
  // meter loop (no React state per frame).
  const scGrRefs = useRef(new Map<string, HTMLSpanElement | null>());
  // Latest meter colors for the rAF paint loop (which subscribes on [engine]
  // only) — recompute each render, read .current inside paint so a palette
  // change retints the canvas without tearing down the animation loop.
  const meterColorsRef = useRef<MeterColors>(DEFAULT_METER_COLORS);
  meterColorsRef.current = meterColorsFor(palette);

  // ── meter / LUFS animation loop ──────────────────────────────────────
  useEffect(() => {
    let raf = 0;
    let timer = 0;
    const lastLvl = new Map<string, string>();
    const lastTxt = new Map<HTMLElement, string>();
    const setTxt = (el: HTMLElement | null, txt: string) => {
      if (!el || lastTxt.get(el) === txt) return;
      lastTxt.set(el, txt); el.textContent = txt;
    };
    let loud = 0;   // polls since anything on any strip was above the floor
    // Strips whose last draw was the settled-silent frame (no signal, peak-hold
    // decayed, clip light out). That frame is pixel-identical every time, so
    // while a strip stays settled its canvas work is skipped entirely — the
    // levels are still polled, so the first real sample wakes it on that frame.
    // (Eleven canvases were being cleared and redrawn ~15×/s in silence.)
    const settledDrawn = new Set<string>();
    const paintMeter = (key: string, lv: { preL: number; preR: number; postL: number; postR: number }, now: number): boolean => {
      const cv = canvasRefs.current.get(key);
      if (!cv) return false;
      let hold = holds.current.get(key);
      if (!hold) { hold = { peak: 0, peakDb: -Infinity, peakAt: 0, clip: false, clipAt: 0 }; holds.current.set(key, hold); }
      const live = lv.postL > 1e-4 || lv.postR > 1e-4 || lv.preL > 1e-4 || lv.preR > 1e-4;
      const settled = !live && hold.peakDb <= MIN_METER_DB && !hold.clip;
      if (settled && settledDrawn.has(key)) return false;
      drawMeter(cv, lv, hold, now, meterColorsRef.current);
      if (settled) settledDrawn.add(key); else settledDrawn.delete(key);
      // 4K finish: the meter is a light. Publish its post-fader level (0..1)
      // as a CSS var so the LED glow around it can breathe with the signal —
      // but only when it CHANGES: a style write per canvas per frame forced a
      // style/paint pass at 60 Hz even in silence.
      const post = Math.max(lv.postL, lv.postR);
      const lvl = dbFrac(lin2db(post)).toFixed(2);
      if (lastLvl.get(key) !== lvl) { lastLvl.set(key, lvl); cv.style.setProperty('--lvl', lvl); }
      return live;
    };
    // Live signal → rAF (meters track the display's refresh). Settled silence →
    // a 20 Hz TIMER: a rAF loop makes the renderer run a full frame lifecycle
    // every refresh (120×/s on ProMotion) even when nothing is drawn, which was
    // ~10% of a core at idle. The first real sample flips it back to rAF within
    // one poll (≤ 50 ms).
    const schedule = () => {
      if (loud > 60) timer = window.setTimeout(paint, 50);
      else raf = requestAnimationFrame(paint);
    };
    const paint = () => {
      raf = 0; timer = 0;
      // Nothing mounted (mixer collapsed / off-screen) → nothing to read.
      if (canvasRefs.current.size === 0) { loud = 61; schedule(); return; }
      const now = performance.now();
      let any = false;
      for (const name of [...REGULAR_CHANNELS, ...SEND_CHANNELS]) {
        const ch = engine.getChannel(name);
        // Ride the meter loop rather than adding a timer — the gain-match
        // corrector is deliberately slow, so ~60Hz sampling is far more than
        // it needs and costs one extra RMS pass per strip only while it's on.
        ch.updateGainMatch();
        if (paintMeter(name, ch.levels(), now)) any = true;
      }
      const ml = engine.master.levels();
      if (paintMeter('master', ml, now)) any = true;
      loud = any ? 0 : loud + 1;
      const lu = engine.master.updateLoudness();
      const r = lufsRefs.current;
      const lf = (v: number) => (v === -Infinity || Number.isNaN(v) ? '−∞' : v.toFixed(1));
      setTxt(r.m, lf(lu.m));
      setTxt(r.s, lf(lu.s));
      setTxt(r.i, lf(lu.i));
      if (r.tp) { const tpLin = lu.worklet ? lu.holdTp : ml.truePeak; const tpDb = tpLin > 0 ? 20 * Math.log10(tpLin) : -Infinity; setTxt(r.tp, tpDb === -Infinity ? '−∞' : tpDb.toFixed(1)); }
      for (const [pk, el] of scGrRefs.current) {
        if (!el) continue;
        const [chn, idxStr] = pk.split(':');
        const strip = chn === 'master' ? engine.master : engine.channels.get(chn);
        const fx = strip?.fx[Number(idxStr)] as { gainReductionDb?: number } | undefined;
        setTxt(el, `${(fx?.gainReductionDb ?? 0).toFixed(1)} dB`);
      }
      schedule();
    };
    schedule();
    return () => { cancelAnimationFrame(raf); clearTimeout(timer); };
  }, [engine]);

  // Stopping the transport clears every clip light (a latched red from the
  // last run shouldn't outlive the take).
  const prevTransport = useRef(!!transportOn);
  useEffect(() => {
    if (prevTransport.current && !transportOn) {
      for (const h of holds.current.values()) { h.clip = false; h.clipAt = 0; }
    }
    prevTransport.current = !!transportOn;
  }, [transportOn]);

  const togglePanel = (key: string) =>
    setOpenPanels(p => {
      if (p.includes(key)) { setCollapsedPanels(c => c.filter(k => k !== key)); return p.filter(k => k !== key); }
      return [...p, key];
    });
  const closePanelsFor = (prefix: string) => {
    setOpenPanels(p => p.filter(k => !k.startsWith(prefix + ':')));
    setCollapsedPanels(c => c.filter(k => !k.startsWith(prefix + ':')));
  };
  const toggleCollapse = (key: string) =>
    setCollapsedPanels(c => (c.includes(key) ? c.filter(k => k !== key) : [...c, key]));
  // The FX name TOGGLES its device panel (togglePanel): click opens it, click
  // again closes it. The panel's own ✕ also closes it, and removing the FX
  // closes it too.

  const openMidiMenu = (e: ReactMouseEvent, paramKey: string) => {
    e.preventDefault();
    // Clamp to the viewport so the popup never opens off the right/bottom edge.
    const MENU_W = 130, MENU_H = 64;
    const x = Math.min(e.clientX, window.innerWidth - MENU_W - 8);
    const y = Math.min(e.clientY, window.innerHeight - MENU_H - 8);
    setMidiMenu({ paramKey, x: Math.max(8, x), y: Math.max(8, y) });
  };

  // Reorder a strip's FX, then realign this strip's index-keyed UI state
  // (open / collapsed panels, MIDI maps, learn target) to the new positions.
  const reorderFx = (key: string, from: number, to: number) => {
    if (from === to) return;
    engine.reorderFX(key, from, to);
    const remap = (i: number) => {
      if (i === from) return to;
      if (from < to) return i > from && i <= to ? i - 1 : i;
      return i >= to && i < from ? i + 1 : i;
    };
    const rekey = (k: string) => {
      const parts = k.split(':');
      if (parts[0] !== key) return k;
      parts[1] = String(remap(Number(parts[1])));
      return parts.join(':');
    };
    setOpenPanels(p => p.map(rekey));
    setCollapsedPanels(c => c.map(rekey));
    const nm = new Map<string, MidiMapping>();
    for (const [k, m] of midiMappings.current) nm.set(rekey(k), m);
    midiMappings.current = nm;
    saveMidiMap();
    if (learnTargetRef.current && learnTargetRef.current.split(':')[0] === key) setLearn(rekey(learnTargetRef.current));
    force();
  };

  // Begin a pointer drag from a slot's grip. Window listeners (the effect below)
  // own move/up so the gesture survives the dragged slot re-rendering.
  const fxDragStart = (e: ReactPointerEvent, key: string, from: number) => {
    if (e.metaKey || e.ctrlKey) return;                  // Cmd/Ctrl = COPY drag (slot handler)
    if (fxDragRef.current) return;                       // one drag at a time
    const slotEl = (e.currentTarget as HTMLElement).closest('.mx-fx-slot') as HTMLElement | null;
    const chainEl = slotEl?.closest('.mx-fx-chain') as HTMLElement | null;
    if (!slotEl || !chainEl) return;
    const slotRect = slotEl.getBoundingClientRect();
    const chainRect = chainEl.getBoundingClientRect();
    const gap = parseFloat(getComputedStyle(chainEl).rowGap) || 2;
    const slotH = slotRect.height;
    const filled = (key === 'master' ? engine.master : engine.getChannel(key as ChannelName)).fx.length;
    const topPx = slotRect.top - chainRect.top;
    fxDragRef.current = {
      key, from, filled, chainTop: chainRect.top, grabDy: e.clientY - slotRect.top,
      step: slotH + gap, slotH, gap, over: from, topPx,
    };
    setFxDrag({ key, from, over: from, topPx, step: slotH + gap, gap });
    e.preventDefault();
  };

  // FX removal splices the chain (indices shift), so reindex this strip's MIDI
  // mappings: drop the removed FX's, shift higher ones down by one.
  const reindexMappings = (chKey: string, removedIdx: number) => {
    const next = new Map<string, MidiMapping>();
    for (const [k, m] of midiMappings.current) {
      const parts = k.split(':');
      if (parts[0] !== chKey) { next.set(k, m); continue; }
      const i = Number(parts[1]);
      if (i === removedIdx) continue;
      const ni = i > removedIdx ? i - 1 : i;
      next.set(`${parts[0]}:${ni}:${parts.slice(2).join(':')}`, m);
    }
    midiMappings.current = next;
    saveMidiMap();
    if (learnTargetRef.current?.startsWith(`${chKey}:`)) setLearn(null);
  };

  // Apply an incoming CC value (0..127) to a mapped knob/slider param.
  // expectFxId = the effect the mapping was learnt on; we only drive that exact
  // effect at that index (the chain can be rebuilt under us — preset restore).
  const applyCcToParam = (paramKey: string, val127: number, expectFxId?: FxId) => {
    if (isFaderKey(paramKey)) {
      // CC travel follows the on-screen fader taper (faderPosToDb), so a
      // hardware fader at half-way lands where the mouse would.
      const ch = paramKey.slice('fader:'.length);
      const db = faderPosToDb(val127 / 127);
      if (ch === 'master') engine.master.setFaderDb(db);
      else if (engine.channels.has(ch as ChannelName)) applyFader(ch as ChannelName, db);
      scheduleForce();
      return;
    }
    if (!expectFxId) return;
    const parts = paramKey.split(':');
    const ch = parts[0]; const fxIdx = Number(parts[1]); const param = parts.slice(2).join(':');
    const strip = ch === 'master' ? engine.master : engine.getChannel(ch as ChannelName);
    if (strip.fxIds[fxIdx] !== expectFxId) return;                 // stale: FX removed / replaced
    // Honour the send-channel WET lock (UI + addFx force WET=100 on aux returns).
    if (SEND_CHANNELS.includes(ch as ChannelName) && WET_PARAM_KEYS.has(param)) return;
    const spec = FX_REGISTRY[expectFxId].params.find(p => p.key === param);
    if (!spec || (spec.kind !== 'knob' && spec.kind !== 'slider')) return;
    const n = val127 / 127;
    let v = spec.log
      ? Math.exp(Math.log(spec.min) + n * (Math.log(spec.max) - Math.log(spec.min)))
      : spec.min + n * (spec.max - spec.min);
    if (spec.step) v = Math.round(v / spec.step) * spec.step;
    strip.setFxParam(fxIdx, param, v);
    scheduleForce();
  };

  // ── Web MIDI: learn + live CC control of FX params ──────────────────────
  // Self-contained (mirrors ChopperView's requestMIDIAccess usage). Uses
  // addEventListener for BOTH 'midimessage' and 'statechange' so it never
  // clobbers ChopperView's `onmidimessage` / `onstatechange` on the shared
  // singleton MIDIAccess (assigning those properties would wipe the other).
  useEffect(() => {
    const nav = navigator as unknown as { requestMIDIAccess?: (o?: { sysex: boolean }) => Promise<any> };
    if (!nav.requestMIDIAccess) return;
    let access: any = null;
    let cancelled = false;
    const onMidi = (e: any) => {
      const d = e.data; if (!d || d.length < 3) return;
      if ((d[0] & 0xf0) !== 0xb0) return;               // control-change only
      const midiCh = d[0] & 0x0f, cc = d[1], val = d[2];
      const learning = learnTargetRef.current;
      if (learning) {                                    // map the next REAL control to this param
        // Not every CC is the control: skip 14-bit LSB partners and button-style
        // 0/127 blips until a continuous value shows (midiLearnPick.ts) — a
        // Launchkey fader learnt onto its side-message read as ON/OFF.
        if (!learnPicker.current.feed(midiCh, cc, val, performance.now())) return;
        if (isFaderKey(learning)) {
          midiMappings.current.set(learning, { midiCh, cc });
        } else {
          const lp = learning.split(':');
          const lstrip = lp[0] === 'master' ? engine.master : engine.getChannel(lp[0] as ChannelName);
          const lFxId = lstrip.fxIds[Number(lp[1])];
          if (lFxId) midiMappings.current.set(learning, { midiCh, cc, fxId: lFxId });
        }
        saveMidiMap();
        setLearn(null);
        force();
        return;
      }
      for (const [key, m] of midiMappings.current) {
        if (m.cc === cc && m.midiCh === midiCh) applyCcToParam(key, val, m.fxId);
      }
    };
    const onState = () => attach(access);                // pick up newly-connected inputs
    const attach = (acc: any) => acc?.inputs.forEach((i: any) => i.addEventListener('midimessage', onMidi));
    nav.requestMIDIAccess({ sysex: false }).then((acc: any) => {
      if (cancelled) return;
      access = acc;
      attach(acc);                                       // addEventListener is idempotent for the same fn
      acc.addEventListener('statechange', onState);
    }).catch(() => { /* MIDI unavailable / denied */ });
    return () => {
      cancelled = true;
      if (access) {
        access.inputs.forEach((i: any) => i.removeEventListener('midimessage', onMidi));
        access.removeEventListener('statechange', onState);
      }
    };
  }, [engine]); // eslint-disable-line react-hooks/exhaustive-deps

  // Cancel any pending coalesced refresh on unmount.
  useEffect(() => () => { if (forceRaf.current) cancelAnimationFrame(forceRaf.current); }, []);

  // Escape cancels an open MIDI menu and/or learn mode.
  useEffect(() => {
    if (!midiMenu && !learnTarget) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { setMidiMenu(null); setLearn(null); } };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [midiMenu, learnTarget]);

  // FX-reorder drag: window-level move/up so the gesture survives the dragged
  // slot unmounting (it becomes a placeholder + a floating ghost on drag start).
  const fxDragging = !!fxDrag;
  useEffect(() => {
    if (!fxDragging) return;
    const onMove = (e: PointerEvent) => {
      const d = fxDragRef.current; if (!d) return;
      const rawTop = e.clientY - d.chainTop - d.grabDy;
      // over (insertion index 0..filled) from the raw position so the very-end
      // drop is reachable; the ghost top is clamped to stay over a real slot.
      const over = clamp(Math.round(rawTop / d.step), 0, d.filled);
      const topPx = clamp(rawTop, 0, Math.max(0, (d.filled - 1) * d.step));
      d.over = over; d.topPx = topPx;
      setFxDrag(prev => (prev ? { ...prev, over, topPx } : prev));
    };
    const onUp = () => {
      const d = fxDragRef.current;
      if (d) { const to = d.over > d.from ? d.over - 1 : d.over; reorderFx(d.key, d.from, to); }
      fxDragRef.current = null;
      setFxDrag(null);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
    };
  }, [fxDragging]); // eslint-disable-line react-hooks/exhaustive-deps

  // Cmd/Ctrl + press on a filled slot → copy-drag.
  const fxCopyStart = (e: ReactPointerEvent, key: string, idx: number) => {
    if (!(e.metaKey || e.ctrlKey) || e.button !== 0) return;
    if (fxCopyRef.current || fxDragRef.current) return;
    const strip = key === 'master' ? engine.master : engine.getChannel(key as ChannelName);
    const fxId = strip.fxIds[idx]; const fx = strip.fx[idx];
    if (!fxId || !fx) return;
    e.preventDefault(); e.stopPropagation();
    const st = { fxId, params: { ...fx.params }, bypassed: !!strip.fxBypassed[idx], x: e.clientX, y: e.clientY, over: null, overFull: false };
    fxCopyRef.current = st;
    setFxCopy(st);
  };
  const fxCopying = !!fxCopy;
  useEffect(() => {
    if (!fxCopying) return;
    const chainUnder = (x: number, y: number): { key: string; full: boolean } | null => {
      const el = document.elementFromPoint(x, y) as HTMLElement | null;
      const chain = el?.closest('.mx-fx-chain') as HTMLElement | null;
      const key = chain?.dataset.ch;
      if (!key) return null;
      const strip = key === 'master' ? engine.master : engine.channels.get(key);
      if (!strip) return null;
      return { key, full: strip.fx.length >= 8 };
    };
    const onMove = (e: PointerEvent) => {
      const c = fxCopyRef.current; if (!c) return;
      const t = chainUnder(e.clientX, e.clientY);
      const next = { ...c, x: e.clientX, y: e.clientY, over: t?.key ?? null, overFull: !!t?.full };
      fxCopyRef.current = next;
      setFxCopy(next);
    };
    const onUp = () => {
      const c = fxCopyRef.current;
      fxCopyRef.current = null;
      setFxCopy(null);
      if (!c || !c.over || c.overFull) return;
      const strip = c.over === 'master' ? engine.master : engine.getChannel(c.over as ChannelName);
      const idx = strip.addFx(c.fxId);
      if (idx < 0) return;
      const isSend = SEND_CHANNELS.includes(c.over as ChannelName);
      for (const [k, v] of Object.entries(c.params)) {
        if (isSend && WET_PARAM_KEYS.has(k)) continue;   // aux returns stay 100 % wet
        strip.setFxParam(idx, k, v);
      }
      if (c.bypassed) strip.toggleBypass(idx);
      force();
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
    };
  }, [fxCopying]); // eslint-disable-line react-hooks/exhaustive-deps

  const resetMeter = (key: string) => {
    const h = holds.current.get(key);
    if (h) { h.peak = 0; h.peakDb = -Infinity; h.peakAt = 0; h.clip = false; h.clipAt = 0; }
  };

  // ── render one channel/send strip ────────────────────────────────────
  const renderStrip = (name: ChannelName) => {
    const strip = engine.getChannel(name);
    const meta = chMeta(engine, name);
    const isSend = SEND_CHANNELS.includes(name);
    const nm = names[name] ?? meta.label;
    const w = stripW[name];
    // NARROW: below ~66px the separate fader column can't fit beside the meter
    // (the cap ran into the next strip) — the fader becomes a thin line riding
    // ON the meter instead (CSS .mx-strip--narrow), still draggable.
    const effW = w ?? (stripSize === 's' ? (isSend ? 56 : 58) : stripSize === 'l' ? (isSend ? 128 : 132) : (isSend ? 74 : 76));
    const narrow = effW < 66;
    return (
      <div
        className={`mx-strip${isSend ? ' mx-strip-send' : ''}${BUS_CHANNELS.includes(name) ? ' mx-strip-bus' : ''}${selected.has(name) ? ' mx-strip-sel' : ''}${narrow ? ' mx-strip--narrow' : ''}`}
        key={name}
        ref={el => { stripEls.current.set(name, el); }}
        style={w ? { flex: `0 0 ${w}px`, minWidth: w, maxWidth: w } : undefined}
      >
        <div
          className="mx-head"
          style={{ background: headBgOr(meta.color) }}
          // Click = select this strip; Shift+click = range from the last one you
          // clicked; Ctrl/Cmd+click = toggle. Double-click = rename.
          onPointerDown={e => {
            if (renaming === name) return;
            if (e.button !== 0) return;
            e.preventDefault(); e.stopPropagation();
            clickSelect(name, e);
          }}
          onDoubleClick={e => { e.stopPropagation(); setRenaming(name); }}
        >
          {renaming === name ? (
            <input className="mx-head-edit" autoFocus defaultValue={nm}
              ref={renameInput}
              onBlur={e => commitRename(name, e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') commitRename(name, (e.target as HTMLInputElement).value); if (e.key === 'Escape') setRenaming(null); }} />
          ) : (
            <span className="mx-head-name"
              title="Click to select (click again to deselect) · Shift+click for a range · Ctrl/Cmd+click to add · double-click to rename. Selected faders move together; drag a strip's right edge to resize (all selected resize together)">{nm}</span>
          )}
        </div>
        <div className="mx-strip-resize" onPointerDown={e => startResize(name, e)} title="Drag to resize this strip (selected strips resize together)" />
        {renderFxChain(name, strip.fxIds, strip.fxBypassed)}
        {/* Meter + fader sit side-by-side (Ableton layout): meter left, fader
            right, sharing the same vertical space. */}
        <div className="mx-meter-fader-row">
          <canvas
            className="mx-meter"
            width={42}
            height={196}
            ref={el => { if (el) canvasRefs.current.set(name, el); else canvasRefs.current.delete(name); }}
            onClick={() => resetMeter(name)}
            title="Click to reset peak / clip"
          />
          <MidiMapTarget parameterId={`mixer.${name}`} min={FADER_MIN_DB} max={FADER_MAX_DB}
            onChange={db => applyFader(name, db)} style={{ display: 'flex' }}>
            <Fader db={strip.faderDb} accent={accentOr(meta.color)}
              onChange={db => applyFader(name, db)}
              onDrag={p => dragFader(name, p)} onDragStart={() => gangDragStart(name)} onDragEnd={gangDragEnd}
              learning={learnTarget === `fader:${name}`}
              mapped={midiMappings.current.has(`fader:${name}`)}
              onMidiLearn={() => setLearn(`fader:${name}`)}
              onMidiClear={() => { midiMappings.current.delete(`fader:${name}`); saveMidiMap(); force(); }} />
          </MidiMapTarget>
        </div>
        <PanFader value={strip.pan} accent={accentOr(meta.color)}
          onChange={v => { strip.setPan(v); force(); }}
          onReset={() => { strip.setPan(0); force(); }} />
        <div className="mx-ms-row">
          <button className={`mx-ms mx-mute${strip.muted ? ' on' : ''}`}
            title={`Mute ${name} — silence this channel (mutes are printed into exports)`}
            onClick={() => { strip.setMuted(!strip.muted); engine.applySolo(); force(); }}>M</button>
          <button className={`mx-ms mx-solo${strip.soloed ? ' on' : ''}`}
            title={`Solo ${name} — hear this channel on its own. Alt-click to solo it exclusively`}
            onClick={e => {
              if (e.altKey) engine.soloExclusive(name);
              else { strip.setSoloed(!strip.soloed); engine.applySolo(); }
              force();
            }}>S</button>
        </div>
        {!isSend && (
          <div className="mx-sends">
            {[0, 1, 2, 3].map(i => (
              <div className="mx-send" key={i}>
                <span className="mx-send-lbl" title={`SEND ${i + 1} — how much of ${name} goes to the SEND ${i + 1} return strip (put the reverb / delay THERE, on the return, and it stays 100 % wet); drag up to feed it, double-click = off. A return that nothing feeds stays silent and is left out of Trackouts`}>S{i + 1}</span>
                <Knob value={strip.sendDbs[i]} min={SEND_MIN_DB} max={FADER_MAX_DB} step={0.5}
                  onChange={v => { strip.setSend(i, v); force(); }}
                  onReset={() => { strip.setSend(i, SEND_MIN_DB); force(); }}
                  hint={`SEND ${i + 1} level from ${name} (double-click = off)`}
                  format={d => fmtDb(d)} accent={accentOr('#35ff69')} />
              </div>
            ))}
          </div>
        )}
      </div>
    );
  };

  // ── FX insert chain (shared by channels + master) ────────────────────
  const renderFxChain = (key: string, fxIds: FxId[], bypassed: boolean[], isMaster = false) => {
    const strip = isMaster ? engine.master : engine.getChannel(key as ChannelName);
    const chColor = accentOr(isMaster ? MASTER_COLOR : chMeta(engine, key as ChannelName).color);
    const dragging = fxDrag?.key === key;
    // Inner contents of a filled slot (grip · bypass square · name · remove) —
    // shared by the in-flow slot and the floating drag ghost.
    const slotInner = (idx: number) => (
      <>
        <span className="mx-fx-grip" title="Drag to reorder"
          onPointerDown={e => fxDragStart(e, key, idx)}>⠿</span>
        <button
          className={`mx-fx-sq${bypassed[idx] ? '' : ' on'}`}
          style={bypassed[idx] ? undefined : { background: chColor, borderColor: chColor }}
          title={bypassed[idx] ? 'Bypassed — click to enable' : 'Active — click to bypass'}
          onClick={e => { e.stopPropagation(); if (e.metaKey || e.ctrlKey) return; strip.toggleBypass(idx); force(); }} />
        <span className="mx-fx-name" onClick={e => { if (e.metaKey || e.ctrlKey) return; togglePanel(`${key}:${idx}`); }}
          title={`${FX_REGISTRY[fxIds[idx]!].desc} · click to open its panel`}>{FX_REGISTRY[fxIds[idx]!].name}</span>
        <button className="mx-fx-rm" title="Remove"
          onClick={e => {
            e.stopPropagation();
            if (e.metaKey || e.ctrlKey) return;
            setOpenPanels(p => p.filter(k => k !== `${key}:${idx}`));
            reindexMappings(key, idx); // keep MIDI maps aligned to the spliced chain
            strip.removeFx(idx);
            closePanelsFor(key); // indices shift — drop this strip's open panels
            force();
          }}>✕</button>
      </>
    );
    // Always render exactly 8 fixed slots so the strip height never changes
    // with the insert count. FX live at contiguous indices 0..n-1 (filled
    // slots); every remaining slot is an INSERT FX dropdown. When all 8 are
    // filled there are no empty slots, so no further FX can be added.
    const copyOver = fxCopy?.over === key;
    return (
      <div className={`mx-fx-chain${copyOver ? (fxCopy!.overFull ? ' mx-fx-copy-full' : ' mx-fx-copy-over') : ''}`} data-ch={key}>
        {Array.from({ length: 8 }, (_, idx) => {
          const id = fxIds[idx];
          // dragged slot leaves a placeholder gap in its original position
          if (dragging && idx === fxDrag!.from) return <div className="mx-fx-slot placeholder" key={idx} />;
          if (id) {
            const open = openPanels.includes(`${key}:${idx}`);
            return (
              <div className={`mx-fx-slot${bypassed[idx] ? ' bypassed' : ''}${open ? ' open' : ''}`} key={idx}
                onPointerDown={e => fxCopyStart(e, key, idx)}
                title="Cmd/Ctrl+drag to copy this effect to any strip">
                {slotInner(idx)}
              </div>
            );
          }
          return (
            <select className="mx-fx-add" key={idx} value=""
              title="Add an insert effect to this channel — it processes the signal here, before the fader"
              onChange={e => {
                const fxId = e.target.value as FxId;
                if (!fxId) return;
                strip.addFx(fxId);
                force();
                e.currentTarget.value = '';
              }}>
              <option value="">＋ INSERT FX</option>
              {FX_ORDER.map(fxId => <option key={fxId} value={fxId} title={FX_REGISTRY[fxId].desc}>{FX_REGISTRY[fxId].name}</option>)}
            </select>
          );
        })}
        {dragging && (
          <>
            <div className="mx-fx-slot dragging" style={{ position: 'absolute', left: 0, right: 0, top: fxDrag!.topPx }}>
              {slotInner(fxDrag!.from)}
            </div>
            <div className="mx-fx-drop-line" style={{ top: fxDrag!.over * fxDrag!.step - fxDrag!.gap / 2 }} />
          </>
        )}
      </div>
    );
  };

  // ── master strip ─────────────────────────────────────────────────────
  const renderMaster = () => {
    const m = engine.master;
    return (
      <div className="mx-strip mx-strip-master" key="master">
        <div className="mx-head" style={{ background: headBgOr(MASTER_COLOR) }}>
          <span className="mx-head-name mx-head-name-master">MASTER</span>
        </div>
        {renderFxChain('master', m.fxIds, m.fxBypassed, true)}
        <div className="mx-meter-fader-row">
          <canvas className="mx-meter mx-meter-master" width={48} height={196}
            ref={el => { if (el) canvasRefs.current.set('master', el); else canvasRefs.current.delete('master'); }}
            onClick={() => resetMeter('master')} title="Click to reset peak / clip" />
          <MidiMapTarget parameterId="mixer.master" min={FADER_MIN_DB} max={FADER_MAX_DB}
            onChange={db => { m.setFaderDb(db); force(); }} style={{ display: 'flex' }}>
            <Fader db={m.faderDb} accent={accentOr(MASTER_COLOR)} onChange={db => { m.setFaderDb(db); force(); }}
              learning={learnTarget === 'fader:master'}
              mapped={midiMappings.current.has('fader:master')}
              onMidiLearn={() => setLearn('fader:master')}
              onMidiClear={() => { midiMappings.current.delete('fader:master'); saveMidiMap(); force(); }} />
          </MidiMapTarget>
        </div>
        {onClip && (
          <div className="mx-clip-row">
            <span className="mx-clip-lbl">CLIP</span>
            <MidiMapTarget parameterId="master.clip" min={0} max={1}
              onChange={v => onClip(clamp(v, 0, 1))}>
              <Knob value={clip ?? 0} min={0} max={1} step={0.01}
                onChange={v => onClip(v)}
                onReset={() => onClip(0)}
                format={v => `${Math.round(v * 100)}%`} accent={accentOr(MASTER_COLOR)} />
            </MidiMapTarget>
          </div>
        )}
        <div className="mx-lufs mx-lufs-clickable" role="button" tabIndex={0}
          title="LOUDNESS (BS.1770-4): M = momentary, S = short-term, I = integrated since reset, TP = true peak. Click for the full readout — LRA, PLR, phase, and a spectrum analyzer for your balance"
          onClick={() => setLoudOpen(true)}
          onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setLoudOpen(true); } }}>
          <div className="mx-lufs-row"><span className="mx-lufs-k">M</span><span ref={el => { lufsRefs.current.m = el; }}>−∞</span></div>
          <div className="mx-lufs-row"><span className="mx-lufs-k">S</span><span ref={el => { lufsRefs.current.s = el; }}>−∞</span></div>
          <div className="mx-lufs-row"><span className="mx-lufs-k">I</span><span ref={el => { lufsRefs.current.i = el; }}>−∞</span>
            <button className="mx-lufs-reset" title="Reset integrated LUFS" onClick={e => { e.stopPropagation(); m.resetIntegrated(); }}>⟳</button>
          </div>
          <div className="mx-lufs-row mx-lufs-tp"><span className="mx-lufs-k">TP</span><span ref={el => { lufsRefs.current.tp = el; }}>−∞</span></div>
        </div>
      </div>
    );
  };

  // ── open device panels ───────────────────────────────────────────────
  const renderDevicePanels = () => {
    if (openPanels.length === 0) return null;
    return (
      <div className="mx-devices">
        {openPanels.map(key => {
          const [ch, idxStr] = key.split(':');
          const idx = Number(idxStr);
          const strip = ch === 'master' ? engine.master : engine.getChannel(ch as ChannelName);
          const fx = strip.fx[idx];
          const id = strip.fxIds[idx];
          if (!fx || !id) return null;
          const def = FX_REGISTRY[id];
          const isSend = SEND_CHANNELS.includes(ch as ChannelName);
          const chLabel = ch === 'master' ? 'MASTER' : (names[ch] ?? chMeta(engine, ch as ChannelName).label);
          const chColor = accentOr(ch === 'master' ? MASTER_COLOR : chMeta(engine, ch as ChannelName).color);
          const collapsed = collapsedPanels.includes(key);
          return (
            <div className={`mx-device${collapsed ? ' collapsed' : ''}`} key={key}
              onDoubleClick={() => toggleCollapse(key)}
              title={collapsed ? 'Double-click to expand' : 'Double-click to collapse'}>
              <div className="mx-device-head">
                <span className="mx-device-title" style={{ color: chColor }}>{def.name}</span>
                <span className="mx-device-sub">{chLabel}</span>
                {/* M/S everywhere (4.7a): the SLOT's route. Engine-side, so it applies to every device. */}
                <select className="mx-device-route" value={strip?.fxRoutes?.[idx] ?? 'STEREO'}
                  title={FX_ROUTE_HELP[(strip?.fxRoutes?.[idx] ?? 'STEREO') as FxRoute]}
                  onClick={e => e.stopPropagation()}
                  onChange={e => { strip?.setFxRoute(idx, e.target.value as FxRoute); force(); }}>
                  {FX_ROUTES.map(rt => <option key={rt} value={rt} title={FX_ROUTE_HELP[rt]}>{rt}</option>)}
                </select>
                <button className="mx-device-close" title="Close"
                  onClick={e => { e.stopPropagation(); togglePanel(key); }}>✕</button>
              </div>
              {!collapsed && (
                <div className="mx-device-body" onDoubleClick={e => e.stopPropagation()}>
                  {(id === 'sccomp' || id === 'fetcomp' || id === 'limiter' || id === 'channelstrip') && (
                    <span className="mx-param mx-sc-gr" title={id === 'sccomp'
                      ? 'Gain reduction — how hard the key is ducking this channel right now'
                      : 'Gain reduction — how many dB it is holding this channel down right now'}>
                      <span className="mx-param-label">GR</span>
                      <span className="mx-param-val" ref={el => { scGrRefs.current.set(key, el); }}>0.0 dB</span>
                    </span>
                  )}
                  {def.params.map(spec0 => {
                    const pKey = `${ch}:${idx}:${spec0.key}`;
                    const mm = midiMappings.current.get(pKey);
                    // Sidechain SOURCE: the options are the live strips (every
                    // channel but this one), labelled the way the strips are.
                    const spec: ParamSpec = spec0.kind === 'select' && spec0.dynamic === 'channels'
                      ? { ...spec0, options: [
                          { label: 'NONE', value: 'NONE' },
                          ...[...REGULAR_CHANNELS, ...SEND_CHANNELS].filter(n => n !== ch)
                            .map(n => ({ label: names[n] ?? chMeta(engine, n).label, value: n })),
                        ] }
                      : spec0;
                    return (
                      <ParamControl key={spec.key} spec={spec} value={fx.params[spec.key]}
                        locked={isSend && WET_PARAM_KEYS.has(spec.key)}
                        paramKey={pKey}
                        learning={learnTarget === pKey}
                        mapped={!!mm && mm.fxId === id}
                        onMidiMenu={openMidiMenu}
                        onChange={v => { strip.setFxParam(idx, spec.key, v); force(); }} />
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </div>
    );
  };

  return (
    <div className="mx-mixer">
      {loudOpen && <LoudnessPopup source={engine.master} onClose={() => setLoudOpen(false)} />}
      <div className="mx-mixer-title">
        MIXER
        {/* Auto gain match — trims each insert chain back to the level it
            received, so an effect is judged on character rather than on the
            loudness it happens to add. Live monitoring only; exports render
            from the serialized chain and are unaffected. */}
        <button
          className={`mx-gainmatch${engine.gainMatchOn ? ' on' : ''}`}
          onClick={() => { engine.setGainMatch(!engine.gainMatchOn); force(); }}
          title={engine.gainMatchOn
            ? 'Auto gain match ON — each strip\'s FX chain is trimmed back to its input level. Affects monitoring only, never exports.'
            : 'Auto gain match — hear what an effect DOES without hearing it get louder. Monitoring only, never exports.'}
        >GAIN MATCH</button>
        {/* Plugin-delay compensation — lines every strip up on the longest
            insert chain (COMP ≈ 6 ms, SAT/CLIP/WAVE ≈ 4 ms, VINYL ≈ 9 ms) so
            one channel never plays late against the others and a bus comp
            never combs against the dry channel. Live AND exports. */}
        <button
          className={`mx-gainmatch${engine.pdcOn ? ' on' : ''}`}
          onClick={() => { engine.setPdc(!engine.pdcOn); force(); }}
          title={engine.pdcOn
            ? 'Plugin-delay compensation ON — every channel is delayed to match the longest FX chain (COMP ≈ 6 ms, SAT/CLIP/WAVE ≈ 4 ms, VINYL ≈ 9 ms), so nothing plays late or phases against a bus. Adds that much monitoring latency only while such inserts are in. Applies to exports too.'
            : 'Plugin-delay compensation OFF — a channel with COMP/SAT/VINYL plays a few ms behind the others and a bus compressor combs against the dry channel. Turn on unless you need the lowest possible pad latency.'}
        >PDC</button>
        {/* CONSOLE — analog-desk separation. Every strip gets its own slightly
            different channel stage (sub-sonic filter, ±0.3 dB tilt, ~0.5 % THD
            of level-dependent 2nd/3rd-harmonic drive, seeded by strip name) and
            the master a summing-bus stage. Zero latency, level-matched, OFF by
            default, printed into every export exactly as heard. */}
        <button
          className={`mx-gainmatch${engine.console.on ? ' on' : ''}`}
          onClick={() => { engine.setConsole({ on: !engine.console.on }); force(); }}
          title={engine.console.on
            ? `CONSOLE ON (${engine.console.flavour}, ${engine.console.amount} %) — every channel runs through its own slightly different desk stage and the master through a summing bus, so sources sit apart instead of smearing together. Level-matched, zero latency, and printed into exports exactly as heard. Click to bypass.`
            : 'CONSOLE — analog-desk separation. Gives every channel its own slight colour (a sub-sonic filter, a tiny EQ tilt, a touch of level-dependent saturation — no two strips the same) and glues the sum on a bus stage, the way an SSL / Neve / API desk does. Level-matched so the A/B is character, not loudness. Applies to exports too.'}
        >CONSOLE</button>
        {engine.console.on && (
          <span className="mx-console-ctl">
            {CONSOLE_FLAVOURS.map(fl => (
              <button key={fl}
                className={`mx-gainmatch mx-size-btn${engine.console.flavour === fl ? ' on' : ''}`}
                onClick={() => { engine.setConsole({ flavour: fl }); force(); }}
                title={CONSOLE_FLAVOUR_HELP[fl]}
              >{fl}</button>
            ))}
            <input
              className="mx-console-amt"
              type="range" min={0} max={100} step={1}
              value={engine.console.amount}
              onChange={e => { engine.setConsole({ amount: Number(e.target.value) }); force(); }}
              title={`AMOUNT ${engine.console.amount} % — how far the desk is pushed: the drive and each strip's tilt scale with it. 50 = a real desk at nominal level, 100 = driven. 0 = only the sub-sonic filter.`}
            />
            <span className="mx-console-amt-val">{engine.console.amount}</span>
          </span>
        )}
        <button
          className={`mx-gainmatch${sendsCollapsed ? ' on' : ''}`}
          onClick={() => setSendsCollapsed(v => !v)}
          title={sendsCollapsed
            ? 'Send returns collapsed to name + fader — click to expand'
            : 'Collapse the four send returns to a narrow name + fader, to get the space back when you are not using them'}
        >SENDS</button>
        <span className="mx-size-ctl">
          {(['s', 'm', 'l'] as const).map(sz => (
            <button key={sz}
              className={`mx-gainmatch mx-size-btn${stripSize === sz ? ' on' : ''}`}
              onClick={() => { setStripSize(sz); setStripW({}); }}
              title={`${sz === 's' ? 'Narrow' : sz === 'm' ? 'Normal' : 'Wide'} strips`}
            >{sz.toUpperCase()}</button>
          ))}
        </span>
        {selected.size > 0 && (
          <span className="mx-sel-count" title="Move any selected fader and they all move together, keeping their relative balance">
            {selected.size} selected
            {/* GROUPS + BUSES (4.7d): the one gesture — several strips become a group with one fader and one
                insert chain. The engine owns the routing graph and refuses a cycle, so this cannot make one. */}
            {selected.size > 1 && (
              <button className="mx-gainmatch mx-group-btn"
                title="GROUP — send these strips to a new bus instead of straight to the master, so they share one fader, one insert chain and one place for the glue compressor"
                onClick={() => {
                  const bus = engine.groupChannels([...selected]);
                  if (bus) { setSelected(new Set([bus])); force(); }
                }}>GROUP</button>
            )}
            <button className="mx-gainmatch" onClick={() => setSelected(new Set())} title="Clear selection">✕</button>
          </span>
        )}
      </div>
      <div
        className={`mx-strips mx-size-${stripSize}${sendsCollapsed ? ' mx-sends-collapsed' : ''}`}
        ref={stripsWrapRef}
        // Marquee: drag from any gap BETWEEN strips (a press that lands on a
        // strip is a control interaction, so it's left alone). No modifier
        // needed, which keeps it identical on Windows and Mac.
        onPointerDown={e => {
          if ((e.target as HTMLElement).closest('.mx-strip')) return;
          // Capture is an optimisation (keeps the drag alive past the edge of
          // the container); it throws if the id isn't an active pointer, and an
          // exception here would kill the whole gesture. Never let it.
          try { (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); } catch { /* drag still works */ }
          if (!(e.metaKey || e.ctrlKey)) setSelected(new Set());
          setMarquee({ x0: e.clientX, y0: e.clientY, x1: e.clientX, y1: e.clientY });
        }}
        onPointerMove={e => {
          if (!marquee) return;
          const m = { ...marquee, x1: e.clientX, y1: e.clientY };
          setMarquee(m);
          const l = Math.min(m.x0, m.x1), r = Math.max(m.x0, m.x1);
          const t = Math.min(m.y0, m.y1), b = Math.max(m.y0, m.y1);
          const hit = new Set<ChannelName>();
          for (const [nm, el] of stripEls.current) {
            if (!el) continue;
            const q = el.getBoundingClientRect();
            if (q.right >= l && q.left <= r && q.bottom >= t && q.top <= b) hit.add(nm);
          }
          setSelected(hit);
        }}
        onPointerUp={e => {
          try { (e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId); } catch { /* never captured */ }
          setMarquee(null);
        }}
      >
        {REGULAR_CHANNELS.map(renderStrip)}
        {BUS_CHANNELS.length > 0 && <div className="mx-divider" />}
        {BUS_CHANNELS.map(renderStrip)}
        <div className="mx-divider" />
        {SEND_CHANNELS.map(renderStrip)}
        <div className="mx-divider" />
        {renderMaster()}
        {fxCopy && (
          <div className="mx-fx-copy-ghost" style={{ position: 'fixed', left: fxCopy.x + 10, top: fxCopy.y - 8 }}>
            ⧉ {FX_REGISTRY[fxCopy.fxId].name}
            {fxCopy.over && <span className="mx-fx-copy-hint">{fxCopy.overFull ? ' — no free slot' : ` → ${fxCopy.over === 'master' ? 'MASTER' : (names[fxCopy.over] ?? chMeta(engine, fxCopy.over).label)}`}</span>}
          </div>
        )}
        {marquee && (
          <div className="mx-marquee" style={{
            position: 'fixed',
            left: Math.min(marquee.x0, marquee.x1),
            top: Math.min(marquee.y0, marquee.y1),
            width: Math.abs(marquee.x1 - marquee.x0),
            height: Math.abs(marquee.y1 - marquee.y0),
          }} />
        )}
      </div>
      {renderDevicePanels()}
      {midiMenu && (
        <>
          <div className="mx-midi-backdrop"
            onPointerDown={() => setMidiMenu(null)}
            onContextMenu={e => { e.preventDefault(); setMidiMenu(null); }} />
          <div className="mx-midi-menu" ref={midiMenuRef} style={{ left: midiMenu.x, top: midiMenu.y }}>
            <button className="mx-midi-learn" onClick={() => { setLearn(midiMenu.paramKey); setMidiMenu(null); }}>MIDI Learn</button>
            {midiMappings.current.has(midiMenu.paramKey) && (
              <button className="mx-midi-clear"
                onClick={() => { midiMappings.current.delete(midiMenu.paramKey); saveMidiMap(); setMidiMenu(null); force(); }}>Clear MIDI</button>
            )}
          </div>
        </>
      )}
    </div>
  );
}

// ── meter painter (canvas) ───────────────────────────────────────────────
const MIN_METER_DB = -60;
const SCALE_TICKS = [0, -6, -12, -18, -24, -30, -36, -42, -48, -54, -60];

function lin2db(v: number): number { return v <= 1e-7 ? -Infinity : 20 * Math.log10(v); }
function dbFrac(db: number): number { return db === -Infinity ? 0 : clamp((db - MIN_METER_DB) / (0 - MIN_METER_DB), 0, 1); }

function gradientFor(ctx: CanvasRenderingContext2D, x: number, top: number, bottom: number, mc: MeterColors): CanvasGradient {
  const g = ctx.createLinearGradient(0, bottom, 0, top);
  g.addColorStop(0.0, mc.fillLo);
  g.addColorStop(0.7, mc.fillLo);   // −18 dB
  g.addColorStop(0.701, mc.fillMid);
  g.addColorStop(0.9, mc.fillMid);  // −6 dB
  g.addColorStop(0.901, mc.fillHi);
  g.addColorStop(1.0, mc.fillHi);
  void x;
  return g;
}

const CLIP_HOLD_MS = 1500;   // full red after a clip
const CLIP_FADE_MS = 1200;   // then fades out
const CLIP_WARN_DB = -6;     // pre-warning starts here
function mixHex(a: string, b: string, t: number): string {
  const pa = [1, 3, 5].map(i => parseInt(a.slice(i, i + 2), 16));
  const pb = [1, 3, 5].map(i => parseInt(b.slice(i, i + 2), 16));
  const c = clamp(t, 0, 1);
  return '#' + pa.map((v, i) => Math.round(v + (pb[i] - v) * c).toString(16).padStart(2, '0')).join('');
}
function drawMeter(cv: HTMLCanvasElement, lv: { preL: number; preR: number; postL: number; postR: number }, hold: Hold, now: number, mc: MeterColors) {
  const ctx = cv.getContext('2d');
  if (!ctx) return;
  const W = cv.width, H = cv.height;
  ctx.clearRect(0, 0, W, H);

  const numericH = 14;
  const clipH = 8;
  const top = numericH + clipH + 2;
  const bottom = H - 2;
  const barH = bottom - top;
  const barW = 8, gap = 2;
  const x0 = 2;

  // background gutter
  ctx.fillStyle = mc.gutter;
  ctx.fillRect(x0, top, barW, barH);
  ctx.fillRect(x0 + barW + gap, top, barW, barH);

  const postDb = Math.max(lin2db(lv.postL), lin2db(lv.postR));

  // Peak hold, clip, and the numeric readout all track the POST-fader peak (the
  // actual output level), so pulling the fader down drops them immediately.
  const dt = hold.lastAt ? Math.min(0.1, (now - hold.lastAt) / 1000) : 1 / 60;
  hold.lastAt = now;
  if (postDb > hold.peakDb || hold.peakAt === 0) { hold.peakDb = postDb; hold.peakAt = now; }
  else if (now - hold.peakAt > 3000) { hold.peakDb -= 8 * dt; } // 8 dB/s decay, whatever the refresh rate
  // Clip light: a true clip (≥ 0 dBFS) LATCHES full red for CLIP_HOLD_MS, then
  // fades out over CLIP_FADE_MS unless it clips again. Below that it's a
  // pre-warning: from CLIP_WARN_DB up to 0 it warms yellow → orange → red with
  // the level, so you see it coming instead of only being told afterwards.
  if (lv.postL >= 0.999 || lv.postR >= 0.999) { hold.clip = true; hold.clipAt = now; }
  else if (hold.clip && now - hold.clipAt > CLIP_HOLD_MS + CLIP_FADE_MS) hold.clip = false;

  const drawBar = (x: number, preLin: number, postLin: number) => {
    const pf = dbFrac(lin2db(preLin));   // pre-fader → faint ghost
    const pof = dbFrac(lin2db(postLin)); // post-fader → solid primary bar
    // PRE — faint ghost bar behind (20% opacity) so gain reduction stays visible
    // above the solid bar when the fader is pulled down.
    ctx.fillStyle = mc.ghost;
    ctx.fillRect(x, bottom - pf * barH, barW, pf * barH);
    // POST — solid, full-opacity gradient bar (drops the instant the fader moves).
    ctx.fillStyle = gradientFor(ctx, x, top, bottom, mc);
    ctx.fillRect(x, bottom - pof * barH, barW, pof * barH);
  };
  drawBar(x0, lv.preL, lv.postL);
  drawBar(x0 + barW + gap, lv.preR, lv.postR);

  // peak-hold line
  if (hold.peakDb > MIN_METER_DB) {
    const y = bottom - dbFrac(hold.peakDb) * barH;
    ctx.fillStyle = mc.peak;
    ctx.fillRect(x0, y, barW, 1);
    ctx.fillRect(x0 + barW + gap, y, barW, 1);
  }

  // clip square — latched red fading out, or the level-driven pre-warning,
  // whichever is brighter.
  let latch = 0;
  if (hold.clip) {
    const age = now - hold.clipAt;
    latch = age <= CLIP_HOLD_MS ? 1 : Math.max(0, 1 - (age - CLIP_HOLD_MS) / CLIP_FADE_MS);
  }
  const warn = clamp((postDb - CLIP_WARN_DB) / -CLIP_WARN_DB, 0, 1); // 0 at −6 dB … 1 at 0 dB
  ctx.fillStyle = mc.clipOff;
  ctx.fillRect(x0, numericH, barW * 2 + gap, clipH - 1);
  if (latch > 0 || warn > 0) {
    // warn colour: yellow → orange → red across the last 6 dB; latch = pure red.
    const wc = warn < 0.5 ? mixHex('#ffd23a', '#ff8a1f', warn * 2) : mixHex('#ff8a1f', mc.clipOn, (warn - 0.5) * 2);
    ctx.globalAlpha = Math.max(latch, warn * 0.9);
    ctx.fillStyle = latch >= warn ? mc.clipOn : wc;
    ctx.fillRect(x0, numericH, barW * 2 + gap, clipH - 1);
    ctx.globalAlpha = 1;
  }

  // numeric peak (held)
  ctx.fillStyle = mc.numeric;
  ctx.font = '8px "DM Mono", monospace';
  ctx.textBaseline = 'top';
  ctx.fillText(hold.peakDb > MIN_METER_DB ? hold.peakDb.toFixed(1) : '−∞', 1, 2);

  // dB scale on the right
  const scaleX = x0 + barW * 2 + gap + 2;
  ctx.fillStyle = mc.ticks;
  ctx.font = '7px "DM Mono", monospace';
  for (const t of SCALE_TICKS) {
    const y = bottom - dbFrac(t) * barH;
    ctx.fillText(String(t), scaleX, y - 3);
  }
  ctx.fillText('-∞', scaleX, bottom - 3);
}

/** Memoized at the host boundary: the mixer re-rendered on EVERY chopper emit
 *  (a stem toggle, a pad hit's state flush, …) and its strip + FX-chain JSX
 *  was ~60 ms of the ~70 ms a toggle took in dev. It keeps itself fresh with
 *  force(); the host bumps channelsRev when IT mutates the mixer (channel
 *  add/remove, meta, restore) — see ChopperView's mixer effects. */
export const MixerSection = memo(MixerSectionImpl);
