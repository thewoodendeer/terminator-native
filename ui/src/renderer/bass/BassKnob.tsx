// The BASS panel's knob — a Model-D-style pointer knob. Vertical drag (SHIFT =
// fine), double-click = reset to default, mouse-wheel nudges. Right-click (or
// long-press) opens the knob MENU (copy / paste / reset / MIDI learn / assign
// to MOD) — the parent renders it. In the panel's LEARN mode every knob
// flashes (green = has a CC, white = free) and a tap arms it: move a control on
// your hardware and it binds. Mappings live in the chopper's legacy per-knob
// MIDI-learn store, so a controller mapped once follows the knob forever.
import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { midiLearn, useMidiLearn } from '../chopper/midiLearn';

/** Panel-wide knob environment (LEARN mode, MOD counts, the menu opener) —
 *  a context rather than a wrapper component: a wrapper defined inside the
 *  panel is a NEW component type every render, so React remounted every knob
 *  on each drag tick and the drag died under the mouse. */
export const KnobEnv = createContext<{ learnMode: boolean; modCountFor?: (id: string) => number; onMenu?: (info: KnobMenuInfo) => void }>({ learnMode: false });

/** One shared clipboard for COPY / PASTE between knobs (value + its id). */
export const knobClipboard: { value: number | null; from: string | null } = { value: null, from: null };

export interface KnobMenuInfo {
  id: string;            // midi-learn id ("bass.filter.cutoff")
  path: string;          // patch path ("filter.cutoff")
  label: string;
  value: number;
  def?: number;
  min: number; max: number;
  cc: number | null;
  x: number; y: number;  // client coords for the menu
  onChange: (v: number) => void;
  startLearn: () => void;
  clearCc: () => void;
}

interface Props {
  id: string;                 // midi-learn id, unique across the app ("bass.filter.cutoff")
  label: string;
  value: number;
  min: number;
  max: number;
  def?: number;
  log?: boolean;              // log taper (Hz-style)
  bipolar?: boolean;          // centre-detent arc from the middle
  fmt?: (v: number) => string;
  onChange: (v: number) => void;
  size?: number;
  title?: string;
  /** Panel-wide LEARN mode: tap = arm MIDI learn instead of dragging. */
  learnMode?: boolean;
  /** How many MOD sources are assigned to this knob (draws the M dot). */
  modCount?: number;
  /** Right-click / long-press → the parent opens the knob menu. */
  onMenu?: (info: KnobMenuInfo) => void;
  /** Opt out of the panel menu (right-click = plain MIDI learn). */
  noMenu?: boolean;
}

const clamp01 = (t: number) => Math.max(0, Math.min(1, t));

export function BassKnob({ id, label, value, min, max, def, log, bipolar, fmt, onChange, size = 38, title, learnMode: learnModeProp, modCount: modCountProp, onMenu: onMenuProp, noMenu }: Props) {
  const env = useContext(KnobEnv);
  const learnMode = learnModeProp ?? env.learnMode;
  const modCount = modCountProp ?? env.modCountFor?.(id) ?? 0;
  const onMenu = noMenu ? undefined : (onMenuProp ?? env.onMenu);
  const toNorm = useCallback((v: number) => log
    ? clamp01(Math.log(Math.max(1e-6, v) / min) / Math.log(max / min))
    : clamp01((v - min) / (max - min)), [log, min, max]);
  const fromNorm = useCallback((t: number) => log
    ? min * Math.pow(max / min, clamp01(t))
    : min + (max - min) * clamp01(t), [log, min, max]);
  const onChangeRef = useRef(onChange); onChangeRef.current = onChange;
  const { cc, learning, startLearn, clear } = useMidiLearn(id, (t) => onChangeRef.current(fromNorm(t)));
  const [drag, setDrag] = useState<{ y: number; t: number; fine: boolean } | null>(null);
  const [showVal, setShowVal] = useState(false);
  const pressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const t = toNorm(value);

  useEffect(() => {
    if (!drag) return;
    const move = (e: PointerEvent) => {
      const dy = drag.y - e.clientY;
      const scale = (e.shiftKey || drag.fine ? 1200 : 220);
      onChangeRef.current(fromNorm(drag.t + dy / scale));
    };
    const up = () => { setDrag(null); setShowVal(false); };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
    return () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', up); };
  }, [drag, fromNorm]);

  const openMenu = (x: number, y: number) => {
    onMenu?.({
      id, path: id.replace(/^bass\./, ''), label, value, def, min, max, cc, x, y,
      onChange: (v) => onChangeRef.current(v), startLearn, clearCc: clear,
    });
  };

  const angle = -135 + 270 * t;
  const arcFrom = bipolar ? 0 : -135;
  const arcTo = angle;
  const a0 = Math.min(arcFrom, arcTo), a1 = Math.max(arcFrom, arcTo);
  const text = fmt ? fmt(value) : (Math.abs(value) >= 100 ? value.toFixed(0) : value.toFixed(2));
  const cls = `bk${learning ? ' learning' : ''}${cc !== null ? ' mapped' : ''}${learnMode ? ' learnmode' : ''}${modCount > 0 ? ' modded' : ''}`;
  return (
    <div className={cls}
      style={{ width: size + 10 }}
      title={title ? `${title}${cc !== null ? ` · MIDI CC ${cc}` : ''}${modCount ? ` · ${modCount} MOD` : ''} · right-click: menu` : undefined}
      onContextMenu={(e) => { e.preventDefault(); if (onMenu) openMenu(e.clientX, e.clientY); else startLearn(); }}>
      <div className="bk-dial" style={{ width: size, height: size, ['--a0' as any]: `${a0}deg`, ['--asw' as any]: `${a1 - a0}deg` }}
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          e.preventDefault();
          if (learnMode) { if (learning) midiLearn.cancelLearn(); else startLearn(); return; }
          try { (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId); } catch { /* */ }
          setDrag({ y: e.clientY, t, fine: e.shiftKey }); setShowVal(true);
          // long-press (touch) = menu
          if (e.pointerType === 'touch' && onMenu) {
            const x = e.clientX, y = e.clientY;
            pressTimer.current = setTimeout(() => { setDrag(null); openMenu(x, y); }, 550);
          }
        }}
        onPointerMove={() => { if (pressTimer.current) { clearTimeout(pressTimer.current); pressTimer.current = null; } }}
        onPointerUp={() => { if (pressTimer.current) { clearTimeout(pressTimer.current); pressTimer.current = null; } }}
        onDoubleClick={() => { if (def !== undefined && !learnMode) onChangeRef.current(def); }}
        onWheel={(e) => { e.preventDefault(); onChangeRef.current(fromNorm(t - Math.sign(e.deltaY) * (e.shiftKey ? 0.004 : 0.02))); }}
        onMouseEnter={() => setShowVal(true)} onMouseLeave={() => { if (!drag) setShowVal(false); }}>
        <div className="bk-cap" style={{ transform: `rotate(${angle}deg)` }}><i /></div>
        {modCount > 0 && <span className="bk-mod" title={`${modCount} MOD source${modCount > 1 ? 's' : ''}`}>M</span>}
        {showVal && !learnMode && <div className="bk-val">{text}</div>}
        {learnMode && <div className="bk-val bk-val-cc">{learning ? '…' : cc !== null ? `CC ${cc}` : 'free'}</div>}
      </div>
      <div className="bk-label">{label}{cc !== null && <span className="bk-cc">{cc}</span>}</div>
    </div>
  );
}
