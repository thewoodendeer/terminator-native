# Every third-party dependency is pinned here via FetchContent. Nothing is downloaded by hand.
# Bump = change the GIT_TAG, rebuild all presets, run the tests, one commit.
include(FetchContent)
set(FETCHCONTENT_QUIET OFF)
set(FETCHCONTENT_UPDATES_DISCONNECTED ON)   # never re-fetch a pinned tag on reconfigure

# --- JUCE 9.0.1 (Starter licence, free ≤ $20k revenue — see docs/native/BUILD-RULES.md) ---------
FetchContent_Declare(JUCE
    GIT_REPOSITORY https://github.com/juce-framework/JUCE.git
    GIT_TAG        9.0.1
    GIT_SHALLOW    TRUE
    GIT_PROGRESS   TRUE)
set(JUCE_BUILD_EXAMPLES OFF CACHE BOOL "" FORCE)
set(JUCE_BUILD_EXTRAS   OFF CACHE BOOL "" FORCE)
set(JUCE_ENABLE_MODULE_SOURCE_GROUPS OFF CACHE BOOL "" FORCE)  # ON makes JUCE compile per-file — keep unity builds
FetchContent_MakeAvailable(JUCE)

# --- Catch2 v3 -----------------------------------------------------------------------------------
if(TERMINATOR_BUILD_TESTS)
    FetchContent_Declare(Catch2
        GIT_REPOSITORY https://github.com/catchorg/Catch2.git
        GIT_TAG        v3.8.1
        GIT_SHALLOW    TRUE)
    set(CATCH_INSTALL_DOCS OFF CACHE BOOL "" FORCE)
    set(CATCH_INSTALL_EXTRAS OFF CACHE BOOL "" FORCE)
    FetchContent_MakeAvailable(Catch2)
    list(APPEND CMAKE_MODULE_PATH "${catch2_SOURCE_DIR}/extras")
endif()

# --- Windows: ASIO SDK (Steinberg licence forbids redistribution → fetched in CI / by the dev) ---
set(TERMINATOR_HAS_ASIO OFF)
if(WIN32 AND TERMINATOR_ASIO_SDK_DIR)
    if(EXISTS "${TERMINATOR_ASIO_SDK_DIR}/common/iasiodrv.h")
        set(TERMINATOR_HAS_ASIO ON)
        message(STATUS "ASIO SDK found at ${TERMINATOR_ASIO_SDK_DIR} — JUCE_ASIO=1")
    else()
        message(WARNING "TERMINATOR_ASIO_SDK_DIR set but common/iasiodrv.h not found — building WITHOUT ASIO")
    endif()
endif()
