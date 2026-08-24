#include "terminator/stems/StemModel.h"

#include <algorithm>
#include <array>
#include <cstdlib>
#include <mutex>

#define ORT_API_MANUAL_INIT
#include <onnxruntime_cxx_api.h>
#undef ORT_API_MANUAL_INIT

#if defined(_WIN32)
#include <windows.h>
#else
#include <dlfcn.h>
#endif

#include "terminator/stems/SplitSession.h"

namespace terminator::stems
{
namespace
{
constexpr std::int64_t kMixFloats = 2 * kSegment;
constexpr std::int64_t kRowFloats = 2 * kSegment;

/// The one symbol we resolve by hand; everything else rides the OrtApi table it hands back.
using GetApiBaseFn = const OrtApiBase*(ORT_API_CALL*)();

std::mutex& runtimeMutex()
{
    static std::mutex m;
    return m;
}

#if defined(_WIN32)
/// UTF-8 -> UTF-16 the way Windows needs it: a plain char-by-char widening mangles any path with an accent in
/// it, and a user's model folder is a user's folder.
std::wstring widen(const std::string& utf8)
{
    if (utf8.empty())
        return {};
    const int n = ::MultiByteToWideChar(CP_UTF8, 0, utf8.c_str(), static_cast<int>(utf8.size()), nullptr, 0);
    std::wstring out(static_cast<std::size_t>(n), L'\0');
    ::MultiByteToWideChar(CP_UTF8, 0, utf8.c_str(), static_cast<int>(utf8.size()), out.data(), n);
    return out;
}
#endif

std::string& loadedPath()
{
    static std::string path;
    return path;
}
std::string& loadedVersion()
{
    static std::string version;
    return version;
}

/// Where the runtime can be: an explicit path, the env override (dev/CI), the compiled-in provisioned path
/// (dev builds), then the names the OS loader itself knows (a copy shipped beside the app).
std::vector<std::string> runtimeCandidates(const std::string& override)
{
    std::vector<std::string> out;
    if (!override.empty())
        out.push_back(override);
    if (const char* env = std::getenv("TERMINATOR_ORT_LIB"); env != nullptr && *env != 0)
        out.emplace_back(env);
#if defined(TERMINATOR_ORT_DYLIB_PATH)
    out.emplace_back(TERMINATOR_ORT_DYLIB_PATH);
#endif
#if defined(_WIN32)
    out.emplace_back("onnxruntime.dll");
#elif defined(__APPLE__)
    out.emplace_back("@loader_path/../Frameworks/libonnxruntime.dylib");
    out.emplace_back("libonnxruntime.dylib");
#else
    out.emplace_back("libonnxruntime.so");
#endif
    return out;
}
} // namespace

bool StemModel::ensureRuntime(std::string& error, const std::string& overridePath)
{
    const std::lock_guard lock(runtimeMutex());
    if (!loadedVersion().empty())
        return true;
    std::string tried;
    for (const auto& candidate : runtimeCandidates(overridePath))
    {
#if defined(_WIN32)
        const std::wstring wide = widen(candidate);
        HMODULE handle = ::LoadLibraryW(wide.c_str());
        auto* symbol = handle != nullptr ? ::GetProcAddress(handle, "OrtGetApiBase") : nullptr;
#else
        void* handle = ::dlopen(candidate.c_str(), RTLD_LAZY | RTLD_LOCAL);
        auto* symbol = handle != nullptr ? ::dlsym(handle, "OrtGetApiBase") : nullptr;
#endif
        if (handle == nullptr || symbol == nullptr)
        {
            tried += (tried.empty() ? "" : ", ") + candidate;
            continue;
        }
        const auto* base = reinterpret_cast<GetApiBaseFn>(symbol)();
        const auto* api = base != nullptr ? base->GetApi(ORT_API_VERSION) : nullptr;
        if (api == nullptr)
        {
            // The library is there but too old for the API version these headers were built against.
            tried +=
                (tried.empty() ? "" : ", ") + candidate + " (API " + std::to_string(ORT_API_VERSION) + " unsupported)";
            continue;
        }
        Ort::InitApi(api);
        loadedPath() = candidate;
        loadedVersion() = base->GetVersionString();
        return true;
    }
    error = "onnxruntime could not be loaded (tried " + tried +
            "). On macOS the runtime needs 13.4 or newer — everything else in Terminator runs on 12.";
    return false;
}

std::string StemModel::runtimePath()
{
    return loadedPath();
}

struct StemModel::Impl
{
    // Constructed on the first load(), never at static-init time: the API table has to be in place first.
    std::unique_ptr<Ort::Env> env;
    std::vector<Ort::Session> sessions;
    std::vector<std::string> inputNames;  // one per session
    std::vector<std::string> outputNames; // one per session
    std::unique_ptr<Ort::MemoryInfo> memory;
};

StemModel::StemModel() : impl_(std::make_unique<Impl>()) {}
StemModel::~StemModel() = default;

bool StemModel::loaded() const noexcept
{
    return impl_ != nullptr && !impl_->sessions.empty();
}

int StemModel::modelCount() const noexcept
{
    return impl_ == nullptr ? 0 : static_cast<int>(impl_->sessions.size());
}

std::string StemModel::runtimeVersion()
{
    return loadedVersion();
}

void StemModel::unload()
{
    if (impl_ == nullptr)
        return;
    impl_->sessions.clear();
    impl_->inputNames.clear();
    impl_->outputNames.clear();
}

bool StemModel::load(const std::vector<std::string>& modelPaths, std::string& error, int intraOpThreads)
{
    unload();
    if (!ensureRuntime(error))
        return false;
    if (modelPaths.empty() || (modelPaths.size() != 1 && modelPaths.size() != kStemRows))
    {
        error = "a split takes 1 model (FAST) or 4 specialists (FINE)";
        return false;
    }
    try
    {
        if (impl_->env == nullptr)
        {
            impl_->env = std::make_unique<Ort::Env>(ORT_LOGGING_LEVEL_WARNING, "terminator-stems");
            impl_->memory =
                std::make_unique<Ort::MemoryInfo>(Ort::MemoryInfo::CreateCpu(OrtArenaAllocator, OrtMemTypeDefault));
        }
        for (const auto& path : modelPaths)
        {
            Ort::SessionOptions opts;
            opts.SetGraphOptimizationLevel(GraphOptimizationLevel::ORT_ENABLE_ALL);
            if (intraOpThreads > 0)
                opts.SetIntraOpNumThreads(intraOpThreads);
#if defined(_WIN32)
            impl_->sessions.emplace_back(*impl_->env, widen(path).c_str(), opts);
#else
            impl_->sessions.emplace_back(*impl_->env, path.c_str(), opts);
#endif
            auto& session = impl_->sessions.back();
            Ort::AllocatorWithDefaultOptions alloc;
            if (session.GetInputCount() != 1 || session.GetOutputCount() != 1)
            {
                error = "unexpected model shape: one input and one output are required";
                unload();
                return false;
            }
            impl_->inputNames.emplace_back(session.GetInputNameAllocated(0, alloc).get());
            impl_->outputNames.emplace_back(session.GetOutputNameAllocated(0, alloc).get());
        }
    }
    catch (const Ort::Exception& e)
    {
        error = std::string("onnxruntime: ") + e.what();
        unload();
        return false;
    }
    return true;
}

bool StemModel::run(const float* mix, float* rows, std::string& error, const std::function<void(double)>& onRow)
{
    if (!loaded())
    {
        error = "no model loaded";
        return false;
    }
    const std::array<std::int64_t, 3> shape{1, 2, kSegment};
    try
    {
        // The tensor VIEWS the caller's mix (ORT does not copy) — the buffer outlives the run.
        auto input = Ort::Value::CreateTensor<float>(*impl_->memory, const_cast<float*>(mix),
                                                     static_cast<std::size_t>(kMixFloats), shape.data(), shape.size());
        const int models = modelCount();
        for (int k = 0; k < (models == 1 ? 1 : kStemRows); ++k)
        {
            const char* in = impl_->inputNames[static_cast<std::size_t>(k)].c_str();
            const char* out = impl_->outputNames[static_cast<std::size_t>(k)].c_str();
            auto result =
                impl_->sessions[static_cast<std::size_t>(k)].Run(Ort::RunOptions{nullptr}, &in, &input, 1, &out, 1);
            const auto& value = result.front();
            const auto info = value.GetTensorTypeAndShapeInfo();
            const auto count = static_cast<std::int64_t>(info.GetElementCount());
            if (count < kStemRows * kRowFloats)
            {
                error = "the model returned fewer samples than a chunk of stems";
                return false;
            }
            const float* data = value.GetTensorData<float>();
            if (models == 1)
            {
                // FAST: this one model gives all four rows.
                std::copy(data, data + kStemRows * kRowFloats, rows);
            }
            else
            {
                // FINE: specialist k contributes its own row only.
                const float* src = data + static_cast<std::ptrdiff_t>(k) * kRowFloats;
                std::copy(src, src + kRowFloats, rows + static_cast<std::ptrdiff_t>(k) * kRowFloats);
                if (onRow)
                    onRow(static_cast<double>(k + 1) / kStemRows);
            }
        }
    }
    catch (const Ort::Exception& e)
    {
        error = std::string("onnxruntime: ") + e.what();
        return false;
    }
    return true;
}
} // namespace terminator::stems
