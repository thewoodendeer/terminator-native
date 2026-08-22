#include "ShellServices.h"

namespace terminator::app
{

namespace
{
juce::var obj()
{
    return juce::var(new juce::DynamicObject());
}
void put(juce::var& o, const char* k, const juce::var& v)
{
    o.getDynamicObject()->setProperty(k, v);
}
} // namespace

ShellServices::ShellServices(Settings& settings) : settings_(settings) {}

juce::var ShellServices::ok(bool okFlag, const juce::String& error)
{
    auto o = obj();
    put(o, "ok", okFlag);
    if (!okFlag)
        put(o, "error", error);
    return o;
}

juce::File ShellServices::fileFromVar(const juce::var& v)
{
    const auto s = v.toString();
    if (s.isEmpty() || s.length() > 4096)
        return {};
    if (!juce::File::isAbsolutePath(s))
        return {};
    return juce::File(s);
}

juce::File ShellServices::dataDir() const
{
    return settings_.file().getParentDirectory();
}

juce::var ShellServices::appSettings() const
{
    auto a = settings_.get("app");
    if (a.getDynamicObject() == nullptr)
        return obj();
    return a;
}

juce::File ShellServices::projectsDir() const
{
    const auto v = appSettings().getProperty("projectsDir", juce::var()).toString();
    if (v.isNotEmpty() && juce::File::isAbsolutePath(v))
        return juce::File(v);
    return dataDir().getChildFile("projects");
}

bool ShellServices::projectsDirIsDefault() const
{
    return projectsDir() == dataDir().getChildFile("projects");
}

juce::var ShellServices::dirsVar() const
{
    auto o = obj();
    put(o, "dataDir", dataDir().getFullPathName());
    put(o, "projectsDir", projectsDir().getFullPathName());
    put(o, "projectsIsDefault", projectsDirIsDefault());
    put(o, "settingsFile", settings_.file().getFullPathName());
    put(o, "home", juce::File::getSpecialLocation(juce::File::userHomeDirectory).getFullPathName());
    put(o, "music", juce::File::getSpecialLocation(juce::File::userMusicDirectory).getFullPathName());
    put(o, "sep", juce::String(juce::File::getSeparatorString()));
    return o;
}

juce::String ShellServices::bootUserScript(const juce::String& version) const
{
    auto o = obj();
    put(o, "version", version);
    put(o, "settings", appSettings());
    put(o, "dirs", dirsVar());
    return "window.__TERMINATOR_NATIVE__ = " + juce::JSON::toString(o, true) + ";";
}

juce::var ShellServices::handleSettings(const juce::var& req)
{
    const auto verb = req.getProperty("verb", "get").toString();
    if (verb == "get")
    {
        auto o = ok(true);
        put(o, "settings", appSettings());
        return o;
    }
    if (verb == "set")
    {
        const auto patch = req.getProperty("patch", juce::var());
        auto* po = patch.getDynamicObject();
        if (po == nullptr)
            return ok(false, "invalid settings patch");
        auto cur = appSettings();
        auto merged = cur.clone();
        for (const auto& kv : po->getProperties())
            merged.getDynamicObject()->setProperty(kv.name, kv.value);
        settings_.set("app", merged);
        settings_.save();
        if (onSettingsChanged)
            onSettingsChanged(merged);
        auto o = ok(true);
        put(o, "settings", merged);
        return o;
    }
    return ok(false, "unknown settings verb '" + verb + "'");
}

void ShellServices::handleFs(const juce::var& req, Completion complete)
{
    const auto verb = req.getProperty("verb", juce::var()).toString();
    if (verb == "dirs")
    {
        auto o = ok(true);
        const auto d = dirsVar(); // keep the var alive while iterating (the object is ref-counted by it)
        for (const auto& kv : d.getDynamicObject()->getProperties())
            o.getDynamicObject()->setProperty(kv.name, kv.value);
        complete(o);
        return;
    }
    if (verb == "readText")
    {
        const auto f = fileFromVar(req.getProperty("path", juce::var()));
        if (!f.existsAsFile())
        {
            complete(ok(false, "no such file"));
            return;
        }
        if (f.getSize() > 64 * 1024 * 1024)
        {
            complete(ok(false, "file too large"));
            return;
        }
        auto o = ok(true);
        put(o, "text", f.loadFileAsString());
        put(o, "path", f.getFullPathName());
        put(o, "name", f.getFileNameWithoutExtension());
        complete(o);
        return;
    }
    if (verb == "writeText")
    {
        const auto f = fileFromVar(req.getProperty("path", juce::var()));
        if (f == juce::File())
        {
            complete(ok(false, "invalid path"));
            return;
        }
        const auto text = req.getProperty("text", juce::var()).toString();
        if (f.getParentDirectory().createDirectory().failed())
        {
            complete(ok(false, "cannot create folder"));
            return;
        }
        juce::TemporaryFile tmp(f);
        if (!tmp.getFile().replaceWithText(text) || !tmp.overwriteTargetFileWithTemporary())
        {
            complete(ok(false, "write failed"));
            return;
        }
        auto o = ok(true);
        put(o, "path", f.getFullPathName());
        put(o, "name", f.getFileNameWithoutExtension());
        complete(o);
        return;
    }
    if (verb == "exists")
    {
        const auto f = fileFromVar(req.getProperty("path", juce::var()));
        auto o = ok(true);
        put(o, "exists", f != juce::File() && f.exists());
        put(o, "isDir", f != juce::File() && f.isDirectory());
        complete(o);
        return;
    }
    if (verb == "list")
    {
        const auto d = fileFromVar(req.getProperty("dir", juce::var()));
        juce::StringArray exts;
        if (auto* arr = req.getProperty("exts", juce::var()).getArray())
            for (const auto& e : *arr)
                exts.add(e.toString().toLowerCase());
        juce::Array<juce::var> entries;
        if (d.isDirectory())
        {
            for (const auto& e : juce::RangedDirectoryIterator(d, false, "*", juce::File::findFilesAndDirectories))
            {
                const auto f = e.getFile();
                if (f.getFileName().startsWithChar('.'))
                    continue;
                if (!exts.isEmpty() && !e.isDirectory() && !exts.contains(f.getFileExtension().toLowerCase()))
                    continue;
                auto o = obj();
                put(o, "name", f.getFileNameWithoutExtension());
                put(o, "fileName", f.getFileName());
                put(o, "path", f.getFullPathName());
                put(o, "isDir", e.isDirectory());
                put(o, "size", static_cast<juce::int64>(f.getSize()));
                put(o, "modifiedAt", static_cast<juce::int64>(f.getLastModificationTime().toMilliseconds()));
                entries.add(o);
            }
        }
        auto o = ok(true);
        put(o, "entries", juce::var(entries));
        complete(o);
        return;
    }
    if (verb == "mkdir")
    {
        const auto d = fileFromVar(req.getProperty("path", juce::var()));
        complete(d != juce::File() && d.createDirectory().wasOk() ? ok(true) : ok(false, "cannot create folder"));
        return;
    }
    if (verb == "trash")
    {
        const auto f = fileFromVar(req.getProperty("path", juce::var()));
        if (f == juce::File() || !f.exists())
        {
            complete(ok(true)); // already gone
            return;
        }
        complete(f.moveToTrash() ? ok(true) : ok(false, "could not move to Trash"));
        return;
    }
    if (verb == "reveal")
    {
        const auto f = fileFromVar(req.getProperty("path", juce::var()));
        if (f == juce::File() || !f.exists())
        {
            complete(ok(false, "no such path"));
            return;
        }
        f.revealToUser();
        complete(ok(true));
        return;
    }
    if (verb == "openExternal")
    {
        const auto url = req.getProperty("url", juce::var()).toString();
        if (!(url.startsWith("https://") || url.startsWith("http://") || url.startsWith("mailto:")))
        {
            complete(ok(false, "only http(s)/mailto links"));
            return;
        }
        complete(juce::URL(url).launchInDefaultBrowser() ? ok(true) : ok(false, "could not open"));
        return;
    }
    if (verb == "clipboardReadText")
    {
        auto o = ok(true);
        put(o, "text", juce::SystemClipboard::getTextFromClipboard());
        complete(o);
        return;
    }
    if (verb == "openDialog" || verb == "saveDialog")
    {
        if (chooser_ != nullptr)
        {
            complete(ok(false, "a dialog is already open"));
            return;
        }
        const auto title = req.getProperty("title", verb == "saveDialog" ? "Save" : "Open").toString();
        auto dir = fileFromVar(req.getProperty("dir", juce::var()));
        if (dir == juce::File() || !dir.isDirectory())
            dir = projectsDir();
        const auto filters = req.getProperty("filters", "*").toString(); // "*.tproj;*.tprojz"
        const auto mode = req.getProperty("mode", "file").toString();
        const auto defaultName = req.getProperty("defaultName", juce::var()).toString();
        const auto initial = (verb == "saveDialog" && defaultName.isNotEmpty()) ? dir.getChildFile(defaultName) : dir;
        chooser_ = std::make_unique<juce::FileChooser>(title, initial, filters);
        int flags = 0;
        if (verb == "saveDialog")
            flags = juce::FileBrowserComponent::saveMode | juce::FileBrowserComponent::canSelectFiles |
                    juce::FileBrowserComponent::warnAboutOverwriting;
        else if (mode == "dir")
            flags = juce::FileBrowserComponent::openMode | juce::FileBrowserComponent::canSelectDirectories;
        else
            flags = juce::FileBrowserComponent::openMode | juce::FileBrowserComponent::canSelectFiles |
                    (static_cast<bool>(req.getProperty("multiple", false))
                         ? juce::FileBrowserComponent::canSelectMultipleItems
                         : 0);
        chooser_->launchAsync(flags,
                              [this, complete](const juce::FileChooser& fc)
                              {
                                  const auto results = fc.getResults();
                                  auto o = ok(true);
                                  if (results.isEmpty())
                                      put(o, "cancelled", true);
                                  else
                                  {
                                      put(o, "path", results.getReference(0).getFullPathName());
                                      juce::Array<juce::var> paths;
                                      for (const auto& f : results)
                                          paths.add(f.getFullPathName());
                                      put(o, "paths", juce::var(paths));
                                  }
                                  complete(o);
                                  juce::MessageManager::callAsync([this] { chooser_ = nullptr; });
                              });
        return;
    }
    complete(ok(false, "unknown fs verb '" + verb + "'"));
}

} // namespace terminator::app
