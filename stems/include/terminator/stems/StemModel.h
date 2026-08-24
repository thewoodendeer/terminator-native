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
// CPU execution provider only (7.1). The GPU providers come in 7.2 behind the SNR self-check — CoreML and the
// Intel-slice WebGPU were measured returning WRONG stems, so no GPU path ships unprobed.
//
// THE RUNTIME IS LOADED BY HAND, never linked. Every prebuilt onnxruntime for macOS is built against 13.3+
// (checked 1.20.1 through 1.23.2), so LINKING it would raise Terminator's own floor from macOS 12 to 13.4 —
// the app would refuse to launch on a Mac that can otherwise run everything else it does. Instead the dylib is
// dlopen'd on the first split (`OrtGetApiBase` is the one symbol we look up, ORT_API_MANUAL_INIT does the
// rest): the app links nothing, keeps its 12.0 floor, and an old Mac gets "stems need macOS 13.4" from a
// failed load instead of a dead launch. It also means a missing or corrupt runtime is an error message, not a
// crash on startup.
#include <functional>
#include <memory>
#include <string>
#include <vector>

namespace terminator::stems
{
class StemModel
{
  public:
    StemModel();
    ~StemModel();
    StemModel(const StemModel&) = delete;
    StemModel& operator=(const StemModel&) = delete;

    /// Create a session per model file (1 = FAST, 4 = FINE specialists, in the row order drums/bass/other/vocals).
    /// `intraOpThreads` 0 = let onnxruntime choose. Returns false and fills `error`.
    bool load(const std::vector<std::string>& modelPaths, std::string& error, int intraOpThreads = 0);
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

  private:
    struct Impl;
    std::unique_ptr<Impl> impl_;
};
} // namespace terminator::stems
