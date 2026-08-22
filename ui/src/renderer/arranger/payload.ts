// Builds the /api/arranger request from the current chopper + drum state, and
// returns the chop-index → pad-index map the preview/export use to turn the AI's
// chop indices back into real pads. We re-index assigned pads to a compact 0..N-1
// space so the model only ever sees contiguous chop indices (the server clamps to
// that range), regardless of which physical pads hold chops.

import { ChopperEngine } from '../chopper/ChopperEngine';
import { DrumEngine } from '../drums/DrumEngine';

export interface ArrangerRequest {
  chops: Array<{ index: number; name: string }>;
  drums: { pattern: Record<string, boolean[]>; bars: number; tracks: string[] };
  bpm: number;
  barsAvailable: number;
}

export function buildArrangerPayload(
  engine: ChopperEngine,
  drumEngine: DrumEngine,
): { request: ArrangerRequest; chopToPad: number[] } {
  const st = engine.getState();
  const assigned = st.pads
    .filter((p) => p.chopId !== null)
    .sort((a, b) => a.index - b.index);

  const chopToPad = assigned.map((p) => p.index);
  const chops = assigned.map((_, i) => ({ index: i, name: `Chop ${i + 1}` }));

  const ds = drumEngine.getState();
  return {
    request: {
      chops,
      drums: {
        pattern: ds.pattern as unknown as Record<string, boolean[]>,
        bars: ds.bars,
        tracks: ds.tracks.map((t) => t.key),
      },
      bpm: Math.round(engine.getMasterBpm()) || 90,
      barsAvailable: ds.bars,
    },
    chopToPad,
  };
}
