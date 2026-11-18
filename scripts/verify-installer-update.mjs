import assert from 'node:assert/strict';
import fs from 'node:fs';

const template=fs.readFileSync('src-tauri/installer.nsi','utf8');
const page=template.match(/Function PageReinstall\r?\n([\s\S]*?)FunctionEnd/)?.[1];
const leave=template.match(/Function PageLeaveReinstall\r?\n([\s\S]*?)FunctionEnd/)?.[1];
assert(page&&leave,'Installer maintenance functions missing');
const comparison=page.indexOf('nsis_tauri_utils::SemverCompare');
const direct=page.match(/\$WixMode = 0\s+\$\{AndIf\} \$R0 <> -1\s+StrCpy \$DirectInstall 1\s+Abort/);
assert(direct&&direct.index>comparison&&direct.index<page.indexOf('nsDialogs::Create'),'Normal upgrades must skip maintenance before creating any uninstall controls');
assert(leave.trimStart().startsWith('${If} $DirectInstall = 1\n    Return\n  ${EndIf}')||leave.trimStart().startsWith('${If} $DirectInstall = 1\r\n    Return\r\n  ${EndIf}'),'Direct install cannot fall through to the old uninstaller');
assert(template.includes('Call RestorePreviousInstallLocation'),'Updates must retain the previous install directory');
const install=template.match(/Section Install\r?\n([\s\S]*?)SectionEnd/)?.[1];
assert(install?.includes('File "${MAINBINARYSRCPATH}"'),'Direct updates must still install the application executable');
assert(!install.includes('RmDir /r')&&!install.includes('RMDir /r'),'Installing must not recursively delete data');
console.log('PASS: normal updates/reinstalls skip uninstall selection, direct leave avoids uninstaller, previous directory and file installation retained');
