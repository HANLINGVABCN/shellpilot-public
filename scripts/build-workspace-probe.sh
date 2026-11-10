#!/usr/bin/env bash
set -euo pipefail
test "${GITHUB_ACTIONS:-}" = true
toolchain="$ANDROID_NDK_HOME/toolchains/llvm/prebuilt/linux-x86_64/bin"
target=x86_64-linux-android;abi=x86_64
if test "${1:-x86_64}" = aarch64;then target=aarch64-linux-android;abi=arm64-v8a;fi
output="src-tauri/gen/android/app/src/main/jniLibs/$abi"
mkdir -p "$output"
"$toolchain/${target}26-clang" -O2 -static -Wl,-z,max-page-size=16384 runtime/android/workspace_boundary_probe.c -o "$output/libworkspace_boundary_probe.so"
