#!/usr/bin/env bash
set -euo pipefail
export PATH=/opt/shellpilot-build/tools/cargo/bin:/opt/shellpilot-build/tools/node/bin:$PATH
export CARGO_HOME=/opt/shellpilot-build/tools/cargo
export RUSTUP_HOME=/opt/shellpilot-build/tools/rustup
export CARGO_TARGET_DIR=/opt/shellpilot-build/runner/_work/shellpilot/shellpilot/src-tauri/target
export CARGO_BUILD_JOBS=2
export JAVA_HOME=/usr/lib/jvm/java-17-openjdk-arm64
export ANDROID_HOME=/opt/shellpilot-build/android-sdk
export ANDROID_NDK_HOME=/opt/shellpilot-build/android-sdk/ndk/27.0.12077973
export CI=true
stage=$1
out="$PWD/release-experimental"
mkdir -p "$out/windows" "$out/android"
node - <<'JS'
const {execFileSync}=require('node:child_process');
const fs=require('node:fs');
const expected='https://github.com/HANLINGVABCN/shellpilot-public';
const origin=execFileSync('git',['remote','get-url','origin'],{encoding:'utf8'}).trim().replace(/\.git$/,'');
if(origin!==expected)throw Error('安装包源码不属于指定公开仓库');
if(process.env.GITHUB_REPOSITORY!=='HANLINGVABCN/shellpilot-public')throw Error('构建任务来自错误仓库');
if(execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim()!==process.env.GITHUB_SHA)throw Error('源码提交与任务不一致');
if(JSON.parse(fs.readFileSync('src-tauri/tauri.conf.json')).identifier!=='app.shellpilot.client')throw Error('应用标识不属于公开版');
JS

case "$stage" in
  prepare)
    test -d /opt/shellpilot-build/approved-ui-7881b25/node_modules
    ln -s /opt/shellpilot-build/approved-ui-7881b25/node_modules node_modules
    npm test
    node scripts/verify-brand.mjs
    npm run build
    ;;
  windows)
    if test -n "${SHELLPILOT_REUSE_WINDOWS_RUNNER:-}"; then
      python3 scripts/reuse-windows-package.py
      exit 0
    fi
    unset RUSTFLAGS
    nice -n 10 npm run tauri -- build --runner cargo-xwin --target x86_64-pc-windows-msvc --bundles nsis
    installer="$CARGO_TARGET_DIR/x86_64-pc-windows-msvc/release/bundle/nsis/ShellPilot_1.0.0_x64-setup.exe"
    test -f "$installer"
    cp "$installer" "$out/windows/ShellPilot-Windows-Setup.exe"
    cp "$CARGO_TARGET_DIR/x86_64-pc-windows-msvc/release/shellpilot-app.exe" "$out/windows/ShellPilot.exe"
    python3 - <<'PY'
import os,pathlib,struct,zipfile
out=pathlib.Path('release-experimental/windows')
exe=(out/'ShellPilot.exe').read_bytes()
pe=int.from_bytes(exe[0x3c:0x40],'little')
assert exe[pe:pe+4]==b'PE\0\0' and int.from_bytes(exe[pe+4:pe+6],'little')==0x8664,'Windows程序不是x64'
assets=[p.name.encode() for p in pathlib.Path('dist/assets').glob('index-*.js')]
assert assets and all(marker in exe for marker in assets),'Windows程序缺少本次前端资源'
target=pathlib.Path(os.environ['CARGO_TARGET_DIR'])
for loader in target.rglob('WebView2Loader.dll'):
 data=loader.read_bytes();offset=int.from_bytes(data[0x3c:0x40],'little')
 if int.from_bytes(data[offset+4:offset+6],'little')==0x8664:
  (out/'WebView2Loader.dll').write_bytes(data);break
with zipfile.ZipFile(out/'ShellPilot-portable.zip','w',zipfile.ZIP_DEFLATED) as archive:
 for name in ['ShellPilot.exe','WebView2Loader.dll']:
  if (out/name).exists():archive.write(out/name,name)
PY
    rm -f "$out/windows/ShellPilot.exe" "$out/windows/WebView2Loader.dll"
    ;;
  android)
    if test -n "${SHELLPILOT_REUSE_ANDROID_RUNNER:-}"; then
      python3 scripts/reuse-android-package.py
      exit 0
    fi
    export RUSTFLAGS='-C link-arg=-Wl,-z,max-page-size=16384'
    npm run tauri -- android init
    mkdir -p build/experimental runtime-build/native
    cat > build/experimental/aapt2.sh <<'SH'
#!/bin/sh
exec /usr/bin/qemu-x86_64 -L /opt/shellpilot-build/x86-runtime/root -0 aapt2 /opt/shellpilot-build/android-sdk/build-tools/36.0.0/aapt2 "$@"
SH
    chmod 700 build/experimental/aapt2.sh
    python3 - <<'PY'
import hashlib,json,pathlib,urllib.request
manifest=json.loads(pathlib.Path('runtime/native-manifest.json').read_text())
cache=pathlib.Path('runtime-build/native');cache.mkdir(parents=True,exist_ok=True)
(cache/'native-manifest.json').write_text(json.dumps(manifest))
for info in manifest['packages'].values():
 file=cache/info['file']
 if not file.exists():
  url='https://github.com/HANLINGVABCN/shellpilot-public/releases/download/'+manifest['tag']+'/'+info['file']
  with urllib.request.urlopen(url,timeout=120) as response:file.write_bytes(response.read())
 data=file.read_bytes()
 assert len(data)==info['bytes'] and hashlib.sha256(data).hexdigest()==info['sha256'],'固定安卓运行器校验失败'
props=pathlib.Path('src-tauri/gen/android/gradle.properties')
props.write_text(props.read_text()+'\nandroid.aapt2FromMavenOverride='+str(pathlib.Path('build/experimental/aapt2.sh').resolve())+'\norg.gradle.workers.max=2\norg.gradle.parallel=false\n')
PY
    SHELLPILOT_NATIVE_DIR="$PWD/runtime-build/native" node scripts/prepare-android-workspace.mjs
    node scripts/patch-android.mjs
    export WRY_ANDROID_PACKAGE=app.shellpilot.client
    export WRY_ANDROID_LIBRARY=shellpilot_app_lib
    export WRY_ANDROID_KOTLIN_FILES_OUT_DIR="$PWD/src-tauri/gen/android/app/src/main/java/app/shellpilot/client/generated"
    export TAURI_ANDROID_PROJECT_PATH="$PWD/src-tauri/gen/android"
    export TAURI_ANDROID_PACKAGE_UNESCAPED=app.shellpilot.client
    mkdir -p "$WRY_ANDROID_KOTLIN_FILES_OUT_DIR"
    # 当前工程直接使用所选 Tauri 依赖的官方模板，不依赖旧缓存里的生成目录。
    python3 scripts/prepare-android-codegen.py
    nice -n 10 npm run tauri -- android build --apk --target aarch64
    python3 - <<'PY'
import pathlib,zipfile
root=pathlib.Path('src-tauri/gen/android/app/build')
source=next(p for p in (root/'outputs/apk').rglob('*.apk') if 'release' in str(p).lower())
dest=pathlib.Path('release-experimental/android/ShellPilot-arm64-unsigned.apk')
with zipfile.ZipFile(source) as archive:
 resources=None
 if 'AndroidManifest.xml' not in archive.namelist() or 'resources.arsc' not in archive.namelist():
  resources=next((p for p in root.rglob('*.ap_') if 'shrunk-resources-binary-format' in p.name),None)
  assert resources,'本次构建缺少可用的二进制安卓资源'
 with zipfile.ZipFile(dest,'w',zipfile.ZIP_DEFLATED) as output:
  for item in archive.infolist():output.writestr(item,archive.read(item.filename))
  if resources:
   with zipfile.ZipFile(resources) as compiled:
    for item in compiled.infolist():
     if item.filename not in archive.namelist():output.writestr(item,compiled.read(item.filename))
with zipfile.ZipFile(dest) as archive:
 assert 'AndroidManifest.xml' in archive.namelist() and 'resources.arsc' in archive.namelist()
 libs=[name for name in archive.namelist() if name.startswith('lib/arm64-v8a/') and name.endswith('.so')]
 assert libs and any(any(p.name.encode() in archive.read(name) for p in pathlib.Path('dist/assets').glob('index-*.js')) for name in libs),'APK缺少本次前端'
PY
    ;;
  sign)
    test -n "$SIGNING_KEY_B64" && test -n "$KEYSTORE_PASSWORD" && test -n "$CERT_SHA256"
    umask 077
    key="$RUNNER_TEMP/shellpilot-public-signing.p12"
    cert="$RUNNER_TEMP/shellpilot-public-cert.cer"
    trap 'rm -f "$key" "$cert"' EXIT
    printf '%s' "$SIGNING_KEY_B64" | base64 --decode > "$key"
    keytool -exportcert -keystore "$key" -alias shellpilot -storepass:env KEYSTORE_PASSWORD -file "$cert"
    test "$(sha256sum "$cert" | cut -d ' ' -f1)" = "$CERT_SHA256"
    tools="$ANDROID_HOME/build-tools/35.0.0"
    "$tools/zipalign" -P 16 -f 4 "$out/android/ShellPilot-arm64-unsigned.apk" "$out/android/ShellPilot-arm64-aligned.apk"
    "$tools/apksigner" sign --ks "$key" --ks-key-alias shellpilot --ks-pass env:KEYSTORE_PASSWORD --key-pass env:KEYSTORE_PASSWORD --out "$out/android/ShellPilot-arm64.apk" "$out/android/ShellPilot-arm64-aligned.apk"
    "$tools/apksigner" verify --verbose --print-certs "$out/android/ShellPilot-arm64.apk" > "$out/android/android-signature.txt"
    grep -F "certificate SHA-256 digest: $CERT_SHA256" "$out/android/android-signature.txt"
    "$tools/zipalign" -c -P 16 4 "$out/android/ShellPilot-arm64.apk"
    "$tools/aapt2" dump badging "$out/android/ShellPilot-arm64.apk" > "$out/android/android-package-info.txt"
    grep -F "package: name='app.shellpilot.client'" "$out/android/android-package-info.txt"
    grep -F "application-label:'ShellPilot'" "$out/android/android-package-info.txt"
    cp "$cert" "$out/android/ShellPilot-android.cer"
    rm -f "$out/android/ShellPilot-arm64-unsigned.apk" "$out/android/ShellPilot-arm64-aligned.apk"
    ;;
  info)
    node scripts/experimental-package-info.mjs
    ;;
  *) exit 2 ;;
esac
