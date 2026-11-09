"""Collect one QEMU emulator and its transitive DLL dependencies from MSYS2."""
import pathlib, subprocess, re, shutil, tarfile, sys
prefix=pathlib.Path(sys.argv[1])/'ucrt64'
dest=pathlib.Path('runtime-build/qemu');dest.mkdir(parents=True,exist_ok=True)
pending=[prefix/'bin/qemu-system-x86_64.exe'];copied=set()
while pending:
    source=pending.pop()
    if source.name.lower() in copied:continue
    copied.add(source.name.lower());shutil.copy2(source,dest/source.name)
    output=subprocess.check_output([str(prefix/'bin/objdump.exe'),'-p',str(source)],text=True)
    for name in re.findall(r'DLL Name:\s+(\S+)',output):
        library=prefix/'bin'/name
        if library.is_file():pending.append(library)
firmware=prefix/'share/qemu'
for name in ['bios-256k.bin','vgabios-stdvga.bin','kvmvapic.bin','efi-e1000.rom']:
    source=firmware/name
    if source.is_file():shutil.copy2(source,dest/name)
for directory in (prefix/'share/licenses').glob('*qemu*'):
    shutil.copytree(directory,dest/'licenses'/directory.name,dirs_exist_ok=True)
shutil.copytree(prefix/'share/licenses',dest/'dependency-licenses',dirs_exist_ok=True)
with tarfile.open('runtime-build/ShellPilot-QEMU-Windows.tar.gz','w:gz') as archive:
    for file in dest.rglob('*'):
        if file.is_file():archive.add(file,arcname=file.relative_to(dest),recursive=False)
print('Collected',len(copied),'runtime binaries')
