# terminator-render — offline renderer CLI. Loads a project JSON, renders through the engine, writes WAV.
# The test harness spine: every golden-render gate from Phase 2 on runs through this binary.
juce_add_console_app(terminator-render
    PRODUCT_NAME "terminator-render"
    COMPANY_NAME "Killavic Cheat Codes"
    VERSION "${PROJECT_VERSION}")
target_sources(terminator-render PRIVATE main.cpp)
target_compile_definitions(terminator-render PRIVATE
    JUCE_WEB_BROWSER=0 JUCE_USE_CURL=0)
target_link_libraries(terminator-render PRIVATE
    terminator::engine
    juce::juce_recommended_config_flags
    juce::juce_recommended_lto_flags)
terminator_set_warnings(terminator-render)

# This target IS the process (see engine/CMakeLists.txt — the engine no longer says so for its consumers).
target_compile_definitions(terminator-render PRIVATE JUCE_STANDALONE_APPLICATION=1)
