import React, {useEffect, useRef, useState} from 'react';
import {Terminal} from '@xterm/xterm';
import {FitAddon} from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import {isAndroidDevice} from '../android.js';
import {terminalKey, modifiedTerminalInput} from '../terminalKeys.js';
import TerminalKeyboard from './TerminalKeyboard.jsx';

export default function WorkspaceTerminal({session, active, onConfigure, keyboardOpen=false}) {
  const [mobile]=useState(isAndroidDevice);
  const element=useRef(null), fitRef=useRef(null), termRef=useRef(null), socketRef=useRef(null);
  const [attempt,setAttempt]=useState(0), [closed,setClosed]=useState(false);
  const [modifiers,setModifiers]=useState({ctrl:false,alt:false});
  const modifierRef=useRef(modifiers);
  const [fontSize,setFontSize]=useState(() => {
    if (!mobile) return 13;
    try {return Math.min(22,Math.max(10,Number(localStorage.getItem('shellpilot-android-terminal-font')) || 14));}
    catch {return 14;}
  });
  const fontRef=useRef(fontSize);
  fontRef.current=fontSize;
  const changeModifiers=next => {modifierRef.current=next;setModifiers(next);};
  const sendInput=(data, raw=false) => {
    const socket=socketRef.current;
    if (socket?.readyState !== WebSocket.OPEN) return;
    if (mobile && !raw) data=modifiedTerminalInput(data,modifierRef.current);
    socket.send(JSON.stringify({type:'input',data}));
    changeModifiers({ctrl:false,alt:false});
  };
  const sendKey=(key,overrides) => sendInput(terminalKey(key,{
    ...modifierRef.current,...overrides,
    applicationCursor:termRef.current?.modes.applicationCursorKeysMode || false
  }),true);

  useEffect(() => {
    const term=new Terminal({allowProposedApi:true,fontSize,fontFamily:'Consolas, monospace',cursorBlink:true,scrollback:5000,theme:{background:'#0a0d13',foreground:'#dfe4ee'}});
    const fit=new FitAddon();term.loadAddon(fit);term.open(element.current);
    if (mobile) {
      const input=element.current.querySelector('.xterm-helper-textarea');
      input?.setAttribute('autocapitalize','off');input?.setAttribute('autocorrect','off');
      input?.setAttribute('spellcheck','false');input?.setAttribute('inputmode','text');
    }
    const query=new URLSearchParams({path:session.path || '',session:session.id});
    const socket=new WebSocket((location.protocol === 'https:' ? 'wss' : 'ws')+'://'+location.host+'/api/workspace/terminal/ws?'+query);
    socket.binaryType='arraybuffer';socketRef.current=socket;
    let disposed=false,frame;
    const fitNow=() => {
      cancelAnimationFrame(frame);
      frame=requestAnimationFrame(() => {
        try {
          if (!element.current?.clientWidth || !element.current?.clientHeight) return;
          const zoom=parseFloat(document.documentElement.style.getPropertyValue('--sp-ui-zoom')) || 1;
          term.options.fontSize=Math.round(fontRef.current*zoom*10)/10;
          fit.fit();
          if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({type:'resize',cols:term.cols,rows:term.rows}));
        } catch {}
      });
    };
    fitRef.current=fitNow;termRef.current=term;setClosed(false);fitNow();
    socket.onopen=() => {term.writeln('正在进入 Linux 工作区…');fitNow();};
    socket.onmessage=event => {if (!disposed) term.write(typeof event.data === 'string' ? event.data : new Uint8Array(event.data));};
    socket.onclose=() => {if (!disposed) {term.writeln('\r\n终端已关闭。');setClosed(true);}};
    socket.onerror=() => {if (!disposed) term.writeln('\r\n终端连接失败，请检查工作区安装与运行状态。');};
    const input=term.onData(data => sendInput(data));
    const resize=new ResizeObserver(fitNow);resize.observe(element.current);
    window.addEventListener('shellpilot-zoom',fitNow);
    document.fonts?.addEventListener('loadingdone',fitNow);
    document.fonts?.ready.then(() => {if (!disposed) fitNow();});
    return () => {
      disposed=true;cancelAnimationFrame(frame);resize.disconnect();
      window.removeEventListener('shellpilot-zoom',fitNow);
      document.fonts?.removeEventListener('loadingdone',fitNow);
      input.dispose();socket.close();term.dispose();fitRef.current=null;termRef.current=null;socketRef.current=null;
    };
  },[session.id,attempt]);

  useEffect(() => {
    if (active) {fitRef.current?.();if (!mobile) termRef.current?.focus();}
  },[active,mobile]);
  useEffect(() => {fitRef.current?.();},[fontSize,keyboardOpen,modifiers.ctrl,modifiers.alt]);

  const action=async name => {
    if (name === '粘贴') {
      try {const text=await navigator.clipboard.readText();if (text) sendInput(text);termRef.current?.focus();} catch {}
    } else if (name === '清屏') termRef.current?.clear();
    else if (name === '重连') setAttempt(value => value+1);
  };
  return <div className="workspace-terminal">
    <div ref={element} className="workspace-terminal-body"/>
    {mobile && active && <TerminalKeyboard modifiers={modifiers} keyboardOpen={keyboardOpen} onKey={sendKey}
      actions={['粘贴','清屏','重连']} onAction={action}
      onModifier={key => changeModifiers(key === 'clear' ? {ctrl:false,alt:false} : {...modifierRef.current,[key]:!modifierRef.current[key]})}
      onKeyboard={() => keyboardOpen ? termRef.current?.textarea?.blur() : termRef.current?.focus()}
      onFontSize={delta => setFontSize(previous => {
        const next=Math.min(22,Math.max(10,previous+delta));
        try {localStorage.setItem('shellpilot-android-terminal-font',String(next));} catch {}
        return next;
      })}/>
    }
    {closed && <div className="workspace-terminal-status">
      <button className="btn btn-sm" onClick={() => setAttempt(value => value+1)}>重新连接</button>
      <button className="btn btn-sm" onClick={onConfigure}>⚙ 配置</button>
    </div>}
  </div>;
}
