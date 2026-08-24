#include "terminator/render/AudioFileWriter.h"

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <memory>

#include <juce_audio_formats/juce_audio_formats.h>

namespace terminator::render
{

AudioFileFormat audioFileFormatFromName(const juce::String& name)
{
    const auto n = name.trim().toLowerCase();
    if (n == "flac")
        return AudioFileFormat::flac;
    if (n == "mp3")
        return AudioFileFormat::mp3;
    return AudioFileFormat::wav;
}

juce::String audioFileExtension(AudioFileFormat f)
{
    switch (f)
    {
    case AudioFileFormat::flac:
        return ".flac";
    case AudioFileFormat::mp3:
        return ".mp3";
    case AudioFileFormat::wav:
    default:
        return ".wav";
    }
}

std::vector<std::vector<std::int16_t>> quantizeTpdf16(const juce::AudioBuffer<float>& buffer)
{
    const int numCh = std::max(0, buffer.getNumChannels());
    const int n = std::max(0, buffer.getNumSamples());
    std::vector<std::vector<std::int16_t>> out(static_cast<std::size_t>(numCh),
                                               std::vector<std::int16_t>(static_cast<std::size_t>(n), 0));
    // the app's two xorshift32 streams, drawn once per sample per channel in interleave order
    std::uint32_t s1 = 0x2545f491u, s2 = 0x9e3779b9u;
    auto rnd = [&s1, &s2]
    {
        s1 ^= s1 << 13;
        s1 ^= s1 >> 17;
        s1 ^= s1 << 5;
        s2 ^= s2 << 13;
        s2 ^= s2 >> 17;
        s2 ^= s2 << 5;
        return static_cast<double>(s1) / 4294967296.0 - static_cast<double>(s2) / 4294967296.0;
    };
    for (int i = 0; i < n; ++i)
        for (int ch = 0; ch < numCh; ++ch)
        {
            const double x = std::clamp(static_cast<double>(buffer.getSample(ch, i)), -1.0, 1.0);
            // JavaScript's Math.round: half toward +infinity. std::round rounds half AWAY FROM ZERO and would
            // disagree with the shipping app on every negative half-sample.
            const double v = std::floor(x * 32767.0 + rnd() + 0.5);
            out[static_cast<std::size_t>(ch)][static_cast<std::size_t>(i)] =
                static_cast<std::int16_t>(std::clamp(v, -32768.0, 32767.0));
        }
    return out;
}

namespace
{
/// Write through a JUCE writer using our OWN 16-bit samples (JUCE takes int32 and keeps the top bits).
bool writeQuantised16(juce::AudioFormat& fmt, const juce::File& file, const juce::AudioBuffer<float>& buffer,
                      double sampleRate, juce::String& error)
{
    const int numCh = buffer.getNumChannels();
    const int n = buffer.getNumSamples();
    auto stream = std::unique_ptr<juce::FileOutputStream>(file.createOutputStream());
    if (stream == nullptr || stream->failedToOpen())
    {
        error = "cannot open " + file.getFullPathName() + " for writing";
        return false;
    }
    std::unique_ptr<juce::OutputStream> out = std::move(stream);
    auto writer =
        fmt.createWriterFor(out, juce::AudioFormatWriterOptions{}
                                     .withSampleRate(sampleRate)
                                     .withNumChannels(numCh)
                                     .withBitsPerSample(16)
                                     .withSampleFormat(juce::AudioFormatWriterOptions::SampleFormat::integral));
    if (writer == nullptr)
    {
        error = fmt.getFormatName() + " refused (rate " + juce::String(sampleRate) + ", 16-bit)";
        return false;
    }
    const auto q = quantizeTpdf16(buffer);
    std::vector<std::vector<int>> asInt(static_cast<std::size_t>(numCh));
    std::vector<const int*> ptrs(static_cast<std::size_t>(numCh));
    for (int ch = 0; ch < numCh; ++ch)
    {
        auto& col = asInt[static_cast<std::size_t>(ch)];
        col.resize(static_cast<std::size_t>(n));
        for (int i = 0; i < n; ++i) // JUCE reads int32 and takes the top 16 bits for a 16-bit file
            col[static_cast<std::size_t>(i)] =
                static_cast<int>(q[static_cast<std::size_t>(ch)][static_cast<std::size_t>(i)]) << 16;
        ptrs[static_cast<std::size_t>(ch)] = col.data();
    }
    if (!writer->write(ptrs.data(), n))
    {
        error = "write failed";
        return false;
    }
    writer.reset(); // flush + finalise before anyone reads the file back
    return true;
}

bool writeFloatPath(juce::AudioFormat& fmt, const juce::File& file, const juce::AudioBuffer<float>& buffer,
                    double sampleRate, int bitDepth, juce::String& error)
{
    auto stream = std::unique_ptr<juce::FileOutputStream>(file.createOutputStream());
    if (stream == nullptr || stream->failedToOpen())
    {
        error = "cannot open " + file.getFullPathName() + " for writing";
        return false;
    }
    std::unique_ptr<juce::OutputStream> out = std::move(stream);
    auto writer = fmt.createWriterFor(
        out, juce::AudioFormatWriterOptions{}
                 .withSampleRate(sampleRate)
                 .withNumChannels(buffer.getNumChannels())
                 .withBitsPerSample(bitDepth)
                 .withSampleFormat(bitDepth == 32 ? juce::AudioFormatWriterOptions::SampleFormat::floatingPoint
                                                  : juce::AudioFormatWriterOptions::SampleFormat::integral));
    if (writer == nullptr)
    {
        error = fmt.getFormatName() + " refused (rate " + juce::String(sampleRate) + ", " + juce::String(bitDepth) +
                "-bit)";
        return false;
    }
    if (!writer->writeFromAudioSampleBuffer(buffer, 0, buffer.getNumSamples()))
    {
        error = "write failed";
        return false;
    }
    writer.reset();
    return true;
}
} // namespace

int mp3QualityIndexFor(int kbps)
{
    // JUCE's list: 10 VBR levels (indices 0..9, 0 = best, 9 = smallest) then the CBR rates below, in this order.
    static constexpr int kCbr[] = {32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320};
    int best = 0;
    int bestDist = std::abs(kCbr[0] - kbps);
    for (int i = 1; i < static_cast<int>(std::size(kCbr)); ++i)
        if (const int d = std::abs(kCbr[i] - kbps); d < bestDist)
        {
            bestDist = d;
            best = i;
        }
    return 10 + best; // past the VBR block
}

juce::File findLameBinary(const juce::File& preferred)
{
    if (preferred.existsAsFile())
        return preferred;
    for (const auto* p :
         {"/opt/homebrew/bin/lame", "/usr/local/bin/lame", "/usr/bin/lame", "C:\\Program Files\\lame\\lame.exe"})
        if (juce::File f{juce::String(p)}; f.existsAsFile())
            return f;
    return {};
}

namespace
{
bool writeMp3(const juce::File& file, const juce::AudioBuffer<float>& buffer, double sampleRate, int kbps,
              const juce::File& lameBinary, juce::String& error)
{
    const auto lame = findLameBinary(lameBinary);
    if (!lame.existsAsFile())
    {
        error = "MP3 export needs the `lame` encoder and none was found — export WAV or FLAC, or install lame";
        return false;
    }
    juce::LAMEEncoderAudioFormat fmt(lame);
    auto stream = std::unique_ptr<juce::FileOutputStream>(file.createOutputStream());
    if (stream == nullptr || stream->failedToOpen())
    {
        error = "cannot open " + file.getFullPathName() + " for writing";
        return false;
    }
    std::unique_ptr<juce::OutputStream> out = std::move(stream);
    auto writer = fmt.createWriterFor(out, juce::AudioFormatWriterOptions{}
                                               .withSampleRate(sampleRate)
                                               .withNumChannels(buffer.getNumChannels())
                                               .withBitsPerSample(16)
                                               .withQualityOptionIndex(mp3QualityIndexFor(kbps)));
    if (writer == nullptr)
    {
        error = "the lame encoder refused (rate " + juce::String(sampleRate) + ")";
        return false;
    }
    if (!writer->writeFromAudioSampleBuffer(buffer, 0, buffer.getNumSamples()))
    {
        error = "write failed";
        return false;
    }
    writer.reset();
    return true;
}
} // namespace

bool writeAudioFile(const juce::File& file, const juce::AudioBuffer<float>& buffer, double sampleRate,
                    AudioFileFormat format, int bitDepth, juce::String& error, int mp3Kbps,
                    const juce::File& lameBinary)
{
    if (buffer.getNumChannels() <= 0 || buffer.getNumSamples() <= 0)
    {
        error = "nothing to write";
        return false;
    }
    file.deleteFile();
    switch (format)
    {
    case AudioFileFormat::flac:
    {
        juce::FlacAudioFormat flac;
        if (bitDepth <= 16)
            return writeQuantised16(flac, file, buffer, sampleRate, error);
        return writeFloatPath(flac, file, buffer, sampleRate, 24, error);
    }
    case AudioFileFormat::mp3:
        return writeMp3(file, buffer, sampleRate, mp3Kbps, lameBinary, error);
    case AudioFileFormat::wav:
    default:
    {
        if (bitDepth != 16 && bitDepth != 24 && bitDepth != 32)
        {
            error = "bitDepth must be 16, 24 or 32";
            return false;
        }
        juce::WavAudioFormat wav;
        if (bitDepth == 16)
            return writeQuantised16(wav, file, buffer, sampleRate, error);
        return writeFloatPath(wav, file, buffer, sampleRate, bitDepth, error);
    }
    }
}

} // namespace terminator::render
