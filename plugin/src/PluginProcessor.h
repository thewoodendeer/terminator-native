#pragma once
// TerminatorProcessor — Terminator inside a DAW (Phase 11, FIRST STEP: a preview build).
//
// WHAT THIS IS. One `juce::AudioProcessor` that owns the same Engine the standalone app owns, driven by the
// HOST's `processBlock` instead of by an audio device, with the same React UI in its editor. It exists so
// Terminator can be SEEN inside Ableton — it is not the finished plugin.
//
// WHAT IT IS NOT, YET (all of it is Phase 11 proper):
//  - no HOST SYNC: the transport is Terminator's own, so its tempo and grid do not follow the host's;
//  - no PARAMETERS or automation, and no state saved with the host's project;
//  - one stereo bus out, no multi-out per pad/lane;
//  - MIDI reaches the pads through Terminator's own CoreMIDI inputs, not through the host's MIDI routing.
// The audio IS real: pads, drums, bass and the mixer render into the host's buffer, so a track records it.
#include <juce_audio_processors/juce_audio_processors.h>

#include "terminator/core/Engine.h"
#include "terminator/io/AudioIO.h"
#include "terminator/io/MidiHub.h"
#include "terminator/io/SampleLoader.h"
#include "terminator/io/SampleStore.h"
#include "terminator/io/Settings.h"

namespace terminator::app
{

class TerminatorProcessor final : public juce::AudioProcessor
{
  public:
    TerminatorProcessor();
    ~TerminatorProcessor() override;

    void prepareToPlay(double sampleRate, int maxBlockSize) override;
    void releaseResources() override;
    void processBlock(juce::AudioBuffer<float>&, juce::MidiBuffer&) override;
    bool isBusesLayoutSupported(const BusesLayout& layouts) const override;

    juce::AudioProcessorEditor* createEditor() override;
    bool hasEditor() const override { return true; }

    const juce::String getName() const override { return "Terminator"; }
    bool acceptsMidi() const override { return true; }
    bool producesMidi() const override { return false; }
    bool isMidiEffect() const override { return false; }
    double getTailLengthSeconds() const override { return 0.0; }

    int getNumPrograms() override { return 1; }
    int getCurrentProgram() override { return 0; }
    void setCurrentProgram(int) override {}
    const juce::String getProgramName(int) override { return "Terminator"; }
    void changeProgramName(int, const juce::String&) override {}

    /// Nothing yet — the project does not travel with the host's set (Phase 11.5).
    void getStateInformation(juce::MemoryBlock&) override {}
    void setStateInformation(const void*, int) override {}

    // The editor builds the shell over these.
    Engine& engine() { return engine_; }
    AudioIO& audioIO() { return audioIO_; }
    MidiHub& midi() { return midi_; }
    SampleStore& samples() { return samples_; }
    SampleLoader& loader() { return loader_; }
    Settings& settings() { return settings_; }

  private:
    Settings settings_;
    Engine engine_;
    /// Present because the shell asks it what device is open — and in a plugin the answer is "none, the host
    /// owns the audio". It is never opened here.
    AudioIO audioIO_{engine_};
    MidiHub midi_{engine_};
    SampleStore samples_;
    SampleLoader loader_;

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR(TerminatorProcessor)
};

} // namespace terminator::app
