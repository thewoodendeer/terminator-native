import { ReactNode } from 'react';

/**
 * Floating value bubble shown above a fader thumb while dragging — the
 * mobile-friendly companion to useFaderTooltip (the value never sits under the
 * finger). Render it inside a `position: relative` parent; `pct` is the thumb
 * position 0..100 from the hook, so the bubble tracks the thumb horizontally.
 */
export function FaderBubble({ active, pct, accent, children }: {
  active: boolean; pct: number; accent?: string; children: ReactNode;
}) {
  if (!active) return null;
  return (
    <div
      aria-hidden
      style={{
        position: 'absolute', left: `${pct}%`, bottom: '100%', transform: 'translateX(-50%)',
        marginBottom: 6, padding: '3px 8px', borderRadius: 5,
        background: 'rgba(0,0,0,0.92)', color: '#fff',
        border: `1px solid ${accent ?? 'rgba(255,255,255,0.8)'}`,
        font: '700 13px/1 ui-monospace, "Share Tech Mono", monospace', letterSpacing: 0.5,
        whiteSpace: 'nowrap', pointerEvents: 'none', zIndex: 50,
        boxShadow: '0 2px 8px rgba(0,0,0,0.5)',
      }}
    >{children}</div>
  );
}
