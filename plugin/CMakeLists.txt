# Terminator as a PLUGIN — Phase 11's first step: a PREVIEW build, off by default (-DTERMINATOR_BUILD_PLUGIN=ON).
#
# It exists so Terminator can be seen and heard inside a DAW today. The engine is the same one the standalone
# app runs, driven by the host's processBlock instead of an audio device, and the editor hosts the SAME WebShell
# — one UI, one bridge, no second implementation. What it does NOT do yet is in PluginProcessor.h: no host sync,
# no parameters/automation, no state with the host's set, one stereo bus.
#
# The shell's sources are compiled into this target as well as the app's. That is deliberate for a preview: it
# leaves the shipping app's target untouched. Phase 11 proper turns them into one library both link.
juce_add_plugin(TerminatorPlugin
    PRODUCT_NAME "Terminator"
    COMPANY_NAME "Killavic Cheat Codes"
    BUNDLE_ID "app.killaviccheatcodes.terminator.plugin"
    VERSION "${PROJECT_VERSION}"
    PLUGIN_MANUFACTURER_CODE Kllv
    PLUGIN_CODE Trmn
    # Standalone rides along on purpose: it runs the SAME processor and the SAME editor, so it is how the
    # plugin's window gets smoke-tested without a DAW in the loop.
    FORMATS AU VST3 Standalone
    IS_SYNTH TRUE
    NEEDS_MIDI_INPUT TRUE
    NEEDS_WEB_BROWSER TRUE
    NEEDS_WEBVIEW2 TRUE
    MICROPHONE_PERMISSION_ENABLED TRUE
    MICROPHONE_PERMISSION_TEXT "Terminator records samples from your audio interface."
    # NOT COPY_PLUGIN_AFTER_BUILD: JUCE's copy runs before our own POST_BUILD steps, so the installed bundle
    # would be the one WITHOUT the UI in it. We copy below, after the UI is inside.
    COPY_PLUGIN_AFTER_BUILD FALSE)

target_sources(TerminatorPlugin PRIVATE
    src/PluginProcessor.cpp
    src/PluginEditor.cpp
    # the shell, verbatim from the app
    ../app/src/WebShell.cpp
    ../app/src/ShellServices.cpp
    ../app/src/SampleRegistry.cpp
    ../app/src/ProcessHub.cpp
    ../app/src/PluginHub.cpp
    ../app/src/PluginRack.cpp
    ../app/src/StemHub.cpp
    ../app/src/LicenseHub.cpp
    ../app/src/CloudPresets.cpp
    ../app/src/SecretStore.cpp
    ../app/src/AppMenu.cpp
    ../app/src/Perf.cpp
    # The plain-C++ Updater on every platform: a PLUGIN never updates itself — the host owns the process, and
    # Sparkle driving a restart inside Ableton would be absurd. This file's no-Sparkle branch is exactly that.
    ../app/src/Updater.cpp)

target_include_directories(TerminatorPlugin PRIVATE ../app/src)

target_compile_definitions(TerminatorPlugin PRIVATE
    JUCE_WEB_BROWSER=1
    JUCE_PLUGINHOST_VST3=1
    $<$<PLATFORM_ID:Darwin>:JUCE_PLUGINHOST_AU=1>
    JUCE_USE_CURL=0
    JUCE_VST3_CAN_REPLACE_VST2=0
    JUCE_REPORT_APP_USAGE=0
    $<$<PLATFORM_ID:Windows>:JUCE_USE_WIN_WEBVIEW2_WITH_STATIC_LINKING=1>
    $<$<BOOL:${TERMINATOR_ORT_FOUND}>:TERMINATOR_STEMS=1>
    TERMINATOR_APPCAST_URL="${TERMINATOR_APPCAST_URL_WIN}"
    TERMINATOR_SPARKLE_PUBLIC_KEY="${TERMINATOR_SPARKLE_PUBLIC_KEY}")

target_link_libraries(TerminatorPlugin PRIVATE
    $<IF:$<BOOL:${TERMINATOR_ORT_FOUND}>,terminator::stems,terminator::engine>
    TerminatorWebResources
    juce::juce_audio_utils
    juce::juce_audio_processors
    juce::juce_gui_extra
    juce::juce_gui_basics
    juce::juce_recommended_config_flags
    juce::juce_recommended_lto_flags
    $<$<PLATFORM_ID:Darwin>:-framework\ Security>
    $<$<PLATFORM_ID:Windows>:crypt32>)
terminator_set_warnings(TerminatorPlugin)

# The built React UI rides inside each plugin bundle, the same way it rides inside the app — WebShell looks
# beside its own binary for it (resolveUiDir), so a plugin loaded by any host finds its own copy.
set(_terminator_plugin_dest_AU "$ENV{HOME}/Library/Audio/Plug-Ins/Components")
set(_terminator_plugin_dest_VST3 "$ENV{HOME}/Library/Audio/Plug-Ins/VST3")
foreach(_fmt AU VST3)
    if(TARGET TerminatorPlugin_${_fmt})
        add_custom_command(TARGET TerminatorPlugin_${_fmt} POST_BUILD
            COMMAND "${CMAKE_COMMAND}" -DSRC=${PROJECT_SOURCE_DIR}/ui/dist
                    -DDST=$<TARGET_BUNDLE_CONTENT_DIR:TerminatorPlugin_${_fmt}>/Resources/ui
                    -P "${PROJECT_SOURCE_DIR}/cmake/CopyDirIfExists.cmake"
            COMMENT "Bundling the React UI into the ${_fmt}"
            VERBATIM)
        # …and the drum library, so a plugin in a DAW has its kit without the network, exactly like the app.
        add_custom_command(TARGET TerminatorPlugin_${_fmt} POST_BUILD
            COMMAND "${CMAKE_COMMAND}" -DSRC=${PROJECT_SOURCE_DIR}/drums-flac
                    -DDST=$<TARGET_BUNDLE_CONTENT_DIR:TerminatorPlugin_${_fmt}>/Resources/drums-flac
                    -P "${PROJECT_SOURCE_DIR}/cmake/BundleDrums.cmake"
            VERBATIM)
        if(APPLE)
            # The copy the host actually loads — made LAST, so it carries the UI and the drums.
            add_custom_command(TARGET TerminatorPlugin_${_fmt} POST_BUILD
                COMMAND "${CMAKE_COMMAND}" -E make_directory "${_terminator_plugin_dest_${_fmt}}"
                COMMAND "${CMAKE_COMMAND}" -E rm -rf
                        "${_terminator_plugin_dest_${_fmt}}/$<TARGET_FILE_NAME:TerminatorPlugin_${_fmt}>.${_fmt}"
                COMMAND "${CMAKE_COMMAND}" -E copy_directory
                        "$<TARGET_BUNDLE_DIR:TerminatorPlugin_${_fmt}>"
                        "${_terminator_plugin_dest_${_fmt}}/$<TARGET_BUNDLE_DIR_NAME:TerminatorPlugin_${_fmt}>"
                COMMENT "Installing the ${_fmt} into ${_terminator_plugin_dest_${_fmt}}"
                VERBATIM)
        endif()
    endif()
endforeach()
