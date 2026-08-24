// terminator-stems <in.wav> <out-dir> --model <file> [--model <file> ...] [--windows a:b,c:d] [--sweep]
//                  [--threads N] [--bits 16|24|32] [--quiet] | --version | --help
//
// The headless separator: the same SplitSession + StemModel the app uses, with no window and no page. It is how
// a stem split is MEASURED (speed, and the output compared against the Electron app's), and it is the Phase 7
// gate's spine.
//
// FAST = one --model (htdemucs_fp16weights.onnx). FINE = four, in the row order drums, bass, other, vocals.
// Writes drums.wav / bass.wav / other.wav / vocals.wav at the SOURCE rate, and prints the timing.
// Exit codes: 0 ok · 2 usage · 3 load error · 4 split error · 5 write error
#include <chrono>
#include <cstdio>
#include <string>
#include <vector>

#include <juce_core/juce_core.h>

#include "terminator/Version.h"
#include "terminator/core/planners/StemMask.h"
#include "terminator/io/SampleLoader.h"
#include "terminator/render/AudioFileWriter.h"
#include "terminator/stems/SplitSession.h"
#include "terminator/stems/StemModel.h"

namespace
{
using namespace terminator;

juce::String optionValue(const juce::ArgumentList& args, const juce::String& opt)
{
    for (int i = 0; i < args.size(); ++i)
    {
        const auto& t = args[i].text;
        if (t.startsWith(opt + "="))
            return t.fromFirstOccurrenceOf("=", false, false);
        if (t == opt && i + 1 < args.size())
            return args[i + 1].text;
    }
    return {};
}

/// Every --model, in the order given (FINE's four specialists are drums, bass, other, vocals).
std::vector<std::string> modelPaths(const juce::ArgumentList& args)
{
    std::vector<std::string> out;
    for (int i = 0; i < args.size(); ++i)
    {
        const auto& t = args[i].text;
        if (t.startsWith("--model="))
            out.push_back(t.fromFirstOccurrenceOf("=", false, false).toStdString());
        else if (t == "--model" && i + 1 < args.size())
            out.push_back(args[i + 1].text.toStdString());
    }
    return out;
}

/// "12.5:20,40:48" -> two spans in seconds.
std::vector<stems::Span> parseWindows(const juce::String& text)
{
    std::vector<stems::Span> out;
    for (const auto& part : juce::StringArray::fromTokens(text, ",", ""))
    {
        const auto a = part.upToFirstOccurrenceOf(":", false, false).getDoubleValue();
        const auto b = part.fromFirstOccurrenceOf(":", false, false).getDoubleValue();
        if (b > a)
            out.push_back({a, b});
    }
    return out;
}

void usage()
{
    std::puts("terminator-stems — htdemucs stem separation, headless (the same engine the app runs)\n"
              "usage: terminator-stems <in.wav> <out-dir> --model <file> [--model <file> x3 for FINE]\n"
              "                        [--windows 12.5:20,40:48] [--sweep] [--threads N] [--bits 16|24|32]\n"
              "                        [--quiet]\n"
              "       terminator-stems --version | --help\n"
              "Without --windows the whole track is swept. Writes drums/bass/other/vocals .wav at the source rate.");
}
} // namespace

int main(int argc, char* argv[])
{
    juce::ArgumentList args(argc, argv);
    if (args.containsOption("--version"))
    {
        // Loading the runtime here is deliberate: --version is also the "can this machine split at all?" probe
        // (the dylib is dlopen'd, so a Mac older than 13.4 says so instead of failing to launch).
        std::string ortError;
        const bool ort = stems::StemModel::ensureRuntime(ortError);
        std::printf("terminator-stems %s (onnxruntime %s)\n", terminator::versionString(),
                    ort ? stems::StemModel::runtimeVersion().c_str() : ortError.c_str());
        return ort ? 0 : 3;
    }
    if (args.containsOption("--help|-h") || args.size() < 2)
    {
        usage();
        return args.containsOption("--help|-h") ? 0 : 2;
    }

    const auto inFile = args[0].resolveAsExistingFile();
    const auto outDir = args[1].resolveAsFile();
    const auto models = modelPaths(args);
    const bool quiet = args.containsOption("--quiet");
    if (!inFile.existsAsFile())
    {
        std::fprintf(stderr, "input not found: %s\n", args[0].text.toRawUTF8());
        return 2;
    }
    if (models.empty())
    {
        std::fprintf(stderr, "--model <file> is required (one for FAST, four for FINE)\n");
        return 2;
    }
    if (!outDir.createDirectory())
    {
        std::fprintf(stderr, "cannot create %s\n", outDir.getFullPathName().toRawUTF8());
        return 5;
    }

    SampleLoader loader;
    juce::String error;
    const auto source = loader.load(inFile, error, 2);
    if (source == nullptr)
    {
        std::fprintf(stderr, "load failed: %s\n", error.toRawUTF8());
        return 3;
    }
    const auto frames = static_cast<std::int64_t>(source->numFrames);
    const double rate = source->sampleRate;
    const float* left = source->channel(0);
    const float* right = source->numChannels > 1 ? source->channel(1) : left;
    const double seconds = rate > 0.0 ? static_cast<double>(frames) / rate : 0.0;

    const auto t0 = std::chrono::steady_clock::now();
    stems::StemModel model;
    std::string modelError;
    const int threads = optionValue(args, "--threads").getIntValue();
    if (!model.load(models, modelError, threads))
    {
        std::fprintf(stderr, "model load failed: %s\n", modelError.c_str());
        return 3;
    }
    const auto loadMs = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - t0).count();

    stems::SplitSession session(left, right, frames, rate);
    const auto windows = parseWindows(optionValue(args, "--windows"));
    if (!windows.empty())
        session.queueWindows(windows, false);
    if (windows.empty() || args.containsOption("--sweep"))
        session.queueSweep();

    if (!quiet)
        std::printf("in: %s\n  %.2f s · %.0f Hz · %d ch · %d chunks queued · %s · onnxruntime %s\n",
                    inFile.getFileName().toRawUTF8(), seconds, rate, source->numChannels, session.queuedTotal(),
                    models.size() == 1 ? "FAST" : "FINE", stems::StemModel::runtimeVersion().c_str());

    // Four stereo stems at the SOURCE rate, filled span by span as the split hands them over.
    std::vector<juce::AudioBuffer<float>> out(static_cast<std::size_t>(stems::kStemRows));
    for (auto& b : out)
    {
        b.setSize(2, static_cast<int>(frames));
        b.clear();
    }

    std::string runError;
    const auto tSplit = std::chrono::steady_clock::now();
    std::int64_t framesWritten = 0;
    const bool finished = session.run([&](const float* mix, float* rows) { return model.run(mix, rows, runError); },
                                      [&](const stems::ReadyChunk& chunk)
                                      {
                                          const auto n = static_cast<int>(chunk.endFrame - chunk.startFrame);
                                          for (int row = 0; row < stems::kStemRows; ++row)
                                              for (int ch = 0; ch < 2; ++ch)
                                                  out[static_cast<std::size_t>(row)].copyFrom(
                                                      ch, static_cast<int>(chunk.startFrame),
                                                      chunk.stems[static_cast<std::size_t>(row * 2 + ch)].data(), n);
                                          framesWritten += n;
                                      },
                                      [&](double done, int total)
                                      {
                                          if (!quiet)
                                          {
                                              std::printf("\r  %.0f%% (%.1f/%d chunks)",
                                                          100.0 * done / juce::jmax(1, total), done, total);
                                              std::fflush(stdout);
                                          }
                                      });
    const auto splitMs = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - tSplit).count();
    if (!quiet)
        std::puts("");
    if (!finished)
    {
        std::fprintf(stderr, "split failed: %s\n", runError.empty() ? "cancelled" : runError.c_str());
        return 4;
    }

    const int bits = optionValue(args, "--bits").isEmpty() ? 24 : optionValue(args, "--bits").getIntValue();
    for (int row = 0; row < stems::kStemRows; ++row)
    {
        const auto file = outDir.getChildFile(juce::String(stems::kStemNames[row]) + ".wav");
        juce::String writeError;
        if (!render::writeAudioFile(file, out[static_cast<std::size_t>(row)], rate, render::AudioFileFormat::wav, bits,
                                    writeError))
        {
            std::fprintf(stderr, "write failed (%s): %s\n", file.getFullPathName().toRawUTF8(), writeError.toRawUTF8());
            return 5;
        }
    }

    if (!quiet)
    {
        const double audio = static_cast<double>(framesWritten) / juce::jmax(1.0, rate);
        std::printf("out: %s\n  models %.0f ms · split %.1f s for %.1f s of audio (%.2fx realtime)\n",
                    outDir.getFullPathName().toRawUTF8(), loadMs, splitMs / 1000.0, audio,
                    audio / juce::jmax(0.001, splitMs / 1000.0));
    }
    return 0;
}
