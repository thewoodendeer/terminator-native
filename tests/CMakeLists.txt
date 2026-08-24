include(Catch)

add_executable(terminator-tests
    support/AllocationCounter.h
    support/AllocationCounter.cpp
    support/TestSamples.h
    engine/test_command_queue.cpp
    engine/test_sampler.cpp
    engine/test_clock_calibration.cpp
    engine/test_sample_io.cpp
    engine/test_state_snapshot.cpp
    engine/test_engine.cpp
    engine/test_rt_safety.cpp
    engine/test_offline_renderer.cpp
    engine/test_planners_core.cpp
    engine/test_project_roundtrip.cpp
    engine/test_undo.cpp
    engine/test_loop_render.cpp
    engine/test_waveform_peaks.cpp
    engine/test_project_planner.cpp
    engine/test_project_render.cpp
    engine/test_onsets.cpp
    engine/test_snap_chops.cpp
    engine/test_blocks.cpp
    engine/test_stems_voice.cpp
    engine/test_effective_buffer.cpp
    engine/test_pad_ops.cpp
    engine/test_chop_sequencer.cpp
    engine/test_drum_sequencer.cpp
    engine/test_bass_synth.cpp
    engine/test_bass_sequencer.cpp
    engine/test_midi_clock.cpp
    engine/test_metronome.cpp
    engine/test_arp.cpp
    engine/test_mixer.cpp
    engine/test_fx.cpp
    engine/test_fx_devices.cpp
    engine/test_console.cpp
    engine/test_loudness.cpp
    engine/test_pdc.cpp
    engine/test_export_mix.cpp
    engine/test_export_project.cpp
    engine/test_export_drums.cpp
    engine/test_export_bass.cpp
    engine/test_export_files.cpp)
target_include_directories(terminator-tests PRIVATE support)
target_compile_definitions(terminator-tests PRIVATE
    TERMINATOR_FIXTURES_DIR="${CMAKE_CURRENT_SOURCE_DIR}/fixtures"
    JUCE_WEB_BROWSER=0 JUCE_USE_CURL=0)
target_link_libraries(terminator-tests PRIVATE
    terminator::engine
    Catch2::Catch2WithMain
    juce::juce_recommended_config_flags)
terminator_set_warnings(terminator-tests)
catch_discover_tests(terminator-tests TEST_PREFIX "engine." DISCOVERY_MODE PRE_TEST)

# --- terminator-render CLI smoke gates (the binary itself, not the library) ---
if(TARGET terminator-render)
    add_test(NAME cli.render.version COMMAND terminator-render --version)
    set_tests_properties(cli.render.version PROPERTIES PASS_REGULAR_EXPRESSION "terminator-render ${TERMINATOR_VERSION_STRING}")

    add_test(NAME cli.render.tone440
        COMMAND terminator-render "${CMAKE_CURRENT_SOURCE_DIR}/fixtures/tone-440.json"
                "${CMAKE_CURRENT_BINARY_DIR}/tone-440.wav" --print-spec)
    set_tests_properties(cli.render.tone440 PROPERTIES PASS_REGULAR_EXPRESSION "rendered .*tone-440.wav · 2 ch · 96000 samples")

    add_test(NAME cli.render.override
        COMMAND terminator-render "${CMAKE_CURRENT_SOURCE_DIR}/fixtures/tone-440.json"
                "${CMAKE_CURRENT_BINARY_DIR}/tone-440-44k.wav" --rate 44100 --seconds 0.5 --bits 16)
    set_tests_properties(cli.render.override PROPERTIES PASS_REGULAR_EXPRESSION "22050 samples \\(0.500 s\\) @ 44100 Hz")

    add_test(NAME cli.render.pads
        COMMAND terminator-render "${CMAKE_CURRENT_SOURCE_DIR}/fixtures/pads-demo.json"
                "${CMAKE_CURRENT_BINARY_DIR}/pads-demo.wav" --print-spec)
    set_tests_properties(cli.render.pads PROPERTIES PASS_REGULAR_EXPRESSION "pads=2 events=2.*rendered .*pads-demo.wav · 4 ch · 48000 samples")

    add_test(NAME cli.render.badproject
        COMMAND terminator-render "${CMAKE_CURRENT_SOURCE_DIR}/fixtures/bad-version.json"
                "${CMAKE_CURRENT_BINARY_DIR}/never.wav")
    set_tests_properties(cli.render.badproject PROPERTIES WILL_FAIL TRUE)

    add_test(NAME cli.render.usage COMMAND terminator-render)
    set_tests_properties(cli.render.usage PROPERTIES WILL_FAIL TRUE)
endif()
