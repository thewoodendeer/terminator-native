#include "Perf.h"

#if JUCE_MAC
#include <mach/mach.h>
#elif JUCE_WINDOWS
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#include <psapi.h>
#endif

namespace terminator::app::perf
{
namespace
{
double startTicks = 0.0;
double marks[3] = {-1.0, -1.0, -1.0};
double rssAtPage = 0.0;
} // namespace

void start()
{
    startTicks = static_cast<double>(juce::Time::getHighResolutionTicks());
}

double sinceStartMs()
{
    if (startTicks <= 0.0)
        return 0.0;
    const auto now = static_cast<double>(juce::Time::getHighResolutionTicks());
    return (now - startTicks) * 1000.0 / static_cast<double>(juce::Time::getHighResolutionTicksPerSecond());
}

void mark(Mark m)
{
    auto& slot = marks[static_cast<int>(m)];
    if (slot < 0.0)
    {
        slot = sinceStartMs();
        if (m == Mark::page)
            rssAtPage = residentMb();
    }
}

double residentAtPageMb()
{
    return rssAtPage;
}

double markMs(Mark m)
{
    return marks[static_cast<int>(m)];
}

double residentMb()
{
#if JUCE_MAC
    mach_task_basic_info info{};
    mach_msg_type_number_t count = MACH_TASK_BASIC_INFO_COUNT;
    if (task_info(mach_task_self(), MACH_TASK_BASIC_INFO, reinterpret_cast<task_info_t>(&info), &count) != KERN_SUCCESS)
        return 0.0;
    return static_cast<double>(info.resident_size) / (1024.0 * 1024.0);
#elif JUCE_WINDOWS
    PROCESS_MEMORY_COUNTERS pmc{};
    if (!GetProcessMemoryInfo(GetCurrentProcess(), &pmc, sizeof(pmc)))
        return 0.0;
    return static_cast<double>(pmc.WorkingSetSize) / (1024.0 * 1024.0);
#else
    return 0.0;
#endif
}

} // namespace terminator::app::perf
