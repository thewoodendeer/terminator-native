#pragma once
// Engine → UI state. The audio thread publishes a StateSnapshot once per block through a wait-free
// triple buffer; the UI thread reads the latest one on its 60 Hz timer. No locks, no allocation, and
// every slot is only ever touched by one thread at a time (no data race in the C++ sense).
#include <array>
#include <atomic>
#include <cstdint>
#include <type_traits>

#include "terminator/core/HostClock.h"
#include "terminator/core/Platform.h"
#include "terminator/core/RtAssert.h"

namespace terminator
{

inline constexpr int kMaxPads = 64;
inline constexpr int kMaxOutputChannels = 32;
inline constexpr int kMaxInputChannels = 32;
inline constexpr int kMaxVoices = 256;

struct StateSnapshot
{
    double sampleRate = 0.0;
    std::uint32_t blockSize = 0; // max block size given at prepare()
    std::uint32_t numOutputChannels = 0;
    std::uint32_t numInputChannels = 0;
    std::uint32_t prepared = 0; // 1 once prepare() ran, 0 after release()
    std::uint32_t playing = 0;
    std::uint64_t playheadSamples = 0; // advances only while playing
    std::uint64_t blocksProcessed = 0; // advances every process() call
    std::uint64_t samplesProcessed = 0;
    float masterGain = 1.0f; // current (post-ramp) value
    float testToneFrequencyHz = 0.0f;
    std::uint32_t testToneEnabled = 0;
    float peak[2] = {0.0f, 0.0f};              // per-block peak of outputs 0/1 (post master)
    float outputPeak[kMaxOutputChannels] = {}; // per-block peak of every output (post master)
    float inputPeak[kMaxInputChannels] = {};   // per-block peak of every input
    std::uint64_t commandsApplied = 0;
    std::uint64_t commandsDropped = 0; // producer-side drops (queue full) seen at publish time
    ClockPoint clock{};                // host-time ↔ sample mapping for this block

    // sampler
    std::uint32_t activeVoices = 0;
    std::uint32_t voiceStealing = 0; // cumulative count of voices stolen because the pool was full
    std::uint64_t padActiveMask = 0; // bit i = pad i has a sounding voice (first 64 pads)
    std::int32_t lastTriggeredPad = -1;
    double lastTriggeredPadPositionSec = 0.0; // position inside that pad's region (its buffer's seconds)

    // calibration
    std::uint32_t calibrationState =
        0; // 0 idle · 1 running · 2 done (buffer readable) · 3 failed (channel out of range)
    std::uint32_t calibrationId = 0;
};
static_assert(std::is_trivially_copyable_v<StateSnapshot>, "StateSnapshot must be trivially copyable");

/// Wait-free single-writer / single-reader triple buffer.
template <typename T> class SnapshotPublisher
{
    static_assert(std::is_trivially_copyable_v<T>, "SnapshotPublisher<T> needs a trivially copyable T");

  public:
    SnapshotPublisher() = default;
    SnapshotPublisher(const SnapshotPublisher&) = delete;
    SnapshotPublisher& operator=(const SnapshotPublisher&) = delete;

    /// Writer (audio) thread only. RT-safe.
    void publish(const T& value) noexcept TERMINATOR_NONBLOCKING
    {
        slots_[back_] = value;
        // Hand the freshly written slot to the middle and take whatever was there as the new back.
        const auto prev = middle_.exchange(back_ | kDirty, std::memory_order_acq_rel);
        back_ = prev & kIndexMask;
    }

    /// Reader (UI) thread only. Returns the newest published value (stable until the next read()).
    const T& read() noexcept
    {
        if ((middle_.load(std::memory_order_acquire) & kDirty) != 0)
        {
            const auto prev = middle_.exchange(front_, std::memory_order_acq_rel);
            front_ = prev & kIndexMask;
        }
        return slots_[front_];
    }

  private:
    static constexpr std::uint32_t kDirty = 0x4u;
    static constexpr std::uint32_t kIndexMask = 0x3u;

    std::array<T, 3> slots_{};
    std::uint32_t back_ = 0;  // owned by writer
    std::uint32_t front_ = 1; // owned by reader
    alignas(kCacheLine) std::atomic<std::uint32_t> middle_{2};
};

} // namespace terminator
