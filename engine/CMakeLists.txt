# libterminator — the engine. UI-free. RT-safe core (engine/include/terminator/core) is JUCE-free;
# io/ wraps juce_audio_devices, render/ uses juce_audio_formats for WAV, model/ is the ValueTree project
# (juce_core + juce_data_structures). Nothing here knows about
# React, JUCE GUI, or the app shell.
add_library(terminator_engine STATIC
    include/terminator/Version.h
    include/terminator/core/Platform.h
    include/terminator/core/RtAssert.h
    include/terminator/core/Command.h
    include/terminator/core/CommandQueue.h
    include/terminator/core/StateSnapshot.h
    include/terminator/core/Engine.h
    include/terminator/core/SampleBuffer.h
    include/terminator/core/HostClock.h
    include/terminator/core/Sampler.h
    include/terminator/core/ChopSequencer.h
    include/terminator/core/DrumSequencer.h
    include/terminator/core/BassSynth.h
    include/terminator/core/BassSequencer.h
    include/terminator/core/MidiClock.h
    include/terminator/core/Metronome.h
    include/terminator/core/Arp.h
    include/terminator/core/Mixer.h
    include/terminator/core/LoudnessMeter.h
    include/terminator/core/fx/Effect.h
    include/terminator/core/fx/BasicFx.h
    include/terminator/core/fx/FxDsp.h
    include/terminator/core/fx/ShaperFx.h
    include/terminator/core/fx/ModFx.h
    include/terminator/core/fx/DynamicsFx.h
    include/terminator/core/fx/ReverbFx.h
    include/terminator/core/fx/ConsoleStage.h
    include/terminator/core/fx/FxPool.h
    include/terminator/core/planners/JsMath.h
    include/terminator/core/planners/StemMask.h
    include/terminator/core/planners/Trims.h
    include/terminator/core/planners/Swing.h
    include/terminator/core/planners/LiveLanding.h
    include/terminator/core/planners/SeqRefit.h
    include/terminator/core/planners/LoopRender.h
    include/terminator/io/AudioIO.h
    include/terminator/io/MidiHub.h
    include/terminator/io/SampleLoader.h
    include/terminator/io/SampleStore.h
    include/terminator/io/Settings.h
    include/terminator/render/OfflineRenderer.h
    include/terminator/render/ProjectRenderer.h
    include/terminator/model/Ids.h
    include/terminator/model/ProjectModel.h
    include/terminator/model/EditHistory.h
    include/terminator/model/Document.h
    include/terminator/model/ProjectPlanner.h
    include/terminator/analysis/WaveformPeaks.h
    include/terminator/analysis/EffectiveBuffer.h
    include/terminator/core/planners/Onsets.h
    include/terminator/core/planners/Snap.h
    include/terminator/core/planners/Blocks.h
    include/terminator/core/planners/PadClipboard.h
    src/core/Engine.cpp
    src/core/Sampler.cpp
    src/core/ChopSequencer.cpp
    src/core/DrumSequencer.cpp
    src/core/BassSynth.cpp
    src/core/BassSequencer.cpp
    src/core/MidiClock.cpp
    src/core/Metronome.cpp
    src/core/Mixer.cpp
    src/core/LoudnessMeter.cpp
    src/core/fx/BasicFx.cpp
    src/core/fx/FxDsp.cpp
    src/core/fx/ShaperFx.cpp
    src/core/fx/ModFx.cpp
    src/core/fx/DynamicsFx.cpp
    src/core/fx/ReverbFx.cpp
    src/core/fx/ConsoleStage.cpp
    src/core/fx/FxPool.cpp
    src/core/Arp.cpp
    src/io/AudioIO.cpp
    src/io/MidiHub.cpp
    src/io/SampleLoader.cpp
    src/io/SampleStore.cpp
    src/io/Settings.cpp
    src/render/OfflineRenderer.cpp
    src/render/BassSpec.cpp
    src/render/ProjectRenderer.cpp
    src/model/ProjectModel.cpp
    src/model/EditHistory.cpp
    src/model/Document.cpp
    src/model/ProjectPlanner.cpp
    src/analysis/WaveformPeaks.cpp
    src/analysis/Onsets.cpp
    src/analysis/EffectiveBuffer.cpp)
add_library(terminator::engine ALIAS terminator_engine)

target_include_directories(terminator_engine PUBLIC include)
# JUCE headers are third-party: -isystem so our strict warnings judge only our code
target_include_directories(terminator_engine SYSTEM PUBLIC "${JUCE_SOURCE_DIR}/modules")
target_compile_definitions(terminator_engine PUBLIC
    TERMINATOR_VERSION_STRING="${TERMINATOR_VERSION_STRING}"
    TERMINATOR_VERSION_MAJOR=${PROJECT_VERSION_MAJOR}
    TERMINATOR_VERSION_MINOR=${PROJECT_VERSION_MINOR}
    TERMINATOR_VERSION_PATCH=${PROJECT_VERSION_PATCH}
    JUCE_USE_CURL=0
    JUCE_STANDALONE_APPLICATION=1
    $<$<BOOL:${TERMINATOR_HAS_ASIO}>:JUCE_ASIO=1>)
if(TERMINATOR_HAS_ASIO)
    target_include_directories(terminator_engine PUBLIC "${TERMINATOR_ASIO_SDK_DIR}/common")
endif()

target_link_libraries(terminator_engine
    PUBLIC
        juce::juce_core
        juce::juce_data_structures
        juce::juce_audio_basics
        juce::juce_audio_devices
        juce::juce_audio_formats
        juce::juce_events
    PRIVATE
        juce::juce_recommended_config_flags
        juce::juce_recommended_lto_flags)
terminator_set_warnings(terminator_engine)
