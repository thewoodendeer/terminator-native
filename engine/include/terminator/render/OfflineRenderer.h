#pragma once
// Offline rendering = the SAME Engine driven faster than real time. This is the test-harness spine:
// terminator-render (CLI) and the Catch2 tests both go through renderOffline(). "Export = what you hear"
// is true by construction because there is no second code path.
//
// Project spec v0 (JSON) — see docs/native/BRIDGE-PROTOCOL.md §Project v0:
// {
//   "terminatorProject": 0,
//   "render":   { "sampleRate": 48000, "blockSize": 512, "channels": 2, "lengthSeconds": 2.0 },
//   "master":   { "gain": 0.5 },
//   "testTone": { "enabled": true, "frequencyHz": 440, "amplitude": 0.5 }
// }
#include <cstdint>

#include <juce_audio_basics/juce_audio_basics.h>
#include <juce_core/juce_core.h>

namespace terminator
{

struct RenderSpec
{
    double sampleRate = 48000.0;
    int blockSize = 512;
    int numChannels = 2;
    double lengthSeconds = 1.0;
    float masterGain = 1.0f;
    bool testToneEnabled = false;
    float testToneFrequencyHz = 440.0f;
    float testToneAmplitude = 0.5f;

    std::int64_t totalSamples() const noexcept { return static_cast<std::int64_t>(lengthSeconds * sampleRate + 0.5); }
};

struct RenderResult
{
    juce::AudioBuffer<float> buffer; // numChannels × totalSamples
    std::uint64_t blocksProcessed = 0;
    double sampleRate = 0.0;
};

/// Parses a project v0 JSON value. On failure returns false and fills `error`. Missing fields keep defaults.
bool parseRenderSpec(const juce::var& json, RenderSpec& out, juce::String& error);
bool parseRenderSpecFromText(const juce::String& text, RenderSpec& out, juce::String& error);

/// Drives an Engine through prepare → process×N → release and returns the rendered audio.
RenderResult renderOffline(const RenderSpec& spec);

/// Writes a PCM WAV (bitDepth 16/24/32; 32 = float). Returns false and fills `error` on failure.
bool writeWav(const juce::File& file, const juce::AudioBuffer<float>& buffer, double sampleRate, int bitDepth,
              juce::String& error);

} // namespace terminator
