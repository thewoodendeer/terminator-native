// USER BASS PATCHES — save the synth you dialled in under a name and get it
// back next session. localStorage always (web + Electron), mirrored to
// bass-patches.json in the app data dir when the Electron bridge is there, so
// a patch made once survives a cleared browser store too.
import type { BassPatch } from './BassEngine';

export interface UserBassPatch { name: string; patch: BassPatch; savedAt: number }

const KEY = 'terminator.bassPatches.v1';
type Bridge = { saveBassPatches?: (l: object) => Promise<unknown>; loadBassPatches?: () => Promise<Array<{ name: string; patch: object; savedAt?: number }> | null> };
const bridge = (): Bridge | undefined => (typeof window !== 'undefined' ? (window as any).terminator : undefined);

let cache: UserBassPatch[] | null = null;
const listeners = new Set<(l: UserBassPatch[]) => void>();
const notify = () => { for (const l of listeners) l(list()); };

function readLocal(): UserBassPatch[] {
  try {
    const raw = localStorage.getItem(KEY);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr.filter((p) => p && typeof p.name === 'string' && p.patch && typeof p.patch === 'object') : [];
  } catch { return []; }
}
function writeLocal(l: UserBassPatch[]): void {
  try { localStorage.setItem(KEY, JSON.stringify(l)); } catch { /* */ }
  try { void bridge()?.saveBassPatches?.(l); } catch { /* */ }
}

export function list(): UserBassPatch[] { if (!cache) cache = readLocal(); return cache; }
export function subscribe(fn: (l: UserBassPatch[]) => void): () => void { listeners.add(fn); fn(list()); return () => { listeners.delete(fn); }; }

/** Merge the disk copy in once (Electron). Newer savedAt wins per name. */
export async function loadFromDisk(): Promise<void> {
  const b = bridge(); if (!b?.loadBassPatches) return;
  try {
    const disk = await b.loadBassPatches();
    if (!Array.isArray(disk)) return;
    const merged = new Map<string, UserBassPatch>();
    for (const p of list()) merged.set(p.name, p);
    for (const p of disk) {
      if (!p || typeof p.name !== 'string' || !p.patch) continue;
      const cur = merged.get(p.name);
      if (!cur || (p.savedAt ?? 0) > cur.savedAt) merged.set(p.name, { name: p.name, patch: p.patch as BassPatch, savedAt: p.savedAt ?? 0 });
    }
    cache = [...merged.values()].sort((a, b) => a.name.localeCompare(b.name));
    writeLocal(cache);
    notify();
  } catch { /* no file yet */ }
}

export function save(name: string, patch: BassPatch): void {
  const n = name.trim().slice(0, 40); if (!n) return;
  const l = list().filter((p) => p.name !== n);
  l.push({ name: n, patch: JSON.parse(JSON.stringify(patch)), savedAt: Date.now() });
  l.sort((a, b) => a.name.localeCompare(b.name));
  cache = l; writeLocal(l); notify();
}
export function remove(name: string): void {
  cache = list().filter((p) => p.name !== name); writeLocal(cache); notify();
}
export function get(name: string): UserBassPatch | undefined { return list().find((p) => p.name === name); }
