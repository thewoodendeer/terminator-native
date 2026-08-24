# terminator-stems — the headless separator CLI (Phase 7.1b). The measuring rig: it runs the same SplitSession
# and StemModel the app runs, so a split can be timed and compared against the Electron app's output with no UI.
juce_add_console_app(terminator-stems
    PRODUCT_NAME "terminator-stems"
    COMPANY_NAME "Killavic Cheat Codes"
    VERSION "${PROJECT_VERSION}")
target_sources(terminator-stems PRIVATE main.cpp)
target_compile_definitions(terminator-stems PRIVATE
    JUCE_WEB_BROWSER=0 JUCE_USE_CURL=0)
target_link_libraries(terminator-stems PRIVATE
    terminator::stems
    juce::juce_recommended_config_flags
    juce::juce_recommended_lto_flags)
terminator_set_warnings(terminator-stems)
