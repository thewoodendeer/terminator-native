// TRANSFER TO DEVICE — the little two-way dialog. SEND: shows the code and the
// progress; RECEIVE: a code box. Portal'd to <body>, palette-aware.
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { sendProject, receiveProject, transferAvailable, type TransferProgress } from './projectTransfer';

interface Props {
  mode: 'send' | 'receive';
  /** SEND: build the bundle bytes (+ name) when the dialog opens. */
  getBundle?: () => Promise<{ bytes: Uint8Array; name: string; sizeNote?: string }>;
  /** RECEIVE: import the bytes that arrived. */
  onBundle?: (bytes: Uint8Array, name: string) => Promise<void>;
  onClose: () => void;
}

const fmtMb = (n: number) => `${(n / 1024 / 1024).toFixed(n < 10 * 1024 * 1024 ? 1 : 0)} MB`;

export function TransferModal({ mode, getBundle, onBundle, onClose }: Props) {
  const [prog, setProg] = useState<TransferProgress | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const handle = useRef<{ cancel: () => void } | null>(null);
  const [building, setBuilding] = useState(false);

  useEffect(() => {
    if (!transferAvailable()) { setErr('Device transfer needs a network connection and a browser with WebRTC.'); return; }
    if (mode !== 'send' || !getBundle) return;
    let dead = false;
    setBuilding(true);
    getBundle().then(({ bytes, name }) => {
      if (dead) return;
      setBuilding(false);
      handle.current = sendProject(bytes, name, setProg);
    }).catch((e) => { if (!dead) { setBuilding(false); setErr(e?.message ?? String(e)); } });
    return () => { dead = true; handle.current?.cancel(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { handle.current?.cancel(); onClose(); } };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const startReceive = () => {
    const c = code.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (c.length < 6 || !onBundle) return;
    setErr(null);
    handle.current = receiveProject(c, setProg, onBundle);
  };

  const pct = prog && prog.total > 0 ? Math.round((prog.sent / prog.total) * 100) : 0;
  const phaseText = (p: TransferProgress | null): string => {
    if (!p) return '';
    switch (p.phase) {
      case 'waiting': return 'Waiting for the other device… type this code there: OPEN… → RECEIVE.';
      case 'connecting': return `Connecting… ${p.detail ?? ''}`;
      case 'sending': return `Sending ${p.name ?? ''} — ${fmtMb(p.sent)} of ${fmtMb(p.total)}${p.detail ? ` · ${p.detail}` : ''}`;
      case 'receiving': return `Receiving ${p.name ?? ''} — ${fmtMb(p.sent)} of ${fmtMb(p.total)}`;
      case 'importing': return 'Importing…';
      case 'done': return `Done — ${p.name ?? 'project'} is on the other device.`;
      case 'failed': return `Failed: ${p.detail ?? 'unknown error'}`;
      case 'busy': return `Busy: ${p.detail ?? ''}`;
      case 'timeout': return `Timed out: ${p.detail ?? ''}`;
      default: return '';
    }
  };
  const done = prog?.phase === 'done';
  const dead = prog?.phase === 'failed' || prog?.phase === 'busy' || prog?.phase === 'timeout';

  return createPortal(
    <>
      <div className="xfer-backdrop" onPointerDown={() => { handle.current?.cancel(); onClose(); }} />
      <div className="xfer-modal" role="dialog" aria-label="Transfer project">
        <div className="xfer-title">{mode === 'send' ? 'TRANSFER TO DEVICE' : 'RECEIVE FROM DEVICE'}</div>
        {err && <div className="xfer-err">{err}</div>}
        {mode === 'send' && !err && (
          <>
            {building && <div className="xfer-line">Packing the project and its samples…</div>}
            {prog?.code && !done && (
              <>
                <div className="xfer-line">On the other device (desktop app or terminator on the web): <b>OPEN… → RECEIVE</b>, then type</div>
                <div className="xfer-code" title="The transfer code — valid while this window is open">{prog.code.slice(0, 4)} {prog.code.slice(4)}</div>
                <div className="xfer-line small">{fmtMb(prog.total)} · peer-to-peer, nothing is uploaded</div>
              </>
            )}
          </>
        )}
        {mode === 'receive' && !err && !prog && (
          <>
            <div className="xfer-line">Type the code the sending device is showing (its OPEN… → TRANSFER TO DEVICE):</div>
            <div className="xfer-row">
              <input className="xfer-input" value={code} autoFocus={typeof window !== 'undefined' && !window.matchMedia('(pointer: coarse)').matches}
                onChange={(e) => setCode(e.target.value.toUpperCase())} onKeyDown={(e) => { if (e.key === 'Enter') startReceive(); }}
                placeholder="XXXX XXXX" maxLength={9} inputMode="text" autoCapitalize="characters" autoCorrect="off" spellCheck={false} />
              <button className="xfer-btn on" onClick={startReceive} disabled={code.replace(/[^A-Za-z0-9]/g, '').length < 6}>RECEIVE</button>
            </div>
          </>
        )}
        {prog && (
          <>
            <div className={`xfer-line${dead ? ' bad' : ''}${done ? ' ok' : ''}`}>{phaseText(prog)}</div>
            {(prog.phase === 'sending' || prog.phase === 'receiving') && (
              <div className="xfer-bar"><i style={{ width: `${pct}%` }} /></div>
            )}
          </>
        )}
        <div className="xfer-row end">
          {dead && mode === 'receive' && <button className="xfer-btn" onClick={() => { setProg(null); }}>TRY AGAIN</button>}
          <button className="xfer-btn" onClick={() => { handle.current?.cancel(); onClose(); }}>{done ? 'CLOSE' : 'CANCEL'}</button>
        </div>
      </div>
    </>,
    document.body,
  );
}
