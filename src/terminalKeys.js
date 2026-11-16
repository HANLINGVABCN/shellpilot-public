const ESC = '\x1b';
const cursorKeys = { ArrowUp: 'A', ArrowDown: 'B', ArrowRight: 'C', ArrowLeft: 'D', Home: 'H', End: 'F' };
const tildeKeys = { Insert: 2, Delete: 3, PageUp: 5, PageDown: 6, F5: 15, F6: 17, F7: 18, F8: 19, F9: 20, F10: 21, F11: 23, F12: 24 };
const functionKeys = { F1: 'P', F2: 'Q', F3: 'R', F4: 'S' };
const plainKeys = { Escape: ESC, Tab: '\t', Enter: '\r', Backspace: '\x7f' };

// 与 xterm 键盘协议一致；vim 等应用模式下方向键使用 SS3。
export function terminalKey(key, { ctrl = false, alt = false, applicationCursor = false } = {}) {
  const modifier = 1 + (alt ? 2 : 0) + (ctrl ? 4 : 0);
  if (cursorKeys[key]) {
    if (modifier > 1) return `${ESC}[1;${modifier}${cursorKeys[key]}`;
    return `${ESC}${applicationCursor ? 'O' : '['}${cursorKeys[key]}`;
  }
  if (functionKeys[key]) {
    return modifier > 1 ? `${ESC}[1;${modifier}${functionKeys[key]}` : `${ESC}O${functionKeys[key]}`;
  }
  if (tildeKeys[key]) return `${ESC}[${tildeKeys[key]}${modifier > 1 ? ';' + modifier : ''}~`;
  let data = plainKeys[key] ?? key;
  if (ctrl && data.length === 1) {
    const controlAliases = { ' ': 0, '2': 0, '3': 27, '4': 28, '5': 29, '6': 30, '7': 31, '8': 127, '?': 127 };
    if (Object.hasOwn(controlAliases, data)) data = String.fromCharCode(controlAliases[data]);
    else if (/^[a-z@\[\\\]\^_]$/i.test(data)) data = String.fromCharCode(data.toUpperCase().charCodeAt(0) & 31);
  }
  return alt ? ESC + data : data;
}

// 输入法可能一次提交一整个词或一段粘贴；只对单键施加一次性修饰键。
export function modifiedTerminalInput(data, modifiers) {
  if (!modifiers.ctrl && !modifiers.alt) return data;
  if (data.length === 1) return terminalKey(data, modifiers);
  const cursor = data.match(/^\x1b(?:\[|O)([ABCDHF])$/);
  if (cursor) return terminalKey(Object.keys(cursorKeys).find((key) => cursorKeys[key] === cursor[1]), modifiers);
  return data;
}
