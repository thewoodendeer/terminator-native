#pragma once
// Decodes audio files (WAV/AIFF/FLAC/Ogg + CoreAudio formats on Mac (MP3/AAC/M4A) + Windows Media on Windows)
// into SampleBuffers on the CALLING thread (the app uses a loader thread; the CLI/tests call it directly).
// Never resamples: the engine plays any rate (varispeed ratio handles sr differences) — B1 "removes the 44.1k
// assumption".
#include <memory>

#include <juce_audio_formats/juce_audio_formats.h>

#include "terminator/core/SampleBuffer.h"

namespace terminator
{

class SampleLoader
{
  public:
    SampleLoader();
    /// Returns nullptr and fills `error` on failure. `maxChannels` 0 = keep all.
    std::shared_ptr<SampleBuffer> load(const juce::File& file, juce::String& error, int maxChannels = 0);
    /// Decodes from memory (e.g. an embedded asset or a network pull).
    std::shared_ptr<SampleBuffer> loadFromData(const void* data, size_t bytes, juce::String& error,
                                               int maxChannels = 0);
    juce::String supportedExtensions() const; // "*.wav;*.flac;…" for file choosers
    juce::AudioFormatManager& formats() noexcept { return formats_; }

  private:
    std::shared_ptr<SampleBuffer> read(std::unique_ptr<juce::AudioFormatReader> reader, juce::String& error,
                                       int maxChannels);
    juce::AudioFormatManager formats_;
};

} // namespace terminator
