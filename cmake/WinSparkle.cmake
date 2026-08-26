# WINSPARKLE — the Windows updater (Phase 9.1), PINNED and SHA-256 verified like every other third-party binary
# in this repo (docs/native/BUILD-RULES.md). The Windows half of what cmake/Sparkle.cmake does on macOS.
#
# 0.9.4 on purpose: it is the first release with `win_sparkle_set_eddsa_public_key`, so BOTH platforms verify
# their downloads against the SAME EdDSA key pair — one key in the release Mac's keychain, one `sign_update`
# tool, one thing to back up. The older DSA path is deprecated upstream and would have meant a second key.
#
# Windows has no Info.plist, so there is nothing to merge: the feed URL, the app details and the public key are
# handed to WinSparkle at runtime in app/src/Updater.cpp.
# The DLL is a RUNTIME asset that ships beside the exe; `-DTERMINATOR_UPDATER=OFF` skips the fetch entirely and
# Updater.cpp compiles to a do-nothing stub.
set(WINSPARKLE_VERSION "0.9.4")
set(WINSPARKLE_SHA "6037df37fc263bd1650a1c4949681a9d40ffe991d01f35892a406cb5d103c976")

set(TERMINATOR_WINSPARKLE_FOUND OFF)

function(terminator_provision_winsparkle)
    set(_cache "${CMAKE_SOURCE_DIR}/third_party/.winsparkle-cache")
    set(_archive "${_cache}/WinSparkle-${WINSPARKLE_VERSION}.zip")
    set(_dir "${_cache}/WinSparkle-${WINSPARKLE_VERSION}")
    file(MAKE_DIRECTORY "${_cache}")

    if(NOT EXISTS "${_dir}/include/winsparkle.h")
        if(EXISTS "${_archive}")
            file(SHA256 "${_archive}" _have)
            if(NOT _have STREQUAL WINSPARKLE_SHA)
                message(STATUS "winsparkle: cached archive has the wrong hash — refetching")
                file(REMOVE "${_archive}")
            endif()
        endif()
        if(NOT EXISTS "${_archive}")
            message(STATUS "winsparkle: downloading WinSparkle-${WINSPARKLE_VERSION}.zip (~27 MB, once per machine)")
            file(DOWNLOAD
                 "https://github.com/vslavik/winsparkle/releases/download/v${WINSPARKLE_VERSION}/WinSparkle-${WINSPARKLE_VERSION}.zip"
                 "${_archive}" EXPECTED_HASH SHA256=${WINSPARKLE_SHA} TLS_VERIFY ON STATUS _st)
            list(GET _st 0 _code)
            if(NOT _code EQUAL 0)
                list(GET _st 1 _msg)
                file(REMOVE "${_archive}")
                message(FATAL_ERROR "winsparkle download failed: ${_msg} — build with -DTERMINATOR_UPDATER=OFF to skip the updater")
            endif()
        endif()
        file(ARCHIVE_EXTRACT INPUT "${_archive}" DESTINATION "${_cache}")
    endif()

    # x64 only: that is the one Windows architecture this app is built and shipped for (CMakePresets win-*).
    set(_lib "${_dir}/x64/Release/WinSparkle.lib")
    set(_dll "${_dir}/x64/Release/WinSparkle.dll")
    if(NOT EXISTS "${_lib}" OR NOT EXISTS "${_dll}" OR NOT EXISTS "${_dir}/include/winsparkle.h")
        message(FATAL_ERROR "winsparkle: WinSparkle-${WINSPARKLE_VERSION} did not extract as expected (${_lib})")
    endif()

    add_library(winsparkle INTERFACE IMPORTED GLOBAL)
    # -isystem equivalent: WinSparkle's headers are third-party, our /W4 /WX judges only our code.
    target_include_directories(winsparkle SYSTEM INTERFACE "${_dir}/include")
    target_link_libraries(winsparkle INTERFACE "${_lib}")
    add_library(winsparkle::winsparkle ALIAS winsparkle)

    set(TERMINATOR_WINSPARKLE_FOUND ON PARENT_SCOPE)
    set(TERMINATOR_WINSPARKLE_VERSION "${WINSPARKLE_VERSION}" PARENT_SCOPE)
    set(TERMINATOR_WINSPARKLE_DLL "${_dll}" CACHE INTERNAL "WinSparkle.dll to ship beside the exe" FORCE)
    message(STATUS "winsparkle ${WINSPARKLE_VERSION} · ${_dll}")
endfunction()

if(WIN32 AND TERMINATOR_UPDATER AND TERMINATOR_BUILD_APP)
    terminator_provision_winsparkle()
endif()
