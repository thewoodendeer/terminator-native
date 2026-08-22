#include "terminator/io/MidiHub.h"

#include <algorithm>

#include "terminator/io/AudioIO.h"

namespace terminator
{

MidiHub::MidiHub(Engine& engine) : engine_(engine)
{
    for (const auto& d : juce::MidiInput::getAvailableDevices())
        lastSeenIds_.add(d.identifier);
    startTimer(1000); // hot-plug poll (JUCE has no MIDI device-change callback on every platform)
}

MidiHub::~MidiHub()
{
    stopTimer();
    for (auto& p : open_)
        if (p.input)
            p.input->stop();
    open_.clear();
}

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
    if (now != lastSeenIds_)
    {
        lastSeenIds_ = now;
        if (onPortsChanged)
            onPortsChanged();
    }
}

void MidiHub::timerCallback()
{
    refresh();
}

void MidiHub::handleIncomingMidiMessage(juce::MidiInput* source, const juce::MidiMessage& message)
{
    // DRIVER THREAD. No allocation beyond what JUCE already did for `message`; only queue pushes + atomics.
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

    MidiEvent e;
    e.hostTimeNs = nowNs > lagNs ? nowNs - lagNs : nowNs;
    e.port = static_cast<std::uint8_t>(port);
    const auto* raw = message.getRawData();
    const int n = std::min(3, message.getRawDataSize());
    for (int i = 0; i < n; ++i)
        e.data[i] = raw[i];
    e.size = static_cast<std::uint8_t>(n);
    if (message.isActiveSense() || message.isMidiClock())
        return; // not routed to pads; clock handled in Phase 3
    engine_.midiQueue(port).push(e);

    const int count = lagCount_.fetch_add(1, std::memory_order_relaxed);
    lagHistory_[count % kLagHistory] = lagSec * 1000.0;
    lastLagMs_.store(lagSec * 1000.0, std::memory_order_relaxed);
    messageCount_.fetch_add(1, std::memory_order_relaxed);
    lastStatus_.store(n > 0 ? raw[0] : 0, std::memory_order_relaxed);
    lastData1_.store(n > 1 ? raw[1] : 0, std::memory_order_relaxed);
    lastData2_.store(n > 2 ? raw[2] : 0, std::memory_order_relaxed);
    lastPort_.store(port, std::memory_order_relaxed);
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
