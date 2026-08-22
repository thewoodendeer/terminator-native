#pragma once
#include <memory>

#include <juce_gui_extra/juce_gui_extra.h>

#include "terminator/core/Engine.h"
#include "terminator/io/AudioIO.h"
#include "terminator/io/MidiHub.h"
#include "terminator/io/SampleLoader.h"
#include "terminator/io/SampleStore.h"
#include "terminator/io/Settings.h"

namespace terminator::app
{

class WebShell;

/// The one document window. Owns the engine, the device layers, the sample store and the WebView shell.
class MainWindow final : public juce::DocumentWindow
{
  public:
    explicit MainWindow(const juce::String& name);
    ~MainWindow() override;

    void closeButtonPressed() override;

  private:
    Settings settings_;
    Engine engine_;
    AudioIO audioIO_{engine_};
    MidiHub midi_{engine_};
    SampleStore samples_;
    SampleLoader loader_;
    std::unique_ptr<WebShell> shell_;

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR(MainWindow)
};

} // namespace terminator::app
