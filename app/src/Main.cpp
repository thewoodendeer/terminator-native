#include <juce_gui_extra/juce_gui_extra.h>

#include "MainWindow.h"
#include "Perf.h"
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
        registerOsAssociations();
        mainWindow_ = std::make_unique<MainWindow>(getApplicationName());
        perf::mark(perf::Mark::window); // the window exists — the first thing a user can see
        // A COLD START: the OS launched us *because* of a `terminator://auth?…` link or a double-clicked
        // project, so it arrives on the command line (Windows) or was queued before the window existed
        // (macOS). Deliver it now that there is something to deliver it to.
        deliverOpenRequest(commandLine);
        if (pendingOpen_.isNotEmpty())
        {
            const auto pending = pendingOpen_;
            pendingOpen_.clear();
            mainWindow_->handleOpenRequest(pending);
        }
    }

    void shutdown() override { mainWindow_ = nullptr; }
    void systemRequestedQuit() override { quit(); }
    /// A second launch — and how BOTH platforms hand over a `terminator://` link or a double-clicked project:
    /// macOS routes `application:openFile(s):` and the GetURL Apple Event here, Windows starts a second process
    /// whose command line carries the path or URL. The running instance owns the open project and the pending
    /// sign-in nonce, so the hand-over has to reach IT, never a new process.
    void anotherInstanceStarted(const juce::String& commandLine) override
    {
        deliverOpenRequest(commandLine);
        if (mainWindow_ != nullptr)
            mainWindow_->toFront(true);
    }

  private:
    /// WINDOWS ONLY: claim `terminator://` and the two project extensions for this executable under HKCU (no
    /// admin, no installer step — the same place electron-builder's NSIS script writes them). macOS learns both
    /// from the bundle's Info.plist instead (app/CMakeLists.txt), so there is nothing to do there. Cheap enough
    /// to re-assert on every launch, which also fixes the associations after the app is moved.
    static void registerOsAssociations()
    {
#if JUCE_WINDOWS
        const auto exe = juce::File::getSpecialLocation(juce::File::currentExecutableFile).getFullPathName();
        const auto open = juce::String("\"") + exe + "\" \"%1\"";
        const auto classes = juce::String("HKEY_CURRENT_USER\\Software\\Classes\\");

        juce::WindowsRegistry::setValue(classes + "terminator\\", "URL:Terminator Protocol");
        juce::WindowsRegistry::setValue(classes + "terminator\\URL Protocol", "");
        juce::WindowsRegistry::setValue(classes + "terminator\\shell\\open\\command\\", open);

        // .tproj / .tprojz → one ProgId each, so Explorer shows a real name and double-click opens THIS app.
        const auto assoc = [&](const char* ext, const char* progId, const char* label)
        {
            juce::WindowsRegistry::setValue(classes + ext + "\\", progId);
            juce::WindowsRegistry::setValue(classes + progId + "\\", label);
            juce::WindowsRegistry::setValue(classes + progId + "\\DefaultIcon\\", exe + ",0");
            juce::WindowsRegistry::setValue(classes + progId + "\\shell\\open\\command\\", open);
        };
        assoc(".tproj", "Terminator.Project", "Terminator Project");
        assoc(".tprojz", "Terminator.ProjectBundle", "Terminator Project Bundle");
#endif
    }

    /// Is this token something the app should OPEN? A `terminator://` link (the sign-in callback) or a project
    /// file the OS handed us (double-click in Finder / Explorer, or "open with").
    static bool isOpenable(const juce::String& t)
    {
        return t.startsWithIgnoreCase("terminator://") || t.endsWithIgnoreCase(".tproj") ||
               t.endsWithIgnoreCase(".tprojz");
    }

    /// Pull an openable token out of a command line / open-file / open-URL string and hand it to the window (or
    /// hold it until there is one — a COLD start arrives before `initialise()` has built anything).
    void deliverOpenRequest(const juce::String& text)
    {
        for (const auto& token : juce::StringArray::fromTokens(text, true))
        {
            const auto t = token.unquoted();
            if (!isOpenable(t))
                continue;
            if (mainWindow_ != nullptr)
                mainWindow_->handleOpenRequest(t);
            else
                pendingOpen_ = t; // the window is not up yet — initialise() delivers it
            return;
        }
    }

    juce::String pendingOpen_;
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
// Windows: JUCE owns the entry point, so the clock starts as the application object is constructed instead.
struct TerminatorPerfStart
{
    TerminatorPerfStart() { terminator::app::perf::start(); }
};
static TerminatorPerfStart terminatorPerfStart;
START_JUCE_APPLICATION(terminator::app::TerminatorApplication)
#else
juce::JUCEApplicationBase* juce_CreateApplication();
juce::JUCEApplicationBase* juce_CreateApplication()
{
    return new terminator::app::TerminatorApplication();
}

int main(int argc, char* argv[])
{
    terminator::app::perf::start(); // everything the probe reports about startup is measured from here
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
