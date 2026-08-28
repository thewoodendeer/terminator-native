#pragma once
// TerminatorEditor — the app's own WebView shell, in a plugin window. The UI is not a second implementation:
// it is the same `WebShell` the standalone window hosts, over the same bridge.
#include <juce_audio_processors/juce_audio_processors.h>

#include "PluginProcessor.h"
#include "WebShell.h"

namespace terminator::app
{

class TerminatorEditor final : public juce::AudioProcessorEditor
{
  public:
    explicit TerminatorEditor(TerminatorProcessor&);
    ~TerminatorEditor() override;

    void resized() override;

  private:
    std::unique_ptr<WebShell> shell_;

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR(TerminatorEditor)
};

} // namespace terminator::app
