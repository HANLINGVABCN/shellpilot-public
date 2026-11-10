import pathlib,json,hashlib,sys
root=pathlib.Path(sys.argv[1]);manifest=json.load(open('runtime/manifest.json'))
manifest['version']='alpine-3.24.4-integrated-v1';native={'tag':'linux-alpine-3.24.4-integrated-v1','packages':{}}
for arch,key in [('aarch64','android-arm64'),('x86_64','android-x86_64')]:
    file=root/f'ShellPilot-Linux-Android-{arch}.tar.gz';binary=root/f'ShellPilot-Android-Native-{arch}.tar.gz'
    manifest['packages'][key]={'file':file.name,'bytes':file.stat().st_size,'expandedBytes':128*1024*1024,'sha256':hashlib.sha256(file.read_bytes()).hexdigest(),'version':manifest['version'],'urls':[f'https://dl-cdn.alpinelinux.org/alpine/v3.24/releases/{arch}/alpine-minirootfs-3.24.4-{arch}.tar.gz']}
    native['packages'][arch]={'file':binary.name,'bytes':binary.stat().st_size,'sha256':hashlib.sha256(binary.read_bytes()).hexdigest()}
pathlib.Path('runtime/manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')
(root/'native-manifest.json').write_text(json.dumps(native,indent=2)+'\n')
