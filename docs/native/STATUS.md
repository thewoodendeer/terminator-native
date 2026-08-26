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

### 2.4 / 2.5 / 2.6 — see the third-session sections below (2.4 DONE, 2.5 partial, 2.6 not started)

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

### 2.3 engine tail (DONE, 2026-08-22 third session — two parallel worktrees, merged linear)
- **Stems in the RT voice** (`Command::setPadStems(pad, planes[4], mask)`): a pad carries up to 4 stem planes + a
  4-bit mask; a voice with a partial mask SUMS its lit planes while reading (exact per-sample sum; reverse/varispeed
  identical to the base path); mask 0/15/missing plane = the original (never silence); a mask change on a ringing
  pad re-stems LIVE (twin voice, 12 ms linear crossfade like TS `restemVoice`). Allocation-free, RTSan green.
- **ProjectRenderer parity**: per-source NORM (`SourceNorm['src:<videoId>']` → the voice gain; main chops 1, the
  master gain carries chopVolume×main NORM), one-shot attack = max(source attack, fadeIn/2^(semis/12)), release =
  Master.release, LOOP pads render `loop::renderCrossfadeLoop` of their (reversed, stem-mixed) region, masked pads
  attach decoded stem planes when the span is inside the tree's readyRanges (`SampleBank` grew `mainStems` +
  `stemsBySourceVideoId`; `RenderPadSpec` grew loop + stems).
- **`analysis::buildEffectiveBuffer(file, trims)`** (+ `effectiveOrSame`, `buildEffectiveStems`): the message-thread
  trims→effective audio rebuild (3 ms seam ramps, same object for zero trims).
- **Document** (model): `movePad` (singles move/swap, routes+choke travel, PadGroups pinned like TS, seq steps
  remapped), `clearPad` (all merge rules + SourceStems prune) / `clearBlock` (one batch), `unassignPad`,
  `assignChopToPad`, `cloneChop`, `reviveChop`, `setPadSource` (loadPadBuffer's tree half + `ensureSourceRoute`),
  `hasPadContent`, `setPadsReverse`; `roomAfterBlock`, `chopPadSource`, `chopPadSourceTo`, `autoChopPadSource`,
  `autoChopPadSourceAtTransients`, `padSourceChops`; `autoSliceTransients(sens)` (strengths in `Analysis`,
  `js::round`, slivers, stems carry-over, "auto-slice" coalescing); trims `addTrim`/`restoreTrims` (+
  `trimList`, `effToFile`/`fileToEff`, `trims::effectiveDurationSec`); `core/planners/PadClipboard.h` +
  `copyPads/pastePads/clearPads/cutPads/duplicatePads`. A shared `rearrange()` (snapSlot/placeSlot/origin map/step
  remap) backs moveBlock, chopPadSource* and movePad.
- **Gate:** `mac-debug` 0 warnings, `ctest` **115/115** (89 → +10 voice-tail + 16 pad-ops). RTSan: voice-tail ran
  green in its worktree (100/100); the merged tree's `mac-rtsan` run is in this session's log / CI.
- **Brief-vs-code notes (ported as TS does unless stated):** TS restem is linear (kept); TS anchors release on raw
  velocity not NORM-scaled (native fades from the current level — not reproduced); one-shot `fadeOut` tail has no
  RT field yet; stems are full-length planes in place (TS: chop-length slices + LRU); restem of a rendered LOOP
  voice leaves the ringing voice (re-render + re-send); `setPadStems` must follow `setPadSample`. Document: stems +
  reverse TRAVEL with pad content on movePad (TS pins them to the index — deliberate deviation, consistent with
  moveBlock); vacated pads keep pitch/mode/gate/fades (TS parity); `addTrimRegion` dedupes swallowed chops by id
  (latent TS under-grow on restore, mirrored); `remapSteps` splices `grid` only (velGrid/revGrid positional, as TS);
  analysis arrays are not undo-tracked (the analysis thread re-maps from the original).
- **STILL OPEN in the engine tail:** Signalsmith stretch cache (design note: a message-thread render cache keyed
  (buffer, start, end, ratio) handed over like the loop render; hit path compute-free, warm async); the
  **disk-streaming source + the ≤ 400 MB idle-RSS gate** (design: chunked `SampleBuffer` with a resident head +
  chunk table, loader prefetch from per-voice cursors in the snapshot, quarantine-pinned, a "starved" counter);
  the analysis thread (detectors on load, trims re-map); the trims→effective swap wired from the Document into the
  loader; the one-shot fadeOut tail.

### 2.4 the real UI in the native shell (DONE, 2026-08-22 third session)
- **`ui/`** = the Electron renderer copied (terminator@0af0dbe; minus `mpc/`, `board/`, `test/`; plus `src/mixer` +
  the `board/sim/net` subset projectTransfer needs), its own `npm run gate` (**tsc baseline 5** = the renderer's
  five, `scripts/typecheck.mjs` fails only on NEW errors; `vite build --mode native`), bundled into the app after
  every CMake build (`Contents/Resources/ui`, Windows `ui/` next to the exe) and served by the shell's resource
  provider at `juce://juce.backend/` (a secure context with AudioWorklet). The only source edits vs the copy are
  listed in `ui/README.md` (flag, unlocked gating, ipc-native import, prefs panes).
- **The native `window.terminator`** (`ui/src/renderer/native/ipc-native.ts` over `terminatorFs` /
  `terminatorSettings` / `terminatorWindow`, `app/src/ShellServices.cpp`): settings (+ the synchronous boot read via
  a user script), EULA (local; Supabase insert joins the licence flow), recents, projects folder + `.tproj`
  open/save/list/delete (Trash) with native dialogs, layout / MIDI-map / bass-patch files, presets + named presets +
  session autosave (JSON under `~/Library/Application Support/Terminator3/`), reveal / open-external / clipboard,
  **Preferences = a second JUCE window** hosting `preferences.html` with **native AUDIO (Ableton layout) + MIDI
  panes** over `terminatorAudio`/`terminatorMidi`. `juceBridge.ts` = the typed face on the official
  `@juce-framework/webview` 1.0.0 package.
- **Gate evidence (M1 Max, mac-debug):** `tools/ci/probe-app.sh` → `uiMode react`, **`chopperView true`**, 32 pads,
  `errors []`, `asyncChecks` (settings/EULA/projects dir/list/layout round-trips through the real shim) `done`,
  **`prefsWindow true` + `prefsReady true`** (the Preferences window opened from the UI and its page loaded). CI
  builds the UI on the mac-universal / mac-intel / Windows jobs and the mac probe asserts all of it.
- **NOT native yet (honest):** the copied `ChopperEngine.ts` still plays through **Web Audio inside the WebView** —
  pads sound, but NOT through the C++ engine, so latency/feel is not the native engine's yet. `.tprojz` bundles +
  the asset store (binary transport), library/drums/stems/YouTube, native menus/shortcuts/Recent/open-with-file,
  drag-out, licence, cloud presets stay browser-shim or hidden.

### 2.5a — AUDIO THROUGH THE NATIVE ENGINE: the EngineClient SHADOW (DONE, 2026-08-22 fourth session)
**The pads now sound through the C++ engine in the real app.** Design = the planned shadow: the TS `ChopperEngine`
keeps owning chops/pads/sources/params/undo/sequencer/playhead/LEDs; `ui/src/renderer/native/nativeEngineShadow.ts`
sits beside it and mirrors the pads into the native engine, and the TS engine's LIVE-HIT voices are routed into a
silent bus (`mutePadVoices`) so what you hear is the native sampler.
- **Bridge:** `terminatorSamples` (`begin/chunk/end` = chunked base64 float32 interleaved → planar `SampleBuffer` in
  the `SampleStore` under a page key; `loadFile {key, path}`; `release` unbinds pads then retires through the
  quarantine; `list`) + JSON commands `setPadSample {pad, key, startSec, endSec}` and `setPadLoop {pad, key,
  startSec, endSec, fadeInSec, fadeOutSec, reverse | clear}` (the shell renders the crossfade loop with
  `render::renderPadLoop` — now exported from ProjectRenderer.h so live + offline share one render) and
  `setPadParams.gate`. `app/src/SampleRegistry.{h,cpp}` owns key → store id, pad → key, pad → loop render id.
- **Engine:** `PadParams::gate` (NOTE ON in any mode — a gated LOOP loops while held; `PadMode::gate` implies it;
  the voice carries `gate`, `release()` honours it, the 5 ms release floor follows it) + pitch clamp widened to
  ±48 (pad PITCH ±24 + source PITCH ±24 summed by the UI). Tests: gated one-shot / gated LOOP / un-gated LOOP
  ignores note-off / +36 st = rate 8 + clamp at 48 (`test_sampler`).
- **The shadow (TS):** per pad a descriptor from `resolvePadSource` (main chop, pad source, or the stem-mix SLICE
  — so stem masks play natively as plain samples), `sourceSettings` (pitch/fine/attack), `reversedFor`,
  `chokeGroupOf` (→ stable ints; 'none' = poly), CHOP level × NORM (main: `normalizeGain`, sources: `sourceNorm`),
  mode/gate/loop fades, master RELEASE; diffed against the last sent, applied in order per pad (setPadSample on
  region/key change, setPadParams on param change, setPadLoop on loop change); buffers uploaded once per
  AudioBuffer (3 MB float32 chunks, base64 via FileReader off the main thread), refcounted across pads, released
  2 s after the last reference; `ChopperEngine.voiceSink` (start/stop/release — the only engine edit, listed in
  ui/README) → `triggerPad` (a hit first re-syncs its pad synchronously, then fires after the pad's pending
  apply; `when` in the future → a timer; a per-hit reverse override flips `setPadParams` around the trigger),
  `stopPad`, `releasePad`; `setMasterGain` = master volume. Detach clears every native pad + releases keys.
- **Gate evidence (M1 Max, mac-debug):** `tools/ci/probe-app.sh` now asserts the shadow: `attached`, self-test
  `upload` → `storeFrames 12000` → `bind` → `loop` (native render) → `trigger` → **`lastTriggeredPad 63` on the
  audio thread** (device present), `release`; AND the REAL path: `engine.loadPadBuffer(62)` + `setPadPitch(62, 3)`
  → `syncBound` with `pitch 3`, `engine.triggerPad(62)` → the sink fired natively (`lastTriggeredPad 62`),
  `removePadBuffer` → `syncUnbound`. ctest mac-debug **115/115**, mac-rtsan **116/116**, ui gate baseline 5 / 0 new,
  clang-format clean, build 0 warnings.
- **CMake gotcha fixed:** the UI bundling was a `POST_BUILD` step of the app target, which only fires when the app
  RELINKS — a UI-only rebuild (`npm run gate` + `cmake --build`) kept serving yesterday's dist (the probe caught
  it: "no shadow"). Now `TerminatorBundleUi` is an always-run target depending on `Terminator`.
- **HONEST boundary (what still plays through Web Audio in the WebView):** the chop SEQUENCER's scheduled voices
  (`scheduleSeqStepAudio` — its own ctx-clock path; native transport = Phase 3), drums, bass, metronome, the
  mixer strips + master FX chain (Phase 4 — native pads go dry to outs 1/2, `setMasterGain` = master volume).
  Not mirrored yet: time-STRETCH (dry natively), live re-stem of a ringing voice (the next hit plays the new
  mix), per-hit reverse of a rendered LOOP. (Closed later this session: the one-shot fade-OUT tail —
  `PadParams::fadeOutSec`, linear to silence over the last fadeOut of the region in buffer time, LOOP pads ignore
  it, tests `fadeOutSec` ×2, RTSan green; and MIDI → the page, 2.5e. The 20 Hz snapshot carries `activePads[]`
  because `padActiveMask` loses bits ≥ 53 in JS.) Memory: the C++ side holds a copy of every buffer the page holds (the
  shadow's cost — goes away when ownership moves to the Document + disk streaming).
- **Next (ownership moves native, in order):** peaks via resource URLs so the page stops needing the PCM; the
  main buffer/pad sources decoded by PATH (library/yt/recordings/assets) so uploads vanish for files; the chop
  sequencer on the native transport (Phase 3) with `triggerPadAtSample`; LEDs/playhead from the snapshot.

### 2.5b — THE SAMPLE LIBRARY is native (DONE, 2026-08-22 fourth session)
`~/Music/Terminator` (library.json + Recordings/YouTube/Imports/User Samples, linked folders) works in the native
app with the SAME on-disk format the Electron app writes — a user's library moves between the two apps unchanged.
- **Design:** the Electron library logic (`src/main/library.ts`, 968 lines) is ported verbatim-in-logic into the
  page as `ui/src/renderer/native/libraryCore.ts` over an injectable `FsApi` (first-party code; one implementation
  of the library.json semantics), `libraryNative.ts` wires it to `terminatorFs` and installs the `window.terminator.
  library*` surface + the Preferences FOLDERS root methods (point/move/reset/reveal) + `libraryFileUrl`. The shell
  grew generic fs verbs (`stat`/`move`/`copy`/`writeBinary`/`openPath`/`serveRoots`) and serves library files at
  `/lib/b64/<path>` (path-checked against the roots the page registered; `<audio>` preview + `fetch` both work).
  Finder drops (no paths in a WebView) come in as bytes (`importFiles` → Imports/ or the USER SAMPLES folder).
  Not native yet: YouTube import (the job reports an error phase); "import R2 as a real copy" keeps a reference.
- **Gate evidence:** `ui/scripts/test-library.mts` **39/39** (the Electron harness's cases + importFiles, USER
  SAMPLES on-disk ops, resolveReadable safety, moveLibrary) in `npm run gate`; probe on Victor's REAL library (698
  nodes incl. a linked Ableton folder): tree loaded, a recording (338,924 B) served byte-complete at its URL,
  `audioCanPlay: true` with `TERMINATOR_PROBE_AUDIO=1`, `/etc/hosts` refused. Build 0 warnings, clang-format clean.
- **Gotcha found + fixed — JUCE `emitEvent` is quadratic:** it escapes every C++→JS payload with `String::replace`
  → a 230 KB `readText` reply froze the message thread for minutes (caught by `sample` on the hung probe). Large
  replies (> 24 KB JSON) are now stashed and fetched through `/blob/<token>` (`ShellServices::maybeLarge`,
  transparent in `juceBridge.ts`). This also protects opening big `.tproj` files. Rule: never answer > ~24 KB
  through `complete()`/`emitEvent` — stash it.
- **Victor's pass:** open the sample browser in the native app — RECORDINGS / YOUTUBE / IMPORTS / USER SAMPLES +
  your folders + the linked Ableton folder should match the Electron app; preview a library file; LOAD one (main
  track and onto a pad); drag a WAV from Finder onto IMPORTS or a USER SAMPLES folder; new folder / rename /
  move / copy / duplicate / delete (Trash); Preferences → FOLDERS → the library root. YouTube import says it is not
  native yet.

### 2.5c — YOUTUBE IMPORT is native (DONE, 2026-08-22 fourth session)
Links and playlists pull through the BUNDLED yt-dlp, into the library's YouTube folder — the Electron behaviour.
- **The runtime question, answered:** yt-dlp ≥ 2025.11 solves YouTube's JS challenge through an external JS
  runtime (deno / node / quickjs / bun); Electron used itself as Node. The native app bundles **quickjs-ng v0.16.2
  `qjs` (1.3 MB, universal via lipo)** — verified: `[debug] JS runtimes: quickjs-ng-0.16.2`, challenge provider
  `quickjs`, itag 140 m4a extracted. No Node/Deno/Python/ffmpeg to install.
- **Provisioning:** `cmake/ProvisionTools.cmake` (target `TerminatorBundleTools`, ALL) downloads the pinned yt-dlp
  nightly `2026.08.16.020253` (the Electron pin — ONEDIR; the mac `_internal/Python.framework` stripped like the
  Electron script) + qjs, SHA-256 verified, cached in `third_party/.tools-cache`, into `Resources/bin` (mac) /
  `<exe>/bin` (win). ~82 MB of yt-dlp in the bundle (the Electron DMG carries the same). `-DTERMINATOR_BUNDLE_TOOLS=OFF`
  for offline/engine-only builds.
- **Bridge:** `terminatorProcess` (`app/src/ProcessHub.*`) — spawn/kill/list/tools; only the bundled tools run;
  `--no-update --js-runtimes quickjs:<dir>` prepended by the shell; merged output streamed in ≤ 8 KB events from a
  reader thread; exit events. Page: `processBridge.ts` + `youtubeNative.ts` (youtubeDownloader.ts ported) +
  the job runner and `downloadYouTube` (pullYouTube) in `libraryNative.ts`.
- **Gate evidence:** probe: `ytdlpBundled`, `qjsBundled`, `--version` through the bridge = `2026.08.16.020253`;
  with `TERMINATOR_PROBE_NET=1` (CI mac job has it) a REAL pull of "Me at the zoo" (19 s) into a temp root:
  **309,157 B m4a in 2.1 s**, named by title, then trashed. Build 0 warnings, clang-format clean, ui gate green.
- **CI fix:** the Windows job's library test failed on separators (the harness passed `sep: '/'`; Windows paths
  are backslash) — the test now uses the platform separator like the app does and compares via the core's `norm`.
- **Victor's pass:** sample browser → YOUTUBE row "+ link" → paste a video link → it lands in YOUTUBE named by
  title; a playlist link → a folder under YOUTUBE filling up (3 at a time, cancel works); LOAD LINK / GET SAMPLE
  in the LOAD section → the song pulls into YOUTUBE and loads. Known: the first launch after a fresh install pays
  macOS's one-time code-signature validation of yt-dlp's ~100 dylibs (seconds), then 0.3 s per pull.

### 2.5d — ASSET STORE + `.tprojz` BUNDLES are native (DONE, 2026-08-22 fourth session)
Projects that carry their own samples (`asset:<sha1>` ids, `.tprojz` bundles, TRANSFER payloads) load and save
natively. `ui/src/renderer/native/assetsNative.ts`: `assetPut/assetGet/assetHas` on `<dataDir>/assets/<hash>.<ext>`
+ `<hash>.json` (the Electron layout, verbatim), **with a read fallback into the Electron app's asset store on
the same machine** (macOS `~/Library/Application Support/terminator/terminator-presets/assets`, Windows
`%APPDATA%/terminator/terminator-presets/assets`) — so Terminator 2.x projects open with their samples without
copying hundreds of MB (the full settings/presets import stays Phase 8). Bundles: `readProjectFile` returns
`.tprojz` bytes (`terminatorFs readBinary` → a one-shot `/blob/<token>` the page fetches), `saveProjectBundle`
writes them (chunked `writeBinary`), `saveProjectFile` trashes a stale bundle twin like Electron.
- **Gate evidence:** probe: put → has → get (70,000 B byte-identical through /blob/) → removed; the Electron
  fallback store found with 43 assets on this Mac. ui gate green, build 0 warnings, clang-format clean.
- **Victor's pass:** OPEN… → pick one of your Terminator 2.x projects (they live in `~/Library/Application
  Support/terminator/terminator-presets/` — or Preferences → FOLDERS → point the projects folder there so the OPEN
  list shows them) → the pads' own samples (assets) come back; SAVE AS a `.tprojz` and re-open it; TRANSFER TO
  DEVICE still uses the browser-shim session store (the relay is fine).

### 2.5e — MIDI from a controller reaches the page too (DONE, 2026-08-22 fourth session)
The direct path stays (MidiHub → lock-free queue → audio thread, sub-ms): that is the sound. New: `MidiHub.onNote`
mirrors every note on/off to the message thread → `terminator.midiNote` → the shadow runs the same hit through the
TS engine as `triggerPad(pad, vel, …, { nativeOwned: true })` (the one-line `nativeOwned` flag threaded to
`voiceSink.start`) — so the pad LEDs, the waveform playhead, the TS choke bookkeeping and STEP/LIVE recording all
work from a controller, and the shadow does NOT trigger the pad a second time. Note → pad = the engine's default
map (note − 36); the page's learned MIDI pad map is not honoured natively yet (Phase 3 MIDI). Known: a LIVE-record
"quantize what I hear" early hit sounds immediately natively (the direct path can't delay) while the note is still
written on the line. Probe: `terminatorMidi inject` note 98 → engine hit pad 62 directly (`lastTriggeredPad 62`),
the page mirrored it (`midiMirrored`), no double trigger. ctest 115/115 after the MidiHub change.

### 2.5 / 2.6 — PARTIAL / NOT STARTED
2.5: ChopperView boots natively with the real UI, Preferences native, **the pads sound through the native engine
(2.5a)**, **the sample library is native (2.5b)**, **YouTube import is native (2.5c)**, **the asset store +
bundles are native (2.5d)**. Missing: RECORD SAMPLE
(the page's recorder saves through `librarySaveRecording` — native capture is Phase 5), the sequencer/drums/bass
through the engine (Phase 3), library/YouTube loads by PATH (no PCM upload). 2.6: the CI artifact
(`Terminator-mac-universal-unsigned.zip`) is an unsigned universal .app with the UI bundled; "the chopper's pads
work natively" is now true, "the chopper works natively" (sequencer, mixer) is not yet — not claimed.

### Victor's pass — THE PADS ARE NATIVE NOW (2.5a, 2026-08-22)
Open the app (CI artifact for the shadow commit or a local build): get a sample in the way you do in the web
build — a local WAV/MP3/M4A as the main track, or onto a pad (YouTube pulls and `.tprojz` bundles are not native
yet). Then: hit the pad from the mouse / keys / your controller — **the sound is the C++ engine now** (set AUDIO to the
Model 16 at 64/48k first in Preferences): judge the latency feel; try PITCH ±, the source PITCH/FINE knob, ATTACK,
RELEASE (master), NOTE ON (gate) + release, LOOP with fades (the native crossfade render), REV, a mute GROUP,
NORM on a source. **What will sound different/missing and is KNOWN:** the chop SEQUENCER plays through the old
Web Audio path (so SEQ vs a live hit can differ in level — the native pad goes dry to outs 1/2, bypassing the
mixer strip/FX), STRETCH is dry, stem toggles on a ringing pad apply on the next hit. Tell me: the feel, and anything that sounds
wrong that is NOT on this list.

### Victor's pass (possible NOW in the real app — Phase 0/1 items)
Open `Terminator.app` (CI artifact or `build/mac-release-universal/app/Terminator_artefacts/Release/`): accept the
EULA once → ChopperView. Click **Preferences** (the gear) → **AUDIO** is the native device page: Driver CoreAudio,
Model 16 in + out, 48 kHz, buffer 64 → **Apply**; Input/Output Config list all 16/14 → **Enable all** → Apply;
**Test tone ON** on pair 3/4 (and 5/6, 7/8); cable out 1 → in 1, Measure out 0 → in 0 → the round trip in samples/ms
(tell me the number). **MIDI** tab: your controller appears under native inputs with the lag meter. Caveat: the PADS
in ChopperView still play through Web Audio in the WebView — do not judge latency feel yet.

### Next session (in order)
1. **EngineClient — audio through the native engine**: sample loading by PATH (`terminatorPads loadFile` exists;
   library/yt/recordings are files) → SampleStore; pads/chops regions + params mirrored to `setPadSample`/
   `setPadParams`/`setPadLoopBuffer`/`setPadStems`; pad hits → `triggerPad`; waveform peaks via resource URLs
   (`analysis/WaveformPeaks`); the TS engine's voices muted. Start as a shadow of the TS state, move ownership to
   the C++ Document section by section.
2. Library read-only (`~/Music/Terminator/library.json` served via the resource provider), yt-dlp child process,
   RECORD minimal. 3. Engine-tail leftovers (stretch, streaming + RSS gate, analysis thread). 4. 2.6 naming/
   versions, then Phase 3.

## CI — GREEN on all 4 jobs for the third-session tip (run 32599001143, `be94482`)
mac universal ✅ (ui gate + probe: ChopperView + Preferences window) · mac Intel ✅ · mac RTSan ✅ · Windows/MSVC ✅
(ui gate + the merged engine tail compiled and tested under MSVC).

## Phase 2 — where it stands (2026-08-22, fourth session)
DONE: the engine/model/render core + the engine tail (115 Catch2 cases + 5 CLI gates, RTSan 116); the real React
UI boots in the native shell with a native host (`window.terminator`) and a native Preferences window; **the pads
sound through the native engine (2.5a EngineClient shadow, probe-proven)**.
NOT DONE: library/yt-dlp/RECORD (2.5), the sequencer/drums/bass/mixer through the engine (Phases 3/4), stretch,
streaming + RSS gate, analysis thread, peaks via resource URLs, packaged build #1 claim (2.6).

### Next session (in order) — updated at the end of the fourth session
0. `gh run list` — confirm CI green for tip `9c37f7c` (mac-universal: probe incl. the real YouTube pull; Windows:
   ProvisionTools on Windows + MSVC compile of ProcessHub/readBinary + the library test with backslash paths).
0b. Victor's passes (pads native / library / YouTube / projects with assets / controller) — see each section.
0c. **Phase 3** per the DESIGN below — 3.1 (C++ ChopSequencer + bridge) and **3.2 (the page binding) are DONE**
    (fifth session); next = **3.3 DrumSequencer native** (96-step EventSource + drum voices on the Sampler, pads
    64..127 or a second bank), then 3.4 bass, 3.5 MIDI clock, 3.6 metronome/count-in, 3.7 live-record landing.
(The older list follows for reference.)
1. `gh run list` — confirm CI is green for the 2.5a commits (mac-universal probe asserts the shadow; Windows/MSVC
   compiles SampleRegistry + the gate flag). Then Victor's pad pass above (his latency verdict decides how much
   of Phase 3 goes first).
2. 2.5 tail: library/YouTube loads by PATH (`terminatorSamples loadFile` + the pad source keyed by path) so pulls
   never upload PCM; RECORD minimal; the R2 pull → library copy.
3. Ownership moves native: peaks via resource URLs; pad sources by PATH; chop seq on the native transport
   (Phase 3 start); LEDs/playhead from `activePads`/`lastTriggeredPadPositionSec`.
4. **Phase 4 is now specced to Victor's brief** (TERMINATOR-NATIVE-PLAN.md B4 "VICTOR'S PHASE-4 BRIEF" + decision
   #7): premium JUCE effects + accurate summing + free routing — read it before the mixer sessions.

## CI — GREEN on all 4 jobs for `cc41547` (run 32603121764, 2026-08-22): 2.5a–e + the fadeOut tail + the Phase 3
design — mac universal (probe incl. the real YouTube pull) ✅ · mac Intel ✅ · mac RTSan ✅ · Windows/MSVC ✅ (ProvisionTools
on Windows, ProcessHub/readBinary under MSVC, the library test with backslash paths).

## CI — GREEN on all 4 jobs for `9bb84bb` (run 32604238687): Phase 3.1 included (ChopSequencer under MSVC + RTSan, the
mac probe runs the native sequencer + the real YouTube pull). End of the fourth session.

## Phase 3 — 3.1 DONE (the chop sequencer on the sample clock, headless + bridge), 2026-08-22 fourth session
`engine/include/terminator/core/ChopSequencer.h` + `src/core/ChopSequencer.cpp`: the chop step sequencer as a native
EventSource inside the Engine — the audio callback asks it every block for the hits in [blockStart, blockEnd) and
fires them at exact sample offsets (no look-ahead, no timers). Semantics = ChopperEngine's playSeq/
seqSchedulerTick/scheduleSeqStepAudio on samples: stepDur = 60/bpm·4/res re-read per step (BPM applies at the
next step), **swing applied LIVE** (= the export formula — the documented live-vs-export mismatch resolved as
Victor decided), a queued pattern adopts at the next step 0, a live edit applies to the steps ahead, note length =
until the next hit of the same TAIL group (choke group ≥ 0, else the pad itself — a poly pad still ends at its own
next hit) with the 3 ms fade ending AT that hit (its own swing counted), else the pattern end; pause fades the
sequencer's notes and keeps the unfired hits (shifted on resume); loop off stops after the last slot. Patterns are
plain structs (`SeqPattern`: grid bit masks + per-cell velocity, ~400 KB) handed to the engine by pointer; the
shell keeps a ring of 8. Bridge: `setSequence`/`queueSequence`/`seqPlay`/`seqStop`/`seqPause`/`seqResume`/`setBpm`/
`seqLoop`; the snapshot carries `seqPlaying/seqPaused/seqLoop/seqStep/seqStepCount/seqPatternIndex/seqStepPhase/
seqBpm/seqLoopStartSample/seqHitsFired`.
- **Gates (Catch2 `[seq]`, tolerance 0 samples):** grid onsets exact + loop exact; same-group note ends at the next
  hit (fade ended AT it), poly pads end at their own re-hit (one voice); swing: odd 16th late by exactly
  `seqSwingOffsetSec`, even 16ths on the grid; queued switch at step 0 + live edit ahead; BPM change at the next
  step; loop off stops; **block-size invariant 64 vs 512 (max diff < 1e-6 over 5 s)** — this test caught a real bug
  (a per-pad "next end" slot overwrote an earlier end when the end and the next hit of a pad fell in one block →
  hits and ends now share one time-ordered ring); pause/resume phase; **10 minutes at 120 BPM/16ths: 4800 hits,
  loop starts exactly on multiples of 96000**. ctest **122/122**, RTSan **123/123**, ui gate green; the probe runs
  a 16-step pattern at 240 BPM through the bridge (`seqAdvances`, `seqStopped`).
- 3.2 (below) bound the page to it.

## Phase 3 — 3.2 DONE (the page's chop sequencer IS the native one), 2026-08-22 fifth session
**What changed:** `ChopperEngine.seqSink` (ui) — when set (the shadow sets it), PLAY/STOP/PAUSE/RESUME go to the C++
ChopSequencer (`seqPlay{atSample}`/`seqStop`/`seqPause`/`seqResume`), the TS look-ahead scheduler does NOT run (no
Web Audio sequencer voices at all — not even muted ones), and the native position comes back at 20 Hz
(`nativeSeqUpdate`) into the SAME fields every TS consumer already reads (`seqCurrentLoopStart`, `seqStepDuration`,
`playingSeqIdx`, `seqPausedElapsed`) — so the Timeline cursor (`getSeqCursorStep/Phase`), the live-record landing,
the metronome and the queued-switch bookkeeping work unchanged; a non-loop run ends when the engine stops itself.
The shadow (`nativeEngineShadow.ts`) diffs the audible pattern / a queued switch (`queueSequence`, `{cancel}` when
the playing tab is re-selected) / BPM / swing from the engine state (`setSequence` is de-duplicated by bytes; JS→C++
is not quadratic, whole patterns are fine), serialises everything through one promise chain, and sends PLAY with
`atSample` = the page's anchor as an ENGINE SAMPLE.
- **`NativeClock`** (`ui/src/renderer/native/nativeClock.ts`, pure math, gate `npm run test:clock` = 23 cases):
  engine samples ↔ host ns (the snapshot's last-block anchor `clockHostNs/clockSample`, new) ↔ `performance.now()`
  (round-trip calibration through the new `terminatorAudio {verb:'clock'}`, best RTT wins; every snapshot's
  `emitHostNs` is a one-way upper bound that only tightens) ↔ AudioContext time (`ctxPair`: the context's heard-pair —
  **WebKit's `getOutputTimestamp()` carries NO latency** (measured: contextTime == currentTime while `outputLatency`
  = 16 ms), so the pair is built from `currentTime` + `outputLatency`), **at the ear** (the native device's
  `outputLatencyMs` from the `clock` verb is added on the native side). WebKit's `performance.now()` is 1 ms coarse
  → the mapping is ≈ 1 ms; RTT reads exactly 1.
- **Lead:** PLAY's anchor lead in native mode = native output latency + 1.5 blocks + 4 ms − the ctx latency the
  pair knows, never under the TS 20 ms (`seqSink.leadSec`) — the engine must RENDER the anchor's sample before it is
  heard; on this Mac it lands on the 20 ms floor (18 ms native out-latency, 16 ms ctx latency). The satellites
  (drums/bass/MIDI clock) take the same anchor, so nothing starts out of phase.
- **The two-clock bridge (drums/bass/metronome stay Web Audio until 3.3/3.4/3.6):** the shadow measures, every
  snapshot, where the native grid is HEARD in ctx time vs where the ctx-clocked satellites expect it (`driftMs` in
  the shadow stats), low-passes it (the 1 ms clock) and nudges `drumEngine.nudge(d)` / `bassEngine.nudge(d)` /
  `MidiClockSender.nudge(d)` / the metronome's next click by the residual when it exceeds 2 ms — **phase-preserving
  (no restart; already-booked hits keep their times, the next bookings land on the corrected grid)**, not the design's
  "re-anchor start() every loop" (which would reset a 4-bar drum pattern against a 2-bar chop loop). Musical drift
  (0.6–3 ms/min) means a nudge every minute or so. `setTransportHooks(onStart, onStop, onNudge)`.
- **Quantized live hits are sample-exact:** `triggerPadAt(lineT)` → the shadow maps `lineT` to an engine sample →
  `triggerPad{atSample}`; the Engine fires it at its offset when inside the block, else BOOKS it (a 64-slot RT ring,
  `Engine::bookTrigger` / `firePendingTriggers`; `releasePad{atSample}` the same) — no timer jitter any more (the
  old path was `setTimeout` → `triggerPad`).
- **One owner per hit, in RT code:** every live trigger (command / MIDI) stamps `Engine::liveHitSample_[pad]`; the
  ChopSequencer skips a pattern hit (at FIRE time, so a hit booked a few ms past the grid counts too) whose pad was
  live-triggered within 120 ms (`kLiveOwnerWindowSec` = the TS `lastLivePadHit` window); `seqHitsSkipped` in the
  snapshot. The page's `booked = wasOn` in native mode (the engine fires the pattern's copy itself).
  `queuePattern(nullptr)` = cancel (was: would clear the pattern).
- **Gates:** Catch2 `[seq]` +3 cases (one-owner before/after/far/other-pad at 0-sample tolerance; queue cancel +
  control; a trigger booked 1 s ahead fires sample-exact, a booked release ends a gate pad there): ctest
  **125/125**, RTSan **126/126**; ui gate = tsc baseline 5 + library 39 + **clock 23** + vite build; the probe
  (`selfTest` part 3, asserted by `probe-app.sh` → `seqPageOk`): a 1-bar/16-step pattern hitting pad 62 every 4th
  step at 240 BPM, **`engine.playSeq()` → native `seqPlaying` with the page's pattern index, 4 hits in 800 ms, the
  TS cursor == the native step at two instants (7/7, 12/12), `engine.stopSeq()` stops it natively**; measured
  start offset native-vs-satellites **1.1 ms, 0 nudges** (it was 9.2 ms before the lead + the WebKit latency fix); the probe's
  async budget grew (kProbeDelayTicksReact 11 s / lead 7 s) because the self-test runs ~4 s now.
- **Honest boundary after 3.2:** what you hear = live pads + the chop sequencer natively (dry, outs 1/2); drums +
  bass + metronome + count-in clicks through the WebView's AudioContext (system default output), phase-locked by the
  nudge — their ear-alignment is as good as the clock mapping (≈ 1 ms) + the two devices' latency reports (JUCE's
  `getOutputLatencyInSamples`, WebKit's `outputLatency`). When the clock is not calibrated yet (the first ~100 ms
  after attach) PLAY sends `atSample 0` (next block) and the drift nudge pulls the satellites in. Pause/resume: the
  engine pauses/resumes at a block boundary; the page's frozen phase is refined from the snapshot
  (`seqStep + seqStepPhase`). Live-record landing + count-in stay in the page (3.7). A 4-bar/192-res pattern is
  ~0.3 MB of JSON per `setSequence` — fine through the JS→C++ direction.
- **Victor's pass (3.2):** a chop pattern + the drum machine at 90 BPM for 10 minutes against a DAW click — no
  drift between chops and drums (a ≤ 2 ms step is expected every minute or two, not a creep); pattern switch at the
  loop boundary (tab click while playing; click the playing tab again = cancel); pause/resume; BPM change mid-loop
  (applies at the next step in both); live-record a hit onto a playing pattern — it must sound ONCE, the next loop
  plays it from the grid; PLAY must still feel instant.

## CI for the 3.2 tip `97ef977` (run 32608087978, 2026-08-23): Intel ✅ · RTSan ✅ · Windows/MSVC ✅ · **universal ❌ — the
probe only**: `seqPageCursorTracks` false (TS cursor 7/12 vs native step 5/11 at 240 BPM, drift 21.6 ms after 1 s, one
nudge). Root cause: the runner has no real audio device — the WebView's AudioContext clock runs FAST on the virtual
output (`ctxOutputLatency` 0), and the 3.2 cursor read `ctx.currentTime − loopStartCtx`. Not an engine bug (mac-universal
tests + the native sequencer assertions were green; locally 7/7 12/12 at 1.1 ms). **Fixed in 3.3 (sixth session): the
page cursors (chop + drums) read the ENGINE's position at the ear through NativeClock + `performance.now()`
(`ChopperEngine.nativeCursorHook` / `DrumSink.elapsedSec`) — the AudioContext clock no longer decides what the
playhead shows.** The YouTube pull on the runner hit YouTube's "sign in to confirm you're not a bot" (a warning, not a
failure — the runner's IP; locally the pull succeeds).

## CI for the 3.3 tip `1b2d16f` (run 32610426116): Intel ✅ · RTSan ✅ · Windows/MSVC ✅ · universal ❌ — the probe's
`seqPageCursorTracks` again, and the numbers named the real cause. The TS cursor read **7 on the runner and 7 locally**
(the engine-clock fix works); what differed was **`nat` — the snapshot's `seqStep` — which lagged 2 steps on the runner**.
`seqStep` is the position at the moment the 20 Hz snapshot was EMITTED; on a starved runner the page's newest snapshot is
> 100 ms old (2 steps at 240 BPM), and it is the RENDERED position while the cursor is the HEARD one. The assertion was
comparing a live cursor against a stale field with a hard ±1. **Fixed by deriving the tolerance instead of guessing it**:
the shadow now measures how old the newest snapshot's position is (`stats.snapshotAgeMs`, from the snapshot's own
`emitHostNs` through NativeClock) and `cursorToleranceSteps(stepDur) = ceil((age + outputLatency) / stepDur) + 1`; both
self-tests use it and REPORT `{age1, age2, tol1, tol2}` so a future failure is diagnosable rather than re-guessed.
Measured locally: age 4–42 ms → tol 2 (chop) / 4–7 (drums, 1/96 steps at 240 BPM = 10.4 ms), diffs 0–2. Nothing in the
engine changed — the sample-exactness guarantees live in the 137 Catch2 cases; this is a test-harness correction.

## Phase 3 — 3.3 DONE (THE DRUM MACHINE IS NATIVE), 2026-08-23 sixth session
**What changed (engine):** `core/DrumSequencer.h/.cpp` — the drum step sequencer as a native EventSource on the same
sample clock as the chop sequencer (semantics = `drums/DrumEngine.ts` scheduleAhead/scheduleStep/emitVoice, dossier
§2): 96 internal steps/bar (the UI's views are lenses), stepDur 60/bpm×4/96 re-read per step, the pattern ALWAYS loops;
per hit = lane volume × step VELOCITY × drum master; SWING on the step's 16th slot (the shared formula); SHIFT (ms ±50)
snapped to the PPQ pulse (JS rounding) — it may be NEGATIVE, so steps are scheduled **110 ms ahead** of the block
(a −50 ms hit snapped to a < 100 ms pulse can land ~100 ms early) and fire sample-exact; PAN per hit; REPEAT = a roll
of sub-hits from the swung+shifted hit until the step's STRAIGHT slot end, each fading (4 ms) INTO the next, sub-hits
cut nothing and are cut by nothing but their own end (TS: they bypass the lane registry); arranged pattern SWAPS
(`scheduleDrumPattern {atSample}`, the TS `patternFor(when + stepDur/2)` tolerance) + `drumPlay {atSample, stepOffset}`
(the arranger's seek); one owner per hit (a lane live-triggered within 120 ms owns the pattern's copy, `drumHitsSkipped`).
**Drum lanes = Sampler pads 64..127** (`kMaxPads` 64 → 128; `kChopPads`/`kDrumPadBase`/`kDrumLanes`; MIDI's default
note map still covers 0..63): the page's DECODED buffers (already ceilPeak'd + declicked by the DrumEngine at decode)
are uploaded + bound like any pad; Sampler additions — `PadParams::pan` + per-hit pan (`triggerEx`: the Web Audio
StereoPanner law as a 2×2 matrix resolved at trigger: mono equal-power cos/sin, stereo side-mix; **exactly 0 = no
panner = unity on both**, as the TS only inserts the node when ≠ 0), `PadParams::chokeFadeSec` (pads 3 ms, drum lanes
4 ms = DRUM_CHOKE_S; the retrigger / mute-group / stopPad fade), `Voice::subHit` + `stopSubHitsAt`, `stopPadRange`,
`drumActiveMask`; the mute-group choke now follows the documented time-order rule: **a group mate starting at the SAME
sample layers** (`muteGroups.ts` "strictly later cuts" — the TS LIVE path cut it; live now matches the export rule).
Found + fixed while porting: **a choke deferred to a block offset lost its fade length** (always 3 ms — the chop pads
never noticed, theirs IS 3 ms; the drums' 4 ms became 3 ms); a booked live hit now RE-STAMPS the one-owner window when
it fires (two bookings on one pad overwrote each other). Bridge: `setDrumPattern` / `scheduleDrumPattern` /
`clearDrumPatterns` / `setDrumGraphs` / `setDrumLane` / `setDrumParams` / `drumPlay` / `drumStop`, `triggerPad{pan}`,
`setPadParams{pan, chokeFade}`, snapshot `drumPlaying/drumStep/drumStepCount/drumStepPhase/drumLoopStartSample
(signed)/drumHitsFired/drumHitsSkipped/drumActiveMask`, `activePads` to 127, info `chopPads/drumPadBase/drumLanes`.
- **Gates:** Catch2 `[drums]` 12 cases / 424 assertions at 0-sample tolerance — grid + loop + snapshot + stop; swing
  (odd 16ths + the 32nds inside them, even 16ths never move); SHIFT at 960/24 PPQ incl. negative (fired 50 ms BEFORE the
  grid) and the first-step clamp (= the PLAY block, never the past); level = volume × VELOCITY × master, muted / zero
  lanes skip; PAN mono + stereo laws (+ unity at 0); REPEAT rolls (4 sub-hits, each 4 ms fade ending AT the next, the
  last at the slot end; a rate ≥ the slot = one normal hit; a ringing live voice is NOT cut by a roll); mute groups by
  time order + same-instant layer + ungrouped lanes ring; one owner; swaps at the bar (1-sample-early tolerance) +
  clearScheduled + play with stepOffset; BPM change at the next scheduled step; **block-size invariance 64 vs 512
  (swing + SHIFT + roll + groups, < 1e-6) with zero allocations**; **10 minutes at 120 BPM: 300 passes, every loop start
  exactly k×96000**. ctest **137/137**, RTSan **138/138**; ui gate (tsc baseline 5, library 39, clock 23, vite);
  **the probe** (part 4, asserted by probe-app.sh `drumPageOk`): a synthetic buffer PRIMED into the kick lane →
  the REAL path (onBufferReady → syncLane → upload → setPadSample 64) → a 1-bar pattern (4 hits) at 240 BPM →
  `drumEngine.start()` → native `drumPlaying`, 96 steps, 4 hits in 900 ms, `getStep()` tracks the native step
  (54/51, 82/82 — the snapshot is ≤ 50 ms old, the playhead is "now at the ear"), `stop()` lands natively; and the
  3.2 cursor check now 7/7 12/12 at 0.15 ms drift. The probe's async budget grew to 10 s / 14 s.
- **The page binding (ui):** `DrumEngine.drumSink` (PLAY/STOP/hit/swaps/`elapsedSec`/`leadSec`) — when set the TS books
  NO Web Audio drum voices (scheduleAhead skips, playHit forwards), `nudge` is a no-op (the drums share the engine's
  clock — **the two-clock nudge now only serves bass + MIDI clock + metronome**), `getStep()` reads the engine's
  position at the ear, the live-record `booked = wasOn` rule (the engine fires the copy), `nativeDrumUpdate` keeps the
  ctx-time grid origin for the landing; `cachedBufferFor/ensureLoaded/onBufferReady/primeBuffer` for the shadow.
  `native/nativeDrumShadow.ts`: lane SLOTS (track key → 0..63), buffers through the pad shadow's refcounted uploads,
  attack = the TS head rule (0 if the first ms < 0.02 else 3 ms), group → chokeGroup 1000+g, volume/mute+solo/group →
  `setDrumLane`; pattern (reference-diffed), graphs (reference-diffed), params (value-diffed) per state emit; PLAY →
  `drumPlay` at the page's anchor as an engine sample; hand hits → `triggerPad {pad 64+L, velocity, pan, atSample?}`.
  `attachNativeEngineShadow(engine, drumEngine)` from ChopperView + HardwareView.
- **Honest boundary after 3.3:** what you hear natively = live pads + chop sequencer + THE DRUM MACHINE (dry, outs
  1/2 — lane → mixer strip routing is Phase 4, so the drum lanes bypass the mixer/FX/master chain like the pads); still
  Web Audio on the page's AudioContext: bass (3.4), metronome + count-in clicks (3.6), the drum browser's audition of a
  sample NOT on a lane (`playPreviewBuffer`), the ARP. A graph / swing DRAG applies natively at pointer-up (the TS Live
  setters mutate without an emit; the TS scheduler read them live). Pause/resume do not touch the drums — the TS never
  paused them either (`pauseSeq` does not call the stop hook; resume re-anchors only the chops → after a pause the two
  are out of phase by the pause length — a latent TS behaviour, kept).
- **Latent TS findings (flag, not fixed in the Electron app):** (1) **REPEAT rolls are dead since the 1/96 storage
  change (2026-08-19)**: the roll is bounded by ONE internal step (= 1/24 beat) and the fastest rate (1/64T) IS one
  step → `times.length < 2` → a single hit, always; before that (1/32 storage) only 1/32T·1/64·1/64T rolled; the Drum
  Dojo intent (16 steps) was a roll filling the 1/16 slot. The native port keeps the machinery (`stepsPerBar` is a
  pattern field; the tests roll at 8/bar) — the fix is to bound the roll by the VIEW column (stride × stepDur) or the
  lane's next lit step, in both apps. (2) Live mute-group same-instant hits cut (4 ms blip) while the export rule
  layers — native follows the export rule. (3) Pause leaves the drums running (above).
- **Victor's pass (3.3):** PLAY with a chop pattern + the drum machine at 90 BPM for 10 minutes against a DAW click —
  drums and chops on ONE clock now (no nudges needed: `seqNudges` should stay 0 in the shadow stats); hats in a mute
  group (closed/open) — the open hat stops when the closed lands, both on one step = both sound; SWING knob → both
  sequencers swing together; a SHIFT'd step (±) and a PAN'd step; a VELOCITY ramp; mute/solo lanes; drum ▶ alone
  (no chops) from the DRUMS section; live-record drum hits with REC on (each sounds ONCE, the next loop plays it from
  the grid); STOP cuts every lane (4 ms); the drum browser preview (tap a lane header = native; audition of an
  unloaded sample = still Web Audio, the system default device). Known: lanes bypass the mixer strips/FX (Phase 4).

## Phase 3 — 3.4 DONE (THE BASS IS NATIVE), 2026-08-23 seventh session
**What changed (engine):** `core/BassSynth.h/.cpp` — the `bass-synth` AudioWorklet ported 1:1 (dossier §2.1: the same
equations and constants — PolyBLEP oscillators incl. SHAPE morph, leaky-integrator tri/shark, per-osc drift walk +
per-voice cent offsets, the mixer's Padé-tanh overdrive, LADDER (D'Angelo–Välimäki, 2× OS) / OTA (TPT SVF ×2) / DIODE
(Zavalishin/Pirkle) with the same drive/level laws, RC-shaped ADSRs (attack toward 1.25, decay/release ×0.6), exp glide,
FL-style SLIDE ramps, the legacy LFO, the MOD matrix (3 LFOs + 2 trigger envs, log/linear tapers by knob path, chained
mods on one target), post DRIVE/TONE/GLUE/VOL, DC blocker, safety clip, the 1/30 s meter; mono last-note priority with
the held stack + legato + Model D fallback, poly reuse/free/steal-oldest). **Timing:** events (note on/off, slide, timed
bend) live in a 512-slot RT ring at absolute ENGINE SAMPLES and fire inside render() at their exact sample (an
`earliest_` cache skips the scan); the synth **renders in fixed 128-sample QUANTA aligned to sample 0** (the worklet's
render quantum) so the per-block work (param smoothing τ 20/30 ms, mod LFO/trig advance, drift, envelope times) happens at
the same instants whatever the host block → **block-size invariant, bit-identical at 37/64/128/480/512** (gated) and the
same cadence as the worklet. Randomness = a seeded xorshift64* (osc start phases, voice offsets, drift targets, S&H,
noise — the TS test seeds Math.random the same way for the same reason). One deliberate match worth knowing: a voice that
starts mid-quantum runs on its ADSR's LAST set coefficients until the next quantum sets the patch's (the worklet's
constructor defaults for the very first note) — the cached-coefficient port primes those defaults at prepare().
`core/BassSequencer.h/.cpp` — the piano roll's player on the sample clock (dossier §2.4/§2.6): PPQ-96 tick map (on =
round(start·96), off = round((start+dur)·96) ≥ on+1, an off past the loop fires at its wrap), tickDur 60/bpm/96 re-read
per tick, OFFS BEFORE ONS at a tick at the SAME sample (the TS live path added 0.2 ms to the ons; the TS EXPORT path —
the render reference — does not, and neither does this), SLIDE notes bend what sounds over `dur` beats, the BEND lane
sampled per tick posted when it moved > 0.002 st (`bassBendLane false` while the wheel records), live pattern replace
releases the sounding notes whose pitch changed / off vanished (the "+8va stuck note" rule) and the next ticks read the
new map, play(at, offsetTicks) / stop (release seq notes + bend 0), the arranger's absolute TIMELINE by pointer (sorted,
cursor-consumed, `arrangerDriven` mutes the pattern ticks; `clearTimeline` releases + unbends). Engine: `bass_` renders
DRY into outs 1/2 after the sampler (Phase 4 routes it to its strip); `seqSetBpm` drives all three sequencers; panic
stops + kills the bass. Bridge: `setBassPatch` (deep-merged over the defaults, mod targets by knob path → enum) /
`setBassPattern` / `setBassTimeline` / `clearBassTimeline` / `bassPlay` / `bassStop` / `bassArrangerDriven` /
`bassBendLane` / `bassNote` / `bassSlide` / `bassBend` / `bassMod` / `bassClear` / `bassPanic`; snapshot `bassPlaying /
bassArrangerDriven / bassTick / bassLoopTicks / bassLoopStartSample / bassVoices / bassLevel / bassNotes / bassNotesFired /
bassEventsDropped / bassTimelineFired / bassBend`; info `bassPpq / bassMaxBars / bassMaxVoices`. Command payload `bass`
(ptr/atSample/value/vel/offsetTicks/note/tag/flag) keeps `sizeof(Command) ≤ 64`.
- **Gates:** Catch2 `[bass]` 24 cases / 543 k assertions — the 12 Electron `bass-synth.test.mts` checks ported (default
  patch pitch ±3 % / envelope / release / attack; every filter model bounded at reso 0 and 1, brighter with cutoff,
  ladder+diode self-oscillate; every wave on the note with |DC| < 0.05; sub an octave down; mono legato glide mid/end/
  fallback + no level dip; poly louder + releases; a scheduled note silent before its sample — and the FIRST non-zero
  sample IS its sample; clear(tag) drops only that tag; MOD LFO moves brightness ≥ 4× the still spread, trig env opens
  then returns ±35 %; SHAPE morph endpoints = tri/saw/sine + monotone tri→saw; SLIDE mid/landed/original-off releases/
  alone silent; timed bends 0→+7 st land on time) + native-only: block-size invariance bit-exact, zero allocations while
  rendering 8 voices + mods, panic silences; the sequencer on the sample clock at 0 tolerance — note-ons exactly at
  0/24000/48000/72000/96000 (1-sample blocks), off-before-on retrigger, an off past the loop wrapping to the next pass,
  a BPM change at the NEXT tick (66000 exact), the BEND lane at its tick + the wheel + stop unbends, live replace releases
  36/43 and the next pass plays 48, the arranger timeline at 1000/9000 with the pattern quiet, live/booked/slide/panic,
  engine block invariance 64/480/512 bit-exact, **10 minutes at 120 BPM: 150 passes every loop start exactly
  k×192000, 1200 notes, 0 drops, 0 allocations**; RT case in test_rt_safety. ctest **162/162** (mac-debug), RTSan
  **163/163**, 0 warnings; ui gate (tsc baseline 5, library 39, clock 23, **bass-theory** (the Electron
  `bass-theory.test.mts` copied into `ui/scripts`), vite); **the probe** (part 5, asserted by probe-app.sh `bassPageOk`):
  a fresh 1-bar pattern with 4 notes → `bassEngine.start()` → native `bassPlaying`, 384 ticks, 5 notes fired, the synth
  SOUNDING through the engine (meter 0.44), `getPlayheadBeats()` tracks the native tick (261/262 · 4/2 within the
  derived tolerance 15/17 ticks — a 1/96 tick at 240 BPM is 2.6 ms), stop lands natively. Mid-sweep pitch reads in the
  ported tests use a global-argmax autocorrelation (`sweepHz`): the TS "first local max within 8 %" reader is fine on a
  steady tone but picked a spurious 361 Hz peak 50 ms into the 65→131 Hz glide with our (seeded, different) phases.
- **The page binding (ui):** `BassEngine.bassSink` (NEW interface; the ONLY BassEngine edits: `post()` routes every
  worklet message to the sink when attached, `start()` sends the audible pattern + `bassPlay` at the anchor with the
  engine's lead and keeps a dummy timer handle as "playing", `stop()` → `bassStop`, `nudge` is a no-op, `getPlayheadBeats`
  reads the sink's `elapsedSec`, `rebuildTickMap` while playing sends the pattern (the engine reconciles), `setRecording`
  re-sends with the lane flag, `setArrangerDriven` forwards, `nativeBassUpdate` keeps `startTime` = the loop start in ctx
  time (the live-record landing's `tickAt`) + the sounding notes, `nativeMeter`); `native/nativeBassShadow.ts` (the
  sink: messages → verbs with `at` → engine samples through NativeClock, `notes`/`bends` tagged `arr` gathered into ONE
  `setBassTimeline` per macrotask, the pattern signature-diffed (the TS mutates it in place) + `bassBendLane`, the patch
  reference-diffed on every state emit, PLAY at the anchor, the probe part 5); `attachNativeEngineShadow(engine, drums,
  bass)` from both views; shadow stats `bassCommands/bassEvents`.
- **Honest boundary after 3.4:** what you hear natively = live pads + chop seq + drums + THE BASS (all dry, outs 1/2 —
  mixer strips/FX/master are Phase 4); still Web Audio on the page's AudioContext: the metronome + count-in clicks (3.6),
  the ARP, the drum browser's audition of a sample not on a lane; **exports still render the bass through the TS worklet
  offline** (`renderBassOffline` — Phase 8 moves exports into the engine; the algorithms match, the seeded phases differ).
  The two-clock nudge now serves only the metronome + MIDI clock. Known: a bass MIDI note's `when` (the page's
  handler-lag compensation, usually ≤ now) lands "now" natively — the driver-timestamp path is 3.5.
- **Victor's pass (3.4):** PLAY a bass pattern with chops + drums at 90 BPM for 10 minutes against a DAW click — three
  sequencers on ONE clock; every factory patch (MODEL D … 808 SINE) vs the Electron app by ear (same algorithm; expect
  the same sound, the drift texture differs by seed); MONO legato + glide on a held line; POLY chords; a SLIDE note; draw
  a BEND lane then the wheel with ● REC; edit notes while playing (transpose ↑↓ — no stuck note); MPC pads as the bass
  keyboard (pad 4 = root with LOCK); the roll's playhead + dim sounding keys; the Beat Finisher preview drives the bass
  (the arranger timeline) and stop/seek re-schedules; STOP unbends. Known: dry to outs 1/2 (no mixer strip yet).

## Phase 3 — 3.5 DONE (MIDI CLOCK OUT/IN + THE ONE MIDI ROUTER), 2026-08-23 eighth session
**What changed (engine):** `core/MidiClock.h/.cpp` (JUCE-free) — `MidiClockOut`: the clock generated INSIDE the
callback from the transport (no look-ahead timer, no Worker pump): PLAY → Song Position 0 + START + the first tick AT
the anchor sample, then 24 ticks/quarter with the spacing re-read per tick from the session BPM (a tempo change lands
at the next tick — continuous, never a double/missing tick), pause → STOP (count + phase kept), resume → SPP (ticks/6)
+ CONTINUE from the kept phase, stop → STOP at its sample (no tick after), a restart = STOP then SPP 0 + START, the
preference off mid-run = STOP now; events carry their exact engine sample (128 per block max, a 16-slot FIFO for the
control bytes, ticks accumulate in double — tick n = anchor + n·spt within 1 sample over 10 minutes, block-size
invariant at 37/64/128/480/512). `MidiClockSourceLock` + `MidiClockFollower` = the Electron `midiClockIn.ts` ported
1:1 (constants, LSQ estimator, hysteresis, jump/drop-out rules, the one-port lock) on a fixed 48-slot window.
**Engine:** `Config.outputLatencySamples` (AudioIO fills it from the device); `clockOut_` follows `seqPlay` (the
anchor) / `drumPlay` (when nothing runs — drums alone clock the gear) / `seqPause` / `seqResume` / `seqStop` /
`drumStop` (nothing left) / `panic` / a self-stopping non-loop pattern; `seqSetBpm` feeds it; each block's events →
`MidiOutEvent{hostTimeNs = block entry + (offset + output latency)/sr, sample, bytes}` into `Engine::midiOut()` (a
1024-slot SPSC queue, audio → the pump). Commands `midiClockEnable{on}`, `setMidiRouting{pads}` (the direct
notes→pads path on/off: the page owns the notes in bass MIDI IN / DRUM PADS / MIDI OFF / learn); snapshot `midiClock*`
+ `midiNotesToPads` + `midiOutDropped`. **io/MidiHub:** OUTPUTS (list / `enableOutput` / `applyOutputPrefs` — the page's
`app.midi.outputs` map, missing = ON; hot-plug in `refresh()`), a `Priority::highest` PUMP thread that drains
`midiOut()` and sends every message at its stamp to every open output (`wait(1)` until ~1.5 ms before, yield-spin the
rest; a stamp in the past goes out at once → a late block bunches its ticks, the COUNT = song position stays true;
`sentCount` / `lastSendLatenessMs` / `maxSendLatenessMs`), CLOCK IN on the driver thread (ticks → the lock + follower
on the driver's `getTimeStamp()`; a settled BPM → `onClockBpm` via callAsync ≤ 1/beat; START/CONTINUE through the lock →
mirrored; STOP → lock cleared + mirrored; active sensing dropped), and `onNote` → `onMessage(MidiEvent, portName)` for
EVERY channel message (notes, CCs, bend, aftertouch, program) so the page gets them all; `inject(bytes)` for the probe.
**Shell:** `terminator.midiMessage {data, hostNs, port, portName}` + `terminator.midiClock {bpm, port}`;
`applyMidiSettings(app)` at boot + on every settings change (`app.midi.clock` → `midiClockEnable`, `app.midi.outputs` →
the hub); `terminatorMidi` verbs `enableOutput` (persists into `app.midi.outputs` through the settings service →
`settingsChanged` → every window) + `inject {data}`; reply `outputs[]` + `clock{…}`; snapshot `midiClock*`, `midiSent`,
`midiSendLateMs`, `midiClockIn*`.
**The page binding (ui):** the page now runs ONE MIDI router for Web MIDI and native alike — `midiHub.injectNative()`
dispatches a mirrored message to ChopperView's `onMessage` with the driver's stamp mapped to performance.now()
(NativeClock) and `nativeOwned: true`; the pad path passes `{ nativeOwned: true }` so the voice sink does not
re-trigger the pad the engine already played; transport START/CONTINUE/STOP from a controller, CC learn (both stores),
pitch bend → the bass, bass MIDI IN (+ the MPC/MPD fold by port name), DRUM PADS mode, tap/kill, pad LEARN all work
natively now (2.5e only mirrored notes → pads); `ChopperEngine.midiSink` (`routing` / `noteMap`) + `pushMidiRouting()`
(MIDI OFF / DRUM PADS / learn / bass MIDI IN → `setMidiRouting false`, back on → true) + the learned map → `setNoteMap`
(pads ≥ 64 unmapped natively — drum lanes); `terminator.midiClock` → `engine.setMetronomeBpm` only while the hardware
drives AND "follow tempo" is on (the page's policy, unchanged); `NativeMidiPane` lists the native OUTPUTS with toggles
+ the clock OUT/IN status; the Web MIDI device cards are hidden in the native shell. The TS `MidiClockSender`'s start/
stop/nudge still run on the page (they find no Web MIDI outputs in the WebView → silent; the native clock is the one
that sounds).
**Gates:** mac-debug 0 warnings; ctest = the 3.4 suite + 12 `[midiclock]` cases (the Electron midi-clock + midi-clock-in
gates ported to samples, block invariance, 10 min, pause/resume, the Engine wiring incl. host stamps at the ear, the
OUT→IN loopback reading 120 then 90 within 0.1) + an RT case (clock enabled, play, tempo change, pause/resume, stop —
0 allocations); ui gate (tsc baseline 5, library, clock, bass-theory, vite); the probe asserts `midiMirrored` (through
the new path), `midiNoDoubleTrigger`, `midiTransportOk` (an injected START byte starts the page's transport, STOP stops
it) and `midiClockOk` (the native clock runs / ticks / stops with it, `midiOutDropped` 0). **Evidence (eighth
session):** mac-debug 0 warnings + ctest 175/175 (162 + 13), RTSan 176/176, universal lipo `x86_64 arm64` on the app +
terminator-render + ctest 175, ui gate green, probe OK (`midiClockPosition` 41 at the STOP, `midiOutDropped` 0).
**CI for the pushed 3.4 tip `5d2f0cb` (run 32613089136) was RED on 3 of 4 jobs** — RTSan green; Intel = the runner
could not resolve github.com at checkout (infra); **Windows = 12 bass tests "No test cases matched"** — the 3.4 suites
had `—`/`→` in their `TEST_CASE` names (the MSVC ASCII rule from 3.1 again: catch_discover_tests passes the name on the
command line and the encoding mangles it) → every `TEST_CASE`/`SECTION` name in tests/engine is ASCII now (bass synth,
bass sequencer, drum sequencer, midi clock); universal = the probe's part-1 chop-seq check read the SAME stale snapshot
twice on a starved runner (step 3 at both reads; part 3 with its derived tolerance passed) → it polls now (≤ 3 s) until
the step moved and ≥ 8 hits fired.
**Honest boundary after 3.5:** the clock OUT's delivery accuracy = the pump's wake-up (≤ ~1 ms on a loaded machine;
ticks are stamped ≥ the device's output latency ahead, so they normally wait and go out within tens of µs) — measured
in the pane as "last send … ms late"; the TS "skip whole ticks after a 1 s stall" rule has no native equivalent (the
callback never stalls that long; a glitch bunches ≤ a block of ticks). NOT done from the 3.5 line: the **unified
MIDI-learn store** (both page stores work as before through the one router — the merge + import is Phase 8
persistence), **MIDI note OUT** per strip/bass/drums (Phase 4 routes strips first; the pump + `midiOut()` are ready for
it), the free-tier pad lock on the direct path (the native app is not tier-gated yet). Bass MIDI notes reach the bass
with the driver's stamp through the router's `when` (the handler-lag math) → `bassNote{atSample}` via the bass shadow.
**Victor's pass (3.5):** Preferences → MIDI: turn ON "MIDI Clock (send)", leave your interface's output on; set a drum
machine / DAW to external sync → PLAY in Terminator: it starts on the first tick and locks (compare the bar lines for
5 minutes at 90 BPM — no drift; change the BPM knob → the gear follows at the next tick); STOP stops it; pause/resume
(space) → the gear CONTINUES from the position. Clock IN: PLAY/STOP on the MPC start/stop Terminator (its START reaches
the page's router); with "follow tempo" ON the BPM readout follows the MPC within a beat (on one port only — the two-port
MPC reads the true tempo). Pads from the controller (direct path, sub-ms); bass MIDI IN (notes, pitch wheel); DRUM PADS
mode from the controller; CC LEARN on a knob; pad LEARN — all through the one router. The MIDI pane shows outputs, the
running clock's position and the last send's lateness.

## CI for the 3.5 tip `04eef9a` (run 32614333456, 2026-08-23): GREEN on all 4 jobs (Windows/MSVC · RTSan · Intel ·
universal) — the ASCII test names + the probe's poll closed the three reds of the 3.4 tip.

## Phase 3 — 3.6 DONE (METRONOME + COUNT-IN + ARP ON THE SAMPLE CLOCK), 2026-08-23 ninth session
**What changed (engine):** `core/Metronome.h/.cpp` (JUCE-free) — the five click sounds (click / hihat / rimshot /
kick / clap, accent) SYNTHESISED inside the callback at their exact sample: the Web Audio graphs ported per sample
(OscillatorNode sine from phase 0 with the kick's exponential frequency sweep, the gain automation's linear attack +
`v0·(v1/v0)^t` exponential decay held at the floor until the source's stop, BiquadFilterNode highpass (Q in dB) /
bandpass (Q linear) per the Web Audio spec, the 0.2 s noise buffer read from 0 each click — a seeded table, so a
render is deterministic). **The beats ride the DRIVING sequencer's own grid:** every step the ChopSequencer (or, when
it is silent, the DrumSequencer) schedules is logged (`takeGridLog`: straight grid time + duration + index + steps
per bar) and the beats inside that step are placed from it — at ANY resolution (a beat between two triplet steps is
interpolated with the step's own duration; a 2-steps/bar pattern books the two beats inside each step) and through
a tempo change by construction: the click lands where the sequencer's step lands (at 16ths, 120 → 90 mid-bar, the
TS walker re-reading 60/bpm per beat would have clicked 4000 samples — 83 ms — before the step; the native click is
AT the step's sample). Gated like the TS (clicks only while the chop seq plays and is not paused, else the drums
alone), METRO on mid-play → the next beat, off / stop / pause / a restart drop the booked beats, a driver hand-over
(drums → seq at one anchor) dedupes the same beat (1 ms). **Count-in:** `countIn{beats, atSample}` books N clicks a
beat (60/setBpm) apart from the anchor, the first accented, regardless of METRO (the TS rule), publishes
`countInBeat` (N..1 then −1), `countInPending`, `countInDownbeatSample` = atSample + N·beat; the regular train is
silent until that downbeat and the transport's beat 0 there is ONE click (a beat within 5 ms before it IS the
downbeat); `cancelCountIn` drops the rest. The clicks are added AFTER the master gain (the TS clicks went straight to
`ctx.destination`; Phase 4 routes them to the mixer's CLICK bus) and show in the out-1/2 peak meters.
`core/Arp.h/.cpp` — the TS `startArp / arpFire / stopArp` on the sample clock: holding a pad steps through the bank
every 60/bpm/rate (UP `(hold+step) mod padCount`, DOWN, RANDOM seeded xorshift64*) at the held velocity, each step a
live hit through the Sampler (mute group / retrigger rules) that stamps the pad's live-hit time (one owner: a pattern
hit of that pad within 120 ms is the arp's), the held pad's release stops it, a tempo change lands at the NEXT step
with the phase kept (the TS re-gridded from the start and burst to catch up), `setArp enabled:false` stops a held arp,
`arpHold` with the arp off = a plain hit; **the direct MIDI path holds/releases it when the arp is on** (note-on →
`hold`, note-off → `release`). Commands `setMetronome{enabled, sound}` · `countIn{beats, atSample}` ·
`cancelCountIn` · `setArp{enabled, rate, down, random, padCount}` · `arpHold{pad, velocity, atSample}` ·
`arpRelease{pad}`; `seqSetBpm` feeds the count-in beat + the arp interval; `panic` drops the count-in and the arp;
snapshot `metronome*` / `countIn*` / `arp*`.
**Shell:** the six JSON verbs (`sound` click|hihat|rimshot|kick|clap, `direction` up|down) + the snapshot fields; the
probe's async budget grew to 19 s / 15 s lead (the self-test runs ~9 s now).
**The page binding (ui):** `ChopperEngine.metroSink` (METRO / the click sound → `setMetronome`; `scheduleCountIn` →
`countIn` at the page's anchor — the TS Worker click scheduler does not run and no Web Audio click is booked; the
visual countdown timers + the downbeat callback stay on the page) and `ChopperEngine.arpSink` (`startArp` → `arpHold`
unless the hit is native-owned — the engine is already arping that MIDI note; `stopArp` → `arpRelease`); the shadow
diffs METRO/sound and the ARP settings + `pads.length` from the state (`syncMetroArp`). **The "1" is exact:**
`scheduleCountIn` keeps the downbeat's ctx time (`countInDownbeatCtx`) and the transport start takes it (`playSeq`
reads it before its `stopSeq`; `takeCountInDownbeat()` / `peekCountInDownbeat()` for the drum-only / bass REC
count-ins in DrumSection + HardwareView) instead of "now + lead when the timer fired" — the downbeat timer now runs
`max(50 ms, lead + 30 ms)` ahead so its jitter cannot move the "1" (fired too late → the old now + lead, as before).
Natively the shadow remembers the count-in's downbeat SAMPLE (atSample + N·60/bpm·sr — the engine's own math) and
PLAY on that downbeat sends exactly it to `seqPlay` AND to the drum/bass anchors (`anchorSampleFor`): mapping the
downbeat's ctx time a second time through WebKit's render-quantum-coarse `currentTime` pair had put the transport
45 samples (1 ms at 44.1 k) before the count-in's last click (the first probe run) — now 0 samples.
**Gates:** mac-debug 0 warnings + ctest **188/188** (175 + 8 `[metronome]`: the five sounds render at their sample,
peak in bounds, silent by 350 ms, bit-identical at 37 vs 64 samples/block; beats on the seq grid from the anchor with
accent on 0 at 37/64/512; the tempo-change click AT the sequencer's step (53000, not 49000); 6-steps/bar + 2-steps/bar
beats; pause/resume/stop/toggle-on; the drums alone + the hand-over without a double click + drumStop; the count-in
incl. "the train is silent until the downbeat" / "the transport's beat 0 at the downbeat is one click" / cancel / a
count-in at the block start at 90 BPM; the master-gain bypass — and 4 `[arp]`: UP exact samples + release rules +
the sampler really played them; DOWN / RANDOM deterministic / rates / padCount 0 / re-hold; tempo change at the next
step + arp-off stops + plain hit; MIDI direct path + one owner + block invariance) + 1 RT case (metronome + count-in
+ arp on the callback: 0 allocations); RTSan **189/189**; ui gate (tsc baseline 5, library, clock, bass-theory, vite);
the probe asserts **`metroPageOk`** (METRO → clicks on the grid `(lastClick − loopStart) % beat == 0`, STOP silences,
REC from stopped → the engine's count-in (`countInPending`, 4 clicks + the first beat), the transport started, the
page took the downbeat anchor and the seq loop start == the count-in downbeat sample at **0 samples**, the arp held
pad 62 / stepped ≥ 2 / released). **Evidence (ninth session):** mac-debug 0 warnings + ctest 188/188 · RTSan 189/189 · universal lipo
`x86_64 arm64` on the app + terminator-render + ctest 188 (0 warnings) · ui gate green · probe OK
(`countInOffsetSamples: 0`, `anchorTaken: true`, `metroLastClick.beat: 2`, `arpHits: 2`).
**Honest boundary after 3.6:** the metronome is the LAST Web Audio satellite gone — what you hear is now entirely the
native engine (pads, chop seq, drums, bass, clicks) except the mixer/master FX (Phase 4), time-STRETCH (dry), live
re-stem, per-hit reverse of a rendered LOOP. NOT done from the 3.6 line: the click through a mixer CLICK bus (Phase 4
— today after the master gain, like the TS), an ARP UI (the TS never exposed toggleArp/setArpRate — the engine + the
bridge + the sink are ready; exposing it is a UI decision), the count-in's visual countdown still runs on page
timers (ms-level, the clicks are exact), a resumed step's remaining beats at resolutions < 4 are not re-booked (a
beat inside a 2-steps/bar step that was paused mid-step clicks again from the next step). Electron-visible change in
the shared renderer: the count-in downbeat anchor (better there too — the "1" is where the clicks said, not now+20 ms
± timer jitter) and the downbeat timer firing 50 ms (not 20 ms) ahead.
**Victor's pass (3.6):** METRO on, PLAY a chop pattern at 90 BPM — the click sits on the pattern for 10 minutes;
drag the BPM knob while it plays — the click never falls off the beat (it moves WITH the pattern, not on its own
walker); pause/resume (space) — no click while paused, back on the beat after; toggle METRO mid-play — the first
click is the next beat; the five sounds (LOAD tab metronome sound menu); the drums alone (DRUMS ▶ with the chop seq
stopped) click too. COUNT-IN: REC with the transport stopped — 4 clicks, the "1" lands exactly where the 5th click
would have been (the loop starts ON it, drums and bass with it); the same from the DRUMS LIVE REC and the BASS REC;
cancel mid-count (click REC again). ARP has no UI yet — nothing to test there (MIDI + ARP on would arp natively).

## Phase 3 — 3.7 DONE (LIVE RECORD LANDS ON THE ENGINE CLOCK), 2026-08-23 ninth session
**What changed (page, the engine grid as the truth):** a live-recorded hit's MUSICAL TIME and its LANDED LINE are now
measured on the ENGINE's clock, not the WebView's AudioContext. `ChopperEngine.liveClockHook` (set by the shadow):
`hitElapsedSec(eventTimestamp)` = seconds from the audible loop start (the engine's own `seqLoopStartSample`) to the
hit's HEARD instant — the input's performance stamp (a native MIDI note's driver stamp mapped by the 3.5 router, a DOM
event's `timeStamp` for the mouse/keys; clamped to the TS 50 ms handler-lag window) → `NativeClock.sampleHeardAtPerfMs`
(the NATIVE device's output latency, not the ctx's); `sampleAt(elapsed)` = the absolute engine sample of a point on
the loop; `outputLatencySec()` = the native device's output latency. `_doTrigger`'s live-record branch uses them:
`hitTime = seqCurrentLoopStart + nativeElapsed` (the ctx math `now − lag − hwLatency` only when the native transport is
not running), the landing (`liveLanding` — INPUT Q, stride, the TS rules, unchanged) gives the line, and the audible
hit is booked as that line's ENGINE sample (`triggerPadAt(... {atSample})` → `voiceSink.start(..., atSample)` → the
shadow sends `triggerPad{atSample}` as-is — no second ctx → sample mapping; a past line = the engine fires at once).
`hwLatencySec()` / `hwLatencyMeasured()` read the native device's latency when the hook is set — the LATENCY readout
and the playhead compensation follow what is actually heard. The DRUMS the same way: `DrumSink.hitElapsedSec?` /
`sampleAt?` + `hit(..., atSample?)`; `DrumEngine.liveHit` takes the intent from the engine clock (`recordLiveHitAt`
straight with the musical time; the quantized audible instant as an engine sample through `playLive(..., atSample)`
→ `playHit(..., atSample)` → the sink). Why: WebKit's `ctx.currentTime` is render-quantum coarse (128 samples ≈ 2.9 ms
at 44.1 k) and `ctxPair` re-reads it per mapping — every chop/drum live hit carried up to ±3 ms of that plus the wrong
(WebView) output latency. **Engine:** the snapshot publishes `lastLiveHitPad` / `lastLiveHitSample` (the last live
trigger — command / booked / MIDI direct — and the sample it fired or was booked at; `Engine::noteLiveHit`) so the
page and the probe can assert the landed sample; one `[engine]` case (booked 1 s ahead → its booking; a direct trigger
→ its block offset; a MIDI note → its offset; the booked hit's re-stamp when it fires).
**Gates:** ctest 189/189 (188 + 1), RTSan, universal lipo `x86_64 arm64` (see the evidence line), ui gate (tsc
baseline 5); the probe asserts **`liveRecOk`** (part 7: the chop seq plays a cleared 1-bar/16 pattern at 240, REC arms
while playing, `triggerPad(62, 1, performance.now())` → the page wrote step k AND `lastLiveHitSample − seqLoopStart
(mod the loop) == k × stepSamples` — **0 samples**; the drums: `liveHit(0, now)` while live-recording → the kick row
got step 36 and `lastLiveHitSample` sits on `drumLoopStart + 36 × 459.375` — **1 sample** (the fractional step
length rounds)). Evidence (ninth session): mac-debug 0 warnings + ctest 189/189 · RTSan 190/190 · universal lipo `x86_64 arm64` on the
app + terminator-render + ctest 189 (0 warnings) · ui gate green · probe OK `liveRecOffsetSamples: 0`,
`drumLiveRec.offsetSamples: 1`.
**Honest boundary after 3.7:** the landing MATH (INPUT Q, the stride, the storage refit, the early-hit window) stays on
the page — it is pattern-data logic and the page owns the patterns; what moved is the TIME BASE and the booked sample.
The bass records at PPQ-96 ticks through its own (already native) clock and was left alone. The count-in's early hits
(before the loop runs) still use the ctx hit time for the write (no engine loop start yet — the write only). The
Electron app is untouched (the hook is null there; the `atSample` parameter is dead weight there).
**Victor's pass (3.7):** live-record chops on a playing 90 BPM pattern from a controller and from the pads — what you
hear IS what the next loop plays (no early/late drift between the take and the playback); INPUT Q 0 → your feel
recorded; the same on the drum LIVE surface; the LATENCY pill reads the interface's output latency (not ~16 ms
"browser").

## CI for the 3.7 tip `54d4fe9` (run 32616902875, 2026-08-23): RTSan ✅ · Intel ✅ · Windows/MSVC ✅ · **universal ❌ — not
the code: the smoke step's 60 s cap killed the app mid-self-test** ("app did not quit within 60 s": page loaded at +4 s,
the async checks started at +17 s on the starved runner — the 20 Hz probe countdown itself ran slow — and the
real-time parts 1–7 did not finish inside the cap). The same binary's probe passes here in 24 s. Fix in this session's
app+ui commit: `tools/ci/probe-app.sh` waits 150 s (the cap only has to catch "the page never loaded").

## Phase 4 — 4.1 DONE (THE MIXER IS NATIVE: STRIPS / SENDS / BUSES / MASTER, 64-BIT SUMMING, THE FREE ROUTING GRAPH), 2026-08-23 tenth session
**Engine — `core/Mixer.h/.cpp` (JUCE-free, RT; every buffer sized in `prepare`):** a fixed pool of `kMaxStrips` = 64
strips by index (0 = the MASTER, always; the page names the rest), each `StripKind` off · channel · send · bus · master.
A strip = its 64-bit input accumulator (the sources ADD into it: `Mixer::inputs()` is the per-strip `double*` table,
`addToStrip` for float blocks) → [inserts — 4.2] → M/S width (M = (L+R)/2, S = (L−R)/2·width; 1 = identity, bit-exact,
skipped) → fader (`10^(dB/20)`, ≤ −59.5 dB snaps to 0 — the TS fader's own rule, −60 = exact silence) → mute → pan (the
Web Audio StereoPanner STEREO law — the strip input is explicit 2-ch so it is the only law; pan 0 = identity, bit-exact;
the master has no pan) → output; the output feeds the strip's 4 post-fader/mute/pan sends (each its own level + target
strip) and its OUTPUT TARGET: the master / another strip (a bus; chains of buses) / a hardware PAIR direct (post-fader,
never the master) / none. **The free routing graph:** strips process in dependency order (Kahn over outputs + sends,
rebuilt on every routing change, dead strips skipped); the CYCLE GUARD refuses a send or an output that is the strip
itself, the master through a send, or would close a loop (`reaches()` DFS over ≤ 64 nodes; `routesRejected` counts,
the level of a refused send still applies); a loop can therefore never exist (a fallback index order is kept anyway,
`orderValid`). The master → `mainOut` pair (`setMainOut`). **The solo law** is the engine's (the TS applySolo: silent =
mute || (anySolo && !solo), over every non-master strip; the master mutes everything and has no solo). **Smoothing** =
the TS `setTargetAtTime` constants (fader / pan / send / mute τ 8 ms): the one-pole in closed form at the block end
(`a = exp(−n/(τ·sr))`, one `exp` per strip per block) + a linear ramp inside the block (the pan ramps the 2×2 law
matrix between its block-end values, so a sweep through 0 is continuous); **snapped within 1e-6** so a fader at −60 dB
IS silence and a fader back at 0 dB IS unity (a strip at unity is BIT-IDENTICAL to the direct path, test). **64-bit
summing:** N strips into the master equal one double accumulator cast once (test), the Sampler renders each strip voice
alone into a float scratch and accumulates in double. **Meters** per strip in the callback: pre (input) / post
(output) peak per channel + pooled RMS over a 4096-sample window (a 64-entry ring of per-block partials — the TS
peak-meter worklet's window), in the snapshot (`stripPeakPre/Post[64][2]`, `stripRmsPre/Post`, `stripGain` = the
smoothed fader × mute at the block end, `mixerActiveMask`, `mixerSilentMask`, `mixerRoutesRejected`, `mixerOrderValid`,
`mixerMainOut`, `bassStrip`, `clickStrip`). **Sources:** `PadParams::strip` (−1 = the direct path — the Phase-1..3
behaviour, every older test and the offline renderer unchanged; ≥ 0 = that strip — `Voice::strip`, `Sampler::render(…,
stripInputs, numStrips)`), `setSourceStrip` 0 bass / 1 click (−1 = direct: the bass dry into outs 1/2, the click post
master gain as in 3.6; ≥ 0 = rendered into the engine's scratch and added to the strip — the click now rides the mix
BEFORE the master gain when routed). Engine order: clear the strip inputs → sampler (direct + strips) → bass → click
(if routed) → `mixer_.process` (strips → sends → buses → master → hardware outs, ADDED under whatever was there) → master
gain + peaks → the click direct (if not routed) → publish. Commands `mixerSetStrip` · `mixerSetFader` · `mixerSetPan` ·
`mixerSetWidth` · `mixerSetMute` · `mixerSetSolo` · `mixerSetSend` · `mixerSetOutput` · `mixerSetMainOut` ·
`setSourceStrip` (+ `setPadParams.strip`); the `Command::Payload::Strip` union member (value / strip / index / target /
kind / flag); `Command` still ≤ 64 bytes. **Tests** `tests/engine/test_mixer.cpp` (11 cases, ASCII names): the default
topology + unity = bit-identical to direct + a dead strip drops its input; 64-bit summing = one double accumulator;
the fader taper (−60 = silence, −6.02 = 0.5, +6 = 1.995, the τ check at exactly 8 ms = 1/e); the mute/solo law incl.
the master and the mute ramp; the pan law at −1 / +1 / ±0.5 / back to 0 bit-exact / the master ignores pan; width 0 /
2 / 1 bit-exact; sends post-fader/mute + the return's fader + the guard (itself / the master / a loop → 3 rejections,
targets untouched); strip → bus → master, a chain of buses, the guard on outputs, hardware pair 1 = outs 3/4, mainOut
1, `none`, the direct pad on pair 1 untouched; the bass and the click through their strips and back to direct; a
STATIC mix block-size invariant 64 vs 512 (a live master fader would ramp, and a ramp's intra-block shape is block-size
dependent by design) + the meters read the window; `test_rt_safety` gets the mixer case (strips, routing, a refused
loop, sends, pads + bass + click through strips, live moves — 0 allocations).
**Shell + page:** `WebShell` verbs (BRIDGE-PROTOCOL rows) + the snapshot's `mixer` object (`active` / `silent` /
`strips["<idx>"] = [preL, preR, postL, postR, rmsPre, rmsPost, gain]` for the LIVE strips only / `rejected` /
`orderValid` / `mainOut` / `bassStrip` / `clickStrip`). `src/mixer/MixerEngine.ts` — `MixerNativeSink` +
`setMixerNativeSink()`: `setFaderDb` / `setPan` / `setSend` / `setMuted` / `setSoloed` / the master's `setFaderDb` /
`addChannel` / `removeChannel` report to it (null in Electron). `native/nativeMixerShadow.ts` (NEW): the page's strips
→ indices (fixed names → fixed indices: sample 1 · kick 2 · snare 3 · hat 4 · openhat 5 · perc 6 · bass 7 · send1..4
8..11 · CLICK 12; `sampleN` / user lanes 13.. on demand — a pad or a lane can ask for its strip BEFORE the view's
effect creates the page strip, the index is the same; the slot goes back when the page removes the channel), the whole
mixer mirrored on attach, every setter → its command, the 4 sends → the send1..4 returns, `setSourceStrip` bass →
'bass' and click → 12 (a native-only CLICK strip at 0 dB until the UI grows its fader), `levels(name)` from the
snapshot. `nativeEngineShadow` builds it FIRST; `PadDesc.strip = stripFor(engine.padRoute(i))` rides every
`setPadParams` (main chops → 'sample', a pad source → its 'sampleN'); `nativeDrumShadow` — `DrumShadowHost.
stripForDrumTrack?` (kick/snare/hihat→hat/openhat/perc, a user lane = its key) → `LaneDesc.strip` → the lane pad's
`setPadParams.strip`. Probe part 8 **`mixerPageOk`**: the master + 'sample' + CLICK + 'bass' strips live, the sources
on them, 'sample' fader −60 → `gain` 0 → back → 1, mute on → in `silent` → off, every bound pad's strip == its route's
strip and live, `rejected` 0, `orderValid`. `tools/ci/probe-app.sh` asserts it (and now waits 150 s).
**Gates (tenth session):** mac-debug 0 warnings + ctest **200/200** (188 + 11 `[mixer]` + 1 RT) · RTSan **201/201** ·
universal (0 warnings) lipo `x86_64 arm64` on the app + terminator-render + ctest 200/200 · ui gate (tsc baseline 5,
zero new) · probe OK on the debug AND the universal binary (`mixerPageOk: true`, 14 live strips = master + 11 fixed +
CLICK + the probe's `sample2`; the whole probe 24 s).
**Honest boundary after 4.1:** the native mix is DRY — inserts / the console stage / PDC / the master limiter are still
the page's Web Audio graph, which is NOT what is heard natively (the sources are in the engine): Phase 4.2 ports the
FX (utility/eq/filter/… in the plan's order, each with its golden gate), 4.3 binds the meters (the snapshot already
carries them — the MixerSection still reads its worklet), 4.4 the two-tier integer PDC + the offline renderer's stem
decomposition, 4.5 the export pipeline. No CLICK strip in the UI yet (native strip 12 at 0 dB). Gain match (a live
trim) not ported. MIDI note OUT per strip not started (the 3.5 pump is ready). The mobile HardwareView has no mixer →
its pads stay on the direct path (strip −1), as in Phase 3. The Electron app is untouched (the sink is null there).
**Victor's pass (4.1):** on the desktop app: the MIXER's faders/pans/mutes/solos/sends move what you HEAR (the engine),
the 'sample' strip against the drum strips against the bass; solo a strip; a −60 dB fader is silent; the click rides
the mix (mute the master → no click); a pad re-routed to SAMPLE 2 follows its strip.

## Phase 4 — 4.2a DONE (THE INSERT CHAIN + THE FIRST SIX DEVICES), 2026-08-23 tenth session (second half)
**Engine — `core/fx/Effect.h`:** the insert-effect contract (`FxType` = the page's FxId order; a fixed param table per
type — `FxParamDef` key / range / default / enum options = FX_REGISTRY's, so presets load unchanged; `prepare` non-RT,
`reset` / `setParam(index, value, immediate)` / `param` / `latencySamples` / `process(l, r, n)` RT, all
`TERMINATOR_NONBLOCKING`; `wetMix()` from the type's WET param or 1); `Glide` (the TS setTargetAtTime in closed form per
block, snapped — FX τ 10 ms); `Biquad` = the Web Audio BiquadFilterNode (the spec's RBJ coefficient forms in double,
Direct Form I like Blink; Q in dB for lowpass/highpass, linear for the rest, shelves S = 1; normalised by DIVISION so
a 0 dB shelf/bell is detected as the identity and passes BIT-EXACT; `magnitudeAt` for gates). **`core/fx/BasicFx.h`:**
UTILITY (GAIN τ 10 ms on the linear gain · MODE re-patch · PHASE) · EQ (low shelf 80 · bell 1 k Q 0.8 · high shelf
12 k, ±12, gains glide and the coefficients recompute per block while moving) · FILTER (TYPE · CUTOFF · RESO; Q in dB
for LP/HP so RESO 0..30 = 0..30 dB — Butterworth −3 dB is below the page's range, the floor is 0.0001 dB like the TS)
· WIDE (instant, M/S) · M/S EQ (peaking Q 1 on M and S) · PAN (a sine LFO from phase 0 × DEPTH on the StereoPanner
stereo law per sample). **`core/fx/FxPool.h`:** every instance built + prepared at `Engine::prepare` (utility/eq/
filter 64 each, wide/mseq/pan 32 — the heavy devices get small caps when they land); `acquire` / `release` are
pointer bookkeeping on the audio thread; an UNPORTED type comes back as a `PassFx` placeholder reporting the type (64 of
them) so a page chain with e.g. a reverb in slot 0 keeps its indices aligned natively. **`core/Mixer.h`:** per strip
`fx[8]` + bypass + count; `addFx` (append, the TS pushes) / `removeFx` / `setFxBypass` / `setFxParam` / `reorderFx` /
`clearFx`; refusals (dead strip / full / pool empty) count in `fxRejected`; the chain runs IN PLACE on the strip's input
between the pre meter and width/fader — bypass = skipped (dry, bit-exact), a WET device crossfades (dry 1−mix + wet
mix); a strip turned off returns its devices; `prepare` drops every chain (the pool re-prepares — the page re-sends);
`chainLatencySamples` (Σ of the non-bypassed, 0 for every 4.2a device — the PDC plan, 4.4). Commands `mixerAddFx` ·
`mixerRemoveFx` · `mixerSetFxBypass` · `mixerSetFxParam` · `mixerReorderFx` · `mixerClearFx` (`Payload::Fx`); the
snapshot `stripFxCount[64]` + `mixerFxRejected`. **Tests** `tests/engine/test_fx.cpp` (7 cases): the type table
(ids / keys / option strings / defaults); UTILITY (gain, the three folds, phase, the 10 ms glide); EQ (0 dB bit-exact
pass-through; LOW +12 = +12 at 10 Hz and 0 at 8 k; MID +6 = +6 at 1 k; HIGH −12 = −12 at 22 k; the analytic shelf at
DC exactly ±G, the bell exactly +6 on f0); FILTER (the default flat; LP 1 k at RESO 1 dB = +1 dB at fc (|H(fc)| =
Q_lin) and < −38 dB a decade up; RESO 0 = 0 dB at fc; HP mirrored; BP 0 dB at fc; notch < −40 at fc; the analytic
Butterworth −3.01); WIDE + M/S EQ (the matrix; a mono sine takes the MID band, an anti-phase one the SIDE band);
PAN (at 0.25 s hard right: L 0 / R 1.0, at 0.75 s hard left; DEPTH 0 = identity bit-exact); the chain through the
Engine (add / bypass bit-exact / param / a second device / reorder + read-back / remove / the 8 cap / a dead strip /
clear / the pool cap + a freed slot / a strip turned off gives back / the placeholder for an unported type keeps slot 1
as slot 1 / chain latency 0). `test_rt_safety`: add / param / bypass / reorder / remove / clear on the callback = 0
allocations.
**Shell + page:** WebShell verbs (`mixerAddFx {strip, fx}` by the page's FxId, `mixerSetFxParam {strip, index, fx,
key, value}` — key → index and option string → index through the engine's table, `immediate`), the snapshot row's
`fxCount` + `mixer.fxRejected`. `src/mixer/MixerEngine.ts` — the sink's `fxAdd/fxRemove/fxBypass/fxParam/fxReorder/
fxClear`, reported by `ChannelStrip` AND `MasterStrip` (`addFx` / `removeFx` / `toggleBypass` / `setFxParam` /
`reorderFx` / `clearFx`); `native/nativeMixerShadow.ts` — `mirrorChain` on attach and on a channel re-created, `fxAdd`
sends every current param immediately, the master's chain = strip 0; probe part 8: add an EQ to 'sample' → the
engine's count +1, a param, bypass on/off, remove → back, `fxRejected` 0.
**Gates (4.2a):** mac-debug 0 warnings + ctest **207/207** (200 + 7 `[fx]`) · RTSan 208/208 · universal (0 warnings)
lipo `x86_64 arm64` + ctest 207/207 · ui gate (tsc baseline 5) · probe OK on the debug AND universal binaries
(`mixerPageOk` incl. `mixerFxAdded` / `mixerFxRemoved`, `fxRejected` 0).
**Honest boundary after 4.2a:** eleven page devices (clip, wave, sat, mbsat, phaser, flanger, vinyl, comp, sccomp,
delay, reverb) are PLACEHOLDERS natively (pass-through; the page still runs its Web Audio version, which is not what
is heard) — 4.2b ports them (the 4× shapers with real polyphase oversampling + their latency, the Blink
DynamicsCompressor kernel, the sc-comp worklet, the deterministic IR reverb + partitioned convolution, the delay with
its damped feedback, phaser / flanger / vinyl with their LFOs) and 4.2c builds the B4 premium devices. The console
stage (`ConsoleStage` / the `console-stage` worklet) is not in the chain yet. Gain match not ported. The FX param
smoothing matches the TS at rest (the numbers above); during a move the coefficient update is per block, not per
sample.
**Victor's pass (4.2a):** on the desktop mixer: UTILITY gain/mono/phase, EQ, FILTER (sweep the cutoff — smooth, no
zipper), WIDE, M/S EQ, PAN on any strip — what you HEAR follows the device; bypass is clean; the master's chain too.
**The probe hardened (found while gating 4.2a — the hidden WebView's DOM timers):** the headless probe page is not
"visible" to WebKit, and its `setTimeout(50)` polls were seen to crawl at ~1 s (parts 6–7 taking 12 s + 6 s instead
of 3 s + 0.7 s) and once to stall outright (part 8 stuck at its first insert-chain poll for the whole window) — the
self-test then missed the shell's read window and the script reported "the sample upload failed" (the first assertion
of an EMPTY result). Fixes in the app+ui commit: every self-test poll (engine / drum / bass shadows, 24 sites) now
races the next native `terminator.snapshot` event against the timer (`tick()`; the snapshot is pushed by the shell,
not a DOM timer); part 8's waits have a wall-clock budget; the self-test records `timing` per part and the live
`stats.stage` (so a stall names itself in the probe output); the shell's React probe window is 30 s with the async
checks 26 s before the read (`kProbeDelayTicksReact` 600 / `kProbeAsyncLeadTicks` 520); part 7 (live record) gets one
RETRY (a late clock re-anchor on the throttled page once booked a hit off the grid — `seqNudges` 4 that run; the
sample-exact landing is gated in C++, the probe checks the PATH). After the fixes: 6 consecutive probe runs green,
the whole self-test 8.9–9.1 s every time.

## Phase 4 — 4.2b DONE (EVERY PAGE DEVICE IS REAL NATIVELY: THE ELEVEN HEAVY PORTS), 2026-08-23 eleventh session
**Engine — the shared DSP (`core/fx/FxDsp.h/.cpp`):** `Halfband2x` / `Oversampler4x` = the WaveShaper's `'4x'` as two
polyphase Kaiser-sinc halfband stages (stage 1 center 47 / 95 taps β 8, stage 2 center 16 = a 31-tap halfband padded by
one zero so the two decimators read the right phase; the cascade's group delay is a WHOLE base sample = **55**,
reported by `latencySamples()` and asserted by the gate — Blink's was measured at 192, ours is leaner; the PDC plan
reads the number); `DelayLine` (the DelayNode's linear interpolation; `readAt(d)` before the write for feedback loops);
the OscillatorNode sine / triangle from phase 0; `Fft` (radix-2 complex, double). **`core/fx/ShaperFx.h`:** CLIP / WAVE
/ SAT / MB SAT — the page's curves evaluated analytically (the curve DOMAIN clamps like the WaveShaper's: anything past
±1 takes the endpoint; CLIP tops out at 0.9886 even at AMT 0; SAT's Doidic curve has its +3.5 dB small-signal gain at
DRIVE 0 — the page's), at 4× through `OversampledShaper`; MB SAT = LR4 crossovers (Butterworth Q −3.0103 dB in the
Web Audio LP/HP-in-dB convention, AP(HI_X) on the low band), per-band tanh(a·X)/a on X = clamp(band, ±4), makeup
√(1+4d), and a phase- AND latency-matched dry leg (AP·AP → ±4 → the oversampler's delay) so it blends WET ITSELF
(`wetParam = −1` in the table: the chain runs it fully wet). A drive change glides τ 10 ms (the page swaps the curve
instantly). **`core/fx/ModFx.h`:** DELAY (per-sample loops, damping LP 7.5 k Q 0.5 dB → HP 90 Q 0.5 dB on the
feedback, R = min(2 s, 1.02·TIME), PINGPONG = the mono sum → L → R → feedback → L), PHASER (n allpasses Q 0.6 spread
±½ oct, the sine LFO's linear Hz offset capped at lowest − 40, ONE-sample feedback, coefficients every 16 samples),
FLANGER (triangle LFO, DELAY ± 0.9·DEPTH·DELAY never under one sample, feedback through LP 9 k Q 0.5 dB), VINYL
(Doidic at 4× → LP Q 0.3 dB 20 k − 1.2 k·AGE → HP 20 → wow 4 ms ± 0.3 ms·WOW at 0.1 + 0.07·WOW Hz → flutter 1 ms ±
0.05 ms·FLUTTER at 3 + 0.5·FLUTTER Hz → peaking 200 Hz Q 0.7 +2 + 0.4·WARMTH; latency round(0.005·sr) + 55 = 295 at
48 k). **`core/fx/DynamicsFx.h`:** COMP = `BlinkCompressorKernel`, a port of Chromium's DynamicsCompressorKernel in
float (the knee curve + the 15-step k solver, the 4th-order adaptive-release polynomial, the 2.5 ms detector release,
the sin(π/2·g) warp, the perceptual auto-makeup (1/saturate(1))^0.6, the metering with its 325 ms release, the
`int(0.006·sr)`-frame look-ahead = `latencySamples()` = 288 at 48 k / 264 at 44.1 k, divisions of 32 frames with a
short last division on odd blocks) + the STYLE presets (picking one sets the five knobs AND the blend; NY-PARALLEL =
50 % dry through a look-ahead-matched dry leg, blended inside the device — `wetParam = −1`); SC COMP = the sc-comp
worklet per sample (rectified key peak → soft knee 6 dB in dB → attack / hold / release on the GR → gain × makeup,
k-rate params per block), its key through KEYHP (Butterworth) — **the sidechain hooks**: `Effect::sidechainSource()`
/ `setSidechainKey(l, r)`; the Mixer keeps `keyMask_` (rebuilt on add / remove / clear / SOURCE change / strip off),
copies a keyed strip's input aside at the top of `processStrip` (BEFORE its own inserts mutate it in place), and hands
each SC COMP its key (the copy once the source ran this block — or is this strip; the live accumulator otherwise; a dead
source = silence); SOURCE = the key strip's INDEX (−1 = NONE). **`core/fx/ReverbFx.h`:** the page's generator (the
seeded LCG 1664525/1013904223 from 0x9e3779b9, one stream across both channels, the 1-pole LP along √frac from
14 k − 6 k·room to 1.8 k, the onset ramp 2 + 30·room ms, exp(−6.9078 t/DECAY), Float32 like the AudioBuffer) +
Blink's `normalize = true` (scale = 10^(−58/20) / rms · 44100 / sr, exactly) + PREDELAY as a DelayNode; the
convolution = a ZERO-LATENCY non-uniform partitioned scheme: a 128-tap direct head, 128-sample partitions to lag 512,
512-sample partitions to lag 8192, 4096-sample partitions for the rest with ONE partition of lead (their MAC is sliced
across the 32 tier-1 ticks before the result is due — a 10 s tail never spikes the callback); the IR is generated AND
its partitions transformed INCREMENTALLY on the audio thread (a bounded budget per block, ×4 while nothing is heard
yet; every buffer pre-sized for DECAY 10 s at the rate, the big ones uninitialised + validity counters so the RSS only
grows when a long tail is used: ~27 MB per instance at 48 k, 6 in the pool); a finished IR waits for a tier-3 boundary
to ARM (its first big-tier job runs through that window), is PROMOTED at the next (so its long tail is complete from
its first heard sample) and crossfades in 60 ms; a ROOM / DECAY move under a running build restarts it (the page's
60 ms debounce, in effect). The `FxPool` caps: utility/eq/filter 64, the light devices 32, the delay-line devices 16,
reverb 6; an UNKNOWN type still gets a pass-through placeholder (no page type is unported now).
**Tests — `tests/engine/test_fx_devices.cpp` (12 cases, 599 assertions with the 4.2a ones):** the type table (every
page device, keys / defaults / options / which WET the chain blends); the oversampler (an impulse lands at EXACTLY 55 =
`latencySamples()`, unity DC gain, the passband flat ±0.02 dB at 1 k / ±0.1 at 10 k / ±0.5 at 16 k, a WAVE at DRIVE 30
on a 14 kHz sine aliases at 6 kHz 70 dB below the naive curve (−81 vs −9.4 dB)); CLIP / WAVE / SAT (the curve values,
the domain clamp, the small-signal gains 1/tanh(1) and 1.5 through the devices); MB SAT (0 drive sums flat ±0.05 dB at
100 / 1 k / 10 k, WET 50 still flat — the matched dry leg — LOW 100 lifts 100 Hz by 5–7 dB and leaves 10 kHz, HIGH the
mirror); DELAY (a left impulse echoes at sample 4800, the R line silent in dual mono, feedback's second echo damped
between 0.2 and 0.5, ping-pong 0.5 at 4800 then 0.5 at 9696); PHASER (the cascade is unity ±0.05 dB at 200 / 1 k /
5 k; 50/50 with the dry sweeps to a notch < −10 dB and never over 0 dB; 90 % feedback bounded); FLANGER (DEPTH 0 = a
pure 144-sample delay, feedback's second pass damped, DEPTH 100 at the triangle's peak = 274 ± 5 samples); VINYL
(latency 295, AGE 10 loses > 6 dB at 15 k, WARMTH 10 vs 0 = +4 dB at 200 Hz); COMP (latency 288; STYLE OFF passes an
impulse at unity 288 late AFTER the kernel's start-up — Blink resets its detector average to 0 so a FRESH compressor
dips its gain for ~100 ms then recovers, the page's node does the same, the gate checks both; PUNCHY lifts −30 dBFS
by > 4 dB and compresses −6 dBFS by > 3 dB more; NY-PARALLEL's impulse comes out ONCE at 288 (the dry leg matched);
20:1 compresses > 5 dB more than 1.5:1 measured as the −30-vs-−6 dBFS gain difference — Blink's auto-makeup nearly
cancels the ratio's effect on the loud signal alone); SC COMP through the Mixer (keyed from strip 2's input: > 15 dB of
ducking with the key, a UTILITY −20 dB INSERT on the key strip changes nothing — the key is pre-insert — SOURCE NONE
= clean pass); REVERB (the generator's length / onset / determinism / decorrelation / tail, the normalisation formula,
the device after its first build: the impulse response IS scale · ir within 1e-6 of peak in the head and 1e-5 across
tier 1 / tier 2 / tier 3 (lags 8192+ come only through the sliced big tier) and silence past the end, PREDELAY 10 ms
shifts it by 480, a DECAY move rebuilds / arms / promotes / crossfades to the new length); the chain (Σ latency 55 +
288 + 295, minus a bypassed COMP; a DELAY's WET 0.3 read by the chain). `test_rt_safety`: the eleven heavy devices
added (the SC COMP keyed), params moved (a REVERB DECAY rebuild, MB SAT, a COMP style), 50 blocks = 0 allocations.
**Shell + page:** `nativeMixerShadow.fxValue()` maps the SC COMP's SOURCE channel NAME to the key strip's INDEX (−1 =
NONE) on `fxAdd` / `fxParam` (the shell refuses a string on a numeric param, so a leak would surface as a command
error); probe part 8 adds the heavy round trip (an SC COMP keyed from 'kick', a DELAY, a REVERB — `mixerFxHeavyAdded`
/ `mixerFxHeavyRemoved`, `mixerFxCmdErrors` 0) into `mixerPageOk`.
**Found on the way (fixed):** (1) `BlinkCompressorKernel::reset()` kept the previous `lastPreDelayFrames_`, so a
RE-ACQUIRED COMP ran a 256-frame look-ahead while reporting 288 — the gate caught it (NY's dry leg landed 32 samples
off); reset now returns the kernel to its constructed state. (2) **Windows CI for the 4.2a tip (run 32620283926) =
16 tests died of STACK OVERFLOW on MSVC** — `sizeof(Engine)` had grown to 502 KB with the 4.1 Mixer's 64 strips of
meter rings (177 KB) and the render-comparison gates hold two Engines on a 1 MB Windows stack; the Mixer now lives
on the heap inside the Engine (325 KB again, the 3.7 size that passed) and `Engine.cpp` carries a
`static_assert(sizeof(Engine) <= 384 KB)` so nobody grows it back silently. (3) Non-ASCII TEST_CASE names in
`test_fx.cpp` (4.2a) and the new file — the STATUS gotcha (the Windows ctest discovery mangles them) — ASCII now.
**Page quirks found while porting (flagged, NOT carried natively — the native device does what the page's own comment
says it meant; fix them in the Electron app or accept the difference):** (a) DELAY: each DelayNode feeds a
ChannelMerger INPUT, and merger inputs downmix to mono — the page's "independent L/R" mode actually mono-sums every
repeat per side; native dual-mono is truly dual mono (ping-pong matches the page exactly, it is mono-summed by
design). (b) PHASER: the feedback goes through a one-render-quantum DelayNode (128 frames — Web Audio's cycle rule),
a 2.9 ms comb in the loop at FEEDBACK 30; native feedback is one sample. (c) FLANGER: a DelayNode inside a cycle is
clamped to ≥ 128 frames, so the page never sweeps below 2.9 ms (DELAY < 2.9 ms and the DEPTH trough are clamped);
native sweeps as labelled. (d) COMP: Blink's start-up dip (above) IS carried (a Blink trait, kept for parity —
a one-line `detectorAverage_ = 1` in reset would remove it; Victor's call).
**Gates (4.2b):** mac-debug 0 warnings + ctest **219/219** (207 + 12 `[fx]`) · RTSan **220/220** · universal
(0 warnings) lipo `x86_64 arm64` + ctest 219/219 · ui gate (tsc baseline 5, 0 new) · probe OK on the debug AND the
universal binary (`mixerPageOk` incl. the heavy round trip, the self-test 9.0–9.1 s).
**Honest boundary after 4.2b:** every page insert device is native (the chain, the pool, the bridge, the page mirror,
eleven heavy ports + six light ones). NOT in yet: the CONSOLE stage per strip (`ConsoleStage` / the `console-stage`
worklet — needs the strip NAME's FNV-1a seed → a `mixerSetStrip` seed field) and the legacy chopper master chain
(Filter / EQ3 / Compressor / Delay / Reverb / Clipper … the mobile path) → 4.2c with the B4 premium devices; the SC
COMP's GR meter and the COMP's `reduction` are computed (`gainReductionDb()`) but not on the bridge (4.3 meters); gain
match not ported; PDC (the chain latencies are plumbed and exact) is 4.4; the reverb's first IR after an insert lands
in ~0.3 s and a ROOM / DECAY move in ~0.4 s + ≤ 170 ms (the page: 60 ms debounce + a synchronous build) — acceptable
for a knob, could be faster with a worker; FX coefficient updates are per block while gliding (exact at rest), the
PHASER's every 16 samples.
**Victor's pass (4.2b):** on the desktop mixer: CLIP / WAVE / SAT / MB SAT drive a chop (no fizz on hats = the 4×),
DELAY (dual mono is truly stereo now — a panned source echoes on its side; PING-PONG bounces), PHASER (tighter
than the web — the one-sample feedback), FLANGER (sweeps all the way down now), VINYL/TAPE, COMP (styles; NY-PARALLEL
blends clean — no comb), SC COMP (kick on SOURCE ducks the 808 / pad; the source's own fader / FX do not change the
ducking), REVERB (ROOM / DECAY / PRE-DLY; a DECAY move crossfades with no click, ~half a second later). What you
HEAR is the native device in every case; bypass is clean; the master's chain too.

## Phase 4 — 4.2c (part 1) DONE (THE CONSOLE STAGE + THE MASTER'S SAFETY LIMITER ARE NATIVE), 2026-08-23 eleventh session (second half)
**Engine — `core/fx/ConsoleStage.h/.cpp`:** the page's `console-stage` worklet ported 1:1 in double: per channel
HPF (RBJ, Q 1/√2) → low shelf → high shelf → presence peak → 1-pole LPF → the bounded 2nd+3rd-order polynomial
saturator (x − a3·x³ + a2·x², held flat past x0 = 1/√(3·a3), no foldback) → a 5 Hz DC blocker (always in); the
FLAVOURS table (SSL / NEVE / API, channel + bus numbers); AMOUNT 0..1 scales the drive and the EQ deviations and glides
1/1024 per frame (~23 ms); role CHANNEL = six tolerances in [−1, 1] from `mulberry32(seed)` (the page's `toleranceFor`:
FNV-1a of the strip NAME — `ConsoleStage::fnv1a` reproduces it byte-for-byte: fnv1a('kick') = 0xc61c131f and the six
draws match the JS to 1e-11), role BUS = zeros. **Mixer:** a `ConsoleStage` per strip (channel role; strip 0 = bus) run
between the pre meter / the sidechain key copy and the inserts when `consoleOn_`; `setConsole(on, flavour, amount)`
(switching ON resets every stage AT the setting — the page builds fresh stages); `setStripSeed` (a new `seed` on
`mixerSetStrip` — the shell takes the page's FNV-1a; 0 = leave); the snapshot `mixerConsoleOn`. **The master's safety
limiter** (`Mixer::setMasterLimiter`, `mixerSetLimiter`): the page's DynamicsCompressor −1 dBFS / knee 0 / 20:1 / 1 ms
/ 50 ms on `BlinkCompressorKernel` after the master's fader × mute (the page: `faderGain → limiter → output`); its
look-ahead int(0.006·sr) = `masterLatencySamples()` (264 at 44.1 k, 288 at 48 k); OFF by default in the core (every
older mixer test keeps its bit-exact master), the page shadow turns it ON at attach (the page's master always has it);
the snapshot `mixerLimiterOn`. Blink's perceptual makeup lifts the whole mix +0.57 dB ((1/saturate(1))^0.6 at −1 dB /
20:1) and it is NOT a brickwall (a +6 dBFS 1 kHz sine comes out at ~+0.2 dBFS: the static curve leaves 0.3 dB of the
overshoot, the 2.5 ms detector release rides between the peaks) — exactly what the page's node does; gated as such.
**Shell + page:** `mixerSetStrip {…, seed}` · `mixerSetConsole {on, flavour, amount}` · `mixerSetLimiter {on}`; the
snapshot `mixer.console` / `mixer.limiter`. `MixerNativeSink.console?(settings)` reported by `applyConsole`;
`nativeMixerShadow`: `fnv1a()`, every activation carries `seed: fnv1a(name)` (the CLICK strip 'click'), CONSOLE mirrored
at attach + on change, the limiter ON at attach; probe part 8 toggles CONSOLE on/off against the snapshot and asserts
the limiter is in.
**Tests — `tests/engine/test_console.cpp` (7 cases):** the seed + tolerances vs the JS; level-matched within 0.1 dB at
−18 dBFS / 1 kHz on every strip + the bus, every flavour; THD at −6 dBFS 0.3–2 % at AMOUNT 100, < 0.7× at 50, cleaner
when quieter, SSL odd-heavy / NEVE even-heavy; every strip within ±0.6 dB of flat 60 Hz–12 kHz and every pair ≥ 0.03 dB
apart, same name = same curve; the sub-sonic HPF (10 Hz < −12 dB, 40 Hz > −2.5), the NEVE bus softening 16 kHz (−0.5..
−4 dB), AMOUNT 0 transparent, +12 dBFS bounded, no DC; the AMOUNT glide; through the Mixer (off = dry within 1e-5 THD,
on = the channel stage's THD straight out, channel + bus via the master, the command path + the snapshot flag); the
master limiter (off bit-exact, on: an impulse lands 264 late, −20 dBFS passes at +0.57 ± 0.15 dB, +6 dBFS held to
0.9..1.1, the command + snapshot). `test_rt_safety` adds CONSOLE on + the limiter on to the callback loop.
**Gates (4.2c part 1):** mac-debug 0 warnings + ctest **226/226** (219 + 7) · RTSan 227/227 · universal (0 warnings)
lipo `x86_64 arm64` + ctest 226/226 · ui gate (tsc baseline 5) · probe OK on debug AND universal (`mixerPageOk` incl.
`mixerConsoleOn/Off` + `mixerLimiterOn`, 9.1–9.2 s).
**Honest boundary after 4.2c part 1:** the desk stage + the master limiter are native. NOT in: the page's gain-match
trim (`matchGain`, live-only — 4.3 with the meters), the legacy chopper internal chain (§2.2 — the MOBILE HardwareView
path and the single-chop bake; the native desktop app runs the mixer, so it is not in the signal path here — only the
exports that bake it will need it in 4.5), the B4 premium devices (next), PDC (4.4 — the master's limiter latency is
now a number the plan reads). The native master is the page's: strips → [console] → inserts → width/fader/mute/pan →
sends → master → [bus console] → inserts → fader → limiter → out.
**Victor's pass (4.2c):** CONSOLE on / flavour / amount on the desktop mixer — what you HEAR is the native desk stage
(every strip its own tilt, the master's bus glue); the master limiter is native (a hot mix is held at ~0 dBFS).

## Phase 4 — 4.3 DONE (THE METERS ARE ON THE BRIDGE: STRIP PEAKS, BS.1770-4 LOUDNESS, GAIN REDUCTION), 2026-08-23 eleventh session (third part)
**Engine — `core/LoudnessMeter.h/.cpp`:** the page's loudness-meter worklet 1:1, RT with everything preallocated:
K-weighting designed from the spec's analogue prototypes at the running rate (high shelf f0 1681.97 Hz Q 0.7071752
+3.99984 dB with Vb = Vh^0.4996667741545416, RLB HP 38.13547 Hz Q 0.5003270 — the spec's 48 k table to 6 decimals,
right at 44.1/88.2/96 k); 100 ms hops; MOMENTARY = the last 4 hops, SHORT-TERM = the last 30; INTEGRATED = every 400 ms
block above −70 LUFS then −10 LU below the gated mean, recomputed each hop (the block LUFS stored alongside so the gate
compares, never recomputes a log; a 2-hour ring); LRA = short-term −70 abs / −20 rel, 10th → 95th percentile (an
in-place heapsort — the STL sort is not nonblocking); sample peak + TRUE PEAK (4 phases × 12 taps of a Kaiser β 8 sinc,
each phase unity at DC) per hop; L/R correlation; the holds + maxM/maxS since reset. **Mixer:** fed with the master's
output post limiter, always on (cheap); `resetLoudness`; `fxGainReductionDb(strip, slot)` through a new
`Effect::gainReductionDb()` (COMP = Blink's `reduction` metering, SC COMP = the block's deepest GR); the master
limiter's GR. **Snapshot:** `stripFxGr[64][8]`, `masterLimiterGr`, `lufsM/S/I`, `lra`, `loudPeakL/R`, `loudTpL/R`,
`loudCorr`, `loudHoldPeak/Tp`, `loudMaxM/S`, `loudHops`; command `loudnessReset`.
**Shell + page:** the snapshot `mixer.loudness {…}`, `mixer.fxGr {"<strip>": [per slot]}` (live strips with a chain),
`mixer.limiterGr`; `loudnessReset`. `src/mixer/MixerEngine.ts`: `MixerNativeMeters` / `setMixerNativeMeters` —
`ChannelStrip.levels()` / `MasterStrip.levels()` (+ true peak from the loudness reading) / `updateLoudness()` /
`resetIntegrated()` read the engine first (MixerSection / the LoudnessPopup are unchanged — they call the same
methods); `nativeMixerShadow.installMeters()` from the snapshot (strip peaks from the rows, the loudness object with
−1000 → −∞, the GR rows), `onSnapshot` keeps every SC COMP device's `gainReductionDb` at the engine's number (its
panel reads that field). Probe part 8 asserts the loudness object + `fxGr` ride the snapshot and
`master.updateLoudness().worklet` (`mixerLoudnessOk`).
**Tests — `tests/engine/test_loudness.cpp` (4 cases):** the BS.1770 reference points (a 0 dBFS 997 Hz sine in one
channel = −3.01 LKFS, both channels at −20 dBFS = −20.0 ± 0.05 on M / S / I; an empty channel's correlation = 1 as the
page's; anti-phase = −1; maxM; reset clears); true peak between the samples (an fs/4 sine at phase π/4: sample peak
0.354, true peak 0.490 — the 12-tap design's own −0.17 dB droop at fs/4, the page's number — hold ≥ the hop); LRA
between 12 s at −20 and 12 s at −30 = 10 ± 2 LU, I between; the integrated gate ignores silence (hops 0, I = −∞; after
the signal −20 within 0.2 — the one onset block the −10 LU relative gate lets through); on the bridge: a −20 dBFS
sine through a bare Mixer with the limiter reads −20 + 0.57 (the limiter's makeup), a hot signal through a COMP
reports its slot's GR < −1 dB and 0 on the EQ / an empty slot, the snapshot's fields move + reset on command
(Blink's start-up dip shows as −21 dB of "reduction" on the first block — the page's node too — then its 325 ms
metering release lets go).
**Gates (4.3):** mac-debug 0 warnings + ctest **230/230** (226 + 4) · RTSan 231/231 · universal (0 warnings) lipo
`x86_64 arm64` + ctest 230/230 · ui gate (tsc baseline 5) · probe OK on debug AND universal (`mixerPageOk` incl.
`mixerLoudnessOk`, 9.0–9.2 s).
**Honest boundary after 4.3:** the strip peak meters, the master's loudness popup numbers (M/S/I/LRA/TP/corr/holds) and
the SC COMP GR meters read the engine. NOT in: the popup's SPECTRUM (the page's 8192-bin analyser still reads the
Web Audio master — a future `mixer.spectrum` as ~96 log bands from an audio-thread FFT, or a spectrum pull verb), the
per-strip RMS for the gain-match trim (the page's `matchGain` is live-only and not ported — it would read
`rmsPre/rmsPost` from the rows, already there), the clip-latch / peak-hold logic (page-side, unchanged, fed by the
native peaks). The SnapshotPublisher copies ~2 KB more per block (the GR table) — negligible.
**Victor's pass (4.3):** the mixer's meters move with what you HEAR (pull a fader — the post meter follows; the
pre meter does not); the LOUDNESS popup's LUFS / TP / LRA / correlation are the engine's (RESET works); an SC COMP
panel's GR meter ducks with the kick.

## Phase 4 — 4.4 DONE (PDC: THE TWO-TIER PLAN IS NATIVE, IN WHOLE SAMPLES), 2026-08-23 twelfth session

The page's plan (`MixerEngine.pdcPlan` / `pdcChainDelaySec` / `pdcMasterShiftSec`) ported onto the chain latencies the
engine already reports — no new measurement, no guessing: `chainLatencySamples(strip)` was plumbed in 4.2 and the
devices report exact numbers (the 4x shapers 55, COMP 288 @48k, VINYL ~9 ms, the master limiter 264/288).

**Engine — `core/fx/FxDsp.h/.cpp` `IntDelay`:** an exact-size integer ring (maxDelay + block + 1 doubles), in place,
delay clamped to maxDelay. Delay 0 is a TRUE pass-through — the ring still records so a later plan reads real history,
but the samples come back bit for bit. No interpolation anywhere: PDC is whole samples, and it is instant (a glided
delay would pitch-bend).
**Engine — `core/Mixer`:** `rebuildPdc()` computes the two tiers — tier 1 `maxChan` over every live CHANNEL, tier 2
`maxBus` over every live SEND/BUS (the master is in neither: its own chain latency IS the mix's latency) — and gives
each strip `pdc = max(0, tier − own)`. Recomputed on `addFx` / `removeFx` / `clearFx` / `setFxBypass` / `setStripKind`
and after `prepare()` restores the saved chains. The delay sits in `processStrip` AFTER the inserts and BEFORE the
width/fader, so the meters and the sends see the aligned signal. Tier 2's other half: a CHANNEL's direct leg to the
master is summed into `masterDirectL_/R_` instead of the master's input and delayed ONCE by `maxBus` at the top of
`processStrip(master)` — linear, so identical to the page's per-strip `toMaster` DelayNodes and 63 delay lines cheaper.
`setPdc(on)`, `pdcOn()`, `pdcDelay(strip)`, `pdcToMaster()`, `pdcMaxChan()`; `kMaxPdcSamples` 4096.
**Bit-exactness is preserved where it matters:** with PDC off, or with no latency device anywhere in the mix, nothing
is delayed AND nothing is diverted (the direct leg is only taken when `pdcMaxBus_ > 0`), so the summation order is
unchanged and the mix is bit-identical — gated.
**Command / snapshot / shell:** `mixerSetPdc {on}` (`Command::mixerSetPdc`); snapshot `mixerPdcOn`, `mixerPdcMaxChan`,
`mixerPdcToMaster`, `stripPdc[64]`; the shell publishes `mixer.pdc` / `pdcMaxChan` / `pdcToMaster` / `pdcPlan
{"<strip>": samples}` (live strips with a real delay only).
**Page:** `MixerNativeSink.pdc?(on)` — `MixerEngine.setPdc` reports through it, and `nativeMixerShadow.attach()` sends
the saved setting. ONLY the switch crosses the bridge: the engine owns every chain's latency, so it builds the plan
itself and publishes it back. The existing PDC button (MixerSection.tsx, next to CONSOLE) and the Help entry needed no
change — they already drive `MixerEngine.setPdc`.
**Tests — `tests/engine/test_pdc.cpp` (7 cases):** gated on TIMING, not on a description. A COMP at RATIO 1 / MAKEUP 0
is an exact 288-sample look-ahead delay at 48 k, so: an empty mix has a flat plan and every `stripPdc` 0; the plan
follows the latencies, the bypass, a second send catching up to the longest bus, the switch and `clearFx`; **tier 1** —
a COMP on channel 1 and a clean channel 2 put ONE impulse on sample 288 (with PDC off: two impulses, at 0 and 288, and
they sum to exactly what the aligned one carried — the alignment moved signal in time and nowhere else); **tier 2** —
channel 1 dry to the master and channel 2 through a bus carrying the COMP land on ONE sample too, with the same
conservation check; a latency-free mix is bit-identical with PDC on and off; `IntDelay` is a bit-exact pass-through at
0, an exact 100-sample shift across block boundaries, and clamps a silly delay to `maxDelay` without reading out of
range. The two-rig method matters: comparing PDC-on against PDC-off in the SAME rig fails, because the COMP's detector
keeps settling between triggers — drive two identically-commanded rigs instead.
**Probe:** part 8 gains `mixerPdcPlan` / `mixerPdcOff` / `mixerPdcOn` / `mixerPdcCleared` (a COMP on 'sample' → the
plan appears and 'kick' catches up to exactly `pdcMaxChan` while 'sample' stays at 0 → the switch flattens it → back
on → removing the device empties it), all folded into `mixerPageOk`.
**Gates (4.4):** mac-debug 0 warnings + ctest **240/240** (233 + 7) · RTSan 241/241 · universal (0 warnings) lipo
`x86_64 arm64` + ctest 240/240 · ui gate (tsc baseline 5) · probe OK on debug AND universal (`mixerPageOk` incl. the
four PDC checks, 9.2 s) · clang-format clean.
**Can improve:** the per-strip lines are 4096 samples each (2 × 33 KB × 64 strips ≈ 4.2 MB of heap in the Mixer,
allocated in `prepare`) — sized for the worst case rather than for the plan; a strip's ring is only WRITTEN while its
own delay is non-zero, so switching PDC on with a big plan reads up to `maxBus` samples of stale silence once (the same
transient the latency device itself causes). Neither is audible in normal use; both are a one-liner if they ever are.
**Honest boundary after 4.4:** live monitoring is compensated. The OFFLINE renderer (4.5) does not run through this
Mixer yet, so exports are still on the page's path — that is exactly what 4.5 is.
**Victor's pass (4.4):** put a COMP or a SAT on one channel and play it against another — they should sit together
now, not smear; put a COMP on a send/bus and the dry channel beside it should stop phasing when the return comes back.
The PDC button should still switch it, and with it off you should hear the old early/late behaviour return. It only
costs latency while such a device is in the mix.

## Phase 4 — 4.5a DONE (THE EXPORT RUNS THROUGH THE MIXER; MASTER IMPULSE == STEM IMPULSE), 2026-08-23 twelfth session

`renderOffline()` already drove the SAME Engine — so the Mixer was technically in the export path, but **nothing
configured it**: every pad defaulted to `strip = −1` (the Phase-3 direct path) and the render spec had no mix. A
bounce therefore skipped the strips, the inserts, the console, the limiter and 4.4's alignment. That is what this
closes: "export == what you hear" is now literal, not aspirational.

**Engine — `core/Mixer` stem tap + export latency:**
- `setStemTap(strip, pair)` copies a strip's output to a hardware pair **in addition to** its normal routing, so ONE
  render produces the master AND every trackout, aligned by construction rather than by N separate passes. The tap is
  post insert / PDC / width / fader / mute / pan and PRE the master's chain + limiter — a trackout is a post-strip
  stem. Command `mixerSetStemTap`; a strip going `off` drops its tap.
- `outputLatencySamples(strip)` — how late that strip's output runs against true zero: `own chain + its PDC delay`
  (which is exactly the tier, maxChan or maxChan+maxBus, when PDC is on), and for the MASTER additionally the tier-1
  + tier-2 upstream, its own chain, and the limiter's look-ahead. With PDC off it degrades to the strip's own chain.

**Renderer — `RenderSpec::mixer` (`RenderMixerSpec`):** strips (kind, seed, fader, pan, width, mute, solo, 4 sends,
output target, insert chain with per-param values + bypass, stem tap), console on/flavour/amount, limiter, pdc,
`trimLatency`. `enabled = false` is the default, so **every pre-4.5 render is byte-unchanged** (gated).
**Head-trim:** the render runs past the end by `2·kMaxPdcSamples + blockSize` and each output pair is then shifted
left by its OWN latency, reported back in `RenderResult::pairLatency`. That is what makes the headline gate true.

**A real export bug found by the gate, and the rule that came out of it:** the fader test read 0.5 where 0.25 was
due. **Activating a strip snaps its smoothers to whatever the settings currently say** — so sending `mixerSetFader`
AFTER `mixerSetStrip` makes the export glide in from unity over the 8 ms tau, and the first note of every bounce
plays at the wrong level. Live that glide is the point; in a bounce it is a bug. The renderer now pushes every
smoothed value (fader / pan / width / mute / solo / sends) BEFORE the strip is activated. **Rule: an export must
start SETTLED — order the commands so nothing is still gliding at sample 0.**

**Tests — `tests/engine/test_export_mix.cpp` (8 cases):** no mixer section = the Phase-3 direct path bit-exact; the
strip's fader is really in the bytes (the settled-start rule); **MASTER IMPULSE == STEM IMPULSE** — a COMP on one of
two channels, each tapped, and all three pairs put their impulse on sample 0 while the master equals the two stems
summed to 1e-6 (a trackout set that rebuilds the master); the same for a BUS return against the dry channel beside
it; the limiter's look-ahead is trimmed off the MASTER alone (the stem never carries it); `trimLatency` off leaves
the alignment delay in the file; PDC off exports the strips misaligned exactly as they play; CONSOLE prints into the
bytes and is a character stage, not a level change.

**Gates (4.5a):** mac-debug 0 warnings + ctest **248/248** (240 + 8) · RTSan 249/249 · universal (0 warnings) lipo
`x86_64 arm64` + ctest 248/248 · probe OK on universal · clang-format clean.

**Honest boundary after 4.5a — what is NOT done:**
- `ProjectRenderer::buildProjectRenderSpec` does not populate `spec.mixer` yet, so a PROJECT export still renders the
  direct path. The plumbing is all here; it needs the project's mixer state, which is Phase-8 persistence territory.
  **Next concrete step for 4.5b.**
- No dither yet (TPDF with the fixed xorshift seeds, WAV == FLAC bit-identity) — `writeWav` still truncates.
- The legacy chopper chain for the single-chop bake is untouched.
- Nothing in the SHELL or the page calls this yet: there is no export verb wired to `RenderMixerSpec`, so the app's
  export buttons are unchanged. 4.5b joins them up.

## Phase 4 — 4.5b DONE (THE PROJECT'S MIX IS IN THE PROJECT'S EXPORT), 2026-08-23 twelfth session

4.5a made the RENDERER able to carry a mix; 4.5b makes a real PROJECT export use the one the user saved. The project
file keeps the mixer as an opaque `var` blob (the page's `MixerPreset`: `channels` / `master` / `console`) — this
turns it into a `RenderMixerSpec` and routes every pad into the strip its route names.

**`StripNamer` (ProjectRenderer.h)** — the page's numbering (`nativeMixerShadow.ts` FIXED_STRIPS) as C++: sample 1 ·
kick 2 · snare 3 · hat 4 · openhat 5 · perc 6 · bass 7 · send1..4 8..11 · click 12, everything else from 13 on first
sight and stable after. **This is a compatibility contract, not a convenience**: a saved chain has to land on the
strip it was saved on. Gated name by name.
**`padRouteName(project, pad)`** — the page's `padRoute`: the pad's own override, else its source's route, else
`'sample'`. Gated including the source-route case.
**`buildMixerSpec(project, namer, extraChannels, stemChannels, masterLimiter)`** — the blob → strips. Faders, pan,
mute, solo, the four sends (always wired to the send returns, as the page wires them), the master strip, and the
console (on / flavour / amount). Each strip's CONSOLE seed is `fnv1a(name)`, the page's own seeding. A serialized
insert becomes a real device through the SAME lookups the live bridge uses (`fxTypeFromId` / `fxParamIndex` /
`fxOptionIndex`), so page KEYS and enum OPTION STRINGS both resolve; **an SC COMP's `SOURCE` is a channel NAME on the
page and a strip INDEX natively**, converted here exactly as `nativeMixerShadow.fxValue()` does it. A device this
build does not know is SKIPPED rather than shifting every slot after it. A channel the blob never mentions still gets
a default strip when a pad routes to it.
**`ProjectRenderOptions`:** `useMixer` (default **false**, so every existing project render is byte-unchanged —
gated), `stemChannels` (names → hardware pairs 1, 2, 3 …), `masterLimiter` (default true; **off = an unlimited master
bounce**, which is also the only way the master is EXACTLY the sum of its trackouts).

**Tests — `tests/engine/test_export_project.cpp` (8 cases):** the strip numbering name by name; `padRouteName`'s
three fallbacks; the blob → spec (fader / seed / send targets / the master / console flavour / a channel the blob
never mentioned); a serialized chain → real devices with keys and enum options resolved; SC COMP `SOURCE` name →
index; the render really carries the project's fader (pull the kick strip to −60 and the kick leaves the bytes);
**trackouts out of the same render** — cross-correlation lag 0 against the master AND, with the limiter off, equal
sample for sample to 1e-6; the limiter is in the bounce by default and can be taken out.

**Two test premises I had to fix, both worth remembering:**
- An ONSET-THRESHOLD alignment check is not a valid measure once a limiter is in the path — its transient shaping
  moves the crossing (the master read 15 where the stems read 6, with nothing actually misaligned). **Measure
  alignment by cross-correlation lag; it is immune to level shaping.**
- The master is NOT the sum of its trackouts while the safety limiter is in — the makeup alone lifts +0.57 dB. That
  is correct behaviour (a trackout is post-strip, pre-master), not a bug to tolerate: the exact null test needs
  `masterLimiter = false`.

**Gates (4.5b):** mac-debug 0 warnings + ctest **256/256** (248 + 8) · RTSan 257/257 · universal (0 warnings) lipo
`x86_64 arm64` + ctest 256/256 · probe OK on universal · clang-format clean.

**Honest boundary after 4.5b — still owed by 4.5:**
- **Nothing in the SHELL or the page calls this yet.** There is no export verb wired to `useMixer` / `stemChannels`,
  so the app's export buttons still produce the old bytes. That is the next step (4.5c) and it is the one the user
  can actually hear.
- No dither (TPDF with the fixed xorshift seeds, WAV == FLAC bit-identity) — `writeWav` still truncates.
- The legacy chopper chain for the single-chop bake is untouched.
- Drums / bass / the CLICK do not have their sources routed into strips in the offline path yet (the chop pads do);
  they still take the Phase-3 direct path in a bounce.

## Phase 4 — 4.5c DONE (THE DRUM MACHINE IS IN THE BOUNCE), 2026-08-23 twelfth session

**The gap this closes was bigger than "not routed to strips": a project render was CHOPS ONLY.** `renderProject`
built pad specs and flattened the chop sequence to events, and that was the whole export — a bounce of a real beat
had no drums in it at all. Anyone reaching for the native exporter would have got a broken file.

**How:** the engine's OWN `DrumSequencer` renders it. Not a translation to `RenderEvent`s — the same object that
plays, so the bounce carries the same swing, the same per-step VELOCITY / SHIFT / PAN / REPEAT graphs and the same
mute-group choke order by construction. `RenderSpec` gains `RenderDrumsSpec` (pattern + graphs by `shared_ptr`, the
lanes, swing / master / ppq) and `tempoBpm`; `renderOffline` binds lane L to pad `kDrumPadBase + L` exactly as the
live shadow does (chokeGroup = `1000 + muteGroup`, the 4 ms `DRUM_CHOKE_S` fade, hermite), then `drumSetLane` ×N,
`drumSetGraphs`, `drumSetPattern`, `drumSetParams`, `drumPlay`.

**`buildDrumsSpec(project, bank, namer)`** parses the page's `DrumPreset` blob: tracks → lanes in the preset's own
order (which is how the page hands slots out), the current sequence's per-lane step rows → the pattern's lane bits,
and the four graph rows → the shared `DrumGraphs`. Details that matter:
- **An old preset with no `gridRes` was written at its VIEW resolution** and the page upscales it to INTERNAL_SPB on
  load — so this does too. Without it a 1/16-stored pattern would play six times too fast. Gated.
- **Mute / solo are resolved here**, the way the UI resolves them before the engine ever sees them (any solo
  anywhere silences the un-soloed).
- **A lane whose audio is missing still holds its slot** (silent) so the graphs and mute groups keep their lane
  indices — otherwise every lane below a missing sample would shift and play the wrong part.
- The renderer never resolves the drum CATALOG (sampleIndex + genre → a bundled/R2 file is the shell's job):
  `SampleBank::drumLanes` is handed in by the caller, exactly like pad sources.
- With `useMixer`, each lane takes its strip from the same `StripNamer` — kick 2, snare 3, … — so drum trackouts
  fall out of the same render.

**`ProjectRenderOptions::renderDrums`** defaults to **false**, so every existing project render is byte-unchanged
(gated explicitly).

**Tests — `tests/engine/test_export_drums.cpp` (8 cases):** blob → pattern bits / graphs / lanes / master / ppq; the
old-preset upscale; the solo and mute laws; a missing lane keeps its slot; **the drums are in the bounce at the
sequenced times** (kick on the 1, snare a second later at 120 BPM, silence between); without `renderDrums` the render
is silent; each lane sums into its own strip and comes out as a trackout, with the master equal to the trackouts
summed to 1e-6; the lanes land on the page's strip numbering.

**Gates (4.5c):** mac-debug 0 warnings + ctest **264/264** (256 + 8) · RTSan 265/265 · universal (0 warnings) lipo
`x86_64 arm64` + ctest 264/264 · probe OK on universal · clang-format clean.

**Still owed by 4.5:**
- **BASS is still not in the offline render** — same shape of gap as the drums were: the engine has `BassSequencer` +
  `BassSynth`, the project has a `bass` blob, nothing joins them offline. That is the next unit.
- **Nothing in the SHELL or the page calls any of this yet** (no export verb), so the app's export buttons are still
  the page's Web Audio path. Do this AFTER bass — moving the button to a chops+drums-only renderer would be a
  regression against what the page already produces.
- No dither (TPDF, fixed seeds, WAV == FLAC bit-identity); `writeWav` truncates.
- The legacy chopper chain for the single-chop bake.

## Phase 4 — 4.5d DONE (THE BASS IS IN THE BOUNCE; ONE BASS PARSER FOR LIVE AND EXPORT), 2026-08-23 twelfth session

The last of the three instruments to reach an export. Same shape as the drums: the engine's OWN `BassSequencer` +
`BassSynth` render it, so the patch, the slides and the BEND lane in a bounce are the ones that were playing.

**The parser moved into the engine — `engine/render/BassSpec.h/.cpp`.** `bassPatchFromVar` (the worklet's
`mergePatch(defaultPatch(), patch)` deep-merge, ~110 lines) and the wave / LFO-wave / mod-target enum mappers used to
live in `app/WebShell.cpp`, reachable only by the live bridge. The offline exporter needs exactly the same reading of
exactly the same JSON, and **a second copy would drift — a patch that reads differently in a bounce than it sounds
live is precisely the bug "export == what you hear" exists to prevent.** WebShell now calls
`render::bassPatchFromVar` / `render::bassPatternFromVar`; its own copies (and the `setBassPattern` body) are gone.
Verified live as well as offline: the app probe's `bassPageOk` is green through the refactor.

**`bassPatternFromVar` accepts the BEND lane in BOTH shapes** — a real trap, because the two callers disagree:
`nativeBassShadow` sends the lane **already sampled per tick** (plain numbers), while a **project file stores the
page's breakpoints** `[{beat, semis}]`. The parser detects which it has and, for breakpoints, samples them per tick
with the page's `bendAt` law (flat before the first, flat after the last, linear between). Gated by building the same
ramp both ways and requiring the two tick arrays to match.

**`buildBassSpec(project, namer)`** reads the `bass` blob (patch / patterns / currentIdx), takes the current pattern
and gives the synth its strip. An empty roll leaves it disabled. `renderOffline` sends `setSourceStrip(bass)`,
`bassSetPatch`, `bassSetPattern`, `bassPlay`. `ProjectRenderOptions::renderBass` defaults to false.

**Tests — `tests/engine/test_export_bass.cpp` (7 cases):** the blob → patch + pattern (and the patch really is the
project's, not the defaults — cutoff 800, DIODE, drive 3); an empty roll renders nothing; **the BEND lane in both
shapes agrees tick for tick**; breakpoints are flat before the first and after the last and linear between; the bass
is in the bounce at the sequenced beats and silent without `renderBass`; it sums into the bass strip and comes out as
a trackout equal to the master to 1e-6; it lands on strip 7.

**Gates (4.5d):** mac-debug 0 warnings + ctest **271/271** (264 + 7) · RTSan 272/272 · universal (0 warnings) lipo
`x86_64 arm64` + ctest 271/271 · probe OK on universal (`bassPageOk` green through the parser move) · format clean.

**Where 4.5 stands now:** chops, drums AND bass all render offline through the same engine and the same mixer, with
trackouts and alignment gated. **The renderer is complete enough to move the export button onto.** Still owed:
- **No export verb in the shell / page yet** — the app's buttons are still the page's Web Audio path. THIS IS NEXT.
- No dither (TPDF, fixed seeds, WAV == FLAC bit-identity); `writeWav` truncates.
- The legacy chopper chain for the single-chop bake.
- The metronome/CLICK is not rendered offline (deliberate — a bounce should not click).

## Phase 4 — 4.5e DONE (THE EXPORTER IS ON THE BRIDGE: A PROJECT RENDERS TO WAV NATIVELY), 2026-08-23 twelfth session

4.5a–d built a renderer that carries the whole mix; 4.5e makes it reachable. `terminatorExport` renders the page's
project through the SAME engine, mixer, sequencers and devices that are playing, and writes the WAVs.

**The shape, and why:** the page owns the project, so it hands the JSON over; the audio is ALREADY in the sample
store (the page uploaded it), so it hands over **key maps, not bytes** —
`{project, main?, sources{videoId: key}, drumLanes{lane: key}, path, bitDepth?, sampleRate?, loops?, tail?, mixer?,
drums?, bass?, limiter?, stems[]}` → `{ok, files[], seconds, sampleRate, bitDepth, peak}`. Trackouts land beside the
master as `"<name> - <channel>.wav"`.

**Threading:** the render runs on its own `std::thread` and completes the promise back on the message thread.
`renderOffline` builds an Engine of its OWN, so the live engine and the audio callback are never touched — the only
shared state is the sample buffers, and `SampleRegistry::shared(key)` (new) hands the render a `shared_ptr` so they
cannot be freed underneath it. `WebShell` carries an `alive_` flag its destructor clears, so an export still running
when the window goes away completes into nothing instead of a dangling `this`.

**Page:** `native.exportProject` on the bridge (juceBridge.ts) and `src/renderer/native/exportNative.ts` with the
typed request/result. **The app's export BUTTONS are deliberately not moved yet** — that is a UI change with its own
decisions (format menu, progress, cancel, where files land), and it wants Victor's call.

**Probe:** the self-test uploads a 0.25 s burst straight into the sample store, builds a one-pad one-hit project,
renders it through the real engine and asserts a real WAV landed. `tools/ci/probe-app.sh` now fails the build unless
`export.ok`, `export.bytes > 0` AND **`export.peak > 0`** — a render that writes a file full of silence is a FAILED
export, not a pass, and without the peak check the other two would happily pass one. Measured on both builds:
`{"ok": true, "files": 1, "seconds": 2.2, "bitDepth": 16, "peak": 0.32, "bytes": 422504}`.

**Gates (4.5e):** mac-debug 0 warnings + ctest 271/271 · RTSan 272/272 · universal (0 warnings) lipo
`x86_64 arm64` + ctest 271/271 · ui gate (tsc baseline 5) · probe OK on debug AND universal incl. the new export
checks · clang-format clean.

**Still owed by 4.5:**
- **The app's export buttons still use the page's Web Audio path.** The native verb is there and proven; moving the
  UI onto it is the next decision (and needs Victor: formats offered, progress + cancel, output folder).
- No dither (TPDF, fixed seeds, WAV == FLAC bit-identity); `writeWav` truncates.
- No progress or cancel on a long render (the thread runs to completion).
- The legacy chopper chain for the single-chop bake.
- FLAC / MP3 encoders (the TS FLAC encoder is gated bit-identical and is the one to port).

## Phase 4 — 4.5f DONE (WAV + FLAC + MP3, AND THE DITHER THAT MAKES THEM MATCH THE SHIPPING APP), 2026-08-23

Victor asked for all three formats and asked whether dither was worth adding. **It is, and not mainly for
audio-quality reasons: the Electron app ALREADY applies TPDF with fixed xorshift seeds, and its `test:export-flac`
gate asserts WAV and FLAC come out bit-identical. A native exporter that truncated would produce different files
from the app people already have — a parity break, which is the one thing this rebuild cannot afford.** It is also
the right call on merit at 16-bit: truncation error is correlated with the signal and audible as grit on reverb
tails and fades; TPDF turns it into benign noise near −93 dBFS.

**`engine/render/AudioFileWriter.h/.cpp`:**
- `quantizeTpdf16` is a port of the app's own `quantizeTPDF16` (src/renderer/audio/flacEncoder.ts) — two xorshift32
  streams seeded `0x2545f491` / `0x9e3779b9`, ONE triangular draw per sample per channel in INTERLEAVE order,
  `x·32767 + dither`. **The trap: JavaScript's `Math.round` rounds half toward +infinity, `std::round` rounds half
  AWAY FROM ZERO — they disagree on every negative half-sample. The port uses `floor(v + 0.5)`.** Gated against a
  fixture generated by running the app's own function.
- WAV and FLAC at 16 bits are both written FROM THAT ONE QUANTISER (JUCE takes int32 and keeps the top 16 bits), so
  they hold identical samples by construction rather than by two paths agreeing. 24-bit and float take JUCE's float
  path and are NOT dithered — 24 bits is below the noise floor of anything, float has no quantisation step — and the
  dither happens ONCE, at the export edge.
- FLAC is JUCE's bundled libFLAC, so the 521-line TS encoder did NOT need porting.
- MP3 drives a `lame` EXECUTABLE through `JUCE_USE_LAME_AUDIO_FORMAT` (nothing links liblame, so the app stays clear
  of LAME's LGPL — the binary is a packaging concern, not a linking one). `findLameBinary` takes the bundled tools
  dir first, then the usual install paths; **missing lame is a clear error, never a silently-wrong file.**
- **A real bug the gate caught: JUCE's quality-option list is ten VBR levels FIRST (0 = best … 9 = SMALLEST) and only
  then the CBR rates. My first mapping picked index 9 for "320 kbps", which asks lame for its WORST encode (`-V 9`,
  ~65 kbps).** `mp3QualityIndexFor` now maps a requested kbps to the nearest real CBR rate (`--cbr -b 320`), gated.

**The export verb** takes `format` ('wav' | 'flac' | 'mp3') and `mp3Kbps`, replaces the path's extension to match,
and names trackouts with it. **Probe:** the self-test now renders the same project to WAV *and* FLAC and the build
fails unless the FLAC exists, has bytes, and is SMALLER than the WAV (lossless compression really happened).
Measured both builds: WAV 422504 bytes, FLAC 39035, peak 0.32.

**Gates (4.5f):** mac-debug 0 warnings + ctest **279/279** (271 + 8) · RTSan 280/280 · universal (0 warnings) lipo
`x86_64 arm64` + ctest 279/279 · ui gate (tsc baseline 5) · probe OK on debug AND universal · clang-format clean.
(The universal probe failed `prefsWindow` once immediately after a build and passed idle — the known CPU-load
flakiness: a DIFFERENT check each run = flaky, the SAME check every run = real.)

**Still owed on the export:** progress + cancel on a long render (Victor asked for both — NEXT); the Ableton-style
export dialog with every option incl. trackouts (Victor's design call — NEXT); bundling a `lame` binary per platform
so MP3 works on machines without one; the legacy chopper chain for the single-chop bake.

## Phase 4 — 4.5g DONE (PROGRESS + CANCEL ON A RENDER), 2026-08-23

Victor asked for both. A bounce of a long arrangement is the one place the app can appear frozen, and a cancel that
leaves a half-written file behind is worse than no cancel at all.

**Engine:** `RenderCallbacks { onProgress(0..1) → bool, everyBlocks }` passed to `renderOffline` / `renderProject`.
Returning **false aborts**, and `RenderResult::cancelled` says so. **A cancelled render returns EARLY with a partial
buffer and the caller must not write it** — the shell honours that: on cancel it writes nothing at all, so no
half file is ever left on disk. Reporting defaults to ~every 1% of the render, so the callback is never the cost.

**Shell:** the export verb takes an `id`; progress rides the normal event stream as `terminator.exportProgress`
`{id, pct}`, throttled to WHOLE PERCENTS (the page draws a bar, not a firehose). `{verb: 'cancel', id}` flips that
job's flag and the render thread notices at its next report. Jobs are held in `exportCancels_` and **erased when
they report back**, so the map cannot grow; cancelling a finished id simply fails. `this` is captured by the render
thread but only ever dereferenced inside the message-thread callbacks, after `alive_` confirms the shell is still
there — and since the destructor clears that flag on the same thread, there is no window between the check and the
use.

**Page:** `exportProjectNative(req, onProgress)` returns `{done, cancel, id}` and unsubscribes its listener when the
promise settles.

**Gates (4.5g):** mac-debug 0 warnings + ctest **282/282** (279 + 3) · RTSan 283/283 · universal (0 warnings) +
ctest 282/282 · ui gate (tsc baseline 5) · probe OK on debug AND universal · clang-format clean.
Engine tests: progress rises monotonically and reaches 1.0; returning false stops on the exact report asked for and
leaves `blocksProcessed` far short of the full length; a render with no callbacks is bit-identical to before.
**Probe:** `progressReports: 101`, and the cancel case asserts all three of `cancelled`, `cancelWroteNothing` and
`cancelLeftNoFile` — the last one is the point: a cancelled export must not leave a stub on disk.

**Still owed on the export:** the Ableton-style dialog (NEXT — Victor's design: one popup, every option, trackouts
inside it); bundling a `lame` binary per platform (QUEUED as its own task); the legacy chopper chain for the
single-chop bake.

## Phase 4 — 4.5h DONE (SONG MODE: EVERY SEQUENCE, NOT JUST THE CURRENT ONE), 2026-08-23

**Found while sizing the export dialog, and it would have been a REGRESSION if the dialog had shipped first.** The
app's own Master Mixdown (`ChopperEngine.exportMaster`) walks `sequences` with a running cursor and renders every
pattern back to back. `buildProjectRenderSpec` rendered only `planner.currentSequence()` on repeat — so moving the
Master Mixdown button onto the native renderer would have exported ONE PATTERN where the app exports the song.
(The claim in "4.5d DONE" that the renderer was "complete enough to move the export button onto" was wrong on this
point.)

`ProjectRenderOptions::allSequences` (verb: `song`) now concatenates the run: each pattern's duration is its OWN
bars × resolution clamped to `kSeqMaxSteps`, so patterns of different lengths follow one another correctly, and
`loops` repeats the whole run. Off = the current sequence only, which is what a pattern bounce wants — and with a
single sequence the two are bit-identical (gated).

Worth noting for parity: the app's `exportMaster` renders CHOPS ONLY. The native song render also carries the drums
and the bass through the mixer, so it is strictly more complete, not just equal.

**Gates (4.5h):** mac-debug 0 warnings + ctest **284/284** (282 + 2) · RTSan 285/285 · universal (0 warnings) +
ctest 284/284 · ui gate (tsc baseline 5) · probe OK on universal · clang-format clean.
Tests: two 1-bar sequences render 4 s of audio with real content at the start of the SECOND bar (which the
single-pattern render has as silence); song mode with one sequence is sample-identical to not asking for it.

**Still owed on the export:** the Ableton-style dialog (NEXT). MP3 binary bundling is 4.5i below.
**This commit shipped BROKEN:** it swept in a concurrent session's half-finished `lame` work — `WebShell.cpp` calls
`ProcessHub::lameBinary()` and `exportNative.ts` probes for it, but neither existed yet, so `71177a4` does not
compile. 4.5i is the commit that completes it. One session per repo, always.

## Phase 4 — 4.5i DONE (THE `lame` BINARY SHIPS WITH THE APP), 2026-08-23

MP3 export worked only on a machine that happened to have `lame` installed — Victor's would, a customer's would not.
`cmake/ProvisionTools.cmake` (the yt-dlp/qjs hook) now provisions it too, landing at `Resources/bin/lame` (mac) /
`<exe>/bin/lame.exe` (Windows) — exactly where `ProcessHub::lameBinary()` looks and `render::findLameBinary` prefers
it over anything on the machine.

- **Still a packaging concern, not a linking one.** The app drives the executable through JUCE and links no part of
  LAME, so shipping the unmodified upstream binary as a separate program keeps us clear of the LGPL. Credited beside
  yt-dlp in the EULA modal, with the source URL — the notice LGPL actually asks for.
- **Mac COMPILES it; Windows downloads it.** There is no trustworthy prebuilt macOS `lame`, and none universal at
  all: Homebrew's is per-OS-version, ships behind a ghcr token, and would have to be relocated. So mac builds the
  pinned 3.100 tarball (SHA-256 `ddfe36ca…`) in ONE clang pass with both `-arch` flags — every autoconf answer here
  is arch-independent (both little-endian LP64), so a second configure would only be a second chance to disagree —
  giving one universal, dependency-free executable (system libs only). ~20 s, ONCE per machine: the result is cached
  in `third_party/.tools-cache` as `lame-3.100-macos-universal`, and the existing stamp file skips the whole script.
  Windows takes RareWares' prebuilt x64 `lame.exe` (the binary lame.sourceforge.net points at) — its PE import table
  is only KERNEL32 + SHLWAPI, so it is fully static and the zip's `lame_enc.dll` is deliberately NOT shipped.
- **We ad-hoc sign it ourselves.** The linker's own ad-hoc signature survived a hand build and vanished under the
  cmake one — the same binary, unsigned. An arm64 Mach-O without a valid signature is a coin toss macOS gets to call
  at export time, so the script runs `codesign --force --sign - --identifier lame` and then VERIFIES, failing the
  build (and deleting the cached copy) if either step does not hold. **At release, `Contents/Resources/bin/**` must
  be re-signed with the Developer ID `--options runtime --timestamp` BEFORE the app** — ad-hoc alone fails
  notarisation. Written into BUILD-RULES.md.
- **The gate is the real thing, not the file's presence.** The export self-test now renders the probe project to MP3
  as well, reports `lameBundled` + `lamePath` + `mp3Ok` + `mp3Bytes`, and `probe-app.sh` fails when a build ships a
  `lame` and the MP3 does not come out with bytes in it.

**Verified with `/opt/homebrew/bin/lame` renamed away** (and no `/usr/local/bin/lame`, no `/usr/bin/lame`): both the
debug and the universal app exported a 90,240-byte MP3 through their own `Resources/bin/lame`. That is the claim
that matters — "it works on a machine with no lame" — and it is the one the CI probe now re-checks every run.

**Gates (4.5i):** mac-debug 0 warnings + ctest **284/284** · RTSan 285/285 · universal (0 warnings) + ctest 284/284 ·
ui gate (tsc baseline 5) · probe OK on debug AND universal, MP3 leg included · bundled `lame` is `x86_64 arm64` and
`codesign --verify` clean. The only build warning is JUCE's pre-existing `terminator-render` bundle-id-with-spaces.

## Phase 4 — 4.5j DONE (THE EXPORT DIALOG), 2026-08-23

Victor's brief: "trackouts in same export box like ableton, so when you click export the export popup window comes
up that has all export options". `ExportModal.tsx` is that box — **Rendered Track** as cards (Master Mixdown /
Trackouts / MPC Project / Ableton Drum Rack) then **File** (format, and the bitrate when it is MP3), then Export.
Trackouts are a thing you RENDER, beside the master, rather than a separate control elsewhere. The EXPORT section
is now one button that opens it.

**What renders the audio did NOT change** — the page's `exportArrangement` is still the only thing that knows the
Beat Finisher arrangement, and it stays the authority. The dialog adds three things around it:
- **MP3 without a second render path.** The page renders as it always did, then the shell re-encodes the written
  file: `terminatorExport {verb: 'transcode', from, to, format, mp3Kbps}` reads it with JUCE and writes it through
  the SAME `writeAudioFile` (so the same app-parity dither) — the MP3 carries the samples the WAV would have. The
  intermediate WAV is trashed once the MP3 lands, so only the deliverable remains.
- **A real CANCEL.** `ExportArrangementOpts::shouldCancel` is polled at every progress point and throws
  `ExportCancelled` **before anything is written** — the same rule the native renderer keeps, so a cancelled export
  never leaves a partial file. Esc cancels a running export and closes the box otherwise.
- Progress with the renderer's own stage labels.

**Help updated in the same commit** (house rule): the Exporting topic now describes the box, the cancel behaviour and
the Esc key, and "WAV or FLAC" became "WAV, FLAC or MP3" with the bitrate note.

**Gates (4.5j):** ui gate (tsc baseline 5) · mac-debug 0 warnings + ctest 284/284 · RTSan 285/285 · universal
(0 warnings) + ctest 284/284 · probe OK on debug AND universal (`chopperView` true, `errors: []`) · clang-format
clean. The universal probe also shows the sibling session's work green: `lameBundled: true`, `mp3Ok: true`,
`mp3Bytes: 90240` — MP3 encodes from the BUNDLED lame.

**NEEDS VICTOR — the dialog has not been LOOKED at.** The page only mounts inside the shell, so it cannot be
verified in a plain browser; the probe proves it renders without errors, not that it looks right. Open EXPORT and
check the layout, then try a cancel mid-render. Fast loop for tweaks, no rebuild:
`cd ui && npm run dev` then launch the app with `TERMINATOR_UI_URL=http://localhost:5173`.

**Still owed on the export:** bit depth and sample rate are not in the box yet — `exportArrangement` hardcodes
`bitDepth: 16` and renders at the engine's rate, so showing those controls would have meant showing controls that do
nothing. Wiring them through is the next step. Also: the legacy chopper chain for the single-chop bake.

## Phase 4 — 4.5k DONE (BIT DEPTH IN THE BOX; THE RATE STATED, NOT FAKED), 2026-08-23

The two controls 4.5j deliberately left out, now that they can be real.

**Bit depth 16 / 24.** `ExportArrangementOpts::bitDepth` already existed and already reached
`renderArrangementMix` — `runExport` was simply pinning it to `16 as const`. It is a parameter now and the box has
a BIT DEPTH row. **The catch: the page's FLAC encoder is 16-bit only** (`encodeFLAC(quantizeTPDF16(…), …, 16)`), so
a 24-bit FLAC cannot come from it. Rather than quietly hand back a 16-bit file, 24-bit FLAC renders a 24-bit WAV and
has the SHELL write the FLAC through `writeAudioFile` — the same route MP3 already takes. In a browser (no shell)
24-bit is offered for WAV and disabled for FLAC, with the reason in the tooltip. Gated: a 24-bit FLAC reads back at
`bitsPerSample == 24`, and digital silence stays silent in it (dither belongs at a 16-bit reduction and nowhere else).

**Sample rate is NOT a control, and the box says so.** The arrangement renders at the loaded track's rate and
nothing resamples; a menu that silently did nothing — or silently resampled — would be worse than a sentence. The
dialog states the project's rate instead.

Help updated in the same commit: a "16 or 24 bit" entry (what each is for, and that 16 is dithered on the way down)
and a "Sample rate" entry explaining why there is no menu.

**Gates (4.5k):** ui gate (tsc baseline 5) · mac-debug 0 warnings + ctest **285/285** (284 + 1) · RTSan 286/286 ·
universal (0 warnings) + ctest 285/285 · clang-format clean.

### The probe's `prefsWindow` on THIS machine — environment, not code
Local probes started failing `prefsWindow` (openPreferences reports ok and `prefsReady` is true, but the window is
not `isVisible()` at the final read) — **three consecutive runs, idle, and it reproduces on a CLEAN HEAD with my work
stashed, so it is not the change in flight.** CI on the SAME commit reports `"prefsWindow": true`. So this is the
host's window-server state (the machine slept mid-session), not a shipped bug — do not chase it as one. **The rule
"same check every run = real" needs the companion clause: real to THIS MACHINE. Cross-check CI before believing a
local-only failure.** If it ever fails on CI it is BUG E territory (a window that cannot come to the front).

## Phase 8 — 8.5c DONE (THE LICENCE IS ENFORCED — AN ACCOUNT UNLOCKS IT), 2026-08-25 twentieth session

His call (2026-08-25: "it should unlock with an account. just like terminator electron"). The mechanism landed
in 8.5a and was deliberately never armed: `isSubscribed()` returned `true` unconditionally in the native build
and `checkLicenseGate` never showed the overlay, so every native build was the complete app, free, to anyone who
ran it. Both escape hatches are gone. Native now takes the SAME path as Electron — the device token in the OS
keychain, `/api/terminator-check` on every launch, the 7-day offline grace, free tier (3 pads, 10 pulls) until
an account signs in.

**Flipping it exposed four things that were only ever dead code behind the hatch**, all of which a paying
customer would have hit within a minute of seeing the paywall:
- **The popup offered "Download the desktop app" to somebody already running the desktop app** (his report). On
  desktop that button is now **"Already own it? Sign in →"**, which is what an existing owner actually needs.
  The "install it on your Mac or PC" pitch and the "NEW · NOW ON macOS & WINDOWS" badge are dropped there too.
- **GET TERMINATOR — $40 could not work.** It POSTs to a same-origin `/api/checkout/terminator-lifetime`, and
  the app is served by the SHELL, not by KCC — so the fetch could only ever fail with a network error. On
  desktop the purchase opens in the BROWSER, where the session cookie lives.
- **SEE THE SUITE would have navigated the app away from itself.** `location.href` in the shell's WebView
  replaces Terminator with a web page and there is no back button to a native window; `window.open` silently
  does nothing there. Every outward link on desktop now goes to the OS browser through the bridge.
- **Preferences → ACCOUNT still said the app "runs UNLOCKED whether you sign in or not"** — true yesterday, a
  lie today. It says what the tiers are now.

**GET TERMINATOR GOES TO THE DOWNLOAD PAGE** (his call, 2026-08-25, seen on the real sign-in modal):
`killaviccheatcodes.app/terminator/download`, not `/terminator`. That page both sells it AND hands an owner the
DMG/EXE, which is the whole of what somebody pressing GET TERMINATOR *inside the app* is after — the product
page would sell it to them and then leave them looking for the app. One constant (`TERMINATOR_BUY_URL` is now
`TERMINATOR_DOWNLOAD_URL`) and one path in the shell's `buy` verb, so the modal, the paywall and Preferences all
move together. **Both destinations are gated now:** with the seam armed the `buy` / `account` verbs no longer
open a browser (the `signIn` verb already worked this way) and simply ANSWER with the URL, so the self-test
asserts `.../terminator/download` and `.../account`. A wrong link is invisible until a customer clicks it.

**ACCOUNT vs BUY are two buttons now** (his call: the KCC account page is `killaviccheatcodes.app/account`). One
button sending everybody to the product page told an existing owner nothing: signed in → **MY ACCOUNT**
(`/account`), signed out → **GET TERMINATOR** (`/terminator`). New shell verb `account` beside `buy`, so the URL
lives where the base URL already does and `TERMINATOR_LICENSE_BASE` still redirects both for testing.

**THE GATE IS ASSERTED FROM BOTH SIDES, because getting this wrong locks him out of his own app.**
- `probeUnlock` (new): the probe now signs in through the seam BEFORE anything else is measured, and asserts
  both halves — with NO account the app is the free tier (`lockedWithoutAccount`) and the gate appears
  (`gatedBeforeSignIn`); after signing in it unlocks (`overlayGone`, `subscribedAfterSignIn`). It had to: with
  the gate on, a probe that never signs in is a free-tier app, and the first run measured the paywall instead of
  the engine — `syncTrigger: false`, `midiMirrored: false`, `triggers: 0`, `menuReachedPage: false`. That is the
  failure a user would call "the pads stopped working".
- **That check was WRONG on its first real use, in the way this repo keeps re-learning.** It read the overlay as
  it happened to be AT MOUNT, which passed against the unsigned build and failed against the PACKAGED one —
  because the signed app could read a probe token an earlier run had left in the Keychain and came up already
  unlocked. A gate that depends on leftover state on the machine, exactly like the old `mixerPdcPlan` and
  `prefsWindow` checks. It now SIGNS OUT first, re-runs the LAUNCH-TIME gate decision itself (a page-side seam
  exposed only when the shell armed the licence seam) and asserts the result — so it measures the build.
- The seam test grew the two checks its own docstring had been claiming: **`offlineGraceUnlocks` + `offlineFlagTrue`**
  (an unreachable server keeps a paying user unlocked — the promise that matters most now) and **`refusedLocks`
  + `refusedDropsToFreeTier`** (a REACHABLE server that refuses the entitlement really does drop the token). It
  also signs back in at the end, so nothing after it measures the free tier.
- A **probe-only `setFake` verb** makes that possible in one launch. Refused unless the ENVIRONMENT already
  armed the seam, and an empty mode is refused too — so a page can never switch a real app onto a fake licence,
  nor switch the seam OFF and point the run at the user's real device token.
- **Mid-session re-gating is NOT claimed.** A refusal drops to the free tier immediately; the sign-in overlay is
  a launch-time decision. Electron has never thrown a modal over somebody mid-beat because a server answered
  oddly, and this build does not start. The gate asserts what the app actually does.

**THE VERSION STAMP RODE ON THE WRONG THING, AND THE GATE CAUGHT IT.** `package-mac.sh` refused its own first
run after the licence work: `CFBundleVersion is '3.0.0' — the POST_BUILD stamp did not run`. A POST_BUILD command
fires only when its target RELINKS, but the Info.plist is regenerated on every **re-configure** — which is the
first thing the release script does. Re-configure without touching a source file and the plist came back
unstamped, so every pre-release would have advertised "3.0.0" and the updater would have offered nobody
anything, silently. The stamp is an `ALL` custom target depending on `Terminator` now (`plutil -replace` is
idempotent, so running every build costs nothing), verified against the exact failing case: a bare
reconfigure + build with nothing changed still stamps.

**THE PROBE'S FINAL READ IS DRIVEN BY COMPLETION NOW, NOT BY A CLOCK.** The 30-second delay was a guess that
held until the sign-in round trip went in front of the async block; the read then landed mid-flight and reported
`licenseSeam: null` — which reads as "no failure" and is really "no check". `readWhenAsyncChecksDone()` polls
the block's own `done` flag (bounded, 60 s of grace) and says so when it waits.

**.tproj / .tprojz CARRY THE TERMINATOR LOGO IN FINDER** (his call). `CFBundleTypeIconFile AppIcon` on both
document types — the 2.x app's `tproj-icon.icns` is BYTE-IDENTICAL to its app icon (md5-checked), so pointing at
the icns JUCE already generates from `resources/icon.png` is exact parity with no second copy of the artwork in
the repo. The probe asserts the key and the file.

**Gates:** mac-debug 0 new warnings · ctest 419/419 · `ui` gate green (tsc 5 = baseline, 0 new; library 39,
clock 23, bass-theory ok) · clang-format clean · **PROBE OK** with `probeUnlock {ok:true}` and the full
`licenseSeam {ok:true}`.
**His pass:** launch it signed out — you should get the free tier and the sign-in overlay; sign in via browser
and it should unlock without a restart; Preferences → ACCOUNT → MY ACCOUNT should open `/account` in your
browser; a folder of `.tproj` files should show the Terminator logo. **NOTE:** quit any other Terminator first —
it is single-instance, so double-clicking the app while a probe run is alive hands you the PROBE's window
(fake audio device, fake licence). That is what the 2026-08-25 "Offline (no hardware)" screenshot was.

## Phase 6 — 6.5 DONE (A KNOB ON YOUR CONTROLLER DRIVES A PLUGIN'S OWN PARAMETER), 2026-08-26

The last gap in Phase 6. Every other parameter in the mixer could be MIDI-learned; a hosted plugin's could not,
because a plugin's knobs live in ITS window and never reach the page.

- The plugin's insert slot gets a **MIDI** button beside EDITOR. It lists what that plugin exposes — the
  `params` verb already existed and already answers in **0..1**, which is exactly what a CC maps onto — and a
  right-click on a row arms MIDI Learn like anything else in the mixer.
- The key is `<channel>:<slot>:plugin#<n>`, deliberately unlike any `FX_REGISTRY` key, and `applyCcToParam`
  branches on it BEFORE the registry lookup that a plugin parameter is not in and never will be. Everything
  under it is the existing path untouched: the learn picker that skips 14-bit LSB partners and 0/127 button
  blips, the mapping store, the `midi-map.json` disk mirror, Clear MIDI. A plugin insert's `fxId` is already
  `'plugin'`, so learn COMPLETION needed no change at all.
- A plain list, not a wall of knobs: the plugin's window is where you turn things, this is only where you say
  "that knob drives THIS". It scrolls, because a synth can have hundreds.

**The gate runs on a machine with real plugins, and CI is not one.** The probe lists the hosted plugin's
parameters, sets one well away from where it was, and reads it back changed — a silent no-op would otherwise
look identical to a working bind. But a GitHub runner has **no plugins scanned** (`plugins61.known: 0`), so
`pluginHosted` is null there and the whole block is skipped: on CI this asserts nothing, by construction. It is
real coverage only on a machine with a VST3 installed — his, and the packaged Mac probe, where the AIR Tape
Echo has been hosting since 6.2. **His pass:** put a plugin on a channel, press MIDI, right-click a parameter,
move a knob on the MPD.

Help entry in the same commit, per the house rule. CI green on all four jobs — after one Windows re-run: that
job hung at launch once (no probe file, 240 s timeout) and passed on the identical commit second time. Worth
watching rather than chasing; a repeat is a real bug.

## Phase 9 — 9.1 (WINDOWS): IT UPDATES ITSELF, IT HAS AN INSTALLER, AND THE PLAN'S GUID WAS WRONG, 2026-08-26

**WinSparkle 0.9.4**, pinned and SHA-256 verified, DLL beside the exe. 0.9.4 specifically: it is the first
release with `win_sparkle_set_eddsa_public_key`, so **both platforms verify downloads against the SAME key
pair** — one `sign_update`, one thing to back up. Windows has no Info.plist, so the feed, the app details and
the key are handed over at runtime in `app/src/Updater.cpp`, from the same two CMake values the macOS plist is
built from. Separate appcast FILES per platform (`appcast-mac.xml` / `appcast-win.xml`): Sparkle can serve both
from one, and one file is exactly the arrangement in which a Mac release breaks Windows.

**`Updater.mm` was being compiled by MSVC and it happened to work** — MSVC treats an unknown extension as C++,
and every line of Objective-C sat behind `TERMINATOR_HAS_SPARKLE`. Luck, not design: the first `@interface`
outside the guard would have broken the Windows build for a reason nobody would guess from the error. It is
Apple-only now, with `Updater.cpp` everywhere else.

**THE PLAN'S UNINSTALL GUID WAS WRONG, AND IT IS LOAD-BEARING.** Plan 9.4b carried
`{F9C641D4-BE56-5228-B95C-A6C4E8B7E310}` as "computed, not guessed" — but computed with a stock RFC-4122 helper.
electron-builder uses **its own namespace** (`50e065bc-3134-11e6-9bab-38c9862bdaf3`, `NsisTarget.js:26`) and its
own `UUID.v5`; running that code against `com.terminator.audio` gives **`{57BAB645-AFD8-5C3D-8FD0-03C8A1FC01D8}`**.
The old value appears nowhere in any real build output. An installer built on it would have written a
stranger's uninstall key: **two Terminator entries in Add/Remove Programs and no upgrade in place** — found only
after shipping the one release that has to work. Plan corrected, with the `reg query` that confirms it against a
real installed 2.2.3.

**The installer** (`tools/release/installer/terminator.nsi` + `tools/release/package-win.ps1`) honours
electron-updater's exact arguments, installs to the same per-user path under the same shortcut names, waits for
a running copy to quit before replacing files, and clears the previous payload's folders (an Electron install
otherwise leaves a whole `resources` tree behind for ever). Uninstall leaves `%APPDATA%\terminator` and
`%APPDATA%\Terminator3` alone, so projects survive. **CI compiles it on every Windows run** — measured
2026-08-26: **33,299,442 bytes**. It cannot be signed yet (9.2, no certificate), so it is SmartScreen-unsigned
like 2.x.

**THE WEBVIEW'S USER DATA WAS IN %TEMP%, AND THAT WAS A HOLE IN THE PAYWALL.** `WebShell.cpp` put the WebView2
user-data folder in temp — which is where the PAGE's `localStorage` lives, and the page keeps the **free-tier
pull counter** there along with the theme, palette, FINISH, layout, UI size and tooltips. Windows may empty temp
whenever it likes, so a free user's ten pulls came back for ever and a paying user's whole look reset without
explanation. It lives beside `settings.json` now (verified on the CI runner:
`C:\Users\runneradmin\AppData\Roaming\Terminator3\WebView2`), with a one-time carry-over from the old
folder, and the Windows smoke step FAILS if it is ever under `\Temp\` again. macOS was never affected.

**THREE RED CI RUNS ON THE macOS arm64 RUNNER, TWO OF THEM REAL PROBE BUGS.** Different check each time — the
bass cursor by 2 ticks, the count-in by one click, the bass cursor again by 1 tick — always with 27-58 xruns and
245-680 ms of transport drift in the same report, and always with Intel and Windows green on the identical
commit. Both fixed checks had the same shape: **they sampled on a clock where they should have waited on a
condition** (a flat 150 ms sleep before a final snapshot read; a single cursor pair). What remained is a machine
too busy to judge millisecond timing, so the STEP is retried once and nothing inside it is loosened. The obvious
alternative — widen the tolerance by the measured drift — was tried and thrown away: at 240 BPM, 680 ms of drift
is 68% of the bass loop, so the check would have passed on anything.

**Gates:** all four CI jobs green on `54576c2`, including the compiled installer.
**Still owed on Windows:** the signing certificate (9.2), an `appcast-win.xml` generator, and the handover drill
itself from a real installed 2.2.3.

## Phase 9 — 9.1/9.2 (Mac): THE APP IS SIGNED, NOTARISED AND CAN UPDATE ITSELF, 2026-08-25 twentieth session

Nineteen sessions of features, and none of them could reach a person: there was no packaging at all — no DMG,
no signing, no notarisation, no updater, and `RELEASE-CYCLES-NATIVE.md` was a one-line stub. An un-notarised
build is Gatekeeper-blocked on every Mac but this one, so "give it to a beta tester" was not a thing that could
happen. It is now one command.

**`tools/release/package-mac.sh`** — build → sign → notarise → staple → DMG + zip into `release/mac/`
(gitignored). It uploads NOTHING; it prints each artefact's size and sha512, which is what the appcast needs.
**Measured 2026-08-25 on `3.0.0-alpha.0`:** app and DMG both `Accepted` by Apple and stapled,
`spctl -a -t install` → **accepted / source=Notarized Developer ID**, zip 160,741,583 B, DMG 179,435,184 B.

**Three real bugs the packaging found, none of which any unsigned run could show:**
- **The app had no icon.** `CFBundleIconFile` was empty — a shipping app with a generic blank document icon.
  `app/resources/icon.png` (the 2.x artwork, so the handover looks like the same app) → `ICON_BIG`, plus the
  copyright and website strings that were also blank.
- **Plugin hosting would have died in the signed build.** A hardened process refuses to load a dylib signed by
  another team, and every VST3/AU a user owns is signed by somebody else. `HARDENED_RUNTIME_OPTIONS` now
  carries `com.apple.security.cs.disable-library-validation`, and the packaged probe proves it:
  `pluginId: VST3-AIR Tape Echo…`, `pluginHosted: true` — a REAL third-party plugin loaded into the
  notarised app.
- **`.gitignore`'s `release/` also matched `tools/release/`**, so the release script itself would have been
  silently untracked. Root-anchored now.

**THE UPDATER — Sparkle 2.9.6, pinned and SHA-256 verified** (`cmake/Sparkle.cmake`, the Onnxruntime pattern),
embedded in `Contents/Frameworks`, driven from `app/src/Updater.{h,mm}` (the app's only Objective-C++ file —
nothing outside it knows Sparkle exists).
- **`SPUUpdater` directly, not `SPUStandardUpdaterController`**, because the standard controller shows the USER
  an alert when the app is misconfigured. That is backwards: the person who can fix a bad feed is us. A failed
  start is a log line and an updater that stays quiet.
- **Check for Updates… is in the app menu — and only when the updater actually started.** A dev build (unsigned;
  Sparkle refuses those) gets no menu item rather than one that cannot work.
- Feed `terminator-native/appcast-mac.xml` — the app's OWN channel. Mac and Windows get SEPARATE appcast files
  even though Sparkle can serve both from one, because one file is exactly the arrangement in which a Mac
  release breaks Windows.
- **The bundle id is now a decision, not a constant.** `TERMINATOR_BUNDLE_ID` defaults to today's
  `app.killaviccheatcodes.terminator` (so 3.0 and the installed 2.2.4 can coexist on this Mac without fighting
  over `terminator://` and `.tproj`), and the packaging script REFUSES to package a non-alpha version under it:
  the 3.0.0 that Electron users auto-update into must be `com.terminator.audio` or Squirrel.Mac will not swap it
  in (plan 9.4b). The switch is a re-configure, and it cannot be forgotten any more.

**NEW GATE — the updater is asserted on the SIGNED bundle.** A shipped app whose Sparkle refuses to start never
tells anybody: users simply stop getting versions, and nobody finds out for a release cycle. Sparkle also
refuses to start in an unsigned build, so this can ONLY be proven on a packaged app. `TERMINATOR_PROBE_UPDATER=1`
(which the packaging script sets, and only it) starts the updater for real with **automatic checks OFF** — a
gate that reaches the network is not a gate — and the probe asserts it:
`updater: {compiledIn: true, attempted: true, started: true, detail: "started", feed: "https://…appcast-mac.xml"}`.

**Signing is bundle-aware.** 110 loose Mach-O files (yt-dlp's ~100 dylibs, qjs, lame, onnxruntime, and
Sparkle's own loose helpers) signed as files; four nested bundles (Sparkle's framework, its `Updater.app` and
two XPC services) signed as UNITS, deepest first. Signing a nested bundle's executables file-by-file leaves its
own seal inconsistent — `codesign --verify --deep --strict` fails and Sparkle refuses to launch its updater.
Versioned frameworks are signed at `Versions/B`, not at the `.framework` wrapper.

**AND "BUNDLES AS UNITS" WAS TOO BROAD — APPLE SAID SO.** An `.app` / `.xpc` / `.bundle` really does seal its own
`Contents/MacOS/…`; a `.framework` does NOT. Signing `Sparkle.framework/Versions/B` seals the loose helper
executables in that directory by hash but leaves their EXISTING signature alone, so
`Versions/B/Autoupdate` went to Apple carrying the Sparkle project's certificate and the whole submission came
back **Invalid**: "The binary is not signed with a valid Developer ID certificate", once per architecture.
Sparkle's own documented recipe signs `Autoupdate` explicitly for exactly this reason.

**AND A SIGNING RUN IS 110 ROUND TRIPS TO APPLE.** Every signature is timestamped, and a timestamp is a call to
`timestamp.apple.com` — back to back, Apple's TSA throttles, and a throttled call failed the whole package run
on one of yt-dlp's Cryptodome `.so` files that signed perfectly a second later. `sign_one` retries three times
with a backoff and PRINTS the real error when it finally gives up (the original swallowed codesign's stderr, so
the first failure said only "codesign failed on <path>"). Same rule the pinned-tool downloads already follow: a
transient timeout is retried, a wrong identity is not.

**NEW GATE — EVERY MACH-O IS OURS, CHECKED LOCALLY.** The reason that reached Apple at all is that
`codesign --verify --deep --strict` PASSES on a bundle whose nested binaries are validly signed by somebody
else — it was happy, and the rejection arrived ten minutes later. The script now asks the question Apple asks:
every Mach-O in the bundle carries `TeamIdentifier=S7QVJJHXJ4` **and** a secure timestamp (an un-timestamped
signature stops verifying the day the certificate expires). Seconds locally against a round trip to the notary
service. Measured: `every Mach-O in the bundle is signed by S7QVJJHXJ4 with a timestamp`.

**THE PRIVATE UPDATE KEY IS THE ONE IRREPLACEABLE THING.** Generated by Sparkle's `generate_keys` into this
Mac's login keychain ("Private key for signing Sparkle updates"); the public half is in `app/CMakeLists.txt`
and the app's Info.plist. **Lose it and no installed copy of 3.0 can ever be updated again.** Export and back it
up — the how is in RELEASE-CYCLES-NATIVE.md, which is now a real runbook (the channel, every gate and why it
exists, the upload order, the rollback rule, and what is still owed).

**AND THE FEED — `tools/release/appcast-mac.sh`** (also uploads nothing). Two more bugs it forced out, both of
which would have shipped an updater that quietly never worked:
- **Every pre-release would have advertised the same version.** JUCE writes `project(VERSION)` into
  CFBundleVersion, which is what Sparkle COMPARES — so `3.0.0-alpha.0` and `3.0.0-alpha.1` were both "3.0.0" and
  no alpha could ever see the next one as newer. CFBundleVersion is now a monotonic integer derived from the one
  version string (`major*1000000 + minor*10000 + patch*100 + rank`; alpha.N → N, beta.N → 50+N, rc.N → 80+N,
  final → 99), so `3.0.0-alpha.0` = **3000000** and the final 3.0.0 = 3000099. Pasting the tag in would not have
  worked either — "3.0.0.7" sorts ABOVE the final "3.0.0". No second number to keep in sync; the packaging
  script asserts the stamp landed.
- **The bundle declared no minimum macOS, so Sparkle GUESSED 10.13** against a build that needs 12.0 — it would
  have offered old Macs a download, a restart and a dead app. `LSMinimumSystemVersion` is stamped from the
  deployment target, and the appcast script asserts the feed matches it.
The script also refuses to regress the LIVE feed (fetched, not remembered), puts only the zip in the feed (the
DMG is the human download), and asserts the EdDSA signature, the enclosure URL and that the URL is not in the
Electron channel. Generated locally for `3.0.0-alpha.0`: one signed item, `sparkle:version 3000000`,
`minimumSystemVersion 12.0`.

**NOTHING HAS BEEN PUBLISHED** (2026-08-25, his instruction). No R2 upload, no push. The feed URL returns 404 —
the appcast script checked and said so. Notarisation is a submission to Apple that stamps the local artefact; it
puts nothing in front of anyone. `release/` is gitignored.

**Gates:** mac-debug 0 new warnings · ctest **419/419** (1 skipped: the htdemucs fixture) · clang-format clean ·
mac-release-universal lipo `x86_64 arm64` · the PACKAGED, notarised app PROBE OK.
**Still owed at Phase 9:** Windows (no installer, no WinSparkle, no `appcast-win.xml`), 9.2's Windows signing
certificate, upload automation, and 9.4b — the bundle-id switch and the real handover drill from an installed
2.2.4 / 2.2.3.
**His pass:** nothing to test by ear here. What is his: open `release/mac/Terminator-3.0.0-alpha.0.dmg`, drag
the app to Applications, launch it from there — it should open with NO Gatekeeper warning and NO right-click →
Open dance, show the Terminator icon in the Dock, and carry **Terminator → Check for Updates…** (which will say
it cannot find the feed until the appcast is uploaded — that is correct, nothing is published yet).

## THE OFFLINE AUDIO DEVICE — insurance for a machine with no sound card (2026-08-25 nineteenth session)

**CORRECTION (same day, from the first CI run that carried this):** the claim this section was written on —
"a GitHub runner has no audio device, so the engine half is skipped on CI" — is **WRONG**. Both the macOS and
the Windows runners come up with a real 44.1 kHz / 64-sample device, and the engine block has been running there
all along. What was actually true is narrower and still worth having: `mixerPdcPlan` passed on CI and failed on
a real machine because **a fresh runner has no saved settings, so PDC defaults ON, while this Mac had it saved
OFF** — the gate never turned it on. The offline device below is therefore insurance and control, not a hole
being filled: it removes the dependency on a runner happening to have a sound card, and it turns "no audio
device" from a warning that skipped half the gate into an error.

- `engine/src/io/NullAudioDevice.cpp` is a real `juce::AudioIODevice` that pulls blocks on its own high-priority
  thread, **paced to the wall clock** at 48 kHz / 512. The pacing is the point: the cursor and drift checks
  compare the engine's sample clock against `performance.now()`, so a device running flat out would prove
  nothing.
- **It never appears by accident.** `TERMINATOR_NULL_AUDIO=1` selects it; `=auto` registers it and falls back to
  it only when nothing real opens; unset — every user's app — and the type is not even registered. On CI it has
  so far never been NEEDED (both runners have a device); it is the safety net for the day one does not.
  `tools/ci/probe-app.sh` sets `auto`, so a machine with an interface is completely unaffected, and "no audio
  device on this machine" is now an ERROR rather than a warning that skipped half the gate.
- **It is never written into the user's saved setup** (`persistAudioSetup` refuses it): a test fixture in
  settings.json would point a real launch at a device that does not exist there. Verified by running the probe
  forced-offline and re-reading settings.json: still CoreAudio.
- Measured on the offline device: PROBE OK with `enginePrepared · seq · drums · bass · metro · liveRec · mixer`
  all true, and the PDC plan at **288 samples = exactly 6 ms at 48 kHz** — the rate-dependent assertion proving
  itself at a second rate.

## Phase 8 — 8.6c DONE (DRAG A PAD OUT INTO YOUR DAW), 2026-08-25 nineteenth session

A chop only existed inside the app: to get one into Ableton you exported a folder of stems and went looking for
it. Now the PAD MENU is a drag source — **his call on where it lives** (2026-08-25: "put pad drag out in pad
edit / right click menu of pad"), in both layouts.

- **The item IS the drag.** `⇱ Drag out` fires on **pointerdown**, not click, because macOS builds a drag
  session from the window's CURRENT MOUSE EVENT — by the time a click resolves, the gesture is over. Press it
  and drag to Finder / Ableton / Logic; a plain click does nothing, and the tooltip and the help entry both say
  so.
- **The file is ready before the drag starts.** Opening the menu renders the pad exactly as it PLAYS (the same
  offline render RESAMPLE uses — chop bounds, pitch, reverse, attack), encodes 24-bit WAV and writes it into a
  drag folder in temp. The drag itself is then one bridge call, so nothing has to happen while the mouse is held.
- **The page names a file, never a path.** `startFileDrag` only offers the OS files that are provably inside
  that folder, and it deletes yesterday's drags on the way past (bounded cleanup, no timer nobody reads).
- **Gates:** the whole path except the gesture — a pad renders to a real **264,644-byte** 24-bit WAV in the drag
  folder, and `/etc/hosts` handed to `dragFiles` is refused. The drag needs a held mouse button, so THAT is
  his to confirm: open a pad's menu, press ⇱ Drag out, drag it onto the desktop.
- Native only (`canDragOut()`), so the Electron and web menus are unchanged.

## Phase 8 — 8.5b: SIGN-IN IS REACHABLE (Preferences → ACCOUNT), 2026-08-25 nineteenth session

The licence flow landed with nothing to press: the sign-in screen only appears when the GATE is on, and the gate
is deliberately off while 3.0 is in alpha — so the whole thing was unreachable and untestable. Preferences now
has an **ACCOUNT** tab (native-only; the Electron/web build's tab strip is unchanged).

- SIGNED IN / SIGNED OUT with the account's email, **SIGN IN VIA BROWSER**, SIGN OUT, RE-CHECK, and BUY / MY
  ACCOUNT. It listens for `terminator.authSignedIn`, so the moment the browser hands the code back the pane
  re-reads rather than assuming.
- It says plainly what it does and does not do: no password box in the app, the token lives in the Keychain
  (DPAPI on Windows), a week offline is fine, and **nothing here can lock you out** — signing in is what the
  OPEN dialog's CLOUD tab needs, nothing more, while 3.0 is in alpha.
- **New gate:** the probe now reads the PREFERENCES WINDOW's own DOM (a second page it previously only knew had
  LOADED) and asserts the tab strip rendered, `account` included. A pane that stopped rendering would otherwise
  be found by a person, later. Measured: `prefsPage {tabs:[audio,midi,plugins,folders,account], cards:27,
  error:0}`.

## Phase 9 — 9.3b: THE SOAK (does it leak while you play?), 2026-08-25 nineteenth session

Startup and idle memory were measured; what nobody had looked at is the number that actually matters — what
happens over an hour of making a beat. `TERMINATOR_PROBE_SOAK=<seconds>` keeps the app **playing** after the
normal checks (the page's own transport, exactly what a user presses), samples resident memory every 5 s, and
the final read carries the whole curve.

**Measured 2026-08-25, 5.3 minutes of continuous playback (debug build, 64-sample buffer):**
675 MB → **268 MB**, flat for the last two minutes, **219,199 blocks** processed. It RECLAIMS — the self-test's
buffers, plugin instance and stem fixtures being released — rather than growing. `growthMbPerMin: −76.7`.

Opt-in, never in the per-push gate (five minutes is too slow for that), and `probe-app.sh` fails a soak past
**20 MB/min of sustained growth** — far outside anything this app legitimately does while playing. It is on the
pre-release list in RELEASE-CYCLES-NATIVE.md at ten minutes.

## THE WINDOWS BUILD HAS NOW BEEN RUN — AND IT IS A REAL GATE (2026-08-25 nineteenth session)

The Windows job built the app and never launched it: its smoke step was `continue-on-error: true` and every
failure was a warning, so "the Windows build works" was an assumption nobody had tested. It now launches with
the engine going, and on 2026-08-25 the whole thing came back green on a runner:

- `enginePrepared · seqPageOk · drumPageOk · bassPageOk · metroPageOk · liveRecOk · mixerPageOk` all true, with
  the PDC plan at **264 samples = 6 ms at 44.1 kHz**, the cursor tracking inside tolerance and **−1.05 ms** of
  transport drift (the Mac runner, busier, showed 166 ms);
- the licence bridge, the full sign-in round trip and the signed-out cloud refusal;
- an **MP3 through the bundled `lame.exe`** (90,240 bytes) and **onnxruntime 1.23.2 loaded**, so stems have
  their runtime there;
- perf: window 1,679 ms · engine 1,766 ms · page 9,675 ms (a slow runner), **178 MB** resident, **2.2% of a
  core at 64 samples, 0 xruns**.

So the step is now a HARD gate with named failures (twelve of them), and `continue-on-error` is gone. A red
Windows job from here means a regression, not a runner quirk.

## THE TWO "KNOWN LOCAL PROBE FAILURES" WERE BAD GATES, NOT A BAD MACHINE (2026-08-25 nineteenth session)

`prefsWindow` and `mixerPdcPlan` had been carried for days as "fails on this Mac, green in CI — cross-check CI".
Both of those excuses were wrong, and one of them was hiding the fact that **the whole mixer half of the probe
has never passed on a real machine**.

- **`mixerPdcPlan`: the check turned nothing on.** It added a COMP to `sample` and asserted a PDC plan appeared —
  but **PDC is a saved setting**, and this machine's is OFF, so the plan was legitimately 0. The engine was right
  the whole time. It now switches PDC on for the measurement (and puts it back, like everything else in that
  block), and asserts the plan is **the COMP's real look-ahead** — 6 ms, 264 samples at 44.1 kHz, ±1 — instead of
  merely "> 0", which would pass on a plan that is quietly wrong.
- **Why it passed on CI and failed here** (checked properly afterwards — the first guess, "CI has no audio
  device so the block is skipped", was wrong: both runners have one): a **fresh runner has no saved settings**,
  so PDC comes up ON and the plan appeared; this Mac had PDC saved OFF. The gate depended on a user setting it
  never touched, which is the same class of bug as depending on the machine.
- **`prefsWindow`: the check measured FOCUS.** It read the Preferences window's visibility at the final read.
  That window is always-on-top, so macOS orders it out whenever Terminator is not frontmost — a probe running
  while somebody else uses the Mac failed for a reason that has nothing to do with the build. It now asserts the
  FEATURE (the window was opened, its page loaded, and nothing closed it) and reports visibility as a
  diagnostic. The shell counts opens/closes and records where a close came from (`prefsLastClose`) — which is
  what identified this in the first place.
- **`tools/ci/probe-app.sh` now runs to the end on this Mac: PROBE OK.** Everything after the Preferences check
  had never executed here, so those assertions were only ever exercised by CI.

## CI — THE RETRY THAT COULD NOT RETRY, AND THE CACHE THAT WAS MISSING (2026-08-25)

The Windows job went red twice in one afternoon on `rarewares.org` timing out while serving `lame`.
- The retry added earlier **never ran**: `file(DOWNLOAD ... EXPECTED_HASH ...)` raises its own FATAL error the
  moment a transfer fails ("cannot compute hash on failed download"), so the loop around it was unreachable.
  `fetch_pinned` now downloads, then verifies with `file(SHA256)` — the hash stays absolute (a server that
  answers with the WRONG file still fails on the spot, unretried), but a timeout is retried three times.
  Verified end to end locally: the SourceForge lame tarball failed on attempt 1 and came down on attempt 2.
- **`third_party/.tools-cache` was not cached in CI at all**, so every run re-fetched ~30 MB from three
  third-party hosts. It is cached now, keyed on `cmake/ProvisionTools.cmake`, in all four jobs.

## Phase 8 — 8.1b DONE (CLOUD PRESETS RIDE THE DEVICE TOKEN), 2026-08-25 nineteenth session

The projects saved to a KCC account were the last thing the licence work left dangling: the token existed, the
three calls did not. `app/src/CloudPresets.{h,cpp}` is the port — list / save / remove against
`/api/terminator-presets`, authorised in the SHELL because that is where the token lives, each on a background
thread. **A call made while signed out is refused locally (401) and no request goes out** — an unauthenticated
request to a private endpoint is one that should never have been made, and the probe asserts it.

- The page keeps its Electron contract exactly (`cloudPresetsList/Save/Delete`), so `OpenProjectModal`'s CLOUD
  tab lights up natively with no renderer change.
- **The licence is now OBSERVED natively, still not ENFORCED.** ChopperView's native escape hatch used to skip
  the check entirely; it now refreshes the cached `{unlocked, email}` (so cloud presets know whether we are
  signed in) but never shows the sign-in overlay and never locks the app. The gate flip is still owed.
- **Parity note worth knowing:** with `cloudPresetsList` present, the OPEN dialog's preset list is the CLOUD
  list — exactly as in the Electron desktop app — so while signed out it is EMPTY, where the native build
  previously showed local named presets. That is the shipping app's behaviour, and it resolves itself on the
  first sign-in.
- Gate: `cloudRefusesSignedOut` + `cloudBridgeOk` in the licence self-test. The live round trip needs a real
  account and is his to confirm.

## Phase 9 — 9.3a: WHAT THE NATIVE BUILD ACTUALLY COSTS (measured, 2026-08-25 nineteenth session)

The whole premise of 3.0 is that a native app starts fast, sits light and leaves the CPU to the music — and
nobody had measured any of it. `app/src/Perf.{h,cpp}` puts three marks on one clock (from the top of `main()`
to: the WINDOW exists · the PAGE is usable · the ENGINE is running on a real device) and reads the process's
resident memory from the OS (mach `task_info` / `GetProcessMemoryInfo`). The app probe reports the lot.

**Release build, M1 Max, this machine (2026-08-25):**
| | |
|---|---|
| on screen (window) | **548 ms** |
| making sound (engine on the device) | **611 ms** |
| usable (page loaded, ChopperView rendered) | **852 ms** |
| resident memory at that moment | **227 MB** |
| audio callback | **2.9% of one core at a 16-sample buffer** (0.36 ms blocks, 44.1 kHz) |

The 16-sample buffer is what this machine's saved audio setup was on — an extreme setting, and the engine still
sat at 3%. Debug numbers for comparison: 584 / 730 / 875 ms, 16% CPU at the same buffer.

REPORTED, NEVER GATED — a CI runner's clock is not a user's machine — but the numbers print on every probe run,
so a change that doubles startup shows up in a build instead of in somebody's day. The one automatic reaction is
a WARNING when the UI takes over 5 s to be usable.

Still to do in 9.3: the same numbers on Windows, memory after a long session (a leak shows up there, not here),
and a like-for-like startup comparison against the shipping Electron app.

## Phase 8 — 8.6b DONE (DOUBLE-CLICK A PROJECT AND IT OPENS), 2026-08-25 nineteenth session

The 2.x app registers `.tproj` / `.tprojz` with the OS; 3.0 registered nothing, so a double-clicked project
opened the old app (or nothing). Both platforms now claim them, and the file rides the contract the page has
always had for "open this file" — the same one Open Recent uses, so Finder and the menu take the identical path
in and there is no second implementation to drift.

- **macOS**: `CFBundleDocumentTypes` for both extensions (Role Editor, `LSHandlerRank` Owner) merged into the
  generated Info.plist beside the `terminator://` scheme; JUCE routes `application:openFile(s):` and the GetURL
  Apple Event to `anotherInstanceStarted`, which is where Main.cpp already listens.
- **Windows**: one ProgId per extension under `HKCU\Software\Classes` (name, icon, open command) plus the URL
  scheme, re-asserted on every launch — no admin, no installer step, and it fixes the association after the app
  is moved. Same place electron-builder's NSIS script writes them.
- **A COLD start is the case that breaks this** and it is handled twice over: the OS hands the file over before
  `initialise()` has built a window (buffered in Main.cpp) and again before the PAGE has loaded, where an
  emitted event reaches nobody — so the shell holds it until `pageLoaded` and flushes it then.
- **Gate**: probe-app.sh reads the BUILT bundle's Info.plist and refuses a build that does not claim
  `terminator://`, `.tproj` and `.tprojz`. That is exactly the kind of thing a CMake edit drops silently, and it
  is invisible until a user double-clicks a file and nothing happens. The event path itself is already gated
  (`menuReachedPage`), since it is the same one.
- ctest **419/419**, probe green (chopperView, no page errors, drums · licence · sign-in seam · the hidden
  playlist cache all still true).

## Phase 8 — 8.5a DONE (THE LICENCE IS NATIVE — MECHANISM IN, GATE STILL OFF), 2026-08-25 nineteenth session

Terminator 3.0 could not be sold: there was no sign-in, no device token, no entitlement check — `checkLicense`
and friends were the browser shim, and ChopperView's gate has an explicit "NATIVE build: unlocked until the
licence flow is ported" escape hatch. The MECHANISM is now native, rule for rule with the Electron app's
`src/main/desktopLicense.ts`. **The gate itself is still off** — that flip waits until Victor has signed in on a
real build, because a bug there locks a paying user out of his own app.

- **`app/src/LicenseHub.{h,cpp}`** = the port: browser-only sign-in (no password form, no Supabase token in the
  page), a one-time nonce per attempt held in memory, the `terminator://auth?code&state` callback traded for a
  long-lived server-signed DEVICE TOKEN, re-validation on every launch, and the **7-day offline grace** off the
  last good validation. A reachable server that refuses (401/403) or answers `unlocked:false` DROPS the token; a
  server that cannot be reached, or 5xx, falls back to the grace window rather than punishing the user.
- **`app/src/SecretStore.{h,cpp}`** = the token at rest, in the OS's own store: **macOS Keychain Services**
  (a generic-password item) and **Windows DPAPI** (`CryptProtectData`, bound to the logged-in user). No store →
  the app stays signed out. There is deliberately NO plaintext fallback — that is Electron's `safeStorage` rule
  and the reason the file it writes is not a file we could have just copied.
- **The deep link works on both platforms.** macOS: `CFBundleURLTypes` merged into the generated Info.plist
  (`PLIST_TO_MERGE` in app/CMakeLists.txt — verified with `plutil -p` on the built bundle), delivered as
  `application:openURLs:` → `anotherInstanceStarted`. Windows: a second process carries the URL on its command
  line, and the app claims the scheme under HKCU on every launch (no installer step, no admin). A COLD-START
  link (the app was not running) is buffered until the window exists.
- **The token never reaches the page.** `terminatorLicense` answers `{unlocked, email, offline, storeAvailable}`;
  `licenseNative.ts` is only the five keys `lib/desktopAuth.ts` has always spoken, so no renderer code changed.
- **Gates** (`window.__terminatorNativeLicense`, asserted in tools/ci/probe-app.sh): the bridge is installed and
  `status` answers; and through a FAKE SEAM the whole round trip — locked at rest → **a callback with the wrong
  nonce changes nothing** → **the nonce is single-use, so even the right one cannot be replayed after it** → a
  matching callback stores the token in the real OS store and unlocks (with the `terminator.authSignedIn` event)
  → **SIGN OUT removes the credential**. The seam (`TERMINATOR_LICENSE_FAKE`) replaces both HTTP calls, arms the
  probe-only `deepLink` verb and moves the credential to its own store entry, so the gate needs no KCC account,
  no live server and no browser — and can never touch the user's real device token.
- Measured on this Mac: `licenseSeam {startLocked, gotNonce, wrongStateStillLocked, nonceIsSingleUse,
  signedInEvent, unlocked, signedOutLocked} all true`, `storeAvailable: true` (a real Keychain item written,
  read and deleted inside the run, no prompt). ctest **419/419**, ui gate green.
- **What is NOT done here:** the gate flip (ChopperView + lib/subscription.ts still return early for native),
  the free tier's pad lock, and the EULA→Supabase insert. Phase 9.4b also needs the bundle id moved to
  `com.terminator.audio` before the 2.x→3.0 handover — today it is `app.killaviccheatcodes.terminator`.

## Phase 8 — 8.2a DONE (THE DRUM LIBRARY IS IN THE APP, AND MY DRUMS IS REAL), 2026-08-25 nineteenth session

Drums were the last thing in the native app still reaching over the NETWORK: `terminator-drums://` is an Electron
custom scheme, the JUCE shell has none, so every fetch fell through to R2 and MY DRUMS was simply absent (the tab
is gated on `drumsUserList`, which nothing provided). Both halves are native now.

- **The KCC library ships INSIDE the app.** `drums-flac/` (1,182 opaque-id one-shots, 80 MB) rides in
  `Contents/Resources/drums-flac` (Windows: beside the exe) and the shell serves it at **`/drums/<id>.<ext>`** —
  `WebShell::provideResource`, id validated as a bare 16-hex token and nothing else, so there is no path handling
  to get wrong. The URL SHAPE is deliberate: `drumIdFromUrl` already reads an id out of `/drums/<id>.<ext>`, so a
  project saved in the native app still resolves its drums (and their R2 fallbacks) in the Electron app and on
  the web. `drums-flac/` is gitignored — `node tools/fetch-drums.mjs` provisions it (ported from the Electron
  repo's fetch script: same ids off the committed samples.json, same bucket, same flac→mp3 fallback), and
  `cmake/BundleDrums.cmake` lays it into the bundle with a count+bytes stamp so it costs one copy per build dir.
  **A build without it is normal** (CI has none): the app reads drums off R2 exactly like the web build.
- **MY DRUMS + Preferences → FOLDERS → Drums.** `ui/src/renderer/native/drumsNative.ts` ports the Electron
  main-process module `userDrums.ts` over `terminatorFs`: `drumsUserList` (the folder as a tree of RELATIVE paths
  — the page never sees an absolute — audio only, bounded at 50k files / depth 16), `drumsUserDir`,
  `drumsUserReveal`, `drumsUserEmpty` (Trash, never unlink; a refusal stops and says so). The folder is
  `<Sample Library>/Drums`, so it moves with the library, and its files PLAY through the library's own
  `/lib/b64/` route — the library root is already a registered serve root, so nothing new is exposed.
- **The page needed one hook, not a fork.** `drumR2.setNativeDrumUrls({sample, user})` swaps the two URL builders
  when the shell is there; Electron and the web keep the custom scheme. Same pattern as `voiceSink`.
- **The FOLDERS chips are honest again**: `getFolderSizes` now answers `drums` (the user's folder) and
  `drumsBundled` (81 MB) — and OMITS `drumsBundled` when the build ships no library, because a 0 B chip would
  read as "empty" rather than "not in this build".
- **Gates** (`window.__terminatorNativeDrums.selfTest`, asserted in tools/ci/probe-app.sh): the bundled route
  serves a real id **byte-complete** (size compared against the directory listing), a path that is not a bare
  16-hex id is refused (`/drums/..%2F..%2Fetc%2Fhosts.flac`), and the MY DRUMS walk finds a `.wav` and skips a
  `.txt` in a folder **the probe fills in temp** — never the user's own drums folder, which is legitimately empty
  on a fresh machine. A build with no bundled library still gates the route: probe-app.sh points
  `TERMINATOR_DRUMS_DIR` at a one-file fixture, so the feature is asserted on every machine, not just this one.
- Local evidence (M1 Max): `drums: {bundledDir: true, bundledCount: 1182, bundledServed: true,
  bundledBogusRefused: true, userWalked: true, userSkipsNonAudio: true, userDirInLibrary: true, ok: true}`,
  folderSizes `drumsBundled 81,468,994 B`. ctest **419/419**, ui gate green (tsc at its 5 baseline).
- **Still on the shim after this:** nothing about drums — but the DRUM BROWSER's organiser features Victor asked
  for on 2026-08-21 (cut/copy/paste/duplicate/delete, Cmd-drag copy, new folders in BOTH browsers) are a separate
  build, in both repos.
- At release: `Resources/drums-flac` is DATA — nothing to sign — but the shipping build must be made on a machine
  where `drums-flac/` is provisioned, or the DMG quietly ships an app that needs the network for drums.

## SOUND: A CHOP PITCHED UP DOES NOT ALIAS ANY MORE, 2026-08-25 eighteenth session

**What was wrong.** Reading a sample faster than it was recorded — every pad with PITCH up — puts its top
octave above the new Nyquist, and with no band-limiting it folds straight back into the band as inharmonic
ringing. Neither the engine's Hermite read nor the Web Audio `AudioBufferSourceNode` the app grew up on does
anything about it. Measured on a 1 kHz + 15 kHz source at +12 st: **the folded 15 kHz comes back at 18 kHz at
the SAME level as the music (0 dB)**.

**`Interpolation::sinc`** squeezes a windowed-sinc kernel by 1/rate, so that content is gone before it can
fold: **−77.6 dB** on the same signal, with the music itself untouched (the gate checks that too — a
band-limiter that eats the signal is no use).

**Three things the measurements forced, in order:**
1. A **fixed 16-tap** kernel measured only −49 dB, because squeezing the cutoff stretches the sinc's lobes and
   a short window then holds too few of them. **The half-width scales with the rate** (8 source samples at
   rate 1 → capped at 32), so the lobe count stays put and the cost only rises when the pitch is up.
2. Windowing in the SCALED argument silently un-windows the kernel as the cutoff drops. The window belongs in
   TAP space; getting that wrong measured −23 dB.
3. Evaluating the sinc and the Kaiser window per tap cost **43x a Hermite read** — nothing that expensive
   belongs on the audio thread. The kernel is a **polyphase table** now (512 phases x taps, per rate bucket,
   each row normalised to unity gain so the level cannot move with the pitch): one multiply-add per tap.
   **Release, 32 voices all at +12 st: 1.3% of one core through Hermite, 6.7% through sinc.**

**It is the default in the app** — `setPadParams` defaults to sinc, and so does the EXPORT
(`ProjectRenderOptions::interpolation`), because a bounce should not read the audio differently from the thing
that made it. The engine's own default stays `linear`, which is what golden-matches the Web Audio fixtures the
render tests compare against; a request can still ask for `linear` or `hermite` for an A/B.
Gates: `Sampler: the sinc read does not alias a chop pitched up; hermite does` (the rejection, and that the
music survives) + a hidden `[.][bench]` case that prints both costs. ctest **419/419**.

## SOUND: TIME STRETCH IS REAL NOW (and the shipping app's stretch has a bug), 2026-08-25 eighteenth session

**The shell played every stretched pad DRY.** The page applies stretch inside its own `startVoice` — a cache
hit swaps the chop for its pre-stretched buffer — and the native engine never reaches `startVoice`, so TARGET
BPM did nothing at all in Terminator 3.0. `ChopperEngine.nativeStretchSlice(pad)` now answers the same
question outside a voice (startVoice's own resolution: pad source or chop, and the REVERSED buffer with its
mirrored region when the pad is reversed), and the shadow binds that slice whole and forward — `reverse` goes
FALSE with it, because the slice already IS the reversed audio. A miss plays dry once and warms, exactly as a
page hit does; the pad re-describes when the warm lands, and a hit re-syncs the pad anyway.

**Then the measurement found a real bug underneath, in the shipping app's own code.** SoundTouch's
`fillOutputBuffer` only processes once its input buffer holds 8192*2 frames, and stops when what remains is
less than that. Measured in plain node against the same library the app bundles:

| slice | out | expected |
|---|---|---|
| 11 025 frames (0.25 s — a normal 1/16 chop) | **0** | 14 700 |
| 44 100 (1 s) | 37 752 | 58 800 |
| 176 400 (4 s) | 212 355 | 235 200 |

So **a chop shorter than 16 384 frames (371 ms at 44.1k) was never stretched at all** — `getStretchedBuffer`
returned the dry buffer and the chop played at the wrong tempo, silently — **and every longer chop lost its
last ~0.37 s.** Chopping a loop into sixteenths makes almost every chop shorter than the threshold, so TARGET
BPM has been quietly doing nothing to them.

**The fix**: pad the input with 32 768 frames of silence so the whole slice is processed, then cut the output
to `numSamples / ratio` — measured: full level right up to that point, silence after it, and the content
starts at sample ~3, so there is no latency to compensate. The extract loop also fills preallocated
Float32Arrays instead of pushing into two `number[]` (a 4-minute chop was millions of boxed pushes).

**OWED IN THE ELECTRON REPO**: `terminator/src/renderer/chopper/ChopperEngine.ts` holds this code verbatim —
the shipping app has the same bug, and it is a web-bundle + desktop-release change.

**Probe**: pad 62 bound at 0.25 s dry; STRETCH on at 120 → 90 re-binds it to a slice of **0.333 s** (1.33x =
1/0.75) with `reverse` false, and turning stretch off puts the dry key back. All three are asserted.

**The BOUNCE carries it too** (same session, second commit): `SampleBank.padOverrides` (pad index → the whole
buffer) is audio the renderer cannot make for itself, because SoundTouch lives in the page. The override IS the
region, and the pad's stem mask and REVERSE are already baked into it, so both are skipped for that pad —
applying either twice would be the bug this fixes. It rides the export request as `padSamples {pad: key}`, and
`nativeSampleKeys` fills it: an export can afford to WAIT for a slice the hot path would have skipped, so it
renders the stretch instead of dropping it. The page's own offline bounce (`scheduleOfflineChop` — the MPC and
Drum Rack bakes, `exportSeq`) takes the same slice. Gate: `render: a pad override plays THAT audio whole, past
its chop's own length` — silent without the override, sounding past the chop's 0.2 s with it, stopping at its
own end. **The native SEQUENCER now plays
stretched** (it plays the pad's bound sample), which is a deliberate improvement over the Electron app, where
the sequencer takes `resolvePadSource` and plays dry while the pad plays stretched. His stems precedent
("it's not the same sound as when I hit the pad") says the sequencer should match the pad.

## Phase 7 — 7.2 DONE (THE EP PROBE: COREML MEASURED AND REFUSED), 2026-08-25 eighteenth session

The question was whether an accelerator can make a split faster on his Mac. It is answered with numbers, and
the answer is NO for both CoreML modes — so **CPU stays the engine**, exactly as in the shipping app.

**The harness** (this is the part that keeps its value after any onnxruntime or model bump):
- `StemModel::load(..., Ep)` — `cpu` · `coreml` (MLComputeUnits ALL, the Neural Engine included) · `coremlGpu`
  (CPUAndGPU). A provider this build of onnxruntime cannot create is an ERROR, never a quiet fall back to CPU:
  a "GPU build" that is silently a slow CPU build is how nobody notices for a year. `epUsed()` says what ran.
- `StemModel::compareEp(models, mix, ep, …)` — the SAME chunk through CPU and the candidate, after a warm-up
  run on both (the first run pays the arena and, for CoreML, the model compile). Reports the WORST row's SNR
  (not the average — a provider that gets three rows right and vocals wrong is wrong), max|diff|, both
  timings, and how many of the 2 751 840 samples came back non-finite.
- `SplitSession::buildChunkMix(idx, mix)` — the real chunk the run would infer on, so the check measures music
  and not a synthetic buffer. Gated: an identity model records what it was fed and the two agree sample for
  sample, including the zero pad on the short last chunk.
- `terminator-stems … --check-ep coreml|coreml-gpu` prints all of it and exits non-zero when the provider
  fails. **The pass rule is the shipping app's own** (`stemsWorkerChild.ts probeChunk`): SNR ≥ 40 dB AND at
  least 1.1x faster. Correct-but-slower is not a win.

**Measured, M1 Max, htdemucs_fp16weights, 30 s of a real track (first chunk):**
| provider | worst-row SNR | non-finite | ms/chunk vs CPU | verdict |
|---|---|---|---|---|
| CoreML, MLComputeUnits ALL | — (no comparable sample) | **2 751 840 / 2 751 840** | 6 224 vs 1 893 (0.30x) | different audio |
| CoreML, CPUAndGPU | 55.8 dB (max diff 8.6e-04) | 0 | 132 254 vs 5 625 (0.04x) | right audio, far slower |

**What that tells us, beyond "no":** the Electron app recorded "CoreML returns WRONG stems" — this says WHY.
The Neural Engine is the part that returns garbage (every sample NaN with fp16 weights); restrict CoreML to
CPU+GPU and the audio comes back essentially correct — and 23x slower than the plain CPU provider. So a
re-exported fp32 model would fix the NaN and still lose on speed. **The door that is still open** is a
different provider entirely (DirectML on Windows), and the harness above is what will judge it.

Nothing in the app changed: the hub still loads CPU, and no setting can pick a provider — the check is a
developer tool until something passes it.

## Phase 7 — 7.3a (THE PADS CAN READ THE ENGINE'S STEM PLANES — behind a flag), 2026-08-25 eighteenth session

**Off by default** (Preferences → Stems → "Play stems from the engine", setting `stemsPlanes`). His stems pass
is owed on the shipping path, and this changes what a masked pad plays — so it ships as an experiment he can
A/B, not as a silent switch.

**What it replaces.** Today a masked pad gets a MIXED slice: the page sums the lit stems into a new
AudioBuffer (`bufferForPadChop`, a 96-entry LRU) and the shadow uploads that to the store — one buffer per
(mask, chop). With the flag on, the split also keeps its four planes in C++ (`split {planes:true}`), the pad is
bound to the UNMASKED source, and `setPadStems {pad, key, mask}` tells the RT voice which planes to sum per
hit. One buffer per SOURCE instead of one per mask, and a layer change is a command instead of a render.

**The rules it has to obey (all of them cost a line each):**
- **Only for keys the hub actually holds planes for.** A project restored from the stems cache has page audio
  and NO planes; attaching there would silently play the original. The shadow keeps the hub's own `sources`
  list (`refreshStemSources`, refreshed at attach and on every `terminator.stemsDone`), and `setPadStems`
  answers with the mask it attached — no mask back means it did not attach, so that key is forgotten and the
  pad re-binds the page's mix on the next sync.
- **A new sample drops the pad's planes in the engine**, so the mask is sent AFTER `setPadSample`, never
  before (the voice only keeps its snapshot when the sample is the same one).
- **Not for LOOP pads**: a rendered crossfade loop reads the SAMPLE, so its masked audio has to be real audio.
- Mask 15 (all four) is not a mask at all — that is the original, and it detaches.
- The page still receives every span: its waveform composite, its FLAC assets and its cache are untouched.
  Dropping the page's copy entirely is 7.3b, after his pass.

**Measured in the app** (`TERMINATOR_PROBE_STEMS=1`, a real 2 s split through htdemucs): `planesKept` — the
split left its planes in the hub · `padStemsAttached` — a partial mask attaches through the real command and
the hub reports mask 1 back · `padStemsDetached` — a full mask detaches it · the shadow's `stemSources` went
to 1 on `stemsDone` without anything asking it to. ctest 416/416, ui gate green, 0 new warnings.
**Not provable in CI**: the model is 166 MB and never downloaded there, so CI runs everything except the split
itself — and the page-level choice (which pad, which mask) needs a real song, which is his pass.

## Phase 7 — 7.4 (part 1) DONE (PREFERENCES → STEMS: THE ENGINES AND THE SAVED STEM AUDIO), 2026-08-25 eighteenth session

The Preferences page has carried the whole Stems card since it was copied from the Electron renderer — the
engines with their sizes, DOWNLOAD / DELETE, the per-song stem audio with its own DELETE, CLEAR ALL, and the two
OPEN buttons. It rendered nothing natively because the card is gated on `bridge.stemsUsage`, and the shell
answered none of that surface. It does now, ported call for call from the Electron handlers
(`main.ts stems:usage / clearAudio / deleteSongStems / revealAudio / revealModels` + `diskUsage.ts`).

- **`stemsUsage()`** — the engines come off `terminatorStems {verb:'status'}` (bytes / expectedBytes / ready,
  plus a `downloading` flag the TS side keeps from the progress events), the folder is the hub's own
  `modelsDir`, and the stem AUDIO is a scan of the native asset store (`<dataDir>/assets`): a `<hash>.json`
  sidecar whose `name` ends `.stems.flac` (or the older `.stems.wav`) is a stem file, and the song it belongs
  to is that name minus the ` — DRUMS.stems.flac` stamp `finalize()` writes. Same filter, same rollup, same
  em-dash rule as `diskUsage.ts` — a title containing " — " itself survives.
- **DELETE takes the shortcut with it.** A song's stems and their sidecars go to the TRASH (the shell has no
  hard delete, and the drums EMPTY sets the precedent), and every `stems-cache.json` entry pointing at one of
  the deleted hashes is dropped — a shortcut left behind would "find" stems whose files are gone. CLEAR ALL
  empties the index outright. Both refuse while a split is running, like the Electron handlers.
- **DOWNLOAD awaits the download.** The shell answers the verb at once and finishes on
  `terminator.stemsModels`; the Electron pane awaited `ensureModels`, so the shim resolves on that event
  instead (and on a refused verb) — otherwise the pane would say "downloaded" the instant it was asked.
- **The progress event now says WHICH engine** (`terminator.stemsProgress {..., quality}`): Preferences keys its
  FAST / FINE row by quality, and a download the SPLIT started has to light the same row as one the pane
  started. Both windows get the event (`emitToAll`), so the chopper's bar and the pane's row agree.
- OPEN ENGINES / OPEN STEM AUDIO = `mkdir` then `openPath` (the folder can legitimately not exist yet).

**Evidence.** `mac-debug` 0 new warnings · ctest **416/416** · `ui` gate green (tsc at the 5 baseline) · the app
probe drives the pane's whole contract without a click: `usageModelsDir` · `usageSeesSong` (a fake
`probe stems song — DRUMS.stems.flac` written into the store with a real cache shortcut shows up as a SONG) ·
`deleteOk` · `deleteRemovedSong` · `deleteDroppedCache`. The probe script asserts all five.
(The two local probe failures on this Mac are the known ones — `prefsWindow` and `mixerPdcPlan`; both are green
in CI and fail on a clean HEAD build too.)

### 7.4 (part 2) — THE ENGINES FOLDER MOVES, AND USE DEFAULT REALLY GOES BACK
- **Two bugs in the folder itself, found by writing the button.** `StemModels::setDirectory` documented "an
  empty File = back to the default" and then IGNORED an empty File — USE DEFAULT would have done nothing at
  all. It now remembers `defaultDir_` and resets to it (`isDefaultDirectory()`; the models test asserts the
  round trip, including that the default folder really is empty again after a move). And a relocated folder
  did not survive a relaunch: the shell keeps no settings, so the page stores `stemsModelsDir` and re-applies
  it at install (`applyModelsDirSetting`), before anything can start a split.
- **A reset RE-ADOPTS.** On his machine the folder in use is the Electron app's (adoption at startup). A plain
  "back to `<dataDir>/stems/models`" would have pointed the app at an empty folder and offered to download
  166 MB he already has, so the adoption rule now runs again on reset. Which also fixes what "default" means:
  `modelsDirIsDefault` is false only when the USER picked the folder, so USE DEFAULT is greyed out until there
  is a choice to undo.
- Preferences: CHANGE… / USE DEFAULT under the engines path, with the tooltip that says what actually happens
  (a folder that already holds htdemucs is USED as it stands — nothing is copied or moved).
- Probe: `modelsDirMoved` · `modelsDirReset` · `modelsDirRestored` (it puts the folder AND the setting back —
  a probe that left a reset behind would have hidden the adopted models from the split check below).
  ctest **416/416**, 0 new warnings, `ui` gate green.

### 7.4 (part 3) — THE FOLDERS TAB TELLS THE TRUTH
- **`terminatorFs {verb:'du', path}`** → `{ok, bytes, approx}`: the Electron `dirSizeBytes` rule in the shell —
  symlinks skipped (a library pointing at itself cannot loop) and a 200 000-entry cap that reports `approx`
  instead of hanging the call. One walk per chip, in C++, not thousands of `list` round trips.
- **`getFolderSizes`** answers only the folders the native app HAS (projects · library · YouTube). A key it
  leaves out hides its chip, which is honest — a `0 B` chip would read as "empty", and drums are not native yet.
- **The YouTube row works**: `getCacheDirInfo` / `revealCacheDir` point at `<library>/YouTube`, the same rule as
  the shipping app (where `setCacheDir` was retired — the folder moves WITH the library, so CHANGE is a no-op
  that reports `cancelled`).
- Probe: `folderSizes.projects.bytes > 0` (a zero means the walk never ran) and `cacheDir.path` is set.

**Still open in Preferences:** the drums rows (drums are not native at all yet) and their `drumsBundled` size.

## Phase 7 — 7.1a/7.1b DONE (STEMS RUN NATIVELY: THE PIPELINE, AND htdemucs IN PROCESS), 2026-08-24 seventeenth session

**The biggest hole in the native app is closed at the engine level: a stem split runs in Terminator's own
process, with no Node child, no temp file and no IPC — and it produces the SAME stems the shipping app does.**

### 7.1a — the pipeline (`engine/{include,src}/terminator/stems/`)
- `SplitSession` is the Electron worker's grid, ported: segment 343980 (7.8 s at 44.1k), overlap = segment/4,
  stride = segment − overlap, chunk i at i·stride, the fade window, the overlap-add accumulators, the
  ready-range rule (a stretch is ready only when its chunk AND the chunk whose tail covers its head are done),
  the reported-span subtraction, and the emit with kernel margin either side. **The model is INJECTED**
  (`InferFn`), so the whole pipeline gates without onnxruntime — and the app can swap in a different engine.
- `Resampler` is the rate bridge, ported tap for tap (windowed sinc, Blackman, 16 lobes up / 32 down, per-phase
  table normalised to unity DC, positions from the GLOBAL output index so spans tile).
  **Measured against the TS kernel on the same input: max difference 1.19e-07 — one float ULP.** That is what
  makes the stems cache the Electron app wrote still valid.
- **A focused window now really does jump the queue.** The Electron worker skipped any chunk already queued, so
  a chop tapped during the sweep waited out the whole sweep; a front enqueue moves it to the head instead.
- 10 gates (`tests/engine/test_stems_split.cpp`): unity DC gain, global-index tiling, flat to 20 kHz within
  0.1 dB with 78 dB rejection of what folds into the band, the chunk maths, ready-only-when-covered, spans
  tiling the track and reported once, seam reconstruction (−33 dB gate with an identity model), the 48k rate
  bridge, queue priority, cancel, sub-chunk progress ticks.

### 7.1b — the model, in process (`stems/`, `tools/terminator-stems/`)
- `StemModel` runs htdemucs through the onnxruntime C++ API: FAST = one model, all four rows; FINE = the four
  specialists, row k from model k. Input/output names are read off the session, never assumed. CPU EP only —
  the GPU providers are 7.2, behind the SNR self-check.
- **onnxruntime is dlopen'd, never linked.** Every prebuilt ORT for macOS is built against 13.3+ (checked
  1.20.1 → 1.23.2), so LINKING it would raise Terminator's own floor from macOS 12 to 13.4. `ORT_API_MANUAL_INIT`
  + one `dlsym("OrtGetApiBase")` keeps the app's floor where it is, makes a missing runtime an error message
  instead of a dead launch, and leaves `otool -L` with no onnxruntime line at all. Verified: the dlopen path is
  bit-identical to the linked one.
- Pinned in `cmake/Onnxruntime.cmake`: **1.23.2**, the last macOS release shipped as `osx-universal2`
  (`lipo -info` = x86_64 arm64 — one file for both slices), the same version the Electron app's Intel Macs
  already run, and `onnxruntime-win-x64` at the same number. SHA-256 verified, cached in
  `third_party/.ort-cache` (gitignored), CI caches it per job. `-DTERMINATOR_STEMS=OFF` builds without it.
- `terminator-stems` CLI = the measuring rig: a WAV in, four stems out, the timing printed.

### Measured on this Mac (M1 Max, 30 s of "Nas — The World Is Yours", FAST, CPU EP)
- **native vs the SHIPPING Electron child, same input, same model: 116–128 dB SNR per stem, max sample
  difference 6.0e-07.** Two different onnxruntime versions (native 1.23.2 vs the app's node 1.27.0) and the
  stems are the same audio. The B5 gate asked for ≤ −60 dB; this is −116 dB.
- Ready ranges identical to the Electron child's, span for span.
- Speed: 1.95 s per 7.8 s chunk (the Electron app's own estimate for FAST is 2.0 s/chunk) — 2.8x realtime for
  a whole track, model load 2.2 s. **Parity, as expected: same graph, same CPU EP.**
- The four stems sum back to the source at 33 dB, with no seam spike in the residual.

### How the parity was measured (repeat it after any onnxruntime bump)
1. `ffmpeg -i <track> -t 30 -ar 44100 -ac 2 -c:a pcm_f32le src.wav`
2. native: `terminator-stems src.wav out/ --model <htdemucs_fp16weights.onnx> --sweep --bits 32`
3. Electron: fork `$HOME/terminator/dist/main/stemsWorkerChild.js` under PLAIN node (never Electron — the V8
   cage SIGTRAPs onnxruntime) with `serialization:'advanced'`, send `{type:'init', rawPath, frames, srcRate,
   modelPaths, windows:[], sweep:true, gpu:'off'}` where rawPath is L then R as planar float32, and write the
   8 planes it sends back.
4. compare per stem with numpy: SNR and max|diff|. The gate is ≤ −60 dB difference; the measured number is
   −116 dB or better.
Also worth re-running: `arch -x86_64` on the universal CLI, which drives the Intel slice of the same universal
dylib (measured: 121–124 dB against the arm64 slice, so both slices agree).

### Gates (the three commits together)
`mac-debug` **414/414** · `mac-rtsan` **415/415** · zero new warnings (the only ones left are Phase 6's
`-Wfunction-effects` lines in PluginFx.h) · `mac-release-universal` builds and `lipo -info terminator-stems` =
`x86_64 arm64` · the model-backed case runs with `TERMINATOR_STEMS_MODEL=<htdemucs_fp16weights.onnx>` and skips
without it (a 166 MB model is not a repo fixture).

### 7.1c (part 1) — the models on disk (`stems/StemModels.{h,cpp}`)
Same files, same R2 URLs and the same SHA-256s as the Electron app, into `<dataDir>/stems/models` (Preferences
→ FOLDERS can move it, and pointing it at the Electron app's folder skips the download entirely). Every file
is size- AND hash-checked; a partial or corrupt one is deleted, never left to be "the model" later. Progress
0..100 over the whole job, cancellable, blocking (it belongs on a background thread). 5 gates run against a
local fixture server over `file://` URLs with a tiny manifest — nothing in CI touches R2 or a 166 MB file.

### 7.1c (part 2) — THE SPLIT IS ON THE BRIDGE: the STEMS button works natively
- **`StemHub`** (`app/src/StemHub.{h,cpp}`) — `terminatorStems`: status · split · queueWindow · cancel ·
  downloadModels · deleteModels · modelsDir · forget. One split at a time on its own thread; everything the page
  sees goes through an outbox drained by a Timer on the message thread. The model stays loaded between splits at
  the same quality (his batch workflow pays the 2 s load once).
- **The page never ships PCM.** The audio is already in the shell's SampleStore (the engine shadow uploaded it to
  play the pads), so a split takes the store KEY — the controller asks the shadow for it
  (`NativeEngineShadow.stemsKeyFor`, which uploads + holds it). Copying 170 MB of floats over the bridge to start
  a split the shell can already see would have been the slowest part of the feature.
- **A ready span comes back as BYTES, not as an event payload**: the shell stashes the eight planes and the event
  carries `/blob/<token>`; `stemsNative.ts` fetches it binary and hands the renderer the same
  `Float32Array[8]` the Electron worker did. **The fetches are chained and `done` waits for them** — the exact
  ORDER TRAP the Electron path hit (finalizing while the last span was in flight wrote assets missing it).
- **The renderer's whole stems layer is untouched**: its waveform composite, its FLAC assets, its project
  save/restore and its cache all still work, because the contract they were written against is the one the shell
  now answers. The cache is the same `stems-cache.json` shape, in the app's presets folder.
- **The models are adopted, not re-downloaded**: if the Electron app's `terminator-stems/models` folder on this
  machine already holds htdemucs (same names, same SHA-256s), that becomes the folder. Nobody pulls 166 MB twice.
- `Command::setPadStems` is wired too (`{verb:'split', planes:true}` keeps the four full-length planes in C++ and
  the RT voice sums the lit stems per hit) — off by default until 7.3 moves the audio out of the page entirely.
- Bundling: the onnxruntime dylib rides in `Contents/Frameworks` (a symlink covers the plain name — one copy,
  not two) and nothing links it, so `otool -L` on the app still has no onnxruntime line.

### Measured in the app (probe, `TERMINATOR_PROBE_STEMS=1`)
`ortLoaded: true` (1.23.2, dlopen'd from the bundle) · an unknown sample key is refused · the cache round-trips ·
**a real 2-second split: one span, 88200 frames, peak 0.324, 4.8 s wall (2.3 s model load + one chunk)** — the
whole path, from the verb through the model to the blob fetch, inside the shipping app. The probe asserts all of
it; the split part only runs when a model is on the machine (never in CI — it is 166 MB).

### Known gaps after 7.1c
- **The page still owns the stem audio** (that is what keeps the waveform composite and the asset saving working).
  7.3 flips it: `planes:true`, the shadow binds the ORIGINAL + a mask instead of uploading a mix, and the native
  cache writes the assets — then the page holds none of it.
- Preferences has no STEMS pane yet (download / delete / relocate the models is only on the bridge).
- No GPU: CPU EP only until 7.2's probe.

### Two things 7.1c part 2 has to handle (known, not bugs yet)
- **The accumulators are the whole track.** 8 planes + the weight = 36 bytes a frame at 44.1k, so a 6-minute
  song is ~570 MB while it splits (`SplitSession::accumulatorBytes()` reports it). The plan's answer is
  streaming: free a chunk's rows once every span covering them has gone out, with a cap above that.
- **Two downloads of the same model at once** (Preferences → DOWNLOAD while a split starts one) would both
  write the same `.part`. `StemModels` is documented as one-thread-at-a-time; the hub has to serialise it, the
  way the Electron version's inflight map does.

### Next (7.1c part 2, the session after this)
The split is not on the bridge yet — the page's `stemsSplit` / `onStemsChunk` still hit the browser shim, so
the app's STEMS button does nothing native. **The decision to make first: where the stem audio LIVES.** The
page contract ships 8 planes of floats per span, which is ~8 MB a span through `emitEvent` — not viable. The
native answer is that the audio never leaves C++: the split writes straight into the engine's stem planes
(`Command::setPadStems` already takes them), the page gets progress + ready ranges only, and the cache
(content key, FLAC assets, `stems-cache.json`) is reimplemented natively so a project reopens with its stems.

## CI RED on `9b24b4d` — my own test, wrong on Windows (fixed 2026-08-24)

Windows/MSVC failed `engine.recorder: a bad path fails cleanly`; mac universal, Intel and RTSan were all green.
**The product was right and the TEST was wrong.** It used `/this/directory/does/not/exist/.../x.wav` as an
"unwritable" path — but on Windows a leading slash resolves to the current DRIVE, so JUCE created the whole tree,
the recorder started correctly, and the `CHECK_FALSE` failed. The gate was asserting a property of POSIX, not a
property of the recorder.

Now it points at a path inside a real FILE (`<tempfile>/x.wav`) — a directory cannot be created where a file
already sits, on either OS. **The rule: an "impossible" path is a platform assumption. Make the impossibility
something the filesystem itself guarantees.**

## Phase 6 — 6.1b: THE SCAN RUNS FOUR AT A TIME, AND THE MENU FIRED TWICE, 2026-08-24

- **The scan is parallel now.** A machine with hundreds of plugins is the normal case (Victor's has hundreds), and
  one child process at a time is ten to twenty minutes of watching a bar. Up to four children run at once
  (`min(4, cpus/2)`) — they are independent processes, and the only shared state is the job's own, already behind
  its lock. Verified: four concurrent children each returned their plugin, 1.6 s wall for all four.
- **FIXED: every menu item fired TWICE.** Choosing a COMMAND item invokes the command manager AND then calls
  `menuItemSelected` (juce_MainMenu_mac.mm: `invoke()` then `invokeDirectly()`), so File → Save would have opened
  two save dialogs. `perform()` now acts only for the KEY EQUIVALENTS (`invocationMethod != fromMenu`); the menu
  path goes through `menuItemSelected` alone. Found by reading JUCE's dispatch, not by a crash — a headless probe
  cannot click a menu, so **his pass should confirm one dialog per click, on both platforms**.

## Phase 6 — 6.6a DONE (A PLUGIN THAT CRASHES CANNOT TRAP YOU), 2026-08-24

Real isolation means hosting plugins out of process, which is a phase of its own. This is the cheap half that
matters most: **a plugin that takes the app down cannot take it down twice.**

Instantiating a plugin runs somebody else's code in our process, and a plugin that crashes on load crashes again
the moment the same project reloads it — a loop the user cannot get out of. So `PluginHub::create` writes the
plugin's id to `plugin-loading.txt` before the plugin is made and erases it when control comes back. Finding that
file at the next launch means we never came back from it: the plugin is **blocklisted, removed from the list, and
NAMED** — Preferences → PLUGINS says which one, and TRY THESE AGAIN (or RESCAN EVERYTHING) gives it another go
after an update. **Verified by simulation:** a breadcrumb left behind by hand, next launch → that plugin gone from
the list and on the blocklist, the breadcrumb consumed.

## Phase 6 — 6.2/6.3 follow-up: A SAVE CARRIES WHAT IS LOADED, 2026-08-24

Two holes in how a hosted plugin's own settings reach the project, both found by reading the save path rather than
by a crash:
- **A save now pulls the plugin states itself** (`doSaveProject` awaits `syncNativePluginStates()`), instead of
  trusting whatever the 15-second poll last saw. A plugin's state changes while you turn ITS knobs in ITS window
  and nothing tells the page — so the moment that matters is the save.
- **An INSTRUMENT's state was never saved at all.** It reports slot −1 (it is not in any insert chain), so the
  sync's `fx[slot]` lookup found nothing and skipped it silently; it now goes back into the slot whose PLUGIN
  param chose it.

## Phase 8 — 8.6a DONE (THE APP HAS A MENU), 2026-08-24

Terminator 3.0 had no menu bar at all — no ⌘S, no ⌘O, no Open Recent — and `ipc.onShortcut`, the contract the page
has used for the Electron menu since forever, was a stub that returned an empty unsubscribe.

- `app/src/AppMenu.{h,cpp}`: **File** (New ⌘N · Open ⌘O · Open Recent ▸ · Save ⌘S · Save As ⇧⌘S · Export ⌘E) ·
  **Transport** (Play / Stop) · **View** (Rearrange · Reset Layout) · **Help** (F1). On macOS it is the app menu
  (`setMacMainMenu`) with Preferences ⌘, in the Terminator menu; on Windows it is the window's menu bar. The key
  equivalents come from an `ApplicationCommandManager`, so they are real shortcuts rather than painted ones.
- **Every item forwards to the PAGE** (`terminator.menu {key}` → `ipc.onShortcut(key)`), because the page owns
  projects, exports and the layout. That is not just tidiness: on macOS a menu key equivalent is handled BEFORE the
  WebView sees the keystroke, so an item that did its own thing would quietly take the shortcut away from the page.
  SPACE deliberately has NO key equivalent — it belongs to the page (and to typing).
- **Open Recent** reads `app.recentProjects` (the list the page already writes) and arrives as the page's existing
  `onOpenFile(path)` contract, so a recent project opens exactly as a double-clicked file will.
- The page gained the three handlers nobody had registered: EXPORT (opens the export dialog), PLAY/STOP (the same
  unified transport SPACE drives) and HELP.
- **Gate:** the probe fires the menu's HELP item from the shell and asserts the PAGE opened its help window
  (`menuReachedPage`) — a menu that renders but reaches nobody is exactly the shape the old stub had.

## Phase 6 — 6.3 DONE (YOUR SYNTHS PLAY INTO THE MIXER), 2026-08-24

An INSTRUMENT plugin is a SOURCE, like the bass synth: notes in, audio out into a mixer strip.

- **Engine:** `ExternalProcessor` grew `processBlockWithNotes` (the block's `ExternalNote`s at their sample offsets;
  an effect ignores them, which is why the default forwards to `processBlock`). The Engine holds ONE instrument —
  pointer + strip — and renders it beside the bass: the buffer it gets is SILENT (an instrument writes, it does not
  process what is there), and its output goes into its strip (or dry into outs 1/2 when it has none), so the fader,
  the inserts after it and the console all apply. Notes come from `Command::instrumentNote` (sample-exact when the
  page says when) and from MIDI IN — but only when `setInstrumentMidi` is on. **It is OFF by default: the standing
  rule is that keys and MIDI trigger pads**, so playing the synth is a deliberate choice.
- **App:** `openInstrument` / `closeInstrument` on the rack (one at a time), the adapter turning the block's notes
  into a `MidiBuffer`. Same lifetime rule as an insert, same re-prepare on a device change.
- **Page:** the same PLUGIN slot and the same picker — instruments are listed with `· INSTR`, and choosing one
  loads it as the strip's INSTRUMENT instead of an insert (the insert itself stays the pass-through it is). The
  device panel gains a **MIDI IN** toggle next to EDITOR.
- **Gates:** 3 engine cases (notes play it and its audio takes the strip's fader · a MIDI note plays the instrument
  instead of the pad it is mapped to · no allocation) — **ctest 395/395**. Probe: with
  `TERMINATOR_PROBE_INSTRUMENT=<a synth .vst3>` it scans, opens and checks the ENGINE holds it — verified locally
  with **Massive X** (`instrumentOpened/Attached/Detached` all true, strip 20).
- **Fixed on the way:** `scanFile` now returns the IDs it added. Matching a freshly scanned plugin back by FILE
  PATH is fragile — a format can report the path its own way, and Massive X did — so the caller gets the ids
  instead of guessing.

**Still open in 6:** 6.5 MIDI learn on plugin params · 6.6 crash drills. An instrument is not SEQUENCED yet (no
notes from the chop/drum sequencers or the arrangement — that is a Phase 10 "beyond parity" question), and the
offline render carries INSERT plugins but not the instrument.

## Phase 5 — 5.1e DONE (THE INPUT LIST IS YOUR INTERFACE'S CHANNELS), 2026-08-24

RECORD SAMPLE's INPUT list was still the BROWSER's devices in the shell — a list the engine does not use for a
take at all (it records off the interface's own channels). Natively it now lists **the interface's channels**:
every enabled pair as a stereo take, then each channel on its own as a mono one, named the way the driver names
them. The engine records exactly those channels, in that order, and a mono pick makes a MONO file rather than one
with a silent second side. The MONITOR listens to the same channels, so what you hear is what you are about to
record. The browser list stays for the web build; 🔁 and system audio are unchanged.

## Phase 6 — 6.4 DONE (AND THE EXPORT HAS THEM TOO), 2026-08-24

A plugin you can hear live but not in the file is exactly the trap this project already walked into once (4.6, the
premium device that was live-only until the export went native). So an export now loads the plugins its chains
name, before a sample is rendered.

- `RenderFxSpec` carries `pluginId` / `pluginState` (read straight off the project's chain — the PLUGIN and STATE
  params) and a `processor` the HOST fills in. `ProjectRenderOptions::prepareMixer` is the hook: called once the
  mixer spec is built and before anything renders.
- The export gets **its own instances**, not the live ones (those are being played through), created on the
  MESSAGE thread — `MessageManager::callSync` from the render thread — with the state the project saved, and
  destroyed back on the message thread when the render ends (both paths, including a cancel).
- **A plugin that will not load is reported**, not skipped in silence: the export reply carries `plugins` (how many
  loaded) and `pluginsMissing`.
- Gate: `export: a plugin insert is in the rendered file` — the same render with and without a processor attached,
  0.125 vs 0.5 peak. An insert with nobody attached renders as the pass-through it is, not silence. **ctest
  391 + 1.**

**Still open in 6:** 6.3 instruments · 6.5 MIDI learn on plugin params · 6.6 crash drills. And the MPC Project /
Drum Rack exporters are still the page's, so a plugin (like any native-only device) is missing from THOSE files —
that is the Phase-8 `.mpcsample` / `.adg` writer item, now with one more reason to do it.

## Phase 6 — 6.2 DONE (YOUR PLUGINS ARE IN THE CHAIN), 2026-08-24

A VST3 / Audio Unit is an INSERT now: pick it in a mixer slot, hear it in the engine's own chain, open its window,
and the choice travels with the project.

**The split that keeps the engine headless.** The engine never learns what a VST3 is: `core/fx/PluginFx.h` is a
slot holding an `ExternalProcessor*` — an interface the APP implements over `juce::AudioPluginInstance` — handed
over by `Command::mixerSetFxProcessor`. `libterminator` still links no plugin machinery at all (the CLI renderer
and the tests prove it). An EMPTY plugin slot is a pass-through, bit for bit, so a chain restored from a project
keeps its slot while the app is still loading the plugin and the mix does not stop for it.
- **Lifetime is the whole game.** The app may only destroy an instance after detaching it AND letting the engine
  run blocks; `PluginRack` keeps a retired list and drains it against `blocksProcessed` (or at once when the engine
  is not running). Same rule on a device change: detach, `releaseResources` / `prepareToPlay` at the new rate,
  re-attach.
- **PDC:** a plugin brings its latency with it, so `Mixer::setFxProcessor` rebuilds the plan when the number moves.
- **The app half** (`app/src/PluginRack.{h,cpp}`): `open` (with a saved state), `close`, `editor` (the plugin's own
  window, in its own `DocumentWindow`), `state` / `setState` (base64 — what a project carries), `params` /
  `setParam`, `rack`. Stereo in / stereo out is requested so the engine's two channels are wrapped with NO COPY;
  a plugin that refuses keeps its own layout and gets a scratch buffer sized once.
- **The page half:** `plugin` is an FX_REGISTRY entry (`ui/src/mixer/fx/PluginFX.ts`, a documented pass-through
  like every premium device) offered only inside the shell. Its `PLUGIN` param is the plugin's identifier and
  `STATE` its own settings — both ordinary params, so they ride the chain into the project, through a copy/paste of
  the slot, everywhere. The mixer's device panel gets an **EDITOR** button; the picker lists what the scan found.
  The shadow loads/unloads as slots change (a remove or a reorder re-seats the strip's plugins rather than guessing
  at the new indices) and pulls each plugin's own state back into the chain every 15 s — a plugin's state changes
  while you turn ITS knobs, in ITS window, and nothing tells us when.

**Two real bugs, both found by making the gate real:**
1. **The known-plugin list never survived a relaunch.** `KnownPluginList::createXml()` makes its own
   `<KNOWNPLUGINS>` element, which `save()` put inside a `<KNOWN>` wrapper — and `load()` handed the WRAPPER to
   `recreateFromXml`, which silently found no plugins. Every launch started empty, and nothing said so. The probe
   caught it because it reports `known` before scanning.
2. **The scan child booted a whole GUI app.** The `--scan-plugin` branch lived in `initialise()`, so every child
   became an NSApplication. `main()` now forks the road BEFORE JUCE's app machinery: the child brings up only the
   message manager, hides itself from the Dock and prints the descriptions.

**Gates:** `tests/engine/test_plugin_fx.cpp` (4 cases: an empty slot is bit-identical to no slot · an attached
processor is heard and WET blends it · its latency joins the PDC plan on attach and leaves on detach · attaching,
running and detaching allocate nothing) — **ctest 391/391**. Probe: `plugins62` opens a REAL VST3 on a strip and
asserts the ENGINE's slot is holding it (`attached` / `detached`), and the shadow's self-test drives the same
thing from the PAGE (`pluginHosted` / `pluginUnhosted` — verified true locally with AIR Tape Echo). Both degrade
to "skipped" on a machine with no plugins, which is every CI runner.

**Known local flake, NOT this work:** the probe's `prefsWindow` assertion fails on this Mac right now — measured
against a clean baseline build of the previous commit, which fails it too, while CI is green on the same check.
Environmental; do not chase it in code.

**Not done in 6.2 (on purpose):** instruments (6.3 — a plugin as a pad/bass sound), plugin params on the page's own
knobs (the editor is the way in for now), offline render with plugins (6.4 — `ProjectRenderer` builds its own
mixer, so an exported mix has no plugins in it YET), MIDI learn on plugin params (6.5) and the crash drills (6.6).

## Phase 6 — 6.1 DONE (THE PLUGIN SCAN, IN CHILD PROCESSES), 2026-08-24

Terminator can see his VST3s and Audio Units. `app/src/PluginHub.{h,cpp}` + `terminatorPlugins` + a
Preferences → PLUGINS pane.

- **Every plugin is scanned in its OWN child process.** The app relaunches its own binary with
  `--scan-plugin <format> <file>`; the child prints the `PluginDescription`s as XML on stdout and exits. A plugin
  that crashes, hangs (30 s) or exits non-zero takes THE CHILD down and lands on the **blocklist**, so the next
  scan skips it — the only honest way to run a machine full of other people's code, and what every host does.
  `moreThanOneInstanceAllowed()` had to become conditional: Terminator is single-instance, so without that the
  child would have handed its command line to the running app and scanned nothing.
- **JUCE 9 note:** `AudioPluginFormatManager::addDefaultFormats()` is `= delete` in the headless module; the
  UI-capable list comes from `juce::addDefaultFormatsToManager()` in `juce_audio_processors` (which the app links
  explicitly now, on top of `juce_audio_utils`). `JUCE_PLUGINHOST_VST3=1` everywhere, `JUCE_PLUGINHOST_AU=1` on
  macOS.
- The known list, the blocklist and the extra folders live in `plugins.xml` beside settings.json — a scan happens
  when he asks, not on every launch. `scan` skips what is already known; `rescanAll` re-reads everything AND clears
  the blocklist (it is also the "try the failures again" button).
- Verbs: `list` · `scan` {rescanAll?, folders?} · **`scanFile`** {file, format?} (one file through the same child
  path — the probe's end-to-end check, and the way to add a plugin the folder walk missed) · `cancelScan` ·
  `remove` · `clearBlocklist` · `setFolders`. Progress → `terminator.pluginScan` {done, total, current, found,
  finished}.
- Preferences → **PLUGINS** (native only): SCAN FOR NEW / RESCAN EVERYTHING / STOP, a filter, the list with
  format + FX/INSTR, extra folders (ADD FOLDER… via the shell's own dialog), and the "did not load" list with
  TRY THESE AGAIN. Help updated in the same commit.
- **Gate: probe OK** — `plugins61` {ok, formats 2, scanFileOk, scanFileAdded}. The probe scans ONE file end to end:
  `TERMINATOR_PROBE_PLUGIN=<a real .vst3>` locally (verified: **added 1** from AIR Tape Echo), and the app's own
  binary in CI, which must come back "0 added" rather than hanging. No full scan in a gate — that is minutes of
  other people's code.

**NEXT (6.2):** host one as an INSERT — the engine gets a `plugin` FxType whose processing is a pointer the app
hands in (the engine must not learn about `juce_audio_processors`), the editor opens in its own window, the state
saves with the project, and the plugin's latency joins the PDC plan.

## Phase 5 — 5.1d DONE (THE RESAMPLE TAKE IS THE ENGINE'S, AND A TAKE IS NOT LATE ANY MORE), 2026-08-24

**A BUG, not a preference: 🔁 TERMINATOR OUTPUT recorded SILENCE in the shell.** The page taps its own Web Audio
master (`engine.mixerEngine.master.output`) — but inside the shell the native engine plays the pads and the TS
engine's voices are routed into a silent bus (`nativeEngineShadow` → `mutePadVoices`). So the resample take was a
tap on a muted graph. Nobody had reported it because 5.1b only moved the INPUT sources onto the engine.

- **`RecordSource::master`** — the take is Terminator's own output, taken post master gain and **before the click**
  (a count-in you recorded against is not part of the sample you are making; the clicks bypass the mixer exactly as
  they always did). `terminatorRecord {verb:'start', source:'master'}`; the page sends it for 🔁 and the whole
  Web Audio tap is unused in the shell.
- **LATENCY COMPENSATION** — what you played for musical time M only reaches the input stream a round trip later,
  so an INPUT take armed to a musical position now starts at `M + roundTrip` and frame 0 is the performance rather
  than the latency. The number is the LOOPBACK-MEASURED one (`calibration.roundTripSamples`, and only at the rate
  it was measured at), else the driver's reported in + out latency — the fallback every DAW uses.
  `compensate:false` opts out. A MASTER take never gets it: nothing left the machine, and shifting it would move
  the take off the grid it was armed to.
- Gates: 4 more cases in `test_record_arm.cpp` (the master take is post-fader; the count-in is NOT in it; the
  compensation lands frame 0 on the performance; a master take ignores compensation). **ctest 387/387 · probe OK ·
  ui typecheck 5 = baseline.**
- **Owed to his ears:** resample a beat (🔁) — it should now actually contain the beat — and a count-in take
  against the click, which should sit on the grid without nudging.

## Phase 5 — 5.1c DONE (THE ARM: A TAKE STARTS ON A SAMPLE, AND YOU CAN HEAR YOURSELF), 2026-08-24

5.1a made the engine record and 5.1b put the button on it. What was still missing is everything that turns a
CAPTURE into a TAKE: it began on whichever buffer boundary the click happened to land near, it ran until somebody
pressed STOP, and you could not hear the input while you set the level.

- **THE ARM.** `Engine::startRecord(cfg, err, RecordArm)` opens the file on the message thread as before — opening
  it is the slow part, and a take that has to wait four beats cannot afford to do it when its sample arrives — and
  the AUDIO thread starts capturing at the take's own sample. Four modes: `immediate` (5.1a's behaviour),
  `atSample` (an exact engine sample), **`countInDownbeat`** (the downbeat a pending count-in is counting to) and
  `transportStart` (the transport's OWN anchor — `seqPlay(atSample)` books a start in the future, and the take
  begins there, not in the block the command landed in). `Recorder::push` grew a `startOffset` so the first
  recorded frame is the armed frame, mid-block: armed at 300 with a 128-frame buffer, frame 0 of the file IS
  sample 300, not 256.
- **PUNCH-OUT.** `lengthSamples` ends the take on its own frame (500 frames means 500, not "the block that passes
  500"). The audio thread stops capturing and raises `recordComplete()`; the shell's timer closes the file and
  emits **`terminator.recordFinished`** {path, frames, dropped, seconds}, and the page lands the take the same way
  STOP does — nobody has to be holding the button when a timed take finishes.
- **THE COUNT-IN IS THE SHELL'S JOB, not the page's.** `terminatorRecord {verb:'start', countIn: N}` arms the take
  AND books the clicks, in that order, in one place. Doing it from the page would race: if the count-in were
  booked after the arm the engine would already be waiting for a downbeat that has been and gone. Cancelling the
  count-in FINISHES an armed take (an empty take the page reports beats a recorder that silently never fires).
- **INPUT MONITORING.** `Command::setMonitor(enabled, ch0, ch1, gain, strip)` — the interface's inputs, heard
  through the engine, ramped (OFF fades over a block rather than clicking), one channel heard centred, and
  optionally through a MIXER STRIP so the take is auditioned through the fader, inserts and console it will sit
  behind. It costs no latency of ours: this block's input is added to this block's output, so what you hear is the
  driver's round trip and nothing else.
- **The page:** RECORD SAMPLE gains a COUNT-IN picker (OFF / 2 / 4 / 8 beats) and a MONITOR button, both only for
  the engine's own path (Terminator's output and system audio stay on the page path). The REC button reads
  `● COUNTING IN` while armed and a second click CANCELS — nothing is captured, so nothing is saved. The monitor
  closes with the panel: an input left open behind a closed panel is a feedback loop waiting to happen. Help +
  tooltips updated in the same commit.
- The snapshot carries `recordState` (0 idle · 1 armed · 2 rolling · 3 punched out), `recordStartSample`,
  **`recordStartPlayhead`** (the TRANSPORT position of the take's first frame — where it belongs in the song),
  `recordFrames`, `recordDropped`, `monitorOn`, `monitorStrip`.

**Gates (5.1c):** a new `test_record_arm.cpp`, 10 cases — the armed sample is the file's first frame (mid-block),
the punch-out length is exact, the count-in downbeat is the take's first frame, a cancelled count-in finishes the
take, the transport anchor is honoured, the reported playhead is right, the monitor's gain/centre/strip-fader/
mute behaviour, and an allocation counter over armed → rolling → captured with the monitor open (0). **ctest
383/383 · RTSan clean · probe OK** (the probe now arms a take a minute ahead over the real bridge handler and
asserts `armed` + `monitorOk` + 0 frames) · ui typecheck 5 = baseline · vite build clean.

**Still unwired on purpose:** a punch-out LENGTH and the `atSample` start have no UI yet — grid-aligned punch-in
while the song plays wants the page to name the next bar line, which belongs with the arranger, not the sample
recorder. Both are on the bridge and both are gated.

**Owed to his ears:** the count-in (does the take land where the click says?) and the monitor (level, feel,
through a strip) — both on his interface.

**NEXT (5.1d):** the take that knows the song — dropping a punched take onto the arrangement at
`recordStartPlayhead`, and the input-channel picker (which of the interface's inputs a take takes) in the panel.

## Phase 5 — 5.1b DONE (THE RECORD BUTTON IS ON THE ENGINE), 2026-08-24

RECORD SAMPLE now makes its take in the ENGINE when it is running in the shell and the input is a real one. The
page's `getUserMedia` path stays exactly where it was for the browser build **and for the two sources the engine
does not have**: Terminator's own output (🔁 — that is a bounce of what we are playing, not a capture) and system
audio (that is the OS's, and it does not arrive on the interface's inputs). If the engine refuses to start, the
code falls through to the page path rather than failing the click.

- The take is written straight to a 24-bit WAV by the engine, read back through `readBinary`, saved into the
  library and dropped on a pad — **the same library + pad landing as before**, so nothing downstream changed.
- **The level meter reads the ENGINE's peaks**, painted as a level bar on the same canvas (the engine reports a
  peak rather than a spectrum, and the peak is what tells you whether you are about to clip the take). There is no
  MediaStream to hang an analyser on, and the engine's number is the truer one anyway — it is the interface's own
  sample, before anything of ours.
- **A dropped-frame take says so.** `stop` returns `dropped`, and anything but 0 surfaces as an error on the take.
- The temp file is trashed after it is read.

**Gate:** app probe PROBE OK · ui typecheck 5 = baseline · vite build clean. **Owed to Victor's ears — and this one
genuinely needs him:** record from his interface and confirm it arrives raw, 24-bit, on the right input, with the
meter moving. That is the whole reason this project exists and it cannot be measured headlessly.

**NEXT (5.1c):** monitoring, punch/count-in, and the transport-aligned start that makes a take land on the grid.

## Phase 5 — 5.1a DONE (THE NATIVE RECORDER: CAPTURE FROM THE INTERFACE), 2026-08-24

Phase 4 is finished, so this starts Phase 5. **What the app does today:** RECORD SAMPLE goes through the PAGE —
`getUserMedia` → `MediaRecorder` → decode — which in the native shell means the audio takes a trip through WebKit
before it is a file: the interface's channels cannot be chosen, the format is whatever the browser felt like, and
nothing is aligned to the transport. This is the engine's own path.

`engine/io/Recorder.{h,cpp}` + `Engine::startRecord/stopRecord` + the `terminatorRecord` bridge function
(`start` / `stop` / `status`) and `native.record` on the page's typed bridge.

**The shape is the only safe one:** the audio thread does nothing but COPY into a preallocated ring — no
allocation, no locks, no file I/O — and a writer thread drains it into a WAV. **If the writer falls behind, the
ring drops the newest block and COUNTS it.** A take with a counted hole is worth more than one that silently
splices the two sides together, because the second kind is only discovered later, in the mix. `dropped` is
reported all the way out to the page for the same reason.

24-bit is the default (what an interface actually gives); 32-bit float and 16 are there too. The take runs
**before** anything else looks at the block, so what is on the interface is what lands in the file.

**Gates (5.1a):** a new `test_recorder.cpp`, 6 cases — what goes in is what lands in the file, sample for sample at
32-bit float · 24-bit really is 24-bit and lands within a step and a half · **the audio thread never allocates**
(the allocation counter around `push()`, so this gate runs on Windows CI too, not only under RTSan) · an overrun is
counted and every frame is accounted for as either captured or dropped · the recorded channels are the ones asked
for, in the order asked for (a take of inputs 3 and 1 — "the first two" is not good enough for anyone with more
than a stereo input) · a bad path fails cleanly and leaves nothing for a later `stop()` to trip over.
**mac-debug ctest 373/373 · RTSan 374/374 · app probe PROBE OK · ui typecheck 5 = baseline.**

**NEXT (5.1b):** move the RECORD SAMPLE button onto this — which needs the input-device / channel picker, the
level meter reading `status`, and the recording landing in the library as it does today. Then 5.1c: monitoring,
punch/count-in, and the transport-aligned start that makes a take land on the grid.

## Phase 4 — 4.7d DONE (GROUPS AND BUSES — THE LAST ITEM ON THE BRIEF), 2026-08-24

The routing half of B4: "any channel can route to any channel to create groups and busses", and "multi-select
several mixer tracks → group them into a bus in one gesture". **The engine already had all of it** — `setOutput`
with a `reaches()` cycle guard and `StripKind::bus` have been there since 4.1. What was missing was everything
above it: the page had no bus concept, no per-strip output, and the exporter never read a routing.

- **Page model:** `ChannelStrip.outputTo`, `MixerEngine.setOutputTo()` (which re-wires the page's own Web Audio
  graph too, so the browser build and the meters agree with the engine), `BUS_CHANNELS`, and `addChannel(name,
  {kind: 'bus'})`.
- **The gesture:** `groupChannels(names)` — a new `busN` appears, every selected strip is re-routed into it, the
  bus goes to the master. In the UI it is a **GROUP** button that shows up as soon as two strips are selected (the
  marquee selection was already there), and bus strips render with an accent bar so a group is visible at a glance.
- **It survives a save:** the strip preset carries `out`, `restore()` re-creates `busN` strips as BUSES and applies
  every routing **after all the strips exist** (a strip pointed at a bus that did not exist yet would silently have
  stayed on the master).
- **It survives an export:** `buildMixerSpec` resolves the saved name to a strip index, and a strip named `bus…`
  becomes `StripKind::bus` so **PDC puts it in the bus tier** — a group returning on the channel tier would arrive
  early against the channels feeding it.
- **It survives an attach:** the shadow re-sends the routing with the strip, or a re-attached session would come
  back with every group empty.

**A guard the Mixer was missing, found by my own test:** `Mixer::process()` never checked `numSamples` against the
block it was PREPARED for. A test that pushed 512 through a mixer prepared for 128 got **silence** back instead of
a complaint — the friendlier of the two things that can happen when you run off the end of every internal buffer.
There is an `TERMINATOR_RT_ASSERT` + a clamp now.

**Gates (4.7d):** 3 more cases in `test_fx_route.cpp` — the exporter resolves routing by name (including an older
project with no `out` key landing on the master, and the bus coming back as `StripKind::bus`) · the cycle guard
refuses a loop, a self-route and a back-route while allowing the master · **and the audio really arrives at the
bus**: pulling the BUS fader down takes the channel with it.
**mac-debug ctest 367/367 · RTSan 368/368 · app probe PROBE OK · ui typecheck 5 = baseline · vite clean.**

### B4's PHASE-4 BRIEF IS COMPLETE
Every item: 64-bit summing · every effect rebuilt · the CONSOLE re-models · Analog Filter · Lexicon-224 reverb ·
the multi-band EQ · tape echo · the Distressor-shaped comp · the SSL channel strip · Decapitator-shaped saturation ·
RC-20-shaped RETRO · the Pro-L-shaped limiter · mid/side everywhere · groups and buses.

## Phase 4 — 4.7c DONE (CHANNEL: THE SSL 4000 G STRIP — THE LAST DEVICE ON THE BRIEF), 2026-08-24

`ChannelStripFx`, `FxType::channelstrip`, 24 params. Filters (HPF 16–350, LPF 3k–22k, off at their ends as on the
desk) → the four-band EQ (LF shelf/bell · LMF · HMF · HF shelf/bell) → the dynamics section (compressor + gate-
expander sharing ONE detector, which is why they never fight), with **DYN PRE EQ** flipping the order the way the
desk's routing button does.

**The switch the whole device is about: E vs G.** On the **E** (1981, black knob) the Q is constant, so a boost is
the same shape at 3 dB and at 15 — a surgical tool. On the **G** (1987, brown knob) the **Q follows the gain**: it
widens as the gain returns to zero and tightens as it is pushed, which is why small moves are broad and flattering
and big ones are precise, and why the G is the one people call musical. Gated exactly that way — the width of the
same boost an octave out must be UNCHANGED between a 3 dB and a 15 dB move on E, and measurably narrower at 15 dB
on G. If those two measured the same the switch would be decoration.

**The bug the "defaults are bit-exact" gate caught:** `compEnv_` and `gateEnv_` hold **decibels of gain reduction**
(they are summed and converted once), so doing nothing is **0** — they were initialised to **1.0**, the linear
value for unity, which made the strip **2 dB louder at rest**. Inserting a channel strip and touching nothing
raised the level. That gate exists for precisely this and it earned its place on the first run.

**Gates (4.7c):** 5 cases — defaults bit-exact (1e-9) · E vs G · the filters and all four bands (including shelf vs
bell) · the dynamics (GR reported, FAST catches more transient than SLOW, the gate shuts quiet and passes loud,
PRE EQ measurably differs from POST) · finite at 3 rates with everything maxed, reset, block-invariance to 1e-9.
**mac-debug ctest 364/364 · RTSan 365/365 · ui typecheck 5 = baseline · vite clean · format clean.**
Page: `channelstrip` in `FX_REGISTRY` as **CHANNEL**, the GR readout and the native GR mirror extended to it, Help.

### B4's premium brief — the device list is COMPLETE
ANALOG FILTER · FET COMP · TAPE ECHO · HALL 224 · SATURATOR · LIMITER · RETRO · EQ 6 · CHANNEL, plus the CONSOLE
re-models and M/S on every slot. **The one item left from the brief is the ROUTING half**: "any channel can route
to any channel to create groups and busses" (the engine already has the free routing graph from 4.1 — this is
mostly a PAGE feature) and "multi-select several mixer tracks → group them into a bus in one gesture".

## THE liveRec PROBE CHECK — the third failure, and the actual fix (2026-08-24)

`liveRecOk` failed CI for a THIRD time (run 32747506096, macOS universal): all five attempts used, the hit landing
15000 samples — five steps — off the grid, on a runner that was visibly starved (`seqPageDriftMs` 36.8, cursor age
98.9 ms against a 3 ms tolerance). The drum half passed on its first try in the same run.

**Raising the retry count is what "fixed" it the last two times, and that is the tell that the retry was never the
fix.** The cause has been understood since the first failure and is not the engine: **WebKit throttles the page it
does not consider visible**, so the hidden probe page's clock re-anchor runs late and books the hit off the grid.
Nothing about the native path is wrong when that happens.

**The fix: the probe asserts the PATH, and reports the offset.** `liveRecOk` is now `armed && the hit reached pad
62 && it was written to a step` — for the drum half likewise. `liveRecOffsetSamples` and `liveRecExact` are still
in the JSON and the loop still RETRIES for an exact landing (it is the normal result), so a real regression is
visible; it just does not fail the build on a starved runner. **The sample-exact contract is unchanged and is
gated deterministically in C++** (`test_engine`, `test_chop_sequencer`), where nothing can starve it.

The general rule, worth keeping: **a probe should assert what only a probe can assert.** Re-testing a deterministic
guarantee in a flaky environment does not strengthen the guarantee — it just moves a solid gate into a place where
it can lie in both directions.

## Phase 4 — 4.7b DONE (THE PARAM BUDGET, AND THE MULTI-BAND EQ IT UNBLOCKED), 2026-08-24

**`kMaxFxParams` 12 → 32.** The 4.6f note flagged this as the thing standing between the premium list and an EQ.
Checked rather than assumed: the constant's only footprint is `Mixer::SavedSlot::params[kMaxFxParams]`, and
`savedChains_` is a **heap vector** (64 strips × 8 inserts × 32 floats = 64 KB), so it is not inside `Engine` and
the standing `static_assert(sizeof(Engine) <= 384 KB)` is untouched — it still compiles, which is the proof.

**`EqFx6` — six bands, 31 params.** Each band is TYPE (OFF / BELL / LOW SHELF / HIGH SHELF / LOW CUT / HIGH CUT /
NOTCH / TILT) · FREQ · GAIN · Q · SLOPE, plus one OUT trim. The cuts are **real cascaded Butterworth sections** —
12 / 24 / 36 / 48 / 72 / 96 dB per octave, up to eight 2-pole sections — not one biquad with its Q wound up.
**A band set to OFF is bit-exact:** its sections are set to identity and skipped entirely, so five unused bands
cost nothing.

**The trap that would have shipped silently:** the Web Audio biquad takes **Q in DECIBELS for the cut types** (the
spec's convention; linear for everything else). Feeding the Butterworth section Qs in linear would have put every
slope in the wrong place — quietly, since it would still look like a filter. The cascade converts
(`20·log10(qLin)`), and the gate below is what would have caught it.

**The gate that had to be rewritten, and why it matters:** the first slope test measured the difference between two
octaves in the stopband. At 96 dB/oct that is **−192 dB**, far under what a −26 dBFS test tone can resolve, so it
read **21 dB/oct** — it was measuring the numerical floor, not the filter. Each slope is now checked against the
**Butterworth magnitude** at the frequency where theory says it is ~40 dB down: comfortably measurable, and a much
tighter claim than "about that steep". **A gate that cannot see the thing it asserts will happily report a number.**

**Gates (4.7b):** 6 more cases — all-OFF bit-exact (1e-12) + the param ids/ranges · a bell at its frequency with
its gain, leaving the rest alone, and two stacking to 12 dB · both shelves + TILT · every one of the six slopes vs
theory, and a HIGH CUT leaving its passband alone · NOTCH depth, OUT trim, reset, block-invariance to 1e-9 · finite
with all six bands on every type at three rates.
**mac-debug ctest 359/359 · RTSan 360/360 · ui typecheck 5 = baseline · vite clean · format clean.**
Page side: `eq6` in `FX_REGISTRY` as **EQ 6** (a flat 31-control panel — a curve editor is a UI project of its own
and is noted as future work) + Help. Per-band M/S is served by the 4.7a ROUTE: two EQs, one MID, one SIDE.

## Phase 4 — 4.7a DONE (M/S EVERYWHERE: A ROUTE ON EVERY INSERT SLOT), 2026-08-24

B4's "mid/side everywhere", built the only way it stays maintainable: as a property of the SLOT, not of each
device. `FxRoute { stereo, mid, side, left, right }` on the insert chain, so **all 25 devices** — the 17 parity
ports and the 8 premium ones — get it at once, and a device added tomorrow gets it for free.

- **STEREO is bit-exact and costs nothing:** the chain still calls `process(inL, inR, n)` in place with no copy
  unless the slot asks for a route (or the device has a WET blend). Gated on a unity UTILITY through the whole
  strip at 1e-9.
- The component is extracted, given to the device in BOTH channels (so a stereo device behaves), and put back.
  Gated the way it should be: a MID-routed attenuator flattens a dead-centre signal and leaves a pure-side signal
  **untouched to 2 %**, and vice versa.

**THE PART THAT MAKES IT REAL — a routed device with LATENCY.** It delays only the half it processes, so the other
half comb-filters against it when they are recombined. That sounds like a broken plugin and is close to
undiagnosable by ear. So a routed slot whose device reports latency takes one of **8 compensation delay pairs**
(`kMaxRoutedLatencySlots`) and the untouched half is delayed by exactly the device's own `latencySamples()`.
Gated: a pure-SIDE signal through a MID-routed LIMITER with 5 ms of look-ahead comes back at full level with L and
R still exactly opposite (a comb would notch it). **When the pool is exhausted the slot stays STEREO and
`routeRejected()` counts it** — refusing is better than sounding subtly wrong, and that is gated too.

**Gates (4.7a):** a new `test_fx_route.cpp`, 5 cases (STEREO transparent · MID/SIDE isolation · LEFT/RIGHT · the
latency alignment · the pool running out). **mac-debug ctest 353/353 · RTSan 354/354 · app probe PROBE OK ·
ui typecheck 5 = baseline · vite clean · format clean.**

Page side: `FxRoute` + `FX_ROUTES` + `FX_ROUTE_HELP` in MixerEngine, `fxRoutes[]` per strip (both ChannelStrip and
MasterStrip), `setFxRoute`, the `mixerSetFxRoute` bridge verb (re-sent with the chain on attach), a ROUTE selector
in each device panel's header that turns accent-coloured when it is not STEREO, and a Help section.

## Phase 4 — 4.6i DONE (THE PREMIUM CONSOLE RE-MODELS — AND A REAL EXPORT BUG THEY UNCOVERED), 2026-08-24

The last item on B4's premium list that fits the current param model. `ConsoleFlavour` gains **SSL+ / NEVE+ / API+**
beside the frozen SSL / NEVE / API. The parity three are untouched by construction — the existing console gates
(level-matching, harmonics per flavour, the seeded tolerances) all still pass unchanged, which IS the proof.

**What the re-models add:** the same polynomial saturator and the same per-strip tolerances, but run **4×
oversampled** through the shared `ButterLp4` decimator (moved out of `AnalogFx.h` into `FxDsp.h` this phase, where
shared DSP belongs), plus the part of each desk the parity stage could not afford:
- **NEVE+ — the actual transformer.** Its core saturates on LOW frequencies first: the signal is split at 160 Hz,
  the low band is driven through its own tanh and put back, so the bottom compresses and thickens while the top
  stays clean. That band asymmetry is what "Neve weight" means and no static curve produces it.
- **SSL+ — the op-amp:** more odd harmonic, kept tight (a3 0.21 vs 0.144), a touch more air.
- **API+ — discrete class-AB:** both harmonics pushed together with a firmer presence lift.

**THE BUG THIS UNCOVERED — every native export rendered NEVE and API projects as SSL.** The page serialises the
console flavour in UPPER case (`MixerEngine.serialize()` → `console: {...this.console}`, values `'SSL' | 'NEVE' |
'API'`), and `ProjectRenderer`'s parser compared **lower case** (`fl == "neve"`). It never matched, so every
project fell through to the default. Nothing sounded broken — the bounce just was not the desk the user chose,
which is precisely the "export == what you hear" break the phase exists to prevent. **No gate had ever set the
flavour string.** Both parsers are case-insensitive now, and there is a gate that walks every string the page can
write (plus lower case, plus a nonsense value falling back to SSL).

**Gates (4.6i):** 2 more cases in `test_console.cpp` — the flavour string → the flavour the user picked (9
assertions), and the re-models being level-matched to the same 0.6 dB rule, folding back LESS than the parity stage
when driven at 6 kHz (what the oversampling buys), and being three different desks (NEVE+ has the higher even/odd
RATIO, not merely more of both — measured that way because the transformer stage drives its saturator harder, so
an absolute comparison would have said the wrong thing).
**mac-debug ctest 348/348 · RTSan 349/349 · ui typecheck 5 = baseline · vite clean · format clean.**
Page side: six flavour buttons, a `CONSOLE_FLAVOUR_HELP` map so each button says what it is, and the Help section
explaining why the plain three will never change.

### Phase 4.6 (premium devices) — SEVEN devices and the console re-models, all shipped
ANALOG FILTER · FET COMP · TAPE ECHO · HALL 224 · SATURATOR · LIMITER · RETRO · CONSOLE+. What is LEFT from B4's
brief needs the param-model step first (see the 4.6f note): the Pro-Q-4-style EQ and the SSL 4000 G channel strip,
both of which need more than 12 params. **M/S everywhere is also still open and is cross-cutting** — it belongs on
the insert chain as a per-slot ROUTE (STEREO / MID / SIDE / L / R), not inside each device.

## Phase 4 — 4.6h DONE (THE SEVENTH PREMIUM DEVICE: RETRO — THE CHARACTER BOX), 2026-08-24

`RetroFx` in `AnalogFx.{h,cpp}`, `FxType::retro` appended. The RC-20 shape from B4, six modules in series: NOISE
(VINYL / TAPE / STATIC / RADIO, with real crackle on the vinyl and static settings), WOBBLE, **DISTORT with EIGHT
curves** (TUBE / TAPE / FUZZ / DIODE / FOLD / BITS / TRANSISTOR / CRUSH — his "a LOT of saturation and distortion
options inside it"), DIGITAL (bit depth *and* sample rate falling together), SPACE, MAGNETIC (dropouts + head bump
+ the top going away).

**Two rules this device is built on, both gated:**
- **Every module does nothing at 0** — with all six down the box returns immediately and the signal is
  bit-identical (1e-12). You can use one module and leave the rest.
- **Everything random is SEEDED and re-seeded on reset**, so an export is the take you heard: two fresh devices
  with the same settings agree sample for sample (1e-15), and the block size does not change it (the RNG advances
  per sample, not per block). A character effect whose crackle lands somewhere else in the bounce is a bug.

**Three issues, all gate-found:**
1. **Four of the eight curves were the same sound.** At high drive FUZZ and CRUSH both became a square, as did
   BITS and TRANSISTOR — physics, not a bug, but it makes the selector decoration. FUZZ is **asymmetric** now (the
   two halves clip differently, so it makes even harmonics a hard clipper cannot) and BITS quantises to twelve
   steps rather than six, so the staircase itself is the character instead of the clipping. The gate also moved to
   a moderate DISTORT — the 4.6f lesson, again: drive anything hard enough and every clipper converges.
2. **The DC blocker was smearing DIGITAL's staircase.** Run unconditionally at the end of the chain, it turned a
   held bit-crushed value into a decaying one — 7168 distinct output values where a staircase should have a few
   dozen. It now runs only where DC can actually come from (the asymmetric curves and the crackle).
3. **"Does it distort" cannot be measured as one harmonic.** BITS is a QUANTISER: its 3rd harmonic sits at −52 dB
   while it is plainly, audibly dirty, because its fingerprint is broadband noise *between* the harmonics. The gate
   measures everything that is not the fundamental instead — otherwise it would have called a bit-crusher clean.

**Gates (4.6h):** 7 more cases — all-zero is bit-identical · seeded and block-invariant · NOISE is a level and the
four flavours differ in brightness · eight curves, each dirty and all eight distinguishable pairwise · DIGITAL
really is a staircase (a quarter of the distinct values) · WOBBLE decorrelates a steady tone and MAGNETIC dips the
level · SPACE puts a tail where there was none, finite at 3 rates × 8 curves with every module at 100, reset back
to silent.
**mac-debug ctest 346/346 · RTSan 347/347 · ui typecheck 5 = baseline · vite clean · format clean · ASCII grep
silent.** Page side: `retro` in `FX_REGISTRY` as **RETRO** + Help.

## Phase 4 — 4.6g DONE (THE SIXTH PREMIUM DEVICE: LIMITER — AND A REAL PDC BUG IT UNCOVERED), 2026-08-24

`LimiterFx` in `AnalogFx.{h,cpp}`, `FxType::limiter` appended. Seven styles (TRANSPARENT / PUNCHY / DYNAMIC /
ALLROUND / AGGRESSIVE / BUS / SAFE), GAIN into a fixed CEILING, program-dependent RELEASE, LOOKAHEAD 0–20 ms,
TRUE-PEAK, channel LINK, GR to the panel meter.

**How it cannot overshoot.** The anticipation is a **sliding minimum** of the required gain over the look-ahead
window (a monotonic deque on fixed arrays — O(1), no allocation), so the gain starts falling the moment a peak
ENTERS the window, `look` samples before it is played. Then the smoothed gain is **hard-clamped to the gain that
exact sample needs**. The styles shape HOW it gets there; the clamp is why it always arrives. Gated across
3 rates × 7 styles × 3 ceilings on hostile material (square edges, then a sine that jumps 30 dB): the output peak
never exceeds the ceiling.

**THE BUG THIS DEVICE FOUND — `Mixer::setFxParam` never rebuilt PDC.** PDC was rebuilt when a device was added,
removed, bypassed or the chain cleared — but **a PARAM can change a device's latency**, and the LIMITER's LOOKAHEAD
is exactly that. Left alone, moving that knob would have left the whole strip compensated for the old number:
silently off the grid, nothing sounding broken, just not where the other strips are. `setFxParam` now reads
`latencySamples()` before and after and rebuilds only when the number actually moved — a knob drag costs one
comparison. **This was a latent bug in the 4.4 PDC plan, not a new one; it needed a device with a latency PARAM to
show up.**

**Two more issues, both found by gates:**
1. **The look-ahead delay read the ring BEFORE writing it**, so LOOKAHEAD 0 delayed by a whole ring (an impulse at
   sample 100 came out at 1065) and quiet material came out as silence. Write, then read `look` back.
2. **TRUE PEAK did nothing** in the first version — the hard clamp measured the sample peak in both branches, so TP
   only affected the anticipation and the output's true peak was unchanged. It now reads the inter-sample peak of
   the sample being PLAYED (4-point Lagrange over its neighbours in the delay ring), which needs two samples of
   future — so TP puts a **two-sample floor on the look-ahead, reported in `latencySamples()`**.
   **And the TP gate itself was measuring nothing:** an 11 kHz test sine's samples wander across the phase and
   eventually land near the peak, so sample-peak limiting already looked fine. It now uses the textbook case — a
   sine at exactly a QUARTER of the sample rate, 45° out of phase, where every sample sits at 0.707 of a peak the
   converter still reconstructs — and asserts that TP off leaves ≥ 1.2× the ceiling on the output while TP on does
   not.

**Gates (4.6g):** 6 more cases — the ceiling across 63 combinations · TP vs sample peak · LOOKAHEAD == the reported
latency and the output really is delayed by it · under the ceiling it is bit-identical (1e-12) with GR 0 · GAIN
pushes it and AGGRESSIVE is louder than BUS · finite/reset/block-invariant.
**mac-debug ctest 339/339 · RTSan 340/340 · ui typecheck 5 = baseline · vite clean · format clean · ASCII grep
silent.** Page side: `limiter` in `FX_REGISTRY`, the GR readout and the native GR mirror extended to it, Help.

## Phase 4 — 4.6f DONE (THE FIFTH PREMIUM DEVICE: SATURATOR — FIVE FLAVOURS), 2026-08-24

`SaturatorFx` in `AnalogFx.{h,cpp}`, `FxType::saturator` appended. The Decapitator shape from B4: **A** tube
(asymmetric, even harmonics first) · **E** germanium (harder knee) · **N** British console (gentle odd) · **T**
transformer (the bottom saturates first) · **P** punish (fold-back fuzz). Every curve is bounded by construction
and the whole stage is 4× oversampled through the same zero-latency ZOH/Butterworth pair as the rest, with the DC
blocker in from the start (the 4.6c lesson, applied rather than re-learned).

**The design point: LOWCUT / HIGHCUT / TONE sit BEFORE the curve** — they choose what gets distorted instead of
tidying up after it. Gated: the 3rd harmonic of a 60 Hz tone drops 20 dB when LOWCUT moves to 500 Hz, and with two
tones in (100 Hz + 3 kHz) TONE decides which one breaks up.

**Three issues, all found by the gates:**
1. **The auto-gain was a guess and it was 12 dB out.** `driveGain^−0.7` cannot compensate five different curves —
   each one compresses differently. It now **asks the curve itself**: run a reference level through it and undo
   exactly that (`comp = ref / |curve(ref · drive)|`), recomputed per block. Spread across the whole DRIVE range is
   now under 8 dB and the gate says so.
2. **"PUNISH is dirtier" measured FALSE at DRIVE 100** — and correctly: at full drive the curve is already a square
   and six times more of a square is still a square. The gate moved to a moderate drive, where the control actually
   does something. (A gate that only passes at one extreme is testing the extreme, not the feature.)
3. **The TONE gate measured BACKWARDS at high drive** (+100 read 4 dB *quieter* than −100): pushing more into a
   saturating stage compresses more, and the two effects cancel in the meter. TONE is now measured CLEAN at DRIVE 0
   for the tilt itself, plus the two-tone test above for what it does to the distortion — which is the real claim.
   Also: the "LOWCUT means it never reaches the curve" assertion was too strong — a 12 dB/oct filter takes ~37 dB
   off at three octaves and DRIVE 100 then multiplies what is left by 24. The gate compares against wide-open now.

**Gates (4.6f):** 6 more cases — DRIVE 0 bit-clean on all five styles (1e-12) · the styles really are different
flavours (even/odd balance: A and T lean even, N and E odd) and all five distort · no style leaves DC · auto-gain +
PUNISH · the pre-curve filters · bounded at 3 rates × 5 styles with PUNISH on, reset, block-invariance to 1e-9.
**mac-debug ctest 333/333 · RTSan 334/334 · ui typecheck 5 = baseline · vite build clean · format clean · ASCII
grep silent.**

Page side in the same commit: `saturator` in `FX_REGISTRY` as **SATURATOR** (pass-through stub) + Help.

### Noted for the EQ and the channel strip: the param budget is 12
`kMaxFxParams = 12` (Effect.h) and the snapshot mirrors `float params[kMaxFxParams]` per slot per strip
(Mixer.h ~288). A Pro-Q-4-style EQ (bands × 4 params) and an SSL-4000-G channel strip (filters + 4-band EQ +
dynamics ≈ 20) do not fit, and raising the constant multiplies the snapshot array — which runs into the standing
`sizeof(Engine) ≤ 384 KB` rule. **Those two devices need a param-model step first** (either a raised cap with the
snapshot mirror sized separately, or a dedicated command carrying the band table). Do not start either without
deciding that.

## Phase 4 — 4.6e DONE (THE FOURTH PREMIUM DEVICE: HALL 224 — A REAL ALGORITHMIC REVERB), 2026-08-24

`PlateVerbFx` in `AnalogFx.{h,cpp}`, `FxType::plateverb` appended. The parity REVERB (a seeded IR through the
partitioned convolver) is untouched — this is a different animal: a **Dattorro tank**, input diffusion into two
cross-coupled half-loops, each a modulated allpass → delay → damping → allpass → delay, with seven output taps a
side drawn from BOTH halves.

**The design decision worth the whole device: DECAY IS IN SECONDS.** The loop gain is solved from the tank's own
round-trip time — `g = 10^(−3·T/RT60)` — so the knob is a measurement, not a feel. Gated at 1 s, 3 s and 6 s
against a real RT60 read off the decay slope (±35 %). Everything else follows from that:
- **BASS is the 224's decay MULTIPLIER, not an EQ.** It is a low shelf INSIDE the loop whose gain is derived from
  the same RT60 maths, so at 4 the bottom *rings longer*, at 0.25 it clears out of the way of a kick. The gate is
  the one that tells the two apart: the low-band share of the tail must GROW from early to late, more so at 4 than
  at 0.25 — an EQ would shift both windows equally and fail.
- **DAMP** is treble decay (a damping LP in each half), gated as the tail being duller late, not quieter.
- **MOD** — the 224's moving tails. Gated both ways: MOD 100 decorrelates from MOD 0 (< 0.9), and **MOD 0 is
  deterministic to 1e-12** across two instances.
- **A mono source comes back as a room:** feeding both channels the same impulse, L and R correlate < 0.5. That is
  the line between a reverb and a mono delay played out of two speakers.
- PROGRAM (HALL / CHAMBER / PLATE / ROOM / AMBIENCE) sets size, diffusion, damping and how much the tail moves;
  SIZE scales the whole tank so the room changes size rather than just its time.

**Gates (4.6e):** 8 more cases — DECAY in seconds at three lengths · stereo decorrelation · PREDELAY lands within
10 ms of where it says · BASS as a multiplier · DAMP · DIFFUSION (crest factor over the first 60 ms) · MOD (moving
AND deterministic at 0) · finite at 3 rates × 5 programs with everything maxed, and reset clearing the tank to
below 1e-9. **mac-debug ctest 327/327 · RTSan 328/328 · ui typecheck 5 = baseline · vite build clean ·
clang-format clean · ASCII grep silent.** Nothing went wrong in this one — the first device to gate green first try.

Page side in the same commit: `plateverb` in `FX_REGISTRY` as **HALL 224** (pass-through stub) + the Help entry.

## Phase 4 — 4.6d DONE (THE THIRD PREMIUM DEVICE: TAPE ECHO, THE RE-201), 2026-08-24

`TapeEchoFx` in `AnalogFx.{h,cpp}`, `FxType::tapeecho` appended. The parity DELAY is untouched.

**What makes it a tape echo and not a delay with a filter on it:**
- **One tape, three heads.** MODE (H1 / H2 / H3 / H1+2 / H2+3 / H1+3 / H1+2+3) picks which of three FIXED head
  spacings (×1.0, ×1.6, ×2.2 of the base time) are reading the same loop — which is where the uneven, rolling
  patterns come from. Gated: MODE H1 → one echo at 200 ms; H1+2+3 → three, at 200 / 320 / 440 ms; H2+3 → the
  pattern starts late, at 320 ms.
- **TIME is the MOTOR, so it glides (τ 250 ms)** — moving it bends the pitch of whatever is already on the tape
  instead of jump-cutting. Gated: the target moves at once, but a block later the echo still reads near the OLD
  time.
- **The losses are INSIDE the feedback loop** (LP 4.5 k → HP 120 → a +3 dB head bump at 95 Hz → tape saturation),
  so repeat 4 is measurably duller than repeat 1. That is the gate, and it is the thing an output filter cannot do.
- **INTENSITY runs away on purpose** (100 → a loop gain of 1.05) and the tape saturation is what keeps
  self-oscillation bounded: gated as still ringing 6 s later AND never exceeding ±4.
- **WOW** is the worn transport — 0.7 Hz wow + 7.3 Hz flutter off one knob, the two channels a quarter-turn apart
  so the drift is stereo. **SPRING** is the tank (four uneven allpasses into a damped feedback delay).

**The issue this one turned up:** the "WOW 0 is dead steady" gate measured **2.1 samples of drift, not 0**. Not a
bug — with the filters inside the loop, every pass is filtered AGAIN, so the peak of the pulse walks a sample or
two later as it dulls. That is the loop's accumulated group delay. The gate now says what is actually true
(< 3 samples at WOW 0, and WOW 100 at least double it) with the reason written next to it, instead of asserting a
zero that a real feedback loop can never hit.

**Gates (4.6d):** 8 more cases — head positions per MODE · INTENSITY (a decaying train, each repeat quieter, and a
bounded runaway) · every pass darker · WOW moves it and 0 does not · SAT thickens (3rd harmonic +6 dB) and the tone
shelves work · TIME glides · SPRING fills the gaps between repeats (4× the RMS) · finite at 3 rates × 7 modes on a
square, reset clears to silence, block-size invariant to 1e-9 (16384 vs 41).
**mac-debug ctest 319/319 · RTSan 320/320 · ui typecheck 5 = baseline · vite build clean · clang-format clean ·
the ASCII grep prints nothing.**

Page side in the same commit: `tapeecho` in `FX_REGISTRY` as **TAPE ECHO** (pass-through stub) + the full Help entry.

## CI RED on `25cf0cc`, and it was the ASCII rule again (fixed 2026-08-24)

**Windows x64 (MSVC) failed one test: `engine.4× oversampling buys real aliasing rejection`** — and not on the
measurement. The log says it all: `No test cases matched '"4? oversampling buys real aliasing rejection"'`. ctest
passes the case NAME to the binary as a filter, and MSVC's console cannot round-trip the `×`, so the filter matched
nothing, no tests ran, and "no tests ran" is a failure. Mac/RTSan/Intel were all green because their filter survives
the character.

**This is the gotcha already at the top of the list — "every Catch2 TEST_CASE/SECTION name ASCII (MSVC)" — and it
still got through**, because a `×` reads as harmless when you are typing "4× oversampling" in a sentence. The fix is
the rename (`4x`), with the reason on the line so the next person does not re-introduce it. A grep is the only real
guard: `grep -nP "TEST_CASE|SECTION\(" tests/engine/*.cpp | grep -P "[^\x00-\x7F]"` must print nothing.

## Phase 4 — 4.6c DONE (THE SECOND PREMIUM DEVICE: FET COMP), 2026-08-24

The Distressor-shaped compressor from B4's brief, `FetCompFx` beside the ladder in `AnalogFx.{h,cpp}` (which is why
it re-uses `ButterLp4` and the zero-latency ZOH-up / Butterworth-down pair rather than growing a second oversampler).
`FxType::fetcomp` is appended; the parity COMP is untouched.

**The design decision that defines it: there is NO THRESHOLD knob.** The threshold is fixed at −18 dBFS (−24 for
NUKE) and you drive INTO it with INPUT, then bring the level back with OUTPUT — the hardware's workflow, and the
thing that makes INPUT read as *how hard it works AND how much colour*. The **RATIO switch is the character, not a
slope**: the knee tightens as it climbs (14 dB at 2:1 → 1.5 dB at 20:1) and **NUKE** drops the threshold, squares
the knee off and drags the release out. **DETECT** (FLAT / HP1 / HP2 / BAND) filters the side chain so a kick stops
ducking the whole track. **MODE**: CLEAN / DIST 2 (even) / DIST 3 (odd) / BRITISH (faster attack, harder, dirtier).
Stereo-LINKED detection (the louder side sets the gain, so the image never wanders) and **program-dependent
release** (the deeper it holds, the slower it lets go). `gainReductionDb()` publishes GR, so the panel shows it.

**Four bugs the gates caught, every one of them the kind that ships silently:**
1. **A bare polynomial is not a saturator.** `x + a(x² − x⁴/2)` reaches −6765 at x = 15.8, and the +24 dB INPUT
   stress case measured **2985 out of the device**. Every shaper now runs on a `ftanh`-bounded input — which is also
   the honest model: a FET box's output stage does not stay linear when you slam it.
2. **DIST 2 left DC behind.** The first version subtracted a fixed constant to "centre" the even shaper, which meant
   **silence came out at −0.125** and any other level was wrong by a different amount. Now a 5 Hz DC blocker (the
   console stage's corner) does the job a coupling capacitor does. New gate: every mode, on silence AND on a sine,
   `|mean| < 1e-5 / 2e-3`.
3. **The detector must RECTIFY, not follow.** Reading `|x|` sample by sample let go at every zero crossing, so the
   measured attack was ~30 % fast (0.455 of the final GR after one time constant instead of 0.63) and the gain
   modulated at the signal's own frequency — which is distortion. There is a peak envelope with instant attack and
   a 20 ms decay in front of the gain computer now.
4. **CLEAN has to bypass the oversampler.** With a linear shaper the 4× path only added the decimator's group delay,
   so "1:1 · CLEAN · INPUT 0 · OUTPUT 0" was NEARLY transparent. It is now **bit-exact to 1e-9** — a compressor has
   to be able to do nothing.

**Gates (4.6c):** 8 more cases in `test_analog_fx.cpp` — the ratio switch really is 4:1 / 10:1 / 20:1 (measured
against the fixed threshold) and quiet passes at unity · 1:1 CLEAN bit-exact + zero latency · attack lands on 63 %
after one time constant and a fast attack catches more of a transient than a slow one · DETECT: HP2 lets a 50 Hz
note through ≥ 5 dB louder, BAND leans on 2.5 kHz · the MODE harmonics are the ones claimed (CLEAN < −80 dB, DIST 2
more 2nd than 3rd, DIST 3 the other way, BRITISH the dirtiest) · no mode leaves DC · NUKE ≥ 20 dB of GR and finite
at 3 rates × 8 ratios × 4 modes on a full-scale square · INPUT/OUTPUT are the two ends.
**mac-debug 0 warnings + ctest 311/311 · RTSan 312/312 · ui typecheck 5 = baseline · vite build clean ·
clang-format clean · app probe PROBE OK** (and `prefsWindow: true` again this run — more evidence the earlier red
was the machine).

Page side in the same commit: `fetcomp` in `FX_REGISTRY` as **FET COMP** (a documented pass-through, like the
ladder), the GR readout in the device panel now serves it as well as SC COMP, the native mixer shadow mirrors its
gain reduction from the snapshot, and Help gained the full entry (including *why* there is no threshold knob).

## Phase 4 — 4.6a DONE (THE FIRST PREMIUM DEVICE: THE ANALOG FILTER — A REAL MOOG LADDER), 2026-08-24 thirteenth session

The parity floor is finished, so this is the first device from B4's **VICTOR'S PHASE-4 BRIEF** — the stock devices
built on top of the ports, not instead of them. Nothing about the 4.2 devices changes: `FxType::ladder` is
APPENDED to the type enum so every existing type keeps its index and every saved chain still resolves.

**What it is.** `engine/…/fx/AnalogFx.{h,cpp}` — the Moog transistor ladder (D'Angelo–Välimäki nonlinear model)
as a mixer insert: MODE (LP24 / LP18 / LP12 / LP6 / HP24 / HP12 / BP24 / BP12) · CUTOFF 20–20000 · RESO 0–100 ·
DRIVE 0–100 · WET. Four nonlinear one-pole stages with the resonant feedback path, run **4× oversampled** (ZOH up,
a 4-pole Butterworth decimator at 0.47·sr) and mixed from the stage taps Oberheim-style — one filter core gives
every slope and the highpass / bandpass shapes without a second filter.

**Three things the model taught, each now a gate:**
- **DRIVE cannot live inside the ladder.** The tanh appears on BOTH sides of every pole, so in steady state the
  stages track their input exactly and a bare input gain adds *no colour at all* below the cutoff (measured: the
  3rd harmonic did not move). The drive is a compensated tanh input stage in FRONT of the ladder (1..16×, √g
  makeup), crossfaded in by the knob so **DRIVE 0 is bit-clean** and DRIVE 100 is +20 dB of 3rd harmonic at the
  same level. Gated both ways.
- **RESO 100 must sing from silence.** A digital ladder from a zeroed state stays at exactly zero forever. The
  model carries its own ≈ −120 dBFS noise floor, which is what bootstraps the self-oscillation — gated: no input
  at all, RESO 100 → a bounded sine within 15 % of the cutoff, and RMS < 1e-4 when RESO is down.
- **Wide open is not bypass, and the gate says the honest number.** Four poles at 20 kHz still cost ≈ 3.9 dB at
  8 kHz. Resonance also steals the bottom (the feedback path divides DC by 1 + res) — both are what the hardware
  does, both are now numbers that cannot drift.
- (Method) **A cascade of one-poles only reaches its asymptotic slope well past the corner.** Measured between
  2·fc and 4·fc a PERFECT 4-pole reads −21 dB, not −24 — arithmetic, not a fault. The slope gate measures
  8·fc → 16·fc.

**Zero latency by design** (`latencySamples() == 0`): the decimator is minimum-phase IIR rather than a linear-phase
halfband, so putting an ANALOG FILTER on a live pad does not push the whole strip back through PDC.

**Gates (4.6a):** `tests/engine/test_analog_fx.cpp`, 10 cases — registry ids/ranges/WET index + pool build + zero
latency · the four LP slopes and the HP/BP shapes · the cutoff is where the knob says (−12 dB at fc, flat an octave
below) · RESO rings, robs the bottom, self-oscillates from silence · DRIVE is colour not level · the 4×
oversampling holds the non-harmonic floor below −45 dB on a driven 6 kHz tone · neutral is transparent · finite at
44.1/48/96/192 k through every mode at full RESO+DRIVE with the cutoff sweeping · reset clears · **block-size
invariance to 1e-9 (8192 vs 37)**. mac-debug 0 warnings + ctest **295/295** · RTSan **296/296** · clang-format clean.

## Phase 4 — 4.7a DONE (THE ARRANGEMENT CAN RENDER NATIVELY: ENGINE + BRIDGE), 2026-08-24 thirteenth session

**Victor's call on the 4.6a blocker: make the export native.** This is the engine half.

**The contract.** The Beat Finisher song is a PAGE structure (sections × bars, per-section chop rows / drum rows /
bass, the drum graphs, swing, REPEAT, mute groups) and the page has always flattened it to absolute-time hits for
its own arranger PREVIEW. That flattening stays where it is — one implementation, already the one you hear when you
press play in the arranger. What was missing is the other half: **an engine render that takes those hits.** So:
the page decides WHAT plays and WHEN; the engine decides how it SOUNDS. `ProjectRenderOptions::arrangementEvents`
(+ `arrangementBass`, `arrangementBassPatch`, `arrangementLengthSeconds`) REPLACE the sequence-driven schedule while
every bit of the sound — the pads and their regions, the drum lanes' samples and mute groups, the bass patch, the
mixer, the console, PDC, the limiter, the dither — still comes from the project.

**What had to be added to say what a live lane already does:**
- `RenderEvent` grew `hasPan` / `pan` (a drum lane's per-step PAN), `subHit` (a note-repeat sub-hit: **chokes
  nothing** — live it bypasses the lane registry and the sequencer books its end), and `reverse` −1/0/1 (the chop
  sequencer's per-cell REVERSE; live the shadow flips the pad param right before the trigger, and the offline
  renderer now does exactly that — commands are drained in order, so the voice reads the flipped setting).
- Two new event types: **`stopAt`** (a chop cut where the next one starts — `off` is a note-off and a ONE-SHOT
  IGNORES IT, so cutting needs the pad's choke fade) and **`chokeSubHits`** (the roll's self-choke).
- `Engine::bookTrigger` became kind-aware (`BookKind` trigger / release / chokeSubHits / stop) with one `fireBooked`
  shared by the in-block path and the pending ring, so a sample-exact booking can now be any of the four.
- `RenderDrumsSpec::eventDriven`: bind the lanes (samples, volumes, mute groups, 4 ms choke, strips) and **do not
  start the sequencer**. Mute-group choke is still the ENGINE's — the pads keep their groups, so a bounce chokes in
  the same order playback does, and the page never sends `groupCutAt`.
- `RenderBassSpec::timeline`: the song's bass is the same **`BassTimeline`** the live arranger preview already sends
  (absolute events, 4096 cap). **A `BassPattern` tops out at 8 bars / 512 notes — a song cannot BE a pattern**, which
  is why this had to be the timeline and not a longer pattern.
- The bridge (`terminatorExport`) parses `arrangement: {lengthSec, hits[{pad,t,vel,pan?,sub?,rev?,stop?}],
  bass[{kind,t,note,vel,value}], bassPatch?}`. `stop` is absolute: a chop's cut, or a sub-hit's self-choke.

**Caught while wiring it:** in arrangement mode the drum and bass legs were still stretching `lengthSeconds` to
`patternDur × loops` — the PROJECT's pattern length, which says nothing about the song. It would have padded (or,
with a long pattern, silently overrun) every arranged export. Both are now guarded.

**Gates (4.7a):** `tests/engine/test_export_arrangement.cpp`, 8 cases — a hit lands on its sample at block sizes
32/128/512/1024 · a hit's own PAN (hard left / hard right, and a pan-less hit untouched) · sub-hits stack instead of
choking and their choke event ends only them · a chop cut where the next starts (with the negative control: uncut it
rings on) · a per-hit REVERSE flips only that hit (read off a ramp) · drum lanes bound with the sequencer off, then
the engine's own mute-group choke · the bass timeline plays where no pattern could · arrangement mode REPLACES the
sequence schedule, keeps the project's sound, and takes the SONG's length. mac-debug 0 warnings + ctest **303/303**
· clang-format clean.

**NEXT (4.7b): the page side.** `exportNative.ts` takes the arrangement payload; a builder turns the live
`Arrangement` + engine/drumEngine into it with the EXISTING exported helpers (`buildDrumTrackHits`, `drumGraphsOf`,
and `buildChopEvents` once exported); the EXPORT dialog's master/stems targets route to `exportProjectNative` when
running in the shell. MPC Project / Drum Rack stay on the page exporters (no .mpcsample/.adg writer natively). The
key maps (`main` / `sources` / `drumLanes`) come from the live shadow's own SampleStore keys — every buffer the
export needs is already uploaded because it is what is playing.

## Phase 4 — 4.7b DONE (THE EXPORT IS NATIVE: THE MASTER AND THE TRACKOUTS COME OUT OF THE ENGINE), 2026-08-24

The page half. **In the shell, Master Mixdown and Trackouts are now rendered by the C++ engine and written by the
shell** — the same voices, strips, inserts, CONSOLE, PDC and master limiter that are playing. The 4.6a blocker is
closed: a native-only device is in the file.

**The split that made it small.** The page keeps what only it knows and loses what it should never have owned:
- `native/arrangementNative.ts` builds the payload out of the EXISTING flatteners — `buildChopEvents`,
  `buildDrumTrackHits`, `drumGraphsOf`, `buildBassNotes` / `buildBassBends` — the very functions the live arranger
  preview and the Web Audio exporter already run. There is ONE reading of a section's bars, swing, per-step
  VELOCITY / SHIFT / PAN / REPEAT and bass line, and it is the one you hear when you press play in the arranger.
  (`buildChopEvents` / the two bass builders had to be exported; nothing was copied.)
- `native/exportArrangementNative.ts` drives it: save dialog → `terminatorExport` → reveal. Progress and CANCEL ride
  the native job (a cancelled render writes nothing), and it FAILS LOUDLY on a silent render (`peak === 0`) instead
  of handing over a file with nothing in it.
- The trackout CHANNEL LIST is still the page's own (`routesForEvents` + `drumPlanFor` + the active sends), deduped
  because several drum lanes share one channel.
- `runExport` intercepts `master-wav` / `wav-stems` when a project is passed and the shell is present; the Beat
  Finisher modal's own export takes the same branch. **MPC Project and Drum Rack stay on the page's exporters** —
  the native renderer has no .mpcsample / .adg writer, and those are files to be parsed, not audio to be mixed.

**Three things worth knowing:**
- **The key maps cost nothing.** Every buffer a bounce reads is ALREADY in the shell's SampleStore, because the live
  shadow uploaded it when the pad or lane was bound — so `nativeSampleKeys` resolves keys (`nativeEngineShadow()` is
  now reachable) and the export sends key maps, never bytes.
- **No transcode step any more.** WAV, FLAC and MP3 all come straight out of the shell at the chosen depth (MP3
  through the bundled `lame`), so `ExportModal`'s render-a-WAV-then-convert path is switched off for these targets
  via a `nativeRendered` prop. The dialog's own MP3 / 24-bit-FLAC transcode still serves the page-rendered targets.
- **A real discrepancy found, and a deliberate choice made:** the native engine applies the DRUM MASTER volume live
  (`DrumSequencer`: lane × step velocity × master) while the page's Web Audio desktop path routes drum tracks
  straight into their mixer channels, bypassing its own drum master gain — so the shipping app's export drops it.
  The native arrangement export FOLDS IT IN, because native playback is the authority and a bounce must match what
  he hears. **Flag for Victor: the Electron app's drum master volume does nothing on desktop.**
- Mute-group cuts are NOT sent: the drum pads carry their groups, so the engine chokes in the same order playback
  does. Chop hits carry no gain either — the pad already has CHOP level × NORM on it, exactly as a live pad press.

Help updated in the same commit ("WHAT ACTUALLY RENDERS IT" + where the file goes).

**Gates (4.7b):** ui gate = typecheck **5 errors, baseline 5, new 0** · library 39/39 · clock · bass-theory · vite
build clean; mac-debug builds 0 warnings; **app probe PROBE OK** (ChopperView renders, no page errors, the native
engine shadow and the export self-test both green).

**NEEDS VICTOR — this is the one to test by ear.** Load a beat with drums, bass and mixer FX, then EXPORT →
Master Mixdown, and Trackouts. What to listen for: it should sound like the app (console + limiter + any device the
page cannot make a sound with), the stems should sum to the master, MP3 and 24-bit FLAC should come out as asked,
and a CANCEL mid-render should leave no file. Compare against an export from the Electron app if you want the
before/after.

## Phase 4 — 4.6b DONE (THE ANALOG FILTER IS ON THE MIXER — the 4.6a blocker is closed), 2026-08-24

Now that the master and the trackouts render in the engine (4.7), a native-only device can be put on a strip
without vanishing from the file. `ladder` is in the page's `FX_REGISTRY` as **ANALOG FILTER** (MODE · CUTOFF ·
RESO · DRIVE · WET) and in the ＋ INSERT FX list right after FILTER, which is what it is the premium version of.

**`ui/src/mixer/fx/LadderFX.ts` is a documented PASS-THROUGH and must stay one.** The device is the engine's; a
Web Audio "version" would be a different filter wearing the same name — the exact drift the native build exists to
end. The page's graph runs for the UI, the engine is what is heard, and the engine renders the export.

**The one place it does not reach: the MPC Project / Drum Rack export**, which bakes the PAGE's mixer chain into
one-shot WAVs (`engine.exportChops`). A native-only device is not in those files. That is a much smaller gap than
the master/stems one — those formats are sampler kits, not the mix — and it is now said out loud in the device's
own tooltip and in Help rather than left to be discovered. Closing it properly means native .mpcsample / .adg
writers (a Phase 8 item).

Help + the device tooltip updated in the same commit (house rule).

**Gates (4.6b):** ui typecheck 5 = baseline · vite build clean · mac-debug builds.
**LOCAL PROBE RED, AND IT IS THE MACHINE:** `prefsWindow: false` with `prefsReady: true` — the documented
window-server symptom. Proven not mine: the SAME probe passed earlier in this session (`build/probe-47b.json`
`prefsWindow: true`), and with **my work stashed and HEAD rebuilt it still failed** (`build/probe-head.json`).
Everything before it in the probe is green (ChopperView renders, no page errors). CI is the arbiter, as it was last
session.

### THE BLOCKER THIS UNCOVERED — a premium device is heard but NOT exported (needs Victor's call)
`exportProjectNative` (the whole of 4.5) is wired to **the probe only**. The shipping EXPORT dialog calls the
PAGE's `exportArrangement` → `renderArrangementDAW`, i.e. the Web Audio mixer, because that is the only thing that
knows the Beat Finisher arrangement (sections × bars, per-section patterns, bass notes/bends). So a device that
exists only natively — which every B4 premium device will be — would be **heard live and silently missing from the
file**. That is worse than not having it.

Two ways out, and it is Victor's call because it decides the shape of the rest of Phase 4:
1. **Make the export native** (recommended): teach `render::ProjectRenderer` the arrangement (flatten sections →
   absolute-time chop/drum/bass events, which is exactly what `exportArrangement` does in TS today) and point the
   dialog at `exportProjectNative`. Then "export == what you hear" is true by construction, the native mixer /
   console / PDC / limiter are in the file, and every premium device is exportable the day it lands.
2. **Twin every premium device in Web Audio** so the page's exporter carries it. That is a second implementation
   of every device to keep in step — the exact drift the bass-parser move (4.5d) was made to prevent — and it is
   absurd for a Lexicon 224 or a Pro-Q 4.

Until that is decided the ANALOG FILTER is **engine-side only**: it is built, pooled and gated, but it is NOT in
the page's `FX_REGISTRY`, so nothing can insert it yet. Adding the page entry is one small commit either way (a
registry entry + the panel renders itself from the ParamSpec list + a Help line) — it is deliberately held so that
no one can put a device on a strip that a bounce would drop.

## CI — the live-record PATH check now retries up to 5 times (2026-08-23), BOTH halves

**Follow-up (2026-08-24):** the retry fixed the CHOP half (`liveRecExact: true`, attempt 1) but universal went red
again on the same overall check — because `liveRecOk` also ANDs in the DRUM half, and that had no retry. Its symptom
is unmistakable once seen: `drumLiveRec.hitPad: 62` — the CHOP pad from the previous test — with a nonsense offset
(6048). The drum hit simply had not reached the snapshot before its 40-tick wait ran out, so it measured the
PREVIOUS hit. Same treatment applied: the drum half now retries up to `LIVE_REC_ATTEMPTS` too, undoing its bad write
between tries so the pattern is left as it was found. Locally unchanged — attempt 1, `hitPad: 64`, offset 0.

**Lesson: when a composite check like `liveRecOk` fails, read every term of the AND before believing the one you
already fixed.** `liveRecExact` was true and green in the log; the failure was two lines further down.



**The failure:** `macOS universal` went red on `liveRecOk` twice in a row (including a clean re-run) — the live hit
landing 5–6 steps off the grid, `liveRecOffsetSamples` 18000 then 15000. Everything else was green, and the same
commit landed **offset 0 on the first attempt, four runs out of four, locally**.

**What it is NOT:** an export regression (the failing check is nowhere near the export path) and not a logic break
(a logic break gives the same number every time; these differed). The probe's own comment already documented the
cause — *"WebKit throttles the page it does not consider visible"*, which makes the hidden probe page's clock
re-anchor run late and books that hit off the grid. It allowed 2 attempts for exactly this; the arm64 runner is now
slow enough that 2 is not always enough.

**The change:** `LIVE_REC_ATTEMPTS = 5` (was a literal 2). **The assertion is untouched — still within 1 sample.**
This is defensible rather than gate-weakening because the probe is a PATH check (does a live hit travel page →
engine → grid at all); the sample-EXACT landing is gated in C++ by `test_engine` / `test_chop_sequencer`, and those
did not move. On a healthy machine nothing changes: it still lands on attempt 1, verified after the change.

**Method note worth keeping.** Chasing this produced two traps:
- The "same check fails every run = real" rule needs the clause **real TO THIS MACHINE**. `prefsWindow` fails every
  local run here — on a CLEAN HEAD with the work stashed too — while CI reports it `true` on the same commit. It is
  this host's window-server state after the machine slept. **Cross-check CI before chasing a local-only failure.**
- An A/B against an older CI run is only sound if that run actually RAN the part in question. The "green" comparison
  run showed `p2midi` through `p8mixer` at one identical timestamp, i.e. those parts were skipped — so it proved
  nothing, and saying my commit caused the failure would have been a guess dressed as a finding.

## BUG G — "I hit export FLAC" and the whole app went blank — **FIXED** (2026-08-23)

Victor pressed EXPORT with FLAC and the Terminator window turned into a blank white page reading
**"Plug-in handled load"**. The app looked dead; only a relaunch brought it back.

**The export itself was fine — DELIVERING the file killed the page.** `lib/download.ts deliverFiles()` ends in the
classic desktop path: make a Blob URL, click an `<a download>`. **A WKWebView has no download manager**, so that
click is a NAVIGATION: the WebView leaves the app and loads the blob, WebKit logs "Plug-in handled load", and the
entire UI is gone. Nothing crashed — the page was simply navigated away from.

The bug was hiding in plain sight: **this file's own header already documents the same failure for the iOS iframe**
("clicking an `<a href="blob:…">` NAVIGATES the iframe to the blob — which blows away (and on big exports crashes)
the embedded app"). The native shell is a third host with the same property, and nobody had taught `deliverFiles`
about it. It would have hit the OLD inline export button too — the dialog just made it easy to reach.

**The fix:** natively the shell owns the filesystem, so bytes never touch an anchor. `deliverFiles` now branches on
the shell FIRST: `saveDialog` → `writeBinary` (chunked base64, the existing helper) → `reveal`. One dialog even for
a multi-file export — the user names the first file and the rest land beside it, which is what a DAW does with
stems. Cancelling the dialog returns `'dismissed'` and writes nothing.

**A consequence worth recording:** the export dialog's MP3 / 24-bit-FLAC step needs the file it just wrote, and it
had been scraping the name out of the human status message. With a real save dialog the file is wherever the user
put it, so `lastNativeSavePaths()` now reports the actual absolute paths and the dialog uses those. **Parsing prose
for a path was always wrong — it would have broken the moment that wording changed.**

**Not covered by a gate:** the probe exercises the NATIVE exporter (`terminatorExport`), not the page's delivery
path, so this fix is verified by build + types and needs Victor's hands. Retest: EXPORT → FLAC → a save dialog should
appear, the file should land where you choose and be revealed in Finder, and the app must still be there.

## THE DEV-SERVER LOOP — page changes with NO rebuild (fixed 2026-08-23, twelfth session)

`TERMINATOR_UI_URL` points the WebView at the Vite dev server instead of the bundled `Resources/ui`, so **every
change to a .tsx/.ts file hot-reloads in the running app** — no `npm run build`, no `cmake --build`. Only C++ changes
need a rebuild. `vite.config.ts` has `root: 'src/renderer'`, so the dev server's paths (`/index.html`,
`/preferences/preferences.html`) are exactly what `WebShell::startUrlFor()` asks for.

```
cd ui && npm run dev            # vite on :5173 (strictPort)
TERMINATOR_UI_URL=http://localhost:5173 \
  open -a build/mac-release-universal/app/Terminator_artefacts/Release/Terminator.app   # or run the binary directly
```

**It was BROKEN until now, and this is the trap:** the shell injected its boot payload as
`window.__TERMINATOR_NATIVE__`, which is ALSO the name of Vite's build-time boolean flag
(`define: { __TERMINATOR_NATIVE__: true }`). In the bundled build esbuild only substitutes the bare identifier and
never creates a global, so the two never met. **The DEV SERVER assigns the define as a real global**, overwriting the
payload with `true` — `nativeBoot()` then returned a boolean, `boot?.dirs.sep` threw at module scope, and ChopperView
never rendered (`chopperView: false`, `rootChildren: 0`). Diagnosed by throwing `typeof boot` from the page itself
through the hot-reload loop: `{"t":"boolean","keys":[],"dirs":"undefined"}`.

Fix: the shell now injects **`window.__TERMINATOR_BOOT__`** (ShellServices.cpp) and `juceBridge.nativeBoot()` reads
that. `isNative()` was never affected — it tests `window.__JUCE__.backend`. BRIDGE-PROTOCOL.md updated.
**Standing rule: never name anything the shell injects the same as a Vite `define` — dev and bundled disagree.**

Verified: with `TERMINATOR_UI_URL` set, `chopperView: true` / `prefsReady: true` / the shadow self-test `ok: true`;
the bundled path is unchanged (PROBE OK on debug and universal).
**Known dev-only wart:** one `unhandledrejection: json@[native code]` still appears under the dev server (a fetch the
resource provider serves in the bundled app). Harmless — everything renders and the engine round trips — but it means
`tools/ci/probe-app.sh` (which requires `errors: []`) still fails in dev mode. Not worth chasing unless it bites.

## BUGS FROM VICTOR'S FIRST NATIVE TEST DRIVE (2026-08-23, eleventh session)

He ran the universal build and found two. Both root-caused with the systematic-debugging loop; evidence below.

### BUG F — "when I open settings I have to hit yes to microphone access 3 times" — **FIXED** (twelfth session)

`PreferencesWindow.tsx` ran TWO web-only device enumerations unconditionally on mount:
`refreshAudioDevices()` → `navigator.mediaDevices.getUserMedia({ audio: true })` (there only to unlock device LABELS)
+ `enumerateDevices()`, re-armed on every `devicechange`; and `refreshMidiDevices()` → `navigator.requestMIDIAccess()`.
Natively **neither result is ever rendered**: the audio tab is `NativeAudioPane` (the C++ `AudioIO` device lists) and
the MIDI tab is `NativeMidiPane` (CoreMIDI through the shell) — the `<select>`s that consume `outputs` / `inputs` /
`midiInputs` / `midiOutputs` are all inside `!isNative()` branches. So the app was asking WKWebView for the microphone
for a list nothing reads, and the WebView does not persist that grant — mount prompted, `getUserMedia` succeeding fired
`devicechange` (labels became available) which re-ran it, and so on: three prompts to open Preferences.

Fix: `if (isNative()) return;` at the top of both callbacks AND in the `devicechange` effect (so the listener is not
even installed). Web / Electron behaviour is untouched — those builds still need the label unlock.

**Needs his pass (not headlessly testable — a TCC prompt is a system dialog):** open Preferences and confirm no
microphone prompt at all. Note the real RECORD SAMPLE / input-recording paths still ask for the mic when he actually
records, which is correct and unchanged.

### BUG A — "adding a chop stops the sample playing" — **FIXED** (`Sampler::setPadSample`)
**The chain:** dropping a chop point moves the SOURCE chop's `end` (`ChopperEngine.sliceAtCurrentPosition`,
`chops.splice`) → `nativeEngineShadow.syncPad` sees `sameRegion` fail (buf/start/**end**) → sends `setPadSample`
to the pad that is CURRENTLY SOUNDING with the same buffer and a new `endFrame` → `Sampler::setPadSample`
unconditionally faded out every voice on that pad ("the previous sample may be freed soon"). The page itself stops
nothing on a main-track slice (every `stopAllPads()` call site is unreachable from one) — **this was native-only;
the Electron app is not affected.**
**Why the fade was wrong:** a Voice SNAPSHOTS its own `sample`, `startFrame`, `endFrame` and stem planes at trigger
(`Sampler.cpp` v->endFrame = p.endFrame; the render loop reads `v.endFrame`). A region-only change frees nothing and
invalidates nothing a playing voice reads. The hazard the comment describes is real ONLY when the BUFFER pointer
changes (the shadow unretains the old rec after a 2 s grace, `RELEASE_GRACE_MS`).
**Fix:** fade the voices AND drop the stem planes only `if (p.sample != sample)`; a region-only update just moves
`startFrame` / `endFrame`. Gate: `[sampler][chop]` — a sounding pad survives a same-buffer re-chop and stays audible,
a different buffer still fades it out.

### BUG C — the buffer-size change left the app SILENT on every later launch — **FIXED** (`3a26960`)
Found while chasing BUG B; it is the most damaging of the three and he almost certainly ran part of his test drive
with it. Change the buffer size once → the app saves an audio setup → on the NEXT launch `MainWindow` applies it
through `AudioIO::apply()` → **`setAudioDeviceSetup()` only RE-configures a manager that already has a device; on a
never-initialised one it opens nothing and returns NO error**:
```
apply(out='MacBook Pro Speakers' rate=44100 buf=128) err='' -> device='(none)' open=-1
```
`audioError` was empty, so MainWindow's `openDefault()` fallback never fired, `Engine::prepare()` was never called,
and the app ran with a working UI and no audio device at all — every launch, until the settings file was deleted.
(It is also why the app probe went green → red mid-session with no code change: the probe reads
`engine_.snapshot().prepared`. A stash-and-rebuild of HEAD failed identically, which is what proved it was not the
device-change work.)
**Fix:** `apply()` initialises a default device first when the manager has none (so a saved setup is HONOURED rather
than ignored), and never reports success while silent — a setup that leaves no open device returns an error the
caller's fallback can act on. Probe green with his real settings (bufferSize 128) in place.

### BUG B — "changed buffer size, audio glitched and did not resume" — **FIXED** (`8fe4694`)
**Measured** (a real release()+prepare() through the engine, the buffer-size path):

| | before | after |
|---|---|---|
| inserts on strip 1 | 2 | **0** |
| master limiter | on | on |
| playhead | 102400 | **0** |
| sequencer | playing | **stopped** |

**The chain:** Preferences → buffer size → `AudioIO::audioDeviceStopped` → `Engine::release()` → then
`audioDeviceAboutToStart` → `Engine::prepare()`. `release()` resets every component; `prepare()` zeroes the transport
counters and re-prepares the sequencers, whose `reset()` is documented "stop, **forget patterns**". `Mixer::prepare`
drops every insert chain — its comment says "the page re-sends its chains", and `FxPool::prepare` rebuilds the pool.
**So the ENGINE is behaving as designed.** The defect is that the page never implemented its half: the only listener
for `terminator.devicesChanged` is `NativeAudioPane.tsx`, which refreshes a device dropdown. Nothing re-mirrors.
**And it is worse than "nothing re-sends":** every shadow keeps a "what I already sent" diff cache
(`nativeEngineShadow.last[] / lastKey[] / lastNoteMap / lastQueued / lastBpmSent / lastMetro / lastArp`,
`nativeDrumShadow.last[] / lastKey[] / lastPattern`, `nativeBassShadow.lastPatch / lastPatternSig`,
`nativeMixerShadow.names / live`). After the engine restarts, those caches are a LIE — they claim state is already
on the engine that the engine has just forgotten — so even a later page edit will not resend the untouched parts.

**Victor's call: playback SHOULD resume smoothly.** So the fix went into the ENGINE rather than a page `resync()`
layer — a device change is made invisible to everything above it, which is both the better design and a much smaller
diff (no page change, and it avoids the retain/unretain trap a cache-clearing resync would have hit).
**What landed:** `release()` has exactly ONE caller (`AudioIO::audioDeviceStopped`), so it never means "tear the
engine down" — only "the device stopped". It now stops pulling audio and leaves the music alone. `prepare()`
distinguishes the FIRST call from a later one: at the SAME sample rate a later call is a device change and keeps
transport, patterns, voices and chains while re-sizing every buffer for the new block; a genuine sample-rate change
still resets (positions and every coefficient are rate-bound). Sampler / ChopSequencer / DrumSequencer /
BassSequencer / BassSynth / Metronome / Arp / MidiClockOut take a `keepState` flag that skips their `reset()`;
`Mixer::saveChains()` snapshots each strip's chain (type, params, bypass, order) BEFORE the FxPool re-prepares —
the pool's re-prepare resets every device's params — and `prepare(…, keepState)` puts them back.
**Gate** `[engine][devicechange]`:

```cpp
TEST_CASE("Engine: a device change (re-prepare) keeps the transport position and the sequencer running", "[engine]")
{
    Engine e;
    e.prepare({48000.0, 512, 2, 0});
    e.commands().push(Command::seqSetBpm(90.0));
    e.commands().push(Command::seqPlay(true));
    std::vector<float> a(512), b(512);
    float* outs[2] = {a.data(), b.data()};
    for (int i = 0; i < 100; ++i) e.process(outs, 2, 512);
    const auto beforePlayhead = e.snapshot().playheadSamples;
    e.release();
    e.prepare({48000.0, 128, 2, 0});
    std::vector<float> c(128), d(128);
    float* outs2[2] = {c.data(), d.data()};
    for (int i = 0; i < 8; ++i) e.process(outs2, 2, 128);
    REQUIRE(e.snapshot().seqPlaying == 1u);
    REQUIRE(e.snapshot().playheadSamples >= beforePlayhead);
}
```

### BUG D — "changed the sample rate 44.1k -> 48k and audio stopped" — **FIXED** (`48492f8`)
Measured: `at 44100: fx=2 playhead=51200 seqPlaying=1` → `at 48000: fx=0 playhead=0 seqPlaying=0`. The BUG-B fix kept
state only when the rate was unchanged, so a rate change still took the old destroy-everything path — and it threw
away the sequencer patterns and the bass patch as well as the chains. All three are POINTERS TO SHELL-OWNED DATA
that `reset()` nulls (`ChopSequencer::pat_/queued_`, `DrumSequencer::pat_`, `BassSequencer::pat_`,
`BassSynth::patch_`), and the page never re-sends them, so PLAY afterwards produced nothing.
**The insight:** almost none of that state is rate-bound. Patterns are steps; chains are types + params in Hz/dB/ms;
the patch is a struct. What IS rate-bound is the CLOCK — positions are in samples, coefficients are rate-derived.
**Fix:** `prepare()` separates `keepClock` (same rate only → transport, voices, playing survive) from `keepData`
(ANY later prepare → the shell-owned pointers survive `reset(keepData)`, and the Mixer restores its chains). After a
rate change the transport stops and rewinds — as every DAW does — but the mix, patterns and patch are intact, so
PLAY works. Verified: `at 48000: fx=2 playhead=0 seqPlaying=0`.
**Still open (his call):** should playback AUTO-RESUME across a rate change? Rescaling every component's
sample-domain state across a rate ratio is real risk for a rare action; stopping is the DAW norm. Ask before building it.

### BUG E — "change any setting, close Preferences, and the pads stop answering the keyboard" — **FIXED** (`bc26187`)
Preferences is a second, always-on-top `DocumentWindow`. BOTH close paths (the title-bar button's
`closeButtonPressed` and the page's `closePreferences` verb) only called `setVisible(false)`. Hiding a window does
not hand keyboard focus back on macOS, and the WebView must be first responder before the page sees ANY keydown —
so the pads went dead until something was clicked (which is what made it look like a chopping bug).
**Fix:** a single `WebShell::closePreferences()` used by both paths — main window `toFront(true)`, browser
`grabKeyboardFocus()`, and a `terminator.focusMain` event the page answers with `window.focus()` (the native view can
be key while the DOCUMENT is not focused; that is the exact symptom, and grabbing native focus alone does not fix it).
**Victor's rule, recorded:** *keys and MIDI must ALWAYS trigger pads unless he is typing (a save-file name, etc.).*
That policy already exists in the page — one `isTextEntry` predicate (input / textarea / contenteditable) guards the
window key handlers — so nothing there needed changing; the focus loss had simply made it unreachable. MIDI is not
focus-dependent at all (CoreMIDI → the engine directly) and a settings change only re-applies clock-send + output
ports (`applyMidiSettings`), so it should never have been affected — **awaiting his confirmation that MIDI actually
died, or whether he was stating the requirement.**
**PARTIAL — his pass 2026-08-23: "i had to click on terminator again to focus. i mean its not a big deal."**
So window-level focus is not the whole story: on macOS `toFront()` / `grabKeyboardFocus()` do nothing if TERMINATOR
IS NOT THE FRONTMOST APPLICATION, and hiding an always-on-top window can hand the front slot to another app
entirely. **Next step (small, untested — do it first when this is picked up): call
`juce::Process::makeForegroundProcess()` in `WebShell::closePreferences()` before `toFront(true)`**, and if that is
still not enough, keep the Preferences window as a child/owned window of the main one so hiding it returns the front
slot automatically instead of dropping it. He has explicitly deprioritised this ("not a big deal") — do not spend a
session on it, but do the one-liner and let him confirm.
**Not headlessly testable** (keyboard focus across two native windows) — always needs his pass.

**Gates for all five fixes:** mac-debug 0 warnings + ctest **233/233** · RTSan 234/234 · universal (0 warnings)
233/233 · ui gate (tsc baseline 5) · app probe green on debug AND universal (`enginePrepared`, `mixerPageOk`,
`mixerLoudnessOk`) with his real settings file in place.

**A second method note:** the app probe is genuinely flaky under CPU load — chasing the rate-change report it failed
on `metroPageOk` once and `drumPageOk` twice, at BOTH rates, then went green on a quiet machine. Different check
failing each run = flakiness, not a bug; the same check failing every run = real. Do not chase a probe failure
without repeating it on an idle machine first.

**Method note worth keeping:** the app probe going red mid-session was NOT the code — stashing the work and
rebuilding HEAD reproduced it exactly, which is what turned the hunt toward the saved audio settings. When a probe
starts failing, bisect against HEAD before reading more code. Also: `kill %1` kills the subshell, not the app — a
stale Terminator holds the single-instance lock and the next launch exits 0 in 0.07 s having written nothing. Use
`pkill -f Terminator_artefacts`.

### Next session (in order) — updated at the end of the TWELFTH session
0. Push (Victor: 4.4) → `gh run list` → the 4 jobs (Windows especially — every new TEST_CASE/SECTION name in
   test_pdc.cpp is ASCII, and `sizeof(Engine)` is untouched: the Mixer is behind a `unique_ptr` and PDC's rings are
   heap vectors inside it).
1. **Phase 4.5 — the export pipeline**: the offline renderer through the SAME Mixer (so exports get the inserts, the
   console stage, the limiter and the 4.4 alignment), stems per strip post-send, the master's limiter look-ahead
   head-trim (264/288 — the one PDC piece 4.4 deliberately left to exports), the legacy chopper chain for the
   single-chop bake, TPDF dither bit-identity. Gate: master impulse == stem impulse sample.
2. The B4 premium devices (TERMINATOR-NATIVE-PLAN.md B4 "VICTOR'S PHASE-4 BRIEF") AFTER the parity floor is complete
   — each needs its page UI (FX_REGISTRY entry + panel) as well as the device.
3. Decide the flagged page quirks (STATUS "4.2b DONE — page quirks"): fix the Electron DELAY merger downmix / PHASER
   quantum feedback / FLANGER cycle clamp to match the native (recommended), and whether COMP keeps Blink's start-up dip.
4. Phase 8 folds the two page MIDI-learn stores into the one native store (import `midi-map.json` + the localStorage map).
5. The popup's spectrum on the bridge (see "4.3 DONE — honest boundary").
6. BUG E's remaining piece is IN (`juce::Process::makeForegroundProcess()` first thing in
   `WebShell::closePreferences()` — on macOS `toFront()`/`grabKeyboardFocus()` are no-ops while the app is not
   frontmost, which is exactly what he hit). Never headlessly testable: **ask him to confirm** that changing a
   setting, closing Preferences and typing now triggers pads with no click on the main window. If it still needs a
   click, the next step is making the Preferences window a child/owned window of the main one.

### Next session (in order) — updated at the end of the eleventh session (superseded — kept for the record)
-1. **BUG B above (the device-change resync)** — it silently eats his FX chains; do it before 4.4.
0. Push (Victor) → `gh run list` → the 4 jobs (Windows: the stack fix + the ASCII names; the universal probe asserts
   `mixerPageOk` incl. the heavy round trip, CONSOLE on/off, the limiter).
1. **Phase 4.4** — PDC: the two-tier integer plan (channel: maxChan − own; bus: maxBus − own, toMaster = maxBus; the
   master's limiter look-ahead head-trim for exports) on the chain latencies already plumbed + exact (55 / 288 / 295,
   the limiter 264/288) — a per-strip `pdcDelay` line before the fader, `mixerSetPdc {on}`, the snapshot's plan; gates:
   SAT-on-kick both channels the same sample, COMP-on-send a single impulse, master impulse == stem impulse sample.
   Then **4.5** the export pipeline (the offline renderer through the same Mixer: stems per strip post-send, master
   head-trim, the legacy chopper chain for the single-chop bake, TPDF dither bit-identity).
2. The B4 premium devices (TERMINATOR-NATIVE-PLAN.md B4 "VICTOR'S PHASE-4 BRIEF") AFTER the parity floor is complete
   — each needs its page UI (FX_REGISTRY entry + panel) as well as the device.
3. Decide the flagged page quirks (STATUS "4.2b DONE — page quirks"): fix the Electron DELAY merger downmix / PHASER
   quantum feedback / FLANGER cycle clamp to match the native (recommended), and whether COMP keeps Blink's start-up dip.
4. Phase 8 folds the two page MIDI-learn stores into the one native store (import `midi-map.json` + the localStorage map).
5. The popup's spectrum on the bridge (see "4.3 DONE — honest boundary").

### Next session (in order) — updated at the end of the tenth session (superseded — kept for the record)
### Next session (in order) — updated at the end of the ninth session (superseded — kept for the record)
0. `gh run list` — CI for the 3.6 + 3.7 commits (4 jobs; the universal probe now also asserts `metroPageOk` +
   `liveRecOk`).
1. **Phase 4** (read TERMINATOR-NATIVE-PLAN.md B4 "VICTOR'S PHASE-4 BRIEF" first) — 4.1 strips / master / sends / the
   free routing graph, 64-bit summing; routes pads / drum lanes / the bass / the CLICK into their strips; MIDI note
   OUT per strip rides the 3.5 pump. Phase 3 is COMPLETE (3.1–3.7).
2. Phase 8 folds the two page MIDI-learn stores into the one native store (import `midi-map.json` + the localStorage map).

## Phase 3 — DESIGN (written at the end of the fourth session, 2026-08-22; the next session starts here)
Read B2/B3 + dossier-sequencing-midi.md first (the dossier's §5 timing table + §8 "easy to break" are the contract).
**Shape: one native Transport, everything an EventSource; the page's sequencers become SHADOWS then move over.**
- **3.1 C++ core (headless, tests first):** `Transport` in the Engine (int64 sample position, bpm 20..300, PPQ 960
  beat position, `play(anchorSample)` / `stop` / `pause` / `resume` / loop range / `seek`; the snapshot carries
  playing/paused/position/bar-beat/bpm/loopStart); an `EventSource` interface `collect(blockStart, blockEnd, out)`
  the audio callback asks every block (no look-ahead, no timers: a frozen UI thread never stalls audio);
  `ChopSequencer` = the first EventSource (pattern: bars, resolution, grid/velGrid, loop, swing — swing applied
  LIVE (= export parity, the documented fix); queued pattern switch at step 0; per-mute-group note length → a
  stop/release at the next same-group hit or the pattern end (the TS 5 ms tail cut); stepDur re-read per step so a
  BPM change applies at the next step; non-loop stop). Commands: `setSequence{idx, bars, resolution, grid, velGrid,
  loop, swing}` (JS→C++ is not quadratic — whole patterns are fine), `seqSelect/seqQueue{idx}`, `seqPlay{now|at}`,
  `seqStop`, `seqPause`, `seqResume`, `setBpm`, `seqLoop{on}`. Gates: port drum-timing/chop-seq-standalone/input-q
  assertions to the sample clock; 10-minute no-drift test; a CPU-starve test (no commands for 2 s → zero dropped
  events); block-size invariance.
- **3.2 The page binding (shadow):** `playSeq` → `seqPlay` natively and the TS `scheduleSeqStepAudio` voices go to the
  silent bus (the native seq is what you hear); the TS keeps its cursor/boundaries for the UI but
  `getSeqCursorStep/Phase` read the native position (a `transportClock` hook on the engine: the snapshot's sample
  position extrapolated with performance.now(), re-anchored at 20 Hz). Live-record landing stays in the page for now
  (its hit time comes from the native MIDI timestamp when the hit is MIDI — 2.5e). **The two-clock problem:** drums +
  bass stay Web Audio on the page's AudioContext clock until 3.3/3.4; clock-rate difference ≈ 0.6–3 ms/min. Bridge:
  the page re-anchors `drumEngine.start(atCtxTime)` / `bassEngine.start` on every native loop start, mapping native
  sample position → ctx time via (snapshot hostTime↔sample) + `ctx.getOutputTimestamp()` (both referenced to
  performance.now) — error < 1 ms per loop, no audible drift. Document it as a known interim.
- **3.3 Drums native:** `DrumSequencer` EventSource (96 steps/bar, graphs velocity/SHIFT/pan/REPEAT, mute-group
  time-ordered choke, swing on 16ths) + drum voices on the Sampler (raise kMaxPads to 128: pads 64..127 = drum
  lanes, or a second bank) with ceilPeak/declick applied at load; routing to strips comes with Phase 4.
- **3.4 Bass synth native** (the Model D-style worklet → C++; PPQ 96 tick map, slides, bends). **3.5 MIDI clock
  in/out from the transport (sample-exact), MIDI-learn store unification, note-out.** **3.6 Arp, metronome (through
  the mixer), count-in on the sample grid.** **3.7 Live-record landing on the native clock; the one-owner rule in C++.**
- Until drums/bass are native, 3.2's "what you hear" is: live pads + chop seq native (dry, outs 1/2), drums/bass
  through the WebView's AudioContext (the system default output). Victor's pass after 3.2: a chop pattern at 90 BPM
  for 10 minutes against a metronome/DAW click — no drift; pattern switch at the loop boundary; pause/resume.

## Phases 3–9 — NOT STARTED (Phase 3 has a design above)
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
