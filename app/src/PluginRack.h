#pragma once
// PLUGINS AS INSERTS (Phase 6.2) — the APP's half: the instances, their editors, their state.
//
// The engine holds nothing but a pointer (core/fx/PluginFx.h). Everything that knows what a VST3 or an AudioUnit
// is lives here, on the message thread. THE RULE THAT MATTERS is lifetime: an instance may only be destroyed
// after the engine has been told to detach it AND has run blocks since, so `retired_` holds each removed plugin
// until `blocksProcessed` proves the audio thread has moved on (or until the engine is not running at all).
#include <memory>
#include <vector>

#include <juce_audio_processors/juce_audio_processors.h>
#include <juce_gui_basics/juce_gui_basics.h>

#include "terminator/core/Engine.h"

#include "PluginHub.h"

namespace terminator::app
{

class PluginRack final : private juce::Timer
{
  public:
    PluginRack(Engine& engine, PluginHub& hub);
    ~PluginRack() override;

    /// `terminatorPlugins` verbs that touch a LOADED plugin: open · close · editor · state · setState · params ·
    /// setParam · rack. Everything else belongs to PluginHub (the scan + the list).
    static bool ownsVerb(const juce::String& verb);
    juce::var handle(const juce::var& req);

    /// The audio device changed: re-prepare every instance for the new rate / block.
    void prepareAll(double sampleRate, int blockSize);

  private:
    class Adapter;
    class EditorWindow;
    struct Entry
    {
        std::unique_ptr<juce::AudioPluginInstance> instance;
        std::unique_ptr<Adapter> adapter;
        std::unique_ptr<EditorWindow> editor;
        juce::String id, name;
        int strip = -1;
        int slot = -1;
    };
    struct Retired
    {
        std::unique_ptr<Entry> entry;
        std::uint64_t blocksAt = 0;
    };

    Entry* find(int strip, int slot);
    void retire(std::unique_ptr<Entry> e);
    void timerCallback() override; // drains retired_ once the audio thread has provably moved on
    juce::var entryVar(const Entry& e) const;

    Engine& engine_;
    PluginHub& hub_;
    std::vector<std::unique_ptr<Entry>> entries_;
    std::vector<Retired> retired_;
};

} // namespace terminator::app
