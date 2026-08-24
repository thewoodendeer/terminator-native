// THE MODEL RUNNER (Phase 7.1b) — onnxruntime loaded BY HAND (never linked, so the app keeps its macOS 12
// floor while the runtime itself needs 13.4), and a chunk run through a real htdemucs when one is on the
// machine. Point TERMINATOR_STEMS_MODEL at htdemucs_fp16weights.onnx to include the inference case; without it
// that one case skips (a 166 MB model is not a repo fixture).
#include <catch2/catch_test_macros.hpp>

#include <cmath>
#include <string>
#include <vector>

#include <juce_core/juce_core.h>

#include "terminator/stems/SplitSession.h"
#include "terminator/stems/StemModel.h"

using namespace terminator::stems;

TEST_CASE("Stems model: the onnxruntime is loaded dynamically, not linked", "[stems][ort]")
{
    std::string error;
    REQUIRE(StemModel::ensureRuntime(error));
    INFO("runtime: " << StemModel::runtimePath());
    REQUIRE_FALSE(StemModel::runtimeVersion().empty());
    // Idempotent: a second call is a no-op, not a second dlopen.
    REQUIRE(StemModel::ensureRuntime(error));
}

TEST_CASE("Stems model: a missing or malformed model fails cleanly", "[stems][ort]")
{
    StemModel model;
    std::string error;
    REQUIRE_FALSE(model.load({"/does/not/exist/htdemucs.onnx"}, error));
    REQUIRE_FALSE(error.empty());
    REQUIRE_FALSE(model.loaded());
    // Two or three files is neither FAST (1) nor FINE (4).
    REQUIRE_FALSE(model.load({"a.onnx", "b.onnx"}, error));
    REQUIRE_FALSE(model.loaded());
    // Running without a model is an error, not a crash.
    std::vector<float> mix(static_cast<std::size_t>(2 * kSegment), 0.0f);
    std::vector<float> rows(static_cast<std::size_t>(kStemRows * 2 * kSegment), 0.0f);
    REQUIRE_FALSE(model.run(mix.data(), rows.data(), error));
}

TEST_CASE("Stems model: a real htdemucs chunk comes back finite and shaped", "[stems][ort][model]")
{
    // juce's reader rather than std::getenv: MSVC deprecates getenv and the Windows build is /WX.
    const auto path = juce::SystemStats::getEnvironmentVariable("TERMINATOR_STEMS_MODEL", {});
    if (path.isEmpty())
        SKIP("set TERMINATOR_STEMS_MODEL to htdemucs_fp16weights.onnx to run this case");

    StemModel model;
    std::string error;
    REQUIRE(model.load({path.toStdString()}, error));
    REQUIRE(model.modelCount() == 1);

    // A quiet chunk with one tone in it: the point is the plumbing (shape, finiteness, no NaN), not the split.
    std::vector<float> mix(static_cast<std::size_t>(2 * kSegment), 0.0f);
    for (std::int64_t i = 0; i < kSegment; ++i)
    {
        const auto v =
            static_cast<float>(0.2 * std::sin(2.0 * 3.14159265358979 * 220.0 * static_cast<double>(i) / kModelRate));
        mix[static_cast<std::size_t>(i)] = v;
        mix[static_cast<std::size_t>(kSegment + i)] = v;
    }
    std::vector<float> rows(static_cast<std::size_t>(kStemRows * 2 * kSegment), 1e9f);
    REQUIRE(model.run(mix.data(), rows.data(), error));
    for (std::size_t i = 0; i < rows.size(); i += 977)
    {
        REQUIRE(std::isfinite(rows[i]));
        REQUIRE(std::abs(rows[i]) <= 4.0f);
    }
    // The four rows are not all the same buffer (something was actually separated).
    double energy[kStemRows] = {0, 0, 0, 0};
    for (int k = 0; k < kStemRows; ++k)
        for (std::int64_t i = 0; i < 2 * kSegment; i += 13)
        {
            const double v = static_cast<double>(rows[static_cast<std::size_t>(k * 2 * kSegment + i)]);
            energy[k] += v * v;
        }
    REQUIRE(energy[0] != energy[1]);
    REQUIRE(energy[2] != energy[3]);
}
