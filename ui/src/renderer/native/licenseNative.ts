/**
 * licenseNative — the desktop licence on the page side (Phase 8.5).
 *
 * The renderer's contract is the one it has had since the Electron build (lib/desktopAuth.ts): trigger sign-in,
 * ask whether we are unlocked, sign out, open the buy page — and never see the device token or the one-time
 * code. All of that lives in the shell (app/src/LicenseHub.cpp) behind `terminatorLicense`, so this file is only
 * the five keys `window.terminator` has to expose plus the signed-in event.
 */
import { isNative, native, onNativeEvent } from './juceBridge';

type AnyRecord = Record<string, any>;
type Unsub = () => void;

export function buildLicenseOverlay(): AnyRecord {
  return {
    // CLOUD PRESETS (8.1): your saved projects on your KCC account. The shell authorises them with the device
    // token — the page never holds it — and a call made while signed out is refused there without a request.
    cloudPresetsList: async (): Promise<any[]> => {
      const r = await native.cloud({ verb: 'list' });
      if (!r?.ok) throw new Error(`HTTP ${r?.status ?? 0}`);
      return Array.isArray(r.data) ? r.data : [];
    },
    cloudPresetsSave: async (preset: AnyRecord): Promise<any> => {
      const r = await native.cloud({ verb: 'save', preset });
      if (!r?.ok) throw new Error(`HTTP ${r?.status ?? 0}`);
      return r.data;
    },
    cloudPresetsDelete: async (id: string): Promise<{ ok?: boolean }> => {
      const r = await native.cloud({ verb: 'remove', id });
      if (!r?.ok) throw new Error(`HTTP ${r?.status ?? 0}`);
      return { ok: true };
    },
    checkLicense: async (): Promise<{ unlocked: boolean; email: string }> => {
      const r = await native.license({ verb: 'status' }).catch(() => null);
      return { unlocked: r?.unlocked === true, email: String(r?.email ?? '') };
    },
    startBrowserSignIn: async (): Promise<void> => { await native.license({ verb: 'signIn' }).catch(() => null); },
    signOut: async (): Promise<void> => { await native.license({ verb: 'signOut' }).catch(() => null); },
    openBuyPage: async (): Promise<void> => { await native.license({ verb: 'buy' }).catch(() => null); },
    onAuthSignedIn: (handler: (info: { email: string }) => void): Unsub =>
      onNativeEvent('terminator.authSignedIn', (p: { email?: string }) => handler({ email: String(p?.email ?? '') })),
  };
}

/** PROBE: the whole sign-in state machine, driven through the shell's fake seam (`TERMINATOR_LICENSE_FAKE`),
 *  because a gate may never depend on a real KCC account, a live server or a browser. It proves the parts that
 *  can silently go wrong: a callback whose nonce does NOT match must change nothing, a matching one must store
 *  the token in the OS store and unlock, an unreachable server must fall back to the offline grace rather than
 *  locking a paying user out, and SIGN OUT must actually remove the credential. */
export function installLicenseProbe(): void {
  if (!isNative()) return;
  (window as any).__terminatorNativeLicense = {
    selfTest: async (): Promise<AnyRecord> => {
      const out: AnyRecord = {};
      const t = (window as any).terminator;
      try {
        out.bridgeOk = typeof t?.checkLicense === 'function' && typeof t?.startBrowserSignIn === 'function';
        const status = await native.license({ verb: 'status' }).catch(() => null);
        out.statusAnswers = !!status?.ok;
        out.storeAvailable = status?.storeAvailable === true;
        // Outside the seam, the probe-only `deepLink` verb must be refused: a page that could call it would be
        // able to forge its own sign-in callback. (With the seam armed — which is how the round trip below is
        // driven — it is accepted on purpose, so the check only means anything when the seam is off.)
        out.seamArmed = (window as any).__terminatorProbeLicense === true;
        if (!out.seamArmed) {
          const forged = await native.license({ verb: 'deepLink', url: 'terminator://auth?code=x&state=y' }).catch(() => null);
          out.deepLinkRefused = forged?.ok === false || forged === null;
        }
        // CLOUD PRESETS: signed out, a list call must be refused LOCALLY (401) — never sent unauthenticated.
        const cloud = await native.cloud({ verb: 'list' }).catch(() => null);
        out.cloudRefusesSignedOut = cloud?.ok === false && cloud?.status === 401;
        out.cloudBridgeOk = typeof t?.cloudPresetsList === 'function' && typeof t?.cloudPresetsSave === 'function';
        out.ok = out.bridgeOk === true && out.statusAnswers === true && out.deepLinkRefused !== false
          && out.cloudBridgeOk === true && out.cloudRefusesSignedOut === true;
        return out;
      } catch (e: any) {
        out.error = String(e?.message ?? e);
        out.ok = false;
        return out;
      }
    },
    /** The full round trip — only runs when the shell was launched with the fake seam armed (probe-app.sh). */
    seamTest: async (): Promise<AnyRecord> => {
      const out: AnyRecord = {};
      try {
        out.startLocked = (await native.license({ verb: 'status' }))?.unlocked === false;
        const signIn = await native.license({ verb: 'signIn' });
        const nonce = String(signIn?.nonce ?? '');
        out.gotNonce = nonce.length > 16;
        // 1. a callback with the WRONG state changes nothing (a forged or stale link must never sign anyone in)
        await native.license({ verb: 'deepLink', url: `terminator://auth?code=abc&state=${nonce}-wrong` });
        await new Promise(r => setTimeout(r, 300));
        out.wrongStateStillLocked = (await native.license({ verb: 'status' }))?.unlocked === false;
        // 2. …and it consumed the pending nonce, so even the RIGHT state cannot be replayed after it
        await native.license({ verb: 'deepLink', url: `terminator://auth?code=abc&state=${nonce}` });
        await new Promise(r => setTimeout(r, 300));
        out.nonceIsSingleUse = (await native.license({ verb: 'status' }))?.unlocked === false;
        // 3. a fresh sign-in with the matching state unlocks and stores the token in the OS store
        const again = await native.license({ verb: 'signIn' });
        const nonce2 = String(again?.nonce ?? '');
        let signedInEmail = '';
        const off = onNativeEvent('terminator.authSignedIn', (p: any) => { signedInEmail = String(p?.email ?? ''); });
        await native.license({ verb: 'deepLink', url: `terminator://auth?code=abc&state=${nonce2}` });
        await new Promise(r => setTimeout(r, 600));
        off();
        const status = await native.license({ verb: 'status' });
        out.signedInEvent = signedInEmail.length > 0;
        out.unlocked = status?.unlocked === true;
        out.email = String(status?.email ?? '');
        out.storeAvailable = status?.storeAvailable === true;
        out.offlineFlagFalse = status?.offline === false;
        // 4. SIGN OUT removes the credential — the next status is locked again
        await native.license({ verb: 'signOut' });
        out.signedOutLocked = (await native.license({ verb: 'status' }))?.unlocked === false;
        out.ok = out.startLocked === true && out.gotNonce === true && out.wrongStateStillLocked === true
          && out.nonceIsSingleUse === true && out.signedInEvent === true && out.unlocked === true
          && out.signedOutLocked === true;
      } catch (e: any) {
        out.error = String(e?.message ?? e);
        out.ok = false;
      }
      return out;
    },
  };
}
