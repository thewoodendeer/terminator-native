// Right-click / long-press menu for a bass knob: COPY · PASTE · RESET ·
// MIDI LEARN / CLEAR CC · ASSIGN TO MOD (LFO 1-3, TRIG A/B — toggles the
// assignment; depth is edited in the MOD module). Portal'd to <body>, closes on
// outside tap / Escape.
import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useKeepOnScreen } from '../hooks/useKeepOnScreen';
import { MOD_SOURCES, type ModAssign, type ModSource } from './BassEngine';
import { knobClipboard, type KnobMenuInfo } from './BassKnob';

interface Props {
  info: KnobMenuInfo;
  mods: ModAssign[];               // current assignments on this knob
  onAssign: (src: ModSource) => void;
  onUnassign: (src: ModSource) => void;
  onClose: () => void;
}

export function KnobMenu({ info, mods, onAssign, onUnassign, onClose }: Props) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  const W = 190, H = 300;
  const left = Math.max(6, Math.min(info.x, window.innerWidth - W - 6));
  const top = Math.max(6, Math.min(info.y, window.innerHeight - H - 6));
  const menuRef = useRef<HTMLDivElement>(null);
  useKeepOnScreen(menuRef, `${info.id}:${info.x},${info.y}`); // the guess above is a guess — this measures
  const canPaste = knobClipboard.value !== null;
  const item = (label: string, onClick: () => void, opts?: { disabled?: boolean; on?: boolean; hint?: string; key?: string }) => (
    <button key={opts?.key ?? label} className={`km-item${opts?.on ? ' on' : ''}`} disabled={opts?.disabled}
      onClick={() => { onClick(); }}>
      <span>{label}</span>{opts?.hint && <small>{opts.hint}</small>}
    </button>
  );
  return createPortal(
    <>
      <div className="km-backdrop" onPointerDown={onClose} onContextMenu={(e) => { e.preventDefault(); onClose(); }} />
      <div className="km-menu" ref={menuRef} style={{ left, top, width: W }} onContextMenu={(e) => e.preventDefault()}>
        <div className="km-title">{info.label}</div>
        {item('COPY', () => { knobClipboard.value = info.value; knobClipboard.from = info.id; onClose(); })}
        {item('PASTE', () => { if (knobClipboard.value !== null) info.onChange(Math.max(info.min, Math.min(info.max, knobClipboard.value))); onClose(); }, { disabled: !canPaste })}
        {item('RESET', () => { if (info.def !== undefined) info.onChange(info.def); onClose(); }, { disabled: info.def === undefined })}
        <div className="km-sep" />
        {item(info.cc !== null ? `MIDI: CC ${info.cc}` : 'MIDI LEARN', () => { info.startLearn(); onClose(); }, { hint: info.cc !== null ? 're-learn' : 'move a control' })}
        {info.cc !== null && item('CLEAR MIDI', () => { info.clearCc(); onClose(); })}
        <div className="km-sep" />
        <div className="km-sub">ASSIGN TO MOD</div>
        {MOD_SOURCES.map((s) => {
          const on = mods.some((m) => m.src === s.id);
          return item(s.label, () => { if (on) onUnassign(s.id); else onAssign(s.id); onClose(); }, { on, hint: on ? '✓ assigned' : undefined, key: s.id });
        })}
      </div>
    </>,
    document.body,
  );
}
