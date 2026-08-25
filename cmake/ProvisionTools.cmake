# cmake -DPLATFORM=mac|win -DDEST=<dir> -DCACHE=<dir> [-DLIPO=<path>] -P ProvisionTools.cmake
#
# Provisions the external command-line tools the native app ships: yt-dlp (ONEDIR nightly — the onefile build
# re-validates ~100 dylib signatures on EVERY launch, 12 s dead time; onedir = 0.3 s) and quickjs-ng's `qjs`
# (the JS runtime yt-dlp uses for YouTube's signature challenge — 1.3 MB, instead of a 100 MB deno/node;
# verified 2026-08-22: "JS runtimes: quickjs-ng-0.16.2", itag 140 extracted) for YouTube import, plus `lame`
# for MP3 export. Downloads are PINNED (versioned release URLs, never /latest/) and every file must match its
# hardcoded SHA-256 or the build fails — a bad binary can never be packaged. Bumping = change the tag/version
# AND the hashes together (yt-dlp: the release's SHA2-256SUMS; qjs + lame: `shasum -a 256` of the assets).
#
# LAME: the app DRIVES the `lame` executable (JUCE's LAMEEncoderAudioFormat) and links nothing, so shipping the
# unmodified upstream binary as a separate program keeps us clear of LAME's LGPL. There is no trustworthy
# prebuilt macOS binary (and none universal at all), so on mac we COMPILE the pinned 3.100 source tarball into
# one universal, dependency-free executable and ad-hoc sign it (release re-signs Resources/bin/** with the
# Developer ID before notarisation); Windows takes RareWares' prebuilt x64 lame.exe, the binary lame.sourceforge.net
# points at — statically linked, imports only KERNEL32 + SHLWAPI, so lame_enc.dll is NOT shipped.
# Layout under DEST:  ytdlp/<launcher> + ytdlp/_internal/  ·  qjs/qjs[.exe]  ·  lame[.exe]
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
set(LAME_VERSION "3.100")
set(LAME_SRC_URL "https://downloads.sourceforge.net/project/lame/lame/${LAME_VERSION}/lame-${LAME_VERSION}.tar.gz")
set(LAME_SRC_SHA "ddfe36cab873794038ae2c1210557ad34857a4b6bdc515785d1da9e175b1da1e")
set(LAME_WIN_TAG "3.100.1-x64") # RareWares' build of the same 3.100 encoder
set(LAME_WIN_URL "https://www.rarewares.org/files/mp3/lame${LAME_WIN_TAG}.zip")
set(LAME_WIN_SHA "9a9c815203316e5203847e93100c6acf0d5d7a5be7744c9018825ded037052e7")
set(LAME_MIN_MACOS "12.0") # keep equal to CMAKE_OSX_DEPLOYMENT_TARGET in CMakeLists.txt

if(NOT PLATFORM OR NOT DEST OR NOT CACHE)
    message(FATAL_ERROR "ProvisionTools.cmake needs -DPLATFORM=mac|win -DDEST=<dir> -DCACHE=<dir>")
endif()
set(STAMP_TEXT "ytdlp=${YTDLP_TAG};qjs=${QJS_TAG};lame=${LAME_VERSION};platform=${PLATFORM};v=2")
set(STAMP_FILE "${DEST}/.tools-tag")
if(EXISTS "${STAMP_FILE}")
    file(READ "${STAMP_FILE}" _have)
    string(STRIP "${_have}" _have)
    if(_have STREQUAL STAMP_TEXT)
        message(STATUS "tools: up to date in ${DEST} (${STAMP_TEXT})")
        return()
    endif()
endif()

# One pinned asset, hash-verified. RETRIED: these come from third-party hosts (rarewares.org took the Windows
# job red on 2026-08-25 with "Timeout was reached" — nothing to do with the commit), and a build that fails
# because someone else's server was busy for ten seconds teaches nobody anything. The HASH is still absolute:
# a download that completes with the wrong bytes fails on the spot, unretried.
function(fetch_pinned url dest sha)
    if(EXISTS "${dest}")
        file(SHA256 "${dest}" _cur)
        if(_cur STREQUAL sha)
            return()
        endif()
        file(REMOVE "${dest}")
    endif()
    # NOTE: the hash is checked HERE, not by file(DOWNLOAD EXPECTED_HASH) — that form raises a FATAL error of its
    # own the moment a transfer fails ("cannot compute hash on failed download"), which killed the build before
    # this retry loop could ever run (2026-08-25, twice, both times rarewares.org). Download, then verify.
    set(_attempts 3)
    foreach(_try RANGE 1 ${_attempts})
        message(STATUS "tools: downloading ${url} (attempt ${_try}/${_attempts})")
        file(DOWNLOAD "${url}" "${dest}" STATUS _st SHOW_PROGRESS TLS_VERIFY ON INACTIVITY_TIMEOUT 60)
        list(GET _st 0 _code)
        list(GET _st 1 _msg)
        if(_code EQUAL 0)
            file(SHA256 "${dest}" _got)
            if(_got STREQUAL sha)
                return()
            endif()
            # The server answered with the WRONG file. That is not a flake — stop, and never package it.
            file(REMOVE "${dest}")
            message(FATAL_ERROR "tools: ${url} does NOT match its pinned SHA-256 (got ${_got}, expected ${sha})")
        endif()
        file(REMOVE "${dest}")
        if(_try LESS ${_attempts})
            execute_process(COMMAND "${CMAKE_COMMAND}" -E sleep 5)
        endif()
    endforeach()
    message(FATAL_ERROR "tools: download failed for ${url} after ${_attempts} attempts: ${_msg}")
endfunction()

file(MAKE_DIRECTORY "${CACHE}")
file(REMOVE_RECURSE "${DEST}/ytdlp" "${DEST}/qjs")
file(REMOVE "${DEST}/lame" "${DEST}/lame.exe")
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
    # `lame` for MP3 export. No prebuilt macOS binary is trustworthy (and none is universal), so we COMPILE the
    # pinned source into one universal, dependency-free executable — system libs only. ~20 s ONCE per machine:
    # the result is cached next to the downloads, and the stamp file above skips the whole script after that.
    set(LAME_BUILT "${CACHE}/lame-${LAME_VERSION}-macos-universal")
    if(NOT EXISTS "${LAME_BUILT}")
        find_program(MAKE_EXE make)
        if(NOT MAKE_EXE)
            message(FATAL_ERROR "tools: `make` not found — install the Xcode command line tools, or build with -DTERMINATOR_BUNDLE_TOOLS=OFF (no MP3 export)")
        endif()
        fetch_pinned("${LAME_SRC_URL}" "${CACHE}/lame-${LAME_VERSION}.tar.gz" "${LAME_SRC_SHA}")
        set(_lame_work "${CACHE}/lame-src")
        file(REMOVE_RECURSE "${_lame_work}")
        file(MAKE_DIRECTORY "${_lame_work}")
        file(ARCHIVE_EXTRACT INPUT "${CACHE}/lame-${LAME_VERSION}.tar.gz" DESTINATION "${_lame_work}")
        set(_lame_src "${_lame_work}/lame-${LAME_VERSION}")
        if(NOT EXISTS "${_lame_src}/configure")
            message(FATAL_ERROR "tools: the lame source did not extract to ${_lame_src}")
        endif()
        # One pass, both slices: clang lipos them itself and every autoconf feature answer is arch-independent
        # here (both little-endian LP64), so a second configure would only be a second chance to disagree.
        set(_lame_arch "-arch arm64 -arch x86_64 -mmacosx-version-min=${LAME_MIN_MACOS}")
        message(STATUS "tools: building lame ${LAME_VERSION} universal (one time, cached in ${CACHE})")
        execute_process(
            COMMAND "${_lame_src}/configure" --disable-shared --enable-static --disable-dependency-tracking
                    "CFLAGS=-O2 ${_lame_arch}" "LDFLAGS=${_lame_arch}"
            WORKING_DIRECTORY "${_lame_src}"
            OUTPUT_FILE "${_lame_work}/configure.log" ERROR_FILE "${_lame_work}/configure.log"
            RESULT_VARIABLE _lr)
        if(NOT _lr EQUAL 0)
            message(FATAL_ERROR "tools: lame configure failed (${_lr}) — see ${_lame_work}/configure.log")
        endif()
        include(ProcessorCount)
        ProcessorCount(_lame_jobs)
        if(_lame_jobs EQUAL 0)
            set(_lame_jobs 2)
        endif()
        execute_process(COMMAND "${MAKE_EXE}" "-j${_lame_jobs}" WORKING_DIRECTORY "${_lame_src}"
                        OUTPUT_FILE "${_lame_work}/make.log" ERROR_FILE "${_lame_work}/make.log"
                        RESULT_VARIABLE _lr)
        if(NOT _lr EQUAL 0)
            message(FATAL_ERROR "tools: lame build failed (${_lr}) — see ${_lame_work}/make.log")
        endif()
        if(NOT EXISTS "${_lame_src}/frontend/lame")
            message(FATAL_ERROR "tools: lame built but frontend/lame is missing")
        endif()
        file(COPY_FILE "${_lame_src}/frontend/lame" "${LAME_BUILT}")
        file(REMOVE_RECURSE "${_lame_work}")
        # Ad-hoc sign it ourselves: whether the linker leaves a signature behind depends on the toolchain, and an
        # arm64 Mach-O without one is a coin toss macOS gets to call at export time. Release re-signs the whole
        # Resources/bin/** tree with the Developer ID before notarisation (BUILD-RULES.md).
        find_program(CODESIGN codesign)
        if(NOT CODESIGN)
            message(FATAL_ERROR "tools: `codesign` not found — install the Xcode command line tools")
        endif()
        execute_process(COMMAND "${CODESIGN}" --force --sign - --identifier lame "${LAME_BUILT}"
                        RESULT_VARIABLE _lr OUTPUT_QUIET ERROR_QUIET)
        if(NOT _lr EQUAL 0)
            file(REMOVE "${LAME_BUILT}") # never cache an unsignable binary
            message(FATAL_ERROR "tools: could not ad-hoc sign the built lame (${_lr})")
        endif()
    endif()
    file(COPY_FILE "${LAME_BUILT}" "${DEST}/lame")
    file(CHMOD "${DEST}/lame" PERMISSIONS OWNER_READ OWNER_WRITE OWNER_EXECUTE GROUP_READ GROUP_EXECUTE WORLD_READ WORLD_EXECUTE)
    if(NOT LIPO)
        find_program(LIPO lipo)
    endif()
    if(LIPO)
        execute_process(COMMAND "${LIPO}" -info "${DEST}/lame" OUTPUT_VARIABLE _lame_slices ERROR_QUIET RESULT_VARIABLE _lr)
        if(NOT _lr EQUAL 0 OR NOT _lame_slices MATCHES "arm64" OR NOT _lame_slices MATCHES "x86_64")
            message(FATAL_ERROR "tools: the bundled lame is not universal (${_lame_slices})")
        endif()
    endif()
    # An arm64 binary whose signature does not verify cannot be exec'd at all — catch that here, not at export
    # time. (Release signs Resources/bin/** with the app's Developer ID before notarisation — BUILD-RULES.md.)
    find_program(CODESIGN codesign)
    if(CODESIGN)
        execute_process(COMMAND "${CODESIGN}" --verify "${DEST}/lame" RESULT_VARIABLE _lr OUTPUT_QUIET ERROR_QUIET)
        if(NOT _lr EQUAL 0)
            file(REMOVE "${LAME_BUILT}") # the cached copy is the suspect — force a rebuild next time
            message(FATAL_ERROR "tools: the bundled lame has no valid signature — macOS would refuse to run it")
        endif()
    endif()
elseif(PLATFORM STREQUAL "win")
    fetch_pinned("${YTDLP_BASE}/yt-dlp_win.zip" "${CACHE}/yt-dlp_win-${YTDLP_TAG}.zip" "${YTDLP_SHA_win}")
    file(ARCHIVE_EXTRACT INPUT "${CACHE}/yt-dlp_win-${YTDLP_TAG}.zip" DESTINATION "${DEST}/ytdlp")
    if(NOT EXISTS "${DEST}/ytdlp/yt-dlp.exe")
        message(FATAL_ERROR "tools: yt-dlp.exe missing after extraction")
    endif()
    fetch_pinned("${QJS_BASE}/qjs-windows-x86_64.exe" "${CACHE}/qjs-windows-x86_64-${QJS_TAG}.exe" "${QJS_SHA_windows_x86_64}")
    file(COPY_FILE "${CACHE}/qjs-windows-x86_64-${QJS_TAG}.exe" "${DEST}/qjs/qjs.exe")
    # `lame` for MP3 export — RareWares' prebuilt x64 build of the same 3.100 encoder (the binary
    # lame.sourceforge.net points at). Statically linked: it imports only KERNEL32 + SHLWAPI, so the zip's
    # lame_enc.dll is deliberately NOT shipped.
    fetch_pinned("${LAME_WIN_URL}" "${CACHE}/lame${LAME_WIN_TAG}.zip" "${LAME_WIN_SHA}")
    set(_lame_work "${CACHE}/lame-win-${LAME_WIN_TAG}")
    file(REMOVE_RECURSE "${_lame_work}")
    file(MAKE_DIRECTORY "${_lame_work}")
    file(ARCHIVE_EXTRACT INPUT "${CACHE}/lame${LAME_WIN_TAG}.zip" DESTINATION "${_lame_work}" PATTERNS "lame.exe")
    if(NOT EXISTS "${_lame_work}/lame.exe")
        message(FATAL_ERROR "tools: lame.exe missing after extraction")
    endif()
    file(COPY_FILE "${_lame_work}/lame.exe" "${DEST}/lame.exe")
    file(REMOVE_RECURSE "${_lame_work}")
else()
    message(FATAL_ERROR "tools: unknown PLATFORM '${PLATFORM}'")
endif()

file(WRITE "${STAMP_FILE}" "${STAMP_TEXT}\n")
message(STATUS "tools: provisioned yt-dlp ${YTDLP_TAG} + qjs ${QJS_TAG} + lame ${LAME_VERSION} into ${DEST}")
