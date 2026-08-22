import { useCallback } from 'react';

interface Options {
  min?: number;
  max?: number;
  step?: number;
  sensitivity?: number; // units per pixel (default: step/3)
}

export function useDraggableNumber(
  value: number,
  onChange: (v: number) => void,
  { min, max, step = 1, sensitivity }: Options = {}
) {
  const sens = sensitivity ?? step / 3;

  const onMouseDown = useCallback((e: React.MouseEvent) => {
    const target = e.currentTarget as HTMLElement;
    const startY = e.clientY;
    const startVal = value;

    const onMove = (me: MouseEvent) => {
      const delta = (startY - me.clientY) * sens;
      let v = startVal + delta;
      if (min !== undefined) v = Math.max(min, v);
      if (max !== undefined) v = Math.min(max, v);
      v = Math.round(v / step) * step;
      // Avoid floating-point noise on the displayed value
      onChange(parseFloat(v.toFixed(10)));
    };

    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      document.body.style.cursor = '';
      target.blur();
    };

    document.body.style.cursor = 'ns-resize';
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }, [value, onChange, sens, min, max, step]);

  const blurTarget = useCallback((e: React.SyntheticEvent) => {
    (e.currentTarget as HTMLElement).blur();
  }, []);

  return {
    onMouseDown,
    onMouseLeave: blurTarget,   // mouse moves off element
    onPointerLeave: blurTarget, // touch moves off element (mobile)
    onPointerUp: blurTarget,    // touch lifts straight up (mobile)
    style: { cursor: 'ns-resize' } as React.CSSProperties,
  };
}
