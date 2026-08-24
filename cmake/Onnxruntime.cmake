# ONNX Runtime — the stem separator's inference engine, PINNED and SHA-256 verified like every other
# third-party binary in this repo (docs/native/BUILD-RULES.md). Phase 7.1.
#
# Version 1.23.2 on purpose:
#   * it is the last macOS release Microsoft ships as osx-universal2 (1.24+ are arm64-only), and the shipping
#     Mac build is universal — `lipo -info` on the dylib says `x86_64 arm64`, so ONE file serves both slices;
#   * the Electron app's Intel Macs already run this exact version (the pinned onnxruntime-node-darwin-x64
#     alias), so a stem split is numerically the same engine on both apps;
#   * Windows takes onnxruntime-win-x64 at the SAME version — one number for both platforms.
# CPU execution provider only for now: WebGPU / CoreML / DirectML come in Phase 7.2 behind the SNR self-check
# (measured 2026-08-21: CoreML and the Intel-slice WebGPU return WRONG stems — no GPU path ships unprobed).
#
# The archive lands in third_party/.ort-cache (gitignored, shared by every preset) and is extracted once.
# Bumping = the version AND both hashes together, in this one file.
set(ORT_VERSION "1.23.2")
set(ORT_BASE "https://github.com/microsoft/onnxruntime/releases/download/v${ORT_VERSION}")
set(ORT_SHA_mac "49ae8e3a66ccb18d98ad3fe7f5906b6d7887df8a5edd40f49eb2b14e20885809")
set(ORT_SHA_win "0b38df9af21834e41e73d602d90db5cb06dbd1ca618948b8f1d66d607ac9f3cd")

set(TERMINATOR_ORT_FOUND OFF)
set(TERMINATOR_ORT_RUNTIME_LIB "" CACHE INTERNAL "The onnxruntime shared library to ship beside the app")

function(terminator_provision_ort)
    if(APPLE)
        set(_name "onnxruntime-osx-universal2-${ORT_VERSION}")
        set(_file "${_name}.tgz")
        set(_sha "${ORT_SHA_mac}")
    elseif(WIN32)
        set(_name "onnxruntime-win-x64-${ORT_VERSION}")
        set(_file "${_name}.zip")
        set(_sha "${ORT_SHA_win}")
    else()
        message(STATUS "onnxruntime: no pinned archive for this platform — stems disabled")
        return()
    endif()

    set(_cache "${CMAKE_SOURCE_DIR}/third_party/.ort-cache")
    set(_archive "${_cache}/${_file}")
    set(_dir "${_cache}/${_name}")
    file(MAKE_DIRECTORY "${_cache}")

    if(NOT EXISTS "${_dir}/include/onnxruntime_cxx_api.h")
        if(EXISTS "${_archive}")
            file(SHA256 "${_archive}" _have)
            if(NOT _have STREQUAL _sha)
                message(STATUS "onnxruntime: cached ${_file} has the wrong hash — refetching")
                file(REMOVE "${_archive}")
            endif()
        endif()
        if(NOT EXISTS "${_archive}")
            message(STATUS "onnxruntime: downloading ${_file} (~40-80 MB, once per machine)")
            file(DOWNLOAD "${ORT_BASE}/${_file}" "${_archive}"
                 EXPECTED_HASH SHA256=${_sha}
                 TLS_VERIFY ON
                 STATUS _st)
            list(GET _st 0 _code)
            if(NOT _code EQUAL 0)
                list(GET _st 1 _msg)
                file(REMOVE "${_archive}")
                message(FATAL_ERROR "onnxruntime download failed: ${_msg} — build with -DTERMINATOR_STEMS=OFF to skip stems")
            endif()
        endif()
        file(ARCHIVE_EXTRACT INPUT "${_archive}" DESTINATION "${_cache}")
    endif()

    if(APPLE)
        set(_runtime "${_dir}/lib/libonnxruntime.${ORT_VERSION}.dylib")
        set(_link "${_runtime}")
    else()
        set(_runtime "${_dir}/lib/onnxruntime.dll")
        set(_link "${_dir}/lib/onnxruntime.lib")
    endif()
    if(NOT EXISTS "${_runtime}" OR NOT EXISTS "${_dir}/include/onnxruntime_cxx_api.h")
        message(FATAL_ERROR "onnxruntime: ${_name} did not extract as expected (${_runtime})")
    endif()

    # HEADERS ONLY — the runtime is dlopen'd at the first split, never linked (StemModel.h explains why: every
    # prebuilt onnxruntime for macOS is built against 13.3+, and linking it would raise the whole app's floor
    # from macOS 12 to 13.4). TERMINATOR_ORT_RUNTIME_LIB is the file the app bundles / the dev build points at.
    add_library(onnxruntime INTERFACE IMPORTED GLOBAL)
    # -isystem: ORT's headers are third-party, our -Werror judges only our code.
    target_include_directories(onnxruntime SYSTEM INTERFACE "${_dir}/include")
    target_compile_definitions(onnxruntime INTERFACE TERMINATOR_ORT_DYLIB_PATH="${_runtime}")
    add_library(onnxruntime::onnxruntime ALIAS onnxruntime)

    set(TERMINATOR_ORT_FOUND ON PARENT_SCOPE)
    set(TERMINATOR_ORT_VERSION "${ORT_VERSION}" PARENT_SCOPE)
    set(TERMINATOR_ORT_RUNTIME_LIB "${_runtime}" CACHE INTERNAL "" FORCE)
    set(TERMINATOR_ORT_LIB_DIR "${_dir}/lib" CACHE INTERNAL "" FORCE)
    message(STATUS "onnxruntime ${ORT_VERSION} · ${_name}")
endfunction()

# Only a build that has the app or the CLIs runs a model (a bare engine+tests configure skips the download).
if(TERMINATOR_STEMS AND (TERMINATOR_BUILD_APP OR TERMINATOR_BUILD_TOOLS))
    terminator_provision_ort()
endif()
