"""使用已解析的 Tauri 依赖生成当前安卓工程的框架文件。"""
import hashlib
import json
import os
from pathlib import Path
import subprocess


def main():
    metadata = json.loads(subprocess.check_output([
        "cargo", "metadata", "--format-version", "1", "--locked", "--offline",
        "--filter-platform", "aarch64-linux-android",
        "--manifest-path", "src-tauri/Cargo.toml",
    ], text=True))
    package = next(item for item in metadata["packages"] if item["name"] == "tauri")
    source = Path(package["manifest_path"]).parent
    output = Path(os.environ["WRY_ANDROID_KOTLIN_FILES_OUT_DIR"])
    project = Path(os.environ["TAURI_ANDROID_PROJECT_PATH"])
    output.mkdir(parents=True, exist_ok=True)
    values = {
        "{{package}}": os.environ["WRY_ANDROID_PACKAGE"],
        "{{library}}": os.environ["WRY_ANDROID_LIBRARY"],
        "$PACKAGE": os.environ["TAURI_ANDROID_PACKAGE_UNESCAPED"],
    }
    files = [(file, output / file.name) for file in (source / "mobile/android-codegen").glob("*.kt")]
    files.append((source / "mobile/proguard-tauri.pro", project / "app/proguard-tauri.pro"))
    assert any(target.name == "TauriActivity.kt" for _, target in files), "Tauri 依赖缺少 Activity 模板"
    report = []
    for original, target in files:
        content = original.read_text()
        for before, after in values.items():
            content = content.replace(before, after)
        data = content.encode()
        if not target.exists() or target.read_bytes() != data:
            target.write_bytes(data)
        report.append({"file": target.name, "sha256": hashlib.sha256(data).hexdigest()})
    print(json.dumps({"tauri": package["version"], "generated": report}))


if __name__ == "__main__":
    main()
