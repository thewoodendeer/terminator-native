#include "SampleRegistry.h"

#include <algorithm>
#include <cmath>
#include <cstring>

#include "terminator/render/ProjectRenderer.h"

namespace terminator::app
{

namespace
{
std::int64_t secToFrame(double sec, double rate) noexcept
{
    return static_cast<std::int64_t>(std::floor(sec * rate + 0.5));
}
int padOf(const juce::var& v)
{
    return v.isObject() ? static_cast<int>(v.getProperty("pad", -1)) : -1;
}
} // namespace

SampleRegistry::SampleRegistry(Engine& engine, SampleStore& store, SampleLoader& loader)
    : engine_(engine), store_(store), loader_(loader)
{
}

juce::var SampleRegistry::ok(bool okFlag, const juce::String& error)
{
    auto* obj = new juce::DynamicObject();
    obj->setProperty("ok", okFlag);
    if (!okFlag)
        obj->setProperty("error", error);
    return juce::var(obj);
}

const SampleBuffer* SampleRegistry::find(const juce::String& key) const
{
    const auto it = ids_.find(key);
    return it == ids_.end() ? nullptr : store_.get(it->second);
}

juce::var SampleRegistry::handle(const juce::var& req)
{
    const auto verb = req.isObject() ? req.getProperty("verb", "list").toString() : juce::String("list");
    if (verb == "begin")
        return begin(req);
    if (verb == "chunk")
        return chunk(req);
    if (verb == "end")
        return end(req);
    if (verb == "loadFile")
        return loadFile(req);
    if (verb == "release")
        return release(req);
    if (verb == "list" || verb == "stats")
        return list();
    return ok(false, "unknown samples verb '" + verb + "'");
}

juce::var SampleRegistry::describe(const juce::String& key, const SampleBuffer& b) const
{
    auto* o = new juce::DynamicObject();
    o->setProperty("ok", true);
    o->setProperty("key", key);
    o->setProperty("frames", static_cast<juce::int64>(b.numFrames));
    o->setProperty("sampleRate", b.sampleRate);
    o->setProperty("channels", b.numChannels);
    o->setProperty("durationSec", b.durationSeconds());
    return juce::var(o);
}

juce::var SampleRegistry::begin(const juce::var& req)
{
    const auto key = req["key"].toString();
    if (key.isEmpty())
        return ok(false, "key required");
    if (ids_.count(key) != 0 || pending_.count(key) != 0)
        return ok(false, "key '" + key + "' already exists (keys are single-use)");
    const auto rate = static_cast<double>(req.getProperty("sampleRate", 0.0));
    const int channels = static_cast<int>(req.getProperty("channels", 0));
    const auto frames = static_cast<std::int64_t>(static_cast<juce::int64>(req.getProperty("frames", 0)));
    if (!(rate > 0.0) || channels < 1 || channels > 32 || frames < 1)
        return ok(false, "begin: need sampleRate > 0, 1..32 channels, frames >= 1");
    if (frames * channels > kMaxFloats)
        return ok(false, "begin: buffer too large");
    Pending p;
    p.buffer = std::make_shared<SampleBuffer>();
    p.buffer->allocate(channels, frames, rate);
    pending_[key] = std::move(p);
    return ok(true);
}

juce::var SampleRegistry::chunk(const juce::var& req)
{
    const auto key = req["key"].toString();
    const auto it = pending_.find(key);
    if (it == pending_.end())
        return ok(false, "chunk: no upload in progress for '" + key + "'");
    auto& p = it->second;
    auto& b = *p.buffer;
    const auto offset = static_cast<std::int64_t>(static_cast<juce::int64>(req.getProperty("offset", 0)));
    const auto data = req["data"].toString();
    juce::MemoryOutputStream raw;
    if (!juce::Base64::convertFromBase64(raw, data))
        return ok(false, "chunk: bad base64");
    const auto bytes = static_cast<std::int64_t>(raw.getDataSize());
    const auto frameBytes = static_cast<std::int64_t>(b.numChannels) * static_cast<std::int64_t>(sizeof(float));
    if (bytes % frameBytes != 0)
        return ok(false, "chunk: byte count is not a whole number of interleaved float32 frames");
    const auto n = bytes / frameBytes;
    if (offset < 0 || offset + n > b.numFrames)
        return ok(false, "chunk: frames out of range");
    // interleaved float32 (the page's Float32Array layout) → the store's planar layout
    const auto* src = static_cast<const float*>(raw.getData());
    for (int ch = 0; ch < b.numChannels; ++ch)
    {
        float* dst = b.channel(ch) + offset;
        for (std::int64_t i = 0; i < n; ++i)
            dst[i] = src[i * b.numChannels + ch];
    }
    p.framesReceived += n;
    ++chunksReceived_;
    bytesReceived_ += static_cast<std::uint64_t>(bytes);
    auto* o = new juce::DynamicObject();
    o->setProperty("ok", true);
    o->setProperty("received", static_cast<juce::int64>(p.framesReceived));
    return juce::var(o);
}

juce::var SampleRegistry::end(const juce::var& req)
{
    const auto key = req["key"].toString();
    const auto it = pending_.find(key);
    if (it == pending_.end())
        return ok(false, "end: no upload in progress for '" + key + "'");
    auto buffer = it->second.buffer;
    const auto received = it->second.framesReceived;
    pending_.erase(it);
    if (received < buffer->numFrames)
        return ok(false,
                  "end: only " + juce::String(received) + " of " + juce::String(buffer->numFrames) + " frames arrived");
    install(key, buffer);
    return describe(key, *buffer);
}

juce::var SampleRegistry::loadFile(const juce::var& req)
{
    const auto key = req["key"].toString();
    if (key.isEmpty())
        return ok(false, "key required");
    if (ids_.count(key) != 0 || pending_.count(key) != 0)
        return ok(false, "key '" + key + "' already exists (keys are single-use)");
    const juce::File f(req["path"].toString());
    juce::String err;
    auto sample = loader_.load(f, err);
    if (sample == nullptr)
        return ok(false, err.isNotEmpty() ? err : "could not decode " + f.getFullPathName());
    install(key, sample);
    return describe(key, *sample);
}

void SampleRegistry::install(const juce::String& key, std::shared_ptr<SampleBuffer> buffer)
{
    ids_[key] = store_.add(std::move(buffer));
}

void SampleRegistry::clearPadLoop(int pad)
{
    if (padLoopIds_[pad] != 0)
    {
        engine_.commands().push(Command::setPadLoopBuffer(static_cast<std::uint16_t>(pad), nullptr, 0, 0));
        store_.retire(padLoopIds_[pad], engine_.snapshot().blocksProcessed);
        padLoopIds_[pad] = 0;
    }
}

void SampleRegistry::unbindKey(const juce::String& key)
{
    for (int pad = 0; pad < kMaxPads; ++pad)
    {
        if (padKeys_[pad] != key)
            continue;
        engine_.commands().push(Command::setPadSample(static_cast<std::uint16_t>(pad), nullptr));
        clearPadLoop(pad);
        padKeys_[pad].clear();
    }
}

juce::var SampleRegistry::release(const juce::var& req)
{
    const auto key = req["key"].toString();
    if (const auto p = pending_.find(key); p != pending_.end())
    {
        pending_.erase(p);
        return ok(true);
    }
    const auto it = ids_.find(key);
    if (it == ids_.end())
        return ok(false, "release: unknown key '" + key + "'");
    unbindKey(key);                                                // the engine drops its pointers first …
    store_.retire(it->second, engine_.snapshot().blocksProcessed); // … then the quarantine frees the memory
    ids_.erase(it);
    return ok(true);
}

juce::var SampleRegistry::list() const
{
    auto* o = new juce::DynamicObject();
    o->setProperty("ok", true);
    juce::Array<juce::var> keys;
    for (const auto& [key, id] : ids_)
        if (const auto* b = store_.get(id))
            keys.add(describe(key, *b));
    o->setProperty("keys", juce::var(keys));
    juce::Array<juce::var> pads;
    for (int pad = 0; pad < kMaxPads; ++pad)
    {
        if (padKeys_[pad].isEmpty())
            continue;
        auto* po = new juce::DynamicObject();
        po->setProperty("pad", pad);
        po->setProperty("key", padKeys_[pad]);
        po->setProperty("loop", padLoopIds_[pad] != 0);
        pads.add(juce::var(po));
    }
    o->setProperty("pads", juce::var(pads));
    o->setProperty("pending", static_cast<int>(pending_.size()));
    o->setProperty("chunks", static_cast<juce::int64>(chunksReceived_));
    o->setProperty("bytes", static_cast<juce::int64>(bytesReceived_));
    o->setProperty("storeLive", static_cast<int>(store_.liveCount()));
    o->setProperty("storeRetired", static_cast<int>(store_.retiredCount()));
    o->setProperty("storeBytes", static_cast<juce::int64>(store_.bytesLive()));
    return juce::var(o);
}

juce::var SampleRegistry::setPadSample(const juce::var& cmd)
{
    const int pad = padOf(cmd);
    if (pad < 0 || pad >= kMaxPads)
        return ok(false, "setPadSample: pad out of range");
    const auto key = cmd.getProperty("key", "").toString();
    if (key.isEmpty())
    {
        if (!engine_.commands().push(Command::setPadSample(static_cast<std::uint16_t>(pad), nullptr)))
            return ok(false, "command queue full");
        clearPadLoop(pad);
        padKeys_[pad].clear();
        return ok(true);
    }
    const auto it = ids_.find(key);
    const SampleBuffer* b = it == ids_.end() ? nullptr : store_.get(it->second);
    if (b == nullptr)
        return ok(false, "setPadSample: unknown key '" + key + "'");
    const auto startSec = static_cast<double>(cmd.getProperty("startSec", 0.0));
    const auto endSec = static_cast<double>(cmd.getProperty("endSec", 0.0));
    const auto start = std::clamp<std::int64_t>(secToFrame(startSec, b->sampleRate), 0, b->numFrames);
    const auto end =
        std::clamp<std::int64_t>(endSec > 0.0 ? secToFrame(endSec, b->sampleRate) : b->numFrames, start, b->numFrames);
    if (!engine_.commands().push(Command::setPadSample(static_cast<std::uint16_t>(pad), b, start, end)))
        return ok(false, "command queue full");
    padKeys_[pad] = key;
    auto* o = new juce::DynamicObject();
    o->setProperty("ok", true);
    o->setProperty("startFrame", static_cast<juce::int64>(start));
    o->setProperty("endFrame", static_cast<juce::int64>(end));
    return juce::var(o);
}

juce::var SampleRegistry::setPadLoop(const juce::var& cmd)
{
    const int pad = padOf(cmd);
    if (pad < 0 || pad >= kMaxPads)
        return ok(false, "setPadLoop: pad out of range");
    const auto key = cmd.getProperty("key", "").toString();
    const bool clear = static_cast<bool>(cmd.getProperty("clear", false)) || key.isEmpty();
    if (clear)
    {
        clearPadLoop(pad);
        return ok(true);
    }
    const auto it = ids_.find(key);
    const SampleBuffer* b = it == ids_.end() ? nullptr : store_.get(it->second);
    if (b == nullptr)
        return ok(false, "setPadLoop: unknown key '" + key + "'");
    const auto startSec = static_cast<double>(cmd.getProperty("startSec", 0.0));
    const auto endSec = static_cast<double>(cmd.getProperty("endSec", 0.0));
    const auto s0 = std::clamp<std::int64_t>(secToFrame(startSec, b->sampleRate), 0, b->numFrames);
    const auto e =
        std::clamp<std::int64_t>(endSec > 0.0 ? secToFrame(endSec, b->sampleRate) : b->numFrames, s0, b->numFrames);
    const auto n = e - s0;
    if (n < 2)
        return ok(false, "setPadLoop: region too short");
    std::int64_t loopStart = 0, loopEnd = 0;
    auto rendered =
        render::renderPadLoop(*b, nullptr, 15, s0, n, static_cast<double>(cmd.getProperty("fadeInSec", 0.0)),
                              static_cast<double>(cmd.getProperty("fadeOutSec", 0.0)),
                              static_cast<bool>(cmd.getProperty("reverse", false)), loopStart, loopEnd);
    if (rendered == nullptr)
    {
        clearPadLoop(pad); // no fades → the raw region hard-wraps (TS: the raw region looped)
        return ok(true);
    }
    const auto id = store_.add(rendered);
    if (!engine_.commands().push(
            Command::setPadLoopBuffer(static_cast<std::uint16_t>(pad), rendered.get(), loopStart, loopEnd)))
    {
        store_.retire(id, engine_.snapshot().blocksProcessed);
        return ok(false, "command queue full");
    }
    if (padLoopIds_[pad] != 0)
        store_.retire(padLoopIds_[pad], engine_.snapshot().blocksProcessed);
    padLoopIds_[pad] = id;
    auto* o = new juce::DynamicObject();
    o->setProperty("ok", true);
    o->setProperty("frames", static_cast<juce::int64>(rendered->numFrames));
    o->setProperty("loopStart", static_cast<juce::int64>(loopStart));
    o->setProperty("loopEnd", static_cast<juce::int64>(loopEnd));
    return juce::var(o);
}

} // namespace terminator::app
