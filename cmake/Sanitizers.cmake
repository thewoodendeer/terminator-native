# Sanitizer presets. RTSan needs an LLVM 20+ clang (Apple clang does NOT ship it — brew install llvm).
# RTSan and ASan/UBSan are mutually exclusive (clang: "'-fsanitize=realtime' not allowed with
# '-fsanitize=address,undefined'") → two presets: mac-rtsan and mac-asan-ubsan.
include(CheckCXXSourceCompiles)

if(TERMINATOR_ENABLE_RTSAN)
    # The flag must be present at compile AND link time for the probe (the rtsan runtime is linked in).
    set(CMAKE_REQUIRED_FLAGS "-fsanitize=realtime")
    set(CMAKE_REQUIRED_LIBRARIES "-fsanitize=realtime")   # lands on the probe's LINK line (LINK_OPTIONS does not, reliably)
    check_cxx_source_compiles("int main() { return 0; }" TERMINATOR_HAS_RTSAN)
    unset(CMAKE_REQUIRED_FLAGS)
    unset(CMAKE_REQUIRED_LIBRARIES)
    if(NOT TERMINATOR_HAS_RTSAN)
        message(FATAL_ERROR "TERMINATOR_ENABLE_RTSAN=ON but this compiler has no -fsanitize=realtime. "
                            "Use Homebrew LLVM: -DCMAKE_CXX_COMPILER=/opt/homebrew/opt/llvm/bin/clang++ (preset mac-rtsan).")
    endif()
    add_compile_options(-fsanitize=realtime -fno-omit-frame-pointer)
    add_link_options(-fsanitize=realtime)
    add_compile_definitions(TERMINATOR_RTSAN=1)
    message(STATUS "RealtimeSanitizer ON")
endif()

if(TERMINATOR_ENABLE_ASAN_UBSAN)
    add_compile_options(-fsanitize=address,undefined -fno-omit-frame-pointer -fno-sanitize-recover=undefined)
    add_link_options(-fsanitize=address,undefined)
    add_compile_definitions(TERMINATOR_ASAN=1)
    message(STATUS "ASan + UBSan ON")
endif()
