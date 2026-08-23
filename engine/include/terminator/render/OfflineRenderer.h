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
#include "terminator/core/Mixer.h"
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

/// One insert in an exported chain: the device and the params it is carrying (by the type's param INDEX, the same
/// order FxPool publishes). Anything not listed keeps the device's default.
struct RenderFxSpec
{
    FxType type = FxType::none;
    bool bypass = false;
    std::vector<std::pair<int, float>> params;
};

/// One strip of the exported mix — the same settings the live mixer is running.
struct RenderStripSpec
{
    int index = 0;
    StripKind kind = StripKind::channel;
    std::uint32_t seed = 0; // the CONSOLE seed (FNV-1a of the page's strip name); 0 = leave
    float faderDb = 0.0f;
    float pan = 0.0f;
    float width = 1.0f;
    bool mute = false;
    bool solo = false;
    float sendDb[kMaxSends] = {kFaderMinDb, kFaderMinDb, kFaderMinDb, kFaderMinDb};
    int sendTarget[kMaxSends] = {-1, -1, -1, -1};
    StripOutput outKind = StripOutput::master;
    int outIndex = 0;
    std::vector<RenderFxSpec> fx;
    /// TRACKOUTS: also copy this strip's output to this hardware pair (−1 = not a stem). Pair 0 is the master's, so
    /// stems start at pair 1 and `numChannels` must cover them.
    int stemTap = -1;
};

/// The mixer for an export (Phase 4.5). `enabled` false = the Phase-3 direct path: pads go straight to their output
/// pair and nothing else runs, which is what every pre-4.5 render did and still does.
struct RenderMixerSpec
{
    bool enabled = false;
    bool consoleOn = false;
    ConsoleFlavour consoleFlavour = ConsoleFlavour::ssl;
    float consoleAmount = 50.0f;
    bool limiter = false; // the master's −1 dBFS safety limiter (the page always has it in)
    bool pdc = true;
    /// Drop each output pair's own latency off the head, so the master and every stem start on the SAME sample.
    /// Off = the raw render including the alignment delay (what a null test against the live engine wants).
    bool trimLatency = true;
    std::vector<RenderStripSpec> strips;
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
    RenderMixerSpec mixer;

    std::int64_t totalSamples() const noexcept { return static_cast<std::int64_t>(lengthSeconds * sampleRate + 0.5); }
};

struct RenderResult
{
    juce::AudioBuffer<float> buffer; // numChannels × totalSamples
    std::uint64_t blocksProcessed = 0;
    double sampleRate = 0.0;
    std::uint32_t voiceSteals = 0;
    /// Phase 4.5: how many samples were dropped off each output pair's head to align them (0 with no mixer / no
    /// latency / trimLatency off). Index = hardware pair.
    std::vector<int> pairLatency;
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
