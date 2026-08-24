#pragma once
// THE MENU (Phase 8.6). Until now Terminator 3.0 had no menu bar at all: no ⌘S, no ⌘O, no Recent, and
// `ipc.onShortcut` — the contract the page has always used for the Electron menu — was a stub that did nothing.
//
// Every item FORWARDS to the page rather than doing anything itself. The page owns projects, exports and the
// layout, and it already has handlers for exactly these keys (`onShortcut('new' | 'open' | 'savePreset' |
// 'saveAs' | 'export' | 'rearrange' | 'resetLayout' | 'playStop')`), so the menu is a second way in, never a
// second implementation. It matters on macOS for another reason too: a menu key equivalent is handled BEFORE the
// WebView sees the keystroke, so an item that did its own thing would silently take the shortcut away from the
// page.
#include <functional>

#include <juce_gui_basics/juce_gui_basics.h>

namespace terminator::app
{

class AppMenu final : public juce::MenuBarModel, public juce::ApplicationCommandTarget
{
  public:
    /// `onCommand(key)` = the page's `onShortcut` key; `onOpenRecent(path)` = a file from the Recent submenu.
    AppMenu(std::function<void(const juce::String&)> onCommand, std::function<void(const juce::String&)> onOpenRecent,
            std::function<juce::StringArray()> recentFiles, std::function<void()> onPreferences);
    ~AppMenu() override;

    /// The manager owns the KEY EQUIVALENTS (⌘S and friends). On macOS a menu key equivalent is handled before the
    /// WebView ever sees the keystroke, so these are the app's shortcuts, not the page's.
    void attachTo(juce::ApplicationCommandManager& manager);

    juce::StringArray getMenuBarNames() override;
    juce::PopupMenu getMenuForIndex(int index, const juce::String& name) override;
    void menuItemSelected(int itemId, int topLevelIndex) override;

    // ApplicationCommandTarget
    juce::ApplicationCommandTarget* getNextCommandTarget() override { return nullptr; }
    void getAllCommands(juce::Array<juce::CommandID>& commands) override;
    void getCommandInfo(juce::CommandID id, juce::ApplicationCommandInfo& info) override;
    bool perform(const InvocationInfo& info) override;

  private:
    std::function<void(const juce::String&)> onCommand_, onOpenRecent_;
    std::function<juce::StringArray()> recentFiles_;
    std::function<void()> onPreferences_;
    juce::StringArray recentSnapshot_;                   // the last Recent submenu, so an id maps back to a path
    juce::ApplicationCommandManager* manager_ = nullptr; // set by attachTo (the key equivalents live there)
};

} // namespace terminator::app
