#pragma once
// PLUGINS AS INSERTS (Phase 6.2) — the engine's half.
//
// The engine must not learn what a VST3 is. `juce_audio_processors` lives in the APP (with the scanner, the
// instances and their editors); the engine only knows this interface, and the app hands it a pointer over the
// command queue. That keeps `libterminator` headless: the CLI renderer and the tests link it with no plugin
// machinery at all, and the plugin format's own threading/GUI rules stay on the app's side of the fence.
//
// LIFETIME is the whole game: the audio thread reads `proc_` every block, so the app may only DELETE an instance
// after it has set the slot's processor to nullptr AND the engine has run blocks since. `Engine::snapshot()
// .blocksProcessed` is the receipt; the app's rack keeps a deferred-delete list against it.
#include <atomic>
#include <cstdint>
#include <vector>

#include <juce_core/juce_core.h>

#include "terminator/core/fx/Effect.h"

namespace terminator
{

/// One note for a hosted INSTRUMENT (6.3), at its sample offset inside the block.
struct ExternalNote
{
    std::uint32_t offset = 0; // samples into the block
    std::uint8_t note = 60;
    std::uint8_t velocity = 100;
    std::uint8_t on = 1; // 0 = note off
    std::uint8_t channel = 1;
};

/// Implemented in the app over `juce::AudioPluginInstance`. Every call happens on the AUDIO thread.
class ExternalProcessor
{
  public:
    virtual ~ExternalProcessor() = default;
    /// In place, float, `numChannels` pointers of `numSamples`. The plugin's own code runs here — it is other
    /// people's software, so it may do anything; that is the price of hosting and every host pays it.
    virtual void processBlock(float* const* channels, int numChannels, int numSamples) noexcept = 0;
    /// INSTRUMENTS (6.3): the same, plus this block's notes. The buffer arrives SILENT and the instrument fills
    /// it. An effect ignores the notes, which is why the default forwards.
    virtual void processBlockWithNotes(float* const* channels, int numChannels, int numSamples,
                                       const ExternalNote* notes, int numNotes) noexcept
    {
        juce::ignoreUnused(notes, numNotes);
        processBlock(channels, numChannels, numSamples);
    }
    /// The plugin's reported latency, for the mixer's PDC plan.
    virtual int latencySamples() const noexcept { return 0; }
};

/// One insert slot holding a plugin. Empty (no processor attached) it is a pass-through, so a chain restored from a
/// project keeps its slot while the app is still instantiating — a plugin takes a moment to load, and the mix must
/// not stop for it.
class PluginFx final : public Effect
{
  public:
    FxType type() const noexcept TERMINATOR_NONBLOCKING override { return FxType::plugin; }

    void prepare(double sampleRate, int maxBlockSize) override
    {
        sampleRate_ = sampleRate;
        maxBlock_ = maxBlockSize > 0 ? maxBlockSize : 512;
        scratch_.assign(static_cast<std::size_t>(maxBlock_) * 2, 0.0f);
        chans_[0] = scratch_.data();
        chans_[1] = scratch_.data() + maxBlock_;
        reset();
    }

    void reset() noexcept TERMINATOR_NONBLOCKING override
    {
        wet_.set(100.0f, true);
        // The processor pointer is NOT cleared here: reset() runs on the audio thread when a slot is (re)used, and
        // the app owns attachment. Clearing it would silently unload a plugin the user just inserted.
    }

    void setParam(int index, float value, bool immediate) noexcept TERMINATOR_NONBLOCKING override
    {
        if (index == 0)
            wet_.set(value, immediate);
    }
    float param(int index) const noexcept TERMINATOR_NONBLOCKING override { return index == 0 ? wet_.target : 0.0f; }

    int latencySamples() const noexcept TERMINATOR_NONBLOCKING override
    {
        auto* p = proc_.load(std::memory_order_acquire);
        return p != nullptr ? p->latencySamples() : 0;
    }

    /// The app's side (message thread → the audio thread through a command). nullptr = the slot passes audio.
    void setProcessor(ExternalProcessor* p) noexcept TERMINATOR_NONBLOCKING
    {
        proc_.store(p, std::memory_order_release);
    }
    ExternalProcessor* processor() const noexcept TERMINATOR_NONBLOCKING
    {
        return proc_.load(std::memory_order_acquire);
    }

    void process(double* l, double* r, int numSamples) noexcept TERMINATOR_NONBLOCKING override
    {
        auto* p = proc_.load(std::memory_order_acquire);
        if (p == nullptr || numSamples > maxBlock_)
            return; // pass through: no plugin attached (or a block bigger than we were prepared for)
        for (int i = 0; i < numSamples; ++i)
        {
            chans_[0][i] = static_cast<float>(l[i]);
            chans_[1][i] = static_cast<float>(r[i]);
        }
        p->processBlock(chans_, 2, numSamples);
        for (int i = 0; i < numSamples; ++i)
        {
            l[i] = static_cast<double>(chans_[0][i]);
            r[i] = static_cast<double>(chans_[1][i]);
        }
    }

  private:
    std::atomic<ExternalProcessor*> proc_{nullptr};
    std::vector<float> scratch_; // 2 x maxBlock, allocated in prepare()
    float* chans_[2] = {nullptr, nullptr};
    double sampleRate_ = 48000.0;
    int maxBlock_ = 512;
    Glide wet_;
};

} // namespace terminator
