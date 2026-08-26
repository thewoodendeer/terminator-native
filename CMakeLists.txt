# Terminator 3.0 — native build (C++20 + JUCE 9.0.1)
# Layout: engine/ (libterminator) · app/ (JUCE shell + WebView) · tools/ (CLIs) · tests/ (Catch2) · docs/native/
# Build rules: docs/native/BUILD-RULES.md   RT rules: docs/native/RT-RULES.md
cmake_minimum_required(VERSION 3.28)

project(TerminatorNative
    VERSION 3.0.0
    DESCRIPTION "Terminator 3.0 — native sampler / DAW"
    LANGUAGES C CXX)

set(TERMINATOR_VERSION_STRING "3.0.0-alpha.0" CACHE STRING "Human version (semver with pre-release tag)")

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)
set(CMAKE_EXPORT_COMPILE_COMMANDS ON)
set(CMAKE_POSITION_INDEPENDENT_CODE ON)

if(NOT CMAKE_BUILD_TYPE AND NOT CMAKE_CONFIGURATION_TYPES)
    set(CMAKE_BUILD_TYPE Release CACHE STRING "" FORCE)
endif()

# --- options -----------------------------------------------------------------
option(TERMINATOR_BUILD_APP   "Build the JUCE shell app (Terminator)"          ON)
option(TERMINATOR_BUILD_TOOLS "Build the CLIs (terminator-render)"             ON)
option(TERMINATOR_BUILD_TESTS "Build the Catch2 tests"                         ON)
option(TERMINATOR_STEMS       "Native stem separation (fetches the pinned onnxruntime)" ON)
option(TERMINATOR_UPDATER     "In-app updates (macOS: fetches the pinned Sparkle)"      ON)
option(TERMINATOR_WARNINGS_AS_ERRORS "Treat warnings as errors in our targets" ON)
option(TERMINATOR_ENABLE_RTSAN      "-fsanitize=realtime (needs LLVM 20+ clang; NOT combinable with ASan)" OFF)
option(TERMINATOR_ENABLE_ASAN_UBSAN "-fsanitize=address,undefined"             OFF)
set(TERMINATOR_ASIO_SDK_DIR "" CACHE PATH "Windows: path to the Steinberg ASIO SDK (fetched in CI, never committed)")

if(TERMINATOR_ENABLE_RTSAN AND TERMINATOR_ENABLE_ASAN_UBSAN)
    message(FATAL_ERROR "RTSan cannot be combined with ASan/UBSan (clang refuses). Pick one preset.")
endif()

if(APPLE AND NOT CMAKE_OSX_DEPLOYMENT_TARGET)
    set(CMAKE_OSX_DEPLOYMENT_TARGET "12.0" CACHE STRING "" FORCE)
endif()

list(APPEND CMAKE_MODULE_PATH "${CMAKE_CURRENT_SOURCE_DIR}/cmake")
include(Dependencies)
include(Onnxruntime)
include(Sparkle)
include(Warnings)
include(Sanitizers)

# JUCE targets inherit these (see docs/CMake API.md "COMPANY_NAME" note)
set_directory_properties(PROPERTIES JUCE_COMPANY_NAME "Killavic Cheat Codes")
set_directory_properties(PROPERTIES JUCE_COMPANY_WEBSITE "https://killaviccheatcodes.app")

add_subdirectory(engine)
if(TERMINATOR_ORT_FOUND)
    add_subdirectory(stems)
endif()
if(TERMINATOR_BUILD_TOOLS)
    add_subdirectory(tools/terminator-render)
    if(TERMINATOR_ORT_FOUND)
        add_subdirectory(tools/terminator-stems)
    endif()
endif()
if(TERMINATOR_BUILD_APP)
    add_subdirectory(app)
endif()
if(TERMINATOR_BUILD_TESTS)
    enable_testing()
    add_subdirectory(tests)
endif()

message(STATUS "Terminator ${TERMINATOR_VERSION_STRING} · ${CMAKE_BUILD_TYPE} · ${CMAKE_CXX_COMPILER_ID} ${CMAKE_CXX_COMPILER_VERSION}"
               " · arch=${CMAKE_OSX_ARCHITECTURES}${CMAKE_SYSTEM_PROCESSOR}"
               " · app=${TERMINATOR_BUILD_APP} tools=${TERMINATOR_BUILD_TOOLS} tests=${TERMINATOR_BUILD_TESTS}"
               " · rtsan=${TERMINATOR_ENABLE_RTSAN} asan=${TERMINATOR_ENABLE_ASAN_UBSAN} stems=${TERMINATOR_ORT_FOUND}")
