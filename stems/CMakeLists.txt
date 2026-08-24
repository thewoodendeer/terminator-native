# libterminator_stems — the separation engine's onnxruntime half (Phase 7.1b). Kept OUT of terminator::engine on
# purpose: the engine links into the tests, the RTSan build and (Phase 11) the plugin, and none of them should
# drag a 40 MB inference runtime. The pure pipeline (grid, window, overlap-add, resampler) lives in the engine;
# this target is only "run a chunk through htdemucs".
add_library(terminator_stems STATIC
    include/terminator/stems/StemModel.h
    src/StemModel.cpp)
add_library(terminator::stems ALIAS terminator_stems)
target_include_directories(terminator_stems PUBLIC include)
target_link_libraries(terminator_stems
    PUBLIC terminator::engine onnxruntime::onnxruntime
    PRIVATE juce::juce_recommended_config_flags)
terminator_set_warnings(terminator_stems)
