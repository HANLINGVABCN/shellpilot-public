"""复用同一应用源码的 APK，只调整已验证的静态加载器文件布局。"""
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import zipfile
from importlib.util import module_from_spec, spec_from_file_location

spec = spec_from_file_location("loader_alignment", Path(__file__).with_name("align-static-loader.py"))
alignment = module_from_spec(spec)
spec.loader.exec_module(alignment)


def git(directory, *args):
    return subprocess.check_output(["git", "-C", str(directory), *args], text=True).strip()


def application_sources(directory):
    result = {}
    for line in git(directory, "ls-tree", "-r", "HEAD").splitlines():
        details, name = line.split("\t", 1)
        if name.startswith(("src/", "public/", "server-rs/", "src-tauri/", "runtime/")) or name in {"package.json", "package-lock.json", "index.html", "vite.config.mjs"}:
            result[name] = details.split()[2]
    result["src-tauri/Cargo.lock"] = hashlib.sha256((Path(directory) / "src-tauri/Cargo.lock").read_bytes()).hexdigest()
    return result


def main():
    runner = os.environ["SHELLPILOT_REUSE_ANDROID_RUNNER"]
    assert re.fullmatch(r"shellpilot-public-ui-\d{8}-[a-f0-9]{8}", runner)
    source = Path("/opt/shellpilot-build") / runner.replace("shellpilot-public-ui-", "public-ui-runner-", 1) / "_work/shellpilot-public/shellpilot-public"
    current = Path.cwd()
    assert git(source, "remote", "get-url", "origin").removesuffix(".git") == "https://github.com/HANLINGVABCN/shellpilot-public"
    assert application_sources(source) == application_sources(current), "应用源码有变化，不能复用 APK"
    package = source / "release-experimental/android/ShellPilot-arm64.apk"
    tools = "/opt/shellpilot-build/android-sdk/build-tools/35.0.0"
    signature = subprocess.check_output([tools + "/apksigner", "verify", "--print-certs", str(package)], text=True)
    assert "certificate SHA-256 digest: 77c676dffaa6efd13a504529dcc52abd5634469e3a41d6f067dbf49bb85b95b3" in signature, "旧 APK 的公开版签名不符"
    output = current / "release-experimental/android/ShellPilot-arm64-unsigned.apk"
    report = []
    markers = [file.name.encode() for file in (current / "dist/assets").glob("index-*.js")]
    with zipfile.ZipFile(package) as archive, zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED) as destination:
        assert all(marker in archive.read("lib/arm64-v8a/libshellpilot_app_lib.so") for marker in markers), "APK 界面不属于本次源码"
        for item in archive.infolist():
            if re.match(r"META-INF/(?:MANIFEST\.MF|[^/]+\.(?:SF|RSA|DSA|EC))$", item.filename, re.I):
                continue
            data = archive.read(item.filename)
            if item.filename == "lib/arm64-v8a/libproot_loader.so":
                data, record = alignment.align_loader(data)
                report.append({"file": item.filename, **record})
            destination.writestr(item, data)
    assert report, "APK 缺少需要调整的静态加载器"
    record = {"sourceCommit": git(source, "rev-parse", "HEAD"), "applicationSourcesIdentical": True,
              "inputApkSha256": hashlib.sha256(package.read_bytes()).hexdigest(), "loaderAlignment": report}
    (current / "release-experimental/android-reuse.json").write_text(json.dumps(record, indent=2))
    print(json.dumps(record))


if __name__ == "__main__":
    main()
