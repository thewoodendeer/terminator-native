#pragma once
// Maps host (monotonic, ns) time ↔ engine sample position. The audio thread publishes one ClockPoint per block
// (entry host time + the sample position at the start of that block + the block's sample rate); any thread
// can then convert a host timestamp (a MIDI message, a UI click) into a sample position.
#include <cstdint>

namespace terminator
{

struct ClockPoint
{
    std::uint64_t hostNs = 0;         // host time at the START of the block (callback entry)
    std::uint64_t samplePosition = 0; // engine samplesProcessed at the start of that block
    std::uint32_t blockSize = 0;
    double sampleRate = 0.0;

    bool valid() const noexcept { return sampleRate > 0.0 && hostNs != 0; }

    /// Sample position corresponding to hostTimeNs (may be before or after the block).
    double sampleAt(std::uint64_t hostTimeNs) const noexcept
    {
        if (!valid())
            return 0.0;
        const double dt = (static_cast<double>(hostTimeNs) - static_cast<double>(hostNs)) * 1e-9;
        return static_cast<double>(samplePosition) + dt * sampleRate;
    }
};

} // namespace terminator
