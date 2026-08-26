// Updater.mm — the Sparkle side of Updater.h. Objective-C++ because Sparkle is an Objective-C framework; this
// is the ONLY .mm in the app, and nothing outside this file knows Sparkle exists.
//
// APPLE ONLY — app/CMakeLists.txt compiles this file on macOS and Updater.cpp everywhere else. It used to be
// compiled on Windows too and happened to work, because MSVC treats an unknown extension as C++ and every line
// of Objective-C here sits behind TERMINATOR_HAS_SPARKLE. That is luck, not design: the first `@interface`
// written outside the guard would have broken the Windows build for a reason nobody would guess from the error.
#include "Updater.h"

#include <juce_core/juce_core.h>

#if TERMINATOR_HAS_SPARKLE
#import <Sparkle/Sparkle.h>

namespace
{
/// A probe / CI / soak run must never touch the network, and must never be interrupted by an update dialog.
/// TERMINATOR_PROBE_FILE is the flag the whole app already uses for "this launch is a gate, not a person".
bool isProbeRun()
{
    return juce::SystemStats::getEnvironmentVariable("TERMINATOR_PROBE_FILE", {}).isNotEmpty();
}
/// A probe MAY start the updater on purpose (that is the gate) — it just must not let it phone home.
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
    SPUUpdater* updater = nil;
    SPUStandardUserDriver* driver = nil;
    bool running = false;
};

Updater::Updater() : impl_(std::make_unique<Impl>())
{
    gStatus = Status{};
    gStatus.compiledIn = true;
    if (isHeadlessRun())
    {
        gStatus.detail = "skipped (headless run)";
        DBG("updater: skipped (headless run)");
        return;
    }
    gStatus.attempted = true;

    @autoreleasepool
    {
        NSBundle* bundle = [NSBundle mainBundle];
        // Read it back out of the BUNDLE rather than from a build-time constant: what Sparkle obeys is the
        // plist, and a plist key that failed to merge is exactly the failure worth catching.
        if (NSString* feed = [bundle objectForInfoDictionaryKey:@"SUFeedURL"])
            gStatus.feed = juce::String([feed UTF8String]);
        impl_->driver = [[SPUStandardUserDriver alloc] initWithHostBundle:bundle delegate:nil];
        impl_->updater = [[SPUUpdater alloc] initWithHostBundle:bundle
                                              applicationBundle:bundle
                                                     userDriver:impl_->driver
                                                       delegate:nil];
        if (probeWantsUpdater())
        {
            // The gate proves the app is CONFIGURED and SIGNED well enough for Sparkle to start. It must not
            // then go and ask the server anything — a gate that reaches the network is not a gate.
            impl_->updater.automaticallyChecksForUpdates = NO;
        }
        NSError* error = nil;
        if ([impl_->updater startUpdater:&error])
        {
            impl_->running = true;
            gStatus.started = true;
            gStatus.detail = "started";
        }
        else
        {
            // The normal reason is "this build is not signed / not in a bundle" — i.e. every dev run. It is a
            // log line on purpose: the user is not the person who can fix a misconfigured feed.
            const char* why = error != nil ? [[error localizedDescription] UTF8String] : nullptr;
            gStatus.detail = juce::String(why != nullptr ? why : "unknown");
            juce::Logger::writeToLog("updater: not started — " + gStatus.detail);
            impl_->updater = nil;
            impl_->driver = nil;
        }
    }
}

Updater::~Updater()
{
    @autoreleasepool
    {
        impl_->updater = nil;
        impl_->driver = nil;
    }
}

bool Updater::isRunning() const noexcept
{
    return impl_ != nullptr && impl_->running;
}

void Updater::checkForUpdatesNow()
{
    if (!isRunning())
        return;
    @autoreleasepool
    {
        // `checkForUpdates` (not ...InBackground) is the verbose one: it reports "you are up to date" too,
        // which is the whole point of a menu item somebody chose to press.
        [impl_->updater checkForUpdates];
    }
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

#endif // TERMINATOR_HAS_SPARKLE
