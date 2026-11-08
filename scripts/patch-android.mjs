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
