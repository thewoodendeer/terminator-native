# BRIDGE PROTOCOL — WebView ⇄ engine (v1, Phase 1)

The React UI (Phase 2+) and today's static page talk to the C++ shell through JUCE 9's WebView bridge,
using the **official `@juce-framework/webview` package** (`modules/juce_gui_extra/native/typescript/
webview-interop`, ESM, served at `/juce/index.js`). No hand-rolled `window.__JUCE__` plumbing: the page
imports `getNativeFunction` and uses `window.__JUCE__.backend.addEventListener`. The C++ side registers
native functions with `WebBrowserComponent::Options::withNativeFunction` and pushes events with
`emitEventIfBrowserIsVisible`.

Version field: every `terminatorInfo()` reply carries `bridgeProtocol` (integer, **1** since Phase 1). The UI
refuses to run against a protocol it does not know. Bump it whenever a command/event shape changes
incompatibly; add fields freely (additive changes don't bump).

## Transport
| Direction | Mechanism | Threading |
|---|---|---|
| JS → C++ | native functions (Promise-returning): `terminatorInfo()`, `terminatorCommand(cmd)`, `terminatorAudio(req)`, `terminatorMidi(req)`, `terminatorPads(req)` | message thread; engine-bound commands → `Engine::commands().push()` (lock-free) → audio thread at the next block |
| C++ → JS | events `terminator.snapshot` (20 Hz), `terminator.devicesChanged`, `terminator.midiChanged` | audio thread publishes `StateSnapshot` (wait-free) → message thread reads `Engine::snapshot()` → WebView |

Resources at `WebBrowserComponent::getResourceProviderRoot()` (`juce://juce.backend/` macOS · `https://juce.backend/`
Windows): the **built React UI** (`ui/dist`, bundled into the app at build time, or `TERMINATOR_UI_DIR=<dir>`)
owns `/` and every path under it when present (MIME by extension, no `..`); `/juce/index.js` (the official
`@juce-framework/webview` ESM) is always served; without a built UI the embedded Phase-1 static page is served.
Env `TERMINATOR_UI_URL` overrides the start URL (Vite dev server with HMR). Env `TERMINATOR_PROBE_FILE=<path>` =
headless smoke mode (see tools/ci/probe-app.sh) — the probe also reports `uiMode`, `chopperView`, `errors`
(uncaught page errors collected by a user script), `secureContext`, `audioWorklet`.

## `terminatorInfo()` → object
```json
{ "app": "Terminator", "version": "3.0.0-alpha.0", "juce": "9.0.1", "os": "macOS 15", "arch": "arm64",
  "cpu": "Apple M2", "bridgeProtocol": 1, "maxPads": 64, "maxVoices": 256, "settingsFile": "…/Terminator3/settings.json",
  "device": { …see Device object… } }
```

## `terminatorCommand(cmd)` → `{ "ok": true }` | `{ "ok": false, "error": "…" }`
`cmd.type` selects the engine `CommandType` (engine/include/terminator/core/Command.h):

| `type` | fields | engine |
|---|---|---|
| `setMasterGain` | `gain` 0..4 | one-block linear ramp |
| `setTestTone` | `enabled`, `frequencyHz` (440), `amplitude` 0..1 (0.25), `outputPair` (0) | sine on outs 2p+1/2p+2 |
| `transportPlay` / `transportStop` | — | playhead counter |
| `panic` | — | stop + 3 ms fade on every voice, tone off |
| `triggerPad` | `pad`, `velocity` 0..1 | starts a voice at the next block (one-block latency; MIDI keeps intra-block offsets) |
| `releasePad` | `pad` | note-off (gate pads release over max(5 ms, release); one-shots ignore) |
| `stopPad` | `pad` | 3 ms fade on that pad's voices |
| `setNoteMap` | `note` 0..127, `pad` (−1 = unmapped) | MIDI note → pad table (default note−36) |
| `setPadParams` | `pad`, `pitch` ±24, `fine` ±50, `attack` 0..0.5, `release` 0..0.5, `gain` 0..4, `outputPair`, `mode` oneshot|gate|loop, `reverse`, `chokeGroup` (−1 own pad · −2 poly · ≥0 group), `interpolation` hermite|linear | RT pad params |
| `setPadLoopBuffer` *(engine-internal, not a JSON verb)* | `pad`, loop buffer + steady `[loopStart,loopEnd)` frames | attaches a pre-rendered crossfade loop (`loop::renderCrossfadeLoop`) so a LOOP pad plays a seamless period; the shell renders it on the loader thread when a pad's fades/region change (Phase 2.3). Null clears it → raw hard-wrap of the region |
| `setPadStems` *(engine-internal, not a JSON verb)* | `pad`, `planes[4]` (drums/bass/other/vocals SampleBuffers, each the base buffer's length/rate; null = absent), `mask` 4-bit | attaches the pad's decoded stem planes + mask (Phase 2.3 stems-in-the-voice). A voice with a partial mask SUMS its lit planes while reading (= `mixMaskChannels`); mask 0/15, no planes, or a lit plane missing → the ORIGINAL plays (never silence). Arriving while the pad rings = a LIVE re-stem: a twin voice at the same position/rate/envelope reads the new set with a 12 ms linear fade-in while the old one fades out over 12 ms (`restemVoice`). Send after `setPadSample` (a new sample clears the planes; the mask stays) |

Refused with `ok:false` when: not an object, unknown `type`, or the command queue is full (1023 pending —
a UI bug, never expected).

## `terminatorAudio(req)` — Preferences → AUDIO (Ableton-style)
`req.verb`: `list` (default; `forType` lists devices of another driver type) · `apply` {`deviceType`,
`inputDevice`, `outputDevice`, `sampleRate`, `bufferSize`, `inputChannels[]`, `outputChannels[]`} (saved to
settings.json) · `enableAll` (every channel of the current devices) · `default` (default output, no inputs) ·
`calibrate` {`outputChannel`, `inputChannel`} → emits a 64-frame click, records 1 s, cross-correlates on the
message thread, result arrives in the snapshot (`calibrationState` 2 + `calibrationSamples/Ms`) and in the
Device object; stored in settings `calibration.*`.
Reply: `{ ok, error?, deviceTypes[], currentType, listType, inputDevices[], outputDevices[], device }`.

### Device object
```json
{ "type": "CoreAudio", "inputDevice": "Model 16", "outputDevice": "Model 16", "sampleRate": 48000, "bufferSize": 64,
  "inputs": 2, "outputs": 2, "inputLatencySamples": 90, "outputLatencySamples": 122, "inputLatencyMs": 1.9,
  "outputLatencyMs": 2.5, "open": true, "error": "", "inputChannelNames": ["Input 1", …], "outputChannelNames": […],
  "activeInputChannels": [0,1], "activeOutputChannels": [0,1], "availableSampleRates": [44100, 48000, …],
  "availableBufferSizes": [32, 64, …], "xruns": 0, "cpuLoad": 0.03,
  "calibrationSamples": 231, "calibrationMs": 4.81, "calibrationReportedSamples": 212 }
```
(`calibrationSamples` −1 = not measured · −2 channel out of range · −3 nothing heard.)

## `terminatorMidi(req)`
`verb`: `list` (default) · `enable` {`id`, `enabled`} · `enableAll` · `refresh`. Reply `{ ok, error?, inputs:[{id,
name, enabled, open}], messages, lastLagMs, medianLagMs, last }`. Enabled set persisted in settings `midi.inputs`.
Engine side: every message is stamped with the shared host clock minus the driver→handler lag and pushed into
the port's lock-free queue; the audio thread maps note-on/off through the note map. Clock/active-sense are not
forwarded (Phase 3).

## `terminatorPads(req)`
`verb`: `list` (default) → `{ ok, pads:[{pad, hasSample, name, file, frames, sampleRate, channels, pitch, fine,
attack, release, gain, outputPair, mode, reverse, chokeGroup}], samplesLive, bytesLive }` · `choose` {`pad`}
(native file chooser → decode on the message thread → `SampleStore` → `setPadSample`) · `loadFile` {`pad`,
`path`} · `clear` {`pad`}. Previous samples are retired through the quarantine (SampleStore) — never freed
while a voice could still read them.

## Events (C++ → JS)
### `terminator.snapshot` (20 Hz)
```json
{ "prepared": true, "sampleRate": 48000, "blockSize": 64, "outputs": 2, "inputs": 2, "playing": false,
  "playheadSamples": 0, "blocksProcessed": 1234, "masterGain": 0.5, "testToneEnabled": false, "testToneFrequencyHz": 440,
  "peakL": 0.0, "peakR": 0.0, "outputPeaks": [0,0], "inputPeaks": [0,0], "commandsApplied": 3, "commandsDropped": 0,
  "cpuLoad": 0.01, "xruns": 0, "activeVoices": 0, "voiceStealing": 0, "padActiveMask": 0, "lastTriggeredPad": -1,
  "lastTriggeredPadPositionSec": 0, "calibrationState": 0, "calibrationSamples": -1, "calibrationMs": -1,
  "midiMessages": 0, "midiLagMs": 0, "midiLast": "" }
```
### `terminator.devicesChanged` (Device object) — hot-plug / device error · `terminator.midiChanged` (MIDI reply)

## Project v0 (terminator-render input)
```json
{ "terminatorProject": 0,
  "render":   { "sampleRate": 48000, "blockSize": 512, "channels": 2, "lengthSeconds": 2.0 },
  "master":   { "gain": 0.5 },
  "testTone": { "enabled": false, "frequencyHz": 440, "amplitude": 0.5 },
  "pads":     [ { "pad": 0, "file": "kick.wav", "startFrame": 0, "endFrame": 0, "pitch": 0, "fine": 0, "attack": 0.003,
                  "release": 0, "gain": 1, "outputPair": 0, "mode": "oneshot", "reverse": false, "chokeGroup": -1,
                  "interpolation": "hermite" } ],
  "events":   [ { "pad": 0, "time": 0.5, "velocity": 1.0, "type": "on" } ] }
```
Parsed by `parseRenderSpec` (engine/src/render/OfflineRenderer.cpp); files relative to the project file;
events are placed sample-accurately (`triggerPadAtSample` / `releasePadAtSample`); renders are block-size
invariant (test `[invariance]`). Phase 2 replaces this with the real `.tproj/.tprojz` reader (plan §B10) —
the `terminatorProject` version field stays.

## Roadmap for the bridge (Phase 2)
- Typed `EngineClient` interface in TypeScript (same shape for desktop/native and web/Web-Audio).
- Batched commands per animation frame; binary meter/playhead/waveform-peak streams (ArrayBuffer / resource URLs).
- Schema versioning tests + bridge fuzz (plan §Testing 5).
- Native dialogs/menus/drag-drop/file pickers exposed as native functions (file chooser already is).
