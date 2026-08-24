#pragma once
// THE MODELS ON DISK (Phase 7.1c) — htdemucs as ONNX, downloaded once and kept forever.
//
// The models are NOT bundled with the app (166 MB for FAST, 1.2 GB for FINE): the first time a quality is
// used, its files come down from R2 into <dataDir>/stems/models and every later split starts instantly and
// offline. Same files, same URLs and the same SHA-256s as the Electron app — a machine that already has them
// can point the folder at the old location and never download again.
//
// Every file is size- AND hash-checked after the download; a partial or corrupt file is deleted and reported.
// `ensure()` blocks, so it belongs on a background thread; it is safe to call from one thread at a time per
// instance.
//
// The rule the manifest inherits from the updater: NEVER repoint a name at different bytes. A new export gets
// a NEW filename.
#include <atomic>
#include <functional>
#include <string>
#include <vector>

#include <juce_core/juce_core.h>

namespace terminator::stems
{
enum class Quality
{
    fast, // one model, htdemucs fp16 weights (~166 MB)
    fine  // the htdemucs_ft bag: four specialists (~316 MB each), one per stem row
};

/// FINE's four files are in the model's row order: drums, bass, other, vocals.
struct ModelFile
{
    std::string name;
    std::int64_t bytes = 0;
    std::string sha256;
};

enum class ModelError
{
    none,
    network,
    disk,
    corrupt,
    cancelled
};

class StemModels
{
  public:
    struct Info
    {
        Quality quality = Quality::fast;
        std::int64_t bytes = 0;         // what is on disk now
        std::int64_t expectedBytes = 0; // the full download, so an absent engine can say how big it is
        bool ready = false;
    };

    /// `dataDir` is the app's data directory; the models live in `<dataDir>/stems/models`.
    explicit StemModels(const juce::File& dataDir);

    /// Preferences → FOLDERS can relocate the models (an empty File = back to the default).
    void setDirectory(const juce::File& dir);
    juce::File directory() const { return dir_; }

    static const std::vector<ModelFile>& manifest(Quality q);
    static std::int64_t downloadBytes(Quality q);

    /// Absolute paths in manifest order. Only meaningful when `ready(q)`.
    std::vector<juce::File> paths(Quality q) const;
    std::vector<std::string> pathStrings(Quality q) const;
    /// Every file present at its exact size.
    bool ready(Quality q) const;
    std::vector<Info> info() const;

    /// Download whatever is missing, verifying size + SHA-256. Blocking. `onProgress` gets 0..100 of the whole
    /// job; `cancel`, when it turns true, aborts and leaves nothing half-written.
    ModelError ensure(Quality q, std::string& error, const std::function<void(int)>& onProgress = {},
                      const std::atomic<bool>* cancel = nullptr);

    /// Free the disk (the next split downloads again).
    bool remove(Quality q, std::string& error);

    /// Test seam: point the manifest at a local fixture server / directory so a gate never touches R2 or a
    /// 166 MB file. An empty string restores the real base.
    static void setBaseUrlForTests(const juce::String& base);
    static void setManifestForTests(std::vector<ModelFile> fast, std::vector<ModelFile> fine);
    static void clearTestOverrides();

  private:
    juce::File fileFor(const ModelFile& f) const;
    ModelError downloadOne(const ModelFile& f, std::string& error, const std::function<void(std::int64_t)>& onBytes,
                           const std::atomic<bool>* cancel) const;

    juce::File dir_;
};
} // namespace terminator::stems
