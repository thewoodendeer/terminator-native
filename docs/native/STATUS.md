# STATUS — Terminator 3.0 native

Plan: TERMINATOR-NATIVE-PLAN.md (Part C = phases + gates). Dossiers: dossier-*.md (code truth as of the
Electron repo at 0af0dbe, 2026-08-22). Build rules: BUILD-RULES.md · RT rules: RT-RULES.md · Bridge:
BRIDGE-PROTOCOL.md.

## Phase 0 — Foundations (started 2026-08-22)
| item | state | notes |
|---|---|---|
| 0.1 repo `~/Developer/terminator-native`, linear main | DONE (local) | private GitHub remote + first push: **held for Victor's go-ahead** |
| 0.2 layout engine/ app/ tools/ tests/ docs/native/ .github/ | DONE | `ui/` = placeholder README — the React UI is copied in Phase 2 (nothing to build/verify before the bridge exists; keeping 26k lines of dead TS out of Phase 0). `third_party/` = FetchContent lands in `build/_deps`; dir kept for fetched SDK drops |
| 0.3 toolchain: ninja, Homebrew LLVM 22 (RTSan), presets mac-debug/release/release-universal/rtsan/asan-ubsan/win-debug/release; JUCE Starter; ASIO SDK + WebView2 NuGet in CI | DONE | Apple clang 21 has **no** `-fsanitize=realtime` → Homebrew LLVM is the RTSan toolchain. RTSan + ASan cannot be combined (clang refuses) → two presets instead of the plan's one |
| 0.4 RT rules doc, `TERMINATOR_NONBLOCKING` / `TERMINATOR_RT_ASSERT`, clang-format/tidy, sanitizer presets | DONE | `-Wfunction-effects` on as a warning (libm calls), RTSan is the hard gate; allocation-counter tests gate MSVC |
| 0.5 skeleton: Engine (prepare/process/release, test tone, master ramp, transport counter), SpscQueue commands, SnapshotPublisher (triple buffer), AudioIO over AudioDeviceManager, terminator-render CLI (project v0 JSON → WAV) | DONE | 18 Catch2 cases + 5 CLI ctest gates |
| 0.6 CI: mac universal (macos-15, lipo-verified + Rosetta run of the x86_64 CLI), mac Intel (macos-15-intel), mac RTSan, Windows (MSVC + WebView2 + ASIO fetch) | WRITTEN, **not yet run** | runs on first push (held). `macos-13` no longer exists on GitHub → `macos-15-intel` |
| 0.7 docs: BRIDGE-PROTOCOL v0, STATUS, BUILD-RULES, RT-RULES, RELEASE-CYCLES-NATIVE stub | DONE | |
| hello app: JUCE window + WebView (WKWebView / WebView2) showing the static page, engine info + 20 Hz snapshot over the official `@juce-framework/webview` bridge, test tone / play / stop / panic / master buttons | DONE (Mac) | Windows build unverified until CI |

**Gate (plan):** CI builds + tests on macOS (arm64 + x64) and Windows; RTSan clean on the empty callback;
JUCE window with a WebView showing a static page; `lipo` shows arm64+x86_64.
**Local evidence (2026-08-22, M1 Max, macOS 26.5.1, Xcode 26.6 / Apple clang 21, Homebrew LLVM 22.1.8):**
- `mac-debug`: build **0 warnings** (`-Werror` on our targets), `ctest` **24/24** green.
- `mac-rtsan` (Homebrew clang, `-fsanitize=realtime`): build 0 warnings, `ctest` **25/25** green; negative
  control (a `[[clang::nonblocking]]` function that mallocs) aborts with "RealtimeSanitizer: unsafe-library-call
  malloc" — the gate bites.
- `mac-release-universal`: 0 warnings, 24/24 green, `lipo -info` = **`x86_64 arm64`** on `Terminator`,
  `terminator-render`, `terminator-tests`; the x86_64 CLI runs under Rosetta (`arch -x86_64 … --version`).
- App probe (`TERMINATOR_PROBE_FILE`, tools/ci/probe-app.sh) on the universal app: page rendered in WKWebView,
  `window.__JUCE__` present, `@juce-framework/webview` loaded, `terminatorInfo()` → "Terminator 3.0.0-alpha.0 ·
  JUCE 9.0.1 · arm64", device "CoreAudio · MacBook Pro Speakers · 44100 Hz", snapshot "prepared … blocks 7876 …
  cmds 1/0 dropped · xruns 0". PROBE OK.
- `mac-asan-ubsan` (Apple clang): 0 warnings, `ctest` **24/24** green.
**Remaining for the gate:** first push → CI green on all 4 jobs (needs go-ahead); Windows build/WebView2
unverified until then (no Windows machine in this session).

### Victor's pass (Phase 0)
Open `Terminator.app` (build/mac-release-universal/app/Terminator_artefacts/Release/ or the CI artifact):
- the window shows the black status page, "bridge" line green, "device" line names your interface/speakers;
- "test tone ON" → a 440 Hz tone at −12 dB on outs 1/2, meters move, the "snapshot" line counts blocks;
- master slider changes the level smoothly (no clicks); PANIC silences; ▶/■ move the playhead seconds.
Verdict: ☐ pending

## Phase 1 — Audio I/O, latency truth, "hello pads" (built 2026-08-22, same session)
| item | state | notes |
|---|---|---|
| 1.1 `AudioIO`: device types, in/out device pick, sample rate/buffer, per-channel enables (Input/Output Config), hot-plug (`ChangeListener` + `onDeviceChanged` → `terminator.devicesChanged`), errors surfaced; settings persisted + restored on launch | DONE | Preferences AUDIO page = the static page's AUDIO block (Ableton layout: Driver Type · Input/Output Device · Channel Configuration · Rate · Buffer · Latencies · Measure · Enable all · Test Tone · CPU). The React page comes with Phase 2 |
| 1.2 Latency: reported in/out latency; **loopback calibration** (64-frame Hann click → capture 1 s → cross-correlate on the message thread → round trip + "driver error compensation" = measured − reported; stored in settings); `ClockPoint` host-time ↔ sample mapping in every snapshot; MIDI/UI events placed by host timestamp | DONE | calibration proven on a synthetic loopback (delay 1234 → measured 1234); the real cable test is his |
| 1.3 Minimal sampler: `SampleLoader` (WAV/AIFF/FLAC/Ogg + CoreAudio MP3/AAC/M4A on Mac, Windows Media on Win; any rate, no resampling), 64 pads / 256 voices, varispeed (hermite default, linear "CLASSIC"), attack/release in real seconds, one-shot/gate/loop/reverse, choke (own pad / group / poly), velocity linear, per-pad output pair (outs 3–8…), voice stealing | DONE | loop = hard wrap (Phase 2 adds the rendered equal-power crossfade loop); stretch/stems/NORM/trims = Phase 2 |
| 1.4 MIDI in: `MidiHub` (all JUCE inputs, per-port enable persisted, hot-plug poll), driver-thread → per-port lock-free queue → audio thread; note→pad map (note−36, remappable); latency meter = driver ts → handler (median of 48) | DONE | clock/CC/learn = Phase 3 |
| 1.5 Stress: 128 voices + stealing past 256 allocation-free; block-size invariance 32…2048; rates 44.1k/96k/192k; RTSan clean | DONE (headless) | device-switch-while-playing = his pass |
| `terminator-render` project v0 grew `pads[]` + `events[]` (sample-accurate) — the golden-render harness spine | DONE | |

**Gate evidence (local, M1 Max):** `mac-debug` 0 warnings, **45/45** ctest; `mac-rtsan` see below; probe OK on the
Phase 1 shell (64 pads, MIDI port listed, device + engine lines live). CI: see the run linked in git log.
**Gate items that need Victor (cannot be measured without the interface):** RTL ≤ 3 ms @64/48k on the Model 16
(use **Measure** with a cable from an output to an input — the page prints samples + ms + compensation);
pad hit → sound ≤ 1 buffer + driver (feel); outputs 3–8 audible (set a pad's out pair / the test tone pair).

### Victor's pass (Phase 1)
1. Preferences block: pick CoreAudio → Model 16 in + out, 48 kHz, buffer 64 → Apply. Input Config / Output
   Config should list all 16 / 14 channels; **Enable all**; the input meters should move when you play into the
   interface.
2. Test tone → out pair 3/4 (and 5/6, 7/8): you should hear it on those outputs only.
3. Cable output 1 → input 1, set Measure out 0 → in 0, press Measure: expect a round trip in the ~100–300 sample
   range at 64/48k (≈ 2–6 ms). Tell me the number — it goes into the plan.
4. Load a sample on a pad (□), play it from the pad, the keys (z x c v …) and your MPC/controller (note 36 = pad 1):
   does it feel like an MPC at buffer 64? Try gate mode + release, loop, reverse, −12/+12 pitch, choke group.
5. Unplug/replug the interface while a loop plays: the engine should glide to silence and recover (no crash).
Verdict: ☐ pending

### Needs extra work / can be improved (Phase 1)
- Windows paths unverified by hand (CI only): ASIO needs the SDK fetched (CI does), WebView2 probe is soft.
- Sub-buffer MIDI placement is "relative to the previous block entry" (one block of fixed latency, spacing kept);
  a driver-timestamp path (CoreMIDI/WinRT timestamps instead of arrival) would shave jitter further — Phase 3.
- No input monitoring yet (Phase 5); calibration records only; mic permission prompt appears the first time an
  input channel is enabled (MICROPHONE_PERMISSION_ENABLED in the plist).
- Settings file is the native app's own (`~/Library/Application Support/Terminator3/settings.json`); Electron
  settings import = Phase 8.

## Phase 2 — Sampler engine parity + bridge + the real UI boots — NEXT
