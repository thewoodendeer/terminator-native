# cmake -DSRC=<dir> -DDST=<dir> -P CopyDirIfExists.cmake — mirror SRC into DST when SRC/index.html exists, else
# remove a stale DST (so an app built after `rm -rf ui/dist` does not keep serving yesterday's UI). Used by
# app/CMakeLists.txt to bundle ui/dist into the app after every build.
if(EXISTS "${SRC}/index.html")
    file(REMOVE_RECURSE "${DST}")
    file(COPY "${SRC}/" DESTINATION "${DST}")
    message(STATUS "ui: bundled ${SRC} -> ${DST}")
else()
    if(EXISTS "${DST}")
        file(REMOVE_RECURSE "${DST}")
    endif()
    message(STATUS "ui: ${SRC} not built — the app serves the embedded static page")
endif()
