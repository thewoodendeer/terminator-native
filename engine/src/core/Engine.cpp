#include "terminator/core/Engine.h"

#include <algorithm>
#include <cmath>

namespace terminator
{

namespace
{
constexpr double kPi = 3.14159265358979323846;

// The calibration click: a 64-frame Hann-windowed 4 kHz-ish burst — broadband enough to cross-correlate sharply
// but band-limited enough not to alias at 44.1 k. Generated once, never allocates.
struct ClickTable
{
    float v[Engine::kCalibrationClickFrames];
    ClickTable() noexcept
    {
        const int n = Engine::kCalibrationClickFrames;
        for (int i = 0; i < n; ++i)
        {
            const double w = 0.5 - 0.5 * std::cos(2.0 * kPi * static_cast<double>(i) / static_cast<double>(n - 1));
            v[i] = static_cast<float>(w * std::sin(2.0 * kPi * static_cast<double>(i) / 8.0)); // period 8 frames
        }
    }
};
const ClickTable gClickTable{};
const ClickTable& clickTable() noexcept TERMINATOR_NONBLOCKING
{
    return gClickTable;
}
} // namespace

const float* Engine::calibrationClick() noexcept
{
    return clickTable().v;
}

Engine::Engine()
    : commands_(std::make_unique<Commands>()), midiQueues_(kMaxMidiPorts), calibCapture_(kCalibrationMaxFrames, 0.0f)
{
    for (int n = 0; n < 128; ++n)
        noteToPad_[n] = static_cast<std::int16_t>(n >= 36 && n - 36 < kChopPads ? n - 36 : -1); // A01 = C1 (note 36)
    for (auto& t : liveHitSample_)
        t = -1.0e12;
    (void)clickTable(); // built at static-init time; nothing to warm
}

void Engine::prepare(const Config& config)
{
    TERMINATOR_RT_ASSERT(config.sampleRate > 0.0);
    TERMINATOR_RT_ASSERT(config.maxBlockSize > 0);
    TERMINATOR_RT_ASSERT(config.numOutputChannels >= 0);
    config_ = config;
    masterGainCurrent_ = masterGainTarget_;
    playheadSamples_ = 0;
    blocksProcessed_ = 0;
    samplesProcessed_ = 0;
    blockHostNs_ = prevBlockHostNs_ = 0;
    toneRe_ = 1.0;
    toneIm_ = 0.0;
    setTestToneFrequency(toneFrequencyHz_);
    sampler_.prepare(config_.sampleRate, config_.maxBlockSize, config_.numOutputChannels);
    seq_.prepare(config_.sampleRate);
    drums_.prepare(config_.sampleRate);
    bass_.prepare(config_.sampleRate);
    bassSeq_.prepare(config_.sampleRate);
    for (auto& t : liveHitSample_)
        t = -1.0e12;
    for (auto& t : pendingTrig_)
        t.used = false;
    calibState_ = 0;
    prepared_ = true;
    publish(0);
}

void Engine::release()
{
    prepared_ = false;
    sampler_.reset();
    seq_.reset();
    drums_.reset();
    bass_.reset();
    bassSeq_.reset();
    StateSnapshot s{};
    s.prepared = 0;
    s.masterGain = masterGainCurrent_;
    s.calibrationState = calibState_;
    s.calibrationId = calibId_;
    snapshot_.publish(s);
}

void Engine::setTestToneFrequency(float hz) noexcept TERMINATOR_NONBLOCKING
{
    toneFrequencyHz_ = hz;
    const double sr = config_.sampleRate > 0.0 ? config_.sampleRate : 48000.0;
    const double w = 2.0 * kPi * static_cast<double>(hz) / sr;
    toneCos_ = std::cos(w);
    toneSin_ = std::sin(w);
}

std::int32_t Engine::offsetForHostTime(std::uint64_t hostTimeNs, int numSamples) const noexcept TERMINATOR_NONBLOCKING
{
    // Events are placed relative to the PREVIOUS block's entry time: an event that arrived while block N-1
    // was being rendered lands in block N at the same intra-block position → inter-onset spacing preserved,
    // fixed latency of one block. 0 / unknown clocks = start of this block.
    if (hostTimeNs == 0 || prevBlockHostNs_ == 0 || config_.sampleRate <= 0.0)
        return 0;
    if (hostTimeNs <= prevBlockHostNs_)
        return 0;
    const double dt = static_cast<double>(hostTimeNs - prevBlockHostNs_) * 1e-9;
    const double off = dt * config_.sampleRate;
    if (off >= static_cast<double>(numSamples - 1))
        return numSamples - 1;
    return static_cast<std::int32_t>(off);
}

void Engine::apply(const Command& c, int numSamples) noexcept TERMINATOR_NONBLOCKING
{
    switch (c.type)
    {
    case CommandType::setMasterGain:
        masterGainTarget_ = std::clamp(c.payload.gain.linear, 0.0f, 4.0f);
        break;
    case CommandType::setTestTone:
        toneEnabled_ = c.payload.testTone.enabled != 0;
        toneAmplitude_ = std::clamp(c.payload.testTone.amplitude, 0.0f, 1.0f);
        toneOutputPair_ = c.payload.testTone.outputPair;
        if (c.payload.testTone.frequencyHz > 0.0f)
            setTestToneFrequency(c.payload.testTone.frequencyHz);
        break;
    case CommandType::transportPlay:
        playing_ = true;
        break;
    case CommandType::transportStop:
        playing_ = false;
        break;
    case CommandType::panic:
        playing_ = false;
        toneEnabled_ = false;
        drums_.stop(sampler_);
        sampler_.stopAll();
        bassSeq_.stop(bass_);
        bass_.panic();
        for (auto& t : pendingTrig_)
            t.used = false;
        break;
    case CommandType::setPadSample:
        sampler_.setPadSample(c.payload.padSample.pad, c.payload.padSample.sample, c.payload.padSample.startFrame,
                              c.payload.padSample.endFrame);
        break;
    case CommandType::setPadParams:
        sampler_.setPadParams(c.payload.padParams);
        break;
    case CommandType::setPadLoopBuffer:
        sampler_.setPadLoopBuffer(c.payload.padLoop.pad, c.payload.padLoop.sample, c.payload.padLoop.loopStart,
                                  c.payload.padLoop.loopEnd);
        break;
    case CommandType::setPadStems:
        sampler_.setPadStems(c.payload.padStems.pad, c.payload.padStems.planes, c.payload.padStems.mask);
        break;
    case CommandType::triggerPad:
    {
        const auto off = offsetForHostTime(c.payload.trigger.hostTimeNs, numSamples);
        if (c.payload.trigger.hasPan != 0)
            sampler_.triggerEx(c.payload.trigger.pad, c.payload.trigger.velocity, off, c.payload.trigger.pan, false);
        else
            sampler_.trigger(c.payload.trigger.pad, c.payload.trigger.velocity, off);
        noteLiveHit(c.payload.trigger.pad, static_cast<double>(samplesProcessed_) + static_cast<double>(off));
        break;
    }
    case CommandType::releasePad:
        sampler_.release(c.payload.trigger.pad);
        break;
    case CommandType::triggerPadAtSample:
        bookTrigger(c.payload.trigger.pad, c.payload.trigger.velocity, c.payload.trigger.hostTimeNs, false, numSamples,
                    c.payload.trigger.hasPan != 0, c.payload.trigger.pan);
        break;
    case CommandType::releasePadAtSample:
        bookTrigger(c.payload.trigger.pad, 0.0f, c.payload.trigger.hostTimeNs, true, numSamples);
        break;
    case CommandType::stopPad:
        sampler_.stopPad(c.payload.trigger.pad);
        break;
    case CommandType::setNoteMap:
        if (c.payload.noteMap.note < 128)
            noteToPad_[c.payload.noteMap.note] = c.payload.noteMap.pad;
        break;
    case CommandType::seqSetPattern:
        seq_.setPattern(static_cast<const SeqPattern*>(c.payload.seq.pattern));
        break;
    case CommandType::seqQueuePattern:
        seq_.queuePattern(static_cast<const SeqPattern*>(c.payload.seq.pattern));
        break;
    case CommandType::seqPlay:
        seq_.play(c.payload.seq.atSample, samplesProcessed_);
        playing_ = true;
        break;
    case CommandType::seqStop:
        seq_.stop();
        playing_ = false;
        break;
    case CommandType::seqPause:
        seq_.pause(samplesProcessed_, sampler_);
        break;
    case CommandType::seqResume:
        seq_.resume(samplesProcessed_);
        break;
    case CommandType::seqSetBpm:
        seq_.setBpm(c.payload.seq.value);
        drums_.setBpm(c.payload.seq.value); // one BPM for every sequencer (getMasterBpm)
        bassSeq_.setBpm(c.payload.seq.value);
        break;
    case CommandType::seqSetLoop:
        seq_.setLoop(c.payload.seq.value != 0.0);
        break;
    case CommandType::drumSetPattern:
        drums_.setPattern(c.payload.drum.pattern);
        break;
    case CommandType::drumSchedulePattern:
        drums_.schedulePattern(c.payload.drum.pattern, c.payload.drum.atSample);
        break;
    case CommandType::drumClearScheduled:
        drums_.clearScheduled();
        break;
    case CommandType::drumSetGraphs:
        drums_.setGraphs(c.payload.drum.graphs);
        break;
    case CommandType::drumSetLane:
        drums_.setLane(c.payload.drumLane.lane, c.payload.drumLane.volume, c.payload.drumLane.audible != 0,
                       c.payload.drumLane.group);
        break;
    case CommandType::drumSetParams:
        drums_.setParams(c.payload.drumParams.swing, c.payload.drumParams.masterVolume, c.payload.drumParams.ppq);
        break;
    case CommandType::drumPlay:
        drums_.play(c.payload.drum.atSample, c.payload.drum.stepOffset, samplesProcessed_);
        playing_ = true;
        break;
    case CommandType::drumStop:
        drums_.stop(sampler_);
        break;
    case CommandType::bassSetPatch:
        bass_.setPatch(static_cast<const BassPatch*>(c.payload.bass.ptr));
        break;
    case CommandType::bassSetPattern:
        bassSeq_.setPattern(static_cast<const BassPattern*>(c.payload.bass.ptr), bass_);
        break;
    case CommandType::bassSetTimeline:
        bassSeq_.setTimeline(static_cast<const BassTimeline*>(c.payload.bass.ptr));
        break;
    case CommandType::bassClearTimeline:
        bassSeq_.clearTimeline(bass_);
        break;
    case CommandType::bassArrangerDriven:
        bassSeq_.setArrangerDriven(c.payload.bass.flag != 0);
        break;
    case CommandType::bassBendLane:
        bassSeq_.setBendLane(c.payload.bass.flag != 0);
        break;
    case CommandType::bassPlay:
        bassSeq_.play(c.payload.bass.atSample, c.payload.bass.offsetTicks, samplesProcessed_);
        break;
    case CommandType::bassStop:
        bassSeq_.stop(bass_);
        break;
    case CommandType::bassNote:
        bass_.pushEvent(c.payload.bass.flag != 0 ? BassSynth::EventKind::on : BassSynth::EventKind::off,
                        c.payload.bass.atSample, c.payload.bass.note, c.payload.bass.vel, 0.0,
                        static_cast<BassTag>(c.payload.bass.tag));
        break;
    case CommandType::bassSlide:
        bass_.pushEvent(BassSynth::EventKind::slide, c.payload.bass.atSample, c.payload.bass.note, 0.0f,
                        c.payload.bass.value, static_cast<BassTag>(c.payload.bass.tag));
        break;
    case CommandType::bassBend:
        // the wheel (at 0 / the past) bends NOW; a future `at` is queued with the note events (a timed BEND lane)
        if (c.payload.bass.atSample > samplesProcessed_)
            bass_.pushEvent(BassSynth::EventKind::bend, c.payload.bass.atSample, 0, 0.0f, c.payload.bass.value,
                            static_cast<BassTag>(c.payload.bass.tag));
        else
            bass_.setBendNow(c.payload.bass.value);
        break;
    case CommandType::bassMod:
        bass_.setModWheel(c.payload.bass.value);
        break;
    case CommandType::bassClear:
        bass_.clear(static_cast<BassTag>(c.payload.bass.tag), c.payload.bass.flag != 0);
        break;
    case CommandType::bassPanic:
        bass_.panic();
        break;
    case CommandType::startCalibration:
    {
        const auto& k = c.payload.calibration;
        calibId_ = k.id;
        if (k.outputChannel >= static_cast<std::uint16_t>(config_.numOutputChannels) ||
            k.inputChannel >= static_cast<std::uint16_t>(config_.numInputChannels) || k.recordFrames == 0)
        {
            calibState_ = 3;
            break;
        }
        calibOut_ = k.outputChannel;
        calibIn_ = k.inputChannel;
        calibTarget_ = std::min(k.recordFrames, kCalibrationMaxFrames);
        calibRecorded_ = 0;
        calibClickPos_ = 0;
        calibState_ = 1;
        break;
    }
    case CommandType::none:
        break;
    }
    ++commandsApplied_;
}

void Engine::bookTrigger(std::uint16_t pad, float velocity, std::uint64_t atSample, bool release, int numSamples,
                         bool hasPan, float pan) noexcept TERMINATOR_NONBLOCKING
{
    // inside this block (or in the past): fire now at its offset; later: wait in the ring (fired by
    // firePendingTriggers in the block that contains it — sample-exact, any lead)
    const std::uint64_t blockEnd = samplesProcessed_ + static_cast<std::uint64_t>(numSamples);
    if (!release)
        noteLiveHit(pad, static_cast<double>(atSample)); // the one-owner rule sees the booking immediately
    if (atSample < blockEnd)
    {
        const auto off = atSample > samplesProcessed_ ? static_cast<std::int64_t>(atSample - samplesProcessed_) : 0;
        const auto clampedOff = static_cast<std::int32_t>(std::min<std::int64_t>(off, numSamples - 1));
        if (release)
            sampler_.release(pad, clampedOff);
        else if (hasPan)
            sampler_.triggerEx(pad, velocity, clampedOff, pan, false);
        else
            sampler_.trigger(pad, velocity, clampedOff);
        return;
    }
    for (auto& t : pendingTrig_)
        if (!t.used)
        {
            t.used = true;
            t.sample = atSample;
            t.velocity = velocity;
            t.pad = pad;
            t.release = release;
            t.hasPan = hasPan;
            t.pan = pan;
            return;
        }
    // ring full (64 hits booked ahead): fire now rather than lose it
    if (release)
        sampler_.release(pad, 0);
    else if (hasPan)
        sampler_.triggerEx(pad, velocity, 0, pan, false);
    else
        sampler_.trigger(pad, velocity, 0);
}

void Engine::firePendingTriggers(int numSamples) noexcept TERMINATOR_NONBLOCKING
{
    const std::uint64_t blockEnd = samplesProcessed_ + static_cast<std::uint64_t>(numSamples);
    for (auto& t : pendingTrig_)
    {
        if (!t.used || t.sample >= blockEnd)
            continue;
        const auto off = t.sample > samplesProcessed_ ? static_cast<std::int64_t>(t.sample - samplesProcessed_) : 0;
        const auto clampedOff = static_cast<std::int32_t>(std::min<std::int64_t>(off, numSamples - 1));
        if (t.release)
            sampler_.release(t.pad, clampedOff);
        else
        {
            if (t.hasPan)
                sampler_.triggerEx(t.pad, t.velocity, clampedOff, t.pan, false);
            else
                sampler_.trigger(t.pad, t.velocity, clampedOff);
            noteLiveHit(t.pad, static_cast<double>(t.sample)); // re-stamp: a later booking of the same pad overwrote it
        }
        t.used = false;
    }
}

void Engine::drainCommands(int numSamples) noexcept TERMINATOR_NONBLOCKING
{
    Command c;
    // Bounded: at most one full queue per block, so a flooding producer cannot starve the callback.
    for (std::size_t n = 0; n < Commands::capacity() && commands_->pop(c); ++n)
        apply(c, numSamples);
}

void Engine::drainMidi(int numSamples) noexcept TERMINATOR_NONBLOCKING
{
    MidiEvent e;
    for (auto& q : midiQueues_)
    {
        for (std::size_t n = 0; n < MidiQueue::capacity() && q.pop(e); ++n)
        {
            if (e.size < 2)
                continue;
            const std::uint8_t status = e.data[0] & 0xF0u;
            const std::uint8_t note = e.data[1] & 0x7Fu;
            const std::uint8_t vel = e.size > 2 ? (e.data[2] & 0x7Fu) : 0;
            const std::int16_t pad = noteToPad_[note];
            if (pad < 0)
                continue;
            if (status == 0x90 && vel > 0)
            {
                const auto off = offsetForHostTime(e.hostTimeNs, numSamples);
                sampler_.trigger(static_cast<std::uint16_t>(pad), static_cast<float>(vel) / 127.0f, off);
                noteLiveHit(static_cast<std::uint16_t>(pad),
                            static_cast<double>(samplesProcessed_) + static_cast<double>(off));
            }
            else if (status == 0x80 || (status == 0x90 && vel == 0))
                sampler_.release(static_cast<std::uint16_t>(pad));
        }
    }
}

void Engine::publish(int numSamples) noexcept TERMINATOR_NONBLOCKING
{
    StateSnapshot s{};
    s.sampleRate = config_.sampleRate;
    s.blockSize = static_cast<std::uint32_t>(config_.maxBlockSize);
    s.numOutputChannels = static_cast<std::uint32_t>(config_.numOutputChannels);
    s.numInputChannels = static_cast<std::uint32_t>(config_.numInputChannels);
    s.prepared = prepared_ ? 1u : 0u;
    s.playing = playing_ ? 1u : 0u;
    s.playheadSamples = playheadSamples_;
    s.blocksProcessed = blocksProcessed_;
    s.samplesProcessed = samplesProcessed_;
    s.masterGain = masterGainCurrent_;
    s.testToneEnabled = toneEnabled_ ? 1u : 0u;
    s.testToneFrequencyHz = toneFrequencyHz_;
    s.peak[0] = outputPeak_[0];
    s.peak[1] = outputPeak_[1];
    for (int ch = 0; ch < kMaxOutputChannels; ++ch)
        s.outputPeak[ch] = outputPeak_[ch];
    for (int ch = 0; ch < kMaxInputChannels; ++ch)
        s.inputPeak[ch] = inputPeak_[ch];
    s.commandsApplied = commandsApplied_;
    s.commandsDropped = commands_->droppedCount();
    s.clock.hostNs = blockHostNs_;
    s.clock.samplePosition = samplesProcessed_ - static_cast<std::uint64_t>(numSamples);
    s.clock.blockSize = static_cast<std::uint32_t>(numSamples);
    s.clock.sampleRate = config_.sampleRate;
    s.activeVoices = sampler_.activeVoices();
    s.voiceStealing = sampler_.stealCount();
    s.padActiveMask = sampler_.padActiveMask();
    s.drumActiveMask = sampler_.drumActiveMask();
    s.lastTriggeredPad = sampler_.lastTriggeredPad();
    s.lastTriggeredPadPositionSec = sampler_.lastTriggeredPadPositionSec();
    s.seqPlaying = seq_.playing() ? 1u : 0u;
    s.seqPaused = seq_.paused() ? 1u : 0u;
    s.seqLoop = seq_.loop() ? 1u : 0u;
    s.seqStep = seq_.playing() ? seq_.currentStep() : -1;
    s.seqStepCount = seq_.stepCount();
    s.seqPatternIndex = seq_.patternIndex();
    s.seqStepPhase = seq_.stepPhase(samplesProcessed_);
    s.seqBpm = seq_.bpm();
    s.seqLoopStartSample = seq_.loopStartSample();
    s.seqHitsFired = seq_.hitsFired();
    s.seqHitsSkipped = seq_.hitsSkippedLiveOwned();
    s.drumPlaying = drums_.playing() ? 1u : 0u;
    s.drumStep = drums_.currentStep();
    s.drumStepCount = drums_.stepCount();
    s.drumStepPhase = drums_.stepPhase();
    s.drumLoopStartSample = drums_.loopStartSample();
    s.drumHitsFired = drums_.hitsFired();
    s.drumHitsSkipped = drums_.hitsSkippedLiveOwned();
    s.bassPlaying = bassSeq_.playing() ? 1u : 0u;
    s.bassArrangerDriven = bassSeq_.arrangerDriven() ? 1u : 0u;
    s.bassTick = bassSeq_.currentTick();
    s.bassLoopTicks = bassSeq_.loopTicks();
    s.bassLoopStartSample = bassSeq_.loopStartSample();
    s.bassVoices = bass_.activeVoices();
    s.bassLevel = bass_.meterLevel();
    bass_.activeNoteMask(s.bassNoteMask);
    s.bassNotesFired = bass_.notesFired();
    s.bassEventsDropped = bass_.eventsDropped();
    s.bassTimelineFired = bassSeq_.timelineEventsFired();
    s.bassBend = bass_.pitchBend();
    s.calibrationState = calibState_;
    s.calibrationId = calibId_;
    snapshot_.publish(s);
}

void Engine::process(const float* const* inputs, int numIn, float* const* outputs, int numOut, int numSamples,
                     std::uint64_t hostTimeNs) noexcept TERMINATOR_NONBLOCKING
{
    if (outputs == nullptr || numOut <= 0 || numSamples <= 0)
        return;

    for (int ch = 0; ch < numOut; ++ch)
        if (outputs[ch] != nullptr)
            std::fill_n(outputs[ch], numSamples, 0.0f);

    if (!prepared_)
        return;

    prevBlockHostNs_ = blockHostNs_;
    blockHostNs_ = hostTimeNs;

    drainCommands(numSamples);
    drainMidi(numSamples);
    firePendingTriggers(numSamples); // live hits booked ahead (quantized live record) land at their exact sample
    seq_.process(samplesProcessed_, numSamples, sampler_, liveHitSample_);   // this block's sequenced hits + note ends
    drums_.process(samplesProcessed_, numSamples, sampler_, liveHitSample_); // this block's drum hits / rolls / ends
    bassSeq_.process(samplesProcessed_, numSamples, bass_);                  // this block's bass ticks / timeline
    if (playing_ && !seq_.playing() && !drums_.playing() && (seqWasPlaying_ || drumsWasPlaying_))
        playing_ = false; // the sequencers stopped themselves (loop off): the transport follows
    seqWasPlaying_ = seq_.playing();
    drumsWasPlaying_ = drums_.playing();

    // ---- input peaks + calibration capture ----
    const int nIn = std::min(numIn, kMaxInputChannels);
    for (int ch = 0; ch < kMaxInputChannels; ++ch)
        inputPeak_[ch] = 0.0f;
    if (inputs != nullptr)
        for (int ch = 0; ch < nIn; ++ch)
            if (const float* in = inputs[ch])
            {
                float pk = 0.0f;
                for (int i = 0; i < numSamples; ++i)
                {
                    const float a = in[i] < 0.0f ? -in[i] : in[i];
                    pk = a > pk ? a : pk;
                }
                inputPeak_[ch] = pk;
            }
    if (calibState_ == 1 && inputs != nullptr && calibIn_ < nIn && inputs[calibIn_] != nullptr)
    {
        const float* in = inputs[calibIn_];
        const std::uint32_t room = calibTarget_ - calibRecorded_;
        const std::uint32_t n = std::min<std::uint32_t>(room, static_cast<std::uint32_t>(numSamples));
        std::copy_n(in, n, calibCapture_.data() + calibRecorded_);
        calibRecorded_ += n;
        if (calibRecorded_ >= calibTarget_)
            calibState_ = 2;
    }

    // ---- sources ----
    sampler_.render(outputs, numOut, numSamples);
    bass_.render(outputs[0], numOut > 1 ? outputs[1] : nullptr, numSamples, samplesProcessed_); // dry, outs 1/2

    if (toneEnabled_)
    {
        const int outL = static_cast<int>(toneOutputPair_) * 2;
        float* l = outL < numOut ? outputs[outL] : nullptr;
        float* r = outL + 1 < numOut ? outputs[outL + 1] : nullptr;
        for (int i = 0; i < numSamples; ++i)
        {
            const float v = static_cast<float>(toneIm_) * toneAmplitude_;
            if (l != nullptr)
                l[i] += v;
            if (r != nullptr)
                r[i] += v;
            const double re = toneRe_ * toneCos_ - toneIm_ * toneSin_;
            const double im = toneRe_ * toneSin_ + toneIm_ * toneCos_;
            toneRe_ = re;
            toneIm_ = im;
        }
        const double mag2 = toneRe_ * toneRe_ + toneIm_ * toneIm_;
        if (mag2 > 0.0)
        {
            const double k = 1.5 - 0.5 * mag2; // one Newton step of 1/sqrt
            toneRe_ *= k;
            toneIm_ *= k;
        }
    }

    if (calibState_ == 1 && calibOut_ < numOut && outputs[calibOut_] != nullptr &&
        calibClickPos_ < static_cast<std::uint32_t>(kCalibrationClickFrames))
    {
        float* out = outputs[calibOut_];
        const float* click = clickTable().v;
        for (int i = 0; i < numSamples && calibClickPos_ < static_cast<std::uint32_t>(kCalibrationClickFrames);
             ++i, ++calibClickPos_)
            out[i] += click[calibClickPos_] * 0.5f;
    }

    // ---- master gain (one-block ramp) + peaks ----
    const float gainStart = masterGainCurrent_;
    const float gainEnd = masterGainTarget_;
    const float gainStep = (gainEnd - gainStart) / static_cast<float>(numSamples);
    const int nOut = std::min(numOut, kMaxOutputChannels);
    for (int ch = 0; ch < kMaxOutputChannels; ++ch)
        outputPeak_[ch] = 0.0f;
    for (int ch = 0; ch < numOut; ++ch)
    {
        float* out = outputs[ch];
        if (out == nullptr)
            continue;
        float g = gainStart;
        float pk = 0.0f;
        for (int i = 0; i < numSamples; ++i)
        {
            const float v = out[i] * g;
            out[i] = v;
            const float a = v < 0.0f ? -v : v;
            pk = a > pk ? a : pk;
            g += gainStep;
        }
        if (ch < nOut)
            outputPeak_[ch] = pk;
    }
    masterGainCurrent_ = gainEnd;

    if (playing_)
        playheadSamples_ += static_cast<std::uint64_t>(numSamples);
    samplesProcessed_ += static_cast<std::uint64_t>(numSamples);
    ++blocksProcessed_;

    publish(numSamples);
}

} // namespace terminator
