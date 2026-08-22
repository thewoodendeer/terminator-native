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

**Gate evidence (local, M1 Max):** `mac-debug` **45/45** ctest; `mac-rtsan` 45/45; probe OK on the Phase 1 shell
(64 pads, MIDI port listed, device + engine lines live).
**CI run 32588994003 (Phase 1 push):** mac universal ✅ · mac Intel ✅ · mac RTSan ✅ · **Windows: configure + build ✅
(ASIO SDK + WebView2 resolved on the runner) but ctest ✗ — `SIGSEGV Stack overflow`: `Engine` was ~2 MB by value
(1.5 MB calibration capture + queues) and tests/OfflineRenderer put it on a 1 MB Windows stack.** Fixed in the
commit after this note (big buffers heap-allocated once in the constructor; sizeof(Engine) is now ~30 KB) — the
NEXT session must confirm the re-run is green on all four jobs (`gh run list`) before starting Phase 2.
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

## Phase 2 — Sampler engine parity + bridge + the real UI boots — IN PROGRESS (started 2026-08-22)

### 2.0 CI + warnings cleanup (DONE, pushed)
- The 10 cosmetic `-Wfunction-effects` warnings are gone: every RT definition in `Engine.cpp`/`Sampler.cpp` now
  carries `TERMINATOR_NONBLOCKING` matching its declaration, and the calibration click table is a
  namespace-scope `const` (no function-local static guard on the callback). `mac-debug` builds **0 warnings**.
- CI run **32589905778** (the Windows stack-overflow fix): 3 mac jobs green; the **mac-universal Test step hung**
  on `engine.SpscQueue: producer/consumer threads` — the consumer popped an item on its `done` branch and then
  DROPPED it, spinning forever waiting for it on a slow Release runner. Fixed (record every pop, stop once the
  producer is done and the queue is drained). Also added `ctest --timeout 300` to every CI job so a hang fails
  by name instead of stalling the run for hours. (Two intermediate runs show "cancelled/failure" — that is
  `concurrency: cancel-in-progress` superseding them on rapid pushes, not a real failure.)

### 2.1 Project model on ValueTree + undo + ChopPreset round-trip (DONE, pushed)
- `engine/include/terminator/model/` + `engine/src/model/`: the project is a **`juce::ValueTree`** whose shape
  mirrors the Electron `ChopPreset` JSON with field names unchanged (`ProjectModel.h` documents the tree).
  `projectFromJson` accepts every legacy shape `loadPreset` does (no version field, single-pattern seq fields,
  `drums._inputQuantize` migration, resolution validation, mask normalisation); `projectToJson` emits the
  current `getPresetData()` shape **+ `version: 2`** (additive — the Electron loader ignores unknown fields).
  chops/pads/pad-sources/routes/groups/choke/sourceFx/sourceNorm/sequences/master/extraFX/trims/stems/
  sourceStems are structured nodes; `drums`/`bass`/`mixer`/`assets`/`timeline` stay opaque `var` blobs until
  their engines land (Phases 3/4) — they round-trip losslessly and undo replaces them whole.
- **Undo = `juce::UndoManager` over the tree** (`EditHistory` + `Document`), with the Electron semantics on top:
  500 ms coalescing by group key (`pad-pitch-N`, `pad-fade-N`, `chop-boundary-<id>-<side>`), begin/end batch
  collapses paste/dup/move to one step, sample audio referenced by the tree (source ids) never copied.
- **The pure planners are ported** (`engine/include/terminator/core/planners/`), JUCE-free, with the TS gates as
  Catch2 cases: stem masks + ready ranges (`stemMask.ts`), trims (file↔effective, region merge, kept ranges,
  effective buffer with 3 ms seam ramps, the three time maps — `trimRegions.ts`), 16T swing (`swing.ts` +
  `seqSwingOffsetSec`), live landing / INPUT Q (`liveLanding`), and the sequencer refit / "the grid is a lens"
  (`refitSeqStorage`, resolutions, `clampVel`). `js::round`/`roundToInt` reproduce `Math.round` so the ports
  hold bit-for-bit.

**Gate evidence (local, M1 Max):**
- `mac-debug` build **0 warnings**, `ctest` **64/64** green; `mac-rtsan` **65/65** green (the model/planner tests
  are pure C++ so they run under RTSan too); `mac-release-universal` 59/59 in 1.9 s, lipo = x86_64 arm64.
- **Round-trip gate:** Victor's **8 real `.tproj` projects** (fixtures `tests/fixtures/projects/p1..p8`, home
  path scrubbed — they carry only R2/YouTube ids, no local paths) parse → serialise and every key the Electron
  writer emitted comes back equal (numbers within 1e-9, key order ignored, null grid rows == empty rows); our
  output re-parses to an **identical** tree (fixed point) and adds only `version`/`viewResolution`/`velGrid`.
- **Undo gate:** a real project (p4) survives **600 pitch edits** and returns byte-identical after undoing them
  all; ≥ 500 steps kept; deep history bounded (UndoManager unit cap).

### 2.1 needs Victor
- Nothing yet — this is headless model work. His ear/hands pass is owed at 2.5 (ChopperView boots) and on the
  Phase 1 items still pending (see below).

### 2.2 Pure planners ported (DONE, pushed)
`engine/include/terminator/core/planners/` — JUCE-free, each with its TS gate re-asserted as a Catch2 case:
- `StemMask.h` (stemMask.ts): bit order, toggle-refuses-last, normalise, combo mixdown = exact sum, ready
  ranges merge/contain/EPS.
- `Trims.h` (trimRegions.ts): fileToEff/effToFile (seam sides), addTrimRegion (merge + swallowed-chop dedupe),
  keptRanges, buildEffectiveChannels (3 ms seam ramps, exact ramp values), cutTimes/mapTimesFileToEff/
  mapFileRangesToEff.
- `Swing.h` (swing.ts + seqSwingOffsetSec): pulse-snap formula, steps-in-an-odd-16th shift together.
- `LiveLanding.h` (liveLanding / INPUT Q): 100 on the line, 0 keeps the time, 50 halfway, monotonic, NaN=full.
- `SeqRefit.h` (refitSeqStorage / "the grid is a lens"): resolutions, clampVel, gcd/lcm, columnStride,
  refitStorage (upscale/downscale lossless, recording floor). `LoopRender.h` (renderCrossfadeLoop) below.
- `js::round`/`roundToInt` reproduce `Math.round` so the ports hold bit-for-bit.
STILL TS-ONLY (not yet ported — needed for 2.3 chop-while-playing + auto-slice, and 2.5 UI): the transient
detectors (broadband + drum-only, exact params), estimateBPM (tempogram), detectSilenceEnd, applySnap/
snapToBeat/gridAnchor/snapToTransient, autoChop/autoSliceTransients, and the BLOCKS planners (blockRange/
insertPushing/rearrange/moveBlock/planMoveBlock/nextSlotForSource/roomAfterBlock/chopPadSource*) + padClipboard.
These are pure and portable the same way; they were not on the critical path for the render spine.

### 2.3 Voice engine + analysis (PARTIAL — the pieces that set the memory/timing profile, DONE + pushed)
- **Rendered equal-power crossfade LOOP** on the RT sampler (`LoopRender.h` + `Sampler`/`Command`
  `setPadLoopBuffer`): the message thread renders a pad's loop buffer + steady `[loopStart,loopEnd)` and hands
  it over; a LOOP voice plays the warm-up then wraps that period seamlessly (replaces Phase 1's hard wrap).
  RT-safe (rtsan green); gate: no seam step > 2× the audio's own.
- **Disk-cached multi-resolution waveform peaks** (`analysis/WaveformPeaks.h`): a pure C++ min/max pyramid
  serialised to a small blob — deliberately NOT `juce::AudioThumbnail` (it needs juce_audio_utils → GUI, and
  libterminator must stay UI-free for Phase 11). Gate: a 4-min stereo buffer → ~720 KB blob, COLD re-open draws
  a full-width window in **0.79 ms** (≤ 100 ms gate).
- **ProjectPlanner** (`model/ProjectPlanner.h`): padSourceKey / chokeGroupOf / seqTailGroup / reversedFor +
  `patternToEvents` (swing, per-cell velocity, per-pad reverse, tail-group note length) over the tree. Gates:
  chop-seq-standalone (velocity/swing/tail) + pad-reverse (override-vs-source).
- **ProjectRenderer** (`render/ProjectRenderer.h`): a project tree + a bank of decoded samples → a RenderSpec
  the **same** offline Engine renders — the "export = what you hear" spine, one DSP path. Pads resolve to
  buffer+region (own sample or a main-track chop), params carry pitch (pad+source+fine)/mode/reverse/choke
  (source-identity groups → stable ints); the current sequence becomes on/stop events. Gate: a 1/16 kit renders
  master audio at the sequenced times with velocity 0.2 vs 1.0 audibly scaled; a main-track chop plays its region.
- **NOT YET DONE in 2.3** (deferred, honest): per-source NORM as a per-voice multiplier (currently folded into
  master gain, so it is right for a whole-project render but not for per-pad NORM independence — a later pass);
  stems masks read from a `StemSet` in the voice (2.2 stem-slice buffers); Signalsmith stretch cache; the
  trims→effective-buffer swap wired into the Document; the **disk-streaming source + the ≤ 400 MB idle-RSS
  gate** (needs the real large-file streaming `AudioFormatReader` source + a device/real-song RSS measurement —
  see "needs Victor"); the analysis thread wiring (detectors above are still TS-only).

### 2.4 / 2.5 / 2.6 — NOT STARTED
EngineClient (TS interface) + NativeEngineClient/WebAudioEngineClient, the `ui/` copy of the React app (26k
lines) + pnpm gate, booting ChopperView in the WebView, and the packaged build. The Phase 1 static page + bridge
v1 already prove the WebView/bridge/engine path end to end (probe); 2.4+ swap the static page for the real UI.

## CI — GREEN on all 4 jobs (2026-08-22, run 32594435703)
mac universal ✅ · mac Intel ✅ · mac RTSan ✅ · **Windows/MSVC ✅**. The whole Phase-2 engine/model/render batch
is verified on every platform.
- **What was blocking it, and how it was cleared:** the private repo's 2,000 included GitHub-Actions minutes/mo
  hit 100% mid-session, so runs died instantly ("payments failed / spending limit"). Victor's call: **make the
  repo PUBLIC** (Actions minutes are free/unlimited on public repos) "until you're done building". Done —
  `thewoodendeer/terminator-native` is PUBLIC now. A pre-flight scan confirmed no secrets, no keys, no real home
  path (only `~/`), commits under the `thewoodendeer` pseudonym, and fixtures carrying only public song
  titles/R2 ids. **NEEDS VICTOR (low priority): flip the repo back to PRIVATE once the build is far enough along**
  (or when the monthly minutes reset on Sept 1) — it was private by design.
- **Five Windows-only breaks were found and fixed via CI this session (all clang-invisible):** (1) `columnStride`
  constexpr calling `std::floor` → C3615, made `inline`; (2) locals shadowing `ids::` names under
  `using namespace ids` → C4459, renamed; (3) `M_PI` undefined on MSVC → guarded in 6 files; (4) [the SPSC test
  hang, earlier]; (5) **non-ASCII TEST_CASE names** (arrows/dashes) mangled by `catch_discover_tests` PRE_TEST on
  the Windows command line → the test ran 0 assertions and ctest failed it → all test names are ASCII now. MSVC
  is the only thing that compiles the Windows path, so it stays the cross-platform oracle — keep test names
  ASCII, avoid `using namespace ids` in .cpp, and no `constexpr` fn that calls libm.

### 2.3 onset / BPM / silence detectors (DONE, pushed)
`core/planners/Onsets.h` (impl in `src/analysis/Onsets.cpp`): `detectTransients` (broadband HOP256/FRAME512,
flux mean+0.1σ, 30 ms gap), `detectDrumTransients` (banded LP200/HP1500, mean+0.5σ, 50 ms, kick eLow/eHigh>0.4
snare>0.15, merge/dedupe), `detectSilenceEnd` (RMS 0.015 / 256), `estimateBpm` (tempogram HOP1024/FRAME2048,
comb [1,.7,.5,.4], fold 75..165). Exact-param ports — unlocks auto-chop + snap-to-transient (still-TS list now
shrinks to: applySnap/snapToBeat/gridAnchor, autoChop/autoSliceTransients, the BLOCKS planners, padClipboard).
Gate: synthetic click tracks read 120 and 90 BPM; broadband finds impulses within 20 ms; banded finds
kicks+snares; silence-end lands on the first sound; a <8 s buffer returns 0.

### 2.3/chop-workflow — snap + chop editing + blocks (DONE, pushed)
- `core/planners/Snap.h`: applySnap / snapToTransient / snapToBeat / gridAnchor (beat grid anchored at the first
  drum hit, folded into [0,beat); beat modes fall back to transient when bpm is unknown).
- `Document`: analysis state (bpm + transients, set after decode) + `autoChop(n)` (equal division onto pads
  0..n-1, one undo step), `sliceAtTime` (split the containing chop at the snapped position onto a target pad,
  10 ms edge guard, stems carry over).
- `core/planners/Blocks.h` + `Document.moveBlock`: blockRange / nextSlotForSource / roomAfterBlock /
  insertPushing / planMoveBlock ported pure (blocks push aside, never overwrite; singles swap). moveBlock
  rewrites the pad nodes + pad sources + index-keyed route/choke/group overrides from the plan's new->old map and
  remaps every sequencer step. Gates green on all 4 CI jobs.

## Phase 2 — where it stands (honest boundary, 2026-08-22)
**DONE and CI-green on Mac arm64 + Intel + RTSan + Windows/MSVC — the engine/model/render CORE:**
project ValueTree + round-trip of Victor's 8 real projects; undo (UndoManager, 500-deep); the pure planners with
their TS-test parity (stem masks, trims, swing, live-landing, seq-refit, loop-render, onset/BPM/silence
detectors, snap, blocks); the rendered crossfade LOOP on the RT sampler; disk-cached waveform peaks (0.79 ms
cold); ProjectPlanner (patternToEvents) + ProjectRenderer ("export = what you hear"); Document editing
(pad params, chop boundary, autoChop, sliceAtTime, moveBlock). 90 Catch2 cases + 5 CLI gates, 0 warnings, RTSan
clean, lipo universal.

**NOT DONE in Phase 2 (the remaining work, in order):**
- Engine tail: per-source NORM as a per-voice multiplier (today folded into master gain — right for a whole
  render, not for per-pad NORM independence); stems read from a StemSet in the voice; Signalsmith stretch cache;
  trims→effective-buffer swap wired into the Document; the disk-streaming source + the ≤ 400 MB idle-RSS gate
  (needs the streaming AudioFormatReader source + a real-song RSS measurement on Victor's machine); the analysis
  thread that runs the detectors on load; the remaining pure planners (chopPadSource*, movePad singles,
  padClipboard, autoSliceTransients by the knob).
- **2.4 EngineClient + the `ui/` React copy (≈26k lines) + pnpm gate** — a big mechanical port; the typed
  EngineClient interface (NativeEngineClient over the JUCE bridge / WebAudioEngineClient over the existing engine)
  is designed in the plan but not written.
- **2.5 boot ChopperView in the WebView** against the native engine (LOAD/WAVEFORM/PADS, sample browser, themes/
  help). Needs 2.4 + a Vite dev server; the Phase-1 static page already proves the WebView/bridge/engine path.
- **2.6 packaged build #1.**
These UI-integration steps are a different kind of work from the headless engine ports and are best done as their
own focused session(s); they also carry Victor's owed device pass (below).

## Phases 3–9 — NOT STARTED
Transport/sequencers/MIDI (3), mixer/FX/console/PDC (4), recording (5), plugins (6), stems native (7),
persistence/library/exports (8), ship (9). Each is 6–18 sessions in the plan. The Phase-2 planners already lay
groundwork for 3 (patternToEvents, swing, refit, the transport-agnostic Engine) and 8 (the ValueTree ⇄
ChopPreset reader/writer is the persistence core).

### Latent bug found while porting### Latent bug found while porting (flagged, not yet fixed in the Electron app)
- `refitSeqStorage` (ChopperEngine.ts): when INPUT Q < 100 raises the storage `floor` above the lossless
  resolution, the Electron code scales note indices only by the lossless factor, not by `next/old` — so notes
  can land on the wrong step the first time the floor kicks in. The C++ port does the full `next/old` scaling
  (test `seq refit`), so native is correct; worth a one-line fix in the web engine in a separate session.

## Phase 2 — Sampler engine parity + bridge + the real UI boots — NEXT (handoff written 2026-08-22)

### Design decisions already taken (planning session, folded into the plan — do not re-litigate)
- **Undo = `juce::ValueTree` + `UndoManager` from the first Phase 2 commit.** The project model IS the undo
  model and serialises to the `ChopPreset` JSON with field names unchanged. Preserve: 500 ms coalescing by
  group key (`pad-pitch-N`, `pad-fade-N`, `chop-boundary-<id>-<side>`, `auto-slice`), begin/end batch
  (paste/dup/move/clearBlock = one step), sample buffers referenced never copied. Close the Electron gap:
  padRoutes/sourceRoutes + knob drags ARE in history.
- **Disk streaming + `AudioThumbnail` land in 2.3, not later.** Pads keep a resident head; the rest streams
  on the loader thread; fully-resident mode for short one-shots + offline render. Peaks = AudioThumbnail
  cached to disk. Gates: idle RSS with a 4-minute song + stems ≤ 400 MB; cold waveform draw ≤ 100 ms;
  undo/redo 500 deep bounded.
- **Phase 11 (plugin) constraint:** `libterminator` never assumes it owns the clock, the device, the window
  or the filesystem — transport/I-O/paths are injected (Phase 1 already obeys: Engine::process takes the
  block + host time; AudioIO is outside the core).
- The React UI is COPIED into `ui/` (from `terminator/src/renderer`, minus `mpc/` + `board/`, keep
  `finishhim/`), binds through a typed `EngineClient` (NativeEngineClient over @juce-framework/webview,
  WebAudioEngineClient wrapping the existing ChopperEngine for dev/testing).

### What was read for Phase 2 (so the next session does not re-read blindly)
Dossiers: chopper-core (all), shell-ui §2/§4/§6, persistence §1/§2.1, sequencing-midi §4/§5. Electron
sources read in full: `lib/swing.ts`, `chopper/stemMask.ts`, `lib/audioClock.ts`, `chopper/trimRegions.ts`,
`chopper/padClipboard.ts`, `chopper/bpmDetect.ts`; `ChopperEngine.ts` lines 140–560 (types,
renderCrossfadeLoop, liveLanding, ChopperState), 1300–1700 (sources/blocks/rearrange/insertPushing/
moveBlock/planMoveBlock/resolvePadSource/padRenderPlan), 2100–2200 (addTrim/restoreTrims),
3000–3420 (detectSilenceEnd/autoChop/autoSliceTransients/getPresetData/loadPreset), 3420–3880
(setChopBoundary/applySnap/snapToBeat/gridAnchor/transient detectors/slice fns), 3988–4330 (clearPad/
setPad*/triggerPad/triggerPadAt/_doTrigger). NOT yet read: 4330–4760 (startVoice/restemVoice/release/stop/
chokeGroup/loopBufferFor), 2400–2540 (routes/busFor/chokeGroupOf/sourceSettings/attackFor/pitchFor/
reversedFor/normGainFor), 1700–2000 (stem slice buffers), 1120–1300 (ensurePad/chopPadSource/
autoChopPadSource/movePad/assignChopToPad/cloneChop/reviveChop/unassignPad/loadPadBuffer/setPadTrim/
clearBlock), 4760–4870 (stretch), 6858–6900 (patternToEvents), stemsController.ts.
A read-only survey agent was started for the ChopperEngine public API × UI call sites (EngineClient
extraction) — re-run it if its result is not in the handoff memory note.

### Victor's real projects (for golden renders)
8 `.tproj` in `~/Library/Application Support/terminator/terminator-presets/` (+ 86 assets, 538 MB). Main
tracks are R2 ids (e.g. `688b1ef70ddbb8c05cbdbcfe`) — NOT on disk; pad sources via `padBufferMeta`; the
YouTube folder holds 7 cached m4a. Golden-render harness is still an open question: the Electron
`fake-web-audio` harness is a proxy (no real DSP), so reference WAVs need a real Web Audio render (headless
Chromium / the web build in a browser) — decide in Phase 2.1; until then port planners with their TS tests
(exact math) and validate DSP per feature against synthetic references.

### Phase 2 work order (proposed)
2.1 `Project` model on ValueTree (+ UndoManager wrapper with group coalescing/batching) ↔ ChopPreset JSON
    reader/writer; round-trip Victor's 8 projects (parse → serialise → deep-compare). Tests.
2.2 Port the pure planners as C++ with the TS tests: trims (fileToEff/effToFile/addTrimRegion/keptRanges/
    buildEffectiveBuffer/cutTimes/mapTimesFileToEff/mapFileRangesToEff), stemMask (+ ready ranges), swing,
    liveLanding, refit (gcd/lcm), blocks (blockRange/insertPushing/rearrange/moveBlock/planMoveBlock/
    nextSlotForSource/roomAfterBlock/chopPadSource*), applySnap/snapToBeat/gridAnchor/snapToTransient,
    detectTransients (broadband + drum-only, exact params), estimateBPM, detectSilenceEnd, autoChop/
    autoSliceTransients, renderCrossfadeLoop, clearPad merge rules, setChopBoundary coupling, padClipboard.
2.3 Voice engine parity on the Phase 1 sampler: per-voice region from chops (main) or pad sources, per-source
    fx (attack/pitch/fine/reverse), NORM (0.891/peak), velocity×NORM, rendered crossfade LOOP (period/warm-up
    math), one-shot fades, release anchored on raw velocity, choke = source identity default / 'none' / grpN,
    120 ms one-owner window (Phase 3), restem crossfade 12 ms, chop-while-playing (playhead = samplesRendered
    − outputLatency + chopOffsetMs → snap), stretch cache (Signalsmith via FetchContent) with dry fallback,
    stem masks from StemSet (FLAC stem assets from the cache), trims → effective buffer swap on the loader
    thread, streaming source + AudioThumbnail (2.3 of the plan), analysis thread.
2.4 EngineClient (TS) + NativeEngineClient + WebAudioEngineClient; `ui/` copy + pnpm; waveform peaks via
    resource URLs; batched commands; binary meter stream.
2.5 Boot ChopperView in the WebView (LOAD/WAVEFORM/PADS), sample browser on `~/Music/Terminator/library.json`
    (read-only first), yt-dlp pulls, RECORD SAMPLE minimal, themes/help/tooltips.
2.6 Packaged build #1.
