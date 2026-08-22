# BRIDGE PROTOCOL — WebView ⇄ engine (v0, Phase 0)

The React UI (Phase 2+) and today's static page talk to the C++ shell through JUCE 9's WebView bridge,
using the **official `@juce-framework/webview` package** (`modules/juce_gui_extra/native/typescript/
webview-interop`, ESM). No hand-rolled `window.__JUCE__` plumbing: the page imports `getNativeFunction`
and uses `window.__JUCE__.backend.addEventListener`. The C++ side registers native functions with
`WebBrowserComponent::Options::withNativeFunction` and pushes events with `emitEventIfBrowserIsVisible`.

Version field: every `terminatorInfo()` reply carries `bridgeProtocol` (integer). The UI refuses to run
against a protocol it does not know. Bump it whenever a command/event shape changes incompatibly; add
fields freely (additive changes don't bump).

## Transport
| Direction | Mechanism | Threading |
|---|---|---|
| JS → C++ | native function (Promise-returning). `terminatorInfo()`, `terminatorCommand(cmd)` | message thread → `Engine::commands().push()` (lock-free) → audio thread at the next block |
| C++ → JS | event `terminator.snapshot` (20 Hz timer, `WebShell::timerCallback`) | audio thread publishes `StateSnapshot` (wait-free) → message thread reads `Engine::snapshot()` → WebView |

Page resources are served from embedded binary data at `WebBrowserComponent::getResourceProviderRoot()`:
`/` and `/index.html` (the page), `/juce/index.js` (the JUCE package). Env `TERMINATOR_UI_URL` overrides
the start URL (Vite dev server with HMR in Phase 2).

## Native functions (JS → C++)
### `terminatorInfo()` → object
```json
{ "app": "Terminator", "version": "3.0.0-alpha.0", "juce": "9.0.1", "os": "macOS 15", "arch": "arm64",
  "cpu": "Apple M2", "bridgeProtocol": 0,
  "device": { "type": "CoreAudio", "name": "MacBook Pro Speakers", "sampleRate": 48000, "bufferSize": 512,
              "inputs": 0, "outputs": 2, "inputLatencySamples": 0, "outputLatencySamples": 0,
              "open": true, "error": "" } }
```
### `terminatorCommand(cmd)` → `{ "ok": true }` | `{ "ok": false, "error": "…" }`
`cmd` is one object; `type` selects the engine `CommandType` (engine/include/terminator/core/Command.h):

| `type` | fields | engine |
|---|---|---|
| `setMasterGain` | `gain` 0..4 (linear) | `CommandType::setMasterGain` — one-block linear ramp |
| `setTestTone` | `enabled` bool, `frequencyHz` (default 440), `amplitude` 0..1 (default 0.25) | `CommandType::setTestTone` |
| `transportPlay` | — | `CommandType::transportPlay` |
| `transportStop` | — | `CommandType::transportStop` |
| `panic` | — | `CommandType::panic` — stop + silence |

Refused with `ok:false` when: not an object, unknown `type`, or the command queue is full (1023 pending —
a UI bug, never expected).

## Events (C++ → JS)
### `terminator.snapshot` (20 Hz)
```json
{ "prepared": true, "sampleRate": 48000, "blockSize": 512, "outputs": 2, "playing": false,
  "playheadSamples": 0, "blocksProcessed": 1234, "masterGain": 0.5, "testToneEnabled": false,
  "testToneFrequencyHz": 440, "peakL": 0.0, "peakR": 0.0, "commandsApplied": 3, "commandsDropped": 0,
  "cpuLoad": 0.01, "xruns": 0 }
```
Mirrors `StateSnapshot` (engine/include/terminator/core/StateSnapshot.h) plus device-manager stats.

## Project v0 (terminator-render input)
```json
{ "terminatorProject": 0,
  "render":   { "sampleRate": 48000, "blockSize": 512, "channels": 2, "lengthSeconds": 2.0 },
  "master":   { "gain": 0.5 },
  "testTone": { "enabled": true, "frequencyHz": 440, "amplitude": 0.5 } }
```
Parsed by `parseRenderSpec` (engine/src/render/OfflineRenderer.cpp). Missing sections keep defaults;
wrong `terminatorProject` version, non-numbers and out-of-range values are rejected with a message.
Phase 2 replaces this with the real `.tproj/.tprojz` reader (plan §B10) — the `terminatorProject`
version field stays.

## Roadmap for the bridge (Phase 2)
- Typed `EngineClient` interface in TypeScript (same shape for desktop/native and web/Web-Audio).
- Batched commands per animation frame; binary meter/playhead stream (ArrayBuffer events) instead of JSON.
- Schema versioning tests + bridge fuzz (plan §Testing 5).
- Native dialogs/menus/drag-drop/file pickers exposed as native functions.
