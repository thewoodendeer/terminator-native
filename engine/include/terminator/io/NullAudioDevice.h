#pragma once
// NullAudioDevice — an audio device that exists so the ENGINE can be tested where there is no hardware.
//
// Half of this app's self-test only runs once the engine is prepared: the chop sequencer, the drum machine, the
// bass, the metronome and count-in, live record, the whole mixer and its PDC plan. CI runners have no audio
// device, so all of that was SKIPPED there — "green in CI" meant "never ran" (found 2026-08-25, when a mixer
// check that had been failing on a real machine for days turned out to be a bad gate nobody could see).
//
// This is a real `juce::AudioIODevice` that pulls blocks on its own high-priority thread, paced to WALL CLOCK at
// the chosen rate, and hands the engine silence in and throws its output away. Real-time pacing is the point:
// the cursor and drift checks compare the engine's sample clock against `performance.now()`, so a device that
// ran flat out would prove nothing.
//
// It is NEVER used by accident. `TERMINATOR_NULL_AUDIO=1` selects it outright; `=auto` registers it and falls
// back to it only when no real device would open. Unset (every user's app) and it does not exist.
#include <atomic>

#include <juce_audio_devices/juce_audio_devices.h>

namespace terminator
{

/// The device type to hand `AudioDeviceManager::addAudioDeviceType`. Name: "Offline".
class NullAudioDeviceType final : public juce::AudioIODeviceType
{
  public:
    static constexpr const char* kTypeName = "Offline";
    static constexpr const char* kDeviceName = "Offline (no hardware)";

    NullAudioDeviceType();

    void scanForDevices() override {}
    juce::StringArray getDeviceNames(bool wantInputNames = false) const override;
    int getDefaultDeviceIndex(bool forInput) const override;
    int getIndexOfDevice(juce::AudioIODevice* device, bool asInput) const override;
    bool hasSeparateInputsAndOutputs() const override { return false; }
    juce::AudioIODevice* createDevice(const juce::String& outputDeviceName,
                                      const juce::String& inputDeviceName) override;
};

/// How the app asked for it: off (the default), forced, or "only if nothing real opens".
enum class NullAudioMode
{
    off,
    autoFallback,
    forced
};
NullAudioMode nullAudioMode();

} // namespace terminator
