"""调整 ARM64 静态 PRoot 加载器的 ELF 文件布局，保留地址和机器码。"""
import hashlib
from pathlib import Path
import struct
import sys

PAGE = 16384


def align_loader(original):
    assert original[:5] == b"\x7fELF\x02" and original[5] == 1, "需要小端 ELF64 加载器"
    assert struct.unpack_from("<H", original, 16)[0] == 2, "只处理静态 ET_EXEC 加载器"
    assert struct.unpack_from("<H", original, 18)[0] == 183, "16KB 页布局只应用于 ARM64 加载器"
    phoff = struct.unpack_from("<Q", original, 32)[0]
    shoff = struct.unpack_from("<Q", original, 40)[0]
    phsize, phcount, shsize, shcount = struct.unpack_from("<HHHH", original, 54)
    loads = []
    for index in range(phcount):
        position = phoff + index * phsize
        fields = struct.unpack_from("<IIQQQQQQ", original, position)
        if fields[0] == 1:
            loads.append((position, fields))
    assert loads and len(loads) == 2 and loads[0][1][2] == 0, "加载器布局与预期不符"
    split = loads[1][1][2]
    assert split > phoff + phsize * phcount, "程序头必须在首段内"
    assert all(fields[3] % PAGE == 0 for _, fields in loads), "加载地址不在 16KB 边界"
    padding = (-split) % PAGE
    result = bytearray(original[:split] + bytes(padding) + original[split:])
    if shoff >= split:
        struct.pack_into("<Q", result, 40, shoff + padding)
    for index in range(phcount):
        position = phoff + index * phsize
        offset = struct.unpack_from("<Q", original, position + 8)[0]
        if offset >= split:
            struct.pack_into("<Q", result, position + 8, offset + padding)
        if struct.unpack_from("<I", original, position)[0] == 1:
            struct.pack_into("<Q", result, position + 48, PAGE)
    new_shoff = shoff + padding if shoff >= split else shoff
    for index in range(shcount):
        old_position = shoff + index * shsize
        position = new_shoff + index * shsize
        offset = struct.unpack_from("<Q", original, old_position + 24)[0]
        if offset >= split:
            struct.pack_into("<Q", result, position + 24, offset + padding)
    entry = struct.unpack_from("<Q", original, 24)[0]
    assert entry == struct.unpack_from("<Q", result, 24)[0], "入口地址发生变化"
    code_verified = False
    for position, fields in loads:
        offset, address, file_size = fields[2], fields[3], fields[5]
        new_offset = struct.unpack_from("<Q", result, position + 8)[0]
        assert new_offset % PAGE == address % PAGE, "文件映射未按 16KB 对齐"
        if address <= entry < address + file_size:
            assert offset >= split, "入口机器码不能位于需要改写的文件头"
            assert original[offset:offset + file_size] == result[new_offset:new_offset + file_size], "机器码发生变化"
            code_verified = True
    assert code_verified, "没有验证入口机器码"
    return bytes(result), {
        "originalSha256": hashlib.sha256(original).hexdigest(),
        "sha256": hashlib.sha256(result).hexdigest(),
        "entryAddress": entry, "machineCodeUnchanged": True,
        "addedPaddingBytes": padding, "pageAlignment": PAGE,
    }


if __name__ == "__main__":
    import json
    report = []
    for directory in Path(sys.argv[1]).iterdir():
        if directory.name != "arm64-v8a":
            continue
        file = directory / "libproot_loader.so"
        if not file.is_file():
            continue
        result, record = align_loader(file.read_bytes())
        file.write_bytes(result)
        report.append({"abi": directory.name, **record})
    if (Path(sys.argv[1]) / "arm64-v8a").is_dir():
        assert report, "ARM64 工作区加载器缺失"
    print(json.dumps(report))
