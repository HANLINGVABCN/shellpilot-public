import fs from 'node:fs';
const svg=fs.readFileSync('public/shellpilot.svg','utf8');
const color=svg.match(/<rect\b[^>]*\bfill="(#[0-9A-Fa-f]{6})"/)[1];
const file='src-tauri/icons/android/values/ic_launcher_background.xml';
fs.mkdirSync('src-tauri/icons/android/values',{recursive:true});
fs.writeFileSync(file,`<?xml version="1.0" encoding="utf-8"?>\n<resources>\n  <color name="ic_launcher_background">${color}</color>\n</resources>\n`);
console.log('Android adaptive icon background:',color);

// Android 的 108dp 前景会裁到约 72dp；保留 1/6 留白，避免图案比桌面图标放大。
const adaptive=`<?xml version="1.0" encoding="utf-8"?>\n<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">\n  <foreground>\n    <inset android:drawable="@mipmap/ic_launcher_foreground" android:inset="16.6667%"/>\n  </foreground>\n  <background android:drawable="@color/ic_launcher_background"/>\n</adaptive-icon>\n`;
const adaptiveDir='src-tauri/icons/android/mipmap-anydpi-v26';
fs.mkdirSync(adaptiveDir,{recursive:true});
for(const name of ['ic_launcher.xml','ic_launcher_round.xml'])fs.writeFileSync(`${adaptiveDir}/${name}`,adaptive);
console.log('Android launcher foreground inset: 16.6667% on every edge');
