// Updater.cpp — the NON-Apple side of Updater.h: WinSparkle on Windows, a do-nothing stub everywhere else.
// (macOS compiles Updater.mm instead — see the note at the top of that file.)
//
// WinSparkle is the same idea as Sparkle with a different shape: there is no Info.plist to read, so the feed,
// the app details and the public key are handed over at runtime here. The KEY is deliberately the same EdDSA
// pair macOS uses — one key in the release Mac's keychain, one `sign_update`, one thing to back up — which is
// why WinSparkle is pinned at 0.9.4, the first release with `win_sparkle_set_eddsa_public_key`.
#include "Updater.h"

#if TERMINATOR_HAS_WINSPARKLE
#include <winsparkle.h>

#include <juce_core/juce_core.h>

namespace
{
/// A probe / CI run must never reach the network, and must never be interrupted by an update dialog.
/// TERMINATOR_PROBE_UPDATER=1 opts a probe back IN — that is the gate that proves a shipped build can update —
/// and the check interval is pushed out of the way so nothing phones home while it runs.
bool isProbeRun()
{
    return juce::SystemStats::getEnvironmentVariable("TERMINATOR_PROBE_FILE", {}).isNotEmpty();
}
bool probeWantsUpdater()
{
    return isProbeRun() && juce::SystemStats::getEnvironmentVariable("TERMINATOR_PROBE_UPDATER", {}) == "1";
}
bool isHeadlessRun()
{
    return (isProbeRun() && !probeWantsUpdater()) ||
           juce::SystemStats::getEnvironmentVariable("TERMINATOR_NO_UPDATER", {}).isNotEmpty();
}

terminator::app::Updater::Status gStatus{};
} // namespace

namespace terminator::app
{

struct Updater::Impl
{
    bool running = false;
};

Updater::Updater() : impl_(std::make_unique<Impl>())
{
    gStatus = Status{};
    gStatus.compiledIn = true;
    gStatus.feed = TERMINATOR_APPCAST_URL;
    if (isHeadlessRun())
    {
        gStatus.detail = "skipped (headless run)";
        return;
    }
    gStatus.attempted = true;

    // The public key first: if WinSparkle refuses it, there is no point starting — an updater that cannot
    // verify a download can only ever refuse one, and it would do so silently.
    if (win_sparkle_set_eddsa_public_key(TERMINATOR_SPARKLE_PUBLIC_KEY) == 0)
    {
        gStatus.detail = "WinSparkle rejected the EdDSA public key";
        juce::Logger::writeToLog("updater: not started — " + gStatus.detail);
        return;
    }
    win_sparkle_set_appcast_url(TERMINATOR_APPCAST_URL);
    win_sparkle_set_app_details(L"Killavic Cheat Codes", L"Terminator",
                                juce::String(TERMINATOR_VERSION_STRING).toWideCharPointer());
    // Ask before the first check rather than deciding for the user, and never install unattended — the same
    // "Restart now / Later" bargain the Electron app already makes.
    win_sparkle_set_automatic_check_for_updates(probeWantsUpdater() ? 0 : 1);
    win_sparkle_set_update_check_interval(60 * 60 * 24);
    win_sparkle_init();
    impl_->running = true;
    gStatus.started = true;
    gStatus.detail = "started";
}

Updater::~Updater()
{
    if (impl_ != nullptr && impl_->running)
        win_sparkle_cleanup();
}

bool Updater::isRunning() const noexcept
{
    return impl_ != nullptr && impl_->running;
}

void Updater::checkForUpdatesNow()
{
    if (!isRunning())
        return;
    // The VERBOSE one: it reports "you are up to date" too, which is the whole point of a menu item somebody
    // chose to press.
    win_sparkle_check_update_with_ui();
}

bool Updater::available() noexcept
{
    return true;
}

Updater::Status Updater::status() noexcept
{
    return gStatus;
}

} // namespace terminator::app

#else // no updater in this build (Linux, or -DTERMINATOR_UPDATER=OFF)

namespace terminator::app
{
struct Updater::Impl
{
};
Updater::Updater() = default;
Updater::~Updater() = default;
bool Updater::isRunning() const noexcept
{
    return false;
}
void Updater::checkForUpdatesNow() {}
bool Updater::available() noexcept
{
    return false;
}
Updater::Status Updater::status() noexcept
{
    return {};
}
} // namespace terminator::app

#endif
