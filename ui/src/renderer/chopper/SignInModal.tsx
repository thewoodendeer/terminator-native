import { useState } from 'react';
import { startBrowserSignIn, openBuyPage } from '../lib/desktopAuth';

interface Props {
  /** "Continue with limited access" — dismiss the gate and use the free tier.
   *  (The actual unlock, when the user signs in, arrives via the main-process
   *  auth:signed-in event → checkLicense, handled by ChopperView.) */
  onContinueFree: () => void;
}

// Browser-only sign-in. The renderer never handles passwords, the one-time code,
// or the device token — clicking SIGN IN opens the KCC bridge in the default
// browser (main process), which deep-links back and unlocks the app.
export function SignInModal({ onContinueFree }: Props) {
  const [waiting, setWaiting] = useState(false);

  const handleSignIn = () => {
    setWaiting(true);
    void startBrowserSignIn();
  };

  return (
    <div className="eula-overlay">
      <div className="eula-modal signin-modal">
        <div className="eula-header">
          <span className="eula-logo">T-800</span>
          <h2 className="eula-title">SIGN IN</h2>
        </div>

        <p className="signin-msg">
          Sign in with your Killavic Cheat Codes account to unlock Terminator.
          We&apos;ll open your browser to sign in securely, then bring you back.
        </p>

        <button className="eula-accept-btn" onClick={handleSignIn}>
          SIGN IN VIA BROWSER
        </button>

        {waiting && (
          <p className="signin-msg" style={{ opacity: 0.7 }}>
            Waiting for you to finish signing in in your browser… you&apos;ll be
            unlocked automatically when you return.
          </p>
        )}

        <div className="signin-divider"><span>NO ACCOUNT?</span></div>

        <div className="signin-alt">
          <button
            type="button"
            className="signin-alt-btn signin-buy"
            onClick={() => openBuyPage()}
          >
            GET TERMINATOR ($40)
          </button>
        </div>

        <button
          type="button"
          className="signin-skip"
          onClick={onContinueFree}
        >
          Continue with limited access →
        </button>
      </div>
    </div>
  );
}
