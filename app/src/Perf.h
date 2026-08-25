#pragma once
// Perf — what the native build is FOR, measured instead of assumed (Phase 9.3): how long the app takes to be
// usable, and what it costs while it sits there.
//
// Three marks on one clock, taken from the moment `main()` starts: the WINDOW is up, the PAGE has loaded, and
// the ENGINE is running on a real device. Plus the process's resident memory, read from the OS. The app probe
// reports all of it, so a change that quietly doubles startup shows up in a build rather than in a user's day.
#include <juce_core/juce_core.h>

namespace terminator::app::perf
{

/// Called once at the top of main(): everything below is measured from here.
void start();

/// Milliseconds since start() — 0 before it was called.
double sinceStartMs();

/// Record / read the launch milestones (message thread; a second record of the same mark is ignored, so a
/// window that is rebuilt later cannot rewrite history).
enum class Mark
{
    window,
    page,
    engine
};
void mark(Mark m);
double markMs(Mark m); // -1 when it has not happened

/// Resident memory the moment the page finished loading — the honest "just launched, doing nothing" figure.
/// (`residentMb()` read later in a probe run includes everything the self-test dragged in.)
double residentAtPageMb();

/// The process's resident set size in megabytes (0 when the OS will not say).
double residentMb();

} // namespace terminator::app::perf
