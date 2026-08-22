#pragma once
// UI → engine commands. Plain trivially-copyable structs so they can travel through the lock-free queue
// without any allocation. Every new engine capability adds a CommandType + payload here AND a line in
// docs/native/BRIDGE-PROTOCOL.md (the JSON form the WebView sends is translated into these by the shell).
#include <cstdint>
#include <type_traits>

namespace terminator
{

enum class CommandType : std::uint32_t
{
    none = 0,
    setMasterGain, // payload: gain
    setTestTone,   // payload: testTone
    transportPlay, // no payload
    transportStop, // no payload
    panic,         // no payload — silence everything immediately
};

struct Command
{
    CommandType type = CommandType::none;
    std::uint32_t sequence = 0; // producer-side counter (debug / ordering checks)

    union Payload
    {
        struct Gain
        {
            float linear; // 0..1 (+), applied with a one-block linear ramp
        } gain;

        struct TestTone
        {
            float frequencyHz;
            float amplitude; // peak, 0..1
            std::uint32_t enabled;
        } testTone;
    } payload{};

    static Command setMasterGain(float linear) noexcept
    {
        Command c;
        c.type = CommandType::setMasterGain;
        c.payload.gain.linear = linear;
        return c;
    }
    static Command setTestTone(bool enabled, float frequencyHz, float amplitude) noexcept
    {
        Command c;
        c.type = CommandType::setTestTone;
        c.payload.testTone.enabled = enabled ? 1u : 0u;
        c.payload.testTone.frequencyHz = frequencyHz;
        c.payload.testTone.amplitude = amplitude;
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
};

static_assert(std::is_trivially_copyable_v<Command>, "Command must be trivially copyable (lock-free queue)");
static_assert(sizeof(Command) <= 64, "Keep Command within one cache line");

} // namespace terminator
