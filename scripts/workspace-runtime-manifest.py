import pathlib,json,hashlib,subprocess,sys
directory=pathlib.Path(sys.argv[1]);tag=sys.argv[2];repo='HANLINGVABCN/shellpilot-public'
manifest=json.load(open('runtime/manifest.json',encoding='utf-8'))
old_version=manifest['version'];manifest['version']=tag.removeprefix('linux-')
for key in ('windows-qemu','windows-guest'):
    manifest['packages'][key]['version']=manifest['packages'][key].get('version',old_version)
release=json.loads(subprocess.check_output(['gh','api',f'repos/{repo}/releases/tags/{tag}']))
assets={asset['name']:asset for asset in release['assets']}
for key,arch in [('android-arm64','aarch64'),('android-x86_64','x86_64')]:
    file=directory/f'ShellPilot-Linux-Android-{arch}.apk';asset=assets[file.name]
    manifest['packages'][key]={'file':file.name,'bytes':file.stat().st_size,'expandedBytes':file.stat().st_size+1048576,'sha256':hashlib.sha256(file.read_bytes()).hexdigest(),'version':manifest['version'],'urls':[asset['browser_download_url'],asset['url']]}
(directory/'runtime-manifest.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
