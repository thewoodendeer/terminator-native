#include "AppMenu.h"

namespace terminator::app
{
namespace
{
// Ids: 1.. fixed items, 1000.. the Recent files (index + 1000).
enum MenuId
{
    idNew = 1,
    idOpen,
    idSave,
    idSaveAs,
    idExport,
    idPreferences,
    idPlayStop,
    idRearrange,
    idResetLayout,
    idHelp,
    idRecentFirst = 1000
};
} // namespace

AppMenu::AppMenu(std::function<void(const juce::String&)> onCommand,
                 std::function<void(const juce::String&)> onOpenRecent, std::function<juce::StringArray()> recentFiles,
                 std::function<void()> onPreferences)
    : onCommand_(std::move(onCommand)), onOpenRecent_(std::move(onOpenRecent)), recentFiles_(std::move(recentFiles)),
      onPreferences_(std::move(onPreferences))
{
#if JUCE_MAC
    // On macOS the menu belongs to the APPLICATION, and Preferences belongs in the app menu with its own ⌘,
    // the app menu (with Preferences) is set in attachTo, once the manager knows the key equivalents
#endif
}

AppMenu::~AppMenu()
{
#if JUCE_MAC
    juce::MenuBarModel::setMacMainMenu(nullptr);
#endif
}

juce::StringArray AppMenu::getMenuBarNames()
{
    return {"File", "Transport", "View", "Help"};
}

void AppMenu::attachTo(juce::ApplicationCommandManager& manager)
{
    manager_ = &manager;
    manager.registerAllCommandsForTarget(this);
#if JUCE_MAC
    // On macOS the menu belongs to the APPLICATION, and Preferences belongs in the app menu with its own ⌘,
    juce::PopupMenu appMenu;
    appMenu.addCommandItem(manager_, idPreferences);
    juce::MenuBarModel::setMacMainMenu(this, &appMenu);
#endif
}

void AppMenu::getAllCommands(juce::Array<juce::CommandID>& commands)
{
    commands.addArray(
        {idNew, idOpen, idSave, idSaveAs, idExport, idPreferences, idPlayStop, idRearrange, idResetLayout, idHelp});
}

void AppMenu::getCommandInfo(juce::CommandID id, juce::ApplicationCommandInfo& info)
{
    const auto set = [&info](const char* name, const char* category, int keyCode, juce::ModifierKeys mods)
    {
        info.setInfo(name, name, category, 0);
        if (keyCode != 0)
            info.addDefaultKeypress(keyCode, mods);
    };
    const auto cmd = juce::ModifierKeys::commandModifier;
    const auto cmdShift = juce::ModifierKeys::commandModifier | juce::ModifierKeys::shiftModifier;
    switch (id)
    {
    case idNew:
        set("New Project", "File", 'N', cmd);
        break;
    case idOpen:
        set("Open Project...", "File", 'O', cmd);
        break;
    case idSave:
        set("Save Project", "File", 'S', cmd);
        break;
    case idSaveAs:
        set("Save Project As...", "File", 'S', cmdShift);
        break;
    case idExport:
        set("Export...", "File", 'E', cmd);
        break;
    case idPreferences:
        set("Preferences...", "File", ',', cmd);
        break;
    case idPlayStop: // SPACE belongs to the page (and to typing): no key equivalent here
        set("Play / Stop", "Transport", 0, {});
        break;
    case idRearrange:
        set("Rearrange Layout", "View", 0, {});
        break;
    case idResetLayout:
        set("Reset Layout", "View", 0, {});
        break;
    case idHelp:
        set("Terminator Help", "Help", juce::KeyPress::F1Key, {});
        break;
    default:
        break;
    }
}

bool AppMenu::perform(const InvocationInfo& info)
{
    menuItemSelected(static_cast<int>(info.commandID), 0);
    return true;
}

juce::PopupMenu AppMenu::getMenuForIndex(int index, const juce::String&)
{
    juce::PopupMenu m;
    if (index == 0)
    {
        m.addCommandItem(manager_, idNew);
        m.addCommandItem(manager_, idOpen);
        juce::PopupMenu recent;
        recentSnapshot_ = recentFiles_ ? recentFiles_() : juce::StringArray();
        for (int i = 0; i < recentSnapshot_.size() && i < 20; ++i)
            recent.addItem(idRecentFirst + i, juce::File(recentSnapshot_[i]).getFileNameWithoutExtension());
        m.addSubMenu("Open Recent", recent, !recentSnapshot_.isEmpty());
        m.addSeparator();
        m.addCommandItem(manager_, idSave);
        m.addCommandItem(manager_, idSaveAs);
        m.addSeparator();
        m.addCommandItem(manager_, idExport);
#if !JUCE_MAC
        m.addSeparator();
        m.addCommandItem(manager_, idPreferences);
#endif
    }
    else if (index == 1)
        m.addCommandItem(manager_, idPlayStop);
    else if (index == 2)
    {
        m.addCommandItem(manager_, idRearrange);
        m.addCommandItem(manager_, idResetLayout);
    }
    else if (index == 3)
        m.addCommandItem(manager_, idHelp);
    return m;
}

void AppMenu::menuItemSelected(int itemId, int)
{
    if (itemId >= idRecentFirst)
    {
        const int i = itemId - idRecentFirst;
        if (onOpenRecent_ && i >= 0 && i < recentSnapshot_.size())
            onOpenRecent_(recentSnapshot_[i]);
        return;
    }
    if (itemId == idPreferences)
    {
        if (onPreferences_)
            onPreferences_();
        return;
    }
    if (!onCommand_)
        return;
    switch (itemId)
    {
    case idNew:
        onCommand_("new");
        break;
    case idOpen:
        onCommand_("open");
        break;
    case idSave:
        onCommand_("savePreset");
        break;
    case idSaveAs:
        onCommand_("saveAs");
        break;
    case idExport:
        onCommand_("export");
        break;
    case idPlayStop:
        onCommand_("playStop");
        break;
    case idRearrange:
        onCommand_("rearrange");
        break;
    case idResetLayout:
        onCommand_("resetLayout");
        break;
    case idHelp:
        onCommand_("help");
        break;
    default:
        break;
    }
}

} // namespace terminator::app
