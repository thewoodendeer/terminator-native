/**
 * processBridge — run one of the BUNDLED command-line tools as a child process through `terminatorProcess`
 * (app/src/ProcessHub.cpp). The shell only ever runs its own bundled binaries (`tool` is a name, never a path) and
 * prepends their fixed flags; the page gets the merged stdout+stderr as it arrives and the exit code.
 */
import { isNative, native, onNativeEvent } from './juceBridge';

export interface ProcessHandle {
  id: string;
  /** Resolves with the exit code (−1 if the shell could not report one). */
  exit: Promise<number>;
  kill(): Promise<void>;
}

type Waiter = { onOutput?: (chunk: string) => void; resolve: (code: number) => void };
const waiters = new Map<string, Waiter>();
let installed = false;
let seq = 0;

function installListeners(): void {
  if (installed || !isNative()) return;
  installed = true;
  onNativeEvent('terminator.processOutput', (p: any) => { const w = p && waiters.get(String(p.id)); if (w && w.onOutput) { try { w.onOutput(String(p.data ?? '')); } catch { /* */ } } });
  onNativeEvent('terminator.processExit', (p: any) => { const w = p && waiters.get(String(p.id)); if (w) { waiters.delete(String(p.id)); w.resolve(Number.isFinite(Number(p.code)) ? Number(p.code) : -1); } });
}

/** The bundled tools' paths ('' when not bundled in this build). */
export async function bundledTools(): Promise<{ ytdlp: string; qjs: string; ytdlpDir: string; qjsDir: string; binDir: string }> {
  const r = await native.process({ verb: 'tools' });
  return { ytdlp: String(r?.ytdlp ?? ''), qjs: String(r?.qjs ?? ''), ytdlpDir: String(r?.ytdlpDir ?? ''), qjsDir: String(r?.qjsDir ?? ''), binDir: String(r?.binDir ?? '') };
}

/** Spawn a bundled tool. Throws if the shell refuses (tool missing, bad args). */
export async function spawnTool(tool: 'ytdlp', args: string[], onOutput?: (chunk: string) => void): Promise<ProcessHandle> {
  installListeners();
  const id = `p${Date.now().toString(36)}-${(++seq).toString(36)}`;
  let resolveExit!: (code: number) => void;
  const exit = new Promise<number>((res) => { resolveExit = res; });
  waiters.set(id, { onOutput, resolve: resolveExit });
  const r = await native.process({ verb: 'spawn', id, tool, args });
  if (!r?.ok) { waiters.delete(id); throw new Error(r?.error ?? `could not start ${tool}`); }
  return { id, exit, kill: async () => { await native.process({ verb: 'kill', id }); } };
}
