#include "terminator/io/Recorder.h"

#include <algorithm>
#include <cmath>

namespace terminator
{

/// The writer thread. It does one thing: move whatever the audio thread has left in the ring into the file, then
/// sleep. It never signals the audio thread and the audio thread never waits for it.
class Recorder::Writer final : public juce::Thread
{
  public:
    explicit Writer(Recorder& owner) : juce::Thread("terminator-rec"), owner_(owner) {}
    void run() override
    {
        while (!threadShouldExit())
        {
            owner_.drain(false);
            wait(20);
        }
    }

  private:
    Recorder& owner_;
};

Recorder::Recorder() = default;

Recorder::~Recorder()
{
    if (recording_.load(std::memory_order_acquire))
        stop();
}

bool Recorder::start(const RecorderConfig& cfg, juce::String& error)
{
    if (recording_.load(std::memory_order_acquire))
    {
        error = "already recording";
        return false;
    }
    cfg_ = cfg;
    cfg_.numChannels = std::clamp(cfg_.numChannels, 1, 32);
    cfg_.bitDepth = cfg_.bitDepth == 16 ? 16 : (cfg_.bitDepth == 32 ? 32 : 24);
    cfg_.ringSeconds = std::clamp(cfg_.ringSeconds, 1, 60);

    cfg_.file.getParentDirectory().createDirectory();
    cfg_.file.deleteFile();
    auto stream = std::make_unique<juce::FileOutputStream>(cfg_.file);
    if (!stream->openedOk())
    {
        error = "cannot write " + cfg_.file.getFullPathName();
        return false;
    }
    juce::WavAudioFormat wav;
    // 32 = FLOAT, 16 / 24 = integer PCM. The writer takes ownership of the stream.
    std::unique_ptr<juce::OutputStream> out = std::move(stream);
    writer_ = wav.createWriterFor(
        out, juce::AudioFormatWriterOptions{}
                 .withSampleRate(cfg_.sampleRate)
                 .withNumChannels(cfg_.numChannels)
                 .withBitsPerSample(cfg_.bitDepth)
                 .withSampleFormat(cfg_.bitDepth == 32 ? juce::AudioFormatWriterOptions::SampleFormat::floatingPoint
                                                       : juce::AudioFormatWriterOptions::SampleFormat::integral));
    if (writer_ == nullptr)
    {
        error = "cannot create a WAV writer";
        return false;
    }

    ringFrames_ = static_cast<int>(cfg_.sampleRate) * cfg_.ringSeconds;
    ring_.assign(static_cast<std::size_t>(ringFrames_) * static_cast<std::size_t>(cfg_.numChannels), 0.0f);
    chunk_.assign(static_cast<std::size_t>(cfg_.numChannels) * 8192u, 0.0f);
    writePos_.store(0, std::memory_order_relaxed);
    readPos_.store(0, std::memory_order_relaxed);
    captured_.store(0, std::memory_order_relaxed);
    written_.store(0, std::memory_order_relaxed);
    dropped_.store(0, std::memory_order_relaxed);
    for (auto& p : peak_)
        p.store(0.0f, std::memory_order_relaxed);

    recording_.store(true, std::memory_order_release);
    thread_ = std::make_unique<Writer>(*this);
    thread_->startThread();
    return true;
}

void Recorder::push(const float* const* inputs, int numIn, int numSamples) noexcept TERMINATOR_NONBLOCKING
{
    if (!recording_.load(std::memory_order_acquire) || inputs == nullptr || numSamples <= 0)
        return;
    const int nch = cfg_.numChannels;
    const std::uint64_t w = writePos_.load(std::memory_order_relaxed);
    const std::uint64_t r = readPos_.load(std::memory_order_acquire);
    const std::uint64_t free = static_cast<std::uint64_t>(ringFrames_) - (w - r);
    if (free < static_cast<std::uint64_t>(numSamples))
    {
        // The writer is behind. Drop this block and SAY SO — a take with a counted hole beats one that silently
        // splices across it, because the second kind is only discovered later, in the mix.
        dropped_.fetch_add(static_cast<std::uint64_t>(numSamples), std::memory_order_relaxed);
        return;
    }
    for (int i = 0; i < numSamples; ++i)
    {
        const std::size_t base =
            static_cast<std::size_t>((w + static_cast<std::uint64_t>(i)) % static_cast<std::uint64_t>(ringFrames_)) *
            static_cast<std::size_t>(nch);
        for (int c = 0; c < nch; ++c)
        {
            // which hardware input this recorded channel takes; default = the first N
            const int src =
                c < static_cast<int>(cfg_.inputChannels.size()) ? cfg_.inputChannels[static_cast<std::size_t>(c)] : c;
            const float v = (src >= 0 && src < numIn && inputs[src] != nullptr) ? inputs[src][i] : 0.0f;
            ring_[base + static_cast<std::size_t>(c)] = v;
            const float a = v < 0.0f ? -v : v;
            if (a > peak_[c].load(std::memory_order_relaxed))
                peak_[c].store(a, std::memory_order_relaxed);
        }
    }
    writePos_.store(w + static_cast<std::uint64_t>(numSamples), std::memory_order_release);
    captured_.fetch_add(static_cast<std::uint64_t>(numSamples), std::memory_order_relaxed);
}

void Recorder::drain(bool finish)
{
    if (writer_ == nullptr)
        return;
    const int nch = cfg_.numChannels;
    const int maxFrames = 8192;
    for (;;)
    {
        const std::uint64_t w = writePos_.load(std::memory_order_acquire);
        const std::uint64_t r = readPos_.load(std::memory_order_relaxed);
        if (w == r)
            break;
        const int n = static_cast<int>(std::min<std::uint64_t>(w - r, static_cast<std::uint64_t>(maxFrames)));
        // deinterleave into the staging buffer — JUCE's writer wants a channel per pointer
        float* chans[32];
        for (int c = 0; c < nch; ++c)
            chans[c] = chunk_.data() + static_cast<std::size_t>(c) * static_cast<std::size_t>(maxFrames);
        for (int i = 0; i < n; ++i)
        {
            const std::size_t base = static_cast<std::size_t>((r + static_cast<std::uint64_t>(i)) %
                                                              static_cast<std::uint64_t>(ringFrames_)) *
                                     static_cast<std::size_t>(nch);
            for (int c = 0; c < nch; ++c)
                chans[c][i] = ring_[base + static_cast<std::size_t>(c)];
        }
        writer_->writeFromFloatArrays(chans, nch, n);
        readPos_.store(r + static_cast<std::uint64_t>(n), std::memory_order_release);
        written_.fetch_add(static_cast<std::uint64_t>(n), std::memory_order_relaxed);
        if (!finish && n < maxFrames)
            break;
    }
}

std::uint64_t Recorder::stop()
{
    if (!recording_.load(std::memory_order_acquire))
        return written_.load(std::memory_order_relaxed);
    // Stop the audio thread writing FIRST, then take everything that is left — in that order there is nothing to
    // race with while the file is closed.
    recording_.store(false, std::memory_order_release);
    if (thread_ != nullptr)
    {
        thread_->signalThreadShouldExit();
        thread_->notify();
        thread_->stopThread(2000);
        thread_.reset();
    }
    drain(true);
    writer_.reset(); // flushes and closes the stream it owns
    return written_.load(std::memory_order_relaxed);
}

float Recorder::peak(int channel) const noexcept
{
    if (channel < 0 || channel >= 32)
        return 0.0f;
    return peak_[channel].load(std::memory_order_relaxed);
}

} // namespace terminator
