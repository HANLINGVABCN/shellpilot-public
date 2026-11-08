import React from 'react';
const count=value=>Number.isFinite(value)?String(Math.trunc(value)).replace(/\B(?=(\d{3})+(?!\d))/g,','):'—';
const decimal=value=>value.toFixed(1).replace(/\.0$/,'').replace(/\d+(?=\.|$)/,text=>text.replace(/\B(?=(\d{3})+(?!\d))/g,','));
export default function ReplyStats({stats}){
 if(!stats)return null;
 const seconds=Number.isFinite(stats.durationMs)?decimal(stats.durationMs/1000)+'s':'—';
 const rate=Number.isFinite(stats.tokensPerSecond)?decimal(stats.tokensPerSecond):'—';
 const date=Number.isFinite(stats.startedAt)?new Date(stats.startedAt):null;
 const pad=value=>String(value).padStart(2,'0');
 const time=date&&!Number.isNaN(date.getTime())?[date.getFullYear(),pad(date.getMonth()+1),pad(date.getDate())].join('-')+' '+pad(date.getHours())+':'+pad(date.getMinutes()):'—';
 return <div className="reply-stats" aria-label="回答统计">
  {[time,'↑'+count(stats.inputTokens)+'（'+count(stats.cachedTokens)+'）','↓'+count(stats.outputTokens),seconds,rate+'tok/s',(stats.provider||'—')+'/'+(stats.model||'—')].join(' ')}
 </div>;
}
