// Build a mixer insert-FX chain inside ANY BaseAudioContext — crucially an
// OfflineAudioContext, so the exact same effects that colour live playback can
// be baked into offline (export) renders. Every FX class + the WetDry base + the
// registry `create()` already type their ctx as BaseAudioContext, so the live
// and offline graphs are byte-for-byte the same code path.
//
// Adapted to this codebase: effects are built through the `createFx(id, ctx)`
// factory (not raw constructors), and the base interface is `MixerFX`.

import { createFx, type FxId } from './index';
import type { MixerFX, FxParamValue } from './base';

export interface SerializedFX {
  type: string;                                   // FxId, e.g. 'reverb' | 'delay' | …
  params: Record<string, FxParamValue>;           // live param values (number | string)
  bypassed: boolean;
}

/** Build the offline insert chain. Bypassed effects are skipped entirely (the
 *  live graph's bypass is a dry passthrough, so excluding them is equivalent).
 *  When nothing is active, a unity-gain GainNode passes the signal through
 *  unchanged. */
export function buildOfflineFXChain(
  ctx: BaseAudioContext,
  serializedChain: SerializedFX[],
): { input: AudioNode; output: AudioNode; dispose: () => void; ready: Promise<void>; fx: MixerFX[] } {
  const active = serializedChain.filter(f => !f.bypassed);
  if (active.length === 0) {
    const pass = ctx.createGain();
    return { input: pass, output: pass, dispose: () => { try { pass.disconnect(); } catch { /* */ } }, ready: Promise.resolve(), fx: [] };
  }

  const nodes: MixerFX[] = active.map(({ type, params }) => {
    const fx = createFx(type as FxId, ctx);
    for (const [k, v] of Object.entries(params)) fx.setParam(k, v);
    return fx;
  });

  for (let i = 0; i < nodes.length - 1; i++) {
    nodes[i].outputNode.connect(nodes[i + 1].inputNode);
  }

  return {
    input: nodes[0].inputNode,
    output: nodes[nodes.length - 1].outputNode,
    dispose: () => nodes.forEach(n => { try { n.dispose(); } catch { /* */ } }),
    // Anything async inside an effect (a measured latency, a worklet module)
    // must be in place before startRendering — await this first.
    ready: Promise.all(nodes.map(n => n.ready ?? Promise.resolve())).then(() => undefined),
    fx: nodes,
  };
}
