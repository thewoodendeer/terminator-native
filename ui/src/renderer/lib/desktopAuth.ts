/**
 * Desktop (Electron) licensing — RENDERER side.
 *
 * Thin client over the main-process desktopLicense module (via the preload
 * bridge). The renderer NEVER holds the device token or the one-time code — it
 * only triggers actions and caches the validated {unlocked, email} result in
 * memory for the synchronous isSubscribed() gate. There is NO localStorage, so
 * there is no persisted boolean to flip: unlock always reflects the main
 * process's last server-validated checkLicense().
 *
 * The web build never drives this: ChopperView's gate effect bails on isWeb, and
 * isSubscribed() uses the ?sub=1 wrapper path on web. ipc-browser.ts also
 * provides inert stubs so any bridge call is a harmless no-op there.
 */

interface LicenseBridge {
  startBrowserSignIn?: () => Promise<void>;
  checkLicense?: () => Promise<{ unlocked: boolean; email: string }>;
  signOut?: () => Promise<void>;
  openBuyPage?: () => Promise<void>;
  onAuthSignedIn?: (handler: (info: { email: string }) => void) => () => void;
}

function bridge(): LicenseBridge | undefined {
  return (window as any).terminator as LicenseBridge | undefined;
}

export interface LicenseState {
  unlocked: boolean;
  email: string;
}

// In-memory only. null = not yet checked. Populated by refreshLicense() at the
// Electron mount gate and on auth:signed-in; read synchronously by isSubscribed().
let license: LicenseState | null = null;

export function getLicense(): LicenseState | null {
  return license;
}

// Notify consumers that read the license cache OUTSIDE React render — e.g.
// App.tsx's body.tt-locked class, applied in a mount-only effect — so they
// re-apply when the (async) cache flips. Fires only in Electron: refreshLicense
// / signOutDesktop are never called on web (the gate effects bail on isWeb), so
// the web build never dispatches this and behaves exactly as before.
function notifyLicenseChanged(): void {
  try { window.dispatchEvent(new Event('terminator:license-changed')); } catch { /* no window */ }
}

/** Ask the main process to re-validate the stored device token with the server
 *  and cache the result. Any failure → locked. */
export async function refreshLicense(): Promise<LicenseState> {
  try {
    const r = await bridge()?.checkLicense?.();
    license = { unlocked: r?.unlocked === true, email: r?.email ?? '' };
  } catch {
    license = { unlocked: false, email: '' };
  }
  notifyLicenseChanged();
  return license;
}

/** Open the KCC browser sign-in. The unlock arrives later via the auth:signed-in
 *  event → refreshLicense(). */
export async function startBrowserSignIn(): Promise<void> {
  try { await bridge()?.startBrowserSignIn?.(); } catch { /* no bridge */ }
}

/** Clear the device token (main process) and the in-memory cache. */
export async function signOutDesktop(): Promise<void> {
  try { await bridge()?.signOut?.(); } catch { /* no bridge */ }
  license = { unlocked: false, email: '' };
  notifyLicenseChanged();
}

/** Open the buy page in the default browser. */
export function openBuyPage(): void {
  try { void bridge()?.openBuyPage?.(); } catch { /* no bridge */ }
}

/** Subscribe to the main-process "signed in" notification (fired after a
 *  successful browser sign-in + token exchange). Returns an unsubscribe fn. */
export function onAuthSignedIn(handler: (info: { email: string }) => void): () => void {
  return bridge()?.onAuthSignedIn?.(handler) ?? (() => {});
}
