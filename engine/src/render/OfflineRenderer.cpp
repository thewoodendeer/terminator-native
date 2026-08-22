#include "terminator/render/OfflineRenderer.h"

#include <algorithm>
#include <memory>
#include <vector>

#include <juce_audio_formats/juce_audio_formats.h>

#include "terminator/core/Engine.h"

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
} // namespace

bool parseRenderSpec(const juce::var& json, RenderSpec& out, juce::String& error)
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
    out = spec;
    return true;
}

bool parseRenderSpecFromText(const juce::String& text, RenderSpec& out, juce::String& error)
{
    juce::var parsed;
    const auto result = juce::JSON::parse(text, parsed);
    if (result.failed())
    {
        error = "JSON parse error: " + result.getErrorMessage();
        return false;
    }
    return parseRenderSpec(parsed, out, error);
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

    std::vector<float*> ptrs(static_cast<std::size_t>(spec.numChannels));
    int pos = 0;
    while (pos < total)
    {
        const int n = std::min(spec.blockSize, total - pos);
        for (int ch = 0; ch < spec.numChannels; ++ch)
            ptrs[static_cast<std::size_t>(ch)] = result.buffer.getWritePointer(ch, pos);
        engine.process(ptrs.data(), spec.numChannels, n);
        pos += n;
    }
    result.blocksProcessed = engine.snapshot().blocksProcessed;
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
