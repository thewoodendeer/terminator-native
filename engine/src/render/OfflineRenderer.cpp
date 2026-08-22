#include "terminator/render/OfflineRenderer.h"

#include <algorithm>
#include <memory>
#include <vector>

#include <juce_audio_formats/juce_audio_formats.h>

#include "terminator/core/Engine.h"
#include "terminator/io/SampleLoader.h"

namespace terminator
{

namespace
{
template <typename T>
bool readNumber(const juce::var& obj, const char* key, T& out, juce::String& error, double lo, double hi)
{
    if (!obj.hasProperty(key))
        return true;
    const auto v = obj[key];
    if (!v.isDouble() && !v.isInt() && !v.isInt64())
    {
        error = juce::String("'") + key + "' must be a number";
        return false;
    }
    const double d = static_cast<double>(v);
    if (d < lo || d > hi)
    {
        error = juce::String("'") + key + "' out of range [" + juce::String(lo) + ", " + juce::String(hi) + "]";
        return false;
    }
    out = static_cast<T>(d);
    return true;
}

bool readBool(const juce::var& obj, const char* key, bool& out, juce::String& error)
{
    if (!obj.hasProperty(key))
        return true;
    const auto v = obj[key];
    if (!v.isBool() && !v.isInt())
    {
        error = juce::String("'") + key + "' must be a boolean";
        return false;
    }
    out = static_cast<bool>(v);
    return true;
}

bool parsePad(const juce::var& p, RenderPadSpec& out, juce::String& error, const juce::File& baseDir)
{
    if (!p.isObject())
    {
        error = "pads[] entries must be objects";
        return false;
    }
    int pad = 0;
    if (!readNumber(p, "pad", pad, error, 0, kMaxPads - 1))
        return false;
    out.params.pad = static_cast<std::uint16_t>(pad);
    const auto file = p["file"].toString();
    if (file.isNotEmpty())
        out.file =
            juce::File::isAbsolutePath(file)
                ? juce::File(file)
                : (baseDir == juce::File() ? juce::File::getCurrentWorkingDirectory() : baseDir).getChildFile(file);
    if (!readNumber(p, "startFrame", out.startFrame, error, 0, 1e12))
        return false;
    if (!readNumber(p, "endFrame", out.endFrame, error, 0, 1e12))
        return false;
    if (!readNumber(p, "pitch", out.params.pitchSemitones, error, -24, 24))
        return false;
    if (!readNumber(p, "fine", out.params.fineCents, error, -50, 50))
        return false;
    if (!readNumber(p, "attack", out.params.attackSec, error, 0, 0.5))
        return false;
    if (!readNumber(p, "release", out.params.releaseSec, error, 0, 0.5))
        return false;
    if (!readNumber(p, "gain", out.params.gain, error, 0, 4))
        return false;
    int outputPair = 0;
    if (!readNumber(p, "outputPair", outputPair, error, 0, 15))
        return false;
    out.params.outputPair = static_cast<std::uint8_t>(outputPair);
    bool reverse = false;
    if (!readBool(p, "reverse", reverse, error))
        return false;
    out.params.reverse = reverse ? 1 : 0;
    int choke = -1;
    if (!readNumber(p, "chokeGroup", choke, error, -2, 32767))
        return false;
    out.params.chokeGroup = static_cast<std::int16_t>(choke);
    const auto mode = p.getProperty("mode", "oneshot").toString();
    if (mode == "oneshot")
        out.params.mode = PadMode::oneShot;
    else if (mode == "gate")
        out.params.mode = PadMode::gate;
    else if (mode == "loop")
        out.params.mode = PadMode::loop;
    else
    {
        error = "pad mode must be oneshot|gate|loop";
        return false;
    }
    const auto interp = p.getProperty("interpolation", "hermite").toString();
    if (interp == "hermite")
        out.params.interpolation = Interpolation::hermite;
    else if (interp == "linear")
        out.params.interpolation = Interpolation::linear;
    else
    {
        error = "interpolation must be hermite|linear";
        return false;
    }
    return true;
}

bool parseEvent(const juce::var& e, RenderEvent& out, juce::String& error)
{
    if (!e.isObject())
    {
        error = "events[] entries must be objects";
        return false;
    }
    int pad = 0;
    if (!readNumber(e, "pad", pad, error, 0, kMaxPads - 1))
        return false;
    out.pad = static_cast<std::uint16_t>(pad);
    if (!readNumber(e, "time", out.timeSec, error, 0, 3600))
        return false;
    if (!readNumber(e, "velocity", out.velocity, error, 0, 1))
        return false;
    const auto type = e.getProperty("type", "on").toString();
    if (type == "on")
        out.type = RenderEvent::Type::on;
    else if (type == "off")
        out.type = RenderEvent::Type::off;
    else if (type == "stop")
        out.type = RenderEvent::Type::stop;
    else
    {
        error = "event type must be on|off|stop";
        return false;
    }
    return true;
}
} // namespace

bool parseRenderSpec(const juce::var& json, RenderSpec& out, juce::String& error, const juce::File& baseDir)
{
    if (!json.isObject())
    {
        error = "project must be a JSON object";
        return false;
    }
    if (!json.hasProperty("terminatorProject"))
    {
        error = "missing 'terminatorProject' version field";
        return false;
    }
    if (static_cast<int>(json["terminatorProject"]) != 0)
    {
        error = "unsupported project version " + json["terminatorProject"].toString() + " (this build reads v0)";
        return false;
    }

    RenderSpec spec;
    const auto render = json["render"];
    if (render.isObject())
    {
        if (!readNumber(render, "sampleRate", spec.sampleRate, error, 8000.0, 384000.0))
            return false;
        if (!readNumber(render, "blockSize", spec.blockSize, error, 1.0, 65536.0))
            return false;
        if (!readNumber(render, "channels", spec.numChannels, error, 1.0, 64.0))
            return false;
        if (!readNumber(render, "lengthSeconds", spec.lengthSeconds, error, 0.0, 3600.0))
            return false;
    }
    const auto master = json["master"];
    if (master.isObject())
    {
        if (!readNumber(master, "gain", spec.masterGain, error, 0.0, 4.0))
            return false;
    }
    const auto tone = json["testTone"];
    if (tone.isObject())
    {
        if (!readBool(tone, "enabled", spec.testToneEnabled, error))
            return false;
        if (!readNumber(tone, "frequencyHz", spec.testToneFrequencyHz, error, 0.1, 100000.0))
            return false;
        if (!readNumber(tone, "amplitude", spec.testToneAmplitude, error, 0.0, 1.0))
            return false;
    }
    if (json.hasProperty("pads"))
    {
        const auto* arr = json["pads"].getArray();
        if (arr == nullptr)
        {
            error = "'pads' must be an array";
            return false;
        }
        for (const auto& p : *arr)
        {
            RenderPadSpec ps;
            if (!parsePad(p, ps, error, baseDir))
                return false;
            spec.pads.push_back(std::move(ps));
        }
    }
    if (json.hasProperty("events"))
    {
        const auto* arr = json["events"].getArray();
        if (arr == nullptr)
        {
            error = "'events' must be an array";
            return false;
        }
        for (const auto& e : *arr)
        {
            RenderEvent ev;
            if (!parseEvent(e, ev, error))
                return false;
            spec.events.push_back(ev);
        }
    }
    out = std::move(spec);
    return true;
}

bool parseRenderSpecFromText(const juce::String& text, RenderSpec& out, juce::String& error, const juce::File& baseDir)
{
    juce::var parsed;
    const auto result = juce::JSON::parse(text, parsed);
    if (result.failed())
    {
        error = "JSON parse error: " + result.getErrorMessage();
        return false;
    }
    return parseRenderSpec(parsed, out, error, baseDir);
}

bool parseRenderSpecFromFile(const juce::File& projectFile, RenderSpec& out, juce::String& error)
{
    if (!projectFile.existsAsFile())
    {
        error = "project file not found: " + projectFile.getFullPathName();
        return false;
    }
    return parseRenderSpecFromText(projectFile.loadFileAsString(), out, error, projectFile.getParentDirectory());
}

bool loadRenderSamples(RenderSpec& spec, juce::String& error)
{
    SampleLoader loader;
    for (auto& p : spec.pads)
    {
        if (p.sample != nullptr || p.file == juce::File())
            continue;
        p.sample = loader.load(p.file, error);
        if (p.sample == nullptr)
        {
            error = "pad " + juce::String(p.params.pad) + ": " + error;
            return false;
        }
    }
    return true;
}

RenderResult renderOffline(const RenderSpec& spec)
{
    RenderResult result;
    result.sampleRate = spec.sampleRate;
    const auto total = static_cast<int>(std::max<std::int64_t>(0, spec.totalSamples()));
    result.buffer.setSize(spec.numChannels, total, false, true, false);
    if (total == 0 || spec.numChannels <= 0)
        return result;

    Engine engine;
    Engine::Config cfg;
    cfg.sampleRate = spec.sampleRate;
    cfg.maxBlockSize = spec.blockSize;
    cfg.numOutputChannels = spec.numChannels;
    engine.prepare(cfg);

    // Same commands the UI would send; the queue is drained at the first process() call.
    engine.commands().push(Command::setMasterGain(spec.masterGain));
    engine.commands().push(
        Command::setTestTone(spec.testToneEnabled, spec.testToneFrequencyHz, spec.testToneAmplitude));
    engine.commands().push(Command::transportPlay());
    for (const auto& p : spec.pads)
    {
        engine.commands().push(Command::setPadParams(p.params));
        if (p.sample == nullptr)
            continue;
        engine.commands().push(Command::setPadSample(p.params.pad, p.sample.get(), p.startFrame, p.endFrame));
        if (p.loopSample != nullptr)
            engine.commands().push(Command::setPadLoopBuffer(p.params.pad, p.loopSample.get(), p.loopStart, p.loopEnd));
        const bool anyPlane = p.stems[0] || p.stems[1] || p.stems[2] || p.stems[3];
        if (anyPlane && (p.stemMask & 15) != 15)
        {
            const SampleBuffer* planes[4] = {p.stems[0].get(), p.stems[1].get(), p.stems[2].get(), p.stems[3].get()};
            engine.commands().push(Command::setPadStems(p.params.pad, planes, p.stemMask));
        }
    }

    // events sorted by time; pushed per block so the queue never holds more than one block's worth
    std::vector<const RenderEvent*> events;
    events.reserve(spec.events.size());
    for (const auto& e : spec.events)
        events.push_back(&e);
    std::stable_sort(events.begin(), events.end(),
                     [](const RenderEvent* a, const RenderEvent* b) { return a->timeSec < b->timeSec; });
    std::size_t nextEvent = 0;

    std::vector<float*> ptrs(static_cast<std::size_t>(spec.numChannels));
    int pos = 0;
    while (pos < total)
    {
        const int n = std::min(spec.blockSize, total - pos);
        const auto blockStart = static_cast<std::uint64_t>(pos);
        const auto blockEnd = blockStart + static_cast<std::uint64_t>(n);
        while (nextEvent < events.size())
        {
            const auto* e = events[nextEvent];
            const auto at = static_cast<std::uint64_t>(e->timeSec * spec.sampleRate + 0.5);
            if (at >= blockEnd)
                break;
            const auto clamped = std::max(at, blockStart);
            switch (e->type)
            {
            case RenderEvent::Type::on:
                engine.commands().push(Command::triggerPadAtSample(e->pad, e->velocity, clamped));
                break;
            case RenderEvent::Type::off:
                engine.commands().push(Command::releasePadAtSample(e->pad, clamped));
                break;
            case RenderEvent::Type::stop:
                engine.commands().push(Command::stopPad(e->pad));
                break;
            }
            ++nextEvent;
        }
        for (int ch = 0; ch < spec.numChannels; ++ch)
            ptrs[static_cast<std::size_t>(ch)] = result.buffer.getWritePointer(ch, pos);
        engine.process(ptrs.data(), spec.numChannels, n);
        pos += n;
    }
    result.blocksProcessed = engine.snapshot().blocksProcessed;
    result.voiceSteals = engine.snapshot().voiceStealing;
    engine.release();
    return result;
}

bool writeWav(const juce::File& file, const juce::AudioBuffer<float>& buffer, double sampleRate, int bitDepth,
              juce::String& error)
{
    if (bitDepth != 16 && bitDepth != 24 && bitDepth != 32)
    {
        error = "bitDepth must be 16, 24 or 32";
        return false;
    }
    file.deleteFile();
    auto stream = std::unique_ptr<juce::FileOutputStream>(file.createOutputStream());
    if (stream == nullptr || stream->failedToOpen())
    {
        error = "cannot open " + file.getFullPathName() + " for writing";
        return false;
    }
    juce::WavAudioFormat wav;
    const auto options =
        juce::AudioFormatWriterOptions{}
            .withSampleRate(sampleRate)
            .withNumChannels(buffer.getNumChannels())
            .withBitsPerSample(bitDepth)
            .withSampleFormat(bitDepth == 32 ? juce::AudioFormatWriterOptions::SampleFormat::floatingPoint
                                             : juce::AudioFormatWriterOptions::SampleFormat::integral);
    std::unique_ptr<juce::OutputStream> out = std::move(stream);
    auto writer = wav.createWriterFor(out, options);
    if (writer == nullptr)
    {
        error = "WavAudioFormat refused (rate " + juce::String(sampleRate) + ", " + juce::String(bitDepth) + "-bit)";
        return false;
    }
    if (!writer->writeFromAudioSampleBuffer(buffer, 0, buffer.getNumSamples()))
    {
        error = "write failed";
        return false;
    }
    return true;
}

} // namespace terminator
