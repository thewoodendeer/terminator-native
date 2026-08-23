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

### Next session (in order) — updated at the end of the tenth session
0. Push (Victor) → `gh run list` → the 4 jobs (the universal probe now also asserts `mixerPageOk` incl. the insert
   round trip; the smoke cap is 150 s).
1. **Phase 4.2b** — the remaining page devices as `Effect`s (the chain, the pool, the bridge and the page mirror are
   DONE in 4.2a — each port = a class in `core/fx/`, a row in the type table with its FX_REGISTRY params, a
   `capacityOf`, a `make`, a `[fx]` gate against dossier-mixer-fx.md §2): delay (damped feedback LP 7.5 k / HP 90, R =
   1.02·TIME, PINGPONG), reverb (the seeded LCG IR + onset ramp + √-frac absorption + partitioned convolution, the 60 ms
   A/B swap), comp (the Blink DynamicsCompressor kernel — its ~6 ms look-ahead = `latencySamples`), sccomp (the sc-comp
   worklet + the sidechain tap from another strip's INPUT), clip / wave / sat / mbsat (4× with real polyphase halfbands,
   `latencySamples` = the oversampler's group delay; MB SAT's LR4 split + AP dry leg), phaser / flanger / vinyl (their
   LFOs + feedback), the console stage per strip (FNV-1a seeds by NAME → `mixerSetStrip` needs the name's seed), the
   legacy chopper master chain; then 4.2c the B4 premium devices. Then 4.3 meters on the bridge (`levels(name)` is
   ready), 4.4 PDC + offline parity (the chain latencies are plumbed), 4.5 exports.
2. Phase 8 folds the two page MIDI-learn stores into the one native store (import `midi-map.json` + the localStorage map).

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
