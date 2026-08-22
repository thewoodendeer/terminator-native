# terminator_set_warnings(<target>) — strict warnings (+ -Werror / /WX) on OUR source files only.
# JUCE module sources are compiled inside our targets too (INTERFACE_SOURCES), so a target-wide
# target_compile_options() would subject JUCE itself to -Wconversion/-Werror. We set COMPILE_OPTIONS on
# the target's own listed sources instead.
if(MSVC)
    set(TERMINATOR_WARNING_FLAGS
        /W4 /permissive- /Zc:__cplusplus /utf-8
        /wd4100  # unreferenced formal parameter (JUCE virtuals)
        /wd4458  # declaration hides class member (JUCE headers)
        $<$<BOOL:${TERMINATOR_WARNINGS_AS_ERRORS}>:/WX>)
else()
    set(TERMINATOR_WARNING_FLAGS
        -Wall -Wextra -Wpedantic -Wshadow -Wconversion -Wsign-conversion -Wdouble-promotion
        -Wnon-virtual-dtor -Woverloaded-virtual -Wcast-align -Wunused -Wnull-dereference
        -Wno-unused-parameter
        $<$<BOOL:${TERMINATOR_WARNINGS_AS_ERRORS}>:-Werror>)
    if(CMAKE_CXX_COMPILER_ID MATCHES "Clang")
        # Function-effects analysis ([[clang::nonblocking]]) — a WARNING, not an error: libm calls on the
        # RT thread are fine in practice and the runtime gate is RTSan. See docs/native/RT-RULES.md.
        include(CheckCXXCompilerFlag)
        check_cxx_compiler_flag(-Wfunction-effects TERMINATOR_HAS_WFUNCTION_EFFECTS)
        if(TERMINATOR_HAS_WFUNCTION_EFFECTS)
            list(APPEND TERMINATOR_WARNING_FLAGS -Wfunction-effects -Wno-error=function-effects)
        endif()
        # LLVM 22+ -Wpedantic flags __COUNTER__ (used by Catch2's TEST_CASE) as a C2y extension
        check_cxx_compiler_flag(-Wno-c2y-extensions TERMINATOR_HAS_WNO_C2Y)
        if(TERMINATOR_HAS_WNO_C2Y)
            list(APPEND TERMINATOR_WARNING_FLAGS -Wno-c2y-extensions)
        endif()
    endif()
endif()

function(terminator_set_warnings target)
    get_target_property(srcs ${target} SOURCES)
    set(ours "")
    foreach(s IN LISTS srcs)
        get_filename_component(abs "${s}" ABSOLUTE BASE_DIR "${CMAKE_CURRENT_SOURCE_DIR}")
        if(abs MATCHES "\\.(cpp|cc|cxx|mm|m)$" AND abs MATCHES "^${PROJECT_SOURCE_DIR}/")
            list(APPEND ours "${abs}")
        endif()
    endforeach()
    if(ours)
        set_source_files_properties(${ours} TARGET_DIRECTORY ${target}
            PROPERTIES COMPILE_OPTIONS "${TERMINATOR_WARNING_FLAGS}")
    endif()
endfunction()
