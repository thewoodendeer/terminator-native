// THE MODEL MANAGER (Phase 7.1c) — the files a split needs, downloaded once, verified, deletable. The gates
// run against a LOCAL fixture "server" (a temp directory served as file:// URLs) with a tiny manifest, so
// nothing here touches R2 or a 166 MB file: what is being tested is the size + SHA-256 contract, the partial
// file never surviving, the progress, cancel, and the paths a split is handed.
#include <catch2/catch_test_macros.hpp>

#include <atomic>
#include <string>
#include <vector>

#include <juce_core/juce_core.h>
#include <juce_cryptography/juce_cryptography.h>

#include "terminator/stems/StemModels.h"

using namespace terminator::stems;

namespace
{
struct Fixture
{
    juce::File root{juce::File::getSpecialLocation(juce::File::tempDirectory)
                        .getChildFile("terminator-stems-models-" + juce::Uuid().toDashedString())};
    juce::File server{root.getChildFile("server")};
    juce::File data{root.getChildFile("data")};

    Fixture()
    {
        server.createDirectory();
        data.createDirectory();
        StemModels::setBaseUrlForTests(juce::URL(server).toString(false) + "/");
    }
    ~Fixture()
    {
        StemModels::clearTestOverrides();
        root.deleteRecursively();
    }

    /// A deterministic little "model" on the fixture server, and its manifest entry.
    ModelFile put(const juce::String& name, int bytes, std::uint32_t seed, bool corruptTheHash = false)
    {
        juce::MemoryBlock block(static_cast<std::size_t>(bytes));
        auto* p = static_cast<std::uint8_t*>(block.getData());
        std::uint32_t s = seed;
        for (int i = 0; i < bytes; ++i)
        {
            s = s * 1664525u + 1013904223u;
            p[i] = static_cast<std::uint8_t>(s >> 24);
        }
        const auto file = server.getChildFile(name);
        file.replaceWithData(block.getData(), block.getSize());
        ModelFile entry;
        entry.name = name.toStdString();
        entry.bytes = bytes;
        entry.sha256 = juce::SHA256(block.getData(), block.getSize()).toHexString().toStdString();
        if (corruptTheHash)
            entry.sha256[0] = entry.sha256[0] == 'a' ? 'b' : 'a';
        return entry;
    }
};
} // namespace

TEST_CASE("Stem models: a download is verified, reported and put in place", "[stems][models]")
{
    Fixture fx;
    const auto a = fx.put("tiny_fast.onnx", 4096, 11);
    StemModels::setManifestForTests({a}, {});
    StemModels models(fx.data);

    REQUIRE_FALSE(models.ready(Quality::fast));
    REQUIRE(models.info()[0].expectedBytes == 4096);
    REQUIRE(models.info()[0].bytes == 0);

    std::vector<int> ticks;
    std::string error;
    REQUIRE(models.ensure(Quality::fast, error, [&](int pct) { ticks.push_back(pct); }) == ModelError::none);
    REQUIRE(error.empty());
    REQUIRE(models.ready(Quality::fast));
    REQUIRE(models.info()[0].bytes == 4096);
    REQUIRE_FALSE(ticks.empty());
    REQUIRE(ticks.back() == 100);
    REQUIRE(models.paths(Quality::fast).size() == 1u);
    REQUIRE(models.paths(Quality::fast)[0].getFileName() == "tiny_fast.onnx");
    // No .part left behind, and a second ensure is a no-op that still reports done.
    REQUIRE(models.directory().getNumberOfChildFiles(juce::File::findFiles, "*.part") == 0);
    ticks.clear();
    REQUIRE(models.ensure(Quality::fast, error, [&](int pct) { ticks.push_back(pct); }) == ModelError::none);
    REQUIRE(ticks == std::vector<int>{100});
}

TEST_CASE("Stem models: a file whose bytes do not match its hash is refused and deleted", "[stems][models][gate]")
{
    Fixture fx;
    const auto bad = fx.put("wrong_hash.onnx", 2048, 21, /*corruptTheHash=*/true);
    StemModels::setManifestForTests({bad}, {});
    StemModels models(fx.data);

    std::string error;
    REQUIRE(models.ensure(Quality::fast, error) == ModelError::corrupt);
    REQUIRE_FALSE(error.empty());
    REQUIRE_FALSE(models.ready(Quality::fast));
    // Neither the part file nor a half-written model survives — the next try starts clean.
    REQUIRE(models.directory().getNumberOfChildFiles(juce::File::findFiles, "*") == 0);
}

TEST_CASE("Stem models: a file that is not on the server is a network error", "[stems][models]")
{
    Fixture fx;
    ModelFile absent;
    absent.name = "not_uploaded.onnx";
    absent.bytes = 1024;
    absent.sha256 = std::string(64, '0');
    StemModels::setManifestForTests({absent}, {});
    StemModels models(fx.data);

    std::string error;
    const auto result = models.ensure(Quality::fast, error);
    REQUIRE((result == ModelError::network || result == ModelError::corrupt));
    REQUIRE_FALSE(models.ready(Quality::fast));
    REQUIRE(models.directory().getNumberOfChildFiles(juce::File::findFiles, "*") == 0);
}

TEST_CASE("Stem models: FINE is four files in row order, and delete frees the disk", "[stems][models]")
{
    Fixture fx;
    const std::vector<ModelFile> fine{fx.put("ft_drums.onnx", 1024, 31), fx.put("ft_bass.onnx", 1024, 32),
                                      fx.put("ft_other.onnx", 1024, 33), fx.put("ft_vocals.onnx", 1024, 34)};
    StemModels::setManifestForTests({fx.put("fast.onnx", 512, 30)}, fine);
    StemModels models(fx.data);

    std::string error;
    REQUIRE(models.ensure(Quality::fine, error) == ModelError::none);
    REQUIRE(models.ready(Quality::fine));
    REQUIRE(StemModels::downloadBytes(Quality::fine) == 4096);
    const auto paths = models.pathStrings(Quality::fine);
    REQUIRE(paths.size() == 4u);
    REQUIRE(juce::String(paths[0]).endsWith("ft_drums.onnx"));
    REQUIRE(juce::String(paths[3]).endsWith("ft_vocals.onnx"));
    // FAST is a separate engine: FINE being here says nothing about it.
    REQUIRE_FALSE(models.ready(Quality::fast));

    REQUIRE(models.remove(Quality::fine, error));
    REQUIRE_FALSE(models.ready(Quality::fine));
    REQUIRE(models.info()[1].bytes == 0);
}

TEST_CASE("Stem models: cancel leaves nothing half-written, and the folder can move", "[stems][models]")
{
    Fixture fx;
    StemModels::setManifestForTests({fx.put("cancelled.onnx", 8192, 41)}, {});
    StemModels models(fx.data);

    std::atomic<bool> cancel{true};
    std::string error;
    REQUIRE(models.ensure(Quality::fast, error, {}, &cancel) == ModelError::cancelled);
    REQUIRE_FALSE(models.ready(Quality::fast));
    REQUIRE(models.directory().getNumberOfChildFiles(juce::File::findFiles, "*") == 0);

    // Preferences -> FOLDERS relocation: the same files, somewhere else (an already-downloaded folder is
    // adopted as-is, which is how a machine that has the Electron app's models skips the download).
    const auto moved = fx.root.getChildFile("elsewhere");
    moved.createDirectory();
    models.setDirectory(moved);
    REQUIRE(models.directory() == moved);
    cancel = false;
    REQUIRE(models.ensure(Quality::fast, error, {}, &cancel) == ModelError::none);
    REQUIRE(models.ready(Quality::fast));
    REQUIRE(moved.getChildFile("cancelled.onnx").existsAsFile());
}
