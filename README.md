# Terminator 3.0 — native

Native rebuild of Terminator (sampler / DAW) in C++20 on JUCE 9.0.1: CoreAudio/ASIO/WASAPI, multi-channel
I/O, VST3/AU hosting, sample-accurate transport, in-process stems, and the existing React UI rendered in a
native WebView. Mac universal (arm64 + x86_64, macOS 12+) and Windows x64.

**Read first:** `docs/native/TERMINATOR-NATIVE-PLAN.md` (the plan), `docs/native/STATUS.md` (where we are),
`docs/native/BUILD-RULES.md` (how to build/gate), `docs/native/RT-RULES.md` (the audio-thread contract),
`docs/native/BRIDGE-PROTOCOL.md` (WebView ⇄ engine).

## Quick start (macOS)
```bash
brew install ninja llvm            # llvm = RealtimeSanitizer toolchain
cmake --preset mac-debug && cmake --build --preset mac-debug -j8 && ctest --preset mac-debug
open build/mac-debug/app/Terminator_artefacts/Debug/Terminator.app
```
Universal release: `cmake --preset mac-release-universal && cmake --build --preset mac-release-universal`
→ `lipo -info build/mac-release-universal/app/Terminator_artefacts/Release/Terminator.app/Contents/MacOS/Terminator`.
RT gate: `cmake --preset mac-rtsan && cmake --build --preset mac-rtsan && ctest --preset mac-rtsan`.

## Quick start (Windows, x64 Native Tools shell)
```bat
nuget install Microsoft.Web.WebView2 -OutputDirectory %USERPROFILE%\AppData\Local\PackageManagement\NuGet\Packages
cmake --preset win-release -DTERMINATOR_ASIO_SDK_DIR=C:\path\to\asiosdk && cmake --build --preset win-release && ctest --preset win-release
```

## Layout
```
engine/   libterminator — UI-free engine (core/ is JUCE-free; io/ AudioIO; render/ offline renderer)
app/      JUCE shell: window + WebView + bridge
tools/    terminator-render CLI (project JSON → WAV; the test-harness spine)
tests/    Catch2 + fixtures (+ allocation-counter RT gate)
ui/       the React UI (Phase 2)
docs/native/  plan, dossiers, rules, status
.github/workflows/build.yml  CI: mac universal · mac Intel · mac RTSan · Windows
```
