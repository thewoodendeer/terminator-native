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
    /// ARRANGEMENT hits (Phase 4.7): triggerPadAtSample plus the two things a drum lane needs and a plain trigger
    /// cannot say — this hit's own PAN, and that it is a note-repeat SUB-HIT (chokes nothing; its end is booked
    /// separately, exactly as the live DrumSequencer books it).
    triggerPadAtSampleEx, // trigger — pan / subHit honoured
    chokeSubHitsAtSample, // trigger — fade only this pad's SUB-HIT voices from that sample (a roll's self-choke)
    stopPadAtSample,      // trigger — stop the pad's voices from that sample (the chop's own 3 ms fade)
    stopPad,              // trigger — stop the pad's voices (3 ms fade)
    setNoteMap,           // noteMap — MIDI note → pad (−1 = unmapped)
    startCalibration,     // calibration — emit a click on out channel, record in channel
    setPadLoopBuffer,     // padLoop — attach/clear a pad's pre-rendered crossfade-loop buffer + its steady bracket
    setPadStems, // padStems — attach the pad's stem planes (drums/bass/other/vocals) + its 4-bit mask; a ringing
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
    // ---- metronome + count-in + arp (Phase 3.6, core/Metronome.h + core/Arp.h) ----
    setMetronome,  // metro.enabled + metro.sound — METRO on/off (off drops the booked beat clicks) + the click sound
    countIn,       // metro.beats + metro.atSample (0 = the next block) — book the count-in clicks; the downbeat follows
                   // the last one by a beat (snapshot countInDownbeatSample); replaces a pending count-in
    cancelCountIn, // — drop a pending count-in
    setArp,        // arp.enabled / rate / down / random / padCount — the page's ARP settings (off stops a held arp)
    arpHold,       // arp.pad + arp.velocity + arp.atSample (0 = the next block) — hold: the arp steps from there; with
                   // the arp off it is a plain trigger
    arpRelease,    // arp.pad — release: stops the arp when it is the held pad (−1 = whatever is held)
    // ---- plugins (Phase 6.2, core/fx/PluginFx.h) ----
    mixerSetFxProcessor, // fxProc.strip + fxProc.index + fxProc.processor — attach (or detach, nullptr) the APP's
                         // plugin instance to a `plugin` insert slot. The engine never learns what a VST3 is; the
                         // app may only DELETE the instance after detaching AND letting blocks run (PluginFx.h)
    // ---- instruments (Phase 6.3, core/fx/PluginFx.h) ----
    setInstrument,     // fxProc.processor + fxProc.strip — the APP's hosted INSTRUMENT and the strip it plays into
                       // (strip −1 = dry into outs 1/2; processor nullptr = take it out)
    setInstrumentMidi, // midi.flag — MIDI notes play the instrument instead of the pads
    instrumentNote,    // trigger.pad = the NOTE, trigger.velocity, trigger.hostTimeNs = an engine sample (0 = now),
                       // trigger.subHit = 0 note-off / 1 note-on — the page's keyboard and pads playing it
    // ---- input monitoring (Phase 5.1c, io/Recorder.h is the take; this is hearing it) ----
    setMonitor, // monitor.enabled + monitor.ch0/ch1 (hardware inputs, −1 = none — one channel feeds both sides) +
                // monitor.gain (linear) + monitor.strip (a mixer strip, so its fader/inserts/console apply;
                // −1 = straight to outs 1/2). No added latency: the block that arrives is added to the block
                // that leaves.
    // ---- the mixer (Phase 4.1, core/Mixer.h) ----
    mixerSetStrip,   // strip.strip + strip.kind (StripKind: 0 off · 1 channel · 2 send · 3 bus) — activate / retype /
                     // deactivate a strip (strip 0 = the master, always) + strip.seed (the CONSOLE seed = FNV-1a of
                     // the page's strip NAME; 0 = leave as is)
    mixerSetConsole, // strip.flag = on + strip.kind = flavour (0 SSL · 1 NEVE · 2 API) + strip.value = amount 0..100
    mixerSetLimiter, // strip.flag = on — the master's safety limiter (the page's −1 dBFS / 20:1 DynamicsCompressor)
    mixerSetPdc,     // strip.flag = on — plugin-delay compensation (4.4, the page's two-tier plan in whole samples)
    mixerSetStemTap, // strip.strip + strip.index (the hardware pair) — ALSO copy this strip's output to a hardware pair
                     // (4.5, the trackouts render); −1 = off. The strip's normal output target is unchanged.
    loudnessReset,   // the master's BS.1770 meter: integrated + LRA + the holds restart (the page's RESET)
    mixerSetFader,   // strip.strip + strip.value — dB, −60 (= −∞) .. +6 (τ 8 ms)
    mixerSetPan,     // strip.strip + strip.value — −1..1 (τ 8 ms); the master has no pan
    mixerSetWidth,   // strip.strip + strip.value — M/S width 0 (mono) .. 1 (as is) .. 2
    mixerSetMute,    // strip.strip + strip.flag
    mixerSetSolo,    // strip.strip + strip.flag — the solo law: silent = mute || (anySolo && !solo)
    mixerSetSend,    // strip.strip + strip.index (send 0..3) + strip.value (dB) + strip.target (strip, −1 = unwired);
                     // a target that closes a loop / the strip itself / the master is refused (snapshot
                     // mixerRoutesRejected++), the level still applies
    mixerSetOutput,  // strip.strip + strip.kind (StripOutput: 0 master · 1 strip · 2 hardware pair · 3 none) +
                     // strip.index (the strip / the pair) — a loop / itself is refused
    mixerSetMainOut, // strip.index — the master's hardware pair (0 = outs 1/2)
    setSourceStrip,  // strip.kind = the source (0 bass · 1 click) + strip.target = its strip (−1 = the direct
                     // Phase-3 path: bass dry into outs 1/2, the click post master gain)
    // ---- the insert chain (Phase 4.2, core/fx/Effect.h + core/fx/FxPool.h) ----
    mixerAddFx,       // fx.strip + fx.type (FxType) — append a device (≤ 8; refused: dead strip / full / pool empty /
                      // not ported → snapshot mixerFxRejected++)
    mixerRemoveFx,    // fx.strip + fx.index
    mixerSetFxBypass, // fx.strip + fx.index + fx.flag
    mixerSetFxRoute,  // fx.strip + fx.index + fx.param = FxRoute (M/S everywhere, 4.7a)
    mixerSetFxParam,  // fx.strip + fx.index + fx.param (the type's param index) + fx.value (enum: the option index) +
                      // fx.flag = immediate (no glide — a restore / the first set)
    mixerReorderFx,   // fx.strip + fx.index (from) + fx.to
    mixerClearFx,     // fx.strip
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
    /// 16-tap windowed sinc whose cutoff FOLLOWS the read rate: pitching a chop UP reads faster than the
    /// source, and everything above the new Nyquist folds back into the band as inharmonic ringing. Neither
    /// linear nor Hermite band-limits at all (nor does an AudioBufferSourceNode), so this is the only path
    /// here that does not alias. It costs about five times the read; the mixer and FX dwarf it.
    sinc = 2,
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
        0.003f;              // the fade a hit of THIS pad applies when it cuts (retrigger / mute group) and the
                             // fade stopPad gives its voices: pads 3 ms (kStopFadeSec), drum lanes 4 ms (DRUM_CHOKE_S)
    std::int16_t strip = -1; // the MIXER strip the pad's voices sum into (Phase 4.1); −1 = the direct path (the
                             // hardware pair `outputPair`, no mixer — the Phase-1..3 behaviour and the offline tests)
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
            std::uint8_t subHit; // 1 = a note-repeat SUB-HIT (chokes nothing; ended by chokeSubHitsAtSample)
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

        struct FxProc
        {
            void* processor; // ExternalProcessor* (nullptr = detach)
            std::int16_t strip;
            std::int8_t index; // the insert slot
        } fxProc;

        struct Monitor
        {
            float gain;         // linear
            std::int16_t ch0;   // hardware input for the left side (−1 = none)
            std::int16_t ch1;   // … the right (−1 = none: ch0 is heard centred, on both sides)
            std::int16_t strip; // a mixer strip (−1 = straight to outs 1/2)
            std::uint8_t enabled;
        } monitor;

        struct Metro
        {
            std::uint64_t atSample; // countIn: an ENGINE sample (0 = the next block)
            std::int32_t beats;     // countIn: 1..16
            std::uint8_t enabled;   // setMetronome
            std::uint8_t sound;     // setMetronome: ClickSound (0 click · 1 hihat · 2 rimshot · 3 kick · 4 clap)
        } metro;

        struct ArpCmd
        {
            std::uint64_t atSample; // arpHold: an ENGINE sample (0 = the next block)
            float velocity;         // arpHold
            std::int16_t pad;       // arpHold / arpRelease (−1 = any)
            std::uint16_t padCount; // setArp: the pad bank size the arp walks (0 = the whole grid)
            std::uint8_t enabled;   // setArp
            std::uint8_t rate;      // setArp: 1 = quarters, 2 = 8ths, 4 = 16ths, 8 = 32nds
            std::uint8_t down;      // setArp: direction DOWN (else UP)
            std::uint8_t random;    // setArp
        } arp;

        struct Strip
        {
            float value;         // dB / pan / width / the console amount
            std::uint32_t seed;  // mixerSetStrip: the CONSOLE seed (0 = leave)
            std::int16_t strip;  // the strip 0..kMaxStrips−1
            std::int16_t index;  // send index / hardware pair / output strip
            std::int16_t target; // a send's destination strip / a source's strip (−1 = none)
            std::uint8_t kind;   // StripKind / StripOutput / the source id / the console flavour
            std::uint8_t flag;   // mute / solo / console on
        } strip;

        struct Fx
        {
            float value;
            std::int16_t strip;
            std::int8_t index; // the slot (from)
            std::int8_t to;    // reorder: the destination slot
            std::uint8_t type; // FxType
            std::uint8_t param;
            std::uint8_t flag; // bypass on / immediate
        } fx;

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
        c.payload.trigger.subHit = 0;
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
        c.payload.trigger.subHit = 0;
        c.payload.trigger.pan = 0.0f;
        return c;
    }
    static Command triggerPadAtSample(std::uint16_t pad, float velocity, std::uint64_t samplePosition) noexcept
    {
        Command c = triggerPad(pad, velocity, samplePosition);
        c.type = CommandType::triggerPadAtSample;
        return c;
    }
    /// An ARRANGEMENT hit: sample-exact, with its own pan and/or as a note-repeat SUB-HIT (Phase 4.7).
    static Command triggerPadAtSampleEx(std::uint16_t pad, float velocity, std::uint64_t samplePosition, bool hasPan,
                                        float pan, bool subHit) noexcept
    {
        Command c = triggerPad(pad, velocity, samplePosition);
        c.type = CommandType::triggerPadAtSampleEx;
        c.payload.trigger.hasPan = hasPan ? 1 : 0;
        c.payload.trigger.pan = pan;
        c.payload.trigger.subHit = subHit ? 1 : 0;
        return c;
    }
    /// End the pad's ringing SUB-HITS at `samplePosition` (the roll's self-choke — the fade ENDS where the next
    /// sub-hit starts, which is what the live sequencer books).
    static Command chokeSubHitsAtSample(std::uint16_t pad, std::uint64_t samplePosition) noexcept
    {
        Command c = releasePad(pad, samplePosition);
        c.type = CommandType::chokeSubHitsAtSample;
        return c;
    }
    /// Stop the pad's voices from `samplePosition` (a chop that must end where the next one starts).
    static Command stopPadAtSample(std::uint16_t pad, std::uint64_t samplePosition) noexcept
    {
        Command c = releasePad(pad, samplePosition);
        c.type = CommandType::stopPadAtSample;
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
    // ---- metronome + count-in + arp (Phase 3.6) ----
    static Command metroCmd(CommandType t) noexcept
    {
        Command c;
        c.type = t;
        c.payload.metro.atSample = 0;
        c.payload.metro.beats = 4;
        c.payload.metro.enabled = 0;
        c.payload.metro.sound = 0;
        return c;
    }
    static Command setMetronome(bool enabled, std::uint8_t sound) noexcept
    {
        Command c = metroCmd(CommandType::setMetronome);
        c.payload.metro.enabled = enabled ? 1 : 0;
        c.payload.metro.sound = sound;
        return c;
    }
    static Command countIn(int beats, std::uint64_t atSample = 0) noexcept
    {
        Command c = metroCmd(CommandType::countIn);
        c.payload.metro.beats = beats;
        c.payload.metro.atSample = atSample;
        return c;
    }
    static Command cancelCountIn() noexcept { return metroCmd(CommandType::cancelCountIn); }
    /// 6.3: hand a hosted INSTRUMENT to the engine (nullptr = take it out) and say which strip it plays into.
    static Command setInstrument(void* processor, int strip) noexcept
    {
        Command c;
        c.type = CommandType::setInstrument;
        c.payload.fxProc.processor = processor;
        c.payload.fxProc.strip = static_cast<std::int16_t>(strip);
        c.payload.fxProc.index = 0;
        return c;
    }
    static Command setInstrumentMidi(bool on) noexcept
    {
        Command c;
        c.type = CommandType::setInstrumentMidi;
        c.payload.midi.flag = on ? 1 : 0;
        return c;
    }
    /// 6.3: a note for the instrument. `atSample` 0 = the next block; else the exact engine sample.
    static Command instrumentNote(int note, float velocity, bool on, std::uint64_t atSample = 0) noexcept
    {
        Command c;
        c.type = CommandType::instrumentNote;
        c.payload.trigger.pad = static_cast<std::uint16_t>(note < 0 ? 0 : (note > 127 ? 127 : note));
        c.payload.trigger.velocity = velocity;
        c.payload.trigger.hostTimeNs = atSample;
        c.payload.trigger.subHit = on ? 1 : 0;
        return c;
    }
    /// 6.2: hand a hosted plugin to (or take it from) an insert slot. `processor` is an `ExternalProcessor*`.
    static Command mixerSetFxProcessor(int strip, int index, void* processor) noexcept
    {
        Command c;
        c.type = CommandType::mixerSetFxProcessor;
        c.payload.fxProc.processor = processor;
        c.payload.fxProc.strip = static_cast<std::int16_t>(strip);
        c.payload.fxProc.index = static_cast<std::int8_t>(index);
        return c;
    }
    /// Input monitoring (5.1c): hear inputs ch0/ch1 through the engine at `gain`, optionally through a mixer strip.
    static Command setMonitor(bool enabled, int ch0, int ch1, float gain, int strip) noexcept
    {
        Command c;
        c.type = CommandType::setMonitor;
        c.payload.monitor.enabled = enabled ? 1 : 0;
        c.payload.monitor.ch0 = static_cast<std::int16_t>(ch0);
        c.payload.monitor.ch1 = static_cast<std::int16_t>(ch1);
        c.payload.monitor.gain = gain;
        c.payload.monitor.strip = static_cast<std::int16_t>(strip);
        return c;
    }
    static Command arpCmd(CommandType t) noexcept
    {
        Command c;
        c.type = t;
        c.payload.arp.atSample = 0;
        c.payload.arp.velocity = 1.0f;
        c.payload.arp.pad = -1;
        c.payload.arp.padCount = 0;
        c.payload.arp.enabled = 0;
        c.payload.arp.rate = 4;
        c.payload.arp.down = 0;
        c.payload.arp.random = 0;
        return c;
    }
    static Command setArp(bool enabled, int rate, bool down, bool random, int padCount) noexcept
    {
        Command c = arpCmd(CommandType::setArp);
        c.payload.arp.enabled = enabled ? 1 : 0;
        c.payload.arp.rate = static_cast<std::uint8_t>(rate < 1 ? 1 : (rate > 255 ? 255 : rate));
        c.payload.arp.down = down ? 1 : 0;
        c.payload.arp.random = random ? 1 : 0;
        c.payload.arp.padCount = static_cast<std::uint16_t>(padCount < 0 ? 0 : padCount);
        return c;
    }
    static Command arpHold(std::uint16_t pad, float velocity, std::uint64_t atSample = 0) noexcept
    {
        Command c = arpCmd(CommandType::arpHold);
        c.payload.arp.pad = static_cast<std::int16_t>(pad);
        c.payload.arp.velocity = velocity;
        c.payload.arp.atSample = atSample;
        return c;
    }
    static Command arpRelease(std::int16_t pad) noexcept
    {
        Command c = arpCmd(CommandType::arpRelease);
        c.payload.arp.pad = pad;
        return c;
    }
    // ---- the mixer (Phase 4.1) ----
    static Command stripCmd(CommandType t, int strip) noexcept
    {
        Command c;
        c.type = t;
        c.payload.strip.value = 0.0f;
        c.payload.strip.seed = 0;
        c.payload.strip.strip = static_cast<std::int16_t>(strip);
        c.payload.strip.index = 0;
        c.payload.strip.target = -1;
        c.payload.strip.kind = 0;
        c.payload.strip.flag = 0;
        return c;
    }
    static Command mixerSetStrip(int strip, std::uint8_t kind, std::uint32_t seed = 0) noexcept
    {
        Command c = stripCmd(CommandType::mixerSetStrip, strip);
        c.payload.strip.kind = kind;
        c.payload.strip.seed = seed;
        return c;
    }
    static Command loudnessReset() noexcept { return stripCmd(CommandType::loudnessReset, 0); }
    static Command mixerSetLimiter(bool on) noexcept
    {
        Command c = stripCmd(CommandType::mixerSetLimiter, 0);
        c.payload.strip.flag = on ? 1 : 0;
        return c;
    }
    static Command mixerSetStemTap(int strip, int pair) noexcept
    {
        Command c = stripCmd(CommandType::mixerSetStemTap, strip);
        c.payload.strip.index = static_cast<std::int16_t>(pair);
        return c;
    }
    static Command mixerSetPdc(bool on) noexcept
    {
        Command c = stripCmd(CommandType::mixerSetPdc, 0);
        c.payload.strip.flag = on ? 1 : 0;
        return c;
    }
    static Command mixerSetConsole(bool on, std::uint8_t flavour, float amount) noexcept
    {
        Command c = stripCmd(CommandType::mixerSetConsole, 0);
        c.payload.strip.flag = on ? 1 : 0;
        c.payload.strip.kind = flavour;
        c.payload.strip.value = amount;
        return c;
    }
    static Command mixerSetFader(int strip, float db) noexcept
    {
        Command c = stripCmd(CommandType::mixerSetFader, strip);
        c.payload.strip.value = db;
        return c;
    }
    static Command mixerSetPan(int strip, float pan) noexcept
    {
        Command c = stripCmd(CommandType::mixerSetPan, strip);
        c.payload.strip.value = pan;
        return c;
    }
    static Command mixerSetWidth(int strip, float width) noexcept
    {
        Command c = stripCmd(CommandType::mixerSetWidth, strip);
        c.payload.strip.value = width;
        return c;
    }
    static Command mixerSetMute(int strip, bool on) noexcept
    {
        Command c = stripCmd(CommandType::mixerSetMute, strip);
        c.payload.strip.flag = on ? 1 : 0;
        return c;
    }
    static Command mixerSetSolo(int strip, bool on) noexcept
    {
        Command c = stripCmd(CommandType::mixerSetSolo, strip);
        c.payload.strip.flag = on ? 1 : 0;
        return c;
    }
    static Command mixerSetSend(int strip, int send, float db, int target) noexcept
    {
        Command c = stripCmd(CommandType::mixerSetSend, strip);
        c.payload.strip.index = static_cast<std::int16_t>(send);
        c.payload.strip.value = db;
        c.payload.strip.target = static_cast<std::int16_t>(target);
        return c;
    }
    static Command mixerSetOutput(int strip, std::uint8_t outputKind, int index) noexcept
    {
        Command c = stripCmd(CommandType::mixerSetOutput, strip);
        c.payload.strip.kind = outputKind;
        c.payload.strip.index = static_cast<std::int16_t>(index);
        return c;
    }
    static Command mixerSetMainOut(int pair) noexcept
    {
        Command c = stripCmd(CommandType::mixerSetMainOut, 0);
        c.payload.strip.index = static_cast<std::int16_t>(pair);
        return c;
    }
    /// source 0 = the bass synth, 1 = the metronome (click + count-in); strip −1 = the direct path.
    static Command setSourceStrip(std::uint8_t source, int strip) noexcept
    {
        Command c = stripCmd(CommandType::setSourceStrip, 0);
        c.payload.strip.kind = source;
        c.payload.strip.target = static_cast<std::int16_t>(strip);
        return c;
    }
    // ---- the insert chain (Phase 4.2) ----
    static Command fxCmd(CommandType t, int strip, int index = 0) noexcept
    {
        Command c;
        c.type = t;
        c.payload.fx.value = 0.0f;
        c.payload.fx.strip = static_cast<std::int16_t>(strip);
        c.payload.fx.index = static_cast<std::int8_t>(index);
        c.payload.fx.to = 0;
        c.payload.fx.type = 0;
        c.payload.fx.param = 0;
        c.payload.fx.flag = 0;
        return c;
    }
    static Command mixerAddFx(int strip, std::uint8_t fxType) noexcept
    {
        Command c = fxCmd(CommandType::mixerAddFx, strip);
        c.payload.fx.type = fxType;
        return c;
    }
    static Command mixerRemoveFx(int strip, int index) noexcept
    {
        return fxCmd(CommandType::mixerRemoveFx, strip, index);
    }
    static Command mixerSetFxBypass(int strip, int index, bool on) noexcept
    {
        Command c = fxCmd(CommandType::mixerSetFxBypass, strip, index);
        c.payload.fx.flag = on ? 1 : 0;
        return c;
    }
    static Command mixerSetFxRoute(int strip, int index, std::uint8_t route) noexcept
    {
        Command c = fxCmd(CommandType::mixerSetFxRoute, strip, index);
        c.payload.fx.param = route;
        return c;
    }
    static Command mixerSetFxParam(int strip, int index, int param, float value, bool immediate = false) noexcept
    {
        Command c = fxCmd(CommandType::mixerSetFxParam, strip, index);
        c.payload.fx.param = static_cast<std::uint8_t>(param < 0 ? 0 : param);
        c.payload.fx.value = value;
        c.payload.fx.flag = immediate ? 1 : 0;
        return c;
    }
    static Command mixerReorderFx(int strip, int from, int to) noexcept
    {
        Command c = fxCmd(CommandType::mixerReorderFx, strip, from);
        c.payload.fx.to = static_cast<std::int8_t>(to);
        return c;
    }
    static Command mixerClearFx(int strip) noexcept { return fxCmd(CommandType::mixerClearFx, strip); }
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
