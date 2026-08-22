# CLAUDE.md — terminator-native

This is the NATIVE Terminator 3.0 repo (C++20 + JUCE 9.0.1). The [WEB]/[IOS] rules from the global
Universal-Build-Rules do NOT apply here — no tsc, SW, CSP, Vite deploy, XcodeGen. This repo's own rules:

1. Read `docs/native/STATUS.md` first (where we are), then `docs/native/TERMINATOR-NATIVE-PLAN.md` Part C for
   the current phase, then the dossier for the area you touch. Code wins over dossier wins over plan.
2. Build/gate rules: `docs/native/BUILD-RULES.md`. Audio-thread contract: `docs/native/RT-RULES.md`
   (non-negotiable). Bridge: `docs/native/BRIDGE-PROTOCOL.md` — every command/event change updates it.
3. Linear commits on `main`, named `git add` paths, one feature per commit, lowercase imperative subject.
   **Never push without Victor's explicit go-ahead** (a push triggers CI and is outward-facing).
4. Gate before "done": `mac-debug` 0 warnings + ctest green, `mac-rtsan` ctest green,
   `mac-release-universal` lipo shows both arches, CI green. Then tell Victor exactly what to test and wait.
5. Update STATUS.md (and memory) whenever a phase item lands.
6. Never write the real home path into any file (`~/`, not `/Users/<name>/`). No secrets, no fetched SDKs,
   no binaries in git.
