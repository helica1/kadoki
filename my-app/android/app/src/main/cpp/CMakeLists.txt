cmake_minimum_required(VERSION 3.22)
project(whisperjni C CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

# Static ggml+whisper linked into the single libwhisperjni.so this target
# produces — one small .so in the APK, no shared-lib dance.
set(BUILD_SHARED_LIBS OFF)
set(WHISPER_BUILD_TESTS OFF CACHE BOOL "" FORCE)
set(WHISPER_BUILD_EXAMPLES OFF CACHE BOOL "" FORCE)
set(WHISPER_BUILD_SERVER OFF CACHE BOOL "" FORCE)
set(GGML_OPENMP OFF CACHE BOOL "" FORCE)

# armv8.2-a+dotprod+fp16 makes quantized (q5) inference several times faster
# than generic armv8-a. Requires a 2018+ arm64 SoC (Cortex-A75/A55 era or
# newer); older devices would SIGILL inside whisper, which checkAvailability
# cannot detect — accepted tradeoff, revisit if a report ever comes in.
set(GGML_CPU_ARM_ARCH "armv8.2-a+dotprod+fp16" CACHE STRING "" FORCE)

# AGP compiles the Debug variant's native code at -O0, which makes whisper
# 10-20x slower than realtime (device-verified: >2 min per 30 s window on a
# Snapdragon 8 Gen 3). Inference must ALWAYS be optimized, debug APK or not.
set(CMAKE_C_FLAGS_DEBUG "-O3 -DNDEBUG")
set(CMAKE_CXX_FLAGS_DEBUG "-O3 -DNDEBUG")

add_subdirectory(whisper.cpp EXCLUDE_FROM_ALL)

add_library(whisperjni SHARED whisper_jni.cpp)
target_link_libraries(whisperjni whisper log)
