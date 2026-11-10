// Inline ghost text follows the shell prompt, never a guessed password/input line.
export function attachTerminalHistory(term,element){
  let token='',commands=[],prompt=null,column=0,editing=false,suggestion='',prefix='',suppressed='',composing=false,live=true,pendingInput=false,expectedLine=null,freshInput=false,frame=null;
  const screen=element.querySelector('.xterm-screen'),ghost=document.createElement('span');
  ghost.className='terminal-history-suggestion';ghost.hidden=true;ghost.setAttribute('role','button');ghost.setAttribute('aria-label','接受历史命令建议');screen.appendChild(ghost);
  const clear=()=>{ghost.hidden=true;suggestion='';};
  const schedule=()=>{if(frame===null&&live)frame=requestAnimationFrame(()=>{frame=null;refresh();});};
  const reset=()=>{editing=false;expectedLine=null;prefix='';freshInput=false;prompt?.dispose();prompt=null;clear();};
  function refresh(){
    if(!live||!editing||!prompt||prompt.isDisposed||composing||pendingInput||term.buffer.active.type!=='normal'||term.getSelection()){clear();return;}
    const buffer=term.buffer.active,row=buffer.baseY+buffer.cursorY,start=prompt.line;
    if(start<0||row<start||row-start>20||buffer.viewportY!==buffer.baseY){clear();return;}
    const line=buffer.getLine(row);if(!line||line.translateToString(true,buffer.cursorX).trim()){clear();return;}
    let text='';
    for(let index=start;index<=row;index++){
      const line=buffer.getLine(index);if(!line){clear();return;}
      text+=line.translateToString(false,index===start?column:0,index===row?buffer.cursorX:term.cols);
    }
    prefix=text;
    if(!freshInput){clear();return;}
    // An earlier echo is not an acknowledgement of all queued keystrokes.
    if(expectedLine!==null&&text!==expectedLine){clear();return;}
    if(!text||text===suppressed||text.includes('\n')){clear();return;}
    const found=commands.findLast(command=>command.length>text.length&&command.startsWith(text));
    if(!found||buffer.cursorX>=term.cols){clear();return;}
    suggestion=found.slice(text.length);
    const cellWidth=screen.clientWidth/term.cols,cellHeight=screen.clientHeight/term.rows;
    ghost.style.left=buffer.cursorX*cellWidth+'px';ghost.style.top=buffer.cursorY*cellHeight+'px';
    ghost.style.maxWidth=(term.cols-buffer.cursorX)*cellWidth+'px';ghost.style.height=cellHeight+'px';ghost.style.lineHeight=cellHeight+'px';
    ghost.style.fontFamily=term.options.fontFamily;ghost.style.fontSize=term.options.fontSize+'px';ghost.textContent=suggestion;ghost.hidden=false;
  }
  const parser=term.parser.registerOscHandler(777,data=>{
    const marker='ShellPilot;'+token+';';if(!token||!data.startsWith(marker))return false;
    const code=data.slice(marker.length);
    if(code==='P'){reset();}else if(code==='I'){prompt?.dispose();prompt=term.registerMarker(0);column=term.buffer.active.cursorX;editing=true;expectedLine=null;freshInput=false;suppressed='';}else if(code==='C'){reset();}
    return true;
  });
  const listeners=[term.onWriteParsed(()=>{pendingInput=false;schedule();}),term.onCursorMove(schedule),term.onScroll(schedule),term.onResize(schedule),term.onSelectionChange(schedule)];
  const textarea=element.querySelector('.xterm-helper-textarea');
  const compositionStart=()=>{composing=true;clear();},compositionEnd=()=>{composing=false;schedule();};
  textarea?.addEventListener('compositionstart',compositionStart);textarea?.addEventListener('compositionend',compositionEnd);
  const accept=()=>{if(ghost.hidden||!suggestion)return false;refresh();if(!suggestion)return false;const text=suggestion;clear();term.paste(text);term.focus();return true;};
  ghost.addEventListener('pointerdown',event=>{event.preventDefault();event.stopPropagation();accept();});
  return {
    setToken(value){if(token!==(value||'')){reset();token=value||'';}},
    setCommands(value){commands=Array.isArray(value)?value.filter(command=>typeof command==='string'&&!/[\r\n\x00]/.test(command)):[];schedule();},
    input(data){
      pendingInput=true;clear();if(!editing)return;
      freshInput=true;
      if(data.includes('\r')||data.includes('\n')){editing=false;expectedLine=null;return;}
      if(data.startsWith('\x1b[200~')&&data.endsWith('\x1b[201~'))data=data.slice(6,-6);
      if(data==='\x7f'){expectedLine=Array.from(expectedLine??prefix).slice(0,-1).join('');}
      else if(!/[\x00-\x1f\x7f-\x9f]/.test(data)){expectedLine=(expectedLine??prefix)+data;}
      else expectedLine=null;
    },
    key(event){if(event.type!=='keydown')return true;if(event.key==='ArrowRight'&&!event.shiftKey&&!event.ctrlKey&&!event.altKey&&!event.metaKey&&accept()){event.preventDefault();return false;}if(event.key==='Escape'){suppressed=prefix;clear();}return true;},
    reset,refresh:schedule,
    dispose(){live=false;cancelAnimationFrame(frame);reset();parser.dispose();listeners.forEach(listener=>listener.dispose());textarea?.removeEventListener('compositionstart',compositionStart);textarea?.removeEventListener('compositionend',compositionEnd);ghost.remove();}
  };
}
