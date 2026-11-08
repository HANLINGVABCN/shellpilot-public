import React,{useState} from 'react';
import {api} from '../api.js';
export default function StorageIssue({error,onRecovered}){
 const [busy,setBusy]=useState(false),[detail,setDetail]=useState(error);
 return <section className="storage-issue" role="alert">
  <strong>读取本机数据失败</strong>
  <p>{detail}</p>
  <button className="btn" disabled={busy} onClick={async()=>{
   setBusy(true);try{await api('/storage/retry','POST',{});onRecovered();}catch(e){setDetail(e.message);}finally{setBusy(false);}
  }}>{busy?'正在重新读取…':'重新读取'}</button>
 </section>;
}
