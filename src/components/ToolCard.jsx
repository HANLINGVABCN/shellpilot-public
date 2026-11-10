import React,{useId,useState} from 'react';
const names={get_metrics:'读取性能指标',vps_exec:'执行命令',exec_command:'执行命令',vps_exec_batch:'批量执行命令',vps_metrics:'读取性能指标',vps_metrics_batch:'批量读取指标',vps_diagnose:'系统诊断',vps_logs:'查询日志',vps_read_file:'读取文件',vps_write_file:'预览或修改文件',vps_list:'机器列表',remember_memory:'保存记忆'};
export default function ToolCard({part}){
  const [expanded,setExpanded]=useState(false);const id=useId();
  let result;try{result=JSON.parse(part.result);}catch{}
  const command=part.args?.command || (part.args?.commands?part.args.commands.map((item)=>item.command).join('\n'):part.name==='remember_memory'?`${part.args?.topic||''}：${part.args?.content||''}`:`${names[part.name]||part.name}${part.args?.path?' '+part.args.path:''}${part.args?.unit?' '+part.args.unit:''}`);
  const output=typeof result?.stdout==='string'?`${result.stdout}${result.stderr?'\n'+result.stderr:''}`:result?.content??result?.error??(part.result|| (part.status==='running'?'执行中…':'无输出'));
  const toggle=(event)=>{
    if(event.target.closest('button,a,input,textarea,select') || window.getSelection()?.toString())return;
    setExpanded((value)=>!value);
  };
  const copy=(event,text)=>{event.stopPropagation();navigator.clipboard?.writeText(String(text)).catch(()=>{});};
  const keyboard=(event)=>{if(event.target===event.currentTarget && ['Enter',' '].includes(event.key)){event.preventDefault();setExpanded((value)=>!value);}};
  return <div className={'tool-card command-card'+(part.status==='running'?' running':'')+(part.isError?' failed':'')} onClick={toggle} onKeyDown={keyboard} tabIndex={0} role="button" aria-expanded={expanded} aria-controls={id}>
    <div className="command-card-meta"><span>{part.status==='running'?'⏳':part.isError?'❌':'✓'} {names[part.name]||part.name}</span>{part.host && <span className="tool-host">{part.host}</span>}<span>{expanded?'点击内容收起':'点击展开'}</span></div>
    {!expanded?<div className="command-card-preview"><div title={command}><b>命令</b><code>{command.replace(/\s*\n\s*/g,' · ')}</code></div><div title={String(output)}><b>输出</b><span>{String(output).replace(/\s*\n\s*/g,' · ')||'（无输出）'}</span></div></div>:<div id={id} className="command-card-content"><div className="command-card-label"><b>命令</b><button className="btn btn-sm" onClick={(event)=>copy(event,command)}>复制命令</button></div><pre>{command}</pre><div className="command-card-label"><b>命令输出{result?.exitCode!==undefined?` · 退出码 ${result.exitCode}`:''}</b><button className="btn btn-sm" onClick={(event)=>copy(event,output)}>复制输出</button></div><pre>{String(output)||'（无输出）'}</pre>{result?.truncated && <p>输出已截断，请分页或缩小查询范围</p>}{part.judge && <div className="run-judge">{part.judge}</div>}</div>}
  </div>;
}
