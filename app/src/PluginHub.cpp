#include "PluginHub.h"

#include <iostream>

namespace terminator::app
{
namespace
{
constexpr int kChildTimeoutMs = 30000; // a plugin that has not answered in 30 s is not going to

juce::var descriptionVar(const juce::PluginDescription& d)
{
    auto* o = new juce::DynamicObject();
    o->setProperty("id", d.createIdentifierString());
    o->setProperty("name", d.name);
    o->setProperty("manufacturer", d.manufacturerName);
    o->setProperty("format", d.pluginFormatName);
    o->setProperty("category", d.category);
    o->setProperty("version", d.version);
    o->setProperty("isInstrument", d.isInstrument);
    o->setProperty("file", d.fileOrIdentifier);
    o->setProperty("numInputs", d.numInputChannels);
    o->setProperty("numOutputs", d.numOutputChannels);
    return juce::var(o);
}
} // namespace

// ---- the scan thread ---------------------------------------------------------------------------------------
// One child process per plugin. The thread walks the files each format reports, skips what is already known (unless
// this is a full rescan) and what is blocklisted, and hands each one to a child. Progress is pushed into a
// lock-free-enough queue the hub's timer drains on the message thread — the page never talks to this thread.
class PluginHub::ScanJob final : public juce::Thread
{
  public:
    ScanJob(juce::AudioPluginFormatManager& formats, const juce::KnownPluginList& known, juce::StringArray blocklist,
            juce::StringArray searchPaths, bool rescanAll)
        : juce::Thread("plugin scan"), formats_(formats), blocklist_(std::move(blocklist)),
          searchPaths_(std::move(searchPaths)), rescanAll_(rescanAll)
    {
        for (const auto& d : known.getTypes())
            alreadyKnown_.addIfNotAlreadyThere(d.fileOrIdentifier);
    }

    void run() override
    {
        juce::StringArray files;
        juce::Array<int> formatOf;
        for (int f = 0; f < formats_.getNumFormats(); ++f)
        {
            auto* format = formats_.getFormat(f);
            juce::FileSearchPath path;
            for (const auto& extra : searchPaths_)
                path.addIfNotAlreadyThere(juce::File(extra));
            if (path.getNumPaths() == 0 || !format->canScanForPlugins())
                path = format->getDefaultLocationsToSearch();
            else
                for (int i = 0; i < format->getDefaultLocationsToSearch().getNumPaths(); ++i)
                    path.addIfNotAlreadyThere(format->getDefaultLocationsToSearch()[i]);
            for (const auto& id : format->searchPathsForPlugins(path, true, true))
            {
                if (blocklist_.contains(id))
                    continue;
                if (!rescanAll_ && alreadyKnown_.contains(id))
                    continue;
                files.add(id);
                formatOf.add(f);
            }
        }
        total_ = files.size();
        for (int i = 0; i < files.size() && !threadShouldExit(); ++i)
        {
            const auto file = files[i];
            {
                const juce::ScopedLock sl(lock_);
                current_ = file;
                done_ = i;
            }
            scanOne(formats_.getFormat(formatOf[i])->getName(), file);
        }
        const juce::ScopedLock sl(lock_);
        done_ = files.size();
        finished_ = true;
    }

    /// One plugin, in its own process. Everything that can go wrong there is the child's problem.
    void scanOne(const juce::String& formatName, const juce::String& file)
    {
        juce::StringArray args;
        args.add(juce::File::getSpecialLocation(juce::File::currentExecutableFile).getFullPathName());
        args.add("--scan-plugin");
        args.add(formatName);
        args.add(file);
        juce::ChildProcess child;
        if (!child.start(args, juce::ChildProcess::wantStdOut))
        {
            const juce::ScopedLock sl(lock_);
            failed_.add(file);
            return;
        }
        const auto out = child.readAllProcessOutput();
        if (!child.waitForProcessToFinish(kChildTimeoutMs))
        {
            child.kill();
            const juce::ScopedLock sl(lock_);
            failed_.add(file);
            return;
        }
        if (child.getExitCode() != 0)
        {
            const juce::ScopedLock sl(lock_);
            failed_.add(file);
            return;
        }
        // The child prints the descriptions as one XML document (empty = "nothing here", which is not a failure:
        // a folder is full of files that are not plugins).
        if (auto xml = juce::parseXML(out.fromFirstOccurrenceOf("<", true, false)))
        {
            const juce::ScopedLock sl(lock_);
            for (auto* child2 : xml->getChildIterator())
            {
                juce::PluginDescription d;
                if (d.loadFromXml(*child2))
                    found_.add(d);
            }
        }
    }

    /// Message thread: take what has happened since the last call.
    struct Progress
    {
        int done = 0, total = 0;
        bool finished = false;
        juce::String current;
        juce::Array<juce::PluginDescription> found;
        juce::StringArray failed;
    };
    Progress take()
    {
        const juce::ScopedLock sl(lock_);
        Progress p;
        p.done = done_;
        p.total = total_;
        p.finished = finished_;
        p.current = current_;
        p.found.swapWith(found_);
        p.failed.swapWith(failed_);
        return p;
    }

  private:
    juce::AudioPluginFormatManager& formats_;
    juce::CriticalSection lock_;
    juce::StringArray blocklist_, searchPaths_, alreadyKnown_;
    bool rescanAll_ = false;
    int done_ = 0, total_ = 0;
    bool finished_ = false;
    juce::String current_;
    juce::Array<juce::PluginDescription> found_;
    juce::StringArray failed_;
};

// ---- the hub ------------------------------------------------------------------------------------------------
PluginHub::PluginHub(const juce::File& stateFile) : stateFile_(stateFile)
{
    juce::addDefaultFormatsToManager(formats_); // VST3 everywhere, AudioUnit on macOS (JUCE 9: the UI-capable list)
    load();
}

PluginHub::~PluginHub()
{
    stopTimer();
    if (scan_ != nullptr)
    {
        scan_->signalThreadShouldExit();
        scan_->stopThread(2000);
    }
}

void PluginHub::load()
{
    if (!stateFile_.existsAsFile())
        return;
    if (auto xml = juce::parseXML(stateFile_))
    {
        // `KnownPluginList::createXml()` makes its OWN <KNOWNPLUGINS> element and we keep it inside a <KNOWN>
        // wrapper — so the list to restore is that wrapper's CHILD. Handing recreateFromXml the wrapper itself is
        // silent: it finds no plugins, reports nothing, and every launch starts with an empty list. (It did.)
        if (auto* wrapper = xml->getChildByName("KNOWN"))
            if (auto* list = wrapper->getFirstChildElement())
                known_.recreateFromXml(*list);
        if (auto* blocked = xml->getChildByName("BLOCKLIST"))
            for (auto* f : blocked->getChildIterator())
                blocklist_.addIfNotAlreadyThere(f->getStringAttribute("file"));
        if (auto* fold = xml->getChildByName("FOLDERS"))
            for (auto* f : fold->getChildIterator())
                folders_.addIfNotAlreadyThere(f->getStringAttribute("path"));
    }
}

void PluginHub::save()
{
    juce::XmlElement root("TERMINATORPLUGINS");
    {
        auto known = known_.createXml();
        auto* wrapper = root.createNewChildElement("KNOWN");
        if (known != nullptr)
            wrapper->addChildElement(known.release());
    }
    auto* blocked = root.createNewChildElement("BLOCKLIST");
    for (const auto& f : blocklist_)
        blocked->createNewChildElement("FILE")->setAttribute("file", f);
    auto* fold = root.createNewChildElement("FOLDERS");
    for (const auto& f : folders_)
        fold->createNewChildElement("FOLDER")->setAttribute("path", f);
    stateFile_.getParentDirectory().createDirectory();
    root.writeTo(stateFile_);
}

juce::StringArray PluginHub::searchPaths() const
{
    return folders_;
}

juce::var PluginHub::listVar() const
{
    auto* o = new juce::DynamicObject();
    juce::Array<juce::var> plugins;
    for (const auto& d : known_.getTypes())
        plugins.add(descriptionVar(d));
    o->setProperty("plugins", plugins);
    juce::Array<juce::var> blocked;
    for (const auto& f : blocklist_)
        blocked.add(f);
    o->setProperty("blocklist", blocked);
    juce::Array<juce::var> fold;
    for (const auto& f : folders_)
        fold.add(f);
    o->setProperty("folders", fold);
    juce::Array<juce::var> formats;
    for (int i = 0; i < formats_.getNumFormats(); ++i)
        formats.add(formats_.getFormat(i)->getName());
    o->setProperty("formats", formats);
    o->setProperty("scanning", scan_ != nullptr);
    o->setProperty("ok", true);
    return juce::var(o);
}

juce::var PluginHub::handle(const juce::var& req)
{
    const auto verb = req.getProperty("verb", "list").toString();
    if (verb == "scan")
    {
        if (scan_ != nullptr)
            return listVar(); // already running
        if (auto* extra = req.getProperty("folders", juce::var()).getArray())
        {
            folders_.clear();
            for (const auto& f : *extra)
                folders_.addIfNotAlreadyThere(f.toString());
            save();
        }
        const bool rescanAll = static_cast<bool>(req.getProperty("rescanAll", false));
        if (rescanAll)
            blocklist_.clear(); // a full rescan is also the "try the ones that failed again" button
        scan_ = std::make_unique<ScanJob>(formats_, known_, blocklist_, searchPaths(), rescanAll);
        scan_->startThread(juce::Thread::Priority::low);
        startTimer(200);
        return listVar();
    }
    if (verb == "scanFile")
    {
        // ONE file, through the same child process the full scan uses (the probe's end-to-end check, and the
        // "I know exactly where it is" path for a plugin the folder walk missed).
        const auto file = req.getProperty("file", "").toString();
        const auto formatName = req.getProperty("format", "").toString();
        auto* o = new juce::DynamicObject();
        int added = 0;
        for (int f = 0; f < formats_.getNumFormats(); ++f)
        {
            auto* format = formats_.getFormat(f);
            if (formatName.isNotEmpty() && format->getName() != formatName)
                continue;
            ScanJob one(formats_, known_, {}, {}, true);
            one.scanOne(format->getName(), file);
            auto p = one.take();
            for (const auto& d : p.found)
            {
                known_.addType(d);
                ++added;
            }
            if (added > 0)
                break;
        }
        if (added > 0)
            save();
        o->setProperty("ok", true);
        o->setProperty("added", added);
        o->setProperty("known", known_.getNumTypes());
        return juce::var(o);
    }
    if (verb == "cancelScan")
    {
        if (scan_ != nullptr)
        {
            scan_->signalThreadShouldExit();
            scan_->stopThread(2000);
            scan_ = nullptr;
            stopTimer();
            save();
        }
        return listVar();
    }
    if (verb == "remove")
    {
        const auto id = req.getProperty("id", "").toString();
        for (const auto& d : known_.getTypes())
            if (d.createIdentifierString() == id)
            {
                known_.removeType(d);
                break;
            }
        save();
        return listVar();
    }
    if (verb == "clearBlocklist")
    {
        blocklist_.clear();
        save();
        return listVar();
    }
    if (verb == "setFolders")
    {
        folders_.clear();
        if (auto* extra = req.getProperty("folders", juce::var()).getArray())
            for (const auto& f : *extra)
                folders_.addIfNotAlreadyThere(f.toString());
        save();
        return listVar();
    }
    return listVar();
}

void PluginHub::timerCallback()
{
    if (scan_ == nullptr)
        return stopTimer();
    auto p = scan_->take();
    for (const auto& d : p.found)
        known_.addType(d);
    for (const auto& f : p.failed)
        blocklist_.addIfNotAlreadyThere(f);
    if (!p.found.isEmpty() || !p.failed.isEmpty())
        save();
    auto* o = new juce::DynamicObject();
    o->setProperty("done", p.done);
    o->setProperty("total", p.total);
    o->setProperty("current", p.current);
    o->setProperty("found", static_cast<int>(known_.getNumTypes()));
    o->setProperty("finished", p.finished);
    if (onEvent)
        onEvent("terminator.pluginScan", juce::var(o));
    if (p.finished)
    {
        scan_->stopThread(2000);
        scan_ = nullptr;
        stopTimer();
        save();
    }
}

juce::PluginDescription PluginHub::describe(const juce::String& id) const
{
    for (const auto& d : known_.getTypes())
        if (d.createIdentifierString() == id)
            return d;
    return {};
}

std::unique_ptr<juce::AudioPluginInstance> PluginHub::create(const juce::String& id, double sampleRate, int blockSize,
                                                             juce::String& error)
{
    const auto d = describe(id);
    if (d.name.isEmpty())
    {
        error = "unknown plugin '" + id + "'";
        return nullptr;
    }
    return formats_.createPluginInstance(d, sampleRate, blockSize, error);
}

bool PluginHub::runChildScan(const juce::String& formatName, const juce::String& fileOrIdentifier)
{
    juce::AudioPluginFormatManager formats;
    juce::addDefaultFormatsToManager(formats);
    juce::XmlElement root("PLUGINS");
    for (int i = 0; i < formats.getNumFormats(); ++i)
    {
        auto* format = formats.getFormat(i);
        if (format->getName() != formatName)
            continue;
        juce::OwnedArray<juce::PluginDescription> found;
        format->findAllTypesForFile(found, fileOrIdentifier);
        for (auto* d : found)
            if (auto xml = d->createXml())
                root.addChildElement(xml.release());
    }
    std::cout << root.toString() << std::endl;
    return true;
}

} // namespace terminator::app
