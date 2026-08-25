# RELEASE CYCLES — Terminator 3.0 native (STUB — written at Phase 9)

Not a release runbook yet. This file exists so nobody improvises one earlier.

What is already decided (TERMINATOR-NATIVE-PLAN.md §A0/§A2, Phase 9):
- Separate channel from the Electron app: R2 prefix `terminator-native/` in bucket `terminator-samples`;
  its own feeds (Sparkle appcast for Mac, WinSparkle for Windows — electron-updater's yml format is gone).
- Version line `3.0.0-alpha.N` → `3.0.0-beta.N` → `3.0.0`. Version lives in the root CMakeLists
  (`TERMINATOR_VERSION_STRING` + `project(VERSION)`), one spot, read by the app, the CLI and the appcast.
- Mac: universal .dmg, hardened runtime, notarised through the Keychain notary profile; the gate is the
  PACKAGED app launching (8-second smoke) before any upload. Windows: signed installer (cert at Phase 9).
- Discipline carried over from RELEASE-CYCLES.md (Electron, canonical): binaries first → verify 200 + sizes
  → feed last; never reuse or regress a live version; never touch the other platform's feed; rollback
  first, diagnose second.

**Pre-release checks that already exist — run these before any build reaches a user:**
- `tools/ci/probe-app.sh <the PACKAGED binary>` — the 8-second smoke grew into the whole gate: the bridge, the
  UI, the engine (sequencers, mixer + PDC, live record), the licence round trip, the export, the drum route,
  and the bundle's OS claims (`terminator://`, `.tproj`, `.tprojz`) read out of the built Info.plist.
- **A SOAK**: `TERMINATOR_PROBE_SOAK=600 tools/ci/probe-app.sh …` keeps the app PLAYING for ten minutes and
  reports what resident memory did (it fails past 20 MB/min of sustained growth). A leak in the play loop never
  shows up in a 35-second probe. Measured 2026-08-25 over 5.3 minutes: 675 MB → **268 MB**, flat for the last
  two minutes, 219,199 blocks — it reclaims rather than grows.
- `ls Terminator.app/Contents/Resources/drums-flac | wc -l` — a build made on a machine without
  `drums-flac/` provisioned ships an app that needs the network for drums.

Until Phase 9 the only "releases" are CI artifacts (`Terminator-mac-universal-unsigned.zip`,
`Terminator-win-x64-unsigned.zip`, 14-day retention) — for Victor's per-phase pass, never for users.
