#include "terminator/stems/StemModels.h"

#include <juce_cryptography/juce_cryptography.h>

namespace terminator::stems
{
namespace
{
constexpr const char* kR2Base = "https://pub-17b3d7f0dae24aa8b32405d12d43a870.r2.dev/stems-models/onnx/";

// Filled from the real artifacts before they were uploaded — the same files the Electron app pulls.
const std::vector<ModelFile> kFast{
    {"htdemucs_fp16weights.onnx", 165612636, "d05c269d0178d2a72ad484b10b11dd370193fc923201c3b27a99f848745db70a"}};
const std::vector<ModelFile> kFine{
    {"htdemucs_ft_drums.onnx", 316446953, "f76b68af36066e38885b369299b5032a861038f9b49da5aa6cf1c31cfa69cf27"},
    {"htdemucs_ft_bass.onnx", 316446953, "2a74d9283fc2336fcc58d50f87a7080aff57aea372f65cfe3f0211ea1ff16182"},
    {"htdemucs_ft_other.onnx", 316446953, "90e11806c1bb558ca9d9c7e909d28a2854f7f217982e90482dbed6442513daad"},
    {"htdemucs_ft_vocals.onnx", 316446953, "8c5d5e2da1f27050240bb80236673307ee3b40d4b064066d9350f4d64bfd544d"}};

juce::String& baseUrl()
{
    static juce::String base{kR2Base};
    return base;
}
std::vector<ModelFile>& fastManifest()
{
    static std::vector<ModelFile> m = kFast;
    return m;
}
std::vector<ModelFile>& fineManifest()
{
    static std::vector<ModelFile> m = kFine;
    return m;
}

std::string sha256Of(const juce::File& file)
{
    juce::FileInputStream in(file);
    if (!in.openedOk())
        return {};
    return juce::SHA256(in).toHexString().toStdString();
}
} // namespace

StemModels::StemModels(const juce::File& dataDir) : dir_(dataDir.getChildFile("stems").getChildFile("models")) {}

void StemModels::setDirectory(const juce::File& dir)
{
    if (dir != juce::File())
        dir_ = dir;
}

const std::vector<ModelFile>& StemModels::manifest(Quality q)
{
    return q == Quality::fast ? fastManifest() : fineManifest();
}

std::int64_t StemModels::downloadBytes(Quality q)
{
    std::int64_t total = 0;
    for (const auto& f : manifest(q))
        total += f.bytes;
    return total;
}

juce::File StemModels::fileFor(const ModelFile& f) const
{
    return dir_.getChildFile(juce::String(f.name));
}

std::vector<juce::File> StemModels::paths(Quality q) const
{
    std::vector<juce::File> out;
    for (const auto& f : manifest(q))
        out.push_back(fileFor(f));
    return out;
}

std::vector<std::string> StemModels::pathStrings(Quality q) const
{
    std::vector<std::string> out;
    for (const auto& f : paths(q))
        out.push_back(f.getFullPathName().toStdString());
    return out;
}

bool StemModels::ready(Quality q) const
{
    for (const auto& f : manifest(q))
        if (!fileFor(f).existsAsFile() || fileFor(f).getSize() != f.bytes)
            return false;
    return true;
}

std::vector<StemModels::Info> StemModels::info() const
{
    std::vector<Info> out;
    for (const auto q : {Quality::fast, Quality::fine})
    {
        Info i;
        i.quality = q;
        i.expectedBytes = downloadBytes(q);
        i.ready = ready(q);
        for (const auto& f : manifest(q))
            if (const auto file = fileFor(f); file.existsAsFile())
                i.bytes += file.getSize();
        out.push_back(i);
    }
    return out;
}

ModelError StemModels::downloadOne(const ModelFile& f, std::string& error,
                                   const std::function<void(std::int64_t)>& onBytes,
                                   const std::atomic<bool>* cancel) const
{
    const auto dest = fileFor(f);
    const auto part = dest.withFileExtension(dest.getFileExtension() + ".part");
    part.deleteFile();

    const juce::URL url(baseUrl() + juce::String(f.name));
    auto options = juce::URL::InputStreamOptions(juce::URL::ParameterHandling::inAddress)
                       .withConnectionTimeoutMs(30000)
                       .withNumRedirectsToFollow(5);
    auto in = url.createInputStream(options);
    if (in == nullptr)
    {
        error = "download failed: cannot reach " + url.toString(false).toStdString();
        return ModelError::network;
    }

    {
        juce::FileOutputStream out(part);
        if (!out.openedOk())
        {
            error = "cannot write to " + part.getFullPathName().toStdString();
            return ModelError::disk;
        }
        juce::HeapBlock<char> buffer(1 << 20);
        for (;;)
        {
            if (cancel != nullptr && cancel->load(std::memory_order_relaxed))
            {
                out.flush();
                part.deleteFile();
                error = "cancelled";
                return ModelError::cancelled;
            }
            const auto got = in->read(buffer.getData(), 1 << 20);
            if (got <= 0)
                break;
            if (!out.write(buffer.getData(), static_cast<std::size_t>(got)))
            {
                out.flush();
                part.deleteFile();
                error = "the disk refused the write (out of space?)";
                return ModelError::disk;
            }
            if (onBytes)
                onBytes(got);
        }
        out.flush();
    }

    // A truncated download and a corrupted one look the same from here: both are refused and deleted.
    if (part.getSize() != f.bytes || sha256Of(part) != f.sha256)
    {
        part.deleteFile();
        error = f.name + " failed verification — try again";
        return ModelError::corrupt;
    }
    dest.deleteFile();
    if (!part.moveFileTo(dest))
    {
        part.deleteFile();
        error = "cannot put " + f.name + " in place";
        return ModelError::disk;
    }
    return ModelError::none;
}

ModelError StemModels::ensure(Quality q, std::string& error, const std::function<void(int)>& onProgress,
                              const std::atomic<bool>* cancel)
{
    if (!dir_.createDirectory())
    {
        error = "cannot create " + dir_.getFullPathName().toStdString();
        return ModelError::disk;
    }
    std::vector<ModelFile> missing;
    for (const auto& f : manifest(q))
        if (!fileFor(f).existsAsFile() || fileFor(f).getSize() != f.bytes)
            missing.push_back(f);
    if (missing.empty())
    {
        if (onProgress)
            onProgress(100);
        return ModelError::none;
    }

    std::int64_t total = 0;
    for (const auto& f : missing)
        total += f.bytes;
    std::int64_t got = 0;
    for (const auto& f : missing)
    {
        const auto result = downloadOne(
            f, error,
            [&](std::int64_t n)
            {
                got += n;
                if (onProgress && total > 0)
                    onProgress(static_cast<int>(juce::jlimit<std::int64_t>(0, 100, (got * 100) / total)));
            },
            cancel);
        if (result != ModelError::none)
            return result;
    }
    if (onProgress)
        onProgress(100);
    return ModelError::none;
}

bool StemModels::remove(Quality q, std::string& error)
{
    bool ok = true;
    for (const auto& f : manifest(q))
    {
        const auto file = fileFor(f);
        if (file.existsAsFile() && !file.deleteFile())
        {
            ok = false;
            error = "cannot delete " + file.getFullPathName().toStdString();
        }
    }
    return ok;
}

void StemModels::setBaseUrlForTests(const juce::String& base)
{
    baseUrl() = base.isEmpty() ? juce::String(kR2Base) : base;
}

void StemModels::setManifestForTests(std::vector<ModelFile> fast, std::vector<ModelFile> fine)
{
    fastManifest() = std::move(fast);
    fineManifest() = std::move(fine);
}

void StemModels::clearTestOverrides()
{
    baseUrl() = kR2Base;
    fastManifest() = kFast;
    fineManifest() = kFine;
}
} // namespace terminator::stems
