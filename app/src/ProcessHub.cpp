#include "ProcessHub.h"

namespace terminator::app
{

namespace
{
constexpr int kChunkBytes = 8 * 1024; // per processOutput event (emitEvent's escape is quadratic — keep it small)

/// Reads a child's merged output until EOF, posting chunks + the exit to the message thread.
class Reader final : public juce::Thread
{
  public:
    Reader(juce::ChildProcess& proc, juce::String id, std::weak_ptr<bool> alive,
           std::function<void(const juce::String&, const juce::String&)> onOutput,
           std::function<void(const juce::String&, int)> onExit)
        : juce::Thread("yt-dlp reader"), proc_(proc), id_(std::move(id)), alive_(std::move(alive)),
          onOutput_(std::move(onOutput)), onExit_(std::move(onExit))
    {
    }
    void run() override
    {
        char buf[kChunkBytes];
        for (;;)
        {
            const int n = proc_.readProcessOutput(buf, kChunkBytes); // blocks; 0 = EOF (process gone)
            if (n <= 0)
                break;
            juce::String data = juce::String::fromUTF8(buf, n);
            post([this, data] { onOutput_(id_, data); });
        }
        const int code = static_cast<int>(proc_.getExitCode());
        post([this, code] { onExit_(id_, code); });
    }

  private:
    void post(std::function<void()> fn)
    {
        std::weak_ptr<bool> alive = alive_;
        juce::MessageManager::callAsync(
            [alive, fn = std::move(fn)]
            {
                if (auto a = alive.lock(); a && *a)
                    fn();
            });
    }
    juce::ChildProcess& proc_;
    juce::String id_;
    std::weak_ptr<bool> alive_;
    std::function<void(const juce::String&, const juce::String&)> onOutput_;
    std::function<void(const juce::String&, int)> onExit_;
};
} // namespace

struct ProcessHub::Job
{
    juce::String id;
    std::unique_ptr<juce::ChildProcess> proc = std::make_unique<juce::ChildProcess>();
    std::unique_ptr<Reader> reader;
    bool exited = false;
    ~Job()
    {
        if (proc != nullptr && proc->isRunning())
            proc->kill();
        if (reader != nullptr)
            reader->stopThread(4000);
    }
};

ProcessHub::ProcessHub(Emit emit) : emit_(std::move(emit)) {}

ProcessHub::~ProcessHub()
{
    *alive_ = false; // no more posts reach us
    jobs_.clear();   // kills + joins every child
}

juce::var ProcessHub::ok(bool okFlag, const juce::String& error)
{
    auto* o = new juce::DynamicObject();
    o->setProperty("ok", okFlag);
    if (!okFlag)
        o->setProperty("error", error);
    return juce::var(o);
}

juce::File ProcessHub::bundledBinDir()
{
#if JUCE_MAC
    return juce::File::getSpecialLocation(juce::File::currentApplicationFile)
        .getChildFile("Contents")
        .getChildFile("Resources")
        .getChildFile("bin");
#else
    return juce::File::getSpecialLocation(juce::File::currentExecutableFile).getParentDirectory().getChildFile("bin");
#endif
}

juce::File ProcessHub::ytdlpLauncher()
{
#if JUCE_WINDOWS
    const auto f = bundledBinDir().getChildFile("ytdlp").getChildFile("yt-dlp.exe");
#else
    const auto f = bundledBinDir().getChildFile("ytdlp").getChildFile("yt-dlp_macos");
#endif
    return f.existsAsFile() ? f : juce::File();
}

juce::File ProcessHub::qjsBinary()
{
#if JUCE_WINDOWS
    const auto f = bundledBinDir().getChildFile("qjs").getChildFile("qjs.exe");
#else
    const auto f = bundledBinDir().getChildFile("qjs").getChildFile("qjs");
#endif
    return f.existsAsFile() ? f : juce::File();
}

juce::var ProcessHub::handle(const juce::var& req)
{
    const auto verb = req.isObject() ? req.getProperty("verb", "list").toString() : juce::String("list");
    if (verb == "spawn")
        return spawn(req);
    if (verb == "kill")
        return kill(req);
    if (verb == "list")
        return list();
    if (verb == "tools")
        return tools();
    return ok(false, "unknown process verb '" + verb + "'");
}

juce::var ProcessHub::tools() const
{
    auto o = ok(true);
    auto* d = o.getDynamicObject();
    const auto y = ytdlpLauncher();
    const auto q = qjsBinary();
    d->setProperty("ytdlp", y.getFullPathName());
    d->setProperty("qjs", q.getFullPathName());
    d->setProperty("ytdlpDir", y != juce::File() ? y.getParentDirectory().getFullPathName() : juce::String());
    d->setProperty("qjsDir", q != juce::File() ? q.getParentDirectory().getFullPathName() : juce::String());
    d->setProperty("binDir", bundledBinDir().getFullPathName());
    return o;
}

juce::var ProcessHub::spawn(const juce::var& req)
{
    const auto id = req.getProperty("id", "").toString();
    if (id.isEmpty() || id.length() > 128)
        return ok(false, "spawn: id required");
    if (jobs_.count(id) != 0)
        return ok(false, "spawn: id '" + id + "' is in use");
    if (jobs_.size() >= 16)
        return ok(false, "spawn: too many processes");
    const auto tool = req.getProperty("tool", "").toString();
    juce::StringArray argv;
    if (tool == "ytdlp")
    {
        const auto y = ytdlpLauncher();
        if (y == juce::File())
            return ok(false, "yt-dlp is missing from this build");
        argv.add(y.getFullPathName());
        argv.add("--no-update"); // we ship it; it must never nag (the nag became the error text after 90 days)
        if (const auto q = qjsBinary(); q != juce::File())
        {
            // the bundled quickjs-ng solves YouTube's JS challenge; additive — a deno on the machine still ranks first
            argv.add("--js-runtimes");
            argv.add("quickjs:" + q.getParentDirectory().getFullPathName());
        }
    }
    else
        return ok(false, "spawn: unknown tool '" + tool + "' (only the bundled tools can run)");
    if (auto* args = req.getProperty("args", juce::var()).getArray())
    {
        if (args->size() > 256)
            return ok(false, "spawn: too many args");
        for (const auto& a : *args)
        {
            const auto s = a.toString();
            if (s.length() > 8192)
                return ok(false, "spawn: argument too long");
            argv.add(s);
        }
    }
    auto job = std::make_shared<Job>();
    job->id = id;
    if (!job->proc->start(argv, juce::ChildProcess::wantStdOut | juce::ChildProcess::wantStdErr))
        return ok(false, "spawn: could not start " + tool);
    job->reader = std::make_unique<Reader>(
        *job->proc, id, std::weak_ptr<bool>(alive_), [this](const juce::String& i, const juce::String& d)
        { onOutput(i, d); }, [this](const juce::String& i, int c) { onExit(i, c); });
    job->reader->startThread();
    jobs_[id] = job;
    return ok(true);
}

juce::var ProcessHub::kill(const juce::var& req)
{
    const auto id = req.getProperty("id", "").toString();
    const auto it = jobs_.find(id);
    if (it == jobs_.end())
        return ok(true); // already gone
    if (it->second->proc->isRunning())
        it->second->proc->kill(); // the reader sees EOF and posts the exit
    return ok(true);
}

juce::var ProcessHub::list() const
{
    auto o = ok(true);
    juce::Array<juce::var> ids;
    for (const auto& [id, job] : jobs_)
        if (!job->exited)
            ids.add(id);
    o.getDynamicObject()->setProperty("running", juce::var(ids));
    return o;
}

void ProcessHub::onOutput(const juce::String& id, const juce::String& data)
{
    auto* o = new juce::DynamicObject();
    o->setProperty("id", id);
    o->setProperty("data", data);
    emit_("terminator.processOutput", juce::var(o));
}

void ProcessHub::onExit(const juce::String& id, int code)
{
    const auto it = jobs_.find(id);
    if (it != jobs_.end())
    {
        it->second->exited = true;
        auto job = it->second; // keep the reader alive while it returns from run()
        jobs_.erase(it);
        juce::MessageManager::callAsync([job] { /* destroyed here, off the reader's own stack */ });
    }
    auto* o = new juce::DynamicObject();
    o->setProperty("id", id);
    o->setProperty("code", code);
    emit_("terminator.processExit", juce::var(o));
}

} // namespace terminator::app
