import React,{useEffect,useRef} from 'react';
import {Terminal} from '@xterm/xterm';
import {FitAddon} from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
export default function WorkspaceTerminal({onClose}){
 const element=useRef(null);
 useEffect(()=>{
  const term=new Terminal({fontSize:13,fontFamily:'Consolas, monospace',cursorBlink:true,scrollback:5000,theme:{background:'#0a0d13',foreground:'#dfe4ee'}});
  const fit=new FitAddon();term.loadAddon(fit);term.open(element.current);let frame;
  const fitNow=()=>{cancelAnimationFrame(frame);frame=requestAnimationFrame(()=>{try{const zoom=parseFloat(document.documentElement.style.getPropertyValue('--sp-ui-zoom'))||1;term.options.fontSize=Math.round(13*zoom*10)/10;fit.fit();}catch{}});};fitNow();
  const socket=new WebSocket(`${location.protocol==='https:'?'wss':'ws'}://${location.host}/api/workspace/terminal/ws`);socket.binaryType='arraybuffer';
  socket.onopen=()=>term.writeln('正在进入 Linux 工作区…');
  socket.onmessage=event=>term.write(typeof event.data==='string'?event.data:new Uint8Array(event.data));
  socket.onclose=()=>term.writeln('\r\n终端已关闭，点击打开终端可重新进入。');
  socket.onerror=()=>term.writeln('\r\n终端连接失败，请检查工作区安装与运行状态。');
  const input=term.onData(data=>{if(socket.readyState===WebSocket.OPEN)socket.send(data);});
  const resize=new ResizeObserver(fitNow);resize.observe(element.current);window.addEventListener('shellpilot-zoom',fitNow);document.fonts?.addEventListener('loadingdone',fitNow);
  return()=>{cancelAnimationFrame(frame);resize.disconnect();window.removeEventListener('shellpilot-zoom',fitNow);document.fonts?.removeEventListener('loadingdone',fitNow);input.dispose();socket.close();term.dispose();};
 },[]);
 return <div className="workspace-terminal"><div className="workspace-heading"><strong>Linux 终端</strong><button className="btn btn-sm" onClick={onClose}>关闭终端</button></div><div ref={element} className="workspace-terminal-body"/></div>;
}
