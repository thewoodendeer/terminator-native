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
    /// Normally one instance only — but a PLUGIN SCAN child (Windows: see the bottom of this file) is this same
    /// binary, and a second instance that hands its command line to the first would scan nothing at all.
    bool moreThanOneInstanceAllowed() override { return getCommandLineParameters().contains("--scan-plugin"); }

    void initialise(const juce::String& commandLine) override
    {
        // The scan child, for the platforms where JUCE owns the entry point (Windows' WinMain). On macOS `main()`
        // below catches it BEFORE any of this, which is where it belongs — see the note there.
        const auto args = getCommandLineParameterArray();
        const int scanAt = args.indexOf("--scan-plugin");
        if (scanAt >= 0 && args.size() > scanAt + 2)
        {
            PluginHub::runChildScan(args[scanAt + 1], args[scanAt + 2]);
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

// THE PLUGIN SCAN CHILD (Phase 6.1/6.2) does not become an app where we own the entry point.
//
// It used to everywhere: the scan branch lived in `initialise()`, so every child booted a full JUCE GUI
// application and made itself an NSApplication — a scanner has no business owning windows, an activation policy
// or a Dock icon. On macOS `main()` forks the road before JUCE's app machinery starts: the child brings up only
// the message manager the plugin formats need, keeps itself out of the Dock, prints the descriptions and returns.
// On Windows JUCE owns the entry point (WinMain, because this is a GUI subsystem app), so the child there takes
// the `initialise()` path above — Windows has no activation policy to get wrong.
#if JUCE_WINDOWS
START_JUCE_APPLICATION(terminator::app::TerminatorApplication)
#else
juce::JUCEApplicationBase* juce_CreateApplication();
juce::JUCEApplicationBase* juce_CreateApplication() { return new terminator::app::TerminatorApplication(); }

int main(int argc, char* argv[])
{
    for (int i = 1; i + 2 < argc; ++i)
    {
        if (juce::String(argv[i]) != "--scan-plugin")
            continue;
        juce::ScopedJuceInitialiser_GUI juceInit; // the message manager the plugin formats need, and nothing more
        juce::Process::setDockIconVisible(false); // …and it never appears, never activates, never steals a window
        terminator::app::PluginHub::runChildScan(juce::String::fromUTF8(argv[i + 1]),
                                                 juce::String::fromUTF8(argv[i + 2]));
        return 0;
    }
    juce::JUCEApplicationBase::createInstance = &juce_CreateApplication;
    return juce::JUCEApplicationBase::main(argc, const_cast<const char**>(argv));
}
#endif
