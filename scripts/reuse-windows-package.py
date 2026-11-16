"""只在两份 Windows 源码完全相同时复用已完成的安装文件。"""
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import zipfile


def git(directory, *args):
    return subprocess.check_output(["git", "-C", str(directory), *args], text=True).strip()


def windows_sources(directory):
    result = {}
    for line in git(directory, "ls-tree", "-r", "HEAD").splitlines():
        details, name = line.split("\t", 1)
        relevant = name.startswith(("src/", "public/", "server-rs/", "src-tauri/"))
        relevant = relevant or name in {"index.html", "package.json", "package-lock.json", "vite.config.mjs"}
        if relevant and not name.startswith("src-tauri/icons/android/"):
            result[name] = details.split()[2]
    return result


def main():
    runner = os.environ["SHELLPILOT_REUSE_WINDOWS_RUNNER"]
    assert re.fullmatch(r"shellpilot-public-ui-\d{8}-[a-f0-9]{8}", runner), "无效的旧构建运行器"
    directory = Path("/opt/shellpilot-build") / runner.replace("shellpilot-public-ui-", "public-ui-runner-", 1)
    source = directory / "_work/shellpilot-public/shellpilot-public"
    current = Path.cwd()
    assert git(source, "remote", "get-url", "origin").removesuffix(".git") == "https://github.com/HANLINGVABCN/shellpilot-public"
    previous = windows_sources(source)
    assert previous and previous == windows_sources(current), "Windows 源码有变化，不能复用旧安装包"
    packages = source / "release-experimental/windows"
    portable = packages / "ShellPilot-portable.zip"
    with zipfile.ZipFile(portable) as archive:
        executable = archive.read("ShellPilot.exe")
    markers = [file.name.encode() for file in (current / "dist/assets").glob("index-*.js")]
    assert markers and all(marker in executable for marker in markers), "旧安装包界面不是本次正式前端"
    output = current / "release-experimental/windows"
    report = []
    for name in ["ShellPilot-Windows-Setup.exe", "ShellPilot-portable.zip"]:
        data = (packages / name).read_bytes()
        assert data, "旧构建安装文件为空"
        if "--verify-only" not in sys.argv:
            shutil.copyfile(packages / name, output / name)
        report.append({"name": name, "sha256": hashlib.sha256(data).hexdigest(), "bytes": len(data)})
    record = {"sourceCommit": git(source, "rev-parse", "HEAD"), "windowsSourcesIdentical": True, "packages": report}
    if "--verify-only" not in sys.argv:
        (current / "release-experimental/windows-reuse.json").write_text(json.dumps(record, indent=2))
    print(json.dumps(record))


if __name__ == "__main__":
    main()
