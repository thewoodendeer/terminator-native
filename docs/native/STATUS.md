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

## Phase 1 — Audio I/O, latency truth, "hello pads" — NOT STARTED
Needs: his Tascam Model 16 on the Mac for the RTL measurement gate (plan Phase 1).
