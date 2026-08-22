import { useEffect, useState } from 'react';
import type { ChopperActivity, ChopperEngine } from './ChopperEngine';

/**
 * Subscribe to the engine's per-hit pad activity (which pads are ringing, which
 * was hit last, whether anything is playing).
 *
 * This exists so a pad trigger doesn't have to push a whole new ChopperState.
 * ChopperView is a very large tree (~2000 DOM nodes) and a full re-render of it
 * costs 12–46ms on the main thread — the same thread Web MIDI delivers note-ons
 * on. One re-render per note meant a fast roll queued up behind renders and
 * every hit landed late and uneven. Components that actually need the pad LEDs
 * (PadGrid, WaveformView, HardwareView) subscribe here instead, so a note
 * re-renders only them.
 */
const IDLE: ChopperActivity = { activePads: [], lastTriggeredPad: null, playing: false };

export function usePadActivity(engine: ChopperEngine | undefined): ChopperActivity | null {
  const [activity, setActivity] = useState<ChopperActivity>(() => engine?.getActivity() ?? IDLE);
  useEffect(() => {
    if (!engine) return;
    return engine.subscribeActivity(setActivity);
  }, [engine]);
  // null (not IDLE) when there's no engine, so callers can tell "no activity
  // channel available" from "channel says nothing is playing" and fall back to
  // whatever ChopperState they were already given.
  return engine ? activity : null;
}
