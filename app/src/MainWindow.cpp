#include "MainWindow.h"

#include "WebShell.h"

namespace terminator::app
{

MainWindow::MainWindow(const juce::String& name)
    : juce::DocumentWindow(name, juce::Colours::black, juce::DocumentWindow::allButtons)
{
    setUsingNativeTitleBar(true);
    settings_.load();

    // Audio: saved setup if any, else the default output device (0 inputs → no mic prompt on first run).
    juce::String audioError;
    const auto saved = settings_.get("audio");
    if (saved.isObject())
    {
        AudioIO::DeviceSetup s;
        s.deviceType = saved["deviceType"].toString();
        s.inputDevice = saved["inputDevice"].toString();
        s.outputDevice = saved["outputDevice"].toString();
        s.sampleRate = static_cast<double>(saved.getProperty("sampleRate", 0.0));
        s.bufferSize = static_cast<int>(saved.getProperty("bufferSize", 0));
        if (const auto* a = saved["inputChannels"].getArray())
            for (const auto& v : *a)
                s.inputChannels.push_back(static_cast<int>(v));
        if (const auto* a = saved["outputChannels"].getArray())
            for (const auto& v : *a)
                s.outputChannels.push_back(static_cast<int>(v));
        audioError = audioIO_.apply(s);
        if (audioError.isNotEmpty())
            audioError = audioIO_.openDefault(0, 2) +
                         (audioError.isNotEmpty() ? " (saved setup failed: " + audioError + ")" : "");
    }
    else
        audioError = audioIO_.openDefault(0, 2);

    // MIDI: every saved-enabled input (or all of them on first run)
    const auto midiSaved = settings_.get("midi.inputs");
    if (midiSaved.isObject())
    {
        for (const auto& p : midi_.inputs())
            if (static_cast<bool>(midiSaved.getProperty(p.identifier, false)))
                midi_.enableInput(p.identifier, true);
    }
    else
        midi_.enableAllInputs();

    shell_ = std::make_unique<WebShell>(engine_, audioIO_, midi_, samples_, loader_, settings_, audioError);
    setContentNonOwned(shell_.get(), true);

    // THE MENU (8.6). It does nothing itself: each item is the page's own `onShortcut` key, sent over the bridge,
    // so the menu and the keyboard run the same code. Recent comes from settings (`app.recentProjects`, the same
    // list the page writes).
    menu_ = std::make_unique<AppMenu>(
        [this](const juce::String& key)
        {
            if (shell_ != nullptr)
                shell_->menuCommand(key);
        },
        [this](const juce::String& path)
        {
            if (shell_ != nullptr)
                shell_->menuOpenRecent(path);
        },
        [this]
        {
            juce::StringArray out;
            if (const auto* arr = settings_.get("app.recentProjects").getArray())
                for (const auto& v : *arr)
                {
                    const auto path = v.isObject() ? v.getProperty("path", "").toString() : v.toString();
                    if (path.isNotEmpty())
                        out.add(path);
                }
            return out;
        },
        [this]
        {
            if (shell_ != nullptr)
                shell_->openPreferencesFromMenu();
        });
    menu_->attachTo(commands_);
    addKeyListener(commands_.getKeyMappings()); // Windows: the window carries the key equivalents
#if !JUCE_MAC
    setMenuBar(menu_.get());
#endif

    setResizable(true, false);
    setResizeLimits(720, 480, 10000, 10000);
    centreWithSize(1200, 800);
    setVisible(true);
}

MainWindow::~MainWindow()
{
#if !JUCE_MAC
    setMenuBar(nullptr);
#endif
    menu_ = nullptr;
    shell_ = nullptr;
    audioIO_.close();
}

void MainWindow::closeButtonPressed()
{
    juce::JUCEApplication::getInstance()->systemRequestedQuit();
}

} // namespace terminator::app
