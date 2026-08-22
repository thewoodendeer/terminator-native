#include <juce_gui_extra/juce_gui_extra.h>

#include "MainWindow.h"
#include "terminator/Version.h"

namespace terminator::app
{

class TerminatorApplication final : public juce::JUCEApplication
{
  public:
    const juce::String getApplicationName() override { return "Terminator"; }
    const juce::String getApplicationVersion() override { return terminator::versionString(); }
    bool moreThanOneInstanceAllowed() override { return false; }

    void initialise(const juce::String&) override { mainWindow_ = std::make_unique<MainWindow>(getApplicationName()); }
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
