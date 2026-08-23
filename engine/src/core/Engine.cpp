#include "terminator/core/Engine.h"

#include <algorithm>
#include <cmath>

namespace terminator
{

// An Engine VALUE lives on test / tool stacks (two at a time in the render-comparison gates) and Windows threads get
// 1 MB by default: the big buffers are on the heap; this keeps anyone from growing it back (4.1's Mixer once did,
// silently: 502 KB → 16 Windows tests died of stack overflow).
static_assert(sizeof(Engine) <= 384 * 1024, "Engine must stay small enough for a 1 MB stack — heap the new member");


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
    : commands_(std::make_unique<Commands>()), midiQueues_(kMaxMidiPorts), midiOut_(std::make_unique<MidiOutQueue>()),
      mixer_(std::make_unique<Mixer>()), calibCapture_(kCalibrationMaxFrames, 0.0f)
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
    clockOut_.prepare(config_.sampleRate);
    metro_.prepare(config_.sampleRate);
    arp_.prepare(config_.sampleRate);
    fxPool_.prepare(config_.sampleRate, config_.maxBlockSize);
    mixer_->setPool(&fxPool_);
    mixer_->prepare(config_.sampleRate, config_.maxBlockSize);
    scratchL_.assign(static_cast<std::size_t>(config_.maxBlockSize), 0.0f);
    scratchR_.assign(static_cast<std::size_t>(config_.maxBlockSize), 0.0f);
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
    clockOut_.reset();
    metro_.reset();
    arp_.reset();
    mixer_->reset();
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
        clockOut_.stop(samplesProcessed_);
        metro_.transportStopped();
        metro_.cancelCountIn();
        arp_.stop();
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
        // the MIDI clock rides the SAME anchor (the TS seqStartHook → MidiClockSender.start(at)); a restart re-sends
        // STOP + SPP 0 + START
        clockOut_.start(c.payload.seq.atSample != 0 ? c.payload.seq.atSample : samplesProcessed_, samplesProcessed_);
        metro_.transportStopped(); // a (re)start: the booked beats go; the new run's steps re-book them
        break;
    case CommandType::seqStop:
        seq_.stop();
        playing_ = false;
        clockOut_.stop(samplesProcessed_);
        metro_.transportStopped();
        break;
    case CommandType::seqPause:
        seq_.pause(samplesProcessed_, sampler_);
        clockOut_.pause(samplesProcessed_);
        metro_.transportStopped(); // no clicks while paused (the TS gate)
        break;
    case CommandType::seqResume:
        seq_.resume(samplesProcessed_);
        clockOut_.resume(samplesProcessed_);
        break;
    case CommandType::seqSetBpm:
        seq_.setBpm(c.payload.seq.value);
        drums_.setBpm(c.payload.seq.value); // one BPM for every sequencer (getMasterBpm)
        bassSeq_.setBpm(c.payload.seq.value);
        clockOut_.setBpm(c.payload.seq.value); // the tick spacing follows at the next tick
        metro_.setBpm(c.payload.seq.value);    // the count-in beat (the beats themselves ride the sequencer grid)
        arp_.setBpm(c.payload.seq.value);      // the arp interval follows at the next step
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
        // drums alone (no sample loaded: the page's PLAY starts only the drums) still clock the outboard gear — the
        // first transport to start anchors the clock; a seqPlay in the same run already did
        if (!clockOut_.running())
            clockOut_.start(c.payload.drum.atSample != 0 ? c.payload.drum.atSample : samplesProcessed_,
                            samplesProcessed_);
        if (!seq_.playing())
            metro_.transportStopped(); // the drums drive the clicks alone: a restart drops the booked beats
        break;
    case CommandType::drumStop:
        drums_.stop(sampler_);
        if (!seq_.playing())
        {
            clockOut_.stop(samplesProcessed_);
            metro_.transportStopped();
        }
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
    case CommandType::midiClockEnable:
        clockOut_.setEnabled(c.payload.midi.flag != 0, samplesProcessed_);
        break;
    case CommandType::setMidiRouting:
        midiNotesToPads_ = c.payload.midi.flag != 0;
        break;
    // ---- the mixer (Phase 4.1) ----
    case CommandType::mixerSetStrip:
        mixer_->setStripKind(c.payload.strip.strip,
                            static_cast<StripKind>(c.payload.strip.kind > 4 ? 0 : c.payload.strip.kind));
        break;
    case CommandType::mixerSetFader:
        mixer_->setFader(c.payload.strip.strip, c.payload.strip.value);
        break;
    case CommandType::mixerSetPan:
        mixer_->setPan(c.payload.strip.strip, c.payload.strip.value);
        break;
    case CommandType::mixerSetWidth:
        mixer_->setWidth(c.payload.strip.strip, c.payload.strip.value);
        break;
    case CommandType::mixerSetMute:
        mixer_->setMute(c.payload.strip.strip, c.payload.strip.flag != 0);
        break;
    case CommandType::mixerSetSolo:
        mixer_->setSolo(c.payload.strip.strip, c.payload.strip.flag != 0);
        break;
    case CommandType::mixerSetSend:
        (void)mixer_->setSend(c.payload.strip.strip, c.payload.strip.index, c.payload.strip.value,
                             c.payload.strip.target);
        break;
    case CommandType::mixerSetOutput:
        (void)mixer_->setOutput(c.payload.strip.strip,
                               static_cast<StripOutput>(c.payload.strip.kind > 3 ? 0 : c.payload.strip.kind),
                               c.payload.strip.index);
        break;
    case CommandType::mixerSetMainOut:
        mixer_->setMainOut(c.payload.strip.index);
        break;
    case CommandType::setSourceStrip:
    {
        const int strip =
            c.payload.strip.target >= 0 && c.payload.strip.target < kMaxStrips ? c.payload.strip.target : -1;
        if (c.payload.strip.kind == 0)
            bassStrip_ = strip;
        else if (c.payload.strip.kind == 1)
            clickStrip_ = strip;
        break;
    }
    // ---- the insert chain (Phase 4.2) ----
    case CommandType::mixerAddFx:
        (void)mixer_->addFx(c.payload.fx.strip, static_cast<FxType>(c.payload.fx.type));
        break;
    case CommandType::mixerRemoveFx:
        (void)mixer_->removeFx(c.payload.fx.strip, c.payload.fx.index);
        break;
    case CommandType::mixerSetFxBypass:
        mixer_->setFxBypass(c.payload.fx.strip, c.payload.fx.index, c.payload.fx.flag != 0);
        break;
    case CommandType::mixerSetFxParam:
        mixer_->setFxParam(c.payload.fx.strip, c.payload.fx.index, c.payload.fx.param, c.payload.fx.value,
                          c.payload.fx.flag != 0);
        break;
    case CommandType::mixerReorderFx:
        (void)mixer_->reorderFx(c.payload.fx.strip, c.payload.fx.index, c.payload.fx.to);
        break;
    case CommandType::mixerClearFx:
        mixer_->clearFx(c.payload.fx.strip);
        break;
    case CommandType::setMetronome:
        metro_.setEnabled(c.payload.metro.enabled != 0);
        metro_.setSound(static_cast<ClickSound>(c.payload.metro.sound > 4 ? 0 : c.payload.metro.sound));
        break;
    case CommandType::countIn:
        metro_.countIn(c.payload.metro.beats, c.payload.metro.atSample, samplesProcessed_);
        break;
    case CommandType::cancelCountIn:
        metro_.cancelCountIn();
        break;
    case CommandType::setArp:
        arp_.setParams(c.payload.arp.enabled != 0, c.payload.arp.rate, c.payload.arp.down != 0,
                       c.payload.arp.random != 0, c.payload.arp.padCount);
        break;
    case CommandType::arpHold:
    {
        const int pad = c.payload.arp.pad;
        if (pad < 0 || pad >= kChopPads)
            break;
        if (arp_.enabled())
            arp_.hold(pad, c.payload.arp.velocity, c.payload.arp.atSample, samplesProcessed_);
        else
        {
            // the arp is off: a plain hit (the page never sends this then — harmless)
            bookTrigger(static_cast<std::uint16_t>(pad), c.payload.arp.velocity,
                        c.payload.arp.atSample != 0 ? c.payload.arp.atSample : samplesProcessed_, false, numSamples);
        }
        break;
    }
    case CommandType::arpRelease:
        arp_.release(c.payload.arp.pad);
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
            if (e.size < 2 || !midiNotesToPads_)
                continue; // the page owns the notes (bass MIDI IN / DRUM PADS / MIDI OFF / learn) — mirrored, not
                          // played
            const std::uint8_t status = e.data[0] & 0xF0u;
            const std::uint8_t note = e.data[1] & 0x7Fu;
            const std::uint8_t vel = e.size > 2 ? (e.data[2] & 0x7Fu) : 0;
            const std::int16_t pad = noteToPad_[note];
            if (pad < 0)
                continue;
            if (status == 0x90 && vel > 0)
            {
                const auto off = offsetForHostTime(e.hostTimeNs, numSamples);
                if (arp_.enabled() && pad < kChopPads)
                {
                    // ARP on: holding the note steps through the bank (TS triggerPad → startArp); the arp stamps the
                    // live-hit times itself
                    arp_.hold(pad, static_cast<float>(vel) / 127.0f,
                              samplesProcessed_ + static_cast<std::uint64_t>(off), samplesProcessed_);
                    continue;
                }
                sampler_.trigger(static_cast<std::uint16_t>(pad), static_cast<float>(vel) / 127.0f, off);
                noteLiveHit(static_cast<std::uint16_t>(pad),
                            static_cast<double>(samplesProcessed_) + static_cast<double>(off));
            }
            else if (status == 0x80 || (status == 0x90 && vel == 0))
            {
                if (arp_.enabled())
                    arp_.release(pad); // TS releasePad: the held pad's note-off stops the arp
                sampler_.release(static_cast<std::uint16_t>(pad));
            }
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
    s.lastLiveHitPad = lastLiveHitPad_;
    s.lastLiveHitSample = lastLiveHitSample_;
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
    s.midiClockEnabled = clockOut_.enabled() ? 1u : 0u;
    s.midiClockRunning = clockOut_.running() ? 1u : 0u;
    s.midiClockTicks = clockOut_.ticksSent();
    s.midiClockPosition = clockOut_.tickCount();
    s.midiOutDropped = midiOut_->droppedCount();
    s.midiNotesToPads = midiNotesToPads_ ? 1u : 0u;
    s.metronomeEnabled = metro_.enabled() ? 1u : 0u;
    s.metronomeSound = static_cast<std::uint32_t>(metro_.sound());
    s.metronomeBeat = metro_.beat();
    s.metronomeClicks = metro_.clicks();
    s.metronomeLastClickSample = metro_.lastClickSample();
    s.metronomeLastClickAccent = metro_.lastClickAccent() ? 1u : 0u;
    s.countInBeat = metro_.countInBeat();
    s.countInPending = metro_.countInPending() ? 1u : 0u;
    s.countInDownbeatSample = metro_.countInDownbeatSample();
    s.arpEnabled = arp_.enabled() ? 1u : 0u;
    s.arpHoldPad = arp_.holdPad();
    s.arpStep = arp_.step();
    s.arpLastPad = arp_.lastPad();
    s.arpHits = arp_.hits();
    // the mixer (4.1)
    s.mixerActiveMask = mixer_->activeMask();
    s.mixerSilentMask = mixer_->silentMask();
    s.mixerRoutesRejected = mixer_->routesRejected();
    s.mixerOrderValid = mixer_->orderValid() ? 1u : 0u;
    s.mixerMainOut = mixer_->mainOut();
    s.bassStrip = bassStrip_;
    s.clickStrip = clickStrip_;
    for (int i = 0; i < kMaxStrips; ++i)
    {
        const auto& m = mixer_->meter(i);
        s.stripPeakPre[i][0] = m.peakPre[0];
        s.stripPeakPre[i][1] = m.peakPre[1];
        s.stripPeakPost[i][0] = m.peakPost[0];
        s.stripPeakPost[i][1] = m.peakPost[1];
        s.stripRmsPre[i] = m.rmsPre;
        s.stripRmsPost[i] = m.rmsPost;
        s.stripGain[i] = mixer_->currentGain(i);
        s.stripFxCount[i] = static_cast<std::uint8_t>(mixer_->fxCount(i));
    }
    s.mixerFxRejected = mixer_->fxRejected();
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
    arp_.process(samplesProcessed_, numSamples, sampler_, liveHitSample_);   // the held arp's steps (live hits)
    seq_.process(samplesProcessed_, numSamples, sampler_, liveHitSample_);   // this block's sequenced hits + note ends
    drums_.process(samplesProcessed_, numSamples, sampler_, liveHitSample_); // this block's drum hits / rolls / ends
    bassSeq_.process(samplesProcessed_, numSamples, bass_);                  // this block's bass ticks / timeline
    // the metronome's beats ride the DRIVING sequencer's grid (3.6): the chop sequencer while it plays (paused = no
    // steps = no clicks), else the drums alone; the other log is drained and dropped
    {
        const int n1 = seq_.takeGridLog(gridLog_, kMaxGridLog);
        if (seq_.playing() || n1 > 0)
        {
            for (int i = 0; i < n1; ++i)
                metro_.onGridStep(gridLog_[i]);
            (void)drums_.takeGridLog(gridLog_, kMaxGridLog);
        }
        else
        {
            const int n2 = drums_.takeGridLog(gridLog_, kMaxGridLog);
            for (int i = 0; i < n2; ++i)
                metro_.onGridStep(gridLog_[i]);
        }
    }
    if (playing_ && !seq_.playing() && !drums_.playing() && (seqWasPlaying_ || drumsWasPlaying_))
        playing_ = false; // the sequencers stopped themselves (loop off): the transport follows
    if (clockOut_.running() && !seq_.playing() && !drums_.playing())
        clockOut_.stop(samplesProcessed_); // … and so does the MIDI clock (STOP to the gear)
    seqWasPlaying_ = seq_.playing();
    drumsWasPlaying_ = drums_.playing();
    // MIDI clock OUT (3.5): this block's SPP/START/CONTINUE/STOP/ticks at their exact samples → the out queue, stamped
    // with the host time the sample is HEARD (block entry + offset + output latency); the MidiHub pump sends them then
    {
        const int n = clockOut_.process(samplesProcessed_, numSamples, clockEvents_, MidiClockOut::kMaxEventsPerBlock);
        for (int i = 0; i < n; ++i)
        {
            const auto& ce = clockEvents_[i];
            MidiOutEvent oe;
            oe.sample = ce.sample;
            oe.data[0] = ce.data[0];
            oe.data[1] = ce.data[1];
            oe.data[2] = ce.data[2];
            oe.size = ce.size;
            if (blockHostNs_ != 0 && config_.sampleRate > 0.0)
            {
                const double offSamples = static_cast<double>(ce.sample - samplesProcessed_) +
                                          static_cast<double>(config_.outputLatencySamples);
                oe.hostTimeNs = blockHostNs_ + static_cast<std::uint64_t>(offSamples / config_.sampleRate * 1e9);
            }
            midiOut_->push(oe);
        }
    }

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
    // the mixer (4.1): pads / drum lanes with a strip sum into the strip's 64-bit accumulator (the sampler renders
    // them alone into a scratch first); the bass and the click follow their setSourceStrip; everything with strip −1
    // keeps the direct path (outputs[pair], dry)
    mixer_->clearInputs(numSamples);
    sampler_.render(outputs, numOut, numSamples, mixer_->inputs(), kMaxStrips);
    if (bassStrip_ >= 0 && mixer_->isActive(bassStrip_) && numSamples <= static_cast<int>(scratchL_.size()))
    {
        std::fill_n(scratchL_.data(), numSamples, 0.0f);
        std::fill_n(scratchR_.data(), numSamples, 0.0f);
        bass_.render(scratchL_.data(), scratchR_.data(), numSamples, samplesProcessed_);
        mixer_->addToStrip(bassStrip_, scratchL_.data(), scratchR_.data(), numSamples);
    }
    else
        bass_.render(outputs[0], numOut > 1 ? outputs[1] : nullptr, numSamples, samplesProcessed_); // dry, outs 1/2
    float clickPeak = -1.0f; // ≥ 0 = the click was rendered into its strip this block (not post-master below)
    if (clickStrip_ >= 0 && mixer_->isActive(clickStrip_) && numSamples <= static_cast<int>(scratchL_.size()))
    {
        std::fill_n(scratchL_.data(), numSamples, 0.0f);
        std::fill_n(scratchR_.data(), numSamples, 0.0f);
        clickPeak = metro_.process(samplesProcessed_, numSamples, scratchL_.data(), scratchR_.data());
        mixer_->addToStrip(clickStrip_, scratchL_.data(), scratchR_.data(), numSamples);
    }

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

    // ---- the mixer: strips → sends → buses → master → the hardware outs (4.1) ----
    mixer_->process(outputs, numOut, numSamples);

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

    // the metronome + count-in clicks (3.6): synthesised at their samples, added AFTER the master gain — the TS clicks
    // went straight to the destination past the mixer. With a CLICK strip (setSourceStrip 1, Phase 4.1) they were
    // rendered into that strip above instead and ride the mix
    if (clickPeak < 0.0f)
    {
        float* l = numOut > 0 ? outputs[0] : nullptr;
        float* r = numOut > 1 ? outputs[1] : nullptr;
        const float pk = metro_.process(samplesProcessed_, numSamples, l, r);
        if (pk > outputPeak_[0])
            outputPeak_[0] = pk;
        if (numOut > 1 && pk > outputPeak_[1])
            outputPeak_[1] = pk;
    }

    if (playing_)
        playheadSamples_ += static_cast<std::uint64_t>(numSamples);
    samplesProcessed_ += static_cast<std::uint64_t>(numSamples);
    ++blocksProcessed_;

    publish(numSamples);
}

} // namespace terminator
