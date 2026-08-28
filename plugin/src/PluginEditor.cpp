#include "PluginEditor.h"

namespace terminator::app
{

TerminatorEditor::TerminatorEditor(TerminatorProcessor& p) : juce::AudioProcessorEditor(&p)
{
    // "The host owns the audio" is what the shell is told, so Preferences → AUDIO says so rather than offering
    // a device picker that would do nothing here.
    shell_ = std::make_unique<WebShell>(p.engine(), p.audioIO(), p.midi(), p.samples(), p.loader(), p.settings(),
                                        "the host owns the audio in a plugin");
    addAndMakeVisible(*shell_);
    setResizable(true, true);
    setResizeLimits(900, 600, 4096, 2600);
    setSize(1440, 900);
}

TerminatorEditor::~TerminatorEditor() = default;

void TerminatorEditor::resized()
{
    shell_->setBounds(getLocalBounds());
}

} // namespace terminator::app
