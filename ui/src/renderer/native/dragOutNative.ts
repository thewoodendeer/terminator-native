/**
 * dragOutNative — DRAG A PAD OUT of Terminator (Phase 8.6c, native only).
 *
 * A chop only exists inside the app: to get it into Ableton you had to export a folder of stems and go find it.
 * This renders the pad exactly as it PLAYS (the same offline render RESAMPLE uses — chop bounds, pitch, reverse,
 * attack), writes one WAV into the shell's drag folder, and asks the OS to start a file drag with it.
 *
 * THE TIMING IS THE WHOLE TRICK. macOS builds a drag session from the window's CURRENT MOUSE EVENT, so the
 * drag has to be asked for while the button is still down — which is why the menu item calls `prepare()` when
 * the menu opens (rendering, encoding and writing happen there, off the critical path) and `startDrag()` on
 * pointerdown, where all that is left is one bridge call.
 */
import { isNative, native, nativeBoot } from './juceBridge';
import { encodeWAV } from '../audio/StemExporter';

type AnyRecord = Record<string, any>;

const bytesToBase64 = (bytes: Uint8Array): Promise<string> =>
  new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onerror = () => reject(r.error ?? new Error('base64 failed'));
    r.onload = () => { const s = String(r.result); resolve(s.slice(s.indexOf(',') + 1)); };
    r.readAsDataURL(new Blob([bytes as unknown as BlobPart]));
  });

const safeName = (s: string): string =>
  (s || 'terminator').replace(/[/\\:*?"<>|\0]/g, '-').replace(/\s+/g, ' ').trim().slice(0, 80) || 'terminator';

/** The engine surface this needs — kept structural so nothing here depends on ChopperEngine's whole type. */
export interface DragOutEngine {
  renderPadAsPlayed(padIdx: number): Promise<AudioBuffer | null>;
}

/** One pad's file, prepared and then dragged. */
export class PadDragOut {
  private path: string | null = null;
  private pending: Promise<string | null> | null = null;

  /** Render + write, so the drag itself is one call. Safe to call again — the same file is reused. */
  prepare(engine: DragOutEngine, padIdx: number, name: string): Promise<string | null> {
    if (this.path) return Promise.resolve(this.path);
    if (this.pending) return this.pending;
    this.pending = (async () => {
      try {
        if (!isNative()) return null;
        const buf = await engine.renderPadAsPlayed(padIdx);
        if (!buf) return null;
        const wav = encodeWAV(buf, 24);
        const sep = nativeBoot()?.dirs.sep ?? '/';
        const dir = `${nativeBoot()?.dirs.temp || '/tmp'}${sep}terminator-drag`;
        await native.fs({ verb: 'mkdir', path: dir });
        const file = `${dir}${sep}${safeName(name)}.wav`;
        const bytes = wav instanceof Uint8Array ? wav : new Uint8Array(wav as ArrayBuffer);
        const CHUNK = 3 * 1024 * 1024;
        for (let off = 0; off < bytes.length; off += CHUNK) {
          const part = bytes.subarray(off, Math.min(bytes.length, off + CHUNK));
          const r = await native.fs({ verb: 'writeBinary', path: file, data: await bytesToBase64(part), append: off > 0 });
          if (!r?.ok) return null;
        }
        this.path = file;
        return file;
      } catch { return null; }
      finally { this.pending = null; }
    })();
    return this.pending;
  }

  /** Hand the file to the OS. Called from pointerdown — the mouse must still be down. */
  async startDrag(engine: DragOutEngine, padIdx: number, name: string): Promise<boolean> {
    const path = this.path ?? (await this.prepare(engine, padIdx, name));
    if (!path) return false;
    const r = await native.window({ verb: 'dragFiles', paths: [path] } as AnyRecord);
    return !!r?.ok;
  }

  /** A new menu / a changed pad: forget the prepared file (a stale WAV is worse than a re-render). */
  reset(): void { this.path = null; }
}

/** True when this build can drag a pad out at all (the JUCE shell; Electron and the web cannot). */
export const canDragOut = (): boolean => isNative();

/** PROBE: everything except the OS drag itself, which needs a mouse button held down and so can only be tested
 *  by a person. What IS testable is the part that would silently rot: a pad renders to a real 24-bit WAV in the
 *  drag folder, and the shell refuses to offer the OS anything outside that folder. */
export function installDragOutProbe(): void {
  if (!isNative()) return;
  (window as any).__terminatorNativeDragOut = {
    selfTest: async (): Promise<AnyRecord> => {
      const out: AnyRecord = {};
      try {
        // A synthetic "pad": one second of a sine, rendered by the same path the menu uses.
        const ctx = new OfflineAudioContext(2, 44100, 44100);
        const buf = ctx.createBuffer(2, 44100, 44100);
        for (let c = 0; c < 2; c++) {
          const d = buf.getChannelData(c);
          for (let i = 0; i < d.length; i++) d[i] = Math.sin((i / 44100) * 440 * 2 * Math.PI) * 0.5;
        }
        const drag = new PadDragOut();
        const path = await drag.prepare({ renderPadAsPlayed: async () => buf }, 0, 'probe drag');
        out.wrote = !!path;
        if (path) {
          const st = await native.fs({ verb: 'stat', path });
          out.bytes = Number(st?.size) || 0;
          // 24-bit stereo at 44.1k for one second is ~264 KB + header; anything much smaller is not a WAV.
          out.looksLikeWav = out.bytes > 250000;
          out.inDragFolder = path.includes('terminator-drag');
          await native.fs({ verb: 'trash', path });
        }
        // The shell must refuse to hand the OS a file the page did not put in the drag folder.
        const bogus = await native.window({ verb: 'dragFiles', paths: ['/etc/hosts'] } as AnyRecord).catch(() => null);
        out.refusesOutsideFolder = bogus?.ok === false;
        out.ok = out.wrote === true && out.looksLikeWav === true && out.inDragFolder === true
          && out.refusesOutsideFolder === true;
      } catch (e: any) {
        out.error = String(e?.message ?? e);
        out.ok = false;
      }
      return out;
    },
  };
}
