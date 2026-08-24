#pragma once
// Writing the rendered audio out (Phase 4.5f): WAV / FLAC / MP3, and the 16-bit QUANTISER that has to match the
// shipping Electron app sample for sample.
//
// The 16-bit path is not JUCE's float→int conversion: it is a port of the app's own `quantizeTPDF16`
// (src/renderer/audio/flacEncoder.ts) — two xorshift32 streams seeded 0x2545f491 / 0x9e3779b9, one triangular draw
// per sample per channel in INTERLEAVE order, x·32767 + dither, rounded with JavaScript's Math.round semantics
// (half toward +infinity — NOT std::round, which rounds half away from zero and disagrees on negatives).
// Two consequences, both deliberate:
//   • a native 16-bit export is bit-identical to the same export from the Electron app (parity is the point);
//   • WAV and FLAC of the same render hold the SAME samples, because both are written from this one quantiser —
//     the app's `test:export-flac` contract.
// 24-bit and float are NOT dithered (24 bits is below the noise floor of anything, float has no quantisation step)
// and dither is applied ONCE, here at the export edge, never at an intermediate stage.
#include <vector>

#include <juce_audio_basics/juce_audio_basics.h>
#include <juce_core/juce_core.h>

namespace terminator::render
{

enum class AudioFileFormat
{
    wav,
    flac,
    mp3
};

/// "wav" · "flac" · "mp3" (anything else = wav).
AudioFileFormat audioFileFormatFromName(const juce::String& name);
/// The extension including the dot.
juce::String audioFileExtension(AudioFileFormat f);

/// Float planar → 16-bit, the app's quantiser exactly (see the header note). `out[ch][i]` is the sample value.
std::vector<std::vector<std::int16_t>> quantizeTpdf16(const juce::AudioBuffer<float>& buffer);

/// Write `buffer` as `format`. bitDepth 16/24/32 (32 = float) applies to WAV; FLAC takes 16 or 24; MP3 ignores it
/// and uses `mp3Kbps`. Returns false and fills `error`.
/// MP3 goes through a `lame` EXECUTABLE (JUCE drives it; nothing links liblame, so the app stays clear of LAME's
/// LGPL). `lameBinary` is where the shell found it — bundled tools first, then PATH; an invalid path is a clear
/// error, never a silent WAV.
bool writeAudioFile(const juce::File& file, const juce::AudioBuffer<float>& buffer, double sampleRate,
                    AudioFileFormat format, int bitDepth, juce::String& error, int mp3Kbps = 320,
                    const juce::File& lameBinary = {});

/// JUCE's LAME quality-option index for a CBR bitrate. Its option list is ten VBR levels (0 = best … 9 = SMALLEST)
/// and only THEN the CBR rates, so an index picked by "bigger number = better" selects the worst encode there is —
/// this maps a requested kbps to the nearest real CBR rate instead.
int mp3QualityIndexFor(int kbps);

/// Where a usable `lame` lives: `preferred` if it runs, else one off the PATH, else an invalid File.
juce::File findLameBinary(const juce::File& preferred = {});

} // namespace terminator::render
