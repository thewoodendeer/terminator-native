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
    bool moreThanOneInstanceAllowed() override { return false; }

    void initialise(const juce::String& commandLine) override
    {
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

// THE PLUGIN SCAN CHILD (Phase 6.1/6.2) never becomes an app.
//
// It used to: the scan branch lived in `initialise()`, so every child booted a full JUCE GUI application, made
// itself an NSApplication, and — measured, not guessed — the running Terminator's Preferences window was sent a
// CLOSE the moment a child came up (the probe caught it: `PrefsWindow::closeButtonPressed` right after each scan).
// A scanner has no business owning windows or an activation policy, so `main()` forks the road BEFORE JUCE's app
// machinery starts: the child brings up only the message manager it needs to load a plugin, prints the
// descriptions and returns.
juce::JUCEApplicationBase* juce_CreateApplication();
juce::JUCEApplicationBase* juce_CreateApplication()
{
    return new terminator::app::TerminatorApplication();
}

int main(int argc, char* argv[])
{
    for (int i = 1; i < argc; ++i)
    {
        if (juce::String(argv[i]) != "--scan-plugin" || i + 2 >= argc)
            continue;
        juce::ScopedJuceInitialiser_GUI juceInit; // the message manager the plugin formats need, and nothing more
        // …and it stays out of the way: no Dock icon, never the foreground app. On macOS `initialiseJuce_GUI`
        // does create an NSApplication, and a second activating instance of the same bundle is what sent the
        // running Terminator's Preferences window a close.
        juce::Process::setDockIconVisible(false);
        terminator::app::PluginHub::runChildScan(juce::String::fromUTF8(argv[i + 1]),
                                                 juce::String::fromUTF8(argv[i + 2]));
        return 0;
    }
    juce::JUCEApplicationBase::createInstance = &juce_CreateApplication;
    return juce::JUCEApplicationBase::main(argc, const_cast<const char**>(argv));
}
