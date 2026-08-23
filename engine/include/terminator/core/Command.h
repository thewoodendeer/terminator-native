#pragma once
// UI → engine commands. Plain trivially-copyable structs so they can travel through the lock-free queue
// without any allocation. Every new engine capability adds a CommandType + payload here AND a line in
// docs/native/BRIDGE-PROTOCOL.md (the JSON form the WebView sends is translated into these by the shell).
#include <cstdint>
#include <type_traits>

namespace terminator
{

struct SampleBuffer;
struct SeqPattern;
struct DrumPattern;
struct DrumGraphs;
struct BassPatch;
struct BassPattern;
struct BassTimeline;

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
    triggerPadAtSample, // trigger — hostTimeNs holds an ENGINE SAMPLE POSITION (samplesProcessed scale); inside the
                        // current block it fires at that offset, past it the engine books it (a 64-slot RT ring) and
                        // fires it sample-exact in the block that contains it (quantized live-record hits)
    releasePadAtSample, // trigger — same, for note-off
    stopPad,            // trigger — stop the pad's voices (3 ms fade)
    setNoteMap,         // noteMap — MIDI note → pad (−1 = unmapped)
    startCalibration,   // calibration — emit a click on out channel, record in channel
    setPadLoopBuffer,   // padLoop — attach/clear a pad's pre-rendered crossfade-loop buffer + its steady bracket
    setPadStems,        // padStems — attach the pad's stem planes (drums/bass/other/vocals) + its 4-bit mask; a ringing
                        // voice re-stems live (12 ms crossfade)
    // ---- the chop sequencer on the native transport (Phase 3.1, core/ChopSequencer.h) ----
    seqSetPattern,   // seq — live replace: the steps not fired yet read the new pattern (pointer owned by the shell)
    seqQueuePattern, // seq — switch at the next step 0 (the loop boundary); not playing = take it now
    seqPlay,         // seq — start at atSample (0 = the start of the next block); restarts when playing
    seqStop,         // —
    seqPause,        // — freeze the position
    seqResume,       // — continue from the frozen position
    seqSetBpm,       // seq.value — 20..300, applies at the next step (the drum sequencer reads the same BPM)
    seqSetLoop,      // seq.value — 0/1
    // ---- the drum sequencer (Phase 3.3, core/DrumSequencer.h) — lane L plays pad kDrumPadBase + L ----
    drumSetPattern, // drum.pattern — live replace: the steps not scheduled yet read it (pointer owned by the shell)
    drumSchedulePattern, // drum.pattern + drum.atSample — arranged playback: a step whose grid time ≥ atSample uses it
    drumClearScheduled,  // — drop the arranged swap list (the live pattern plays again)
    drumSetGraphs, // drum.graphs — the VELOCITY / SHIFT / PAN / REPEAT rows (engine-level, shared by every pattern)
    drumSetLane,   // drumLane — one lane's volume, audible (mute + solo resolved by the UI), mute group
    drumSetParams, // drumParams — swing 0..1, master volume 0..1, ppq (the SHIFT snap grid)
    drumPlay,      // drum.atSample (0 = the start of the next block) + drum.stepOffset — start; restarts when playing
    drumStop,      // — stop scheduling; every drum-lane voice fades (its lane's choke fade)
    // ---- the bass synth + its pattern sequencer (Phase 3.4, core/BassSynth.h + core/BassSequencer.h) ----
    bassSetPatch,       // bass.ptr = BassPatch* (nullptr = defaults; pointer owned by the shell's ring)
    bassSetPattern,     // bass.ptr = BassPattern* — live replace (sounding notes whose pitch changed / off vanished
                        // are released; the next ticks read the new map)
    bassSetTimeline,    // bass.ptr = BassTimeline* — the arranger's absolute-time events (nullptr = none)
    bassClearTimeline,  // — drop the arr events, release what sounds, bend 0
    bassArrangerDriven, // bass.flag — the pattern ticks stay quiet while the arranger drives
    bassBendLane,       // bass.flag — 0 while the wheel records into the lane
    bassPlay,           // bass.atSample (0 = next block) + bass.offsetTicks — start; restarts when playing
    bassStop,           // — stop, release the seq notes, bend 0
    bassNote,           // bass.atSample (0 = now), note, vel, flag = on(1)/off(0), tag — a live / preview note event
    bassSlide,          // bass.atSample, note, value = duration seconds, tag — bend what sounds to `note`
    bassBend,           // bass.atSample (0 = now), value = semitones, tag — the wheel (now) / a timed bend
    bassMod,            // bass.value — the mod wheel 0..1
    bassClear,          // bass.tag (0 = all) + bass.flag = release — drop pending events of a tag
    bassPanic,          // — kill every bass voice, drop every event
    // ---- MIDI (Phase 3.5, core/MidiClock.h) ----
    midiClockEnable, // midi.flag — Preferences "MIDI Clock (send)": the clock OUT follows the transport (off while
                     // running = STOP now); the ticks go to io/MidiHub's pump through Engine::midiOut()
    setMidiRouting,  // midi.flag — 1 = MIDI notes play pads on the direct path (default); 0 = the page owns the notes
                     // (bass MIDI IN / DRUM PADS mode / MIDI OFF / pad learn) — the engine only mirrors them
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
    float fadeOutSec = 0.0f;     // one-shot/gate: linear fade to silence over the LAST fadeOut seconds of the region
                             // (buffer time — TS startVoice's fade-out envelope ending AT the region end); 0 = none.
                             // LOOP pads bake their fades into the rendered loop instead
    float gain = 1.0f;           // 0..4 (per-pad NORM × user gain)
    std::uint8_t outputPair = 0; // 0 = outs 1/2, 1 = outs 3/4, …
    PadMode mode = PadMode::oneShot;
    std::uint8_t reverse = 0;
    std::uint8_t gate =
        0; // NOTE ON: release() ends the voice (any mode — a gated LOOP loops while held); PadMode::gate
           // implies it. 0 = the voice plays out on its own (one-shot / free-running loop)
    std::int16_t chokeGroup = -1; // −1 = the pad itself; ≥0 = a shared mute group id; −2 = poly (never choked)
    Interpolation interpolation = Interpolation::hermite;
    float pan = 0.0f; // −1..1, the Web Audio StereoPanner law (mono: equal-power cos/sin; stereo: the side-mix law);
                      // exactly 0 = NO panner (a mono source plays on both outs at unity — the TS inserts the node only
                      // when pan ≠ 0). A drum hit's PAN graph overrides it per hit (Sampler::triggerEx)
    float chokeFadeSec =
        0.003f; // the fade a hit of THIS pad applies when it cuts (retrigger / mute group) and the
                // fade stopPad gives its voices: pads 3 ms (kStopFadeSec), drum lanes 4 ms (DRUM_CHOKE_S)
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
            std::uint8_t hasPan; // 1 = `pan` overrides the pad's PadParams::pan for this hit (a drum lane's PAN)
            float pan;           // −1..1
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

        struct Seq
        {
            const SeqPattern* pattern; // lifetime owned by the shell (a ring keeps retired patterns alive)
            std::uint64_t atSample;
            double value;
        } seq;

        struct Drum
        {
            const DrumPattern* pattern; // lifetime owned by the shell (a ring keeps retired patterns alive)
            const DrumGraphs* graphs;   // same
            std::uint64_t atSample;
            std::int32_t stepOffset; // drumPlay: the internal step the run starts on (the arranger's seek)
        } drum;

        struct DrumLane
        {
            float volume;         // 0..1 (the lane's fader; × the step VELOCITY × the drum master per hit)
            std::int16_t group;   // 0 = none; ≥ 1 = the lane's mute group (lanes sharing it cut each other)
            std::uint16_t lane;   // 0..kDrumLanes−1
            std::uint8_t audible; // 0 = silenced by mute / another lane's solo
        } drumLane;

        struct DrumParams
        {
            double swing;       // 0..1 (16T, the shared swing formula on the step's 16th slot)
            float masterVolume; // 0..1
            std::uint16_t ppq;  // SHIFT snaps to 60/bpm/ppq (24..960)
        } drumParams;

        struct Bass
        {
            const void* ptr;          // BassPatch* / BassPattern* / BassTimeline* (lifetime owned by the shell's ring)
            std::uint64_t atSample;   // an ENGINE sample (0 = now / the next block)
            double value;             // slide seconds · bend semitones · mod wheel
            float vel;                // 0.05..1
            std::int32_t offsetTicks; // bassPlay: the absolute tick landing on the anchor
            std::uint8_t note;        // 0..127
            std::uint8_t tag;         // BassTag
            std::uint8_t flag;        // on/off · release · arranger-driven · bend lane
        } bass;

        struct Midi
        {
            std::uint8_t flag;
        } midi;

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
        c.payload.trigger.hasPan = 0;
        c.payload.trigger.pan = 0.0f;
        return c;
    }
    /// A hit with its own pan (a drum lane's PAN graph / a panned live drum hit).
    static Command triggerPadPanned(std::uint16_t pad, float velocity, float pan, std::uint64_t hostTimeNs = 0) noexcept
    {
        Command c = triggerPad(pad, velocity, hostTimeNs);
        c.payload.trigger.hasPan = 1;
        c.payload.trigger.pan = pan;
        return c;
    }
    static Command releasePad(std::uint16_t pad, std::uint64_t hostTimeNs = 0) noexcept
    {
        Command c;
        c.type = CommandType::releasePad;
        c.payload.trigger.pad = pad;
        c.payload.trigger.velocity = 0.0f;
        c.payload.trigger.hostTimeNs = hostTimeNs;
        c.payload.trigger.hasPan = 0;
        c.payload.trigger.pan = 0.0f;
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
        Command c = releasePad(pad);
        c.type = CommandType::stopPad;
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
    static Command seqSetPattern(const SeqPattern* pattern) noexcept
    {
        Command c;
        c.type = CommandType::seqSetPattern;
        c.payload.seq.pattern = pattern;
        c.payload.seq.atSample = 0;
        c.payload.seq.value = 0.0;
        return c;
    }
    static Command seqQueuePattern(const SeqPattern* pattern) noexcept
    {
        Command c = seqSetPattern(pattern);
        c.type = CommandType::seqQueuePattern;
        return c;
    }
    static Command seqPlay(std::uint64_t atSample = 0) noexcept
    {
        Command c;
        c.type = CommandType::seqPlay;
        c.payload.seq.pattern = nullptr;
        c.payload.seq.atSample = atSample;
        c.payload.seq.value = 0.0;
        return c;
    }
    static Command seqStop() noexcept
    {
        Command c = seqPlay();
        c.type = CommandType::seqStop;
        return c;
    }
    static Command seqPause() noexcept
    {
        Command c = seqPlay();
        c.type = CommandType::seqPause;
        return c;
    }
    static Command seqResume() noexcept
    {
        Command c = seqPlay();
        c.type = CommandType::seqResume;
        return c;
    }
    static Command seqSetBpm(double bpm) noexcept
    {
        Command c = seqPlay();
        c.type = CommandType::seqSetBpm;
        c.payload.seq.value = bpm;
        return c;
    }
    static Command seqSetLoop(bool loop) noexcept
    {
        Command c = seqPlay();
        c.type = CommandType::seqSetLoop;
        c.payload.seq.value = loop ? 1.0 : 0.0;
        return c;
    }
    // ---- drums (Phase 3.3) ----
    static Command drumSetPattern(const DrumPattern* pattern) noexcept
    {
        Command c;
        c.type = CommandType::drumSetPattern;
        c.payload.drum.pattern = pattern;
        c.payload.drum.graphs = nullptr;
        c.payload.drum.atSample = 0;
        c.payload.drum.stepOffset = 0;
        return c;
    }
    static Command drumSchedulePattern(const DrumPattern* pattern, std::uint64_t atSample) noexcept
    {
        Command c = drumSetPattern(pattern);
        c.type = CommandType::drumSchedulePattern;
        c.payload.drum.atSample = atSample;
        return c;
    }
    static Command drumClearScheduled() noexcept
    {
        Command c = drumSetPattern(nullptr);
        c.type = CommandType::drumClearScheduled;
        return c;
    }
    static Command drumSetGraphs(const DrumGraphs* graphs) noexcept
    {
        Command c = drumSetPattern(nullptr);
        c.type = CommandType::drumSetGraphs;
        c.payload.drum.graphs = graphs;
        return c;
    }
    static Command drumSetLane(std::uint16_t lane, float volume, bool audible, std::int16_t group) noexcept
    {
        Command c;
        c.type = CommandType::drumSetLane;
        c.payload.drumLane.lane = lane;
        c.payload.drumLane.volume = volume;
        c.payload.drumLane.audible = audible ? 1 : 0;
        c.payload.drumLane.group = group;
        return c;
    }
    static Command drumSetParams(double swing, float masterVolume, std::uint16_t ppq) noexcept
    {
        Command c;
        c.type = CommandType::drumSetParams;
        c.payload.drumParams.swing = swing;
        c.payload.drumParams.masterVolume = masterVolume;
        c.payload.drumParams.ppq = ppq;
        return c;
    }
    static Command drumPlay(std::uint64_t atSample = 0, std::int32_t stepOffset = 0) noexcept
    {
        Command c = drumSetPattern(nullptr);
        c.type = CommandType::drumPlay;
        c.payload.drum.atSample = atSample;
        c.payload.drum.stepOffset = stepOffset;
        return c;
    }
    static Command drumStop() noexcept
    {
        Command c = drumSetPattern(nullptr);
        c.type = CommandType::drumStop;
        return c;
    }
    // ---- bass (Phase 3.4) ----
    static Command bassCmd(CommandType t) noexcept
    {
        Command c;
        c.type = t;
        c.payload.bass.ptr = nullptr;
        c.payload.bass.atSample = 0;
        c.payload.bass.value = 0.0;
        c.payload.bass.vel = 1.0f;
        c.payload.bass.offsetTicks = 0;
        c.payload.bass.note = 0;
        c.payload.bass.tag = 0;
        c.payload.bass.flag = 0;
        return c;
    }
    static Command bassSetPatch(const BassPatch* patch) noexcept
    {
        Command c = bassCmd(CommandType::bassSetPatch);
        c.payload.bass.ptr = patch;
        return c;
    }
    static Command bassSetPattern(const BassPattern* pattern) noexcept
    {
        Command c = bassCmd(CommandType::bassSetPattern);
        c.payload.bass.ptr = pattern;
        return c;
    }
    static Command bassSetTimeline(const BassTimeline* timeline) noexcept
    {
        Command c = bassCmd(CommandType::bassSetTimeline);
        c.payload.bass.ptr = timeline;
        return c;
    }
    static Command bassClearTimeline() noexcept { return bassCmd(CommandType::bassClearTimeline); }
    static Command bassArrangerDriven(bool on) noexcept
    {
        Command c = bassCmd(CommandType::bassArrangerDriven);
        c.payload.bass.flag = on ? 1 : 0;
        return c;
    }
    static Command bassBendLane(bool on) noexcept
    {
        Command c = bassCmd(CommandType::bassBendLane);
        c.payload.bass.flag = on ? 1 : 0;
        return c;
    }
    static Command bassPlay(std::uint64_t atSample = 0, std::int32_t offsetTicks = 0) noexcept
    {
        Command c = bassCmd(CommandType::bassPlay);
        c.payload.bass.atSample = atSample;
        c.payload.bass.offsetTicks = offsetTicks;
        return c;
    }
    static Command bassStop() noexcept { return bassCmd(CommandType::bassStop); }
    static Command bassNote(bool on, std::uint8_t note, float velocity, std::uint64_t atSample = 0,
                            std::uint8_t tag = 2) noexcept
    {
        Command c = bassCmd(CommandType::bassNote);
        c.payload.bass.flag = on ? 1 : 0;
        c.payload.bass.note = note;
        c.payload.bass.vel = velocity;
        c.payload.bass.atSample = atSample;
        c.payload.bass.tag = tag;
        return c;
    }
    static Command bassSlide(std::uint8_t note, double durationSec, std::uint64_t atSample = 0,
                             std::uint8_t tag = 2) noexcept
    {
        Command c = bassCmd(CommandType::bassSlide);
        c.payload.bass.note = note;
        c.payload.bass.value = durationSec;
        c.payload.bass.atSample = atSample;
        c.payload.bass.tag = tag;
        return c;
    }
    static Command bassBend(double semis, std::uint64_t atSample = 0, std::uint8_t tag = 2) noexcept
    {
        Command c = bassCmd(CommandType::bassBend);
        c.payload.bass.value = semis;
        c.payload.bass.atSample = atSample;
        c.payload.bass.tag = tag;
        return c;
    }
    static Command bassMod(double value) noexcept
    {
        Command c = bassCmd(CommandType::bassMod);
        c.payload.bass.value = value;
        return c;
    }
    static Command bassClear(std::uint8_t tag, bool release) noexcept
    {
        Command c = bassCmd(CommandType::bassClear);
        c.payload.bass.tag = tag;
        c.payload.bass.flag = release ? 1 : 0;
        return c;
    }
    static Command bassPanic() noexcept { return bassCmd(CommandType::bassPanic); }
    // ---- MIDI (Phase 3.5) ----
    static Command midiClockEnable(bool on) noexcept
    {
        Command c;
        c.type = CommandType::midiClockEnable;
        c.payload.midi.flag = on ? 1 : 0;
        return c;
    }
    static Command setMidiRouting(bool notesToPads) noexcept
    {
        Command c;
        c.type = CommandType::setMidiRouting;
        c.payload.midi.flag = notesToPads ? 1 : 0;
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
