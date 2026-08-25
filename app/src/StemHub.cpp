#include "StemHub.h"

#include <algorithm>

#include "SampleRegistry.h"

namespace terminator::app
{
namespace
{
constexpr int kDrainHz = 20; // the outbox drain — the page's progress line, not audio

juce::var ok(bool okFlag, const juce::String& error = {})
{
    auto* o = new juce::DynamicObject();
    o->setProperty("ok", okFlag);
    if (!okFlag)
        o->setProperty("error", error);
    return juce::var(o);
}

stems::Quality qualityOf(const juce::var& v)
{
    return v.toString().equalsIgnoreCase("fine") ? stems::Quality::fine : stems::Quality::fast;
}
const char* qualityName(stems::Quality q)
{
    return q == stems::Quality::fine ? "fine" : "fast";
}

juce::var rangesToVar(const std::vector<stems::ReadyRange>& ranges)
{
    juce::Array<juce::var> out;
    for (const auto& r : ranges)
    {
        juce::Array<juce::var> pair;
        pair.add(r.start);
        pair.add(r.end);
        out.add(juce::var(pair));
    }
    return juce::var(out);
}
} // namespace

StemHub::StemHub(Engine& engine, SampleRegistry& registry, const juce::File& dataDir,
                 std::function<juce::String(std::vector<std::byte>)> stashBytes)
    : engine_(engine), registry_(registry), stashBytes_(std::move(stashBytes)), models_(dataDir)
{
    // ADOPT THE ELECTRON APP'S MODELS. htdemucs is 166 MB (FAST) / 1.2 GB (FINE) and the shipping app keeps it
    // in its own folder on this machine — asking the same user to download it again would be rude. The files
    // are identical (same names, same SHA-256s), so if ours are missing and its are there, that IS our folder.
    // Same read-fallback idea as the asset store (assetsNative.ts).
    if (!models_.ready(stems::Quality::fast) && !models_.ready(stems::Quality::fine))
    {
        const auto home = juce::File::getSpecialLocation(juce::File::userHomeDirectory);
#if JUCE_WINDOWS
        const auto electron = home.getChildFile("AppData")
                                  .getChildFile("Roaming")
                                  .getChildFile("terminator")
                                  .getChildFile("terminator-stems")
                                  .getChildFile("models");
#else
        const auto electron = home.getChildFile("Library")
                                  .getChildFile("Application Support")
                                  .getChildFile("terminator")
                                  .getChildFile("terminator-stems")
                                  .getChildFile("models");
#endif
        if (electron.isDirectory())
        {
            stems::StemModels probe(dataDir);
            probe.setDirectory(electron);
            if (probe.ready(stems::Quality::fast) || probe.ready(stems::Quality::fine))
                models_.setDirectory(electron);
        }
    }
    startTimerHz(kDrainHz);
}

StemHub::~StemHub()
{
    stopTimer();
    stopWorker();
}

void StemHub::stopWorker()
{
    cancelDownload_.store(true, std::memory_order_relaxed);
    if (auto s = session_)
        s->cancel();
    if (worker_.joinable())
        worker_.join();
    cancelDownload_.store(false, std::memory_order_relaxed);
}

void StemHub::post(const juce::String& event, juce::var payload, std::vector<std::byte> bytes)
{
    const std::lock_guard lock(outboxMutex_);
    outbox_.push_back({event, std::move(payload), std::move(bytes)});
}

void StemHub::timerCallback()
{
    std::vector<Outgoing> batch;
    {
        const std::lock_guard lock(outboxMutex_);
        batch.swap(outbox_);
    }
    for (auto& m : batch)
    {
        if (!m.bytes.empty() && stashBytes_)
            if (auto* o = m.payload.getDynamicObject())
                o->setProperty("blob", "/blob/" + stashBytes_(std::move(m.bytes)));
        if (onEvent)
            onEvent(m.event, m.payload);
    }
    // A finished run is joined here rather than in the split thread — the thread cannot join itself.
    if (!running_.load(std::memory_order_relaxed) && worker_.joinable())
        worker_.join();
}

const stems::StemSet* StemHub::setFor(const juce::String& key) const
{
    const std::lock_guard lock(setsMutex_);
    const auto it = sets_.find(key);
    return it == sets_.end() ? nullptr : it->second.get();
}

juce::var StemHub::rangesVar(const juce::String& key) const
{
    const std::lock_guard lock(setsMutex_);
    const auto it = sets_.find(key);
    return it == sets_.end() ? juce::var(juce::Array<juce::var>()) : rangesToVar(it->second->ranges());
}

juce::var StemHub::statusVar() const
{
    std::string error;
    const bool runtime = stems::StemModel::ensureRuntime(error);
    auto* o = new juce::DynamicObject();
    o->setProperty("ok", true);
    o->setProperty("available", runtime);
    o->setProperty("ort", juce::String(stems::StemModel::runtimeVersion()));
    if (!runtime)
        o->setProperty("unavailable", juce::String(error));
    o->setProperty("busy", running_.load(std::memory_order_relaxed));
    o->setProperty("key", currentKey_);
    o->setProperty("engine", "cpu"); // the GPU providers are 7.2, behind the SNR self-check

    juce::Array<juce::var> list;
    for (const auto& info : models_.info())
    {
        auto* m = new juce::DynamicObject();
        m->setProperty("quality", qualityName(info.quality));
        m->setProperty("ready", info.ready);
        m->setProperty("bytes", static_cast<juce::int64>(info.bytes));
        m->setProperty("expectedBytes", static_cast<juce::int64>(info.expectedBytes));
        list.add(juce::var(m));
    }
    o->setProperty("models", juce::var(list));
    o->setProperty("modelsDir", models_.directory().getFullPathName());

    juce::Array<juce::var> sources;
    {
        const std::lock_guard lock(setsMutex_);
        for (const auto& [key, set] : sets_)
        {
            auto* s = new juce::DynamicObject();
            s->setProperty("key", key);
            s->setProperty("ranges", rangesToVar(set->ranges()));
            s->setProperty("readySeconds", set->readySeconds());
            s->setProperty("seconds", static_cast<double>(set->frames()) / std::max(1.0, set->sampleRate()));
            sources.add(juce::var(s));
        }
    }
    o->setProperty("sources", juce::var(sources));
    return juce::var(o);
}

juce::var StemHub::handle(const juce::var& req)
{
    const auto verb = req.isObject() ? req.getProperty("verb", "status").toString() : juce::String("status");
    if (verb == "status")
        return statusVar();
    if (verb == "split")
        return startSplit(req);
    if (verb == "queueWindow")
    {
        auto s = session_;
        if (!s || !running_.load(std::memory_order_relaxed))
            return ok(false, "no split is running");
        const auto span = req.getProperty("span", juce::var());
        const double a = span.getProperty("startSec", 0.0);
        const double b = span.getProperty("endSec", 0.0);
        if (!(b > a))
            return ok(false, "queueWindow: empty span");
        s->queueWindows({{a, b}}, true); // the chop he just focused goes to the head of the queue
        return ok(true);
    }
    if (verb == "cancel")
    {
        if (auto s = session_)
            s->cancel();
        cancelDownload_.store(true, std::memory_order_relaxed);
        return ok(true);
    }
    if (verb == "downloadModels")
    {
        if (running_.load(std::memory_order_relaxed))
            return ok(false, "a split is running");
        const auto quality = qualityOf(req.getProperty("quality", "fast"));
        stopWorker();
        running_.store(true, std::memory_order_relaxed);
        worker_ = std::thread(
            [this, quality]
            {
                std::string error;
                const auto result = models_.ensure(
                    quality, error,
                    [this](int pct)
                    {
                        auto* p = new juce::DynamicObject();
                        p->setProperty("phase", "models");
                        p->setProperty("pct", pct);
                        post("terminator.stemsProgress", juce::var(p));
                    },
                    &cancelDownload_);
                auto* done = new juce::DynamicObject();
                done->setProperty("quality", qualityName(quality));
                done->setProperty("ready", result == stems::ModelError::none);
                if (result != stems::ModelError::none)
                    done->setProperty("error", juce::String(error));
                post("terminator.stemsModels", juce::var(done));
                running_.store(false, std::memory_order_relaxed);
            });
        return ok(true);
    }
    if (verb == "deleteModels")
    {
        if (running_.load(std::memory_order_relaxed))
            return ok(false, "a download or split is running");
        std::string error;
        return models_.remove(qualityOf(req.getProperty("quality", "fast")), error) ? ok(true)
                                                                                    : ok(false, juce::String(error));
    }
    if (verb == "modelsDir")
    {
        const auto path = req.getProperty("path", "").toString();
        models_.setDirectory(path.isEmpty() ? juce::File() : juce::File(path));
        return statusVar();
    }
    if (verb == "forget")
    {
        // Drop a source's stems (the page closed the project / released the sample). Pads pointing at them are
        // detached first, so the engine can never read a retired plane.
        const auto key = req.getProperty("key", "").toString();
        if (running_.load(std::memory_order_relaxed) && key == currentKey_)
            return ok(false, "that source is being split");
        std::shared_ptr<stems::StemSet> dropped;
        {
            const std::lock_guard lock(setsMutex_);
            if (const auto it = sets_.find(key); it != sets_.end())
            {
                dropped = it->second;
                sets_.erase(it);
            }
        }
        if (dropped != nullptr)
            for (int pad = 0; pad < kMaxPads; ++pad)
                engine_.commands().push(Command::setPadStems(static_cast<std::uint16_t>(pad), nullptr, 0));
        return ok(dropped != nullptr);
    }
    return ok(false, "unknown stems verb '" + verb + "'");
}

juce::var StemHub::startSplit(const juce::var& req)
{
    if (running_.load(std::memory_order_relaxed))
        return ok(false, "a split is already running");
    std::string runtimeError;
    if (!stems::StemModel::ensureRuntime(runtimeError))
        return ok(false, juce::String(runtimeError));

    const auto key = req.getProperty("key", "").toString();
    auto source = registry_.shared(key); // a shared_ptr so the split owns what it reads for its whole run
    if (source == nullptr || source->numFrames <= 0)
        return ok(false, "split: unknown sample key '" + key + "'");

    const auto quality = qualityOf(req.getProperty("quality", "fast"));
    std::vector<stems::Span> windows;
    if (const auto* arr = req.getProperty("windows", juce::var()).getArray())
        for (const auto& w : *arr)
        {
            const double a = w.getProperty("startSec", 0.0);
            const double b = w.getProperty("endSec", 0.0);
            if (b > a)
                windows.push_back({a, b});
        }
    const bool sweep = windows.empty() || static_cast<bool>(req.getProperty("sweep", true));
    // The engine-side planes are opt-in (see the header): the page still takes the audio today.
    const bool keepPlanes = static_cast<bool>(req.getProperty("planes", false));

    if (keepPlanes)
    {
        // One set per source, kept across splits: a second pass (FINE after FAST, or another window) fills the
        // same planes, so pads already reading them just get better audio.
        const std::lock_guard lock(setsMutex_);
        auto& set = sets_[key];
        if (set == nullptr || set->frames() != source->numFrames || set->sampleRate() != source->sampleRate)
            set = std::make_shared<stems::StemSet>(source->numFrames, source->numChannels, source->sampleRate);
    }

    stopWorker();
    currentKey_ = key;
    running_.store(true, std::memory_order_relaxed);
    worker_ = std::thread(&StemHub::runSplit, this, source, key, quality, windows, sweep, keepPlanes);
    return ok(true);
}

void StemHub::runSplit(std::shared_ptr<SampleBuffer> source, juce::String key, stems::Quality quality,
                       std::vector<stems::Span> windows, bool sweep, bool keepPlanes)
{
    const auto fail = [this](const juce::String& message)
    {
        auto* o = new juce::DynamicObject();
        o->setProperty("message", message);
        post("terminator.stemsError", juce::var(o));
        running_.store(false, std::memory_order_relaxed);
    };
    const auto progress = [this](const char* phase, int pct, int total)
    {
        auto* p = new juce::DynamicObject();
        p->setProperty("phase", phase);
        p->setProperty("pct", pct);
        if (total > 0)
            p->setProperty("total", total);
        post("terminator.stemsProgress", juce::var(p));
    };

    // 1. the models (a download only when they are missing — normally instant)
    std::string error;
    if (!models_.ready(quality))
    {
        progress("models", 0, 0);
        if (models_.ensure(
                quality, error, [&](int pct) { progress("models", pct, 0); }, &cancelDownload_) !=
            stems::ModelError::none)
            return fail(juce::String(error));
    }

    // 2. the sessions (the slow silent stretch: FINE loads four big models). A model already loaded at this
    // quality is reused — the real per-split overhead, and his batch-stemming workflow pays it once.
    progress("load", 0, 0);
    if (!modelLoaded_ || loadedQuality_ != quality)
    {
        if (!model_.load(models_.pathStrings(quality), error))
            return fail(juce::String(error));
        modelLoaded_ = true;
        loadedQuality_ = quality;
    }
    progress("load", 100, 0);

    // 3. the split itself
    const float* left = source->channel(0);
    const float* right = source->numChannels > 1 ? source->channel(1) : left;
    auto session = std::make_shared<stems::SplitSession>(left, right, source->numFrames, source->sampleRate);
    session_ = session;
    if (!windows.empty())
        session->queueWindows(windows, false);
    if (sweep)
        session->queueSweep();
    const int total = session->queuedTotal();
    progress("split", 0, total);

    std::shared_ptr<stems::StemSet> set;
    if (keepPlanes)
    {
        const std::lock_guard lock(setsMutex_);
        set = sets_[key];
        if (set == nullptr)
            return fail("split: the stem set went away");
    }
    const double rate = source->sampleRate;

    const bool finished = session->run(
        [this, &error](const float* mix, float* rows)
        { return model_.run(mix, rows, error, [session = session_](double f) { session->reportPartial(f); }); },
        [this, &set, &key, rate](const stems::ReadyChunk& chunk)
        {
            const auto frames = chunk.endFrame - chunk.startFrame;
            juce::var ranges;
            if (set != nullptr)
            {
                // The audio is written BEFORE the range is published: by the time the page can ask a pad to
                // read these frames, they are here (see the header note on threads).
                const std::lock_guard lock(setsMutex_);
                set->write(chunk);
                ranges = rangesToVar(set->ranges());
            }
            // The span's PCM for the page: the eight planes end to end (drums L,R, bass L,R, other L,R,
            // vocals L,R), float32, exactly the order `onStemsChunk` has always handed the renderer.
            std::vector<std::byte> bytes(static_cast<std::size_t>(frames) * stems::kStemPlanes * sizeof(float));
            auto* dest = reinterpret_cast<float*>(bytes.data());
            for (int p = 0; p < stems::kStemPlanes; ++p)
            {
                const auto& plane = chunk.stems[static_cast<std::size_t>(p)];
                const auto n = std::min<std::size_t>(static_cast<std::size_t>(frames), plane.size());
                std::copy(plane.begin(), plane.begin() + static_cast<std::ptrdiff_t>(n),
                          dest + static_cast<std::size_t>(p) * static_cast<std::size_t>(frames));
            }
            auto* o = new juce::DynamicObject();
            o->setProperty("key", key);
            o->setProperty("startFrame", static_cast<juce::int64>(chunk.startFrame));
            o->setProperty("endFrame", static_cast<juce::int64>(chunk.endFrame));
            o->setProperty("frames", static_cast<juce::int64>(frames));
            o->setProperty("planes", stems::kStemPlanes);
            o->setProperty("startSec", static_cast<double>(chunk.startFrame) / rate);
            o->setProperty("endSec", static_cast<double>(chunk.endFrame) / rate);
            if (set != nullptr)
                o->setProperty("ranges", ranges);
            post("terminator.stemsChunk", juce::var(o), std::move(bytes));
        },
        [&](double done, int queued)
        { progress("split", static_cast<int>(100.0 * done / std::max(1, queued)), queued); });

    session_.reset();
    if (!finished && !error.empty())
        return fail(juce::String(error));

    auto* o = new juce::DynamicObject();
    o->setProperty("key", key);
    o->setProperty("cancelled", !finished);
    if (set != nullptr)
    {
        const std::lock_guard lock(setsMutex_);
        o->setProperty("ranges", rangesToVar(set->ranges()));
    }
    post("terminator.stemsDone", juce::var(o));
    running_.store(false, std::memory_order_relaxed);
}

juce::var StemHub::setPadStems(const juce::var& cmd)
{
    const int pad = cmd.isObject() ? static_cast<int>(cmd.getProperty("pad", -1)) : -1;
    if (pad < 0 || pad >= kMaxPads)
        return ok(false, "setPadStems: pad out of range");
    const auto key = cmd.getProperty("key", "").toString();
    const auto mask = static_cast<std::uint8_t>(std::clamp(static_cast<int>(cmd.getProperty("mask", 15)), 0, 15));

    const stems::StemSet* set = key.isEmpty() ? nullptr : setFor(key);
    if (set == nullptr || mask == 0 || mask == stems::kMaskAll)
    {
        // Nothing to sum: the pad plays its ORIGINAL sample (the engine's own fallback, made explicit).
        if (!engine_.commands().push(Command::setPadStems(static_cast<std::uint16_t>(pad), nullptr, 0)))
            return ok(false, "command queue full");
        return ok(true);
    }
    const auto planes = set->planePointers();
    if (!engine_.commands().push(Command::setPadStems(static_cast<std::uint16_t>(pad), planes.data(), mask)))
        return ok(false, "command queue full");
    auto* o = new juce::DynamicObject();
    o->setProperty("ok", true);
    o->setProperty("mask", static_cast<int>(mask));
    return juce::var(o);
}
} // namespace terminator::app
