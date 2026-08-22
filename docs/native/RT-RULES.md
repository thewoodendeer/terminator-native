# RT RULES — the audio thread contract (non-negotiable)

These are the rules for anything that runs inside `Engine::process()` (the audio callback) or on the
offline-render thread that drives the same code. They are enforced three ways: by compiler annotation,
by RTSan at run time, and by the allocation-counter tests that run on every compiler (MSVC included).

## The rules
1. **No allocation.** No `new`/`malloc`, no `std::string`, no `std::vector::push_back` past capacity, no
   `std::function` construction, no `juce::String`, no `juce::var`, no `juce::Array` growth. Everything the
   callback touches is preallocated in `prepare()` (voice pools, event buffers, plugin buffers, scratch).
2. **No locks.** No `std::mutex`, `juce::CriticalSection`, `SpinLock`, no `std::atomic` wait/notify. The only
   cross-thread primitives are `SpscQueue` (UI→engine commands) and `SnapshotPublisher` (engine→UI state),
   both wait-free.
3. **No I/O, no syscalls.** No file reads, no logging (`DBG` included), no `printf`, no `juce::Logger`, no
   timers, no `Thread::sleep`. Disk streaming happens on the loader thread; the callback reads from buffers
   it was handed.
4. **No exceptions, no RTTI-driven dispatch.** `noexcept` everywhere on the RT path; `dynamic_cast` is
   fine only if there is no allocation behind it (prefer virtual calls or enums).
5. **Bounded work.** Loops on the callback are bounded by block size, voice count, or a fixed command
   drain limit (`Engine::drainCommands` drains at most one queue-capacity per block so a flooding producer
   cannot starve the callback).
6. **Ownership is one-directional.** RT state (`Engine::toneRe_`, `masterGainCurrent_`, voices…) is owned by
   the audio thread after `prepare()`. The message thread never touches it directly — only via commands.
7. **`prepare()` / `release()` are not RT.** They may allocate; they run with the device stopped
   (`audioDeviceAboutToStart` / `audioDeviceStopped`). Never call them from the callback.

## The tooling
- **Annotation:** `TERMINATOR_NONBLOCKING` (= `[[clang::nonblocking]]` on an LLVM 20+ clang) on every RT
  function (`Engine::process`, `drainCommands`, `apply`, `SpscQueue::pop`, `SnapshotPublisher::publish`).
  `-Wfunction-effects` warns at compile time about blocking/allocating calls. It is a **warning, not an
  error** (`-Wno-error=function-effects`): libm calls like `std::sin`/`std::cos` trip it and are fine in
  practice; the runtime gate is RTSan. Apple clang 21 does not support the attribute — it compiles to
  nothing there and Homebrew LLVM is the toolchain that checks it.
- **RTSan (runtime):** preset `mac-rtsan` (`-DCMAKE_CXX_COMPILER=/opt/homebrew/opt/llvm/bin/clang++
  -DTERMINATOR_ENABLE_RTSAN=ON`). Any malloc/lock/syscall reached from a `nonblocking` function aborts the
  process. The CI job `mac-rtsan` builds the engine + tools + tests and runs `ctest` under it on every push.
  RTSan is **not combinable with ASan/UBSan** (clang refuses) — `mac-asan-ubsan` is the separate preset.
- **Allocation counter (every platform):** `tests/support/AllocationCounter` replaces global
  `operator new/delete` in the test binary and counts per thread; `tests/engine/test_rt_safety.cpp`
  asserts `allocationsDuring(process) == 0` for the empty callback, tone, command flood and panic. This
  is what gates Windows (no RTSan on MSVC).
- **`TERMINATOR_RT_ASSERT(x)`** — debug-only assertion that traps instead of printing; safe on the callback.

## How to add something to the audio path (checklist)
- [ ] All memory it needs is sized in `prepare()` (or is a fixed-size member).
- [ ] Its per-block function is `noexcept TERMINATOR_NONBLOCKING`.
- [ ] It receives parameters through a `Command` (add a `CommandType` + payload in `Command.h`, the JSON
      form in `BRIDGE-PROTOCOL.md`, and a line in `WebShell::applyJsonCommand`).
- [ ] It reports through `StateSnapshot` (add fields; never pointers).
- [ ] `test_rt_safety.cpp` gets a case covering it; `mac-rtsan` preset is green.
- [ ] If it needs libm or other non-annotated calls, that's fine — the warning is expected; a malloc is not.

## Why this is strict from day one
Every sequencer/timing bug in the Electron app came from the engine not owning time. A DAW that drops out
under load or clicks on a UI action is unusable; retrofitting RT discipline onto an engine that grew
without it is a rewrite. See TERMINATOR-NATIVE-PLAN.md §A3.
