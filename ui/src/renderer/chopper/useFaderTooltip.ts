import { useEffect, useState } from 'react';

/**
 * Hook that powers the "value bubble" shown above an FX slider while the
 * user is dragging it. Solves the thumb-covered-by-finger problem on mobile.
 * Returns:
 *   - `active`: whether to render the tooltip
 *   - `pct`: position of the slider thumb as a percentage (0..100), so the
 *            caller can absolute-position the tooltip with `left: pct%`
 *   - `onPointerDown`: attach to the slider input
 *
 * Pointerup / cancel are tracked at the window level so a finger that drifts
 * off the input still releases the tooltip cleanly.
 */
export function useFaderTooltip(value: number, min: number, max: number) {
  const [active, setActive] = useState(false);
  useEffect(() => {
    if (!active) return;
    const stop = () => setActive(false);
    window.addEventListener('pointerup', stop);
    window.addEventListener('pointercancel', stop);
    return () => {
      window.removeEventListener('pointerup', stop);
      window.removeEventListener('pointercancel', stop);
    };
  }, [active]);

  const range = Math.max(1e-9, max - min);
  const pct = Math.max(0, Math.min(100, ((value - min) / range) * 100));
  const onPointerDown = () => setActive(true);

  return { active, pct, onPointerDown };
}
