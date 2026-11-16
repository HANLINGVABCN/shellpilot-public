import React, { useState } from 'react';

const arrows = [
  { key: 'ArrowLeft', label: '←', name: '向左' }, { key: 'ArrowDown', label: '↓', name: '向下' },
  { key: 'ArrowUp', label: '↑', name: '向上' }, { key: 'ArrowRight', label: '→', name: '向右' }
];
const extended = [
  ['Home', 'Home'], ['End', 'End'], ['PageUp', 'PgUp'], ['PageDown', 'PgDn'], ['Delete', 'Del'], ['Insert', 'Ins'],
  ...Array.from({ length: 12 }, (_, index) => ['F' + (index + 1), 'F' + (index + 1)]),
  ...['|', '~', '\\', '-', '_', ':'].map((key) => [key, key])
];
const controlLetters = ['A', 'C', 'D', 'E', 'K', 'L', 'R', 'U', 'W', 'Z', '[', ' '];

export default function TerminalKeyboard({ modifiers, keyboardOpen, onKey, onModifier, onKeyboard, onAction, onFontSize, actions=['搜索', '粘贴', '清屏', '重连'] }) {
  const [expanded, setExpanded] = useState(false);
  // 按键不抢走 xterm 的输入焦点，连续点按时软键盘保持原状。
  const keepFocus = (event) => event.preventDefault();
  const keyButton = (key, label, name = label) => (
    <button key={key} type="button" className="terminal-key" aria-label={name}
      onPointerDown={keepFocus} onClick={() => onKey(key)}>{label}</button>
  );

  return (
    <div className="terminal-keyboard" aria-label="终端特殊按键">
      {(modifiers.ctrl || modifiers.alt) && (
        <div className="terminal-modifiers">
          <span>{[modifiers.ctrl && 'Ctrl', modifiers.alt && 'Alt'].filter(Boolean).join(' + ')} 已就绪 · 对下一个按键生效</span>
          <button type="button" onPointerDown={keepFocus} onClick={() => onModifier('clear')}>取消</button>
        </div>
      )}
      {modifiers.ctrl && (
        <div className="terminal-key-grid terminal-control-keys">
          {controlLetters.map((key) => keyButton(key, key === ' ' ? 'Space' : key, 'Ctrl+' + (key === ' ' ? 'Space' : key)))}
        </div>
      )}
      {expanded && (
        <div className="terminal-key-expanded">
          <div className="terminal-key-grid">{extended.map(([key, label]) => keyButton(key, label))}</div>
          <div className="terminal-key-grid terminal-tools">
            {actions.map((action) => (
              <button key={action} type="button" className="terminal-key" onPointerDown={keepFocus}
                onClick={() => { setExpanded(false); onAction(action); }}>{action}</button>
            ))}
            <button type="button" className="terminal-key" aria-label="减小终端字号" onPointerDown={keepFocus} onClick={() => onFontSize(-1)}>A−</button>
            <button type="button" className="terminal-key" aria-label="增大终端字号" onPointerDown={keepFocus} onClick={() => onFontSize(1)}>A＋</button>
          </div>
        </div>
      )}
      <div className="terminal-key-grid">
        {keyButton('Escape', 'Esc')}
        {keyButton('Tab', 'Tab')}
        {['ctrl', 'alt'].map((modifier) => (
          <button key={modifier} type="button" className={'terminal-key' + (modifiers[modifier] ? ' on' : '')}
            aria-pressed={modifiers[modifier]} onPointerDown={keepFocus} onClick={() => onModifier(modifier)}>
            {modifier === 'ctrl' ? 'Ctrl' : 'Alt'}
          </button>
        ))}
        <button type="button" className={'terminal-key' + (expanded ? ' on' : '')} aria-expanded={expanded}
          onPointerDown={keepFocus} onClick={() => setExpanded(!expanded)}>更多</button>
        <button type="button" className={'terminal-key' + (keyboardOpen ? ' on' : '')}
          aria-label={keyboardOpen ? '收起键盘' : '打开键盘'} onPointerDown={keepFocus} onClick={onKeyboard}>键盘</button>
      </div>
      <div className="terminal-key-grid">
        <button type="button" className="terminal-key terminal-interrupt" aria-label="Ctrl+C 中断"
          onPointerDown={keepFocus} onClick={() => onKey('C', { ctrl: true, alt: false })}>Ctrl+C</button>
        {keyButton('/', '/')}
        {arrows.map(({ key, label, name }) => keyButton(key, label, name))}
      </div>
    </div>
  );
}
