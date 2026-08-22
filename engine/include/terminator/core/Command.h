#pragma once
// UI → engine commands. Plain trivially-copyable structs so they can travel through the lock-free queue
// without any allocation. Every new engine capability adds a CommandType + payload here AND a line in
// docs/native/BRIDGE-PROTOCOL.md (the JSON form the WebView sends is translated into these by the shell).
#include <cstdint>
#include <type_traits>

namespace terminator
{

struct SampleBuffer;

enum class CommandType : std::uint32_t
{
    none = 0,
    setMasterGain,      // gain
    setTestTone,        // testTone
    transportPlay,      // —
    transportStop,      // —
    panic,              // — stop every voice now (3 ms fade), tone off, transport stop
    setPadSample,       // padSample — pad takes a SampleBuffer (nullptr = clear); region in frames of that buffer
    setPadParams,       // padParams — pitch/fine/attack/release/gain/output/mode/reverse/choke/interp
    triggerPad,         // trigger — start a voice (hostTimeNs 0 = at the start of the next block)
    releasePad,         // trigger — note-off (gate pads release; one-shots ignore)
    triggerPadAtSample, // trigger — hostTimeNs holds an ENGINE SAMPLE POSITION (samplesProcessed scale); must fall
                        // inside the current block
    releasePadAtSample, // trigger — same, for note-off
    stopPad,            // trigger — stop the pad's voices (3 ms fade)
    setNoteMap,         // noteMap — MIDI note → pad (−1 = unmapped)
    startCalibration,   // calibration — emit a click on out channel, record in channel
    setPadLoopBuffer,   // padLoop — attach/clear a pad's pre-rendered crossfade-loop buffer + its steady bracket
    setPadStems,        // padStems — attach the pad's stem planes (drums/bass/other/vocals) + its 4-bit mask; a ringing
                        // voice re-stems live (12 ms crossfade)
};

enum class PadMode : std::uint8_t
{
    oneShot = 0,
    gate = 1, // sounds only while held
    loop = 2, // loops the region until retriggered/stopped
};

enum class Interpolation : std::uint8_t
{
    linear = 0,  // "CLASSIC" — matches the Web Audio engine for golden renders
    hermite = 1, // 4-point — the native default
};

struct PadParams
{
    std::uint16_t pad = 0;
    float pitchSemitones = 0.0f; // −48..+48 (pad PITCH ±24 + its source's PITCH ±24, summed by the UI)
    float fineCents = 0.0f;      // −50..+50
    float attackSec = 0.003f;    // 0..0.5
    float releaseSec = 0.0f;     // 0..0.5
    float gain = 1.0f;           // 0..4 (per-pad NORM × user gain)
    std::uint8_t outputPair = 0; // 0 = outs 1/2, 1 = outs 3/4, …
    PadMode mode = PadMode::oneShot;
    std::uint8_t reverse = 0;
    std::uint8_t gate =
        0; // NOTE ON: release() ends the voice (any mode — a gated LOOP loops while held); PadMode::gate
           // implies it. 0 = the voice plays out on its own (one-shot / free-running loop)
    std::int16_t chokeGroup = -1; // −1 = the pad itself; ≥0 = a shared mute group id; −2 = poly (never choked)
    Interpolation interpolation = Interpolation::hermite;
};

struct Command
{
    CommandType type = CommandType::none;
    std::uint32_t sequence = 0; // producer-side counter (debug / ordering checks)

    union Payload
    {
        struct Gain
        {
            float linear; // 0..4, applied with a one-block linear ramp
        } gain;

        struct TestTone
        {
            float frequencyHz;
            float amplitude; // peak, 0..1
            std::uint32_t enabled;
            std::uint8_t outputPair;
        } testTone;

        struct PadSample
        {
            const SampleBuffer* sample; // lifetime owned by SampleStore (see retire/collect rule)
            std::int64_t startFrame;    // region inside the buffer, in that buffer's frames
            std::int64_t endFrame;      // exclusive; ≤ numFrames (0,0 = whole buffer)
            std::uint16_t pad;
        } padSample;

        PadParams padParams;

        struct Trigger
        {
            std::uint64_t hostTimeNs; // 0 = as soon as possible (start of the next block)
            float velocity;           // 0..1 linear gain
            std::uint16_t pad;
        } trigger;

        struct NoteMap
        {
            std::uint8_t note;
            std::int16_t pad; // −1 = unmapped
        } noteMap;

        struct PadLoop
        {
            const SampleBuffer* sample; // the rendered loop buffer (nullptr = clear)
            std::int64_t loopStart;     // steady period bracket, frames of `sample`
            std::int64_t loopEnd;
            std::uint16_t pad;
        } padLoop;

        struct PadStems
        {
            const SampleBuffer* planes[4]; // drums, bass, other, vocals — each the same length/rate as the pad's base
                                           // buffer (nullptr = that stem is absent); lifetime owned like a sample
            std::uint16_t pad;
            std::uint8_t mask; // bit i = plane i lit; 0 / 15 / a lit plane missing = the base buffer plays
        } padStems;

        struct Calibration
        {
            std::uint16_t outputChannel;
            std::uint16_t inputChannel;
            std::uint32_t recordFrames; // ≤ Engine::kCalibrationMaxFrames
            std::uint32_t id;           // echoed in StateSnapshot::calibrationId when done
        } calibration;
    } payload{};

    static Command setMasterGain(float linear) noexcept
    {
        Command c;
        c.type = CommandType::setMasterGain;
        c.payload.gain.linear = linear;
        return c;
    }
    static Command setTestTone(bool enabled, float frequencyHz, float amplitude, std::uint8_t outputPair = 0) noexcept
    {
        Command c;
        c.type = CommandType::setTestTone;
        c.payload.testTone.enabled = enabled ? 1u : 0u;
        c.payload.testTone.frequencyHz = frequencyHz;
        c.payload.testTone.amplitude = amplitude;
        c.payload.testTone.outputPair = outputPair;
        return c;
    }
    static Command transportPlay() noexcept
    {
        Command c;
        c.type = CommandType::transportPlay;
        return c;
    }
    static Command transportStop() noexcept
    {
        Command c;
        c.type = CommandType::transportStop;
        return c;
    }
    static Command panic() noexcept
    {
        Command c;
        c.type = CommandType::panic;
        return c;
    }
    static Command setPadSample(std::uint16_t pad, const SampleBuffer* sample, std::int64_t startFrame = 0,
                                std::int64_t endFrame = 0) noexcept
    {
        Command c;
        c.type = CommandType::setPadSample;
        c.payload.padSample.pad = pad;
        c.payload.padSample.sample = sample;
        c.payload.padSample.startFrame = startFrame;
        c.payload.padSample.endFrame = endFrame;
        return c;
    }
    static Command setPadParams(const PadParams& p) noexcept
    {
        Command c;
        c.type = CommandType::setPadParams;
        c.payload.padParams = p;
        return c;
    }
    static Command triggerPad(std::uint16_t pad, float velocity, std::uint64_t hostTimeNs = 0) noexcept
    {
        Command c;
        c.type = CommandType::triggerPad;
        c.payload.trigger.pad = pad;
        c.payload.trigger.velocity = velocity;
        c.payload.trigger.hostTimeNs = hostTimeNs;
        return c;
    }
    static Command releasePad(std::uint16_t pad, std::uint64_t hostTimeNs = 0) noexcept
    {
        Command c;
        c.type = CommandType::releasePad;
        c.payload.trigger.pad = pad;
        c.payload.trigger.velocity = 0.0f;
        c.payload.trigger.hostTimeNs = hostTimeNs;
        return c;
    }
    static Command triggerPadAtSample(std::uint16_t pad, float velocity, std::uint64_t samplePosition) noexcept
    {
        Command c = triggerPad(pad, velocity, samplePosition);
        c.type = CommandType::triggerPadAtSample;
        return c;
    }
    static Command releasePadAtSample(std::uint16_t pad, std::uint64_t samplePosition) noexcept
    {
        Command c = releasePad(pad, samplePosition);
        c.type = CommandType::releasePadAtSample;
        return c;
    }
    static Command stopPad(std::uint16_t pad) noexcept
    {
        Command c;
        c.type = CommandType::stopPad;
        c.payload.trigger.pad = pad;
        c.payload.trigger.velocity = 0.0f;
        c.payload.trigger.hostTimeNs = 0;
        return c;
    }
    static Command setNoteMap(std::uint8_t note, std::int16_t pad) noexcept
    {
        Command c;
        c.type = CommandType::setNoteMap;
        c.payload.noteMap.note = note;
        c.payload.noteMap.pad = pad;
        return c;
    }
    static Command setPadLoopBuffer(std::uint16_t pad, const SampleBuffer* sample, std::int64_t loopStart,
                                    std::int64_t loopEnd) noexcept
    {
        Command c;
        c.type = CommandType::setPadLoopBuffer;
        c.payload.padLoop.pad = pad;
        c.payload.padLoop.sample = sample;
        c.payload.padLoop.loopStart = loopStart;
        c.payload.padLoop.loopEnd = loopEnd;
        return c;
    }
    static Command setPadStems(std::uint16_t pad, const SampleBuffer* const planes[4], std::uint8_t mask) noexcept
    {
        Command c;
        c.type = CommandType::setPadStems;
        c.payload.padStems.pad = pad;
        c.payload.padStems.mask = mask;
        for (int i = 0; i < 4; ++i)
            c.payload.padStems.planes[i] = planes != nullptr ? planes[i] : nullptr;
        return c;
    }
    static Command startCalibration(std::uint16_t outputChannel, std::uint16_t inputChannel, std::uint32_t recordFrames,
                                    std::uint32_t id) noexcept
    {
        Command c;
        c.type = CommandType::startCalibration;
        c.payload.calibration.outputChannel = outputChannel;
        c.payload.calibration.inputChannel = inputChannel;
        c.payload.calibration.recordFrames = recordFrames;
        c.payload.calibration.id = id;
        return c;
    }
};

static_assert(std::is_trivially_copyable_v<Command>, "Command must be trivially copyable (lock-free queue)");
static_assert(std::is_trivially_copyable_v<PadParams>, "PadParams must be trivially copyable");
static_assert(sizeof(Command) <= 64, "Keep Command within one cache line");

} // namespace terminator
