import { useEffect, useState, createElement, Fragment } from 'react';
import { midiLearn as legacyCc } from './midiLearn';
import type { ReactNode, ReactElement, CSSProperties } from 'react';

/**
 * Full MIDI-CC → parameter mapping system (Electron desktop only).
 *
 * A control registers itself under a stable `parameterId` (e.g. "master.bpm",
 * "mixer.kick") together with its value range [min, max] and a live setter.
 * In MIDI-learn mode the user CLICKS a control to arm it, then moves a CC on
 * their controller — that CC binds to the armed parameter. Outside learn mode,
 * any incoming CC mapped to a parameter scales 0-127 → [min, max] and drives
 * the setter live.
 *
 * Mappings persist to `midi-map.json` in the app's userData dir over IPC. The
 * whole system is a no-op in the web build (no `window.terminator` bridge), so
 * the web build sees zero behavioural change.
 *
 * This is SEPARATE from the older per-knob `midiLearn.ts` manager (right-click
 * arm, localStorage), which still handles the master-FX knobs. The two cover
 * disjoint parameter sets; the MIDI handler tries this store first and falls
 * back to the legacy one for any CC this store doesn't own.
 */

export type MidiCcMapping = { parameterId: string; min: number; max: number };
type Handler = (value: number) => void;

import { LearnPicker } from './midiLearnPick.mts';

class MidiMapStore {
  private picker = new LearnPicker();
  private map: Record<number, MidiCcMapping> = {};   // cc number → mapping
  private handlers: Record<string, Handler> = {};    // parameterId → live setter
  private meta: Record<string, { min: number; max: number }> = {}; // parameterId → range
  private learnMode = false;
  private armed: string | null = null;
  private listeners = new Set<() => void>();
  private loaded = false;

  // The Electron preload bridge. Undefined in the web build → the whole system
  // stays inert (no learn highlights, no persistence, no runtime apply).
  private get bridge(): {
    saveMidiMap?: (m: Record<string, MidiCcMapping>) => Promise<unknown>;
    loadMidiMap?: () => Promise<Record<string, MidiCcMapping> | null>;
  } | undefined {
    return typeof window !== 'undefined' ? (window as unknown as { terminator?: never }).terminator : undefined;
  }
  get enabled(): boolean { return !!this.bridge; }

  subscribe(fn: () => void): () => void { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; }
  private notify() { this.listeners.forEach(fn => fn()); }

  /** Load the persisted map once (Electron only). Re-applies on next render via notify. */
  async load(): Promise<void> {
    if (this.loaded || !this.enabled) return;
    this.loaded = true;
    legacyCc.onPersist = () => this.save();
    try {
      const saved = await this.bridge!.loadMidiMap?.();
      if (saved && typeof saved === 'object') {
        // The legacy per-knob CC map (bass knobs, master-FX knobs, waveform
        // START/END) rides along under a non-numeric key the loop below skips.
        legacyCc.restore((saved as Record<string, unknown>).__ccMap as Record<string, number> | undefined);
        const next: Record<number, MidiCcMapping> = {};
        for (const k of Object.keys(saved)) {
          const cc = Number(k);
          const v = (saved as Record<string, MidiCcMapping>)[k];
          if (Number.isFinite(cc) && v && typeof v.parameterId === 'string' && Number.isFinite(v.min) && Number.isFinite(v.max)) {
            next[cc] = { parameterId: v.parameterId, min: Number(v.min), max: Number(v.max) };
          }
        }
        this.map = next;
        this.notify();
      }
    } catch { /* no saved map yet */ }
  }

  private save() {
    if (!this.enabled) return;
    try { void this.bridge!.saveMidiMap?.({ ...(this.map as unknown as Record<string, MidiCcMapping>), __ccMap: legacyCc.snapshot() as unknown as MidiCcMapping }); } catch { /* best-effort */ }
  }

  /** A control registers its live setter + range. Called every render so the
   *  setter closure (which captures current engine refs) stays fresh. */
  registerParam(parameterId: string, handler: Handler, min: number, max: number): () => void {
    this.handlers[parameterId] = handler;
    this.meta[parameterId] = { min, max };
    return () => { if (this.handlers[parameterId] === handler) delete this.handlers[parameterId]; };
  }

  setLearnMode(on: boolean) {
    if (!this.enabled || this.learnMode === on) return;
    this.learnMode = on;
    if (!on) this.armed = null;
    this.notify();
  }
  isLearnMode() { return this.learnMode; }

  /** Arm a parameter as the pending learn target (next CC binds to it). */
  arm(parameterId: string) {
    if (!this.enabled || !this.learnMode) return;
    this.armed = this.armed === parameterId ? null : parameterId; // click again to un-arm
    this.picker.reset();
    this.notify();
  }
  isArmed(id: string) { return this.armed === id; }

  ccForParam(id: string): number | null {
    for (const k of Object.keys(this.map)) if (this.map[Number(k)].parameterId === id) return Number(k);
    return null;
  }
  isMapped(id: string): boolean { return this.ccForParam(id) !== null; }

  clearParam(id: string) {
    let changed = false;
    for (const k of Object.keys(this.map)) if (this.map[Number(k)].parameterId === id) { delete this.map[Number(k)]; changed = true; }
    if (changed) { this.save(); this.notify(); }
  }

  /** Feed an incoming MIDI CC. Returns true if consumed (an armed learn was
   *  completed, OR a mapped parameter was driven). Returns false for an
   *  unmapped CC so the caller can fall back to the legacy FX-knob manager. */
  handleCC(cc: number, value: number): boolean {
    if (!this.enabled) return false;
    if (this.learnMode && this.armed) {
      // Wait for a REAL continuous control (skip 14-bit LSB partners and 0/127
      // button blips) — see midiLearnPick.ts.
      if (!this.picker.feed(0, cc, value, typeof performance !== 'undefined' ? performance.now() : Date.now())) return true;
      const range = this.meta[this.armed] ?? { min: 0, max: 1 };
      // One CC per parameter: drop any prior mapping for this param first.
      for (const k of Object.keys(this.map)) if (this.map[Number(k)].parameterId === this.armed) delete this.map[Number(k)];
      this.map[cc] = { parameterId: this.armed, min: range.min, max: range.max };
      // Clear ONLY the armed target — keep learnMode ON so the user can chain:
      // click the next control, move a CC, repeat, without re-toggling LEARN.
      // The just-mapped control now shows its blue dot; the rest stay armable.
      this.armed = null;
      this.save();
      this.notify();
      return true;
    }
    return this.apply(cc, value);
  }

  /** Scale a CC value (0-127) into the mapped parameter's range and drive it. */
  apply(cc: number, value: number): boolean {
    const m = this.map[cc];
    if (!m) return false;
    const t = Math.max(0, Math.min(1, value / 127));
    this.handlers[m.parameterId]?.(m.min + t * (m.max - m.min));
    return true;
  }
}

export const midiMapStore = new MidiMapStore();

/** Hook: registers a control's live setter + range and exposes its learn state. */
export function useMidiMappable(
  parameterId: string,
  min: number,
  max: number,
  onChange: Handler,
): { learnMode: boolean; armed: boolean; mapped: boolean; cc: number | null; arm: () => void; clear: () => void } {
  const [, force] = useState(0);
  // Re-register every render so onChange captures the latest engine/force refs.
  useEffect(() => midiMapStore.registerParam(parameterId, onChange, min, max));
  useEffect(() => midiMapStore.subscribe(() => force(n => n + 1)), []);
  return {
    learnMode: midiMapStore.isLearnMode(),
    armed: midiMapStore.isArmed(parameterId),
    mapped: midiMapStore.isMapped(parameterId),
    cc: midiMapStore.ccForParam(parameterId),
    arm: () => midiMapStore.arm(parameterId),
    clear: () => midiMapStore.clearParam(parameterId),
  };
}

/**
 * Wraps a mappable control. Idle: renders children plus a tiny blue dot if the
 * control is MIDI-mapped. Learn mode: overlays a blue, clickable highlight that
 * arms the control (and intercepts the control's own drag); the armed control
 * gets a brighter, pulsing highlight with a "Move a knob…" prompt.
 *
 * Authored with createElement (not JSX) so this stays in a `.ts` file. Right-
 * clicking the overlay clears an existing mapping.
 */
export function MidiMapTarget(props: {
  parameterId: string;
  min: number;
  max: number;
  onChange: Handler;
  children: ReactNode;
  style?: CSSProperties;
  className?: string;
}): ReactElement {
  const { parameterId, min, max, onChange, children, style, className } = props;
  const m = useMidiMappable(parameterId, min, max, onChange);

  // Idle + unmapped (always the case in the web build, where the store is
  // disabled): render children bare — no wrapper span, so the DOM/layout is
  // byte-identical to the un-wrapped control. The wrapper only appears once a
  // control is mapped (to host the dot) or while learning (to host the overlay).
  if (!m.learnMode && !m.mapped) return createElement(Fragment, null, children);

  const dot = m.mapped
    ? createElement('span', { key: 'dot', className: 'midimap-dot', title: `MIDI CC ${m.cc} mapped` })
    : null;

  const overlay = m.learnMode
    ? createElement(
        'div',
        {
          key: 'ov',
          className: `midimap-overlay${m.armed ? ' midimap-armed' : ''}`,
          title: m.armed ? 'Move a knob/fader on your controller…' : (m.mapped ? `CC ${m.cc} — click to re-map, right-click to clear` : 'Click to map this control'),
          onPointerDown: (e: { preventDefault: () => void; stopPropagation: () => void }) => { e.preventDefault(); e.stopPropagation(); },
          onClick: (e: { preventDefault: () => void; stopPropagation: () => void }) => { e.preventDefault(); e.stopPropagation(); m.arm(); },
          onContextMenu: (e: { preventDefault: () => void; stopPropagation: () => void }) => { e.preventDefault(); e.stopPropagation(); m.clear(); },
        },
        m.armed
          ? createElement('span', { className: 'midimap-hint' }, 'Move a knob…')
          : (m.mapped ? createElement('span', { className: 'midimap-cc' }, `CC ${m.cc}`) : null),
      )
    : null;

  return createElement(
    'span',
    {
      className: `midimap-wrap${m.learnMode ? ' midimap-learnable' : ''}${className ? ' ' + className : ''}`,
      style: { position: 'relative', display: 'inline-flex', ...style },
    },
    children,
    overlay,
    dot,
  );
}
