# BUILD RULES — terminator-native (C++20 / JUCE 9.0.1)

This repo is a native C++ repo. **None of the [WEB] or [IOS] rules apply here** — no service worker, no Vite
bundle DEPLOY, no XcodeGen. The one web-shaped corner is `ui/` (the copied React app, Phase 2.4): its own
`npm run gate` (tsc baseline **5** = the Electron renderer's five + `vite build --mode native` → `ui/dist`),
documented in `ui/README.md`; CMake bundles `ui/dist` into the app when it exists.

## Repo
- `~/Developer/terminator-native` · private GitHub `thewoodendeer/terminator-native` · **linear commits on
  `main`** (solo repo: no feature branches, no merges). Named `git add` paths only. One feature per commit.
- **No push without Victor's go-ahead.** Ever. CI runs on push, so a push IS the CI trigger — ask first.
- Never commit: `build/`, fetched SDKs (`third_party/asiosdk*`), binaries, `.env`, keys, the real home path
  (write `~/`, not `/Users/<name>/`).
- Version line: `3.0.0-alpha.N` → `TERMINATOR_VERSION_STRING` in the root CMakeLists (one spot) +
  `project(VERSION)` numeric part. Bump both together.

## Toolchain
- macOS: Xcode (Apple clang 21+), `brew install ninja llvm` (LLVM 20+ = RTSan). CMake ≥ 3.28 (4.x ok).
- Windows: Visual Studio 2022/2026 Build Tools (MSVC x64), Ninja, CMake ≥ 3.28. WebView2 NuGet package at
  `%USERPROFILE%\AppData\Local\PackageManagement\NuGet\Packages` (JUCE's default search path;
  `nuget install Microsoft.Web.WebView2 -OutputDirectory <that path>`). ASIO SDK: download from Steinberg
  yourself, pass `-DTERMINATOR_ASIO_SDK_DIR=<dir containing common/iasiodrv.h>` — never commit it.
- Everything third-party is pinned in `cmake/Dependencies.cmake` via FetchContent (JUCE 9.0.1, Catch2
  v3.8.1). Nothing downloaded by hand. Bump = one commit, all presets rebuilt, tests green.
- JUCE licence: **Starter (free, ≤ $20k revenue)** until Terminator 3.0 sells; upgrade to Indie at Phase 9.1b.

## Presets (CMakePresets.json) — `cmake --preset X && cmake --build --preset X && ctest --preset X`
| preset | what | when |
|---|---|---|
| `mac-debug` | Debug, native arch, app+tools+tests | daily work |
| `mac-release` | Release, native arch | local perf checks, Intel CI runner |
| `mac-release-universal` | Release, `arm64;x86_64` | the shipping build; `lipo -info` must show both |
| `mac-rtsan` | Debug + `-fsanitize=realtime`, Homebrew LLVM, **no app** | the RT gate (CI job `mac-rtsan`) |
| `mac-asan-ubsan` | Debug + ASan/UBSan, Apple clang, **no app** | memory/UB hunting (not combinable with RTSan) |
| `win-debug` / `win-release` | MSVC x64 via Ninja — run from an **x64 Native Tools** shell | Windows |

Intel Macs: Homebrew lives in `/usr/local` — override `-DCMAKE_CXX_COMPILER=/usr/local/opt/llvm/bin/clang++`
for `mac-rtsan`.

## Gates (all must be green before "done")
1. `mac-debug` builds with **zero warnings** (`-Werror` is on for our targets: engine/app/tools/tests;
   JUCE itself is exempt). MSVC: `/W4 /WX`.
2. `ctest` green on `mac-debug` (Catch2 suites `engine.*` + `cli.render.*`).
2b. `cd ui && npm run gate` green (tsc at its 5-error baseline, zero new; vite build) whenever `ui/` changed;
    the app probe (`tools/ci/probe-app.sh`) then asserts ChopperView rendered with no page errors.
3. `mac-rtsan` ctest green — no RT violation on the callback path.
4. `mac-release-universal`: `lipo -info` on `Terminator.app/Contents/MacOS/Terminator` and
   `terminator-render` shows `x86_64 arm64`.
5. CI green on all four jobs (macOS universal, macOS Intel, macOS RTSan, Windows).
6. Phase gate + Victor's ear/hands pass as listed in TERMINATOR-NATIVE-PLAN.md Part C; recorded in STATUS.md.

## Code rules
- `engine/` is UI-free. `engine/include/terminator/core` is JUCE-free (pure C++20). `io/` and `render/`
  may use non-GUI JUCE modules (audio_devices, audio_formats, core). Nothing in `engine/` includes
  `juce_gui_*` or knows about the WebView.
- RT path: docs/native/RT-RULES.md. Every engine capability = Command + Snapshot field + bridge doc line +
  test.
- Exports/offline renders go through `renderOffline()` — the same `Engine::process`. No second code path.
- Format with `.clang-format` (`clang-format -i` on touched files); `.clang-tidy` is advisory.
- Tests: Catch2 in `tests/engine/*.cpp`, golden fixtures in `tests/fixtures/` (Phase 2: real `.tproj`
  projects + reference WAVs rendered by the Electron engine; tolerance rules in the plan §Testing).
- Commit style: lowercase imperative subject, bullet body (house rule).

## Release (Phase 9 — see RELEASE-CYCLES-NATIVE.md)
Sparkle (Mac) + WinSparkle (Win) feeds under R2 prefix `terminator-native/`. Binaries first, feed last,
never reuse a live version. Mac: hardened runtime + notarisation via the Keychain profile. Windows: OV/EV
cert bought at Phase 9. Not before.

## Bundled tools (yt-dlp + qjs + lame) — 2.5c / 4.5g
`cmake/ProvisionTools.cmake` (target `TerminatorBundleTools`, runs with every app build) downloads the pinned
yt-dlp nightly + quickjs-ng `qjs`, SHA-256 verified, into `third_party/.tools-cache` (gitignored) and lays them into
the bundle. Offline / engine-only: `-DTERMINATOR_BUNDLE_TOOLS=OFF`. Bumping yt-dlp or qjs = the tag/version AND the
hashes together, in that one file; then re-run the probe with `TERMINATOR_PROBE_NET=1` (a real pull).

**`lame` (MP3 export) rides the same script**, landing at `bin/lame` (mac) / `bin/lame.exe` (Windows) — where
`ProcessHub::lameBinary()` looks and `render::findLameBinary` prefers it over anything on the machine. It is a
PACKAGING concern, never a linking one: the app drives the executable through JUCE and links nothing, so the
unmodified upstream binary keeps us clear of LAME's LGPL. Mac has no trustworthy prebuilt (and none universal), so
the script COMPILES the pinned 3.100 tarball once per machine into one universal, dependency-free executable
(~20 s, cached as `lame-3.100-macos-universal`) and ad-hoc signs it; Windows takes RareWares' prebuilt x64
`lame.exe` (static — `lame_enc.dll` is deliberately not shipped). Bumping = URL + SHA together, same rule.
**At release, sign `Contents/Resources/bin/**` (lame, qjs, yt-dlp and its `_internal/`) with the Developer ID
`--options runtime --timestamp` BEFORE signing the app** — a nested executable that is only ad-hoc signed fails
notarisation. The probe gate is `mp3Ok` in the export self-test: when a build ships `lame`, an MP3 export has to
succeed with no `lame` anywhere else on the machine.
LAME is credited beside yt-dlp in the app (`ui/src/renderer/chopper/EulaModal.tsx`).
