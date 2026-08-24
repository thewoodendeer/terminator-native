#pragma once
// PLUGINS (Phase 6.1) — the scan, the list, and making instances. VST3 everywhere plus AudioUnit on macOS.
//
// THE SCAN RUNS IN A CHILD PROCESS, one plugin at a time: the app relaunches its own binary with
// `--scan-plugin <format> <fileOrIdentifier>`, and the child prints the plugin descriptions as XML on stdout. A
// plugin that crashes, hangs or spews takes the CHILD down, never Terminator — and the file goes on the BLOCKLIST
// so the next scan does not try it again. That is the only honest way to scan a machine full of other people's
// code, and it is what every host does.
//
// The list + the blocklist live in `plugins.xml` beside settings.json, so a scan happens once, not every launch.
#include <functional>
#include <memory>

#include <juce_audio_processors/juce_audio_processors.h>
#include <juce_audio_processors/format/juce_AudioPluginFormatManagerHelpers.h>
#include <juce_gui_basics/juce_gui_basics.h>

namespace terminator::app
{

class PluginHub final : private juce::Timer
{
  public:
    explicit PluginHub(const juce::File& stateFile);
    ~PluginHub() override;

    /// The bridge verbs (`terminatorPlugins`): list · scan · cancelScan · remove · clearBlocklist · setFolders.
    juce::var handle(const juce::var& req);

    /// Scan progress / completion → the page (`terminator.pluginScan`). Set by the shell.
    std::function<void(const juce::String& event, const juce::var& payload)> onEvent;

    /// Make an instance (message thread; the caller owns it). `id` = PluginDescription::createIdentifierString().
    std::unique_ptr<juce::AudioPluginInstance> create(const juce::String& id, double sampleRate, int blockSize,
                                                      juce::String& error);
    /// The description behind an id (a null description when it is not in the list).
    juce::PluginDescription describe(const juce::String& id) const;

    /// The child-process side: print this plugin's descriptions as XML and return true. Called from Main before any
    /// window exists.
    static bool runChildScan(const juce::String& formatName, const juce::String& fileOrIdentifier);

  private:
    class ScanJob;
    void timerCallback() override; // drains the scan thread's progress onto the message thread
    void load();
    void save();
    juce::var listVar() const;
    juce::StringArray searchPaths() const;

    juce::File stateFile_;
    juce::AudioPluginFormatManager formats_;
    juce::KnownPluginList known_;
    juce::StringArray blocklist_; // files that crashed / timed out in the child
    juce::StringArray folders_;   // extra user folders (Preferences → PLUGINS)
    std::unique_ptr<ScanJob> scan_;
};

} // namespace terminator::app
