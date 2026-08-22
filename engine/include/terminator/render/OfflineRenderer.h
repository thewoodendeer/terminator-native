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
//   "testTone": { "enabled": true, "frequencyHz": 440, "amplitude": 0.5 },
//   "pads":     [ { "pad": 0, "file": "kick.wav", "startFrame": 0, "endFrame": 0, "pitch": 0, "fine": 0,
//                   "attack": 0.003, "release": 0, "gain": 1, "outputPair": 0, "mode": "oneshot|gate|loop",
//                   "reverse": false, "chokeGroup": -1, "interpolation": "hermite|linear" } ],
//   "events":   [ { "pad": 0, "time": 0.5, "velocity": 1.0, "type": "on|off|stop" } ]
// }
// File paths are resolved relative to the project file's directory (parseRenderSpecFromFile) or the CWD.
#include <cstdint>
#include <memory>
#include <vector>

#include <juce_audio_basics/juce_audio_basics.h>
#include <juce_core/juce_core.h>

#include "terminator/core/Command.h"
#include "terminator/core/SampleBuffer.h"

namespace terminator
{

struct RenderPadSpec
{
    juce::File file;
    std::int64_t startFrame = 0;
    std::int64_t endFrame = 0;
    PadParams params{};
    std::shared_ptr<SampleBuffer> sample; // filled by loadRenderSamples (or set directly by tests)
    // Optional pre-rendered crossfade LOOP (loop::renderCrossfadeLoop on the message side) + its steady bracket:
    // sent as setPadLoopBuffer after setPadSample. The spec keeps the buffer alive for the render.
    std::shared_ptr<SampleBuffer> loopSample;
    std::int64_t loopStart = 0;
    std::int64_t loopEnd = 0;
    // Optional stem planes (drums/bass/other/vocals, the sample's length/rate) + the pad's 4-bit mask: sent as
    // setPadStems after setPadSample. Mask 15 / no planes = nothing sent (the base buffer plays).
    std::shared_ptr<SampleBuffer> stems[4];
    std::uint8_t stemMask = 15;
};

struct RenderEvent
{
    enum class Type : std::uint8_t
    {
        on,
        off,
        stop
    };
    std::uint16_t pad = 0;
    double timeSec = 0.0;
    float velocity = 1.0f;
    Type type = Type::on;
};

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
    std::vector<RenderPadSpec> pads;
    std::vector<RenderEvent> events;

    std::int64_t totalSamples() const noexcept { return static_cast<std::int64_t>(lengthSeconds * sampleRate + 0.5); }
};

struct RenderResult
{
    juce::AudioBuffer<float> buffer; // numChannels × totalSamples
    std::uint64_t blocksProcessed = 0;
    double sampleRate = 0.0;
    std::uint32_t voiceSteals = 0;
};

/// Parses a project v0 JSON value. On failure returns false and fills `error`. Missing fields keep defaults.
/// `baseDir` resolves relative sample paths.
bool parseRenderSpec(const juce::var& json, RenderSpec& out, juce::String& error, const juce::File& baseDir = {});
bool parseRenderSpecFromText(const juce::String& text, RenderSpec& out, juce::String& error,
                             const juce::File& baseDir = {});
bool parseRenderSpecFromFile(const juce::File& projectFile, RenderSpec& out, juce::String& error);

/// Loads every pad's file into spec.pads[i].sample (skips pads that already have one). False + error on failure.
bool loadRenderSamples(RenderSpec& spec, juce::String& error);

/// Drives an Engine through prepare → process×N → release and returns the rendered audio. Events are placed
/// sample-accurately (triggerPadAtSample). Pads without a loaded sample are silent.
RenderResult renderOffline(const RenderSpec& spec);

/// Writes a PCM WAV (bitDepth 16/24/32; 32 = float). Returns false and fills `error` on failure.
bool writeWav(const juce::File& file, const juce::AudioBuffer<float>& buffer, double sampleRate, int bitDepth,
              juce::String& error);

} // namespace terminator
