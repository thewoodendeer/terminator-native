# ui/ — the React UI (Phase 2.4)

The Terminator React app, COPIED from the Electron repo (`terminator/src/renderer` at `mpc-stem-extractor`
0af0dbe, 2026-08-22) minus `mpc/` (the Extractor), `board/` (the Producer Sim) and `test/`, plus `src/mixer`
(the desk) and the `board/sim/net` subset that `chopper/transfer/projectTransfer.ts` needs (no `guests.ts` /
`xfer.ts` — those pull three.js + the Extractor types). `finishhim/` is kept (it is the DAW's arranger UI).
Public assets: fonts, worklets, themes, icon, manifest; `public/videos/*.mp4` (the boot-intro easter egg) are
NOT committed — `scripts/sync-assets.sh` copies them from a local Electron checkout.

## Build + gate
```
cd ui && npm ci && npm run gate      # = tsc --noEmit (baseline below) + vite build --mode native → ui/dist
```
- **tsc baseline = 5 errors**, the SAME five the Electron renderer carries (ChopperView `ipc` possibly
  undefined ×2, exporters `Uint8Array`, mpcSample `replaceAll` ×2). Zero NEW errors on top of that is the gate.
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
- Everything else is byte-identical to the Electron source at the commit above. Re-sync = `rsync` the same
  exclusions, re-apply this list, re-run the gate.

## Engine binding (2.4b →)
Today the copied `ChopperEngine.ts` still plays through Web Audio INSIDE the WebView (the `ipc-browser`
IndexedDB shim stands in for `window.terminator`). The native binding lands as `EngineClient` (typed
interface) with `NativeEngineClient` over `@juce-framework/webview` (`/juce/index.js`, served by the shell) and
`WebAudioEngineClient` wrapping the existing engine — see docs/native/BRIDGE-PROTOCOL.md and STATUS.md §2.4.
