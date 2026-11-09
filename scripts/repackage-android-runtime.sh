#!/usr/bin/env bash
set -euo pipefail
arch=${1:?architecture}; source=${2:?verified existing APK}
work="$PWD/runtime-build/repackage-$arch"
mkdir -p "$work/classes" "$work/assets" "$work/jni"
unzip -q "$source" 'assets/*' 'lib/*' -d "$work/original"
cp -R "$work/original/assets/." "$work/assets/"
cp -R "$work/original/lib" "$work/jni/"
sdk="$ANDROID_HOME/platforms/android-35/android.jar"; build="$ANDROID_HOME/build-tools/35.0.0"
javac --release 8 -classpath "$sdk" -d "$work/classes" runtime/android/RuntimeService.java
"$build/d8" --lib "$sdk" --min-api 26 --output "$work" $(find "$work/classes" -name '*.class')
"$build/aapt2" link -I "$sdk" --manifest runtime/android/AndroidManifest.xml -A "$work/assets" -o "$work/unsigned.apk"
(cd "$work" && zip -q unsigned.apk classes.dex)
(cd "$work/jni" && zip -qr "$work/unsigned.apk" lib)
"$build/zipalign" -P 16 -f 4 "$work/unsigned.apk" "$work/aligned.apk"
"$build/apksigner" sign --ks "$SIGNING_KEY_PATH" --ks-key-alias shellpilot --ks-pass env:KEYSTORE_PASSWORD --key-pass env:KEYSTORE_PASSWORD --out "runtime-build/ShellPilot-Linux-Android-$arch.apk" "$work/aligned.apk"
"$build/apksigner" verify --print-certs "runtime-build/ShellPilot-Linux-Android-$arch.apk" > "$work/certificate.txt"
grep -F "certificate SHA-256 digest: $CERT_SHA256" "$work/certificate.txt"
python3 - "$source" "runtime-build/ShellPilot-Linux-Android-$arch.apk" <<'PY'
import sys,zipfile,hashlib
with zipfile.ZipFile(sys.argv[1]) as old,zipfile.ZipFile(sys.argv[2]) as new:
    for path in old.namelist():
        if path.startswith(('lib/','assets/')) and not path.endswith('/'):
            assert hashlib.sha256(old.read(path)).digest()==hashlib.sha256(new.read(path)).digest(),path
print('PASS: fixed native executables and Alpine archive reused without rebuilding')
PY
tar -czf "runtime-build/ShellPilot-Linux-Android-$arch-service-sources.tar.gz" runtime/android/RuntimeService.java runtime/android/AndroidManifest.xml scripts/repackage-android-runtime.sh
