#pragma once
// BLOCKS — pure ports of ChopperEngine's source/block layout planners (dossier §1.4 / §3 SOURCES+BLOCKS). A
// BLOCK is a contiguous run of pads sharing a source key; blocks move as a unit and PUSH other blocks aside
// (never overwrite). These operate on the abstract "source key per pad slot" array (empty = std::nullopt); the
// Document applies the resulting index map to the real pad nodes + remaps sequencer steps.
#include <cstddef>
#include <optional>
#include <string>
#include <utility>
#include <vector>

namespace terminator::blocks
{
using Key = std::optional<std::string>; // the padSourceKey of a slot; nullopt = empty pad
using Slots = std::vector<Key>;

/// [lo, hi] of the contiguous run sharing pad `idx`'s key, or nullopt if the pad is empty.
inline std::optional<std::pair<int, int>> blockRange(const Slots& s, int idx)
{
    if (idx < 0 || idx >= static_cast<int>(s.size()) || !s[static_cast<std::size_t>(idx)].has_value())
        return std::nullopt;
    const auto& key = s[static_cast<std::size_t>(idx)];
    int lo = idx, hi = idx;
    while (lo > 0 && s[static_cast<std::size_t>(lo - 1)] == key)
        --lo;
    while (hi + 1 < static_cast<int>(s.size()) && s[static_cast<std::size_t>(hi + 1)] == key)
        ++hi;
    return std::make_pair(lo, hi);
}

/// Where a NEW chop of `key` goes: right after its block; a source with no block yet → the first empty pad.
inline int nextSlotForSource(const Slots& s, const std::string& key)
{
    int hi = -1;
    for (int i = 0; i < static_cast<int>(s.size()); ++i)
        if (s[static_cast<std::size_t>(i)] == key)
            hi = i;
    if (hi >= 0)
        return hi + 1;
    for (int i = 0;; ++i)
        if (i >= static_cast<int>(s.size()) || !s[static_cast<std::size_t>(i)].has_value())
            return i;
}

/// How many empty pads sit right after pad `idx`'s block — the room it can keep chopping into (scan ≤ 64).
struct Room
{
    int at = 0;
    int free = 0;
};
inline Room roomAfterBlock(const Slots& s, int idx)
{
    const auto range = blockRange(s, idx);
    Room r;
    r.at = range ? range->second + 1
                 : nextSlotForSource(s, s[static_cast<std::size_t>(idx)].value_or(std::string("main")));
    while (r.free < 64)
    {
        const int p = r.at + r.free;
        if (p < static_cast<int>(s.size()) && s[static_cast<std::size_t>(p)].has_value())
            break;
        ++r.free;
    }
    return r;
}

/// Insert `items` at `pos`, pushing the occupied run that starts there to the right (the first empty pad
/// absorbs it). `origin[i]` = the old index now at i (−1 = new content). Mutates slots/origin in place, growing
/// them (this is ChopperEngine.insertPushing exactly).
inline void insertPushing(Slots& slots, std::vector<int>& origin, int pos, const Slots& items)
{
    for (std::size_t k = 0; k < items.size(); ++k)
    {
        const int at = pos + static_cast<int>(k);
        while (static_cast<int>(slots.size()) <= at)
        {
            slots.push_back(std::nullopt);
            origin.push_back(-1);
        }
        int q = at;
        while (q < static_cast<int>(slots.size()) && slots[static_cast<std::size_t>(q)].has_value())
            ++q;
        if (q == static_cast<int>(slots.size()))
        {
            slots.push_back(std::nullopt);
            origin.push_back(-1);
        }
        for (int i = q; i > at; --i)
        {
            slots[static_cast<std::size_t>(i)] = slots[static_cast<std::size_t>(i - 1)];
            origin[static_cast<std::size_t>(i)] = origin[static_cast<std::size_t>(i - 1)];
        }
        slots[static_cast<std::size_t>(at)] = items[k];
        origin[static_cast<std::size_t>(at)] = -1;
    }
}

/// The old→new index map for dropping `from`'s block on `to` (moveBlock). Singles swap. Returns pairs of
/// (oldIndex, newIndex) for every slot that moves; empty when the move is a no-op. This is planMoveBlock — a
/// dry run the caller applies to the real pad nodes.
struct MovePlan
{
    std::vector<std::pair<int, int>> moves; // (old, new) for every slot that changes index
    std::vector<int> landing;               // the block's final indices
    std::vector<int> origin;                // new index -> old index for the WHOLE array (-1 = now empty)
    bool valid = false;
};
inline MovePlan planMoveBlock(const Slots& in, int from, int to)
{
    MovePlan plan;
    const auto range = blockRange(in, from);
    if (!range)
        return plan;
    const int lo = range->first, hi = range->second;
    if (to >= lo && to <= hi)
        return plan;
    const int len = hi - lo + 1;
    const auto destRange = blockRange(in, to);
    // singles swap (a one-wide block onto a one-wide block, or onto an empty pad)
    if (len == 1 && (!destRange || destRange->first == destRange->second))
    {
        plan.valid = true;
        const int m = std::max<int>(static_cast<int>(in.size()), to + 1);
        plan.origin.resize(static_cast<std::size_t>(m));
        for (int i = 0; i < m; ++i)
            plan.origin[static_cast<std::size_t>(i)] = i;
        plan.origin[static_cast<std::size_t>(to)] = from;
        plan.origin[static_cast<std::size_t>(from)] = destRange ? to : -1; // empty dest → the source vacates
        plan.moves.push_back({from, to});
        if (destRange)
            plan.moves.push_back({to, from});
        plan.landing = {to};
        return plan;
    }
    // build the slot/origin arrays and run insertPushing
    const int n = std::max<int>(static_cast<int>(in.size()), to + len);
    Slots slots(in.begin(), in.end());
    slots.resize(static_cast<std::size_t>(n), std::nullopt);
    std::vector<int> origin(static_cast<std::size_t>(n));
    for (int i = 0; i < n; ++i)
        origin[static_cast<std::size_t>(i)] = i;
    Slots items(slots.begin() + lo, slots.begin() + hi + 1);
    std::vector<int> origins(origin.begin() + lo, origin.begin() + hi + 1);
    for (int i = lo; i <= hi; ++i)
    {
        slots[static_cast<std::size_t>(i)] = std::nullopt;
        origin[static_cast<std::size_t>(i)] = -1;
    }
    insertPushing(slots, origin, to, items);
    for (std::size_t k = 0; k < items.size(); ++k)
        origin[static_cast<std::size_t>(to + static_cast<int>(k))] = origins[k];
    plan.valid = true;
    plan.origin = origin;
    for (int i = 0; i < static_cast<int>(origin.size()); ++i)
        if (origin[static_cast<std::size_t>(i)] >= 0 && origin[static_cast<std::size_t>(i)] != i)
            plan.moves.push_back({origin[static_cast<std::size_t>(i)], i});
    for (int k = 0; k < len; ++k)
        plan.landing.push_back(to + k);
    return plan;
}
} // namespace terminator::blocks
