#include "terminator/io/SampleLoader.h"

namespace terminator
{

SampleLoader::SampleLoader()
{
    formats_.registerBasicFormats();
}

juce::String SampleLoader::supportedExtensions() const
{
    return formats_.getWildcardForAllFormats();
}

std::shared_ptr<SampleBuffer> SampleLoader::read(std::unique_ptr<juce::AudioFormatReader> reader, juce::String& error,
                                                 int maxChannels)
{
    if (reader == nullptr)
    {
        error = "unsupported or unreadable audio file";
        return nullptr;
    }
    const auto frames = reader->lengthInSamples;
    if (frames <= 0)
    {
        error = "empty audio file";
        return nullptr;
    }
    if (frames > (std::int64_t{1} << 31))
    {
        error = "file too long";
        return nullptr;
    }
    int channels = static_cast<int>(reader->numChannels);
    if (maxChannels > 0 && channels > maxChannels)
        channels = maxChannels;
    if (channels <= 0)
    {
        error = "no channels";
        return nullptr;
    }
    auto out = std::make_shared<SampleBuffer>();
    out->allocate(channels, frames, reader->sampleRate);

    // read in blocks through a juce::AudioBuffer view onto our planar storage
    constexpr int kBlock = 1 << 16;
    float* planes[64] = {};
    for (int ch = 0; ch < channels && ch < 64; ++ch)
        planes[ch] = out->channel(ch);
    std::int64_t pos = 0;
    while (pos < frames)
    {
        const int n = static_cast<int>(std::min<std::int64_t>(kBlock, frames - pos));
        float* dest[64] = {};
        for (int ch = 0; ch < channels && ch < 64; ++ch)
            dest[ch] = planes[ch] + pos;
        juce::AudioBuffer<float> view(dest, channels, n);
        if (!reader->read(&view, 0, n, pos, true, channels > 1))
        {
            error = "read failed at frame " + juce::String(pos);
            return nullptr;
        }
        pos += n;
    }
    return out;
}

std::shared_ptr<SampleBuffer> SampleLoader::load(const juce::File& file, juce::String& error, int maxChannels)
{
    if (!file.existsAsFile())
    {
        error = "file not found: " + file.getFullPathName();
        return nullptr;
    }
    std::unique_ptr<juce::AudioFormatReader> reader(formats_.createReaderFor(file));
    if (reader == nullptr)
        error = "unsupported format: " + file.getFileName();
    return read(std::move(reader), error, maxChannels);
}

std::shared_ptr<SampleBuffer> SampleLoader::loadFromData(const void* data, size_t bytes, juce::String& error,
                                                         int maxChannels)
{
    auto stream = std::make_unique<juce::MemoryInputStream>(data, bytes, false);
    std::unique_ptr<juce::AudioFormatReader> reader(formats_.createReaderFor(std::move(stream)));
    if (reader == nullptr)
        error = "unsupported format (memory)";
    return read(std::move(reader), error, maxChannels);
}

} // namespace terminator
