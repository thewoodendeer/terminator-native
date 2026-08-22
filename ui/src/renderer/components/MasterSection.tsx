import { useState } from 'react';
import { WAVBitDepth, ExportFormat } from '../audio/StemExporter';

interface Props {
  masterVolume:   number;
  limiterEnabled: boolean;
  onMasterVolume: (v: number) => void;
  onLimiter:      (v: boolean) => void;
  onExportStems:  (format: ExportFormat, bitDepth: WAVBitDepth, dry: boolean) => void;
  onExportMaster: (format: ExportFormat, bitDepth: WAVBitDepth, dry: boolean) => void;
  mpcExportDir:   string | null;
  onExportToMpc:  (format: ExportFormat, bitDepth: WAVBitDepth, dry: boolean) => Promise<{ savedTo?: string; error?: string }>;
  onEjectMpc:     () => Promise<{ ok?: true; error?: string }>;
}

export function MasterSection({ masterVolume, limiterEnabled, onMasterVolume, onLimiter, onExportStems, onExportMaster, mpcExportDir, onExportToMpc, onEjectMpc }: Props) {
  const [format, setFormat]       = useState<ExportFormat>('wav');
  const [bitDepth, setBitDepth]   = useState<WAVBitDepth>(24);
  const [dry, setDry]             = useState(false);
  const [exporting, setExporting] = useState(false);
  const [mpcStatus, setMpcStatus] = useState<string | null>(null);
  const [ejecting, setEjecting]   = useState(false);

  const handleExportStems = async () => {
    setExporting(true);
    try { await onExportStems(format, bitDepth, dry); }
    finally { setExporting(false); }
  };

  const handleExportMaster = async () => {
    setExporting(true);
    try { await onExportMaster(format, bitDepth, dry); }
    finally { setExporting(false); }
  };

  const handleExportToMpc = async () => {
    setExporting(true);
    setMpcStatus(null);
    try {
      const res = await onExportToMpc(format, bitDepth, dry);
      setMpcStatus(res.error ? `ERR: ${res.error}` : `SAVED → ${res.savedTo}`);
      setTimeout(() => setMpcStatus(null), 4000);
    } finally { setExporting(false); }
  };

  const handleEjectMpc = async () => {
    setEjecting(true);
    setMpcStatus(null);
    try {
      const res = await onEjectMpc();
      setMpcStatus(res.error ? `EJECT FAILED: ${res.error}` : 'SAFE TO REMOVE');
      setTimeout(() => setMpcStatus(null), 4000);
    } finally { setEjecting(false); }
  };

  return (
    <div className="master-section">
      <div className="master-title">MASTER</div>

      <div className="master-controls">
        <label className="ctrl-group">
          <span className="ctrl-label">LEVEL</span>
          <input type="range" className="fader master-fader" min={0} max={1} step={0.01}
            value={masterVolume}
            onChange={e => onMasterVolume(Number(e.target.value))}
            onDoubleClick={() => onMasterVolume(0.85)}
            title="Double-click to reset" />
          <span className="ctrl-value">{Math.round(masterVolume * 100)}</span>
        </label>

        <div className="vu-meter">
          <div className="vu-bar vu-l" style={{ height: `${masterVolume * 80}%` }} />
          <div className="vu-bar vu-r" style={{ height: `${masterVolume * 75}%` }} />
        </div>

        <button
          className={`btn btn-limiter ${limiterEnabled ? 'active' : ''}`}
          onClick={() => onLimiter(!limiterEnabled)}
          title="Master limiter"
        >
          {limiterEnabled ? '⬛ LIMIT ON' : '⬜ LIMIT OFF'}
        </button>
      </div>

      <div className="export-section">
        <div className="export-title">EXPORT</div>

        <div className="export-opts">
          <label className="ctrl-group">
            <span className="ctrl-label">FORMAT</span>
            <select className="ctrl-select" value={format} onChange={e => setFormat(e.target.value as ExportFormat)}>
              <option value="wav">WAV</option>
              <option value="mp3">MP3 ⚠</option>
              <option value="flac">FLAC ⚠</option>
            </select>
          </label>

          {format === 'wav' && (
            <label className="ctrl-group">
              <span className="ctrl-label">BIT DEPTH</span>
              <select className="ctrl-select" value={bitDepth} onChange={e => setBitDepth(Number(e.target.value) as WAVBitDepth)}>
                <option value={8}>8-bit</option>
                <option value={16}>16-bit</option>
                <option value={24}>24-bit</option>
                <option value={32}>32f</option>
              </select>
            </label>
          )}

          <label className="ctrl-check">
            <input type="checkbox" checked={dry} onChange={e => setDry(e.target.checked)} />
            <span>DRY EXPORT</span>
          </label>
        </div>

        <div className="export-btns">
          <button className={`btn btn-export ${exporting ? 'loading' : ''}`} onClick={handleExportStems} disabled={exporting}>
            {exporting ? 'RENDERING…' : '⬇ STEMS'}
          </button>
          <button className={`btn btn-export ${exporting ? 'loading' : ''}`} onClick={handleExportMaster} disabled={exporting}>
            {exporting ? 'RENDERING…' : '⬇ MASTER'}
          </button>
        </div>

        <div className="mpc-section">
          <div className="mpc-indicator" title={mpcExportDir ?? 'No MPC card detected'}>
            {mpcExportDir
              ? <><span className="mpc-dot mpc-dot-on" /> MPC → {mpcExportDir}</>
              : <><span className="mpc-dot" /> MPC: not detected</>}
          </div>
          <button
            className={`btn btn-export ${exporting ? 'loading' : ''}`}
            onClick={handleExportToMpc}
            disabled={exporting || ejecting || !mpcExportDir}
            title={mpcExportDir ? `Export all stems to ${mpcExportDir}` : 'Plug MPC in SD-card access mode'}
          >
            {exporting ? 'RENDERING…' : '⇨ EXPORT TO MPC'}
          </button>
          <button
            className={`btn btn-eject ${ejecting ? 'loading' : ''}`}
            onClick={handleEjectMpc}
            disabled={exporting || ejecting || !mpcExportDir}
            title={mpcExportDir ? 'Safely eject the MPC card before unplugging' : 'No MPC card to eject'}
          >
            {ejecting ? 'EJECTING…' : '⏏ EJECT MPC'}
          </button>
          {mpcStatus && <div className="mpc-status">{mpcStatus}</div>}
        </div>
      </div>
    </div>
  );
}
