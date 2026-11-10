import fs from 'node:fs';import path from 'node:path';import {execFileSync} from 'node:child_process';import {createHash} from 'node:crypto';
if(process.env.GITHUB_ACTIONS!=='true')throw Error('Prepare Android native binaries only in GitHub builds');
const destination=path.resolve('src-tauri/gen/android/app/src/main/jniLibs');fs.mkdirSync(destination,{recursive:true});
const source=process.env.SHELLPILOT_NATIVE_DIR||'runtime-build/embedded';fs.mkdirSync(source,{recursive:true});
const manifestFile=process.env.SHELLPILOT_NATIVE_DIR?path.join(source,'native-manifest.json'):'runtime/native-manifest.json';
const manifest=JSON.parse(fs.readFileSync(manifestFile,'utf8'));
for(const[arch,abi]of [['aarch64','arm64-v8a'],['x86_64','x86_64']]){
 const packageInfo=manifest.packages[arch];if(!packageInfo)continue;const archive=path.join(source,packageInfo.file);
 if(!fs.existsSync(archive))execFileSync('gh',['release','download',manifest.tag,'--repo','HANLINGVABCN/shellpilot-public','--pattern',packageInfo.file,'--dir',source],{stdio:'inherit'});
 const bytes=fs.readFileSync(archive);if(bytes.length!==packageInfo.bytes||createHash('sha256').update(bytes).digest('hex')!==packageInfo.sha256)throw Error('Android native runtime checksum mismatch');
 const temp=path.join(source,'unpack-'+arch);fs.mkdirSync(temp,{recursive:true});execFileSync('tar',['-xzf',archive,'-C',temp]);
 for(const name of ['libproot_exec.so','libproot_loader.so','libterminal_exec.so']){
  const input=path.join(temp,'lib',abi,name);if(!fs.existsSync(input)||fs.lstatSync(input).isSymbolicLink())throw Error('Trusted Android executable missing');
  fs.mkdirSync(path.join(destination,abi),{recursive:true});fs.copyFileSync(input,path.join(destination,abi,name));
 }
}
console.log('Verified PRoot and PTY binaries embedded into main APK; no extra Android application');
