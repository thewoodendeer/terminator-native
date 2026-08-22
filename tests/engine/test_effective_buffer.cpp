// EFFECTIVE BUFFER — the SampleBuffer wrapper over trims::buildEffectiveChannels (the ramp math itself is gated
// in test_planners_core): length = file − trimmed frames, seam ramps exact, rate/channels preserved, id 0; zero
// trims keep the SAME buffer; stems are cut with the same list and stay aligned with the original.
#include <catch2/catch_approx.hpp>
#include <catch2/catch_test_macros.hpp>

#include <memory>

#include "TestSamples.h"
#include "terminator/analysis/EffectiveBuffer.h"

using namespace terminator;
using namespace terminator::analysis;
using Catch::Approx;

TEST_CASE("EffectiveBuffer: kept ranges concatenated with 3 ms seam ramps; rate/channels kept, id 0",
          "[analysis][trims]")
{
    const double rate = 1000.0; // 3 ms = 3 frames, like the planner test
    auto file = test::dc(100, 1.0f, rate, 2);
    file->id = 42;
    trims::TrimList t = {{0.02, 0.05, {}}}; // cut frames [20, 50)
    auto eff = buildEffectiveBuffer(*file, t);
    REQUIRE(eff != nullptr);
    CHECK(eff->numFrames == 70);
    CHECK(eff->numChannels == 2);
    CHECK(eff->sampleRate == rate);
    CHECK(eff->id == 0);
    CHECK(eff->data.size() == 140);
    for (int ch = 0; ch < 2; ++ch)
    {
        const float* d = eff->channel(ch);
        CHECK(d[16] == 1.0f);
        CHECK(d[17] == Approx(2.0 / 3).margin(1e-6)); // ramp OUT into the seam
        CHECK(d[18] == Approx(1.0 / 3).margin(1e-6));
        CHECK(d[19] == Approx(0.0).margin(1e-6));
        CHECK(d[20] == Approx(1.0 / 3).margin(1e-6)); // ramp IN out of it
        CHECK(d[21] == Approx(2.0 / 3).margin(1e-6));
        CHECK(d[22] == Approx(1.0).margin(1e-6));
        CHECK(d[0] == 1.0f);
        CHECK(d[69] == 1.0f);
    }
    // the original is untouched
    CHECK(file->numFrames == 100);
    CHECK(file->channel(0)[19] == 1.0f);

    SECTION("two trims remove both spans; a trim past the end is clamped")
    {
        trims::TrimList two = {{0.01, 0.02, {}}, {0.08, 0.2, {}}}; // [10,20) + [80,100)
        auto e2 = buildEffectiveBuffer(*file, two);
        CHECK(e2->numFrames == 70);
    }
    SECTION("empty trims: buildEffectiveBuffer copies, effectiveOrSame returns the SAME buffer")
    {
        auto copy = buildEffectiveBuffer(*file, {});
        CHECK(copy->numFrames == 100);
        CHECK(copy.get() != file.get());
        CHECK(copy->id == 0);
        CHECK(effectiveOrSame(file, {}).get() == file.get());
        CHECK(effectiveOrSame(file, t).get() != file.get());
        CHECK(effectiveOrSame(file, t)->numFrames == 70);
        CHECK(effectiveOrSame(nullptr, t) == nullptr);
    }
}

TEST_CASE("EffectiveBuffer: stems are cut with the same list and stay aligned; null planes stay null",
          "[analysis][trims][stems]")
{
    const double rate = 1000.0;
    auto file = test::ramp(100, rate);
    StemPlanes planes = {test::ramp(100, rate), test::dc(100, 0.5f, rate), nullptr, test::dc(100, 0.25f, rate)};
    trims::TrimList t = {{0.02, 0.05, {}}};
    auto eff = buildEffectiveBuffer(*file, t);
    auto effStems = buildEffectiveStems(planes, t);
    REQUIRE(effStems[0] != nullptr);
    REQUIRE(effStems[1] != nullptr);
    CHECK(effStems[2] == nullptr);
    REQUIRE(effStems[3] != nullptr);
    for (auto k : {0, 1, 3})
        CHECK(effStems[static_cast<std::size_t>(k)]->numFrames == eff->numFrames);
    // plane 0 == the original ramp → its effective copy is sample-identical to the effective original
    for (std::int64_t i = 0; i < eff->numFrames; ++i)
        REQUIRE(effStems[0]->channel(0)[i] == eff->channel(0)[i]);
    // frame 25 of the effective timeline = file frame 55 (after the 30-frame cut): the ramp value at 55
    CHECK(eff->channel(0)[25] == Approx(55.0f / 99.0f).margin(1e-6));
    // zero trims = the same plane objects
    auto same = buildEffectiveStems(planes, {});
    CHECK(same[0].get() == planes[0].get());
    CHECK(same[2] == nullptr);
}
