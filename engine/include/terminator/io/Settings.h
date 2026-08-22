#pragma once
// App settings as one JSON file (Preferences → AUDIO / MIDI / calibration). Message thread only.
// Location: <userApplicationDataDirectory>/Terminator3/settings.json (Phase 8 decides how the Electron
// settings file is imported; this is the native app's own file).
#include <juce_core/juce_core.h>

namespace terminator
{

class Settings
{
  public:
    static juce::File defaultFile();
    explicit Settings(juce::File file = defaultFile());

    bool load();       // false if missing/invalid (defaults kept)
    bool save() const; // writes atomically
    juce::var& root() noexcept { return root_; }
    const juce::var& root() const noexcept { return root_; }
    juce::File file() const { return file_; }

    // convenience: "audio.sampleRate"-style dotted paths
    juce::var get(const juce::String& path, const juce::var& fallback = {}) const;
    void set(const juce::String& path, const juce::var& value);

  private:
    juce::File file_;
    juce::var root_;
};

} // namespace terminator
