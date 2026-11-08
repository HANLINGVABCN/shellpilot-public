import fs from 'node:fs';
const svg=fs.readFileSync('public/shellpilot.svg','utf8');
const color=svg.match(/<rect\b[^>]*\bfill="(#[0-9A-Fa-f]{6})"/)[1];
const file='src-tauri/icons/android/values/ic_launcher_background.xml';
fs.mkdirSync('src-tauri/icons/android/values',{recursive:true});
fs.writeFileSync(file,`<?xml version="1.0" encoding="utf-8"?>\n<resources>\n  <color name="ic_launcher_background">${color}</color>\n</resources>\n`);
console.log('Android adaptive icon background:',color);
