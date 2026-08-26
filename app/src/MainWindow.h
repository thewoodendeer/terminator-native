#pragma once
#include <memory>

#include <juce_gui_extra/juce_gui_extra.h>

#include "terminator/core/Engine.h"
#include "terminator/io/AudioIO.h"
#include "terminator/io/MidiHub.h"
#include "terminator/io/SampleLoader.h"
#include "terminator/io/SampleStore.h"
#include "terminator/io/Settings.h"

#include "AppMenu.h"
#include "Updater.h"

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

    /// Something the OS asked us to open: a `terminator://…` link (8.5, the browser sign-in callback) or a
    /// project file (8.6, a double-click in Finder / Explorer) → the shell. True when it was handled.
    bool handleOpenRequest(const juce::String& urlOrPath);

  private:
    Settings settings_;
    Engine engine_;
    AudioIO audioIO_{engine_};
    MidiHub midi_{engine_};
    SampleStore samples_;
    SampleLoader loader_;
    std::unique_ptr<WebShell> shell_;
    // THE MENU (8.6): every item forwards to the page, and the command manager owns the key equivalents.
    juce::ApplicationCommandManager commands_;
    std::unique_ptr<AppMenu> menu_;
    // THE UPDATER (9.1). Constructed before the menu, because whether it actually started is what decides
    // if the Check for Updates item exists at all.
    Updater updater_;

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR(MainWindow)
};

} // namespace terminator::app
