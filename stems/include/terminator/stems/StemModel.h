#pragma once
// THE MODEL, IN PROCESS (Phase 7.1b) — htdemucs as ONNX, run through the onnxruntime C++ API inside the app.
//
// The Electron build cannot do this: onnxruntime SIGTRAPs inside any Electron process (the V8 memory cage
// forbids ORT's external buffers), so a split there forks a real Node binary, writes the mix to a temp file and
// ships every finished span back over IPC. Native has no cage: the session lives here, the mix is already in
// memory, and a finished span is written straight into the engine's buffers.
//
// FAST = one model, all four rows. FINE = the four htdemucs_ft specialists; specialist k contributes ONLY row k
// (drums model -> drums row), which is what the reference bag does.
//
// Input `mix` (1,2,343980) f32 = 7.8 s at 44.1k; output `stems` (1,4,2,343980) in the order drums, bass, other,
// vocals. Names are read off the session rather than assumed.
//
// EXECUTION PROVIDERS (7.2). CPU is the default and the reference. An accelerator is only ever a candidate: the
// Electron app measured CoreML and the Intel-slice WebGPU returning WRONG stems, so nothing here trusts a
// provider that has not been compared against the CPU's own output on the SAME chunk (`compareEp`). A provider
// the build cannot create is reported, never silently swapped for CPU behind the caller's back — `epUsed()`
// says what actually ran.
//
// THE RUNTIME IS LOADED BY HAND, never linked. Every prebuilt onnxruntime for macOS is built against 13.3+
// (checked 1.20.1 through 1.23.2), so LINKING it would raise Terminator's own floor from macOS 12 to 13.4 —
// the app would refuse to launch on a Mac that can otherwise run everything else it does. Instead the dylib is
// dlopen'd on the first split (`OrtGetApiBase` is the one symbol we look up, ORT_API_MANUAL_INIT does the
// rest): the app links nothing, keeps its 12.0 floor, and an old Mac gets "stems need macOS 13.4" from a
// failed load instead of a dead launch. It also means a missing or corrupt runtime is an error message, not a
// crash on startup.
#include <cstdint>
#include <functional>
#include <memory>
#include <string>
#include <vector>

namespace terminator::stems
{
/// What ran the graph. `cpu` is the reference every candidate is measured against.
enum class Ep
{
    cpu,
    coreml,   // macOS: CoreML, MLComputeUnits ALL — the Neural Engine included
    coremlGpu // macOS: CoreML restricted to CPU+GPU — the ANE is fp16-only, which a model can hate
};
const char* epName(Ep ep) noexcept;

class StemModel
{
  public:
    StemModel();
    ~StemModel();
    StemModel(const StemModel&) = delete;
    StemModel& operator=(const StemModel&) = delete;

    /// Create a session per model file (1 = FAST, 4 = FINE specialists, in the row order drums/bass/other/vocals).
    /// `intraOpThreads` 0 = let onnxruntime choose. `ep` other than `cpu` FAILS (with `error`) when this build of
    /// onnxruntime has no such provider — it never falls back quietly. Returns false and fills `error`.
    bool load(const std::vector<std::string>& modelPaths, std::string& error, int intraOpThreads = 0, Ep ep = Ep::cpu);
    /// The provider the loaded sessions were created with.
    Ep epUsed() const noexcept;
    void unload();

    bool loaded() const noexcept;
    int modelCount() const noexcept;
    /// Load the onnxruntime shared library (idempotent). Called by `load()`; call it directly to find out
    /// whether this machine can split at all. `override` (or TERMINATOR_ORT_LIB) wins over the bundled copy.
    static bool ensureRuntime(std::string& error, const std::string& overridePath = {});
    /// The onnxruntime version, once the runtime is loaded ("" before that).
    static std::string runtimeVersion();
    /// Where the loaded runtime came from.
    static std::string runtimePath();

    /// Run one chunk: `mix` = 2 * kSegment floats (L then R), `rows` = 4 * 2 * kSegment floats (row k = L,R).
    /// `onRow` (optional) is called after each row a FINE run finishes, 0..1 of the chunk — the sub-chunk
    /// progress tick. Returns false and fills `error`.
    bool run(const float* mix, float* rows, std::string& error, const std::function<void(double)>& onRow = {});

    /// THE SELF-CHECK (7.2): run `mix` through this model on the CPU and on `ep`, and report how far apart the
    /// two answers are. Nothing may use an accelerator without it. `snrDb` is the worst of the four rows —
    /// higher is better, and the plan's bar is 60 dB (the CPU-vs-Electron measurement was 116 dB). `cpuMs` /
    /// `epMs` are one chunk each, after a warm-up run on both. Returns false (with `error`) when the provider
    /// cannot be created or a run fails; a provider that returns garbage is a SUCCESSFUL comparison with a bad
    /// number, not an error.
    struct EpCheck
    {
        double snrDb = 0.0;
        double maxDiff = 0.0;
        double cpuMs = 0.0;
        double epMs = 0.0;
        bool finite = false;                // the accelerator's output had no NaN/Inf at all
        std::int64_t nonFinite = 0;         // how many of its samples were NaN/Inf
        std::int64_t samples = 0;           // out of this many
        double cpuPeak = 0.0, epPeak = 0.0; // "it ran and returned silence" is a distinct failure from NaN
    };
    static bool compareEp(const std::vector<std::string>& modelPaths, const float* mix, Ep ep, EpCheck& out,
                          std::string& error, int intraOpThreads = 0);

  private:
    struct Impl;
    std::unique_ptr<Impl> impl_;
};
} // namespace terminator::stems
