/** Shared AudioParam setter for the effect modules.
 *
 *  Live tweaks glide (setTargetAtTime — no zipper noise under a slider). But
 *  the constructor's first set, and EVERY set inside an OfflineAudioContext,
 *  must land instantly: gliding from a node's Web Audio default at t=0 puts a
 *  50 ms parameter sweep at the head of every export (a filter opening from
 *  1 kHz, a delay time chirping up from its default…). */
export const isOfflineCtx = (ctx: BaseAudioContext): boolean =>
  typeof OfflineAudioContext !== 'undefined' && ctx instanceof OfflineAudioContext;

export function setParam(ctx: BaseAudioContext, p: AudioParam, v: number, tau = 0.01, instant = false): void {
  const t = ctx.currentTime;
  if (instant || isOfflineCtx(ctx)) {
    p.cancelScheduledValues(t);
    p.setValueAtTime(v, t);
    return;
  }
  p.setTargetAtTime(v, t, tau);
}
