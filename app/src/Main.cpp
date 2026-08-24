#include <juce_gui_extra/juce_gui_extra.h>

#include "MainWindow.h"
#include "PluginHub.h"
#include "terminator/Version.h"

namespace terminator::app
{

class TerminatorApplication final : public juce::JUCEApplication
{
  public:
    const juce::String getApplicationName() override { return "Terminator"; }
    const juce::String getApplicationVersion() override { return terminator::versionString(); }
    /// Normally one instance only — but the PLUGIN SCAN (Phase 6.1) relaunches this same binary once per plugin,
    /// and a second instance that hands its command line to the first would scan nothing at all.
    bool moreThanOneInstanceAllowed() override { return getCommandLineParameters().contains("--scan-plugin"); }

    void initialise(const juce::String& commandLine) override
    {
        // The child-process scanner: print this plugin's descriptions and quit before a window ever exists. A
        // plugin that crashes or hangs takes THIS process down, which is the whole point.
        const auto args = getCommandLineParameterArray();
        const int i = args.indexOf("--scan-plugin");
        if (i >= 0 && args.size() > i + 2)
        {
            PluginHub::runChildScan(args[i + 1], args[i + 2]);
            quit();
            return;
        }
        juce::ignoreUnused(commandLine);
        mainWindow_ = std::make_unique<MainWindow>(getApplicationName());
    }
    void shutdown() override { mainWindow_ = nullptr; }
    void systemRequestedQuit() override { quit(); }
    void anotherInstanceStarted(const juce::String&) override
    {
        if (mainWindow_ != nullptr)
            mainWindow_->toFront(true);
    }

  private:
    std::unique_ptr<MainWindow> mainWindow_;
};

} // namespace terminator::app

START_JUCE_APPLICATION(terminator::app::TerminatorApplication)
