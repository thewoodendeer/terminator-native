#include "terminator/io/SampleStore.h"

#include <algorithm>

namespace terminator
{

std::uint32_t SampleStore::add(std::shared_ptr<SampleBuffer> buffer)
{
    const auto id = nextId_++;
    buffer->id = id;
    live_[id] = std::move(buffer);
    return id;
}

const SampleBuffer* SampleStore::get(std::uint32_t id) const
{
    const auto it = live_.find(id);
    return it == live_.end() ? nullptr : it->second.get();
}

std::shared_ptr<SampleBuffer> SampleStore::shared(std::uint32_t id) const
{
    const auto it = live_.find(id);
    return it == live_.end() ? nullptr : it->second;
}

void SampleStore::retire(std::uint32_t id, std::uint64_t engineBlocksNow)
{
    const auto it = live_.find(id);
    if (it == live_.end())
        return;
    retired_.push_back({std::move(it->second), engineBlocksNow});
    live_.erase(it);
}

int SampleStore::collect(const StateSnapshot& s)
{
    int freed = 0;
    const auto now = s.blocksProcessed;
    for (auto it = retired_.begin(); it != retired_.end();)
    {
        const bool engineStopped = s.prepared == 0; // nothing can be reading while the device is closed
        if (engineStopped || now >= it->retiredAtBlock + kQuarantineBlocks)
        {
            it = retired_.erase(it);
            ++freed;
        }
        else
            ++it;
    }
    return freed;
}

std::uint64_t SampleStore::bytesLive() const
{
    std::uint64_t b = 0;
    for (const auto& [id, buf] : live_)
        b += buf->data.size() * sizeof(float);
    return b;
}

} // namespace terminator
