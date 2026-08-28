/**
 * licenseNative — the desktop licence on the page side (Phase 8.5).
 *
 * The renderer's contract is the one it has had since the Electron build (lib/desktopAuth.ts): trigger sign-in,
 * ask whether we are unlocked, sign out, open the buy page — and never see the device token or the one-time
 * code. All of that lives in the shell (app/src/LicenseHub.cpp) behind `terminatorLicense`, so this file is only
 * the five keys `window.terminator` has to expose plus the signed-in event.
 */
import { isNative, native, onNativeEvent } from './juceBridge';
import { refreshLicense } from '../lib/desktopAuth';
import { isSubscribed } from '../lib/subscription';

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
    // The KCC ACCOUNT page — where somebody who already owns Terminator manages it. Distinct from the buy page
    // on purpose: sending an existing owner to a product page is the same mistake as offering a desktop
    // download to somebody already running the desktop app.
    openAccountPage: async (): Promise<void> => { await native.license({ verb: 'account' }).catch(() => null); },
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
        // WHERE THE TWO BUTTONS GO. With the seam armed neither opens a browser, they just answer — so the
        // destinations are checked rather than trusted. GET TERMINATOR goes to the DOWNLOAD page (it sells it
        // and hands an owner the DMG/EXE); MY ACCOUNT goes to the KCC account page.
        if (out.seamArmed) {
          out.buyUrl = String((await native.license({ verb: 'buy' }).catch(() => null))?.url ?? '');
          out.accountUrl = String((await native.license({ verb: 'account' }).catch(() => null))?.url ?? '');
          out.urlsOk = out.buyUrl.endsWith('/terminator/download') && out.accountUrl.endsWith('/account');
        }
        out.ok = out.bridgeOk === true && out.statusAnswers === true && out.deepLinkRefused !== false
          && out.cloudBridgeOk === true && out.cloudRefusesSignedOut === true && out.urlsOk !== false;
        return out;
      } catch (e: any) {
        out.error = String(e?.message ?? e);
        out.ok = false;
        return out;
      }
    },
    /** UNLOCK THIS RUN before anything else is measured (8.5c). The licence is ENFORCED now, so a probe that
     *  starts with no stored token is a FREE-TIER app: three pads, no export, no Beat Finisher — and every
     *  engine check that triggers pad 63 measures the paywall instead of the engine. So the probe signs in
     *  through the seam first, exactly the way a person does, and asserts the gate actually lifted. Only ever
     *  reachable with the fake seam armed; a real launch cannot call it. */
    probeUnlock: async (): Promise<AnyRecord> => {
      const out: AnyRecord = {};
      try {
        // START FROM NO ACCOUNT, always. Reading the overlay as it happens to be at mount measures whatever
        // token was left in the OS store by an earlier run, not this build — the packaged app read a leftover
        // probe token and came up already unlocked, which is the same "gate depends on the machine" mistake as
        // the old mixerPdcPlan and prefsWindow checks. So: sign out, re-run THE LAUNCH-TIME GATE DECISION
        // itself, and assert both halves of what a person without an account sees.
        const cleared = await native.license({ verb: 'signOut' });
        // A credential written by a DIFFERENTLY SIGNED build of this app (debug vs the universal release) can
        // survive an erase, and everything below would then measure the leftover rather than this build. Report
        // it so a failure names the real cause instead of "this build ships free to everybody".
        out.credentialCleared = cleared?.cleared !== false;
        await refreshLicense();
        out.lockedWithoutAccount = isSubscribed() === false;
        const recheck = (window as any).__terminatorProbeCheckGate;
        if (typeof recheck === 'function') {
          await recheck();
          for (let i = 0; i < 40 && !document.querySelector('.signin-modal'); i++)
            await new Promise(r => setTimeout(r, 50));
          out.gatedBeforeSignIn = !!document.querySelector('.signin-modal');
        }
        const signIn = await native.license({ verb: 'signIn' });
        const nonce = String(signIn?.nonce ?? '');
        await native.license({ verb: 'deepLink', url: `terminator://auth?code=probe&state=${nonce}` });
        // The page re-checks on the authSignedIn event; wait for the OVERLAY to go, which is the thing a
        // person would see, rather than for a variable.
        for (let i = 0; i < 40 && document.querySelector('.signin-modal'); i++)
          await new Promise(r => setTimeout(r, 50));
        out.overlayGone = !document.querySelector('.signin-modal');
        out.unlocked = (await native.license({ verb: 'status' }))?.unlocked === true;
        await refreshLicense();
        out.subscribedAfterSignIn = isSubscribed() === true;
        out.ok = out.lockedWithoutAccount === true && out.gatedBeforeSignIn === true
          && out.overlayGone === true && out.unlocked === true && out.subscribedAfterSignIn === true;
      } catch (e: any) {
        out.error = String(e?.message ?? e);
        out.ok = false;
      }
      return out;
    },
    /** The full round trip — only runs when the shell was launched with the fake seam armed (probe-app.sh). */
    seamTest: async (): Promise<AnyRecord> => {
      const out: AnyRecord = {};
      try {
        // Start from NO CREDENTIAL whatever this run did before (probeUnlock signs in first now), so
        // "with nothing stored we are locked" still means what it says.
        await native.license({ verb: 'signOut' });
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
        // 4. THE OFFLINE GRACE (8.5c). This is the check that protects a PAYING user: the licence is enforced
        //    now, so a server that cannot be reached must NOT lock him out of an app he owns. With the token
        //    stored and validated moments ago, an unreachable server keeps him unlocked and says `offline`.
        await native.license({ verb: 'setFake', mode: 'offline' });
        const grace = await native.license({ verb: 'status' });
        out.offlineGraceUnlocks = grace?.unlocked === true;
        out.offlineFlagTrue = grace?.offline === true;
        // …and a server that is REACHABLE and refuses the entitlement (refunded, revoked) really does lock,
        //    drop the token, and put the gate back on screen. The other half of the same promise.
        await native.license({ verb: 'setFake', mode: 'locked' });
        const refused = await native.license({ verb: 'status' });
        out.refusedLocks = refused?.unlocked === false;
        //    The consequence in the UI is the FREE TIER taking effect immediately (3 pads, no export). The
        //    sign-in OVERLAY is a launch-time decision — Terminator has never thrown a modal over somebody
        //    mid-beat because a server answered oddly, and this build does not start — so what is asserted here
        //    is the entitlement the app actually acts on.
        await refreshLicense();
        out.refusedDropsToFreeTier = isSubscribed() === false;
        // 5. SIGN OUT removes the credential — the next status is locked again
        await native.license({ verb: 'setFake', mode: 'unlocked:probe@terminator.test' });
        await native.license({ verb: 'signOut' });
        out.signedOutLocked = (await native.license({ verb: 'status' }))?.unlocked === false;
        // Leave this run SIGNED IN: everything read after this point (the final DOM read, the menu) would
        // otherwise be measuring the free tier.
        const back = await native.license({ verb: 'signIn' });
        await native.license({ verb: 'deepLink', url: `terminator://auth?code=probe&state=${String(back?.nonce ?? '')}` });
        await new Promise(r => setTimeout(r, 400));
        await refreshLicense();
        out.endsUnlocked = (await native.license({ verb: 'status' }))?.unlocked === true;
        out.ok = out.startLocked === true && out.gotNonce === true && out.wrongStateStillLocked === true
          && out.nonceIsSingleUse === true && out.signedInEvent === true && out.unlocked === true
          && out.offlineGraceUnlocks === true && out.offlineFlagTrue === true && out.refusedLocks === true
          && out.refusedDropsToFreeTier === true && out.signedOutLocked === true && out.endsUnlocked === true;
      } catch (e: any) {
        out.error = String(e?.message ?? e);
        out.ok = false;
      }
      return out;
    },
  };
}
