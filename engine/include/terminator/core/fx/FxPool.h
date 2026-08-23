#pragma once
// The effect pool (Phase 4.2): every device instance the mixer can ever hold is constructed and prepared up front
// (non-RT); the audio thread only takes and returns pointers (mixerAddFx / mixerRemoveFx). Per-type capacities
// bound the memory (the heavy devices — delay lines, convolution — get small caps when they land).
#include <cstdint>
#include <memory>
#include <vector>

#include "terminator/core/fx/Effect.h"

namespace terminator
{

class FxPool
{
  public:
    FxPool() = default;
    FxPool(const FxPool&) = delete;
    FxPool& operator=(const FxPool&) = delete;

    /// Non-RT: construct + prepare every instance for this rate / block (idempotent on re-prepare).
    void prepare(double sampleRate, int maxBlockSize);
    /// Non-RT: drop everything.
    void release() noexcept;

    /// RT: a free, reset instance of `type` (nullptr = none left / unknown type). A type that is not ported yet comes
    /// back as a PASS-THROUGH placeholder reporting that type (so a page chain with a not-yet-ported device keeps its
    /// slot indices aligned natively; it just does nothing until its port lands).
    Effect* acquire(FxType type) noexcept TERMINATOR_NONBLOCKING;
    /// True when `type` has a real implementation (false = placeholders only).
    static bool isPorted(FxType type) noexcept;
    /// RT: give it back.
    void release(Effect* fx) noexcept TERMINATOR_NONBLOCKING;

    int capacity(FxType type) const noexcept;
    int inUse(FxType type) const noexcept;

  private:
    struct Slot
    {
        std::unique_ptr<Effect> fx;
        bool used = false;
    };
    std::vector<Slot> slots_[static_cast<int>(FxType::count)];
    std::vector<Slot> pass_; // the placeholders for unported types
    bool prepared_ = false;
};

} // namespace terminator
