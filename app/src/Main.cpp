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
        registerUrlScheme();
        mainWindow_ = std::make_unique<MainWindow>(getApplicationName());
        // A COLD-START deep link: the OS launched us *because* of `terminator://auth?…`, so the URL arrives on
        // the command line (Windows) or was queued before the window existed (macOS). Deliver it now that there
        // is something to deliver it to.
        deliverDeepLink(commandLine);
        if (pendingDeepLink_.isNotEmpty())
        {
            const auto url = pendingDeepLink_;
            pendingDeepLink_.clear();
            mainWindow_->handleDeepLink(url);
        }
    }

    void shutdown() override { mainWindow_ = nullptr; }
    void systemRequestedQuit() override { quit(); }
    /// A second launch — including how BOTH platforms hand over a `terminator://` link: macOS routes
    /// `application:openURLs:` here, Windows starts a second process whose command line carries the URL. The
    /// running instance owns the pending sign-in nonce, so the link has to reach IT, never a new process.
    void anotherInstanceStarted(const juce::String& commandLine) override
    {
        deliverDeepLink(commandLine);
        if (mainWindow_ != nullptr)
            mainWindow_->toFront(true);
    }

  private:
    /// WINDOWS ONLY: claim `terminator://` for this executable under HKCU (no admin, no installer step — the
    /// same place electron-builder's NSIS script writes it). macOS learns the scheme from the bundle's
    /// Info.plist instead (app/CMakeLists.txt), so there is nothing to do there. Cheap enough to re-assert on
    /// every launch, which also fixes the association after the app is moved.
    static void registerUrlScheme()
    {
#if JUCE_WINDOWS
        const auto exe = juce::File::getSpecialLocation(juce::File::currentExecutableFile).getFullPathName();
        const auto key = juce::String("HKEY_CURRENT_USER\\Software\\Classes\\terminator\\");
        juce::WindowsRegistry::setValue(key, "URL:Terminator Protocol");
        juce::WindowsRegistry::setValue(key + "URL Protocol", "");
        juce::WindowsRegistry::setValue(key + "shell\\open\\command\\", "\"" + exe + "\" \"%1\"");
#endif
    }

    /// Pull a `terminator://…` URL out of a command line / open-URL string and hand it to the window (or hold
    /// it until there is one).
    void deliverDeepLink(const juce::String& text)
    {
        for (const auto& token : juce::StringArray::fromTokens(text, true))
        {
            const auto t = token.unquoted();
            if (!t.startsWithIgnoreCase("terminator://"))
                continue;
            if (mainWindow_ != nullptr)
                mainWindow_->handleDeepLink(t);
            else
                pendingDeepLink_ = t; // the window is not up yet (cold start) — initialise() delivers it
            return;
        }
    }

    juce::String pendingDeepLink_;
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
juce::JUCEApplicationBase* juce_CreateApplication()
{
    return new terminator::app::TerminatorApplication();
}

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
