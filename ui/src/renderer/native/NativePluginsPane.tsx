/**
 * NativePluginsPane — Preferences → PLUGINS (Phase 6.1). The list of VST3 / AudioUnit plugins Terminator found,
 * a SCAN that runs each plugin in its OWN child process (so a plugin that crashes takes the scanner down and not
 * Terminator), the folders it looks in, and the blocklist of the ones that did crash.
 *
 * Everything talks to the C++ PluginHub through `terminatorPlugins`; progress arrives as `terminator.pluginScan`.
 */
import { useCallback, useEffect, useMemo, useState, type CSSProperties } from 'react';
import { native, onNativeEvent } from './juceBridge';

type Plugin = { id: string; name: string; manufacturer: string; format: string; category: string; version: string; isInstrument: boolean; file: string; numInputs: number; numOutputs: number };
type PluginsReply = { ok: boolean; plugins: Plugin[]; blocklist: string[]; folders: string[]; formats: string[]; scanning: boolean; crashedLastLaunch?: string };
type ScanEvent = { done: number; total: number; current: string; found: number; finished: boolean };

const card: CSSProperties = { background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 6, padding: '12px 14px', marginBottom: 12 };
const label: CSSProperties = { display: 'block', color: 'var(--text-dim)', fontSize: 11, letterSpacing: 1, marginBottom: 5, textTransform: 'uppercase' };
const hint: CSSProperties = { color: 'var(--text-dim)', fontSize: 11, marginTop: 5, lineHeight: 1.4 };
const btn: CSSProperties = { background: 'var(--bg3)', color: 'var(--neon)', border: '1px solid var(--border)', borderRadius: 4, padding: '6px 12px', cursor: 'pointer', fontFamily: 'inherit', fontSize: 12, marginRight: 8 };
const rowStyle: CSSProperties = { display: 'flex', alignItems: 'center', gap: 8, padding: '4px 0', borderBottom: '1px solid var(--border)', fontSize: 12 };

export default function NativePluginsPane() {
  const [reply, setReply] = useState<PluginsReply | null>(null);
  const [scan, setScan] = useState<ScanEvent | null>(null);
  const [filter, setFilter] = useState('');

  const refresh = useCallback(async (req: Record<string, unknown> = { verb: 'list' }) => {
    const r = (await native.plugins(req)) as PluginsReply;
    setReply(r);
    return r;
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => onNativeEvent('terminator.pluginScan', (p: ScanEvent) => {
    setScan(p);
    if (p.finished) { setScan(null); void refresh(); }
  }), [refresh]);

  const plugins = useMemo(() => {
    const all = reply?.plugins ?? [];
    const q = filter.trim().toLowerCase();
    const hit = q ? all.filter(p => `${p.name} ${p.manufacturer} ${p.format} ${p.category}`.toLowerCase().includes(q)) : all;
    return [...hit].sort((a, b) => a.name.localeCompare(b.name));
  }, [reply, filter]);

  const addFolder = async () => {
    // The shell's own folder picker (terminatorFs) — the WebView has no directory dialog of its own.
    const picked = await native.fs({ verb: 'openDialog', mode: 'dir', title: 'Where else should Terminator look for plugins?' });
    const dir = String((picked as any)?.path ?? '');
    if (!dir) return;
    await refresh({ verb: 'setFolders', folders: [...(reply?.folders ?? []), dir] });
  };

  const removeFolder = async (dir: string) =>
    refresh({ verb: 'setFolders', folders: (reply?.folders ?? []).filter(f => f !== dir) });

  return (
    <>
      {!!reply?.crashedLastLaunch && (
        <div style={{ ...card, borderColor: '#ff5230', color: '#ff5230' }}>
          A plugin did not survive being loaded last time, so Terminator started without it and put it under DID NOT
          LOAD. Update it (or the app) and press TRY THESE AGAIN.
          <div style={{ ...hint, color: '#ff5230' }}>{reply.crashedLastLaunch}</div>
        </div>
      )}
      <div style={card}>
        <label style={label}>Plugins</label>
        <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 6 }}>
          <button style={btn} disabled={!!scan} onClick={() => void refresh({ verb: 'scan' })}>
            {scan ? 'SCANNING…' : 'SCAN FOR NEW'}
          </button>
          <button style={btn} disabled={!!scan} onClick={() => void refresh({ verb: 'scan', rescanAll: true })}>
            RESCAN EVERYTHING
          </button>
          {scan && <button style={btn} onClick={() => void refresh({ verb: 'cancelScan' })}>STOP</button>}
          <input
            style={{ flex: 1, minWidth: 160, background: 'var(--bg3)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 4, padding: '6px 8px', fontFamily: 'inherit', fontSize: 12 }}
            placeholder="filter…"
            value={filter}
            onChange={e => setFilter(e.target.value)}
          />
        </div>
        {scan && (
          <div style={hint}>
            {scan.done} / {scan.total} — {scan.current.split('/').pop()} &nbsp; ({scan.found} found so far)
          </div>
        )}
        {!scan && (
          <div style={hint}>
            {plugins.length} plugin{plugins.length === 1 ? '' : 's'} — {(reply?.formats ?? []).join(' · ')}.
            Each plugin is opened in its own process while scanning, so one that crashes cannot take Terminator with it.
          </div>
        )}
      </div>

      <div style={card}>
        <div style={{ maxHeight: 320, overflowY: 'auto' }}>
          {plugins.map(p => (
            <div key={p.id} style={rowStyle}>
              <span style={{ flex: 1, color: 'var(--text)' }}>{p.name}</span>
              <span style={{ color: 'var(--text-dim)', fontSize: 11 }}>{p.manufacturer}</span>
              <span style={{ color: 'var(--neon)', fontSize: 10, letterSpacing: 1 }}>{p.format}</span>
              <span style={{ color: 'var(--text-dim)', fontSize: 10 }}>{p.isInstrument ? 'INSTR' : 'FX'}</span>
              <button style={{ ...btn, marginRight: 0, padding: '2px 8px' }} onClick={() => void refresh({ verb: 'remove', id: p.id })}>✕</button>
            </div>
          ))}
          {plugins.length === 0 && <div style={hint}>Nothing yet — press SCAN FOR NEW.</div>}
        </div>
      </div>

      <div style={card}>
        <label style={label}>Extra folders</label>
        {(reply?.folders ?? []).map(f => (
          <div key={f} style={rowStyle}>
            <span style={{ flex: 1, color: 'var(--text)', fontSize: 11 }}>{f}</span>
            <button style={{ ...btn, marginRight: 0, padding: '2px 8px' }} onClick={() => void removeFolder(f)}>✕</button>
          </div>
        ))}
        <button style={{ ...btn, marginTop: 8 }} onClick={() => void addFolder()}>ADD FOLDER…</button>
        <div style={hint}>The usual VST3 / Components folders are always searched — these are extras.</div>
      </div>

      {(reply?.blocklist?.length ?? 0) > 0 && (
        <div style={card}>
          <label style={label}>Did not load ({reply?.blocklist.length})</label>
          {(reply?.blocklist ?? []).map(f => (
            <div key={f} style={{ ...rowStyle, color: 'var(--text-dim)', fontSize: 11 }}>{f.split('/').pop()}</div>
          ))}
          <button style={{ ...btn, marginTop: 8 }} onClick={() => void refresh({ verb: 'clearBlocklist' })}>TRY THESE AGAIN</button>
          <div style={hint}>These crashed or hung while being scanned, so they are skipped. RESCAN EVERYTHING also retries them.</div>
        </div>
      )}
    </>
  );
}
