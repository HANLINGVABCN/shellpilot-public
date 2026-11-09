import fs from 'fs';
import path from 'path';

const androidRoot = path.resolve('src-tauri/gen/android');
const appBuildGradle = path.join(androidRoot, 'app/build.gradle.kts');
const manifestXml = path.join(androidRoot, 'app/src/main/AndroidManifest.xml');
const resXmlDir = path.join(androidRoot, 'app/src/main/res/xml');
const netSecFile = path.join(resXmlDir, 'network_security_config.xml');
const srcIconsDir = path.resolve('src-tauri/icons/android');
const dstResDir = path.join(androidRoot, 'app/src/main/res');

console.log('--- Configuring Android for Cleartext HTTP traffic & ShellPilot Icons ---');

// 1. Patch build.gradle.kts to set usesCleartextTraffic = true for release
if (fs.existsSync(appBuildGradle)) {
  let gradle = fs.readFileSync(appBuildGradle, 'utf8');
  gradle = gradle.replace(
    /manifestPlaceholders\["usesCleartextTraffic"\]\s*=\s*"false"/g,
    'manifestPlaceholders["usesCleartextTraffic"] = "true"'
  );
  fs.writeFileSync(appBuildGradle, gradle);
  console.log('✓ Patched build.gradle.kts: usesCleartextTraffic set to true for release');
} else {
  console.warn('build.gradle.kts not found at', appBuildGradle);
}

// 2. Create network_security_config.xml permitting 127.0.0.1 and localhost
fs.mkdirSync(resXmlDir, { recursive: true });
const netSecXml = `<?xml version="1.0" encoding="utf-8"?>
<network-security-config>
    <base-config cleartextTrafficPermitted="true">
        <trust-anchors>
            <certificates src="system" />
        </trust-anchors>
    </base-config>
    <domain-config cleartextTrafficPermitted="true">
        <domain includeSubdomains="true">127.0.0.1</domain>
        <domain includeSubdomains="true">localhost</domain>
    </domain-config>
</network-security-config>
`;
fs.writeFileSync(netSecFile, netSecXml);
console.log('✓ Created res/xml/network_security_config.xml');

// 3. Patch AndroidManifest.xml
if (fs.existsSync(manifestXml)) {
  let manifest = fs.readFileSync(manifestXml, 'utf8');
  
  // Replace android:usesCleartextTraffic="${usesCleartextTraffic}" or add it directly
  if (manifest.includes('android:usesCleartextTraffic=')) {
    manifest = manifest.replace(
      /android:usesCleartextTraffic="[^"]*"/g,
      'android:usesCleartextTraffic="true"'
    );
  } else {
    manifest = manifest.replace(
      /<application/g,
      '<application android:usesCleartextTraffic="true"'
    );
  }

  // Add networkSecurityConfig if not already present
  if (!manifest.includes('android:networkSecurityConfig=')) {
    manifest = manifest.replace(
      /<application/g,
      '<application android:networkSecurityConfig="@xml/network_security_config"'
    );
  }

  fs.writeFileSync(manifestXml, manifest);
  console.log('✓ Patched AndroidManifest.xml: added usesCleartextTraffic and networkSecurityConfig');
} else {
  console.warn('AndroidManifest.xml not found at', manifestXml);
}

// 4. Copy ShellPilot official icons into app/src/main/res (overwriting Tauri default sample icons)
if (fs.existsSync(srcIconsDir) && fs.existsSync(dstResDir)) {
  fs.cpSync(srcIconsDir, dstResDir, { recursive: true, force: true });
  console.log('✓ Synchronized official ShellPilot icons from src-tauri/icons/android to app/src/main/res');
} else {
  console.warn('Icons directory not found:', { srcIconsDir, dstResDir });
}

console.log('--- Android cleartext & icon configuration completed successfully ---');

// A signature-protected companion owns the Linux files and PRoot process.
const javaRoot=path.join(androidRoot,'app/src/main/java/app/shellpilot/client');
fs.mkdirSync(javaRoot,{recursive:true});
fs.copyFileSync('runtime/android/WorkspaceBridge.kt',path.join(javaRoot,'WorkspaceBridge.kt'));
const mainFile=path.join(javaRoot,'MainActivity.kt');
if(fs.existsSync(mainFile)){
 let source=fs.readFileSync(mainFile,'utf8');
 if(!source.includes('fun workspaceRuntime'))source=source.replace('class MainActivity : TauriActivity() {','class MainActivity : TauriActivity() {\n  @androidx.annotation.Keep\n  fun workspaceRuntime(request: String): String = WorkspaceBridge.request(this, request)\n');
 else if(!source.includes('@androidx.annotation.Keep'))source=source.replace('fun workspaceRuntime','@androidx.annotation.Keep\n  fun workspaceRuntime');
 if(!source.includes('external fun registerWorkspaceBridge'))source=source.replace('class MainActivity : TauriActivity() {','class MainActivity : TauriActivity() {\n  private external fun registerWorkspaceBridge()\n').replace('super.onCreate(savedInstanceState)','super.onCreate(savedInstanceState)\n    registerWorkspaceBridge()');
 if(!source.includes('WorkspaceBridge.result'))source=source.replace('class MainActivity : TauriActivity() {','class MainActivity : TauriActivity() {\n  override fun onActivityResult(requestCode:Int, resultCode:Int, data:android.content.Intent?){ super.onActivityResult(requestCode,resultCode,data); WorkspaceBridge.result(this,requestCode,resultCode,data) }\n');
 if(!source.includes('fun workspaceRuntime')||!source.includes('registerWorkspaceBridge()'))throw new Error('Android activity template changed; workspace bridge was not inserted');
 fs.writeFileSync(mainFile,source);
}
let appManifest=fs.readFileSync(manifestXml,'utf8');
if(!appManifest.includes('app.shellpilot.workspace.ACCESS'))appManifest=appManifest.replace(/<application/,`<uses-permission android:name="app.shellpilot.workspace.ACCESS"/><uses-permission android:name="android.permission.REQUEST_INSTALL_PACKAGES"/><queries><package android:name="app.shellpilot.workspace"/></queries>\n<application`);
if(!appManifest.includes('workspace-files'))appManifest=appManifest.replace('</application>',`<provider android:name="androidx.core.content.FileProvider" android:authorities="app.shellpilot.client.workspace-files" android:exported="false" android:grantUriPermissions="true"><meta-data android:name="android.support.FILE_PROVIDER_PATHS" android:resource="@xml/workspace_files"/></provider></application>`);
fs.writeFileSync(manifestXml,appManifest);
fs.writeFileSync(path.join(resXmlDir,'workspace_files.xml'),'<paths xmlns:android="http://schemas.android.com/apk/res/android"><files-path name="linux-installer" path="linux-runtime/"/></paths>');
const rules=path.join(androidRoot,'app/proguard-rules.pro');
let keep=fs.existsSync(rules)?fs.readFileSync(rules,'utf8'):'';
if(!keep.includes('workspaceRuntime'))keep+='\n-keepclassmembers class app.shellpilot.client.MainActivity { public java.lang.String workspaceRuntime(java.lang.String); private native void registerWorkspaceBridge(); }\n';
fs.writeFileSync(rules,keep);
