import test from 'node:test';
import assert from 'node:assert/strict';
import { terminalKey, modifiedTerminalInput } from '../src/terminalKeys.js';
import { isAndroidDevice } from '../src/android.js';

test('安卓平台独立启用布局，Windows 和 iOS 保持原界面', () => {
  assert.equal(isAndroidDevice('Mozilla/5.0 (Linux; Android 14; Pixel 7) Mobile'), true);
  assert.equal(isAndroidDevice('Mozilla/5.0 (Linux; Android 13; Tablet)'), true);
  assert.equal(isAndroidDevice('Mozilla/5.0 (Windows NT 10.0; Win64; x64)'), false);
  assert.equal(isAndroidDevice('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0)'), false);
});

test('Ctrl 字母发送 shell 和终端编辑器所需的控制字符', () => {
  for (let value = 1; value <= 26; value++) {
    assert.equal(terminalKey(String.fromCharCode(64 + value), { ctrl: true }), String.fromCharCode(value));
    assert.equal(terminalKey(String.fromCharCode(96 + value), { ctrl: true }), String.fromCharCode(value));
  }
  assert.equal(terminalKey('C', { ctrl: true }), '\x03'); // 中断前台进程
  assert.equal(terminalKey('D', { ctrl: true }), '\x04'); // EOF
  assert.equal(terminalKey('Z', { ctrl: true }), '\x1a'); // 挂起前台进程
  assert.equal(terminalKey('[', { ctrl: true }), '\x1b'); // 编辑器退出插入模式
  assert.equal(terminalKey(' ', { ctrl: true }), '\0');
});

test('Esc、Tab、Enter、删除和翻页发送正确的终端序列', () => {
  for (const [key, expected] of [
    ['Escape', '\x1b'], ['Tab', '\t'], ['Enter', '\r'], ['Backspace', '\x7f'],
    ['Delete', '\x1b[3~'], ['Insert', '\x1b[2~'], ['PageUp', '\x1b[5~'], ['PageDown', '\x1b[6~']
  ]) assert.equal(terminalKey(key), expected, key);
});

test('方向键与 Home、End 兼容普通 shell 和 vim 的应用模式', () => {
  for (const [key, suffix] of [['ArrowUp', 'A'], ['ArrowDown', 'B'], ['ArrowRight', 'C'], ['ArrowLeft', 'D'], ['Home', 'H'], ['End', 'F']]) {
    assert.equal(terminalKey(key), '\x1b[' + suffix);
    assert.equal(terminalKey(key, { applicationCursor: true }), '\x1bO' + suffix);
  }
  assert.equal(terminalKey('ArrowLeft', { ctrl: true }), '\x1b[1;5D');
  assert.equal(terminalKey('ArrowRight', { ctrl: true, alt: true }), '\x1b[1;7C');
});

test('F1–F12 和带修饰键的功能键支持终端应用', () => {
  const expected = ['\x1bOP', '\x1bOQ', '\x1bOR', '\x1bOS', '\x1b[15~', '\x1b[17~', '\x1b[18~', '\x1b[19~', '\x1b[20~', '\x1b[21~', '\x1b[23~', '\x1b[24~'];
  expected.forEach((data, index) => assert.equal(terminalKey('F' + (index + 1)), data));
  assert.equal(terminalKey('F1', { ctrl: true }), '\x1b[1;5P');
  assert.equal(terminalKey('F12', { alt: true }), '\x1b[24;3~');
});

test('一次性修饰键处理键盘输入，同时保留整段输入法和粘贴内容', () => {
  assert.equal(modifiedTerminalInput('c', { ctrl: true }), '\x03');
  assert.equal(modifiedTerminalInput('f', { alt: true }), '\x1bf');
  assert.equal(modifiedTerminalInput('\x1bOA', { ctrl: true }), '\x1b[1;5A');
  assert.equal(modifiedTerminalInput('一个完整的输入法词组', { ctrl: true }), '一个完整的输入法词组');
  assert.equal(modifiedTerminalInput('ls -la\n', { alt: true }), 'ls -la\n');
  assert.equal(modifiedTerminalInput('正常输入', {}), '正常输入');
});
