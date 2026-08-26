# SPARKLE — the macOS updater (Phase 9.1), PINNED and SHA-256 verified like every other third-party binary in
# this repo (docs/native/BUILD-RULES.md).
#
# Why Sparkle and not electron-updater's format: 3.0 is not an Electron app any more, and the `latest-mac.yml`
# feed the 2.x app polls is used EXACTLY ONCE — for the handover release that swaps an installed 2.2.4 into the
# native 3.0.0 (plan 9.4b). After that crossing every update comes from a Sparkle appcast under the app's own
# R2 prefix, so the two channels never share a file and a native release can never corrupt the Electron feed.
#
# 2.9.6 is a BINARY distribution: a universal Sparkle.framework already signed and hardened by the Sparkle
# project, carrying its own nested Updater.app and two XPC services. `tools/release/package-mac.sh` re-signs all
# four as BUNDLES (never file-by-file — that would break their own signatures) with our Developer ID.
#
# The framework is a RUNTIME dependency of the app only. Bumping = the version AND the hash together, here.
set(SPARKLE_VERSION "2.9.6")
set(SPARKLE_SHA "52bf9e88cdd972fc0c81501377a880e90d47031bd8ca5462488f843e2609e192")

set(TERMINATOR_SPARKLE_FOUND OFF)

function(terminator_provision_sparkle)
    set(_cache "${CMAKE_SOURCE_DIR}/third_party/.sparkle-cache")
    set(_dir "${_cache}/Sparkle-${SPARKLE_VERSION}")
    set(_archive "${_cache}/Sparkle-${SPARKLE_VERSION}.tar.xz")
    set(_fw "${_dir}/Sparkle.framework")
    file(MAKE_DIRECTORY "${_cache}")

    if(NOT EXISTS "${_fw}/Versions/B/Sparkle")
        if(EXISTS "${_archive}")
            file(SHA256 "${_archive}" _have)
            if(NOT _have STREQUAL SPARKLE_SHA)
                message(STATUS "sparkle: cached archive has the wrong hash — refetching")
                file(REMOVE "${_archive}")
            endif()
        endif()
        if(NOT EXISTS "${_archive}")
            message(STATUS "sparkle: downloading Sparkle-${SPARKLE_VERSION}.tar.xz (~15 MB, once per machine)")
            file(DOWNLOAD
                 "https://github.com/sparkle-project/Sparkle/releases/download/${SPARKLE_VERSION}/Sparkle-${SPARKLE_VERSION}.tar.xz"
                 "${_archive}" EXPECTED_HASH SHA256=${SPARKLE_SHA} TLS_VERIFY ON STATUS _st)
            list(GET _st 0 _code)
            if(NOT _code EQUAL 0)
                list(GET _st 1 _msg)
                file(REMOVE "${_archive}")
                message(FATAL_ERROR "sparkle download failed: ${_msg} — build with -DTERMINATOR_UPDATER=OFF to skip the updater")
            endif()
        endif()
        # `tar` rather than file(ARCHIVE_EXTRACT): the framework is a tree of SYMLINKS (Versions/Current, and
        # every top-level entry), and CMake's extractor does not preserve them — a dereferenced copy is both
        # twice the size and not a loadable framework.
        file(MAKE_DIRECTORY "${_dir}")
        execute_process(COMMAND tar -xf "${_archive}" -C "${_dir}" RESULT_VARIABLE _tar)
        if(NOT _tar EQUAL 0)
            message(FATAL_ERROR "sparkle: extracting ${_archive} failed")
        endif()
    endif()

    if(NOT EXISTS "${_fw}/Versions/B/Sparkle")
        message(FATAL_ERROR "sparkle: ${_fw} did not extract as expected")
    endif()

    set(TERMINATOR_SPARKLE_FOUND ON PARENT_SCOPE)
    set(TERMINATOR_SPARKLE_VERSION "${SPARKLE_VERSION}" PARENT_SCOPE)
    set(TERMINATOR_SPARKLE_FRAMEWORK "${_fw}" CACHE INTERNAL "Sparkle.framework to embed in the app" FORCE)
    # generate_keys / sign_update / generate_appcast — used by the release scripts, never by the build.
    set(TERMINATOR_SPARKLE_BIN "${_dir}/bin" CACHE INTERNAL "Sparkle's release tools" FORCE)
    message(STATUS "sparkle ${SPARKLE_VERSION} · ${_fw}")
endfunction()

if(APPLE AND TERMINATOR_UPDATER AND TERMINATOR_BUILD_APP)
    terminator_provision_sparkle()
endif()
