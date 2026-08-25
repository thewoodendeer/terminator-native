# cmake -DSRC=<dir> -DDST=<dir> -P BundleDrums.cmake
#
# Lays the KCC drum library (opaque-id .flac/.mp3 one-shots) into the app so the desktop build needs no network
# for drums — the Electron app has shipped it in Resources/drums-flac since 2026-08-21 and the native shell
# serves it at /drums/<id>.<ext> (WebShell::provideResource). SRC is the repo's `drums-flac/`, which is
# GITIGNORED (80 MB, 1180 files): provision it with `node tools/fetch-drums.mjs`. When SRC is absent the app is
# simply built without a bundled library and the page reads drums off R2, exactly like the web build — so a
# fresh clone and CI still build.
#
# ONLY the audio rides along: `drums-flac/` also holds the id -> real filename maps the fetch script writes, and
# those must never ship (the client never sees a real drum filename — drumR2.ts / drumAliases.ts).
# A stamp (file count + total bytes) skips the copy when the library is unchanged, so this costs one 80 MB copy
# per build dir and nothing afterwards.
if(NOT SRC OR NOT DST)
    message(FATAL_ERROR "BundleDrums.cmake needs -DSRC=<dir> -DDST=<dir>")
endif()

file(GLOB _drums "${SRC}/*.flac" "${SRC}/*.mp3")
list(LENGTH _drums _count)
if(_count EQUAL 0)
    if(EXISTS "${DST}")
        file(REMOVE_RECURSE "${DST}")
    endif()
    message(STATUS "drums: ${SRC} is empty or missing — the app reads drums from R2 (node tools/fetch-drums.mjs to bundle them)")
    return()
endif()

set(_bytes 0)
foreach(_f IN LISTS _drums)
    file(SIZE "${_f}" _sz)
    math(EXPR _bytes "${_bytes} + ${_sz}")
endforeach()
set(_stamp_text "count=${_count};bytes=${_bytes}")
set(_stamp_file "${DST}/.drums-tag")
if(EXISTS "${_stamp_file}")
    file(READ "${_stamp_file}" _have)
    string(STRIP "${_have}" _have)
    if(_have STREQUAL _stamp_text)
        message(STATUS "drums: up to date in ${DST} (${_stamp_text})")
        return()
    endif()
endif()

file(REMOVE_RECURSE "${DST}")
file(MAKE_DIRECTORY "${DST}")
file(COPY ${_drums} DESTINATION "${DST}")
file(WRITE "${_stamp_file}" "${_stamp_text}")
message(STATUS "drums: bundled ${_count} file(s) (${_bytes} bytes) -> ${DST}")
