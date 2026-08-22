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

### Next session (in order)
1. `gh run list` — confirm CI is green for the 2.5a commits (mac-universal probe asserts the shadow; Windows/MSVC
   compiles SampleRegistry + the gate flag). Then Victor's pad pass above (his latency verdict decides how much
   of Phase 3 goes first).
2. 2.5 tail: library/YouTube loads by PATH (`terminatorSamples loadFile` + the pad source keyed by path) so pulls
   never upload PCM; RECORD minimal; the R2 pull → library copy.
3. Ownership moves native: peaks via resource URLs; pad sources by PATH; chop seq on the native transport
   (Phase 3 start); LEDs/playhead from `activePads`/`lastTriggeredPadPositionSec`.
4. **Phase 4 is now specced to Victor's brief** (TERMINATOR-NATIVE-PLAN.md B4 "VICTOR'S PHASE-4 BRIEF" + decision
   #7): premium JUCE effects + accurate summing + free routing — read it before the mixer sessions.

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
