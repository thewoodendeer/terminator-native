# libterminator — the engine. UI-free. RT-safe core (engine/include/terminator/core) is JUCE-free;
# io/ wraps juce_audio_devices, render/ uses juce_audio_formats for WAV. Nothing here knows about
# React, JUCE GUI, or the app shell.
add_library(terminator_engine STATIC
    include/terminator/Version.h
    include/terminator/core/Platform.h
    include/terminator/core/RtAssert.h
    include/terminator/core/Command.h
    include/terminator/core/CommandQueue.h
    include/terminator/core/StateSnapshot.h
    include/terminator/core/Engine.h
    include/terminator/io/AudioIO.h
    include/terminator/render/OfflineRenderer.h
    src/core/Engine.cpp
    src/io/AudioIO.cpp
    src/render/OfflineRenderer.cpp)
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
        juce::juce_audio_basics
        juce::juce_audio_devices
        juce::juce_audio_formats
        juce::juce_events
    PRIVATE
        juce::juce_recommended_config_flags
        juce::juce_recommended_lto_flags)
terminator_set_warnings(terminator_engine)
