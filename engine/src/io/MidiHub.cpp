#include "terminator/io/MidiHub.h"

#include <algorithm>
#include <thread>

#include "terminator/io/AudioIO.h"

namespace terminator
{

MidiHub::MidiHub(Engine& engine) : engine_(engine), pump_(*this)
{
    for (const auto& d : juce::MidiInput::getAvailableDevices())
        lastSeenIds_.add(d.identifier);
    for (const auto& d : juce::MidiOutput::getAvailableDevices())
        lastSeenOutIds_.add(d.identifier);
    startTimer(1000); // hot-plug poll (JUCE has no MIDI device-change callback on every platform)
    pump_.startThread(juce::Thread::Priority::highest);
}

MidiHub::~MidiHub()
{
    stopTimer();
    pump_.stopThread(2000);
    for (auto& p : open_)
        if (p.input)
            p.input->stop();
    open_.clear();
    const juce::ScopedLock sl(outLock_);
    outOpen_.clear();
}

// ───────────────────────────────── inputs ─────────────────────────────────

std::vector<MidiHub::PortInfo> MidiHub::inputs() const
{
    std::vector<PortInfo> out;
    for (const auto& d : juce::MidiInput::getAvailableDevices())
    {
        PortInfo p;
        p.identifier = d.identifier;
        p.name = d.name;
        p.enabled = enabledIds_.contains(d.identifier);
        p.open =
            std::any_of(open_.begin(), open_.end(), [&](const OpenPort& o) { return o.identifier == d.identifier; });
        out.push_back(p);
    }
    return out;
}

juce::String MidiHub::enableInput(const juce::String& identifier, bool enabled)
{
    if (enabled)
    {
        enabledIds_.addIfNotAlreadyThere(identifier);
        if (std::any_of(open_.begin(), open_.end(), [&](const OpenPort& o) { return o.identifier == identifier; }))
            return {};
        if (static_cast<int>(open_.size()) >= Engine::kMaxMidiPorts)
            return "too many MIDI inputs open (max " + juce::String(Engine::kMaxMidiPorts) + ")";
        // pick a free queue index
        int idx = 0;
        for (; idx < Engine::kMaxMidiPorts; ++idx)
            if (std::none_of(open_.begin(), open_.end(), [&](const OpenPort& o) { return o.queueIndex == idx; }))
                break;
        auto in = juce::MidiInput::openDevice(identifier, this);
        if (in == nullptr)
            return "could not open MIDI input " + identifier;
        OpenPort p;
        p.identifier = identifier;
        p.name = in->getName();
        p.input = std::move(in);
        p.queueIndex = idx;
        p.input->start();
        open_.push_back(std::move(p));
    }
    else
    {
        enabledIds_.removeString(identifier);
        for (auto it = open_.begin(); it != open_.end(); ++it)
            if (it->identifier == identifier)
            {
                it->input->stop();
                open_.erase(it);
                break;
            }
    }
    if (onPortsChanged)
        onPortsChanged();
    return {};
}

void MidiHub::enableAllInputs()
{
    for (const auto& d : juce::MidiInput::getAvailableDevices())
        enableInput(d.identifier, true);
}

// ───────────────────────────────── outputs (3.5) ─────────────────────────────────

std::vector<MidiHub::PortInfo> MidiHub::outputs() const
{
    std::vector<PortInfo> out;
    const juce::ScopedLock sl(outLock_);
    for (const auto& d : juce::MidiOutput::getAvailableDevices())
    {
        PortInfo p;
        p.identifier = d.identifier;
        p.name = d.name;
        p.enabled = !outDisabledIds_.contains(d.identifier);
        p.open = std::any_of(outOpen_.begin(), outOpen_.end(),
                             [&](const OutPort& o) { return o.identifier == d.identifier; });
        out.push_back(p);
    }
    return out;
}

int MidiHub::openOutputCount() const
{
    const juce::ScopedLock sl(outLock_);
    return static_cast<int>(outOpen_.size());
}

juce::String MidiHub::openOutput(const juce::String& identifier)
{
    {
        const juce::ScopedLock sl(outLock_);
        if (std::any_of(outOpen_.begin(), outOpen_.end(), [&](const OutPort& o) { return o.identifier == identifier; }))
            return {};
    }
    auto out = juce::MidiOutput::openDevice(identifier); // outside the lock: the OS call can take a while
    if (out == nullptr)
        return "could not open MIDI output " + identifier;
    OutPort p;
    p.identifier = identifier;
    p.name = out->getName();
    p.output = std::move(out);
    const juce::ScopedLock sl(outLock_);
    outOpen_.push_back(std::move(p));
    return {};
}

void MidiHub::closeOutput(const juce::String& identifier)
{
    std::unique_ptr<juce::MidiOutput> dying; // destroyed outside the lock
    {
        const juce::ScopedLock sl(outLock_);
        for (auto it = outOpen_.begin(); it != outOpen_.end(); ++it)
            if (it->identifier == identifier)
            {
                dying = std::move(it->output);
                outOpen_.erase(it);
                break;
            }
    }
}

juce::String MidiHub::enableOutput(const juce::String& identifier, bool enabled)
{
    juce::String err;
    if (enabled)
    {
        outDisabledIds_.removeString(identifier);
        err = openOutput(identifier);
    }
    else
    {
        outDisabledIds_.addIfNotAlreadyThere(identifier);
        closeOutput(identifier);
    }
    if (onPortsChanged)
        onPortsChanged();
    return err;
}

void MidiHub::applyOutputPrefs(const juce::var& map)
{
    // the OFF set = every id the map says false; everything available and not off gets opened
    outDisabledIds_.clear();
    if (const auto* o = map.getDynamicObject())
        for (const auto& kv : o->getProperties())
            if (!static_cast<bool>(kv.value))
                outDisabledIds_.add(kv.name.toString());
    for (const auto& d : juce::MidiOutput::getAvailableDevices())
    {
        if (outDisabledIds_.contains(d.identifier))
            closeOutput(d.identifier);
        else
            openOutput(d.identifier);
    }
    if (onPortsChanged)
        onPortsChanged();
}

void MidiHub::refresh()
{
    juce::StringArray now;
    for (const auto& d : juce::MidiInput::getAvailableDevices())
        now.add(d.identifier);
    // drop open ports that vanished
    for (auto it = open_.begin(); it != open_.end();)
    {
        if (!now.contains(it->identifier))
        {
            it->input->stop();
            it = open_.erase(it);
        }
        else
            ++it;
    }
    // reopen enabled ports that came back
    for (const auto& id : enabledIds_)
        if (now.contains(id) &&
            std::none_of(open_.begin(), open_.end(), [&](const OpenPort& o) { return o.identifier == id; }))
            enableInput(id, true);
    // outputs: drop the vanished, open the new ones (unless turned off)
    juce::StringArray nowOut;
    for (const auto& d : juce::MidiOutput::getAvailableDevices())
        nowOut.add(d.identifier);
    bool outChanged = false;
    {
        juce::StringArray gone;
        {
            const juce::ScopedLock sl(outLock_);
            for (const auto& o : outOpen_)
                if (!nowOut.contains(o.identifier))
                    gone.add(o.identifier);
        }
        for (const auto& id : gone)
        {
            closeOutput(id);
            outChanged = true;
        }
    }
    for (const auto& id : nowOut)
        if (!outDisabledIds_.contains(id))
        {
            bool isOpen;
            {
                const juce::ScopedLock sl(outLock_);
                isOpen =
                    std::any_of(outOpen_.begin(), outOpen_.end(), [&](const OutPort& o) { return o.identifier == id; });
            }
            if (!isOpen)
            {
                openOutput(id);
                outChanged = true;
            }
        }
    if (now != lastSeenIds_ || nowOut != lastSeenOutIds_ || outChanged)
    {
        lastSeenIds_ = now;
        lastSeenOutIds_ = nowOut;
        if (onPortsChanged)
            onPortsChanged();
    }
}

void MidiHub::timerCallback()
{
    refresh();
}

// ───────────────────────────────── the pump (engine → outputs) ─────────────────────────────────

void MidiHub::Pump::run()
{
    // Drains Engine::midiOut() (the clock OUT the callback produced, each stamped with the host time its sample is
    // heard) and sends every message AT its stamp: sleep in 1 ms steps until ~1.5 ms before, then spin. A stamp in the
    // past (a late block, no host clock in tests) goes out at once — bunched ticks keep the COUNT = song position.
    std::vector<MidiOutEvent> pending;
    pending.reserve(1024);
    std::size_t head = 0;
    constexpr std::uint64_t kSpinWindowNs = 1'500'000;
    while (!threadShouldExit())
    {
        MidiOutEvent e;
        while (hub_.engine_.midiOut().pop(e))
            pending.push_back(e);
        if (head >= pending.size())
        {
            pending.clear();
            head = 0;
            wait(1);
            continue;
        }
        const auto& next = pending[head];
        const auto now = AudioIO::hostTimeNowNs();
        if (next.hostTimeNs > now + kSpinWindowNs)
        {
            wait(1); // re-check in a ms (also drains whatever arrived meanwhile)
            continue;
        }
        while (!threadShouldExit() && next.hostTimeNs > AudioIO::hostTimeNowNs())
            std::this_thread::yield();
        const auto sentAt = AudioIO::hostTimeNowNs();
        hub_.send(next);
        const double lateMs = next.hostTimeNs != 0 && sentAt > next.hostTimeNs
                                  ? static_cast<double>(sentAt - next.hostTimeNs) * 1e-6
                                  : 0.0;
        hub_.lastLateMs_.store(lateMs, std::memory_order_relaxed);
        if (lateMs > hub_.maxLateMs_.load(std::memory_order_relaxed))
            hub_.maxLateMs_.store(lateMs, std::memory_order_relaxed);
        ++head;
        if (head >= 512 && head * 2 >= pending.size())
        {
            pending.erase(pending.begin(), pending.begin() + static_cast<std::ptrdiff_t>(head));
            head = 0;
        }
    }
}

void MidiHub::send(const MidiOutEvent& e)
{
    if (e.size == 0 || e.size > 3)
        return;
    const juce::MidiMessage m(e.data, static_cast<int>(e.size), 0.0);
    const juce::ScopedLock sl(outLock_);
    for (auto& o : outOpen_)
        if (o.output)
            o.output->sendMessageNow(m);
    sentCount_.fetch_add(1, std::memory_order_relaxed);
}

// ───────────────────────────────── inputs: dispatch ─────────────────────────────────

void MidiHub::handleIncomingMidiMessage(juce::MidiInput* source, const juce::MidiMessage& message)
{
    // DRIVER THREAD. No allocation beyond what JUCE already did for `message` (+ a callAsync lambda per mirrored
    // message — never per clock tick); only queue pushes + atomics on the hot path.
    int port = 0;
    for (const auto& p : open_)
        if (p.input.get() == source)
        {
            port = p.queueIndex;
            break;
        }
    const auto nowNs = AudioIO::hostTimeNowNs();
    // JUCE stamps messages with Time::getMillisecondCounterHiRes()*0.001 at arrival; lag = how late we are seeing it
    const double nowSec = juce::Time::getMillisecondCounterHiRes() * 0.001;
    double lagSec = nowSec - message.getTimeStamp();
    if (lagSec < 0.0 || lagSec > 0.5)
        lagSec = 0.0;
    const auto lagNs = static_cast<std::uint64_t>(lagSec * 1e9);
    dispatch(port, message, nowNs > lagNs ? nowNs - lagNs : nowNs, lagSec);
}

void MidiHub::dispatch(int port, const juce::MidiMessage& message, std::uint64_t hostNs, double lagSec)
{
    const double tsMs = message.getTimeStamp() * 1000.0; // the driver's stamp, ms — what the follower wants
    // ── MIDI clock IN (3.5): the ticks never leave this thread; the lock decides whose they are ──
    if (message.isMidiClock())
    {
        if (clockLock_.onTick(port))
        {
            const double bpm = clockFollow_.onTick(tsMs);
            if (bpm > 0.0)
            {
                clockInBpm_.store(bpm, std::memory_order_relaxed);
                if (onClockBpm)
                    juce::MessageManager::callAsync(
                        [this, bpm, port]
                        {
                            if (onClockBpm)
                                onClockBpm(bpm, port);
                        });
            }
        }
        return;
    }
    if (message.isActiveSense())
        return;

    MidiEvent e;
    e.hostTimeNs = hostNs;
    e.port = static_cast<std::uint8_t>(port);
    const auto* raw = message.getRawData();
    const int n = std::min(3, message.getRawDataSize());
    for (int i = 0; i < n; ++i)
        e.data[i] = raw[i];
    e.size = static_cast<std::uint8_t>(n);

    if (message.isMidiStart() || message.isMidiContinue())
    {
        if (!clockLock_.onStart(port, tsMs))
            return; // the same press seen on another port
        clockFollow_.reset();
        clockStarted_.store(true, std::memory_order_relaxed);
        clockOwner_.store(port, std::memory_order_relaxed);
        mirror(e, port); // the page starts the transport (its startTransport — count-in, REC arms, all engines)
        return;
    }
    if (message.isMidiStop())
    {
        clockLock_.onStop(port);
        clockStarted_.store(false, std::memory_order_relaxed);
        clockOwner_.store(-1, std::memory_order_relaxed);
        mirror(e, port);
        return;
    }
    if (n == 0)
        return;
    // every channel message: the engine (notes → pads on the direct path when routing allows) + the page
    engine_.midiQueue(port).push(e);
    mirror(e, port);

    const int count = lagCount_.fetch_add(1, std::memory_order_relaxed);
    lagHistory_[count % kLagHistory] = lagSec * 1000.0;
    lastLagMs_.store(lagSec * 1000.0, std::memory_order_relaxed);
    messageCount_.fetch_add(1, std::memory_order_relaxed);
    lastStatus_.store(n > 0 ? raw[0] : 0, std::memory_order_relaxed);
    lastData1_.store(n > 1 ? raw[1] : 0, std::memory_order_relaxed);
    lastData2_.store(n > 2 ? raw[2] : 0, std::memory_order_relaxed);
    lastPort_.store(port, std::memory_order_relaxed);
}

void MidiHub::mirror(const MidiEvent& e, int port)
{
    if (!onMessage)
        return;
    juce::MessageManager::callAsync(
        [this, e, port]
        {
            if (!onMessage)
                return;
            juce::String name;
            for (const auto& p : open_) // message thread: safe to read
                if (p.queueIndex == port)
                {
                    name = p.name;
                    break;
                }
            onMessage(e, name);
        });
}

void MidiHub::injectNote(int note, int velocity, bool on, int channel)
{
    const auto msg = on ? juce::MidiMessage::noteOn(channel, note, static_cast<juce::uint8>(velocity))
                        : juce::MidiMessage::noteOff(channel, note, static_cast<juce::uint8>(velocity));
    const auto stamped = juce::MidiMessage(msg, juce::Time::getMillisecondCounterHiRes() * 0.001);
    dispatch(0, stamped, AudioIO::hostTimeNowNs(), 0.0);
}

void MidiHub::inject(const std::uint8_t* data, int size)
{
    if (data == nullptr || size <= 0 || size > 3)
        return;
    const juce::MidiMessage msg(data, size, juce::Time::getMillisecondCounterHiRes() * 0.001);
    dispatch(0, msg, AudioIO::hostTimeNowNs(), 0.0);
}

double MidiHub::medianInputLagMs() const
{
    const int n = std::min(lagCount_.load(std::memory_order_relaxed), kLagHistory);
    if (n == 0)
        return 0.0;
    double tmp[kLagHistory];
    std::copy_n(lagHistory_, n, tmp);
    std::sort(tmp, tmp + n);
    return tmp[n / 2];
}

juce::String MidiHub::lastMessageDescription() const
{
    const auto st = lastStatus_.load(std::memory_order_relaxed);
    if (st == 0)
        return {};
    const auto d1 = lastData1_.load(std::memory_order_relaxed);
    const auto d2 = lastData2_.load(std::memory_order_relaxed);
    const auto port = lastPort_.load(std::memory_order_relaxed);
    juce::String desc;
    switch (st & 0xF0u)
    {
    case 0x90:
        desc = "Note On " + juce::MidiMessage::getMidiNoteName(static_cast<int>(d1), true, true, 3) + " vel " +
               juce::String(d2);
        break;
    case 0x80:
        desc = "Note Off " + juce::MidiMessage::getMidiNoteName(static_cast<int>(d1), true, true, 3);
        break;
    case 0xB0:
        desc = "CC " + juce::String(d1) + " = " + juce::String(d2);
        break;
    case 0xE0:
        desc = "Pitch bend " + juce::String(static_cast<int>((d2 << 7) | d1) - 8192);
        break;
    default:
        desc = "status 0x" + juce::String::toHexString(static_cast<int>(st));
        break;
    }
    return desc + " (ch " + juce::String((st & 0x0Fu) + 1) + ", port " + juce::String(port) + ")";
}

} // namespace terminator
