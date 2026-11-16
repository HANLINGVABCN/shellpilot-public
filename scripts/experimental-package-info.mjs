import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
import assert from 'node:assert/strict';

const root=path.resolve('release-experimental');
const sha256=data=>crypto.createHash('sha256').update(data).digest('hex');
const sourceCommit=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();
const sourceRepository=execFileSync('git',['remote','get-url','origin'],{encoding:'utf8'}).trim().replace(/\.git$/,'');
assert.equal(sourceRepository,'https://github.com/HANLINGVABCN/shellpilot-public');
const frontend=fs.readdirSync('dist/assets').filter(name=>/^index-.*\.(js|css)$/.test(name)).map(name=>{
  const bytes=fs.readFileSync(path.join('dist/assets',name));
  return {name,bytes:bytes.length,sha256:sha256(bytes)};
});
assert(frontend.some(item=>item.name.endsWith('.js')) && frontend.some(item=>item.name.endsWith('.css')));
const apk=path.join(root,'android/ShellPilot-arm64.apk');
const portable=path.join(root,'windows/ShellPilot-portable.zip');
const probe="import json,struct,sys,zipfile\nmarkers=[name.encode() for name in json.loads(sys.argv[3])]\nwith zipfile.ZipFile(sys.argv[2]) as z:exe=z.read('ShellPilot.exe')\npe=int.from_bytes(exe[0x3c:0x40],'little')\nassert exe[pe:pe+4]==b'PE\\0\\0' and int.from_bytes(exe[pe+4:pe+6],'little')==0x8664\nassert all(name in exe for name in markers),'Windows内置资源与本次前端不一致'\nchecked=[]\nwith zipfile.ZipFile(sys.argv[1]) as z:\n    assert 'AndroidManifest.xml' in z.namelist() and 'resources.arsc' in z.namelist()\n    for name in z.namelist():\n        if not name.startswith('lib/arm64-v8a/') or not name.endswith('.so'):continue\n        data=z.read(name)\n        assert data[:4]==b'\\x7fELF' and data[4]==2 and int.from_bytes(data[18:20],'little')==183,name\n        phoff=int.from_bytes(data[32:40],'little');entsize=int.from_bytes(data[54:56],'little');count=int.from_bytes(data[56:58],'little')\n        aligns=[]\n        for i in range(count):\n            p=phoff+i*entsize\n            if int.from_bytes(data[p:p+4],'little')==1:\n                align=int.from_bytes(data[p+48:p+56],'little');assert align>=16384,name+'缺少16KB页支持';aligns.append(align)\n        checked.append({'name':name,'loadSegmentAlignments':aligns})\n    assert checked\n    assert any(all(marker in z.read(item['name']) for marker in markers) for item in checked),'APK内置资源与本次前端不一致'\nprint(json.dumps({'windowsArchitecture':'x64','androidArchitecture':'arm64-v8a','embeddedFrontendMatches':True,'androidLibraries':checked}))";
const verification=JSON.parse(execFileSync('python3',['-c',probe,apk,portable,JSON.stringify(frontend.map(item=>item.name))],{encoding:'utf8'}));
const packages=[];
for(const platform of ['windows','android']) {
  for(const name of fs.readdirSync(path.join(root,platform))) {
    if(!/\.(exe|apk|zip|cer)$/.test(name))continue;
    const file=path.join(root,platform,name),bytes=fs.readFileSync(file);
    packages.push({platform,name,bytes:bytes.length,sha256:sha256(bytes)});
  }
}
const certificateSha256=sha256(fs.readFileSync(path.join(root,'android/ShellPilot-android.cer')));
assert.equal(certificateSha256,'77c676dffaa6efd13a504529dcc52abd5634469e3a41d6f067dbf49bb85b95b3');
const windowsReuse=fs.existsSync(path.join(root,'windows-reuse.json')) ? JSON.parse(fs.readFileSync(path.join(root,'windows-reuse.json'),'utf8')) : null;
const cargoLockSha256=sha256(fs.readFileSync('src-tauri/Cargo.lock'));
const androidReuse=fs.existsSync(path.join(root,'android-reuse.json')) ? JSON.parse(fs.readFileSync(path.join(root,'android-reuse.json'),'utf8')) : null;
const info={sourceRepository,sourceCommit,identifier:'app.shellpilot.client',version:'1.0.0',certificateSha256,cargoLockSha256,frontend,verification,packages,...(windowsReuse ? {windowsReuse} : {}),...(androidReuse ? {androidReuse} : {})};
fs.writeFileSync(path.join(root,'build-info.json'),JSON.stringify(info,null,2)+'\n');
fs.writeFileSync(path.join(root,'SHA256SUMS.txt'),packages.map(item=>item.sha256+'  '+item.platform+'/'+item.name).join('\n')+'\n');
console.log(JSON.stringify(info));
