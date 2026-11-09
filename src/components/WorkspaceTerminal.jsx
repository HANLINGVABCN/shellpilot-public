import React,{useEffect,useRef,useState} from 'react';
import {Terminal} from '@xterm/xterm';
import {FitAddon} from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
export default function WorkspaceTerminal({session,active,onConfigure}){
 const element=useRef(null);
 const fitRef=useRef(null),termRef=useRef(null);
 const [attempt,setAttempt]=useState(0),[closed,setClosed]=useState(false);
 useEffect(()=>{
  const term=new Terminal({fontSize:13,fontFamily:'Consolas, monospace',cursorBlink:true,scrollback:5000,theme:{background:'#0a0d13',foreground:'#dfe4ee'}});
  const fit=new FitAddon();term.loadAddon(fit);term.open(element.current);let frame;
  const fitNow=()=>{cancelAnimationFrame(frame);frame=requestAnimationFrame(()=>{try{const zoom=parseFloat(document.documentElement.style.getPropertyValue('--sp-ui-zoom'))||1;term.options.fontSize=Math.round(13*zoom*10)/10;fit.fit();if(socket.readyState===WebSocket.OPEN)socket.send(JSON.stringify({type:'resize',cols:term.cols,rows:term.rows}));}catch{}});};fitNow();
  const query=new URLSearchParams({path:session.path||'',session:session.id});
  const socket=new WebSocket(`${location.protocol==='https:'?'wss':'ws'}://${location.host}/api/workspace/terminal/ws?${query}`);socket.binaryType='arraybuffer';
  let disposed=false;setClosed(false);fitRef.current=fitNow;termRef.current=term;
  socket.onopen=()=>{term.writeln('正在进入 Linux 工作区…');fitNow();};
  socket.onmessage=event=>term.write(typeof event.data==='string'?event.data:new Uint8Array(event.data));
  socket.onclose=()=>{if(!disposed){term.writeln('\r\n终端已关闭。');setClosed(true);}};
  socket.onerror=()=>term.writeln('\r\n终端连接失败，请检查工作区安装与运行状态。');
  const input=term.onData(data=>{if(socket.readyState===WebSocket.OPEN)socket.send(JSON.stringify({type:'input',data}));});
  const resize=new ResizeObserver(fitNow);resize.observe(element.current);window.addEventListener('shellpilot-zoom',fitNow);document.fonts?.addEventListener('loadingdone',fitNow);
  return()=>{disposed=true;cancelAnimationFrame(frame);resize.disconnect();window.removeEventListener('shellpilot-zoom',fitNow);document.fonts?.removeEventListener('loadingdone',fitNow);input.dispose();socket.close();term.dispose();fitRef.current=null;termRef.current=null;};
 },[session.id,attempt]);
 useEffect(()=>{if(active){fitRef.current?.();termRef.current?.focus();}},[active]);
 return <div className="workspace-terminal"><div ref={element} className="workspace-terminal-body"/>{closed&&<div className="workspace-terminal-status"><button className="btn btn-sm" onClick={()=>setAttempt(value=>value+1)}>重新连接</button><button className="btn btn-sm" onClick={onConfigure}>⚙ 配置</button></div>}</div>;
}
