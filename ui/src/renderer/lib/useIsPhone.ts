import { useEffect, useState } from 'react';

/** Reactive phone breakpoint — updates on resize / orientation change (a one-shot
 *  matchMedia read never updates when the device rotates). Kept in its own module
 *  so component files don't export a non-component (which breaks Fast Refresh). */
export function useIsPhone(maxWidth = 767): boolean {
  const q = `(max-width: ${maxWidth}px)`;
  const [phone, setPhone] = useState(() => { try { return window.matchMedia(q).matches; } catch { return false; } });
  useEffect(() => {
    let mql: MediaQueryList;
    try { mql = window.matchMedia(q); } catch { return; }
    const on = () => setPhone(mql.matches);
    on();
    mql.addEventListener?.('change', on);
    window.addEventListener('resize', on);
    window.addEventListener('orientationchange', on);
    return () => { mql.removeEventListener?.('change', on); window.removeEventListener('resize', on); window.removeEventListener('orientationchange', on); };
  }, [q]);
  return phone;
}
