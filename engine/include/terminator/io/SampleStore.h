#pragma once
// Owns every SampleBuffer the engine may be reading. The engine holds raw pointers (sent by command); the
// store keeps the shared_ptr alive. Lifetime rule: retire(id) does NOT free — it queues the buffer with the
// engine's current block count; collect(snapshot) frees retired buffers once the engine has processed
// ≥ kQuarantineBlocks blocks since (every voice that read them has faded out long before — 3 ms fades,
// ≤ 0.5 s release tails). Message thread only.
#include <cstdint>
#include <map>
#include <memory>
#include <vector>

#include "terminator/core/SampleBuffer.h"
#include "terminator/core/StateSnapshot.h"

namespace terminator
{

class SampleStore
{
  public:
    static constexpr std::uint64_t kQuarantineBlocks =
        4096; // ≈ 43 s at 512/48k … ≈ 2.7 s at 32/48k (release tails are ≤ 0.5 s)

    /// Takes ownership; returns the assigned id (never 0).
    std::uint32_t add(std::shared_ptr<SampleBuffer> buffer);
    const SampleBuffer* get(std::uint32_t id) const;
    std::shared_ptr<SampleBuffer> shared(std::uint32_t id) const;
    /// Marks a buffer for release once the engine can no longer be reading it.
    void retire(std::uint32_t id, std::uint64_t engineBlocksNow);
    /// Frees quarantined buffers whose quarantine elapsed. Returns how many were freed.
    int collect(const StateSnapshot& s);
    std::size_t liveCount() const { return live_.size(); }
    std::size_t retiredCount() const { return retired_.size(); }
    std::uint64_t bytesLive() const;

  private:
    std::uint32_t nextId_ = 1;
    std::map<std::uint32_t, std::shared_ptr<SampleBuffer>> live_;
    struct Retired
    {
        std::shared_ptr<SampleBuffer> buffer;
        std::uint64_t retiredAtBlock;
    };
    std::vector<Retired> retired_;
};

} // namespace terminator
