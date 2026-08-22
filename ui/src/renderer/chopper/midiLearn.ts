import { LearnPicker } from './midiLearnPick.mts';
import { useEffect, useState } from 'react';

/**
 * MIDI-learn manager for knobs/faders. A knob registers itself under a stable
 * `paramId` with a `setNormalized(0..1)` callback. The user arms learn on a
 * knob (right-click), moves a CC on their controller, and that CC number binds
 * to the param. Future CC messages drive the knob. Mappings persist in
 * localStorage. Web MIDI CC values are 0-127.
 */

type ParamReg = { setNormalized: (t: number) => void };

const STORAGE_KEY = 'terminator.midiCcMap.v1';

class MidiLearnManager {
  private map: Record<string, number> = {};          // paramId -> CC number
  private params: Record<string, ParamReg> = {};      // paramId -> live setter
  private learnTarget: string | null = null;
  private listeners = new Set<() => void>();

  constructor() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) this.map = JSON.parse(raw);
    } catch { /* */ }
  }

  /** Optional disk mirror (Electron): MidiMap.ts hooks this so the per-knob
   *  CC map rides along in midi-map.json — a mapping made once survives every
   *  launch even if localStorage is cleared or shared between instances. */
  onPersist: (() => void) | null = null;
  private persist() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(this.map)); } catch { /* */ }
    try { this.onPersist?.(); } catch { /* */ }
  }
  /** The whole paramId → CC map (for the disk mirror). */
  snapshot(): Record<string, number> { return { ...this.map }; }
  /** Merge a saved map in (disk wins over what localStorage had) and re-drive nothing. */
  restore(saved: Record<string, number> | null | undefined): void {
    if (!saved || typeof saved !== 'object') return;
    let changed = false;
    for (const [id, cc] of Object.entries(saved)) {
      if (typeof cc === 'number' && Number.isFinite(cc) && this.map[id] !== cc) { this.map[id] = cc; changed = true; }
    }
    if (changed) { try { localStorage.setItem(STORAGE_KEY, JSON.stringify(this.map)); } catch { /* */ } this.notify(); }
  }
  private notify() { this.listeners.forEach(fn => fn()); }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  }

  registerParam(id: string, reg: ParamReg): () => void {
    this.params[id] = reg;
    return () => { if (this.params[id] === reg) delete this.params[id]; };
  }

  startLearn(id: string) {
    this.learnTarget = id;
    this.notify();
    // The bass module keeps its own flow (KnobMenu / LEARN mode) — untouched.
    if (!id.startsWith('bass.')) this.installOutsideCancel();
  }
  cancelLearn() { this.learnTarget = null; this.notify(); }

  // Right-click armed a knob and it sat there waiting for a CC forever. Now a
  // pointer-down anywhere OUTSIDE the learning knob (or the bass knob menu,
  // which arms from its own popup) — or Escape — cancels the arm. Installed
  // once per arm, removed as soon as learn ends (a CC arriving clears the
  // target too, so the next event just tears itself down).
  private outsideCancel: ((e: Event) => void) | null = null;
  private installOutsideCancel() {
    if (typeof document === 'undefined' || this.outsideCancel) return;
    const teardown = () => {
      if (!this.outsideCancel) return;
      document.removeEventListener('pointerdown', this.outsideCancel, true);
      document.removeEventListener('keydown', this.outsideCancel, true);
      this.outsideCancel = null;
    };
    this.outsideCancel = (e: Event) => {
      if (!this.learnTarget) { teardown(); return; }
      if (e.type === 'keydown') {
        if ((e as KeyboardEvent).key === 'Escape') { this.cancelLearn(); teardown(); }
        return;
      }
      const t = e.target as Element | null;
      // inside the knob that is learning (fx knobs / bass knobs) or the bass
      // knob's popup menu → leave it armed
      if (t?.closest?.('.fx-knob-learning, .bk.learning, .bass-knob-menu, .km-menu')) return;
      this.cancelLearn();
      teardown();
    };
    document.addEventListener('pointerdown', this.outsideCancel, true);
    document.addEventListener('keydown', this.outsideCancel, true);
  }
  isLearning(id: string) { return this.learnTarget === id; }
  learningAny() { return this.learnTarget !== null; }
  ccForParam(id: string): number | null { return this.map[id] ?? null; }

  clearParam(id: string) {
    if (id in this.map) { delete this.map[id]; this.persist(); this.notify(); }
  }

  /** Feed an incoming MIDI CC. Either completes a pending learn or drives any
   *  param(s) bound to this CC. */
  private picker = new LearnPicker();
  handleCC(cc: number, value: number) {
    if (this.learnTarget) {
      // Wait for a REAL continuous control (skip 14-bit LSB partners and 0/127
      // button blips) — see midiLearnPick.ts.
      if (!this.picker.feed(0, cc, value, typeof performance !== 'undefined' ? performance.now() : Date.now())) return;
      this.picker.reset();
      this.map[this.learnTarget] = cc;
      this.learnTarget = null;
      this.persist();
      this.notify();
      return;
    }
    const t = value / 127;
    for (const id of Object.keys(this.map)) {
      if (this.map[id] === cc) this.params[id]?.setNormalized(t);
    }
  }
}

export const midiLearn = new MidiLearnManager();

/** Knob hook: registers the param's live setter and exposes learn state. */
export function useMidiLearn(
  paramId: string,
  setNormalized: (t: number) => void,
): { cc: number | null; learning: boolean; startLearn: () => void; clear: () => void } {
  const [, force] = useState(0);
  // Keep the latest setter registered (closure captures current range/onChange).
  useEffect(() => midiLearn.registerParam(paramId, { setNormalized }));
  useEffect(() => midiLearn.subscribe(() => force(n => n + 1)), []);
  return {
    cc: midiLearn.ccForParam(paramId),
    learning: midiLearn.isLearning(paramId),
    startLearn: () => midiLearn.startLearn(paramId),
    clear: () => midiLearn.clearParam(paramId),
  };
}
