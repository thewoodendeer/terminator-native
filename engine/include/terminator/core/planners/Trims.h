#pragma once
// TRIM — port of src/renderer/chopper/trimRegions.ts: non-destructive section deletion over the ORIGINAL
// decoded audio. `TrimRegion[]` = the DELETED spans in FILE time (sorted, non-overlapping, merged). The
// EFFECTIVE timeline = the kept ranges concatenated — that buffer is what every consumer treats as "the
// sample" (chops, pads, waveform, stems, sequencer, exports).
// Time bases: chops / pads / transients live in EFFECTIVE time; the trim list (and the chops a trim
// swallowed) in FILE time. fileToEff / effToFile are the only bridge.
#include <algorithm>
#include <cmath>
#include <cstdint>
#include <vector>

#include "terminator/core/planners/JsMath.h"

namespace terminator::trims
{
/// A chop swallowed by a trim, FILE time — restored with the region. padIdx −1 = none, stems −1 = absent.
struct TrimChop
{
    int id = 0;
    double startSec = 0.0;
    double endSec = 0.0;
    int padIdx = -1;
    int stems = -1;
    bool operator==(const TrimChop&) const = default;
};
/// One deleted span, FILE time.
struct TrimRegion
{
    double startSec = 0.0;
    double endSec = 0.0;
    std::vector<TrimChop> chops;
    bool operator==(const TrimRegion&) const = default;
};
using TrimList = std::vector<TrimRegion>;

/// Seam anti-click: short in-place ramps on each side of every interior join (amplitude-only, no overlap).
inline constexpr double kSeamFadeSec = 0.003;

inline double totalTrimmedSec(const TrimList& t) noexcept
{
    double s = 0.0;
    for (const auto& r : t)
        s += r.endSec - r.startSec;
    return s;
}
inline bool sameTrims(const TrimList& a, const TrimList& b) noexcept
{
    if (a.size() != b.size())
        return false;
    for (std::size_t i = 0; i < a.size(); ++i)
        if (a[i].startSec != b[i].startSec || a[i].endSec != b[i].endSec)
            return false;
    return true;
}

/// FILE seconds → EFFECTIVE seconds. Points inside a deleted span collapse to its seam.
inline double fileToEff(const TrimList& t, double fileSec) noexcept
{
    double removed = 0.0;
    for (const auto& r : t)
    {
        if (fileSec <= r.startSec)
            break;
        removed += std::min(fileSec, r.endSec) - r.startSec;
    }
    return fileSec - removed;
}
/// EFFECTIVE → FILE seconds (exact on kept ranges). `end` = true picks the BEFORE side of a seam.
inline double effToFile(const TrimList& t, double effSec, bool end = false) noexcept
{
    double file = effSec;
    for (const auto& r : t)
    {
        if (end ? file <= r.startSec : file < r.startSec)
            break;
        file += r.endSec - r.startSec;
    }
    return file;
}

/// Add a deleted span (FILE time): insert, merge every overlapping/touching neighbour (swallowed-chop lists
/// merge, deduped by id). Returns a NEW sorted non-overlapping list.
inline TrimList addTrimRegion(const TrimList& trims, double startSec, double endSec, std::vector<TrimChop> chops)
{
    double s = std::min(startSec, endSec), e = std::max(startSec, endSec);
    std::vector<TrimChop> swallowed = std::move(chops);
    TrimList sorted = trims;
    std::stable_sort(sorted.begin(), sorted.end(),
                     [](const auto& a, const auto& b) { return a.startSec < b.startSec; });
    TrimList out;
    for (const auto& t : sorted)
    {
        if (t.endSec < s || t.startSec > e)
        {
            out.push_back(t);
            continue;
        }
        s = std::min(s, t.startSec);
        e = std::max(e, t.endSec);
        for (const auto& c : t.chops)
            if (std::none_of(swallowed.begin(), swallowed.end(), [&](const TrimChop& x) { return x.id == c.id; }))
                swallowed.push_back(c);
    }
    std::stable_sort(swallowed.begin(), swallowed.end(),
                     [](const auto& a, const auto& b) { return a.startSec < b.startSec; });
    out.push_back({s, e, std::move(swallowed)});
    std::stable_sort(out.begin(), out.end(), [](const auto& a, const auto& b) { return a.startSec < b.startSec; });
    return out;
}

/// Kept ranges of a `length`-frame source at `rate`, FILE frames [a, b). A trim spanning the whole file still
/// leaves one frame so a buffer can exist.
inline std::vector<std::pair<std::int64_t, std::int64_t>> keptRanges(std::int64_t length, double rate,
                                                                     const TrimList& trims)
{
    auto clampF = [&](double sec)
    { return std::max<std::int64_t>(0, std::min<std::int64_t>(length, js::roundToInt(sec * rate))); };
    std::vector<std::pair<std::int64_t, std::int64_t>> kept;
    TrimList sorted = trims;
    std::stable_sort(sorted.begin(), sorted.end(),
                     [](const auto& a, const auto& b) { return a.startSec < b.startSec; });
    std::int64_t cursor = 0;
    for (const auto& t : sorted)
    {
        const auto s = clampF(t.startSec);
        const auto e = clampF(t.endSec);
        if (s > cursor)
            kept.emplace_back(cursor, s);
        cursor = std::max(cursor, e);
    }
    if (cursor < length)
        kept.emplace_back(cursor, length);
    if (kept.empty())
        kept.emplace_back(0, std::min<std::int64_t>(1, length));
    return kept;
}

/// Build the EFFECTIVE channels: kept regions concatenated, with a short amplitude ramp on each side of every
/// interior seam. `src[ch]` points at `length` frames. Returns [channels][totalFrames]; empty trims → a plain
/// copy (the caller decides whether to keep the original buffer object instead — the TS version returns the
/// SAME buffer for zero trims).
inline std::vector<std::vector<float>> buildEffectiveChannels(const std::vector<const float*>& src, std::int64_t length,
                                                              double rate, const TrimList& trims)
{
    const auto kept = keptRanges(length, rate, trims);
    std::int64_t total = 0;
    for (const auto& [a, b] : kept)
        total += b - a;
    total = std::max<std::int64_t>(1, total);
    const auto fade = js::roundToInt(kSeamFadeSec * rate);
    std::vector<std::vector<float>> out(src.size(), std::vector<float>(static_cast<std::size_t>(total), 0.0f));
    for (std::size_t c = 0; c < src.size(); ++c)
    {
        const float* in = src[c];
        auto& dst = out[c];
        std::int64_t w = 0;
        for (std::size_t k = 0; k < kept.size(); ++k)
        {
            const auto [a, b] = kept[k];
            const auto len = b - a;
            for (std::int64_t i = 0; i < len; ++i)
                dst[static_cast<std::size_t>(w + i)] = in[a + i];
            if (k + 1 < kept.size()) // ramp OUT into an interior seam
            {
                const auto n = std::min(fade, len);
                for (std::int64_t i = 0; i < n; ++i)
                    dst[static_cast<std::size_t>(w + len - n + i)] *=
                        static_cast<float>(1.0 - static_cast<double>(i + 1) / static_cast<double>(n));
            }
            if (k > 0) // ramp IN out of one
            {
                const auto n = std::min(fade, len);
                for (std::int64_t i = 0; i < n; ++i)
                    dst[static_cast<std::size_t>(w + i)] *=
                        static_cast<float>(static_cast<double>(i + 1) / static_cast<double>(n));
            }
            w += len;
        }
    }
    return out;
}

struct TimesStrengths
{
    std::vector<float> times;
    std::vector<float> strengths;
};

/// Cut [t0, t1) (EFFECTIVE seconds) out of parallel time/strength arrays: entries inside drop, later slide.
inline TimesStrengths cutTimes(const std::vector<float>& times, const std::vector<float>& strengths, double t0,
                               double t1)
{
    const double removed = t1 - t0;
    TimesStrengths out;
    for (std::size_t i = 0; i < times.size(); ++i)
    {
        const double t = static_cast<double>(times[i]);
        if (t >= t0 && t < t1)
            continue;
        out.times.push_back(static_cast<float>(t >= t1 ? t - removed : t));
        out.strengths.push_back(i < strengths.size() ? strengths[i] : 0.0f);
    }
    return out;
}

/// FILE-time arrays → EFFECTIVE (entries inside a trim dropped, the rest mapped).
inline TimesStrengths mapTimesFileToEff(const std::vector<float>& times, const std::vector<float>& strengths,
                                        const TrimList& trims)
{
    if (trims.empty())
        return {times, strengths};
    TimesStrengths out;
    for (std::size_t i = 0; i < times.size(); ++i)
    {
        const double t = static_cast<double>(times[i]);
        bool inside = false;
        for (const auto& r : trims)
            if (t >= r.startSec && t < r.endSec)
            {
                inside = true;
                break;
            }
        if (inside)
            continue;
        out.times.push_back(static_cast<float>(fileToEff(trims, t)));
        out.strengths.push_back(i < strengths.size() ? strengths[i] : 0.0f);
    }
    return out;
}

/// FILE-time ranges → EFFECTIVE ranges: clipped to the kept parts, mapped, touching pieces merged.
inline std::vector<std::pair<double, double>> mapFileRangesToEff(const std::vector<std::pair<double, double>>& ranges,
                                                                 const TrimList& trims)
{
    if (trims.empty())
        return ranges;
    TrimList sorted = trims;
    std::stable_sort(sorted.begin(), sorted.end(),
                     [](const auto& a, const auto& b) { return a.startSec < b.startSec; });
    std::vector<std::pair<double, double>> out;
    for (const auto& [s, e] : ranges)
    {
        double cur = s;
        for (const auto& t : sorted)
        {
            if (t.endSec <= cur)
                continue;
            if (t.startSec >= e)
                break;
            if (t.startSec > cur)
                out.emplace_back(fileToEff(trims, cur), fileToEff(trims, t.startSec));
            cur = std::max(cur, t.endSec);
        }
        if (cur < e)
            out.emplace_back(fileToEff(trims, cur), fileToEff(trims, e));
    }
    std::stable_sort(out.begin(), out.end(), [](const auto& a, const auto& b) { return a.first < b.first; });
    std::vector<std::pair<double, double>> merged;
    for (const auto& r : out)
    {
        if (!merged.empty() && r.first <= merged.back().second + 1e-6)
            merged.back().second = std::max(merged.back().second, r.second);
        else if (r.second > r.first)
            merged.push_back(r);
    }
    return merged;
}
} // namespace terminator::trims
