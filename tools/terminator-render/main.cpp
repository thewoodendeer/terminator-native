// terminator-render <project.json> <out.wav> [--rate N] [--block N] [--seconds S] [--bits 16|24|32]
//                   [--print-spec] | --version | --help
// Exit codes: 0 ok · 2 usage · 3 project parse error · 4 write error
#include <cstdio>

#include <juce_core/juce_core.h>

#include "terminator/Version.h"
#include "terminator/render/OfflineRenderer.h"

namespace
{
/// Accepts both "--opt value" and "--opt=value". Returns an empty string when absent.
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

void usage()
{
    std::puts("terminator-render — Terminator offline renderer (same engine as playback)\n"
              "usage: terminator-render <project.json> <out.wav> [--rate N] [--block N] [--seconds S]\n"
              "                         [--bits 16|24|32] [--print-spec]\n"
              "       terminator-render --version | --help");
}
} // namespace

int main(int argc, char* argv[])
{
    juce::ArgumentList args(argc, argv);

    if (args.containsOption("--version"))
    {
        std::printf("terminator-render %s\n", terminator::versionString());
        return 0;
    }
    if (args.containsOption("--help|-h") || args.size() < 2)
    {
        usage();
        return args.containsOption("--help|-h") ? 0 : 2;
    }

    const auto projectFile = args[0].resolveAsExistingFile();
    const auto outFile = args[1].resolveAsFile();
    if (projectFile == juce::File() || !projectFile.existsAsFile())
    {
        std::fprintf(stderr, "project file not found: %s\n", args[0].text.toRawUTF8());
        return 2;
    }

    terminator::RenderSpec spec;
    juce::String error;
    if (!terminator::parseRenderSpecFromText(projectFile.loadFileAsString(), spec, error))
    {
        std::fprintf(stderr, "project error: %s\n", error.toRawUTF8());
        return 3;
    }

    if (const auto v = optionValue(args, "--rate"); v.isNotEmpty())
        spec.sampleRate = v.getDoubleValue();
    if (const auto v = optionValue(args, "--block"); v.isNotEmpty())
        spec.blockSize = v.getIntValue();
    if (const auto v = optionValue(args, "--seconds"); v.isNotEmpty())
        spec.lengthSeconds = v.getDoubleValue();
    const auto bitsText = optionValue(args, "--bits");
    const int bits = bitsText.isNotEmpty() ? bitsText.getIntValue() : 24;

    if (spec.sampleRate <= 0.0 || spec.blockSize <= 0 || spec.lengthSeconds < 0.0)
    {
        std::fprintf(stderr, "invalid override: rate=%g block=%d seconds=%g\n", spec.sampleRate, spec.blockSize,
                     spec.lengthSeconds);
        return 2;
    }

    if (args.containsOption("--print-spec"))
        std::printf("spec: rate=%g block=%d channels=%d seconds=%g gain=%g tone=%s %gHz amp=%g\n", spec.sampleRate,
                    spec.blockSize, spec.numChannels, spec.lengthSeconds, static_cast<double>(spec.masterGain),
                    spec.testToneEnabled ? "on" : "off", static_cast<double>(spec.testToneFrequencyHz),
                    static_cast<double>(spec.testToneAmplitude));

    const auto t0 = juce::Time::getMillisecondCounterHiRes();
    const auto result = terminator::renderOffline(spec);
    const auto t1 = juce::Time::getMillisecondCounterHiRes();

    if (!terminator::writeWav(outFile, result.buffer, result.sampleRate, bits, error))
    {
        std::fprintf(stderr, "write error: %s\n", error.toRawUTF8());
        return 4;
    }

    const double secs = static_cast<double>(result.buffer.getNumSamples()) / result.sampleRate;
    std::printf("rendered %s · %d ch · %d samples (%.3f s) @ %g Hz · %llu blocks · %.1f ms (%.0fx realtime)\n",
                outFile.getFullPathName().toRawUTF8(), result.buffer.getNumChannels(), result.buffer.getNumSamples(),
                secs, result.sampleRate, static_cast<unsigned long long>(result.blocksProcessed), t1 - t0,
                (t1 - t0) > 0.0 ? secs * 1000.0 / (t1 - t0) : 0.0);
    return 0;
}
