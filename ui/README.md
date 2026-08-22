# ui/ — the React UI (Phase 2.4)

The Terminator React app, COPIED from the Electron repo (`terminator/src/renderer` at `mpc-stem-extractor`
0af0dbe, 2026-08-22) minus `mpc/` (the Extractor), `board/` (the Producer Sim) and `test/`, plus `src/mixer`
(the desk) and the `board/sim/net` subset that `chopper/transfer/projectTransfer.ts` needs (no `guests.ts` /
`xfer.ts` — those pull three.js + the Extractor types). `finishhim/` is kept (it is the DAW's arranger UI).
Public assets: fonts, worklets, themes, icon, manifest; `public/videos/*.mp4` (the boot-intro easter egg) are
NOT committed — `scripts/sync-assets.sh` copies them from a local Electron checkout.

## Build + gate
```
cd ui && npm ci && npm run gate      # = baseline tsc + node scripts/test-library.mts + vite build --mode native → ui/dist
```
- **tsc baseline = 5 errors**, the SAME five the Electron renderer carries (ChopperView `ipc` possibly
  undefined ×2, exporters `Uint8Array`, mpcSample `replaceAll` ×2), recorded in `tsc-baseline.json` (file + TS
  code + message, line-number-free). `npm run typecheck` = `scripts/typecheck.mjs`: zero NEW errors on top of
  the baseline passes; a baseline error that disappears is reported → `npm run typecheck:update-baseline`.
- `ui/dist` is bundled into the app after every CMake build (`app/CMakeLists.txt` → `Contents/Resources/ui` on
  macOS, `ui/` next to the exe on Windows) and served by the shell's resource provider at
  `WebBrowserComponent::getResourceProviderRoot()` (`juce://juce.backend/` on macOS — a secure context with
  AudioWorklet; `https://juce.backend/` on Windows). Not built → the shell serves the Phase-1 static page.
- Dev loop: `npm run dev` (Vite on :5173) + `TERMINATOR_UI_URL=http://localhost:5173 <Terminator.app binary>`
  = HMR inside the WebView. `TERMINATOR_UI_DIR=<some dist>` serves any built folder without rebuilding the app.
- CI builds the UI on the mac-universal, mac-intel and Windows jobs and the probe asserts `.chopper-view`
  rendered with zero uncaught page errors (`tools/ci/probe-app.sh`).

## What differs from the Electron renderer (keep this list complete — it is the diff to re-apply on a re-sync)
- `vite.config.ts` / `tsconfig.json` / `package.json` are this folder's own (mode `native` only; version read
  from the root CMakeLists `TERMINATOR_VERSION_STRING`; `__TERMINATOR_NATIVE__ = true`; CSP = the Electron prod
  CSP minus the Electron custom schemes).
- `src/renderer/vite-env.d.ts`: declares `__TERMINATOR_NATIVE__`.
- `src/renderer/lib/subscription.ts` + `chopper/ChopperView.tsx` (`checkLicenseGate`): the native build runs
  UNLOCKED until Phase 8/9 ports the desktop licence flow (device token in the OS keychain).
- `src/renderer/main.tsx`: imports `./native/ipc-native` BEFORE `./ipc-browser`.
- `src/renderer/preferences/PreferencesWindow.tsx`: imports `../native/ipc-native` first; when `isNative()` the AUDIO
  tab renders `NativeAudioPane` (Ableton-layout device page over `terminatorAudio`) + PPQ, and the MIDI tab adds
  `NativeMidiPane` (native ports) above the page's own MIDI settings. NEW `src/renderer/native/NativeAudioPane.tsx`,
  `NativeMidiPane.tsx`.
- NEW `src/renderer/native/juceBridge.ts` (typed face of the JUCE bridge on the official `@juce-framework/webview`
  npm package, 1.0.0 — AGPL-3.0 OR the JUCE licence, same terms as the framework we build on) and
  `src/renderer/native/ipc-native.ts` (the native `window.terminator` overlay — what is native vs. browser-shim vs.
  undefined is listed at the top of that file).
- `src/renderer/chopper/ChopperEngine.ts` (**the ONLY engine edit**): a `voiceSink` hook (start/stop/release of
  live-hit voices — called at the end of `startVoice`, in `stopVoice`, in `releasePad`'s gate branch) +
  `mutePadVoices` / `padVoiceOut()` (the live-hit voices of `startVoice`/`restemVoice` connect to a silent bus
  instead of `busFor()` when the native shadow is attached; the sequencer's scheduled voices are untouched).
  Null/false outside the shell = byte-for-byte the Electron behaviour.
- NEW `src/renderer/native/nativeEngineShadow.ts` (audio through the C++ engine — see its header) and the one-line
  `useEffect(() => attachNativeEngineShadow(engine), [engine])` in `chopper/ChopperView.tsx` + `chopper/HardwareView.tsx`
  (+ their import). `juceBridge.ts` grew `native.samples` (`terminatorSamples`).
- **The Sample Library (2.5, 2026-08-22):** NEW `src/renderer/native/libraryCore.ts` (the Electron
  `src/main/library.ts` logic ported verbatim-in-logic onto an injectable `FsApi` — pure, Node-runnable) +
  `src/renderer/native/libraryNative.ts` (FsApi over `terminatorFs`, the `window.terminator.library*` keys + the
  FOLDERS-tab root methods, `libraryFileUrl`, `libraryImportFiles`, the probe self-test); `ipc-native.ts` installs
  them. Edits: `chopper/libraryBridge.ts` (`libFileUrl` asks `window.terminator.libraryFileUrl` first → the shell's
  `/lib/b64/` URL; optional `importFiles` on the bridge type + mapping), `chopper/LibraryTree.tsx` (a Finder drop
  with no paths — every WebView drop — goes through `importFiles` with the File bytes). Gate: `scripts/
  test-library.mts` (39 cases, the Electron harness mirrored, Node ≥ 22.6 type-stripping) runs inside `npm run gate`.
- **YouTube import (2.5c, 2026-08-22):** NEW `src/renderer/native/processBridge.ts` (`terminatorProcess`: the
  bundled yt-dlp as a child process, output + exit events) + `src/renderer/native/youtubeNative.ts` (the Electron
  `src/main/youtubeDownloader.ts` ported: one-video download named by title, `--flat-playlist -J` enumeration,
  3-worker batch, cancel, error mapping, the 403 re-run); `libraryNative.ts` runs the import job (the Electron
  main.ts `library:youtubeImport` logic) and `downloadYouTube` (the `pullYouTube` GET SAMPLE path → the library's
  YouTube folder → `cacheUrl` = the shell's `/lib/b64/` URL). No edits to the shared renderer for this.
- **Asset store + `.tprojz` bundles (2.5d, 2026-08-22):** NEW `src/renderer/native/assetsNative.ts` (`assetPut/
  assetGet/assetHas` on `<dataDir>/assets/<hash>.<ext>` + `<hash>.json` — the Electron layout — with a READ
  FALLBACK into the Electron app's store on the same machine, `readBinaryFile`/`writeBinaryFile` helpers, the probe
  self-test); `ipc-native.ts` reads `.tprojz` bytes (`readProjectFile` → `bundle`), `saveProjectBundle`, and
  `saveProjectFile` trashes a stale bundle twin like Electron. No shared-renderer edits.
- Everything else is byte-identical to the Electron source at the commit above. Re-sync = `rsync` the same
  exclusions, re-apply this list, re-run the gate.

## Host binding (2.4b, landed) and engine binding (next)
`native/ipc-native.ts` gives the React app a native `window.terminator`: settings, EULA, recents, the projects
folder + `.tproj` open/save/list/delete with native dialogs, layout/MIDI-map/bass-patch files, presets + the
session autosave, reveal/open-external/clipboard — over `terminatorFs` / `terminatorSettings`
(app/src/ShellServices.cpp). The Preferences window is native (`terminatorWindow`, a second JUCE window
hosting `preferences.html` with native AUDIO/MIDI panes). Still browser-shim or undefined: `.tprojz` bundles + the
asset store (binary transport), library/drums/stems/YouTube, native menu shortcuts / Recent submenu /
open-with-file, drag-out, licence, cloud presets.
**The pads sound through the native C++ engine (2.5 shadow, 2026-08-22):** `native/nativeEngineShadow.ts` mirrors
every pad's buffer/region/params into the engine (`terminatorSamples` uploads + `setPadSample`/`setPadParams`/
`setPadLoop`) and every live hit/stop/note-off (`triggerPad`/`stopPad`/`releasePad`); the TS engine's live-hit
voices are muted. Still Web Audio inside the WebView: the chop SEQUENCER's scheduled voices, drums, bass, the
mixer/master FX, metronome (Phases 3/4). Not mirrored yet: time-stretch (dry natively), the one-shot fade-OUT
tail, live re-stem of a ringing voice (the next hit plays the new mix), per-hit reverse of a rendered LOOP, MIDI
LEDs for hits that arrive natively (no Web MIDI in the WebView — native MidiHub plays note−36 directly). Probe:
`window.__terminatorNativeShadow.stats()` / `.selfTest()` (tools/ci/probe-app.sh asserts both).
Dev loop for the engine work: `TERMINATOR_UI_URL=http://localhost:5173` (Vite HMR) — note HMR of ChopperView
re-mounts it, which detaches/re-attaches the shadow (pads re-upload).
