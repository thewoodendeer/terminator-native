#pragma once
// RECORDING (Phase 5.1a) — capture from the interface, written to disk by a thread that is not the audio thread.
//
// The shipping app records through the PAGE (getUserMedia → MediaRecorder → decode), which in the native shell
// means the audio takes a trip through WebKit before it is a file: the interface's channels are not selectable,
// the format is whatever the browser felt like, and nothing is aligned to the transport. This is the native path.
//
// The shape is the only one that is safe: the audio thread does nothing but COPY into a preallocated ring (no
// allocation, no locks, no file I/O), and a writer thread drains the ring into a WAV. If the writer ever falls
// behind, the ring drops the newest block and COUNTS it — a recording with a hole in it that says so is worth more
// than one that silently glues the two sides of the hole together.
#include <atomic>
#include <cstdint>
#include <memory>
#include <vector>

#include <juce_audio_formats/juce_audio_formats.h>
#include <juce_core/juce_core.h>

#include "terminator/core/RtAssert.h"

namespace terminator
{

struct RecorderConfig
{
    juce::File file;
    double sampleRate = 48000.0;
    int numChannels = 2;
    int bitDepth = 24;   // 24 = the default (what an interface actually gives), 32 = float, 16 also allowed
    int ringSeconds = 8; // how far the writer may fall behind before anything is lost
    /// Which hardware inputs to take, in order. Empty = the first `numChannels`.
    std::vector<int> inputChannels;
};

/// One take. Start it from the message thread, feed it from the audio callback, stop it from the message thread.
class Recorder
{
  public:
    Recorder();
    ~Recorder(); // out of line: the writer thread is only a forward declaration here

    /// Non-RT: open the file and start the writer thread. False + `error` if the file cannot be written.
    bool start(const RecorderConfig& cfg, juce::String& error);
    /// RT: copy this block in. Never allocates, never blocks, never touches the file. `startOffset` is where in
    /// the block the take begins (5.1c: an armed take starts at ITS sample, not at the block boundary that
    /// contains it) — the frames before it were never part of this take.
    void push(const float* const* inputs, int numIn, int numSamples,
              int startOffset = 0) noexcept TERMINATOR_NONBLOCKING;
    /// Non-RT: drain, close the file, join the writer. Returns the frames actually written.
    std::uint64_t stop();

    bool recording() const noexcept { return recording_.load(std::memory_order_acquire); }
    /// Frames handed to the ring by the audio thread.
    std::uint64_t framesCaptured() const noexcept { return captured_.load(std::memory_order_relaxed); }
    /// Frames the writer has put in the file.
    std::uint64_t framesWritten() const noexcept { return written_.load(std::memory_order_relaxed); }
    /// Frames LOST because the writer could not keep up. Any number but 0 is a bad take, and the caller is told.
    std::uint64_t framesDropped() const noexcept { return dropped_.load(std::memory_order_relaxed); }
    /// The loudest sample seen on each captured channel since the take started (the input meter / clip light).
    float peak(int channel) const noexcept;

  private:
    class Writer;
    void drain(bool finish);

    RecorderConfig cfg_;
    std::unique_ptr<juce::AudioFormatWriter> writer_;
    std::unique_ptr<Writer> thread_;
    std::vector<float> ring_;  // numChannels × ringFrames, interleaved
    std::vector<float> chunk_; // the writer's staging buffer (deinterleaved pointers into it)
    int ringFrames_ = 0;
    std::atomic<std::uint64_t> writePos_{0}; // audio thread writes, writer reads
    std::atomic<std::uint64_t> readPos_{0};  // writer thread advances
    std::atomic<std::uint64_t> captured_{0}, written_{0}, dropped_{0};
    std::atomic<bool> recording_{false};
    std::atomic<float> peak_[32] = {};
};

} // namespace terminator
