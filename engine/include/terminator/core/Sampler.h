#pragma once
// The pad sampler: fixed pools of pads and voices, rendered sample-accurately inside the audio block.
// Everything here is RT: no allocation after construction, no locks. Parameters arrive through Commands
// (Engine::apply), sample memory through SampleBuffer pointers owned elsewhere.
#include <cstdint>

#include "terminator/core/Command.h"
#include "terminator/core/RtAssert.h"
#include "terminator/core/SampleBuffer.h"
#include "terminator/core/StateSnapshot.h"

namespace terminator
{

struct Pad
{
    const SampleBuffer* sample = nullptr;
    std::int64_t startFrame = 0;
    std::int64_t endFrame = 0; // exclusive
    PadParams params{};
    // Rendered crossfade LOOP (message thread renders it via loop::renderCrossfadeLoop and hands it over like a
    // sample): when set and mode==loop, a hit plays THIS buffer from frame 0 (the warm-up), then loops the
    // steady period [loopStartFrame, loopEndFrame). Null = a raw hard-wrap of the region (Phase 1 behaviour).
    const SampleBuffer* loopSample = nullptr;
    std::int64_t loopStartFrame = 0;
    std::int64_t loopEndFrame = 0;

    bool hasSample() const noexcept { return sample != nullptr && endFrame > startFrame; }
    std::int64_t lengthFrames() const noexcept { return endFrame - startFrame; }
};

struct Voice
{
    enum class Stage : std::uint8_t
    {
        idle = 0,
        attack,
        sustain,
        release, // ramping to zero over releaseSamples (gate note-off / one-shot tail)
        fading,  // 3 ms stop/choke ramp
    };

    Stage stage = Stage::idle;
    std::uint16_t pad = 0;
    std::uint32_t serial = 0; // monotonically increasing, for "newest voice of pad"
    const SampleBuffer* sample = nullptr;
    std::int64_t startFrame = 0; // region, in sample frames
    std::int64_t endFrame = 0;
    double position = 0.0; // fractional frame position inside the sample
    double rate = 1.0;     // frames per output sample (varispeed × sr ratio)
    float velocity = 1.0f;
    float gain = 1.0f;               // pad gain × velocity
    float env = 0.0f;                // current envelope level
    float envStep = 0.0f;            // per-sample increment in attack/release/fading
    std::int32_t envRemaining = 0;   // samples left in the current ramp
    std::int32_t releaseSamples = 1; // length of the release ramp when it starts
    std::int32_t startOffset = 0;    // samples into the current block before the voice starts (this block only)
    std::int32_t releaseOffset = -1; // ≥0: release begins at this sample of the current block
    std::int32_t fadeOffset = -1;    // ≥0: the 3 ms stop/choke fade begins at this sample of the current block
    std::uint8_t outputPair = 0;
    std::uint8_t reverse = 0;
    PadMode mode = PadMode::oneShot;
    Interpolation interpolation = Interpolation::hermite;
    std::int16_t chokeGroup = -1;
    bool released = false;     // gate note-off received
    bool tailStarted = false;  // one-shot reached the region end → release tail running
    bool loopRendered = false; // playing a rendered crossfade-loop buffer (wrap loopLo→loopHi, not the region)
    std::int64_t loopLo = 0;   // steady period bracket in the loop buffer's frames
    std::int64_t loopHi = 0;

    bool active() const noexcept { return stage != Stage::idle; }
};

class Sampler
{
  public:
    static constexpr float kStopFadeSec = 0.003f;   // choke / stop ramp
    static constexpr float kMinReleaseSec = 0.005f; // gate release floor (dossier: max(5 ms, release))

    Sampler() = default;

    void prepare(double sampleRate, int maxBlockSize, int numOutputChannels) noexcept;
    void reset() noexcept; // stop every voice instantly (non-RT use only: prepare/release)

    // --- commands (called from Engine::apply on the audio thread) ---
    void setPadSample(std::uint16_t pad, const SampleBuffer* sample, std::int64_t startFrame,
                      std::int64_t endFrame) noexcept TERMINATOR_NONBLOCKING;
    /// Attach (or clear with sample==nullptr) a pre-rendered crossfade-loop buffer for a pad; loopStart/loopEnd
    /// bracket the steady period in that buffer's frames. A ringing loop voice keeps its old render until re-hit.
    void setPadLoopBuffer(std::uint16_t pad, const SampleBuffer* sample, std::int64_t loopStart,
                          std::int64_t loopEnd) noexcept TERMINATOR_NONBLOCKING;
    void setPadParams(const PadParams& p) noexcept TERMINATOR_NONBLOCKING;
    void trigger(std::uint16_t pad, float velocity, std::int32_t offsetInBlock) noexcept TERMINATOR_NONBLOCKING;
    void release(std::uint16_t pad, std::int32_t offsetInBlock = 0) noexcept TERMINATOR_NONBLOCKING;
    void stopPad(std::uint16_t pad) noexcept TERMINATOR_NONBLOCKING; // 3 ms fade
    void stopAll() noexcept TERMINATOR_NONBLOCKING;                  // 3 ms fade on everything (panic)

    /// Adds every active voice into outputs[0..numOutputChannels). Outputs must already hold whatever the
    /// caller wants to sum with (the engine clears/fills them first).
    void render(float* const* outputs, int numOutputChannels, int numSamples) noexcept TERMINATOR_NONBLOCKING;

    // --- read-back for the snapshot (audio thread) ---
    std::uint32_t activeVoices() const noexcept { return activeVoices_; }
    std::uint32_t stealCount() const noexcept { return steals_; }
    std::uint64_t padActiveMask() const noexcept TERMINATOR_NONBLOCKING;
    std::int32_t lastTriggeredPad() const noexcept { return lastTriggeredPad_; }
    double lastTriggeredPadPositionSec() const noexcept TERMINATOR_NONBLOCKING; // buffer seconds inside the region
    const Pad& pad(int i) const noexcept { return pads_[i]; }

  private:
    Voice* allocateVoice() noexcept TERMINATOR_NONBLOCKING;
    void beginFade(Voice& v, float seconds, std::int32_t offsetInBlock = 0) noexcept TERMINATOR_NONBLOCKING;
    void beginFadeNow(Voice& v, float seconds) noexcept TERMINATOR_NONBLOCKING;
    void beginRelease(Voice& v) noexcept TERMINATOR_NONBLOCKING;
    void chokeGroupOf(std::uint16_t pad, std::int16_t group, const Voice* keep,
                      std::int32_t offsetInBlock) noexcept TERMINATOR_NONBLOCKING;
    void renderVoice(Voice& v, float* const* outputs, int numOutputChannels,
                     int numSamples) noexcept TERMINATOR_NONBLOCKING;

    double sampleRate_ = 48000.0;
    int numOutputChannels_ = 2;
    Pad pads_[kMaxPads]{};
    Voice voices_[kMaxVoices]{};
    std::uint32_t nextSerial_ = 1;
    std::uint32_t activeVoices_ = 0;
    std::uint32_t steals_ = 0;
    std::int32_t lastTriggeredPad_ = -1;
};

} // namespace terminator
