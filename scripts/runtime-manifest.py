import pathlib,json,hashlib,tarfile,subprocess,sys
directory=pathlib.Path(sys.argv[1]);tag=sys.argv[2];repo='HANLINGVABCN/shellpilot-public'
release=json.loads(subprocess.check_output(['gh','api',f'repos/{repo}/releases/tags/{tag}']))
assets={asset['name']:asset for asset in release['assets']}
names={'windows-qemu':'ShellPilot-QEMU-Windows.tar.gz','windows-guest':'ShellPilot-Linux-Guest.tar.gz','android-arm64':'ShellPilot-Linux-Android-aarch64.apk','android-x86_64':'ShellPilot-Linux-Android-x86_64.apk'}
manifest={'version':'alpine-3.24.4-v1','packages':{}}
for key,name in names.items():
    file=directory/name
    digest=hashlib.sha256(file.read_bytes()).hexdigest()
    expanded=file.stat().st_size
    if name.endswith('.tar.gz'):
        with tarfile.open(file) as archive:expanded=sum(member.size for member in archive if member.isfile())
    manifest['packages'][key]={'file':name,'bytes':file.stat().st_size,'expandedBytes':expanded+1048576,'sha256':digest,'urls':[assets[name]['browser_download_url'],f'https://api.github.com/repos/{repo}/releases/assets/{assets[name]["id"]}']}
(directory/'runtime-manifest.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2)+'\n',encoding='utf8')
print(json.dumps({key:package['bytes'] for key,package in manifest['packages'].items()}))
