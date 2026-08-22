#include "MainWindow.h"

#include "WebShell.h"

namespace terminator::app
{

MainWindow::MainWindow(const juce::String& name)
    : juce::DocumentWindow(name, juce::Colours::black, juce::DocumentWindow::allButtons)
{
    setUsingNativeTitleBar(true);

    // Phase 0: default output device, no inputs (so no mic prompt yet). Errors land in the page status.
    const auto audioError = audioIO_.open(0, 2);

    shell_ = std::make_unique<WebShell>(engine_, audioIO_, audioError);
    setContentNonOwned(shell_.get(), true);

    setResizable(true, false);
    setResizeLimits(640, 400, 10000, 10000);
    centreWithSize(1100, 720);
    setVisible(true);
}

MainWindow::~MainWindow()
{
    shell_ = nullptr;
    audioIO_.close();
}

void MainWindow::closeButtonPressed()
{
    juce::JUCEApplication::getInstance()->systemRequestedQuit();
}

} // namespace terminator::app
