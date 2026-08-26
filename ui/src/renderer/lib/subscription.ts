/**
 * Subscription gating for the embedded /terminator route on
 * killaviccheatcodes.app. The Next.js wrapper passes ?sub=1 in the iframe
 * URL when the user is signed-in + has an active/trialing Stripe sub (or
 * the `gifted_pro` flag). Anyone else hits the free tier:
 *
 *   - 3 pads max (rest are greyed + un-clickable)
 *   - 10 sample pulls (loadTrackById / swapTrackFromPlaylist calls)
 *   - sequencer / drums / FX / presets / export are greyed out
 *
 * Subscribers ignore all limits.
 *
 * Local-dev builds default to "subscribed" so they aren't accidentally crippled. A PACKAGED desktop build —
 * Electron or the native 3.0 shell — is gated by the server-validated device licence, exactly alike.
 */

import { getLicense } from './desktopAuth';

export const FREE_PAD_LIMIT = 3;
export const FREE_PULL_LIMIT = 10;
const PULL_COUNTER_KEY = 'terminator.free-pulls';

declare const __TERMINATOR_WEB__: boolean;
// True for BOTH the prod web bundle AND the local dev:web tunnel (MODE==='web');
// false only in the Electron build. Distinguishes "web bundle" from "Electron".
const isWeb = (import.meta as any).env?.MODE === 'web';

/** DEMO — the site's /terminator/download embed (`?demo=1`, web only). The
 *  machine is fully playable (every section, all pads) but nothing leaves it:
 *  no save, no record, no export, no Beat Finisher; themes limited; 10 sample
 *  listens/pulls, then the purchase popup — and closing that closes the sample
 *  browser until a reload. Never true in Electron or on /terminator. */
export function isDemo(): boolean {
  if (typeof window === 'undefined' || !isWeb) return false;
  try { return new URLSearchParams(window.location.search).get('demo') === '1'; } catch { return false; }
}

export function isSubscribed(): boolean {
  if (typeof window === 'undefined') return true;
  if (!isWeb) {
    // DEV Electron (renderer served by the vite dev server) runs UNLOCKED —
    // desktop-only Pro features (STEMS…) are untestable otherwise, and the
    // dev sign-in flow can't complete. Packaged builds load the BUILT bundle
    // where import.meta.env.DEV is false, so production is untouched.
    if ((import.meta as any).env?.DEV) return true;
    // NATIVE (Terminator 3.0, JUCE shell) behaves EXACTLY like Electron here — same rule, same source of
    // truth. The escape hatch that returned true unconditionally while the licence was only OBSERVED is gone
    // (Phase 8.5c): the shell now holds the device token in the OS keychain, re-validates against
    // /api/terminator-check each launch, and falls back to a 7-day offline grace rather than locking anyone
    // out when the server cannot be reached.
    //
    // Electron desktop AND native: ONLY the server-validated device license unlocks. This
    // is an in-memory cache the main process populates via checkLicense() each
    // launch (no localStorage — nothing to flip). null (pre-check / signed out)
    // = free tier; the sign-in gate is shown over the app until it resolves.
    return getLicense()?.unlocked === true;
  }
  // Web bundle (prod KCC wrapper OR local dev:web) — UNCHANGED behaviour.
  if (typeof __TERMINATOR_WEB__ !== 'undefined' && !__TERMINATOR_WEB__) return true; // dev:web
  try {
    const params = new URLSearchParams(window.location.search);
    return params.get('sub') === '1';
  } catch { return true; }
}

/**
 * True when a Supabase user is signed in on the KCC wrapper. The Next.js
 * wrapper appends ?auth=1 to the iframe URL whenever `user` exists (pro OR
 * free) — distinct from ?sub=1 (pro only). Used to show the in-app SIGN OUT
 * control in the EXPORT section instead of a floating pill over the iframe.
 * Standalone Electron / local web dev → not framed → no auth=1 → treated as
 * signed out, so the in-app sign-out control simply doesn't render there.
 */
export function isSignedIn(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return new URLSearchParams(window.location.search).get('auth') === '1';
  } catch { return false; }
}

export function pullsUsed(): number {
  try {
    return Math.max(0, Number(localStorage.getItem(PULL_COUNTER_KEY) ?? '0'));
  } catch { return 0; }
}

export function pullsRemaining(): number {
  return Math.max(0, FREE_PULL_LIMIT - pullsUsed());
}

/** Returns true if the caller may proceed; false means the limit is hit. */
export function recordPull(): boolean {
  if (isSubscribed()) return true;
  const used = pullsUsed();
  if (used >= FREE_PULL_LIMIT) return false;
  try { localStorage.setItem(PULL_COUNTER_KEY, String(used + 1)); } catch { /* */ }
  return true;
}

/** Sends the user to the KCC pricing page in the TOP window (we're in an
 *  iframe). Falls back to opening pricing in a new tab if cross-frame
 *  navigation is blocked for any reason. */
export function goToPricing(): void {
  navTopUrl('https://killaviccheatcodes.app/pricing');
}

/** Top-window navigation (we're usually in an iframe). */
/** ON THE DESKTOP APP a link may never NAVIGATE: the app IS the page, so setting location.href replaces
 *  Terminator with a website and there is no back button to a native window. `window.open` is no better — the
 *  shell's WebView has no handler for it, so it silently does nothing. Every outward link therefore goes to the
 *  OS browser through the bridge. On the web this function is the behaviour it always had. */
function navTopUrl(url: string): void {
  if (!isWeb) {
    try { void (window as any).terminator?.openExternal?.(url); } catch { /* no bridge — nothing sensible to do */ }
    return;
  }
  try {
    if (window.top && window.top !== window.self) { window.top.location.href = url; return; }
  } catch { /* cross-origin, fall through */ }
  if (typeof window !== 'undefined' && !(window as any).top) window.open(url, '_blank');
  else window.location.href = url;
}

/** The desktop download page — DMG / EXE for signed-in owners, the pitch +
 *  buy for everyone else. */
export const TERMINATOR_DOWNLOAD_URL = 'https://killaviccheatcodes.app/terminator/download';
export function goToDesktopDownload(): void { navTopUrl(TERMINATOR_DOWNLOAD_URL); }

/** Buy the $40 lifetime license: same-origin checkout API (cookie session).
 *  401 → sign-in first, back to /terminator after. Resolves to an error text
 *  (or null when the browser is being redirected). */
export const TERMINATOR_BUY_URL = 'https://killaviccheatcodes.app/terminator';

export async function buyLifetime(): Promise<string | null> {
  // DESKTOP: there is no same-origin `/api/...` to POST to — the app is served from the shell, not from KCC —
  // so a checkout can only happen in the browser, where the session cookie lives. Hand it over and stop.
  if (!isWeb) { navTopUrl(TERMINATOR_BUY_URL); return null; }
  try {
    const r = await fetch('/api/checkout/terminator-lifetime', { method: 'POST', credentials: 'include' });
    if (r.status === 401) { navTopUrl('https://killaviccheatcodes.app/signin?next=/terminator'); return null; }
    const j = await r.json().catch(() => null);
    if (r.ok && j?.url) { navTopUrl(j.url); return null; }
    return j?.error || `Checkout failed (${r.status}). Please try again.`;
  } catch (e: any) {
    return `Checkout error: ${e?.message ?? 'network problem'}. Please try again.`;
  }
}
