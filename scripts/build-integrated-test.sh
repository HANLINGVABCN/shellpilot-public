#!/usr/bin/env bash
set -euo pipefail
work=runtime-build/integrated-test;mkdir -p "$work/classes"
sdk="$ANDROID_HOME/platforms/android-35/android.jar";tools="$ANDROID_HOME/build-tools/35.0.0"
javac --release 8 -classpath "$sdk" -d "$work/classes" runtime/android/IntegratedRuntimeTest.java
"$tools/d8" --lib "$sdk" --min-api 26 --output "$work" $(find "$work/classes" -name '*.class')
"$tools/aapt2" link -I "$sdk" --manifest runtime/android/IntegratedTestManifest.xml -o "$work/test.apk"
(cd "$work" && zip -q test.apk classes.dex)
"$tools/zipalign" -f 4 "$work/test.apk" "$work/aligned.apk"
"$tools/apksigner" sign --ks "$SIGNING_KEY_PATH" --ks-key-alias shellpilot --ks-pass env:KEYSTORE_PASSWORD --key-pass env:KEYSTORE_PASSWORD --out "$work/signed.apk" "$work/aligned.apk"
