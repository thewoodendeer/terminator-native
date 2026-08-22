#pragma once
#include <memory>

#include <juce_gui_extra/juce_gui_extra.h>

#include "terminator/core/Engine.h"
#include "terminator/io/AudioIO.h"

namespace terminator::app
{

class WebShell;

/// The one document window. Owns the engine, the audio device layer and the WebView shell.
class MainWindow final : public juce::DocumentWindow
{
  public:
    explicit MainWindow(const juce::String& name);
    ~MainWindow() override;

    void closeButtonPressed() override;

  private:
    Engine engine_;
    AudioIO audioIO_{engine_};
    std::unique_ptr<WebShell> shell_;

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR(MainWindow)
};

} // namespace terminator::app
