// Deliver generated file(s) to the user across platforms.
//
// Desktop: the classic <a download> click — reliable, no UI interruption.
//
// iOS / iPadOS Safari: the `download` attribute is IGNORED and, inside our
// same-origin iframe, clicking an <a href="blob:…"> NAVIGATES the iframe to the
// blob — which blows away (and on big exports crashes) the embedded app. So on
// iOS we hand the file(s) to the Web Share API instead: one share sheet for all
// files → "Save to Files" / send to another app. Multiple stems share in a
// single sheet rather than firing N blob navigations (the old crash).
//
// THE CATCH (an iPad user's export vanished this way): `navigator.share` needs
// TRANSIENT USER ACTIVATION, and a stem render eats it long before the bytes
// exist — so a share fired at the end of an export throws NotAllowedError, and
// the old anchor fallback then did nothing visible inside the iframe while the UI
// still said "Exported … as a zip". Delivery therefore REPORTS its outcome
// ('needs-tap' when activation is gone) and the caller offers a SAVE button; the
// user's tap on that button is what opens the sheet.

/** One produced export artifact: bytes + filename + mime. Exporters return
 *  these (the "produce bytes" layer); delivery — download, share sheet, or a
 *  future Electron save/drag — is a separate step (deliverFiles below). */
export type ExportFile = { name: string; data: Uint8Array | ArrayBuffer; mime: string };

export function isIOS(): boolean {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent || '';
  // iPadOS reports as "MacIntel" with touch points, so check that too.
  return /iPad|iPhone|iPod/.test(ua)
    || (navigator.platform === 'MacIntel' && (navigator as any).maxTouchPoints > 1);
}

// Normalise any byte source into a fresh ArrayBuffer-backed BlobPart (avoids
// SharedArrayBuffer-union typing issues and detachment surprises).
function toBlobPart(bytes: ArrayBuffer | Uint8Array | string): BlobPart {
  if (typeof bytes === 'string') return bytes;
  const view = bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : bytes;
  const copy = new ArrayBuffer(view.byteLength);
  new Uint8Array(copy).set(view);
  return copy;
}

/** What actually happened to the bytes. Callers MUST NOT tell the user "exported"
 *  on anything but 'shared' / 'downloaded' — the whole reason this type exists is
 *  that iOS delivery can fail silently (see 'needs-tap'). */
/** True inside the Terminator shell. Imported lazily-by-value so this module stays usable in the plain web build. */
function isNativeShell(): boolean {
  return typeof window !== 'undefined' && !!(window as any).__JUCE__?.backend;
}

/** The absolute paths the last NATIVE delivery wrote, in order. Empty after a cancelled or non-native delivery.
 *  The export dialog needs the real path to hand a file to the shell's transcoder (MP3 / 24-bit FLAC) — parsing it
 *  out of a human status message would break the moment that wording changed. */
let lastNativePaths: string[] = [];
export function lastNativeSavePaths(): string[] { return lastNativePaths; }

/** Ask the shell where to put the export, then write every file there. One dialog even for a multi-file export:
 *  the user names the first file and the rest land beside it, which is what a DAW does with stems. */
async function saveFilesNative(
  items: Array<{ name: string; data: ArrayBuffer | Uint8Array | string; mime?: string }>,
): Promise<DeliveryOutcome> {
  const { native } = await import('../native/juceBridge');
  const { writeBinaryFile } = await import('../native/assetsNative');
  lastNativePaths = [];
  const chosen = await native.fs({ verb: 'saveDialog', title: 'Export', defaultName: items[0].name });
  if (!chosen?.ok || !chosen?.path) return 'dismissed'; // the user cancelled the dialog — nothing was written
  const target = String(chosen.path);
  const sep = target.includes('\\') ? '\\' : '/';
  const dir = target.slice(0, target.lastIndexOf(sep));
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    // the first file takes the name the user typed; the rest keep their own, beside it
    const path = i === 0 ? target : `${dir}${sep}${it.name}`;
    const bytes = typeof it.data === 'string'
      ? new TextEncoder().encode(it.data)
      : (it.data instanceof ArrayBuffer ? new Uint8Array(it.data) : it.data);
    const w = await writeBinaryFile(path, bytes);
    if (!w.ok) throw new Error(`could not write ${it.name}: ${w.error ?? 'unknown'}`);
    lastNativePaths.push(path);
  }
  void native.fs({ verb: 'reveal', path: target }); // show it in Finder/Explorer, as a desktop app should
  return 'downloaded';
}

export type DeliveryOutcome =
  | 'shared'       // the iOS share sheet took the files (Save to Files, AirDrop, …)
  | 'downloaded'   // classic <a download> fired
  | 'dismissed'    // share sheet opened and the user cancelled it
  | 'needs-tap';   // iOS refused: no transient activation left. Bytes NOT delivered.

/** Build the File objects a share needs. Do this while the bytes are already in
 *  hand, so the eventual `shareFiles` call inside a tap handler has NOTHING to
 *  await before `navigator.share` — an await there costs the user activation and
 *  the sheet never opens. */
export function toShareFiles(
  items: Array<{ name: string; data: ArrayBuffer | Uint8Array | string; mime?: string }>,
): File[] {
  return items.map(it =>
    new File([toBlobPart(it.data)], it.name, { type: it.mime ?? 'application/octet-stream' }),
  );
}

/** Can this browser share THESE files at all? (iPadOS/iOS Safari can; desktop
 *  Chrome/Electron cannot share files.) */
export function canShareFiles(files: File[]): boolean {
  const nav = navigator as any;
  return typeof nav.share === 'function' && typeof nav.canShare === 'function' && nav.canShare({ files });
}

/** True when delivery has to wait for a FRESH tap: iOS, share available. Web
 *  Share needs transient user activation, and a stem render burns through it in
 *  the first second — so an export that finishes minutes after the button press
 *  can never open the sheet by itself. The UI has to offer a SAVE button. */
export function needsSaveTap(files: File[]): boolean {
  return isIOS() && canShareFiles(files);
}

/** Open the share sheet. MUST be called from a user-gesture handler with no
 *  awaits before it. */
export async function shareFiles(files: File[]): Promise<DeliveryOutcome> {
  const nav = navigator as any;
  if (!canShareFiles(files)) return 'needs-tap';
  try {
    await nav.share({ files });
    return 'shared';
  } catch (e: any) {
    if (e?.name === 'AbortError') return 'dismissed';
    return 'needs-tap';        // NotAllowedError = activation expired; nothing was delivered
  }
}

export async function deliverFiles(
  items: Array<{ name: string; data: ArrayBuffer | Uint8Array | string; mime?: string }>,
): Promise<DeliveryOutcome> {
  if (items.length === 0) return 'downloaded';

  // NATIVE (the JUCE shell) FIRST — and this is not an optimisation, it is a bug fix. A WKWebView has no download
  // manager: clicking an <a download href="blob:…"> NAVIGATES THE WEBVIEW to the blob, so the app's whole UI is
  // replaced by a blank page ("Plug-in handled load") and Terminator looks dead. Exactly the failure this file's
  // header already documents for the iOS iframe. Natively the shell owns the filesystem, so the bytes go through a
  // real save dialog and terminatorFs instead of ever touching an anchor.
  if (isNativeShell()) return saveFilesNative(items);

  const files = toShareFiles(items);

  if (isIOS() && canShareFiles(files)) {
    const out = await shareFiles(files);
    // 'needs-tap' means Safari refused for lack of activation — the render outlived
    // the button press. Do NOT fall through to the anchor: on iOS the download
    // attribute is ignored and, inside the site's iframe, clicking a blob link
    // navigates (or crashes) the embedded app instead of saving anything. Put a
    // SAVE button on screen instead and let the user's tap open the sheet. A
    // caller with its own save UI (the Extractor's export panel, the board's done
    // screen) stages the files itself and never reaches this.
    if (out === 'needs-tap') return promptSaveTap(files);
    return out;
  }

  for (const file of files) {
    const url = URL.createObjectURL(file);
    const a = Object.assign(document.createElement('a'), { href: url, download: file.name });
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    if (files.length > 1) await new Promise(r => setTimeout(r, 250)); // let each download start
  }
  return 'downloaded';
}

/** LAST-RESORT iOS delivery: a bare overlay with a SAVE button, for callers with
 *  no save UI of their own (the chopper's exports, the arranger). Built in plain
 *  DOM with inline styles on purpose — this module is imported by React and
 *  non-React surfaces alike, and it must work with no stylesheet of ours loaded.
 *
 *  The button is a real <a download> so a browser WITHOUT file sharing still does
 *  something when tapped; where sharing exists the tap is intercepted
 *  synchronously and opens the share sheet instead. Resolves when the files are
 *  gone or the user closes the card. */
function promptSaveTap(files: File[]): Promise<DeliveryOutcome> {
  return new Promise(resolve => {
    const wrap = document.createElement('div');
    wrap.setAttribute('role', 'dialog');
    wrap.style.cssText = 'position:fixed;left:0;right:0;bottom:0;z-index:2147483647;'
      + 'padding:14px 14px calc(14px + env(safe-area-inset-bottom));'
      + 'background:rgba(18,18,20,0.96);color:#fff;font:600 14px/1.45 -apple-system,BlinkMacSystemFont,"Helvetica Neue",Arial,sans-serif;'
      + 'box-shadow:0 -8px 30px rgba(0,0,0,0.45);-webkit-backdrop-filter:blur(8px);backdrop-filter:blur(8px);';
    const total = files.reduce((n, f) => n + f.size, 0);
    const size = total >= 1048576 ? `${(total / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(total / 1024))} KB`;
    const label = document.createElement('div');
    label.textContent = `Your export is ready (${files.length} file${files.length === 1 ? '' : 's'}, ${size}) — tap SAVE, then “Save to Files”.`;
    label.style.cssText = 'margin:0 0 10px;font-weight:600;';
    wrap.appendChild(label);

    const urls: string[] = [];
    const done = (outcome: DeliveryOutcome) => {
      urls.forEach(u => URL.revokeObjectURL(u));
      wrap.remove();
      resolve(outcome);
    };
    const share = canShareFiles(files);
    // Sharing takes the whole batch in one sheet, so one button. Without it each
    // file needs its own tap — an anchor carries exactly one file, and a burst of
    // clicks is what browsers drop.
    const forButtons = share ? [files[0]] : files;
    forButtons.forEach(f => {
      const btn = document.createElement('a');
      const url = URL.createObjectURL(f);
      urls.push(url);
      btn.href = url;
      btn.download = f.name;
      btn.textContent = share ? '⤓ SAVE TO FILES' : `⤓ SAVE ${f.name}`;
      btn.style.cssText = 'display:flex;align-items:center;justify-content:center;min-height:48px;margin-top:8px;'
        + 'padding:0 14px;border-radius:10px;background:#ff5a2d;color:#fff;text-decoration:none;'
        + 'font-weight:700;letter-spacing:0.4px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
      btn.addEventListener('click', e => {
        if (!share) { if (forButtons.length === 1) done('downloaded'); return; }   // the anchor's own download runs
        e.preventDefault();
        shareFiles(files).then(out => { if (out === 'shared') done('shared'); });
      });
      wrap.appendChild(btn);
    });

    const close = document.createElement('button');
    close.type = 'button';
    close.textContent = 'not now';
    close.style.cssText = 'display:block;margin:8px auto 0;padding:6px 10px;background:none;border:0;'
      + 'color:rgba(255,255,255,0.6);font:inherit;font-weight:500;text-decoration:underline;';
    close.addEventListener('click', () => done('dismissed'));
    wrap.appendChild(close);

    document.body.appendChild(wrap);
  });
}

/** Convenience for a single file. */
export function deliverFile(name: string, data: ArrayBuffer | Uint8Array | string, mime?: string): Promise<DeliveryOutcome> {
  return deliverFiles([{ name, data, mime }]);
}
