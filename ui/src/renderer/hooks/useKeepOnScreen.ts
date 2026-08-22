// Keep a floating menu INSIDE the window, whatever anchored it. Measures the
// element after it renders (and again whenever its size changes — a sub-list
// opening, the window resizing) and nudges it with a transform so no edge is
// clipped; a menu taller than the window gets a max-height and scrolls.
// Works for position:fixed and absolute alike, top- or bottom-anchored — the
// element's own left/top/bottom are left untouched.
import { useLayoutEffect, type RefObject } from 'react';

/** `key` = anything that identifies the open menu (x,y / pad index…); null or
 *  false = no menu. A new key re-runs the clamp for the new position. */
export function useKeepOnScreen(ref: RefObject<HTMLElement | null>, key: string | number | null | false, margin = 6): void {
  useLayoutEffect(() => {
    if (key === null || key === false) return;
    const el = ref.current;
    if (!el) return;
    let raf = 0;
    const clamp = () => {
      el.style.transform = '';
      const vw = window.innerWidth, vh = window.innerHeight;
      let r = el.getBoundingClientRect();
      if (r.height > vh - margin * 2) {
        el.style.maxHeight = `${vh - margin * 2}px`;
        el.style.overflowY = 'auto';
        r = el.getBoundingClientRect();
      }
      let dx = 0, dy = 0;
      if (r.right > vw - margin) dx = vw - margin - r.right;
      if (r.left + dx < margin) dx = margin - r.left;
      if (r.bottom > vh - margin) dy = vh - margin - r.bottom;
      if (r.top + dy < margin) dy = margin - r.top;
      if (dx || dy) el.style.transform = `translate(${Math.round(dx)}px, ${Math.round(dy)}px)`;
    };
    clamp();
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => { cancelAnimationFrame(raf); raf = requestAnimationFrame(clamp); }) : null;
    ro?.observe(el);
    window.addEventListener('resize', clamp);
    return () => { ro?.disconnect(); cancelAnimationFrame(raf); window.removeEventListener('resize', clamp); };
  }, [ref, key, margin]);
}
