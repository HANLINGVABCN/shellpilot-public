#!/usr/bin/env bash
set -euo pipefail
arch=${1:-aarch64};abi=arm64-v8a;target=aarch64-linux-android
if test "$arch" = x86_64; then abi=x86_64;target=x86_64-linux-android; fi
mkdir -p "runtime-build/android-$arch";work=$(realpath "runtime-build/android-$arch");mkdir -p "$work"/src "$work"/jni/lib/"$abi" "$work"/assets "$work"/classes
toolchain="$ANDROID_NDK_HOME/toolchains/llvm/prebuilt/linux-x86_64/bin"
export CC="$toolchain/${target}26-clang" AR="$toolchain/llvm-ar" LD="$CC" STRIP="$toolchain/llvm-strip" OBJCOPY="$toolchain/llvm-objcopy" OBJDUMP="$toolchain/llvm-objdump"
curl -fL --retry 4 https://www.samba.org/ftp/talloc/talloc-2.5.0.tar.gz -o "$work/talloc.tar.gz"
printf '912afa237510ae542a7733998eb18a12bcda35ab6729c8e2ddb43e8d0ebab007  %s/talloc.tar.gz\n' "$work" | sha256sum --check
tar -xzf "$work/talloc.tar.gz" -C "$work/src"
pushd "$work/src/talloc-2.5.0"
cat > answers <<'ANSWERS'
Checking uname sysname type: "Linux"
Checking uname machine type: "dontcare"
Checking uname release type: "dontcare"
Checking uname version type: "dontcare"
Checking simple C program: OK
building library support: OK
Checking for large file support: OK
Checking for -D_FILE_OFFSET_BITS=64: OK
Checking for WORDS_BIGENDIAN: OK
Checking for C99 vsnprintf: OK
Checking for HAVE_SECURE_MKSTEMP: OK
rpath library support: OK
-Wl,--version-script support: FAIL
Checking correct behaviour of strtoll: OK
Checking correct behaviour of strptime: OK
Checking for HAVE_IFACE_GETIFADDRS: OK
Checking for HAVE_IFACE_IFCONF: OK
Checking for HAVE_IFACE_IFREQ: OK
Checking getconf LFS_CFLAGS: OK
Checking for large file support without additional flags: OK
Checking for working strptime: OK
Checking for HAVE_SHARED_MMAP: OK
Checking for HAVE_MREMAP: OK
Checking for HAVE_INCOHERENT_MMAP: OK
Checking getconf large file support flags work: OK
ANSWERS
./configure --prefix="$work/talloc" --disable-python --disable-rpath --cross-compile --cross-answers=answers
make -j2
find bin/default -name 'talloc*.o' -print0 | xargs -0 "$AR" rcs "$work/libtalloc.a"
cp talloc.h "$work/"
popd
curl -fL --retry 4 https://github.com/termux/proot/archive/v5.1.107.102.zip -o "$work/proot.zip"
printf '30d12a6e2cc4147123756ff58edea262d3083bbc238c12d0ab9b39e3d1c40852  %s/proot.zip\n' "$work" | sha256sum --check
unzip -q "$work/proot.zip" -d "$work/src"
python3 scripts/patch-proot-network.py "$work/src/proot-5.1.107.102"
export PROOT_UNBUNDLE_LOADER=/system
make -C "$work/src/proot-5.1.107.102/src" -j2 CC="$CC" LD="$CC" STRIP="$STRIP" OBJCOPY="$OBJCOPY" OBJDUMP="$OBJDUMP" CPPFLAGS="-DARG_MAX=131072 -D_FILE_OFFSET_BITS=64 -D_GNU_SOURCE -I$work -I. -DVERSION=\"5.1.107.102\"" LDFLAGS="$work/libtalloc.a -Wl,-z,noexecstack -Wl,-z,max-page-size=16384"
cp "$work/src/proot-5.1.107.102/src/proot" "$work/jni/lib/$abi/libproot_exec.so"
cp "$work/src/proot-5.1.107.102/src/loader/loader" "$work/jni/lib/$abi/libproot_loader.so"
curl -fL --retry 4 "https://dl-cdn.alpinelinux.org/alpine/v3.24/releases/$arch/alpine-minirootfs-3.24.4-$arch.tar.gz" -o "$work/assets/rootfs.tar.gz"
digest=4b14c18f7e90a063b61462ea1462a5732c154bf6adad594974fe6487cd98a8de
if test "$arch" = x86_64;then digest=cdaa38cb8de3537967ee5b6c9b6cd00cc962da2b018e6eea48696bb274923012;fi
printf '%s  %s/assets/rootfs.tar.gz\n' "$digest" "$work"|sha256sum --check
sdk="$ANDROID_HOME/platforms/android-35/android.jar";build="$ANDROID_HOME/build-tools/35.0.0"
javac -source 8 -target 8 -bootclasspath "$sdk" -d "$work/classes" runtime/android/RuntimeService.java
"$build/d8" --lib "$sdk" --min-api 26 --output "$work" $(find "$work/classes" -name '*.class')
"$build/aapt2" link -I "$sdk" --manifest runtime/android/AndroidManifest.xml -A "$work/assets" -o "$work/base.apk"
cp "$work/base.apk" "$work/unsigned.apk"
(cd "$work" && zip -q unsigned.apk classes.dex)
(cd "$work/jni" && zip -qr "$work/unsigned.apk" lib)
"$build/zipalign" -P 16 -f 4 "$work/unsigned.apk" "$work/aligned.apk"
"$build/apksigner" sign --ks "$SIGNING_KEY_PATH" --ks-key-alias shellpilot --ks-pass env:KEYSTORE_PASSWORD --key-pass env:KEYSTORE_PASSWORD --out "runtime-build/ShellPilot-Linux-Android-$arch.apk" "$work/aligned.apk"
"$build/apksigner" verify --print-certs "runtime-build/ShellPilot-Linux-Android-$arch.apk" | tee "$work/certificate.txt"
grep -F "certificate SHA-256 digest: $CERT_SHA256" "$work/certificate.txt"
tar -czf "runtime-build/ShellPilot-Linux-Android-$arch-sources.tar.gz" -C "$work/src" .
