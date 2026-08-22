import { useState } from 'react';
import { goToPricing, buyLifetime, goToDesktopDownload, FREE_PAD_LIMIT, FREE_PULL_LIMIT } from '../lib/subscription';

interface Props {
  open: boolean;
  onClose: () => void;
  /** Host-supplied lifetime checkout (ChopperView has one with its own
   *  toasts); defaults to the shared buyLifetime(). */
  onBuyLifetime?: () => void | Promise<void>;
  /** DEMO (the site's download-page embed): the copy reads "want to explore
   *  more?" instead of "you're on the free tier". */
  demo?: boolean;
}

/** The purchase popup. Free-tier users land here when they hit the pull cap or
 *  a locked pad. Two ways in — LIFETIME ($40, one-time) or the KCC SUITE
 *  subscription — and both include the desktop
 *  app for macOS + Windows, which is new and gets said up top. */
export function SubscribeModal({ open, onClose, onBuyLifetime, demo }: Props) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  if (!open) return null;
  const buy = async () => {
    if (busy) return;
    setBusy(true); setErr(null);
    try {
      if (onBuyLifetime) { await onBuyLifetime(); return; }
      const e = await buyLifetime();
      if (e) { setErr(e); setBusy(false); }
    } catch (e: any) { setErr(e?.message ?? 'Something went wrong'); setBusy(false); }
  };
  return (
    <div className="sub-modal-backdrop" onClick={onClose}>
      <div className="sub-modal sub-modal--v2" onClick={e => e.stopPropagation()} role="dialog" aria-label="Unlock Terminator">
        <button className="sub-modal-close" onClick={onClose} aria-label="Close">×</button>
        <div className="sub-modal-eyebrow">
          <span className="sub-modal-brand">TERMINATOR</span>
          <span className="sub-modal-new">NEW · NOW ON macOS &amp; WINDOWS</span>
        </div>
        <h2 className="sub-modal-title">{demo ? 'WANT TO EXPLORE MORE?' : 'UNLOCK THE FULL MACHINE'}</h2>
        <p className="sub-modal-sub">
          {demo ? (
            <>This is the demo — the whole machine to play, {FREE_PULL_LIMIT} samples to pull. Saving, recording, exporting, the Beat Finisher and the rest of the themes are in the real thing: Terminator, in your browser <em>and</em> as a desktop app for Mac and Windows.</>
          ) : (
            <>You're on the free tier — {FREE_PAD_LIMIT} pads, {FREE_PULL_LIMIT} sample pulls. Everything below is one click away,
            in this browser <em>and</em> as a desktop app you install on your Mac or PC.</>
          )}
        </p>

        <div className="sub-modal-paths">
          <div className="sub-modal-path sub-modal-path--life">
            <div className="sub-modal-path-head">
              <span className="sub-modal-path-name">LIFETIME</span>
              <span className="sub-modal-price">$40 <small>one-time</small></span>
            </div>
            <ul className="sub-modal-path-list">
              <li>Terminator, yours forever — no subscription</li>
              <li>Web app + desktop app (macOS &amp; Windows)</li>
              <li>Every future update</li>
            </ul>
            <button className="sub-modal-cta" onClick={buy} disabled={busy}>{busy ? '…' : 'GET TERMINATOR — $40'}</button>
          </div>
          <div className="sub-modal-path sub-modal-path--suite">
            <div className="sub-modal-path-head">
              <span className="sub-modal-path-name">KCC SUITE</span>
              <span className="sub-modal-price"><small>subscription</small></span>
            </div>
            <ul className="sub-modal-path-list">
              <li>Terminator + every Killavic Cheat Codes tool</li>
              <li>Same desktop apps included</li>
              <li>The lessons + the AI instructor</li>
            </ul>
            <button className="sub-modal-cta sub-modal-cta--ghost" onClick={goToPricing}>SEE THE SUITE</button>
          </div>
        </div>
        {err && <p className="sub-modal-err">{err}</p>}

        <div className="sub-modal-features-title">WHAT'S INSIDE</div>
        <ul className="sub-modal-features sub-modal-features--grid">
          <li><b>BASS</b> — a Model D–style synth + piano roll, locked to your key <i>new</i></li>
          <li><b>CHOPS</b> — unlimited pads, your own samples, unlimited pulls</li>
          <li><b>DRUMS</b> — the drum machine, generators, swing, kits</li>
          <li><b>MIX</b> — DAW mixer, sends, Beat Finisher arranger</li>
          <li><b>PROJECTS</b> — save with samples, transfer laptop ↔ iPad <i>new</i></li>
          <li><b>EXPORT</b> — master, stems, MPC project, Drum Rack</li>
        </ul>
        <div className="sub-modal-footrow">
          <button className="sub-modal-link" onClick={goToDesktopDownload}>Already own it? Download the desktop app →</button>
          <button className="sub-modal-dismiss" onClick={onClose}>Not now</button>
        </div>
      </div>
    </div>
  );
}
