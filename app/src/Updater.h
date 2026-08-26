#pragma once
// THE UPDATER (Phase 9.1) — Sparkle on macOS.
//
// What it is for: 3.0 ships outside the App Store, so an installed copy only ever becomes a NEWER installed
// copy if the app fetches it itself. The Electron app already works this way and its users never think about
// it; anything less here would be a downgrade.
//
// Three deliberate constraints:
//   * It NEVER runs in a headless / probe / dev run. A gate that reaches the network is not a gate, and a
//     dev build is not signed — Sparkle would refuse it and put an alert in front of a developer, every launch.
//   * A misconfiguration is LOGGED, never shown. `SPUStandardUpdaterController` shows the user an alert when
//     the app is set up wrong, which is exactly backwards: the person who can fix it is us, not them. This
//     drives `SPUUpdater` directly so a failed start is a log line and an updater that stays quiet.
//   * The app is fully usable without it. `available()` false = the Check for Updates item is not in the menu,
//     and nothing else changes.
//
// Windows gets WinSparkle against the same appcast contract (a separate feed file — a Mac release may never
// touch the Windows feed). See docs/native/RELEASE-CYCLES-NATIVE.md.
#include <memory>

#include <juce_core/juce_core.h>

namespace terminator::app
{

class Updater final
{
  public:
    Updater();
    ~Updater();

    Updater(const Updater&) = delete;
    Updater& operator=(const Updater&) = delete;

    /// True when this build has an updater AND it started (signed, bundled, with a feed and a public key).
    /// False in every dev build and every probe run — the caller leaves the menu item out.
    bool isRunning() const noexcept;

    /// The menu item: check now and report back verbosely, including "you are up to date".
    void checkForUpdatesNow();

    /// Compiled in at all? (false on Windows/Linux and with -DTERMINATOR_UPDATER=OFF)
    static bool available() noexcept;

    /// WHAT THE PROBE ASKS. A misconfigured updater is invisible in a shipped app — the user simply never gets
    /// another version, and nobody finds out for a release cycle. `TERMINATOR_PROBE_UPDATER=1` makes a probe run
    /// start the updater for real (with automatic checks OFF, so no gate ever reaches the network) and this is
    /// what it reports. `detail` carries Sparkle's own reason when it refused.
    struct Status
    {
        bool compiledIn = false;
        bool attempted = false; ///< did this run even try? (a plain probe run does not)
        bool started = false;
        juce::String detail;
        juce::String feed; ///< SUFeedURL as SPARKLE reads it — out of the built bundle's own Info.plist
    };
    static Status status() noexcept;

  private:
    struct Impl;
    std::unique_ptr<Impl> impl_;
};

} // namespace terminator::app
