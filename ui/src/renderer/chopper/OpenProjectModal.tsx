import React, { useEffect, useMemo, useState, CSSProperties } from 'react';

// ─────────────────────────────────────────────────────────────────────────────
// Open Project modal — LOCAL | CLOUD tabs.
//   LOCAL  (Electron only): .tproj / .tprojz files in the projects folder
//          (default terminator-presets in userData; changeable from the FOLDER row).
//   CLOUD  (Electron + web): the signed-in user's Supabase presets.
// On web the LOCAL tab is hidden (no disk). Triggered by File → Open Project
// (Cmd+O) on Electron and the LOAD PRESET button on web.
//
// SAVE AS mode (mode: 'save'): the same lists, so you can SEE what you already
// have and pick a new name — the search box is the NAME field (click a row to
// take its name), the footer's SAVE button saves (reads OVERWRITE when the name
// is taken). CMD-click SAVE PROJECT / right-click → Save As… opens it.
// ─────────────────────────────────────────────────────────────────────────────

export interface CloudPreset {
  id?: string;
  name: string;
  trackTitle?: string;
  savedAt: string; // ISO date
}
export interface LocalProject {
  name: string;
  path: string;
  modifiedAt: number; // epoch ms
}

interface OpenProjectModalProps {
  open: boolean;
  onClose: () => void;
  /** 'open' (default) loads on click; 'save' = SAVE AS — rows fill the name,
   *  SAVE in the footer calls onSave(name). */
  mode?: 'open' | 'save';
  saveName?: string;
  onSave?: (name: string) => void | Promise<void>;
  isWeb: boolean;
  signedIn: boolean;
  // CLOUD
  cloudPresets: CloudPreset[];
  onRefreshCloud: () => void | Promise<void>;
  onLoadCloud: (id: string) => void | Promise<void>;
  onDeleteCloud: (id: string) => void | Promise<void>;
  // LOCAL (Electron only — omitted on web)
  listLocal?: () => Promise<LocalProject[]>;
  onLoadLocal?: (path: string) => void | Promise<void>;
  deleteLocal?: (path: string) => Promise<{ ok?: boolean; error?: string }>;
  onBrowse?: () => void | Promise<void>;
  // TRANSFER TO DEVICE / RECEIVE (both platforms) — peer-to-peer, by code.
  onTransferSend?: () => void;
  onTransferReceive?: () => void;
  /** Web: pick a .tproj / .tprojz from the device's files. */
  onImportFile?: () => void;
  /** Electron: the folder the .tproj / .tprojz files are saved in — read it,
   *  pick another (native folder dialog), go back to the default, open it. */
  projectsDir?: {
    get: () => Promise<{ path: string; isDefault: boolean }>;
    choose: () => Promise<{ ok?: boolean; cancelled?: boolean; error?: string; path: string; isDefault: boolean }>;
    reset: () => Promise<{ ok?: boolean; path: string; isDefault: boolean }>;
    reveal: () => Promise<{ ok?: boolean; error?: string }>;
  };
}

const overlay: CSSProperties = {
  position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.72)', zIndex: 9000,
  display: 'flex', alignItems: 'center', justifyContent: 'center',
};
const panel: CSSProperties = {
  width: 'min(560px, 92vw)', maxHeight: '82vh', display: 'flex', flexDirection: 'column',
  background: '#0a0f0c', border: '1px solid #0a3a1a', borderRadius: 8,
  boxShadow: '0 10px 40px rgba(0,0,0,0.6)', color: '#cfe7d8', fontFamily: 'monospace',
  overflow: 'hidden',
};
const head: CSSProperties = {
  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
  padding: '10px 14px', borderBottom: '1px solid #0a3a1a', background: '#0a1a0f',
};
const tabBtn = (active: boolean): CSSProperties => ({
  flex: 1, padding: '9px 0', background: active ? '#0a1a0f' : 'transparent',
  color: active ? '#00ff41' : '#5f8a70', border: 'none',
  borderBottom: active ? '2px solid #00ff41' : '2px solid transparent',
  cursor: 'pointer', fontFamily: 'inherit', fontSize: 12, letterSpacing: 2, textTransform: 'uppercase',
});
const rowStyle: CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px',
  borderBottom: '1px solid #102a1a', cursor: 'pointer',
};
const delBtn: CSSProperties = {
  background: '#1a0a0a', color: '#ff6b6b', border: '1px solid #3a1414', borderRadius: 3,
  padding: '3px 8px', cursor: 'pointer', fontFamily: 'inherit', fontSize: 11, flex: '0 0 auto',
};
const smallBtn: CSSProperties = {
  background: '#0a1a0f', color: '#00ff41', border: '1px solid #0a3a1a', borderRadius: 3,
  padding: '5px 10px', cursor: 'pointer', fontFamily: 'inherit', fontSize: 11,
};
const searchStyle: CSSProperties = {
  width: '100%', background: '#06120c', color: '#cfe7d8', border: '1px solid #0a3a1a',
  borderRadius: 4, padding: '7px 9px', fontFamily: 'inherit', fontSize: 13,
};

function fmtDate(d: string | number): string {
  try {
    const dt = typeof d === 'number' ? new Date(d) : new Date(d);
    if (isNaN(dt.getTime())) return '';
    return dt.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  } catch { return ''; }
}

export default function OpenProjectModal(props: OpenProjectModalProps) {
  const { open, onClose, isWeb, signedIn, cloudPresets, onRefreshCloud, onLoadCloud, onDeleteCloud,
    listLocal, onLoadLocal, deleteLocal, onBrowse, onTransferSend, onTransferReceive, onImportFile, projectsDir,
    mode = 'open', saveName = '', onSave } = props;
  const saving = mode === 'save';

  // Web has no LOCAL tab; Electron defaults to LOCAL.
  const [tab, setTab] = useState<'local' | 'cloud'>(isWeb ? 'cloud' : 'local');
  const [query, setQuery] = useState('');
  const [local, setLocal] = useState<LocalProject[]>([]);
  const [busy, setBusy] = useState(false);

  const refreshLocal = async () => {
    if (!listLocal) return;
    setBusy(true);
    try { setLocal(await listLocal()); } catch { setLocal([]); } finally { setBusy(false); }
  };
  // Where the files live (Electron). Re-read with every list refresh so a
  // folder change is reflected at once.
  const [dirInfo, setDirInfo] = useState<{ path: string; isDefault: boolean } | null>(null);
  const [dirMsg, setDirMsg] = useState<string | null>(null);
  const refreshDir = async () => {
    if (!projectsDir) return;
    try { setDirInfo(await projectsDir.get()); } catch { setDirInfo(null); }
  };
  const changeDir = async () => {
    if (!projectsDir) return;
    setDirMsg(null);
    const r = await projectsDir.choose();
    if (r.error) { setDirMsg(r.error); return; }
    if (r.cancelled) return;
    setDirInfo({ path: r.path, isDefault: r.isDefault });
    setDirMsg('New projects save here from now on. Projects in the old folder stay where they are — move the .tproj / .tprojz files over in Finder if you want them listed.');
    await refreshLocal();
  };
  const resetDir = async () => {
    if (!projectsDir) return;
    setDirMsg(null);
    const r = await projectsDir.reset();
    setDirInfo({ path: r.path, isDefault: r.isDefault });
    await refreshLocal();
  };

  // Reset + load fresh lists each time the modal opens.
  useEffect(() => {
    if (!open) return;
    setQuery(saving ? saveName : '');
    setTab(isWeb ? 'cloud' : 'local');
    if (!isWeb) { void refreshLocal(); void refreshDir(); }
    void onRefreshCloud();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Escape closes.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [open, onClose]);

  // SAVE AS: the box is the name, so it must not filter the list down to
  // nothing as you type a brand-new name — show everything, highlight a clash.
  const q = saving ? '' : query.trim().toLowerCase();
  const typedName = query.trim();
  const nameTaken = saving && typedName.length > 0 && (
    (tab === 'cloud' ? cloudPresets : local).some(p => p.name.toLowerCase() === typedName.toLowerCase()));
  const commitSave = () => {
    if (!typedName) return;
    onClose();
    void onSave?.(typedName);
  };
  const filteredCloud = useMemo(
    () => cloudPresets.filter(p => !q || p.name.toLowerCase().includes(q) || (p.trackTitle ?? '').toLowerCase().includes(q)),
    [cloudPresets, q],
  );
  const filteredLocal = useMemo(
    () => local.filter(p => !q || p.name.toLowerCase().includes(q)),
    [local, q],
  );

  if (!open) return null;

  return (
    <div style={overlay} onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div style={panel} onMouseDown={e => e.stopPropagation()}>
        <div style={head}>
          <span style={{ color: '#00ff41', letterSpacing: 2, fontSize: 13 }}>{saving ? 'SAVE PROJECT AS' : 'OPEN PROJECT'}</span>
          <button style={{ ...smallBtn, padding: '3px 9px' }} onClick={onClose} title="Close">✕</button>
        </div>

        {/* Tabs — LOCAL only shows on Electron */}
        <div style={{ display: 'flex', borderBottom: '1px solid #0a3a1a' }}>
          {!isWeb && <button style={tabBtn(tab === 'local')} onClick={() => setTab('local')}>Local</button>}
          <button style={tabBtn(tab === 'cloud')} onClick={() => setTab('cloud')}>Cloud</button>
        </div>

        {/* Search */}
        <div style={{ padding: '10px 12px', borderBottom: '1px solid #102a1a' }}>
          <input
            style={{ ...searchStyle, ...(nameTaken ? { borderColor: '#ffb454' } : {}) }}
            placeholder={saving ? 'Project name… (click a project below to take its name)' : 'Search projects…'}
            value={query}
            autoFocus
            onChange={e => setQuery(e.target.value)}
            onKeyDown={e => { if (saving && e.key === 'Enter') { e.preventDefault(); commitSave(); } }}
            title={saving ? 'The name to save under. Enter = save. A name already in the list overwrites that project.' : undefined}
          />
          {saving && nameTaken && <div style={{ marginTop: 6, fontSize: 11, color: '#ffb454' }}>"{typedName}" already exists — SAVE will overwrite it. Type a different name to keep both.</div>}
        </div>

        <div style={{ overflowY: 'auto', flex: 1, minHeight: 120 }}>
          {tab === 'local' && !isWeb && (
            <>
              {busy && <div style={{ padding: 16, color: '#5f8a70' }}>Loading…</div>}
              {/* The folder row: where these files live, and the controls to move it. */}
              {projectsDir && dirInfo && (
                <div style={{ padding: '8px 12px', borderBottom: '1px solid #102a1a', background: '#07110b', fontSize: 11 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ color: '#5f8a70', letterSpacing: 1, flex: '0 0 auto' }}>FOLDER</span>
                    <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', direction: 'rtl', textAlign: 'left', color: '#cfe7d8' }} title={dirInfo.path}>
                      <bdi>{dirInfo.path}</bdi>
                    </span>
                    {dirInfo.isDefault && <span style={{ color: '#5f8a70', flex: '0 0 auto' }}>(default)</span>}
                    <button style={{ ...smallBtn, padding: '3px 8px', flex: '0 0 auto' }} onClick={() => { void changeDir(); }} title="Pick the folder Terminator saves your projects in (.tproj / .tprojz). Only the project files move — samples stay in the app's own store, and ⇩ FILE bundles carry them">Change folder…</button>
                    {!dirInfo.isDefault && (
                      <button style={{ ...smallBtn, padding: '3px 8px', flex: '0 0 auto' }} onClick={() => { void resetDir(); }} title="Go back to the default folder inside the app's data">Use default</button>
                    )}
                    <button style={{ ...smallBtn, padding: '3px 8px', flex: '0 0 auto' }} onClick={() => { void projectsDir.reveal(); }} title="Open this folder in Finder / Explorer">Open</button>
                  </div>
                  {dirMsg && <div style={{ marginTop: 6, color: '#e7a977', lineHeight: 1.4 }}>{dirMsg}</div>}
                </div>
              )}
              {!busy && filteredLocal.length === 0 && (
                <div style={{ padding: 16, color: '#5f8a70' }}>No projects in this folder yet — SAVE PROJECT puts them here.</div>
              )}
              {!busy && filteredLocal.map(p => (
                <div
                  key={p.path}
                  style={{ ...rowStyle, ...(saving && p.name.toLowerCase() === typedName.toLowerCase() ? { background: '#10200f' } : {}) }}
                  onClick={() => { if (saving) { setQuery(p.name); return; } void onLoadLocal?.(p.path); onClose(); }}
                  title={saving ? `Use the name "${p.name}" (overwrites it)` : p.path}
                >
                  <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.name}</span>
                  <span style={{ color: '#5f8a70', fontSize: 11, flex: '0 0 auto' }}>{fmtDate(p.modifiedAt)}</span>
                  <button
                    style={delBtn}
                    onClick={async e => {
                      e.stopPropagation();
                      if (!window.confirm(`Delete project "${p.name}"? This removes the file from disk.`)) return;
                      await deleteLocal?.(p.path);
                      await refreshLocal();
                    }}
                  >Delete</button>
                </div>
              ))}
            </>
          )}

          {tab === 'cloud' && (
            <>
              {!signedIn && (
                <div style={{ padding: 16, color: '#5f8a70' }}>Sign in to access cloud presets.</div>
              )}
              {signedIn && filteredCloud.length === 0 && (
                <div style={{ padding: 16, color: '#5f8a70' }}>No cloud presets yet.</div>
              )}
              {signedIn && filteredCloud.map(p => (
                <div
                  key={p.id ?? p.name}
                  style={{ ...rowStyle, ...(saving && p.name.toLowerCase() === typedName.toLowerCase() ? { background: '#10200f' } : {}) }}
                  onClick={() => { if (saving) { setQuery(p.name); return; } if (p.id) { void onLoadCloud(p.id); onClose(); } }}
                  title={saving ? `Use the name "${p.name}" (overwrites it)` : (p.trackTitle ?? p.name)}
                >
                  <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {p.name}{p.trackTitle ? <span style={{ color: '#5f8a70' }}> — {p.trackTitle}</span> : null}
                  </span>
                  <span style={{ color: '#5f8a70', fontSize: 11, flex: '0 0 auto' }}>{fmtDate(p.savedAt)}</span>
                  <button
                    style={delBtn}
                    onClick={async e => {
                      e.stopPropagation();
                      if (!p.id) return;
                      if (!window.confirm(`Delete cloud preset "${p.name}"?`)) return;
                      await onDeleteCloud(p.id);
                    }}
                  >Delete</button>
                </div>
              ))}
            </>
          )}
        </div>

        {/* Footer actions */}
        <div style={{ display: 'flex', gap: 8, padding: '10px 12px', borderTop: '1px solid #0a3a1a', background: '#0a1a0f' }}>
          {tab === 'local' && !isWeb && onBrowse && (
            <button style={smallBtn} onClick={() => { void onBrowse(); }}>Browse…</button>
          )}
          {tab === 'local' && !isWeb && (
            <button style={smallBtn} onClick={() => void refreshLocal()}>Refresh</button>
          )}
          {tab === 'cloud' && signedIn && (
            <button style={smallBtn} onClick={() => void onRefreshCloud()}>Refresh</button>
          )}
          {!saving && isWeb && onImportFile && (
            <button style={smallBtn} onClick={() => { onClose(); onImportFile(); }} title="Open a .tproj / .tprojz project file from this device">Open file…</button>
          )}
          <span style={{ flex: 1 }} />
          {!saving && onTransferSend && (
            <button style={smallBtn} onClick={() => { onClose(); onTransferSend(); }} title="Send THIS project (with its samples) to another device — it shows a code, type it there">⇄ Transfer to device</button>
          )}
          {!saving && onTransferReceive && (
            <button style={smallBtn} onClick={() => { onClose(); onTransferReceive(); }} title="Receive a project another device is sending — type its code">⇣ Receive</button>
          )}
          {saving && (
            <button style={{ ...smallBtn, ...(nameTaken ? { color: '#ffb454', borderColor: '#5a3a10' } : {}), opacity: typedName ? 1 : 0.5 }} disabled={!typedName} onClick={commitSave}
              title={nameTaken ? `Overwrite "${typedName}" with this project` : 'Save the project under this name'}>{nameTaken ? 'OVERWRITE' : 'SAVE'}</button>
          )}
          <button style={smallBtn} onClick={onClose}>{saving ? 'Cancel' : 'Close'}</button>
        </div>
      </div>
    </div>
  );
}
