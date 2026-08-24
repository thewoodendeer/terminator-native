import { useState } from 'react';

interface Props {
  onAccepted: () => void;
}

const ipc = (window as any).terminator as {
  eulaAccept: (name: string, email: string) => Promise<{ ok: boolean }>;
} | undefined;

export function EulaModal({ onAccepted }: Props) {
  const [name, setName]       = useState('');
  const [email, setEmail]     = useState('');
  const [agreed, setAgreed]   = useState(false);
  const [busy, setBusy]       = useState(false);
  const [error, setError]     = useState('');

  const handleAccept = async () => {
    if (!name.trim() || !email.trim()) { setError('Name and email required.'); return; }
    if (!agreed) { setError('You must agree to the terms.'); return; }
    setBusy(true);
    setError('');
    try {
      await ipc?.eulaAccept(name.trim(), email.trim());
      onAccepted();
    } catch (e: any) {
      setError(e?.message ?? 'Failed to record acceptance.');
      setBusy(false);
    }
  };

  return (
    <div className="eula-overlay">
      <div className="eula-modal">
        <div className="eula-header">
          <span className="eula-logo">T-800</span>
          <h2 className="eula-title">TERMS OF USE</h2>
        </div>

        <div className="eula-body">
          <p>
            Terminator uses <strong>yt-dlp</strong> to download audio from YouTube.
            This feature is provided for <strong>personal, non-commercial use only</strong>.
          </p>
          <p>
            By using this tool you agree to comply with{' '}
            <strong>YouTube's Terms of Service</strong>{' '}
            (<code>youtube.com/t/terms</code>). You are solely responsible for
            ensuring your use is lawful. The developer of Terminator accepts no
            liability for any ToS violations, copyright claims, or other consequences
            arising from your use of the download feature.
          </p>
          <p>
            MP3 export uses <strong>LAME</strong>, shipped with Terminator as a
            separate, unmodified program under the GNU LGPL v2.1. Terminator
            links no part of it. Encoder and full source:{' '}
            <code>lame.sourceforge.io</code>.
          </p>

          <h3 className="eula-subtitle">SAMPLE USAGE DISCLAIMER</h3>
          <p>
            Killavic Cheat Codes (KCC) provides access to audio samples for
            personal and educational use only.
          </p>
          <p>By using Terminator, you agree that:</p>
          <ul className="eula-list">
            <li>
              You are solely responsible for clearing all samples before any
              commercial release or public distribution of music made with this
              software.
            </li>
            <li>
              KCC is not liable for any copyright infringement, claims, damages,
              or legal action arising from your use of samples accessed through
              this application.
            </li>
            <li>
              Samples sourced from third-party platforms are subject to their
              respective copyright terms. It is your responsibility to obtain
              proper licensing for commercial use.
            </li>
            <li>
              KCC makes no warranties regarding the copyright status of any
              sample available through this application.
            </li>
          </ul>
          <p>
            By clicking ACCEPT, you acknowledge that you have read, understood,
            and agree to these terms.
          </p>
        </div>

        <div className="eula-fields">
          <label className="eula-label">
            NAME
            <input
              className="eula-input"
              type="text"
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder="Your name"
              disabled={busy}
            />
          </label>
          <label className="eula-label">
            EMAIL
            <input
              className="eula-input"
              type="email"
              value={email}
              onChange={e => setEmail(e.target.value)}
              placeholder="your@email.com"
              disabled={busy}
            />
          </label>
        </div>

        <label className="eula-agree">
          <input
            type="checkbox"
            checked={agreed}
            onChange={e => setAgreed(e.target.checked)}
            disabled={busy}
          />
          I have read and agree to the terms above
        </label>

        {error && <p className="eula-error">{error}</p>}

        <button
          className="eula-accept-btn"
          onClick={handleAccept}
          disabled={busy || !agreed}
        >
          {busy ? 'SAVING…' : 'ACCEPT & CONTINUE'}
        </button>
      </div>
    </div>
  );
}
