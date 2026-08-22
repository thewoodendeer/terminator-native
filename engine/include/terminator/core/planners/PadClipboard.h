#pragma once
// PAD CLIPBOARD — pure port of src/renderer/chopper/padClipboard.ts (copy / cut / paste / duplicate / clear
// over pad slots). The plans here are JUCE-free: they take slot descriptors (what a pad holds, which pads are
// occupied) and return the order / destinations; the Document applies them (one undo batch per operation).
// A chop entry remembers its REGION as well as its id: clearing the source after a copy splices the chop out
// of the waveform, and a paste of the bare id would land a silent, dead pad — reviveChop rebuilds it.
#include <algorithm>
#include <optional>
#include <set>
#include <string>
#include <utility>
#include <vector>

namespace terminator::padclip
{
/// The clipboard/paste grid bound — the 64 pads every layout actually shows (4 banks x 16).
inline constexpr int kPadGridMax = 64;

/// What a pad holds, in a form that can be copied to another pad (padClipboard.ts PadContent).
struct PadContent
{
    enum class Type
    {
        chop,  // a main-track chop: id + region (for revive), stems + reverse travel with it
        buffer // the pad's own sample: videoId/title + trim [start, end)
    };
    Type type = Type::chop;
    int chopId = -1; // chop
    double start = 0.0;
    double end = 0.0;
    std::string videoId; // buffer
    std::string title;
    // the pad's play settings — travel with the content and are always written on paste
    double pitch = 0.0;
    std::string mode = "oneshot";
    bool gate = false;
    double fadeIn = 0.0;
    double fadeOut = 0.0;
    int stems = 15;              // chop only; 15 = ALL
    std::optional<bool> reverse; // chop only; nullopt = follow the source
    bool operator==(const PadContent&) const = default;
};

/// First empty pad after `idx`, wrapping to the front, below `limit` (the free-tier lock line caps it below
/// kPadGridMax). -1 when full. `taken` holds slots already claimed earlier in the same operation — the model
/// lags within a batch, so a multi-pad op must track its own. `occupied(i)` = the pad holds content.
template <typename Occupied>
inline int firstEmptyAfter(const Occupied& occupied, int idx, const std::set<int>& taken, int limit = kPadGridMax)
{
    const int cap = std::min(limit, kPadGridMax);
    auto isFree = [&](int i) { return taken.count(i) == 0 && !occupied(i); };
    for (int i = idx + 1; i < cap; ++i)
        if (isFree(i))
            return i;
    for (int i = 0; i < idx && i < cap; ++i)
        if (isFree(i))
            return i;
    return -1;
}

/// Copy order: pad order ascending (the caller skips empties).
inline std::vector<int> copyOrder(std::vector<int> idxs)
{
    std::sort(idxs.begin(), idxs.end());
    return idxs;
}

/// Paste onto consecutive pads starting at `at`, never past `limit`: (destination, item index) pairs. Items
/// beyond the cap are dropped — the caller tells the user. Empty when nothing lands.
inline std::vector<std::pair<int, int>> pastePlan(int at, int nItems, int limit = kPadGridMax)
{
    std::vector<std::pair<int, int>> out;
    const int cap = std::min(limit, kPadGridMax);
    if (nItems <= 0 || at >= cap)
        return out;
    for (int k = 0; k < nItems; ++k)
        if (at + k < cap)
            out.emplace_back(at + k, k);
    return out;
}

/// Clear order: occupied pads back-to-front (clearPad splices a chop out of the waveform and merges its region
/// into a neighbour, so clearing low-to-high would move the ground under later targets).
template <typename Occupied> inline std::vector<int> clearOrder(const std::vector<int>& idxs, const Occupied& occupied)
{
    std::vector<int> list;
    for (int i : idxs)
        if (occupied(i))
            list.push_back(i);
    std::sort(list.begin(), list.end(), [](int a, int b) { return b < a; });
    return list;
}

/// Cut = copy, then EMPTY the pads (unassign, never clearPad — the chop must survive for the paste). The
/// pads to empty, in the caller's order, occupied only.
template <typename Occupied> inline std::vector<int> cutOrder(const std::vector<int>& idxs, const Occupied& occupied)
{
    std::vector<int> list;
    for (int i : idxs)
        if (occupied(i))
            list.push_back(i);
    return list;
}

/// Duplicate pads onto the free slots after them (never past `limit`): (source, destination) pairs in pad
/// order. `hasContent(i)` = the pad can be copied; `occupied(i)` = the slot is taken. Stops at the first
/// pad with no room (what the TS `break` does).
template <typename HasContent, typename Occupied>
inline std::vector<std::pair<int, int>> duplicatePlan(std::vector<int> idxs, const HasContent& hasContent,
                                                      const Occupied& occupied, int limit = kPadGridMax)
{
    std::vector<std::pair<int, int>> out;
    std::sort(idxs.begin(), idxs.end());
    if (idxs.empty())
        return out;
    std::set<int> taken;
    int dest = idxs.back();
    for (int t : idxs)
    {
        if (!hasContent(t))
            continue;
        dest = firstEmptyAfter(occupied, dest, taken, limit);
        if (dest < 0)
            break;
        taken.insert(dest);
        out.emplace_back(t, dest);
    }
    return out;
}
} // namespace terminator::padclip
