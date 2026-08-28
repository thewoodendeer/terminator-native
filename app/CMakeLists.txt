# Terminator — the JUCE shell. A native window hosting a WebView (WKWebView / WebView2) that renders the UI,
# with the engine + AudioIO behind it. Phase 0: a static status page + bridge v0 (engine info, live snapshot).
# WHAT THE OS HANDS THIS APP (JUCE merges this XML into the generated Info.plist):
#  - the `terminator://` URL SCHEME (8.5) — the browser sign-in hands its one-time code back through
#    `terminator://auth?code=…&state=…`, so macOS has to know this bundle owns the scheme;
#  - the PROJECT DOCUMENT TYPES (8.6) — `.tproj` / `.tprojz`, so a double-click in Finder opens Terminator, the
#    same two extensions electron-builder registers for the 2.x app. `CFBundleTypeIconFile AppIcon` gives those
#    files the Terminator logo in Finder instead of a blank page: the 2.x app's tproj-icon.icns is BYTE-IDENTICAL
#    to its app icon (checked), so pointing at the icns JUCE already generates from resources/icon.png is exact
#    parity with no second copy of the artwork in the repo.
# Both arrive as `anotherInstanceStarted` (JUCE routes application:openFile(s): and the GetURL Apple Event
# there) and are handled in Main.cpp. Windows has no plist — the app claims all three under HKCU on every
# launch, see registerOsAssociations() in Main.cpp.
set(TERMINATOR_OS_TYPES_PLIST [==[
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
  <key>CFBundleDocumentTypes</key>
  <array>
    <dict>
      <key>CFBundleTypeName</key>
      <string>Terminator Project</string>
      <key>CFBundleTypeExtensions</key>
      <array><string>tproj</string></array>
      <key>CFBundleTypeIconFile</key>
      <string>AppIcon</string>
      <key>CFBundleTypeRole</key>
      <string>Editor</string>
      <key>LSHandlerRank</key>
      <string>Owner</string>
    </dict>
    <dict>
      <key>CFBundleTypeName</key>
      <string>Terminator Project Bundle</string>
      <key>CFBundleTypeExtensions</key>
      <array><string>tprojz</string></array>
      <key>CFBundleTypeIconFile</key>
      <string>AppIcon</string>
      <key>CFBundleTypeRole</key>
      <string>Editor</string>
      <key>LSHandlerRank</key>
      <string>Owner</string>
    </dict>
  </array>
</dict>
</plist>
]==])

# THE UPDATE FEED (Phase 9.1). Sparkle reads these three keys out of the app's own Info.plist at launch.
#   * SUFeedURL   — the appcast under the app's OWN R2 prefix. `terminator-native/` is a different channel from
#                   the Electron app's `terminator-electron/`, so a 3.0 release can never corrupt the 2.x feed.
#                   Mac and Windows get SEPARATE files for the same reason (RELEASE-CYCLES rule: never touch the
#                   other platform's feed).
#   * SUPublicEDKey — the PUBLIC half of the EdDSA key pair. The private half lives only in the release Mac's
#                   login keychain and is what `sign_update` uses; Sparkle refuses any download whose signature
#                   this key does not verify. Publishing the public half is the point of it.
#   * automatic checks daily, but never an automatic INSTALL — the user is told and chooses, exactly as the
#                   Electron app behaves today ("Restart now / Later").
set(TERMINATOR_APPCAST_URL
    "https://pub-17b3d7f0dae24aa8b32405d12d43a870.r2.dev/terminator-native/appcast-mac.xml"
    CACHE STRING "Sparkle appcast URL baked into the app")
set(TERMINATOR_APPCAST_URL_WIN
    "https://pub-17b3d7f0dae24aa8b32405d12d43a870.r2.dev/terminator-native/appcast-win.xml"
    CACHE STRING "WinSparkle appcast URL baked into the Windows app")
set(TERMINATOR_SPARKLE_PUBLIC_KEY "qHRGkAicXqX+lOZgKNI4VnflnE3374jf1WCVWfxZFto="
    CACHE STRING "Public EdDSA key BOTH platforms verify downloads against (the private half is keychain-only)")

# THE BUILD NUMBER — what SPARKLE actually compares.
# JUCE writes `project(VERSION)` (3.0.0) into BOTH CFBundleVersion and CFBundleShortVersionString, which means
# every 3.0.0-alpha.N ships as "3.0.0": Sparkle compares CFBundleVersion, so no alpha would ever see the next
# alpha as newer, and the updater would sit there doing nothing without anyone noticing. Nor can the pre-release
# tag simply be pasted in — "3.0.0.7" (alpha.7) sorts ABOVE the final "3.0.0", so the release would look older
# than the alpha it replaces.
# So CFBundleVersion becomes one monotonic INTEGER derived from the one version string, and nothing else:
#   major*1000000 + minor*10000 + patch*100 + rank, rank = alpha.N -> N | beta.N -> 50+N | rc.N -> 80+N | final -> 99
# 3.0.0-alpha.0 = 3000000 · 3.0.0-alpha.1 = 3000001 · 3.0.0-beta.0 = 3000050 · 3.0.0 = 3000099 · 3.0.1 = 3000199.
# CFBundleShortVersionString stays the HUMAN string ("3.0.0-alpha.0") — that is what a person reads in About.
if(TERMINATOR_VERSION_STRING MATCHES "^([0-9]+)\\.([0-9]+)\\.([0-9]+)(-(alpha|beta|rc)\\.([0-9]+))?$")
    set(_v_major "${CMAKE_MATCH_1}")
    set(_v_minor "${CMAKE_MATCH_2}")
    set(_v_patch "${CMAKE_MATCH_3}")
    set(_v_tag "${CMAKE_MATCH_5}")
    set(_v_n "${CMAKE_MATCH_6}")
    if(_v_tag STREQUAL "alpha")
        math(EXPR _v_rank "${_v_n}")
    elseif(_v_tag STREQUAL "beta")
        math(EXPR _v_rank "50 + ${_v_n}")
    elseif(_v_tag STREQUAL "rc")
        math(EXPR _v_rank "80 + ${_v_n}")
    else()
        set(_v_rank 99) # a final release is newer than every pre-release of the same number
    endif()
    if(_v_rank GREATER 99)
        message(FATAL_ERROR "TERMINATOR_VERSION_STRING '${TERMINATOR_VERSION_STRING}': the pre-release counter is "
                            "too large — it would collide with the next patch version's build number")
    endif()
    math(EXPR TERMINATOR_BUNDLE_VERSION
         "${_v_major} * 1000000 + ${_v_minor} * 10000 + ${_v_patch} * 100 + ${_v_rank}")
else()
    message(FATAL_ERROR "TERMINATOR_VERSION_STRING '${TERMINATOR_VERSION_STRING}' is not "
                        "MAJOR.MINOR.PATCH[-alpha|beta|rc.N] — the updater's build number is derived from it")
endif()
message(STATUS "terminator ${TERMINATOR_VERSION_STRING} · CFBundleVersion ${TERMINATOR_BUNDLE_VERSION}")

set(TERMINATOR_UPDATER_PLIST "")
if(TERMINATOR_SPARKLE_FOUND)
    set(TERMINATOR_UPDATER_PLIST "  <key>SUFeedURL</key>
  <string>${TERMINATOR_APPCAST_URL}</string>
  <key>SUPublicEDKey</key>
  <string>${TERMINATOR_SPARKLE_PUBLIC_KEY}</string>
  <key>SUEnableAutomaticChecks</key>
  <true/>
  <key>SUScheduledCheckInterval</key>
  <integer>86400</integer>
  <key>SUAutomaticallyUpdate</key>
  <false/>
")
    string(REPLACE "</dict>\n</plist>" "${TERMINATOR_UPDATER_PLIST}</dict>\n</plist>"
           TERMINATOR_OS_TYPES_PLIST "${TERMINATOR_OS_TYPES_PLIST}")
endif()

# THE BUNDLE ID IS A RELEASE DECISION, NOT A CONSTANT (plan 9.4b). The installed Electron app is
# `com.terminator.audio`, and Squirrel.Mac only swaps a downloaded bundle into an installed one when the two
# ids MATCH — so the 3.0.0 that crosses over from 2.2.4 must carry the ELECTRON id, not this one. While 3.0 is
# in alpha the two apps deliberately differ so both can live on the same Mac without fighting over the
# `terminator://` scheme and the .tproj association. `tools/release/package-mac.sh` refuses to package a
# non-alpha version under the alpha id, so the switch cannot be forgotten.
set(TERMINATOR_BUNDLE_ID "app.killaviccheatcodes.terminator" CACHE STRING
    "macOS/Windows bundle identifier. The 3.0.0 HANDOVER release must use com.terminator.audio — see plan 9.4b.")

juce_add_gui_app(Terminator
    PRODUCT_NAME "Terminator"
    COMPANY_NAME "Killavic Cheat Codes"
    COMPANY_COPYRIGHT "Copyright (c) 2026 Killavic Cheat Codes"
    COMPANY_WEBSITE "https://killaviccheatcodes.app"
    BUNDLE_ID "${TERMINATOR_BUNDLE_ID}"
    VERSION "${PROJECT_VERSION}"
    ICON_BIG "${CMAKE_CURRENT_SOURCE_DIR}/resources/icon.png"
    PLIST_TO_MERGE "${TERMINATOR_OS_TYPES_PLIST}"
    NEEDS_WEB_BROWSER TRUE
    NEEDS_WEBVIEW2 TRUE
    MICROPHONE_PERMISSION_ENABLED TRUE
    MICROPHONE_PERMISSION_TEXT "Terminator records samples from your audio interface."
    HARDENED_RUNTIME_ENABLED TRUE
    # `disable-library-validation` is what PLUGIN HOSTING needs and nothing else: a hardened process refuses to
    # load a dylib signed by another team, and every VST3/AU a user owns is signed by someone else. Without it
    # Phase 6 works in a dev build and dies in the SIGNED one — a failure no unsigned run can show.
    HARDENED_RUNTIME_OPTIONS "com.apple.security.cs.allow-unsigned-executable-memory;com.apple.security.device.audio-input;com.apple.security.cs.disable-library-validation")

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
    src/CloudPresets.h
    src/CloudPresets.cpp
    src/SecretStore.h
    src/SecretStore.cpp
    src/AppMenu.h
    src/AppMenu.cpp
    src/Perf.h
    src/Perf.cpp
    src/Updater.h
    # macOS drives Sparkle from Objective-C++; every other platform gets the plain-C++ file (WinSparkle on
    # Windows, a stub elsewhere). Compiling the .mm on MSVC "worked" only because it treats an unknown
    # extension as C++ and the Objective-C sits behind an #if — luck, not design.
    $<IF:$<PLATFORM_ID:Darwin>,src/Updater.mm,src/Updater.cpp>)

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
    $<$<BOOL:${TERMINATOR_ORT_FOUND}>:TERMINATOR_STEMS=1>
    # THE UPDATER (Phase 9.1): compiled in only where Sparkle was provisioned (macOS). Updater.mm compiles to a
    # do-nothing stub otherwise, so nothing else in the app is conditional.
    $<$<BOOL:${TERMINATOR_SPARKLE_FOUND}>:TERMINATOR_HAS_SPARKLE=1>
    $<$<BOOL:${TERMINATOR_WINSPARKLE_FOUND}>:TERMINATOR_HAS_WINSPARKLE=1>
    # Windows has no Info.plist, so WinSparkle is told the feed and the key at runtime — from the SAME two
    # values the macOS plist is built from, so the platforms can never drift apart.
    TERMINATOR_APPCAST_URL="${TERMINATOR_APPCAST_URL_WIN}"
    TERMINATOR_SPARKLE_PUBLIC_KEY="${TERMINATOR_SPARKLE_PUBLIC_KEY}")

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

# The two version keys, stamped onto the plist JUCE generated (juceaide writes it from `project(VERSION)`, and
# there is no juce_add_gui_app argument for these two separately).
#
# AN `ALL` TARGET, NOT A POST_BUILD ON THE APP — and that distinction is the whole point. A POST_BUILD command
# runs only when its target RELINKS, while the Info.plist is regenerated whenever the project is re-configured.
# Re-configure without touching a source file and the plist comes back unstamped: CFBundleVersion falls back to
# "3.0.0", every pre-release advertises the same number, and the updater silently offers nobody anything. That
# is not hypothetical — it is what `tools/release/package-mac.sh` caught on its own `cmake --preset` step, which
# is why that gate exists. `plutil -replace` is idempotent, so running on every build costs nothing.
if(APPLE)
    add_custom_target(TerminatorStampVersion ALL
        # `plutil -replace` rather than PlistBuddy Set/Add: it inserts a key that is not there and overwrites one
        # that is, so this is idempotent across incremental rebuilds either way.
        # LSMinimumSystemVersion is not a nicety: without it Sparkle GUESSES the floor (it guesses 10.13) and
        # offers the update to Macs that cannot launch it — a download, a restart, and a dead app.
        COMMAND plutil -replace CFBundleVersion -string "${TERMINATOR_BUNDLE_VERSION}"
                "$<TARGET_BUNDLE_CONTENT_DIR:Terminator>/Info.plist"
        COMMAND plutil -replace CFBundleShortVersionString -string "${TERMINATOR_VERSION_STRING}"
                "$<TARGET_BUNDLE_CONTENT_DIR:Terminator>/Info.plist"
        COMMAND plutil -replace LSMinimumSystemVersion -string "${CMAKE_OSX_DEPLOYMENT_TARGET}"
                "$<TARGET_BUNDLE_CONTENT_DIR:Terminator>/Info.plist"
        # The Finder / Launchpad / App Store category. The 2.x app declares it and 3.0 did not — a missing one
        # shows up as "Other" wherever macOS groups apps by kind.
        COMMAND plutil -replace LSApplicationCategoryType -string "public.app-category.music"
                "$<TARGET_BUNDLE_CONTENT_DIR:Terminator>/Info.plist"
        COMMENT "Stamping CFBundleVersion ${TERMINATOR_BUNDLE_VERSION} (${TERMINATOR_VERSION_STRING}), macOS ${CMAKE_OSX_DEPLOYMENT_TARGET}+"
        VERBATIM)
    add_dependencies(TerminatorStampVersion Terminator)
endif()

# WINSPARKLE (Phase 9.1) is a DLL that ships beside the exe, and nothing more — no bundle, no plist.
if(TERMINATOR_WINSPARKLE_FOUND)
    target_link_libraries(Terminator PRIVATE winsparkle::winsparkle)
    add_custom_command(TARGET Terminator POST_BUILD
        COMMAND "${CMAKE_COMMAND}" -E copy_if_different "${TERMINATOR_WINSPARKLE_DLL}" "$<TARGET_FILE_DIR:Terminator>"
        COMMENT "Bundling WinSparkle ${TERMINATOR_WINSPARKLE_VERSION} (the updater)"
        VERBATIM)
endif()

# SPARKLE (Phase 9.1) rides in Contents/Frameworks like any other embedded framework.
# `ditto` and not `cmake -E copy_directory`: a framework is a tree of SYMLINKS (Versions/Current and every
# top-level entry), and CMake's copy DEREFERENCES them — the result is twice the size and does not load.
# The framework carries its own nested Updater.app and two XPC services; `tools/release/package-mac.sh` signs
# those as BUNDLES, which is why that script signs nested bundles as units rather than file by file.
if(TERMINATOR_SPARKLE_FOUND)
    cmake_path(GET TERMINATOR_SPARKLE_FRAMEWORK PARENT_PATH _terminator_sparkle_search)
    target_compile_options(Terminator PRIVATE "-F${_terminator_sparkle_search}")
    target_link_options(Terminator PRIVATE "-F${_terminator_sparkle_search}")
    target_link_libraries(Terminator PRIVATE "-framework Sparkle")
    # Sparkle's install name is @rpath-relative, so the app has to say where its frameworks live.
    set_target_properties(Terminator PROPERTIES
        BUILD_RPATH   "@executable_path/../Frameworks"
        INSTALL_RPATH "@executable_path/../Frameworks")
    add_custom_command(TARGET Terminator POST_BUILD
        COMMAND "${CMAKE_COMMAND}" -E make_directory "$<TARGET_BUNDLE_CONTENT_DIR:Terminator>/Frameworks"
        COMMAND "${CMAKE_COMMAND}" -E rm -rf
                "$<TARGET_BUNDLE_CONTENT_DIR:Terminator>/Frameworks/Sparkle.framework"
        COMMAND ditto "${TERMINATOR_SPARKLE_FRAMEWORK}"
                "$<TARGET_BUNDLE_CONTENT_DIR:Terminator>/Frameworks/Sparkle.framework"
        COMMENT "Embedding Sparkle ${TERMINATOR_SPARKLE_VERSION} (the updater)"
        VERBATIM)
endif()

# This target IS the process (see engine/CMakeLists.txt — the engine no longer says so for its consumers).
target_compile_definitions(Terminator PRIVATE JUCE_STANDALONE_APPLICATION=1)
