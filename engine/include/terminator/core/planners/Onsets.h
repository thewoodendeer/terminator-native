#pragma once
// Onset / tempo / silence analysis — ports of ChopperEngine's pure detectors (run on the analysis thread, never
// the RT path). Exact parameters from the Electron code so auto-chop / snap / BPM land identically:
//   detectTransients   — broadband: HOP 256 / FRAME 512, mono mean-square energy, half-wave flux, threshold
//                        mean + 0.1σ, local max (> prev && >= next), min gap 30 ms.
//   detectDrumTransients — banded: one-pole LP 200 Hz (kick) + HP-by-subtraction at 1500 Hz (snare), per-band
//                        flux, thr mean + 0.5σ, min gap 50 ms, kick eLow/eHigh > 0.4, snare > 0.15, merge/dedupe.
//   detectSilenceEnd   — first 256-frame RMS window over 0.015.
//   estimateBpm        — tempogram: HOP 1024 / FRAME 2048, first 60 s, comb weights [1,.7,.5,.4], coarse 60–200
//                        then ±2 BPM @0.1, fold to 75..165, integer; 0 if < 8 s.
#include <cmath>
#include <cstdint>
#include <vector>

namespace terminator::onsets
{
struct Onsets
{
    std::vector<float> times;     // seconds
    std::vector<float> strengths; // spectral-flux magnitude at the onset
};

/// `mono[i]` = the mono-sum sample (ch0+ch1)/2; caller sums channels. sampleRate in Hz.
Onsets detectTransients(const std::vector<float>& mono, double sampleRate);
Onsets detectDrumTransients(const std::vector<float>& mono, double sampleRate);
double detectSilenceEnd(const std::vector<float>& mono, double sampleRate, double threshold = 0.015,
                        int windowFrames = 256);
/// `ch0`,`ch1` are equal-length channels (pass ch0 twice for mono). Returns an integer BPM in [~75,165] or 0.
int estimateBpm(const std::vector<float>& ch0, const std::vector<float>& ch1, double sampleRate, double durationSec);
} // namespace terminator::onsets
