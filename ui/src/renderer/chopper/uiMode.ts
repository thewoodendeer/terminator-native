// UI MODE — which layout the chopper renders: the DESKTOP ChopperView or the
// MOBILE HardwareView. AUTO = the historical rule (coarse pointer or a window
// under 768px → mobile). Persisted so an iPad can live on the desktop layout
// (or a laptop on the phone one). Read once per page load by the router at the
// top of ChopperView; changing it reloads the page (both views own their own
// engines — there is no live hand-over — so the switch confirms first).
export type UiMode = 'auto' | 'desktop' | 'mobile';

const KEY = 'terminator.uiMode';

export function getUiMode(): UiMode {
  // `?ui=desktop|mobile` on the app URL wins for THIS load and is not
  // persisted — the site's /terminator/download embed uses it so a visitor on
  // a laptop or iPad sees the desktop machine, whatever the frame's width.
  try {
    const u = new URLSearchParams(window.location.search).get('ui');
    if (u === 'desktop' || u === 'mobile') return u;
  } catch { /* */ }
  try {
    const v = localStorage.getItem(KEY);
    // A saved MOBILE only counts on a touch device. A computer always opens the
    // desktop layout (his rule: /terminator defaults to the desktop view) — a
    // "mobile" left in localStorage from a test was making a laptop boot into
    // the phone machine every time. The stale key is dropped so it can't come
    // back; `?ui=mobile` is the way to look at the phone layout on a computer.
    if (v === 'mobile' && !isTouchDevice()) { try { localStorage.removeItem(KEY); } catch { /* */ } return 'auto'; }
    return v === 'desktop' || v === 'mobile' ? v : 'auto';
  } catch { return 'auto'; }
}

export function setUiMode(mode: UiMode): void {
  try {
    if (mode === 'auto') localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, mode);
  } catch { /* private mode */ }
}

/** The AUTO rule. Only a PHONE gets the mobile (hardware) layout; everything
 *  else — laptops, desktops, and TABLETS — gets the desktop one (his call,
 *  2026-08-18: /terminator must default to the desktop view; an iPad "is a
 *  better candidate to have the desktop experience"). A phone is a touch
 *  screen whose SHORT side is under TABLET_MIN_SHORT_SIDE css px — every
 *  iPhone (the Pro Max is 440) sits under it, every iPad (the mini is 744)
 *  clears it. Measured on `screen`, not the window, so rotating, Split View or
 *  a narrow browser window can't flip the layout. `?ui=` and the saved UI
 *  choice (theme picker → UI) override all of this. */
export const TABLET_MIN_SHORT_SIDE = 600;
function screenShortSide(): number {
  const sw = window.screen?.width || window.innerWidth;
  const sh = window.screen?.height || window.innerHeight;
  return Math.min(sw, sh);
}
export function isPhoneScreen(): boolean {
  if (typeof window === 'undefined') return false;
  return isTouchDevice() && screenShortSide() < TABLET_MIN_SHORT_SIDE;
}
export function isTabletScreen(): boolean {
  if (typeof window === 'undefined') return false;
  return isTouchDevice() && screenShortSide() >= TABLET_MIN_SHORT_SIDE;
}
export function autoWantsMobile(): boolean {
  return isPhoneScreen();
}

/** Touch-capable device (phone / iPad, incl. iPadOS with its desktop UA). */
export function isTouchDevice(): boolean {
  if (typeof window === 'undefined') return false;
  return window.matchMedia('(pointer: coarse)').matches || (navigator.maxTouchPoints ?? 0) > 1;
}

/** Switch layouts: confirms (the page reloads, unsaved work is lost), persists,
 *  reloads. Returns false when the user cancelled or nothing changed. */
export function switchUiMode(mode: UiMode): boolean {
  if (mode === getUiMode()) return false;
  const label = mode === 'desktop' ? 'the DESKTOP layout' : mode === 'mobile' ? 'the MOBILE layout' : 'AUTO layout';
  const ok = window.confirm(`Switch to ${label}?\n\nTerminator reloads to change layout — save your project first if you have unsaved work.`);
  if (!ok) return false;
  // Drop the layout query params so they don't override the new choice.
  const url = new URL(window.location.href);
  url.searchParams.delete('v2'); url.searchParams.delete('hardware'); url.searchParams.delete('classic'); url.searchParams.delete('ui');
  if (mode === 'mobile' && !isTouchDevice()) {
    // On a computer the phone layout is a one-off look, never the default
    // (getUiMode ignores a saved MOBILE there): carry it in the URL instead.
    setUiMode('auto');
    url.searchParams.set('ui', 'mobile');
  } else {
    setUiMode(mode);
  }
  window.location.replace(url.toString());
  return true;
}
