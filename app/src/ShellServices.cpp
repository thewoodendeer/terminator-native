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

juce::File ShellServices::bundledDrumsDir()
{
    // An explicit override first — the app probe points this at a folder it fills itself, and it is the escape
    // hatch for a build whose drums were not provisioned. `std::getenv` is a build error under MSVC (/WX).
    const auto env = juce::SystemStats::getEnvironmentVariable("TERMINATOR_DRUMS_DIR", {});
    if (env.isNotEmpty())
    {
        const juce::File d(juce::File::isAbsolutePath(env)
                               ? juce::File(env)
                               : juce::File::getCurrentWorkingDirectory().getChildFile(env));
        return d.isDirectory() ? d : juce::File();
    }
    // Beside THIS BINARY (see WebShell::resolveUiDir): in a plugin the running application is the host.
    const auto exe = juce::File::getSpecialLocation(juce::File::currentExecutableFile);
#if JUCE_MAC
    const juce::File candidates[] = {
        exe.getParentDirectory().getParentDirectory().getChildFile("Resources").getChildFile("drums-flac"),
        juce::File::getSpecialLocation(juce::File::currentApplicationFile)
            .getChildFile("Contents")
            .getChildFile("Resources")
            .getChildFile("drums-flac"),
    };
#else
    const juce::File candidates[] = {exe.getParentDirectory().getChildFile("drums-flac"),
                                     exe.getParentDirectory().getChildFile("Resources").getChildFile("drums-flac")};
#endif
    for (const auto& d : candidates)
        if (d.isDirectory())
            return d;
    return {};
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
    put(o, "temp", juce::File::getSpecialLocation(juce::File::tempDirectory).getFullPathName());
    put(o, "sep", juce::String(juce::File::getSeparatorString()));
    // The bundled drum library — an empty string when this build ships none (the page then reads drums off R2,
    // and Preferences leaves the chip off rather than showing a dishonest 0 B).
    put(o, "drumsBundledDir", bundledDrumsDir().getFullPathName());
    return o;
}

juce::String ShellServices::bootUserScript(const juce::String& version) const
{
    auto o = obj();
    put(o, "version", version);
    put(o, "settings", appSettings());
    put(o, "dirs", dirsVar());
    // NOT `__TERMINATOR_NATIVE__`: that name is Vite's build-time boolean flag, and the DEV SERVER assigns it as a
    // real global — which overwrote this payload with `true` and broke every TERMINATOR_UI_URL run (see
    // docs/native/STATUS.md "the dev-server loop").
    return "window.__TERMINATOR_BOOT__ = " + juce::JSON::toString(o, true) + ";";
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
        complete(maybeLarge(o));
        return;
    }
    if (verb == "readBinary") // the file's bytes through the resource provider: {ok, url:"/blob/<token>", bytes, name}
    {
        const auto f = fileFromVar(req.getProperty("path", juce::var()));
        if (!f.existsAsFile())
        {
            complete(ok(false, "no such file"));
            return;
        }
        if (f.getSize() > 2LL * 1024 * 1024 * 1024)
        {
            complete(ok(false, "file too large"));
            return;
        }
        const auto token = stash({.file = f, .mime = "application/octet-stream"});
        auto o = ok(true);
        put(o, "url", "/blob/" + token);
        put(o, "bytes", static_cast<juce::int64>(f.getSize()));
        put(o, "path", f.getFullPathName());
        put(o, "name", f.getFileName());
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
                put(o, "createdAt", static_cast<juce::int64>(f.getCreationTime().toMilliseconds()));
                entries.add(o);
            }
        }
        auto o = ok(true);
        put(o, "entries", juce::var(entries));
        complete(maybeLarge(o));
        return;
    }
    if (verb == "du") // what a folder COSTS (Preferences → FOLDERS size chips) — the Electron dirSizeBytes rule
    {
        // Bounded and symlink-safe: a runaway tree stops counting and says so (`approx`) instead of hanging the
        // call. Follows no links, so a library pointing back at itself cannot loop.
        const auto d = fileFromVar(req.getProperty("path", juce::var()));
        std::int64_t bytes = 0;
        int seen = 0;
        bool approx = false;
        if (d.isDirectory())
        {
            for (const auto& e : juce::RangedDirectoryIterator(d, true, "*", juce::File::findFiles))
            {
                if (++seen > 200000)
                {
                    approx = true;
                    break;
                }
                const auto f = e.getFile();
                if (f.isSymbolicLink())
                    continue;
                bytes += f.getSize();
            }
        }
        auto o = ok(true);
        put(o, "bytes", static_cast<juce::int64>(bytes));
        put(o, "approx", approx);
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
    if (verb == "stat")
    {
        const auto f = fileFromVar(req.getProperty("path", juce::var()));
        auto o = ok(true);
        const bool exists = f != juce::File() && f.exists();
        put(o, "exists", exists);
        put(o, "isDir", exists && f.isDirectory());
        put(o, "isFile", exists && f.existsAsFile());
        put(o, "size", static_cast<juce::int64>(exists ? f.getSize() : 0));
        put(o, "modifiedAt", static_cast<juce::int64>(exists ? f.getLastModificationTime().toMilliseconds() : 0));
        put(o, "createdAt", static_cast<juce::int64>(exists ? f.getCreationTime().toMilliseconds() : 0));
        put(o, "path", f.getFullPathName());
        complete(o);
        return;
    }
    if (verb == "move") // rename / move a file or a whole folder (JUCE copies + deletes across volumes)
    {
        const auto from = fileFromVar(req.getProperty("from", juce::var()));
        const auto to = fileFromVar(req.getProperty("to", juce::var()));
        if (from == juce::File() || to == juce::File() || !from.exists())
        {
            complete(ok(false, "no such path"));
            return;
        }
        if (to.exists())
        {
            complete(ok(false, "destination exists"));
            return;
        }
        if (to.isAChildOf(from))
        {
            complete(ok(false, "cannot move a folder into itself"));
            return;
        }
        if (to.getParentDirectory().createDirectory().failed())
        {
            complete(ok(false, "cannot create folder"));
            return;
        }
        complete(from.moveFileTo(to) ? ok(true) : ok(false, "move failed"));
        return;
    }
    if (verb == "copy") // a file, or a folder recursively (dot-files skipped, like the Electron library did)
    {
        const auto from = fileFromVar(req.getProperty("from", juce::var()));
        const auto to = fileFromVar(req.getProperty("to", juce::var()));
        if (from == juce::File() || to == juce::File() || !from.exists())
        {
            complete(ok(false, "no such path"));
            return;
        }
        if (to.exists())
        {
            complete(ok(false, "destination exists"));
            return;
        }
        if (to.isAChildOf(from))
        {
            complete(ok(false, "cannot copy a folder into itself"));
            return;
        }
        if (to.getParentDirectory().createDirectory().failed())
        {
            complete(ok(false, "cannot create folder"));
            return;
        }
        std::function<bool(const juce::File&, const juce::File&)> copyRec = [&](const juce::File& src,
                                                                                const juce::File& dst) -> bool
        {
            if (src.isDirectory())
            {
                if (dst.createDirectory().failed())
                    return false;
                for (const auto& e :
                     juce::RangedDirectoryIterator(src, false, "*", juce::File::findFilesAndDirectories))
                {
                    const auto c = e.getFile();
                    if (c.getFileName().startsWithChar('.'))
                        continue;
                    if (!copyRec(c, dst.getChildFile(c.getFileName())))
                        return false;
                }
                return true;
            }
            return src.copyFileTo(dst);
        };
        complete(copyRec(from, to) ? ok(true) : ok(false, "copy failed"));
        return;
    }
    if (verb == "writeBinary") // base64 bytes → file (recordings, Finder drops — the page holds the bytes)
    {
        const auto f = fileFromVar(req.getProperty("path", juce::var()));
        if (f == juce::File())
        {
            complete(ok(false, "invalid path"));
            return;
        }
        juce::MemoryOutputStream raw;
        if (!juce::Base64::convertFromBase64(raw, req.getProperty("data", juce::var()).toString()))
        {
            complete(ok(false, "bad base64"));
            return;
        }
        if (f.getParentDirectory().createDirectory().failed())
        {
            complete(ok(false, "cannot create folder"));
            return;
        }
        const bool append = static_cast<bool>(req.getProperty("append", false));
        if (!append && f.exists() && !f.deleteFile())
        {
            complete(ok(false, "cannot replace file"));
            return;
        }
        juce::FileOutputStream out(f);
        if (out.failedToOpen() || !out.write(raw.getData(), raw.getDataSize()))
        {
            complete(ok(false, "write failed"));
            return;
        }
        out.flush();
        auto o = ok(true);
        put(o, "path", f.getFullPathName());
        put(o, "bytes", static_cast<juce::int64>(f.getSize()));
        complete(o);
        return;
    }
    if (verb == "openPath") // open a folder in Finder/Explorer (a file opens with its default app)
    {
        const auto f = fileFromVar(req.getProperty("path", juce::var()));
        if (f == juce::File() || !f.exists())
        {
            complete(ok(false, "no such path"));
            return;
        }
        complete(f.startAsProcess() ? ok(true) : ok(false, "could not open"));
        return;
    }
    if (verb == "serveRoots") // the page's library module registers what /lib/b64/ may serve
    {
        servableRoots_.clear();
        if (auto* arr = req.getProperty("roots", juce::var()).getArray())
            for (const auto& r : *arr)
            {
                const auto d = fileFromVar(r);
                if (d != juce::File())
                    servableRoots_.push_back(d);
            }
        auto o = ok(true);
        put(o, "count", static_cast<int>(servableRoots_.size()));
        complete(o);
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

juce::String ShellServices::stash(Blob blob)
{
    const auto now = juce::Time::currentTimeMillis();
    for (auto it = blobs_.begin(); it != blobs_.end();) // expire stale stashes (a page that never fetched)
        it = it->second.expiresMs < now ? blobs_.erase(it) : std::next(it);
    juce::String token;
    for (int i = 0; i < 4; ++i)
        token += juce::String::toHexString(blobRandom_.nextInt64());
    blob.expiresMs = now + 60'000;
    blobs_[token] = std::move(blob);
    return token;
}

juce::String ShellServices::stashBytes(std::vector<std::byte> bytes, const juce::String& mime)
{
    Blob blob;
    blob.binary = std::move(bytes);
    blob.mime = mime;
    return stash(std::move(blob));
}

juce::var ShellServices::maybeLarge(const juce::var& reply)
{
    const auto json = juce::JSON::toString(reply, true);
    if (json.length() <= kLargeReplyBytes)
        return reply;
    const auto bytes = json.length();
    const auto token = stash({.json = json, .mime = "application/json"});
    auto o = ok(true);
    put(o, "__largeReply", "/blob/" + token);
    put(o, "bytes", bytes);
    return o;
}

std::optional<ShellServices::BlobData> ShellServices::takeBlob(const juce::String& token)
{
    const auto it = blobs_.find(token);
    if (it == blobs_.end())
        return std::nullopt;
    auto blob = std::move(it->second);
    blobs_.erase(it);
    BlobData out;
    out.mime = blob.mime.isNotEmpty() ? blob.mime : "application/octet-stream";
    if (!blob.binary.empty())
    {
        out.bytes = std::move(blob.binary);
    }
    else if (blob.file != juce::File())
    {
        juce::MemoryBlock mb;
        if (!blob.file.loadFileAsData(mb))
            return std::nullopt;
        out.bytes.assign(static_cast<const std::byte*>(mb.getData()),
                         static_cast<const std::byte*>(mb.getData()) + mb.getSize());
    }
    else
    {
        const auto* utf8 = blob.json.toRawUTF8();
        const auto n = static_cast<std::size_t>(blob.json.getNumBytesAsUTF8());
        out.bytes.assign(reinterpret_cast<const std::byte*>(utf8), reinterpret_cast<const std::byte*>(utf8) + n);
    }
    return out;
}

bool ShellServices::mayServe(const juce::File& f) const
{
    if (f == juce::File() || !f.existsAsFile())
        return false;
    for (const auto& r : servableRoots_)
        if (f.isAChildOf(r))
            return true;
    return false;
}

} // namespace terminator::app
