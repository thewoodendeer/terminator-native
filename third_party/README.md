# third_party/

All pinned dependencies are fetched by CMake FetchContent (see `cmake/Dependencies.cmake`) into
`build/<preset>/_deps/` — nothing is vendored here. This directory is the drop point for SDKs that cannot
be redistributed (Steinberg ASIO SDK → `third_party/asiosdk*/`, gitignored) when building Windows locally.
