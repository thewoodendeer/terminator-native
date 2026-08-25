# Terminator — the JUCE shell. A native window hosting a WebView (WKWebView / WebView2) that renders the UI,
# with the engine + AudioIO behind it. Phase 0: a static status page + bridge v0 (engine info, live snapshot).
# THE `terminator://` URL SCHEME (8.5): the browser sign-in hands the one-time code back through
# `terminator://auth?code=…&state=…`, so macOS has to know this bundle owns the scheme (JUCE merges this XML
# into the generated Info.plist). Windows has no plist — the app claims the scheme itself under HKCU on first
# run, see registerUrlScheme() in Main.cpp.
set(TERMINATOR_URL_SCHEME_PLIST [==[
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleURLTypes</key>
  <array>
    <dict>
      <key>CFBundleURLName</key>
      <string>Terminator sign-in</string>
      <key>CFBundleURLSchemes</key>
      <array><string>terminator</string></array>
    </dict>
  </array>
</dict>
</plist>
]==])

juce_add_gui_app(Terminator
    PRODUCT_NAME "Terminator"
    COMPANY_NAME "Killavic Cheat Codes"
    BUNDLE_ID "app.killaviccheatcodes.terminator"
    VERSION "${PROJECT_VERSION}"
    PLIST_TO_MERGE "${TERMINATOR_URL_SCHEME_PLIST}"
    NEEDS_WEB_BROWSER TRUE
    NEEDS_WEBVIEW2 TRUE
    MICROPHONE_PERMISSION_ENABLED TRUE
    MICROPHONE_PERMISSION_TEXT "Terminator records samples from your audio interface."
    HARDENED_RUNTIME_ENABLED TRUE
    HARDENED_RUNTIME_OPTIONS "com.apple.security.cs.allow-unsigned-executable-memory;com.apple.security.device.audio-input")

# Web resources served to the WebView through the resource provider: our static page + JUCE's official
# @juce-framework/webview JS (ESM) taken straight from the fetched JUCE tree — never hand-rolled plumbing.
set(TERMINATOR_JUCE_WEBVIEW_JS "${JUCE_SOURCE_DIR}/modules/juce_gui_extra/native/typescript/webview-interop/dist/index.js")
if(NOT EXISTS "${TERMINATOR_JUCE_WEBVIEW_JS}")
    message(FATAL_ERROR "JUCE webview-interop dist not found at ${TERMINATOR_JUCE_WEBVIEW_JS}")
endif()
juce_add_binary_data(TerminatorWebResources
    HEADER_NAME "WebResources.h"
    NAMESPACE WebResources
    SOURCES
        resources/index.html
        "${TERMINATOR_JUCE_WEBVIEW_JS}")

target_sources(Terminator PRIVATE
    src/Main.cpp
    src/MainWindow.h
    src/MainWindow.cpp
    src/WebShell.h
    src/WebShell.cpp
    src/ShellServices.h
    src/ShellServices.cpp
    src/SampleRegistry.h
    src/SampleRegistry.cpp
    src/ProcessHub.h
    src/ProcessHub.cpp
    src/PluginHub.h
    src/PluginHub.cpp
    src/PluginRack.h
    src/PluginRack.cpp
    src/StemHub.h
    src/StemHub.cpp
    src/LicenseHub.h
    src/LicenseHub.cpp
    src/SecretStore.h
    src/SecretStore.cpp
    src/AppMenu.h
    src/AppMenu.cpp)

target_compile_definitions(Terminator PRIVATE
    JUCE_WEB_BROWSER=1
    # PLUGINS (Phase 6): VST3 everywhere, AudioUnit on macOS. The scan runs in a child process (PluginHub).
    JUCE_PLUGINHOST_VST3=1
    $<$<PLATFORM_ID:Darwin>:JUCE_PLUGINHOST_AU=1>
    JUCE_USE_CURL=0
    JUCE_APPLICATION_NAME_STRING="$<TARGET_PROPERTY:Terminator,JUCE_PRODUCT_NAME>"
    JUCE_APPLICATION_VERSION_STRING="$<TARGET_PROPERTY:Terminator,JUCE_VERSION>"
    JUCE_REPORT_APP_USAGE=0
    $<$<PLATFORM_ID:Windows>:JUCE_USE_WIN_WEBVIEW2_WITH_STATIC_LINKING=1>
    # STEMS (Phase 7): compiled in only where onnxruntime was provisioned. The runtime itself is dlopen'd at the
    # first split, never linked (cmake/Onnxruntime.cmake explains why).
    $<$<BOOL:${TERMINATOR_ORT_FOUND}>:TERMINATOR_STEMS=1>)

target_link_libraries(Terminator PRIVATE
    # terminator::stems already carries terminator::engine (PUBLIC) — naming both makes ld see the same static
    # library twice and say so.
    $<IF:$<BOOL:${TERMINATOR_ORT_FOUND}>,terminator::stems,terminator::engine>
    TerminatorWebResources
    juce::juce_gui_extra
    juce::juce_gui_basics
    juce::juce_audio_utils
    juce::juce_audio_processors
    juce::juce_recommended_config_flags
    juce::juce_recommended_lto_flags
    # the device token at rest: macOS Keychain Services, Windows DPAPI (SecretStore.cpp)
    $<$<PLATFORM_ID:Darwin>:-framework\ Security>
    $<$<PLATFORM_ID:Windows>:crypt32>)
terminator_set_warnings(Terminator)

# The built React UI (ui/dist — `cd ui && npm ci && npm run gate`) rides inside the app: macOS bundle
# Resources/ui, Windows next to the exe. Copied after every build IF it exists, so an engine-only checkout still
# builds (the shell then serves the embedded Phase-1 page). See ui/README.md + docs/native/BUILD-RULES.md.
set(TERMINATOR_UI_DIST "${PROJECT_SOURCE_DIR}/ui/dist" CACHE PATH "Built React UI to bundle (ui/dist)")
if(APPLE)
    set(_terminator_ui_dest "$<TARGET_BUNDLE_CONTENT_DIR:Terminator>/Resources/ui")
else()
    set(_terminator_ui_dest "$<TARGET_FILE_DIR:Terminator>/ui")
endif()
# An always-run target (not a POST_BUILD step — that only fires when the app RELINKS, so a UI-only rebuild
# `npm run gate` + `cmake --build` used to keep serving yesterday's bundle; caught by the probe 2026-08-22).
add_custom_target(TerminatorBundleUi ALL
    COMMAND "${CMAKE_COMMAND}" -DSRC=${TERMINATOR_UI_DIST} -DDST=${_terminator_ui_dest}
            -P "${PROJECT_SOURCE_DIR}/cmake/CopyDirIfExists.cmake"
    COMMENT "Bundling the React UI from ${TERMINATOR_UI_DIST} (if built)"
    VERBATIM)
add_dependencies(TerminatorBundleUi Terminator)

# The KCC drum library inside the app (macOS Resources/drums-flac, Windows <exe dir>/drums-flac) so drums need
# no network — the shell serves it at /drums/<id>.<ext>. `drums-flac/` is gitignored; provision it with
# `node tools/fetch-drums.mjs`. Absent = the app reads drums from R2 like the web build (CI builds this way).
# -DTERMINATOR_BUNDLE_DRUMS=OFF skips the copy even when the folder is there.
option(TERMINATOR_BUNDLE_DRUMS "Bundle the drum library (drums-flac/) into the app" ON)
if(TERMINATOR_BUNDLE_DRUMS)
    if(APPLE)
        set(_terminator_drums_dest "$<TARGET_BUNDLE_CONTENT_DIR:Terminator>/Resources/drums-flac")
    else()
        set(_terminator_drums_dest "$<TARGET_FILE_DIR:Terminator>/drums-flac")
    endif()
    add_custom_target(TerminatorBundleDrums ALL
        COMMAND "${CMAKE_COMMAND}" -DSRC=${PROJECT_SOURCE_DIR}/drums-flac -DDST=${_terminator_drums_dest}
                -P "${PROJECT_SOURCE_DIR}/cmake/BundleDrums.cmake"
        COMMENT "Bundling the drum library from drums-flac (if provisioned)"
        VERBATIM)
    add_dependencies(TerminatorBundleDrums Terminator)
endif()

# yt-dlp (pinned onedir nightly) + quickjs-ng qjs for YouTube import, and `lame` for MP3 export —
# cmake/ProvisionTools.cmake downloads the pinned, SHA-256-verified assets once into third_party/.tools-cache and
# lays them into the bundle: macOS Resources/bin/{ytdlp,qjs,lame}, Windows <exe dir>/bin/{ytdlp,qjs,lame.exe}.
# -DTERMINATOR_BUNDLE_TOOLS=OFF for an offline / engine-only build (the app then reports "yt-dlp is missing from
# this build" for YouTube links, and MP3 export needs a lame on the machine).
option(TERMINATOR_BUNDLE_TOOLS "Download + bundle yt-dlp, qjs and lame into the app (YouTube import, MP3 export)" ON)
if(TERMINATOR_BUNDLE_TOOLS)
    if(APPLE)
        set(_terminator_tools_dest "$<TARGET_BUNDLE_CONTENT_DIR:Terminator>/Resources/bin")
        set(_terminator_tools_platform mac)
    else()
        set(_terminator_tools_dest "$<TARGET_FILE_DIR:Terminator>/bin")
        set(_terminator_tools_platform win)
    endif()
    add_custom_target(TerminatorBundleTools ALL
        COMMAND "${CMAKE_COMMAND}" -DPLATFORM=${_terminator_tools_platform} -DDEST=${_terminator_tools_dest}
                -DCACHE=${PROJECT_SOURCE_DIR}/third_party/.tools-cache
                -P "${PROJECT_SOURCE_DIR}/cmake/ProvisionTools.cmake"
        COMMENT "Bundling yt-dlp + qjs + lame (pinned, SHA-256 verified; cached in third_party/.tools-cache)"
        VERBATIM)
    add_dependencies(TerminatorBundleTools Terminator)
endif()

# The onnxruntime shared library rides in the bundle, next to the app that dlopens it: macOS
# Contents/Frameworks (where StemModel's `@loader_path/../Frameworks/...` candidate looks), Windows beside the
# exe. It is a RUNTIME asset — nothing links it, so a Mac too old for it (it needs 13.4) still launches, and
# stems are simply unavailable there.
if(TERMINATOR_ORT_FOUND AND TERMINATOR_ORT_RUNTIME_LIB)
    if(APPLE)
        set(_terminator_ort_dest "$<TARGET_BUNDLE_CONTENT_DIR:Terminator>/Frameworks")
    else()
        set(_terminator_ort_dest "$<TARGET_FILE_DIR:Terminator>")
    endif()
    add_custom_command(TARGET Terminator POST_BUILD
        COMMAND "${CMAKE_COMMAND}" -E make_directory "${_terminator_ort_dest}"
        COMMAND "${CMAKE_COMMAND}" -E copy_if_different "${TERMINATOR_ORT_RUNTIME_LIB}" "${_terminator_ort_dest}"
        COMMENT "Bundling onnxruntime (stems)"
        VERBATIM)
    if(APPLE)
        # StemModel asks dlopen for the PLAIN name first; a symlink beside the real file answers it without a
        # second 75 MB copy in the bundle (and codesign is happy to sign a symlink's target).
        add_custom_command(TARGET Terminator POST_BUILD
            COMMAND "${CMAKE_COMMAND}" -E rm -f "${_terminator_ort_dest}/libonnxruntime.dylib"
            COMMAND "${CMAKE_COMMAND}" -E create_symlink "libonnxruntime.1.23.2.dylib"
                    "${_terminator_ort_dest}/libonnxruntime.dylib"
            VERBATIM)
    endif()
endif()
