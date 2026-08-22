# cmake -DPLATFORM=mac|win -DDEST=<dir> -DCACHE=<dir> [-DLIPO=<path>] -P ProvisionTools.cmake
#
# Provisions the two external tools the native app ships for YouTube import (the Julienne/Electron engine, same
# pins): yt-dlp (ONEDIR nightly — the onefile build re-validates ~100 dylib signatures on EVERY launch, 12 s
# dead time; onedir = 0.3 s) and quickjs-ng's `qjs` (the JS runtime yt-dlp uses for YouTube's signature
# challenge — 1.3 MB, instead of a 100 MB deno/node; verified 2026-08-22: "JS runtimes: quickjs-ng-0.16.2",
# itag 140 extracted). Downloads are PINNED (versioned release URLs, never /latest/) and every file must match
# its hardcoded SHA-256 or the build fails — a bad binary can never be packaged. Bumping = change the tag/version
# AND the hashes together (yt-dlp: the release's SHA2-256SUMS; qjs: `shasum -a 256` of the release assets).
# Layout under DEST:  ytdlp/<launcher> + ytdlp/_internal/   and   qjs/qjs[.exe]
# Used by app/CMakeLists.txt (target TerminatorBundleTools) with DEST = the app bundle's Resources/bin (mac) or
# <exe dir>/bin (Windows). A stamp file skips the work when the pins are unchanged.
cmake_minimum_required(VERSION 3.21)

set(YTDLP_TAG "2026.08.16.020253")
set(YTDLP_BASE "https://github.com/yt-dlp/yt-dlp-nightly-builds/releases/download/${YTDLP_TAG}")
set(YTDLP_SHA_mac "a9adea0fe41dda5c995b6b6b4586ab14b030d175bad3a0becabc4fbb09f3e358")
set(YTDLP_SHA_win "9a362fe07786e2a7bf91331c6663faa74b1a68082770848101c19298083501ca")
set(QJS_TAG "v0.16.2")
set(QJS_BASE "https://github.com/quickjs-ng/quickjs/releases/download/${QJS_TAG}")
set(QJS_SHA_darwin_arm64  "f6200e9856c45578a5d42ac873a32f3f994b421e29df9f63b452d9c7145015fc")
set(QJS_SHA_darwin_x86_64 "4448991c0500dbe40c7b2f91ba39275995413aa4ee59db3b513b68350908a413")
set(QJS_SHA_windows_x86_64 "7b27412de844403545bd151fbe49191b4d5b91a9e15b5db7c863fea54639a82b")

if(NOT PLATFORM OR NOT DEST OR NOT CACHE)
    message(FATAL_ERROR "ProvisionTools.cmake needs -DPLATFORM=mac|win -DDEST=<dir> -DCACHE=<dir>")
endif()
set(STAMP_TEXT "ytdlp=${YTDLP_TAG};qjs=${QJS_TAG};platform=${PLATFORM};v=1")
set(STAMP_FILE "${DEST}/.tools-tag")
if(EXISTS "${STAMP_FILE}")
    file(READ "${STAMP_FILE}" _have)
    string(STRIP "${_have}" _have)
    if(_have STREQUAL STAMP_TEXT)
        message(STATUS "tools: up to date in ${DEST} (${STAMP_TEXT})")
        return()
    endif()
endif()

function(fetch_pinned url dest sha)
    if(EXISTS "${dest}")
        file(SHA256 "${dest}" _cur)
        if(_cur STREQUAL sha)
            return()
        endif()
        file(REMOVE "${dest}")
    endif()
    message(STATUS "tools: downloading ${url}")
    file(DOWNLOAD "${url}" "${dest}" EXPECTED_HASH SHA256=${sha} STATUS _st SHOW_PROGRESS TLS_VERIFY ON)
    list(GET _st 0 _code)
    if(NOT _code EQUAL 0)
        list(GET _st 1 _msg)
        file(REMOVE "${dest}")
        message(FATAL_ERROR "tools: download failed for ${url}: ${_msg}")
    endif()
endfunction()

file(MAKE_DIRECTORY "${CACHE}")
file(REMOVE_RECURSE "${DEST}/ytdlp" "${DEST}/qjs")
file(MAKE_DIRECTORY "${DEST}/ytdlp" "${DEST}/qjs")

if(PLATFORM STREQUAL "mac")
    fetch_pinned("${YTDLP_BASE}/yt-dlp_macos.zip" "${CACHE}/yt-dlp_macos-${YTDLP_TAG}.zip" "${YTDLP_SHA_mac}")
    file(ARCHIVE_EXTRACT INPUT "${CACHE}/yt-dlp_macos-${YTDLP_TAG}.zip" DESTINATION "${DEST}/ytdlp")
    # The mac zip carries _internal/Python.framework — three byte-identical copies of the interpreter dylib the
    # launcher never loads (it dlopens the FLAT _internal/Python next to it) and a layout codesign refuses as
    # "ambiguous bundle". Strip it (42 MB), exactly like the Electron build does.
    file(REMOVE_RECURSE "${DEST}/ytdlp/_internal/Python.framework")
    if(NOT EXISTS "${DEST}/ytdlp/yt-dlp_macos")
        message(FATAL_ERROR "tools: yt-dlp_macos launcher missing after extraction")
    endif()
    file(CHMOD "${DEST}/ytdlp/yt-dlp_macos" PERMISSIONS OWNER_READ OWNER_WRITE OWNER_EXECUTE GROUP_READ GROUP_EXECUTE WORLD_READ WORLD_EXECUTE)
    fetch_pinned("${QJS_BASE}/qjs-darwin-arm64" "${CACHE}/qjs-darwin-arm64-${QJS_TAG}" "${QJS_SHA_darwin_arm64}")
    fetch_pinned("${QJS_BASE}/qjs-darwin-x86_64" "${CACHE}/qjs-darwin-x86_64-${QJS_TAG}" "${QJS_SHA_darwin_x86_64}")
    # one universal qjs so the same bundle runs natively on both Mac architectures
    if(NOT LIPO)
        find_program(LIPO lipo)
    endif()
    if(LIPO)
        execute_process(COMMAND "${LIPO}" -create "${CACHE}/qjs-darwin-arm64-${QJS_TAG}" "${CACHE}/qjs-darwin-x86_64-${QJS_TAG}"
                                -output "${DEST}/qjs/qjs" RESULT_VARIABLE _lr)
        if(NOT _lr EQUAL 0)
            message(FATAL_ERROR "tools: lipo failed (${_lr})")
        endif()
    else()
        message(WARNING "tools: lipo not found — shipping the arm64 qjs only")
        file(COPY_FILE "${CACHE}/qjs-darwin-arm64-${QJS_TAG}" "${DEST}/qjs/qjs")
    endif()
    file(CHMOD "${DEST}/qjs/qjs" PERMISSIONS OWNER_READ OWNER_WRITE OWNER_EXECUTE GROUP_READ GROUP_EXECUTE WORLD_READ WORLD_EXECUTE)
elseif(PLATFORM STREQUAL "win")
    fetch_pinned("${YTDLP_BASE}/yt-dlp_win.zip" "${CACHE}/yt-dlp_win-${YTDLP_TAG}.zip" "${YTDLP_SHA_win}")
    file(ARCHIVE_EXTRACT INPUT "${CACHE}/yt-dlp_win-${YTDLP_TAG}.zip" DESTINATION "${DEST}/ytdlp")
    if(NOT EXISTS "${DEST}/ytdlp/yt-dlp.exe")
        message(FATAL_ERROR "tools: yt-dlp.exe missing after extraction")
    endif()
    fetch_pinned("${QJS_BASE}/qjs-windows-x86_64.exe" "${CACHE}/qjs-windows-x86_64-${QJS_TAG}.exe" "${QJS_SHA_windows_x86_64}")
    file(COPY_FILE "${CACHE}/qjs-windows-x86_64-${QJS_TAG}.exe" "${DEST}/qjs/qjs.exe")
else()
    message(FATAL_ERROR "tools: unknown PLATFORM '${PLATFORM}'")
endif()

file(WRITE "${STAMP_FILE}" "${STAMP_TEXT}\n")
message(STATUS "tools: provisioned yt-dlp ${YTDLP_TAG} + qjs ${QJS_TAG} into ${DEST}")
