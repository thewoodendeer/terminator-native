#pragma once
// STEM MASKS — port of src/renderer/chopper/stemMask.ts (the pure half of per-pad stems). Bit order == the
// model's stem order (htdemucs rows): bit 0 drums, 1 bass, 2 other, 3 vocals. A pad carries a 4-bit mask; the
// engine resolves it to audio at trigger time. Ready ranges: stems are PARTIAL by design — a span plays its
// stem mix only when a ready range covers it, otherwise the ORIGINAL plays (never silence).
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <vector>

namespace terminator::stems
{
enum class Stem : std::uint8_t
{
    drums = 0,
    bass = 1,
    other = 2,
    vocals = 3
};
inline constexpr int kStemCount = 4;
inline constexpr const char* kStemNames[kStemCount] = {"drums", "bass", "other", "vocals"};

using StemMask = std::uint8_t; // 1..15
inline constexpr StemMask kMaskAll = 0b1111;

constexpr StemMask stemBit(Stem s) noexcept
{
    return static_cast<StemMask>(1u << static_cast<unsigned>(s));
}
constexpr bool maskHas(StemMask m, Stem s) noexcept
{
    return (m & stemBit(s)) != 0;
}
/// Toggle one stem, refusing to turn the LAST lit stem off (mask 0 = silence, unrepresentable).
constexpr StemMask toggleStem(StemMask m, Stem s) noexcept
{
    const StemMask next = static_cast<StemMask>(m ^ stemBit(s));
    return (next & kMaskAll) == 0 ? m : static_cast<StemMask>(next & kMaskAll);
}
/// Normalise a persisted value: anything that is not a real partial mask (integer 1..15) means ALL.
constexpr StemMask normalizeMask(long long v) noexcept
{
    return (v >= 1 && v <= 15) ? static_cast<StemMask>(v) : kMaskAll;
}
/// Same, for a JSON double (must be integral to count).
inline StemMask normalizeMaskValue(double v) noexcept
{
    const auto i = static_cast<long long>(v);
    return static_cast<double>(i) == v ? normalizeMask(i) : kMaskAll;
}
inline StemMask absentMask() noexcept
{
    return kMaskAll;
}

/// Sum the enabled stems' channel data into fresh arrays. `stems[stem][channel]` points at `length` floats;
/// a stem with fewer channels than `channels` repeats its last channel (mono stem fills both).
inline std::vector<std::vector<float>> mixMaskChannels(const std::vector<std::vector<const float*>>& stems,
                                                       StemMask mask, int channels, std::size_t length)
{
    std::vector<std::vector<float>> out(static_cast<std::size_t>(channels), std::vector<float>(length, 0.0f));
    for (int s = 0; s < kStemCount; ++s)
    {
        if (!maskHas(mask, static_cast<Stem>(s)) || static_cast<std::size_t>(s) >= stems.size())
            continue;
        const auto& src = stems[static_cast<std::size_t>(s)];
        if (src.empty())
            continue;
        for (int ch = 0; ch < channels; ++ch)
        {
            const float* in =
                src[static_cast<std::size_t>(ch) < src.size() ? static_cast<std::size_t>(ch) : src.size() - 1];
            auto& d = out[static_cast<std::size_t>(ch)];
            for (std::size_t i = 0; i < length; ++i)
                d[i] += in[i];
        }
    }
    return out;
}

// ── ready ranges ─────────────────────────────────────────────────────────────────────────────────
struct ReadyRange
{
    double start = 0.0;
    double end = 0.0;
    bool operator==(const ReadyRange&) const = default;
};

/// Merge a new range into a sorted, disjoint set (touching ranges join). EPS 1e-4.
inline std::vector<ReadyRange> addReadyRange(const std::vector<ReadyRange>& ranges, ReadyRange add)
{
    constexpr double kEps = 1e-4;
    double a = add.start, b = add.end;
    if (!(b > a))
        return ranges;
    std::vector<ReadyRange> out;
    for (const auto& r : ranges)
    {
        if (r.end < a - kEps || r.start > b + kEps)
        {
            out.push_back(r);
            continue;
        }
        a = a < r.start ? a : r.start;
        b = b > r.end ? b : r.end;
    }
    out.push_back({a, b});
    // insertion sort by start (small lists)
    for (std::size_t i = 1; i < out.size(); ++i)
        for (std::size_t j = i; j > 0 && out[j - 1].start > out[j].start; --j)
            std::swap(out[j - 1], out[j]);
    return out;
}

/// Whole span covered by ONE ready range? EPS 1e-3 forgives float edges.
inline bool spanReady(const std::vector<ReadyRange>& ranges, double start, double end) noexcept
{
    constexpr double kEps = 1e-3;
    for (const auto& r : ranges)
        if (r.start <= start + kEps && r.end >= end - kEps)
            return true;
    return false;
}

/// Sanitize a persisted list: drops junk (non-finite, end ≤ start), clamps start ≥ 0, merges, sorts.
/// The caller has already turned JSON into pairs (non-numeric entries must be dropped by the caller).
inline std::vector<ReadyRange> normalizeRanges(const std::vector<ReadyRange>& v)
{
    std::vector<ReadyRange> out;
    for (const auto& r : v)
    {
        if (!std::isfinite(r.start) || !std::isfinite(r.end) || !(r.end > r.start))
            continue;
        out = addReadyRange(out, {r.start < 0.0 ? 0.0 : r.start, r.end});
    }
    return out;
}
} // namespace terminator::stems
