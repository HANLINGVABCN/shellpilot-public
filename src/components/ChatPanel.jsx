import React, { useEffect, useId, useRef, useState } from 'react';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { ws } from '../ws.js';
import { api } from '../api.js';
import { reconcileScope, sameScope } from '../scope.js';
import ToolCard from './ToolCard.jsx';
import ResizableChatInput from './ResizableChatInput.jsx';
import ReplyStats from './ReplyStats.jsx';
import WorkspacePanel,{workspaceSupported} from './WorkspacePanel.jsx';
import {FolderIcon} from '../icons.jsx';

function UserMessage({ text }) {
  const [expanded, setExpanded] = useState(false);
  const id = useId();
  const long = text.length > 280 || text.split('\n').length > 6;
  useEffect(() => setExpanded(false), [text]);
  return <div className="msg user"><div id={id} className={'user-text' + (long && !expanded ? ' collapsed' : '')}>{text}</div>{long && <button className="user-message-toggle" aria-expanded={expanded} aria-controls={id} onClick={() => setExpanded((value) => !value)}>{expanded ? '收起' : '展开全文'}</button>}</div>;
}

marked.setOptions({ breaks: true });
const render = (text) => ({ __html: DOMPurify.sanitize(marked.parse(text || '')) });

const MODES = [
  { id: 'ask', label: '审批执行', desc: '危险命令先弹条问我' },
  { id: 'ai', label: 'AI 审批', desc: '小模型替我审危险命令' },
  { id: 'auto', label: '自动执行', desc: '命令直接跑，高风险仍拦截' },
  { id: 'full', label: '完全托管', desc: '高风险命令也不问，慎用！' }
];

const EFFORTS = [
  { id: 'off', label: '关闭', desc: '不发思考参数' },
  { id: 'minimal', label: '极低', desc: '最省 token 的浅思考' },
  { id: 'low', label: '低', desc: '快而略加思考' },
  { id: 'medium', label: '中', desc: '平衡模式（默认）' },
  { id: 'high', label: '高', desc: '深度思考，更慢更贵' }
];

// 把存储的 OpenAI 格式消息转成按真实时间顺序的内容片段
function storedToDisplay(messages) {
  const out = [];
  let cur = null;
  const ensureAi = () => {
    const last = out[out.length - 1];
    if (last && last.role === 'assistant' && last === cur) return cur;
    cur = { role: 'assistant', streaming: false, parts: [] };
    out.push(cur);
    return cur;
  };
  for (const m of messages) {
    if (m.role === 'user') {
      cur = null;
      out.push({ role: 'user', text: typeof m.content === 'string' ? m.content : JSON.stringify(m.content) });
    } else if (m.role === 'assistant') {
      const ai = ensureAi();
      if(m.stats)ai.stats=m.stats;
      const reasoning = m.reasoning_content || m.reasoning;
      if (reasoning) {
        ai.parts.push({ type: 'reasoning', text: reasoning });
      }
      if (typeof m.content === 'string' && m.content) {
        if (m.content.includes('<think>')) {
          const thinkMatch = m.content.match(/<think>([\s\S]*?)<\/think>/);
          if (thinkMatch) {
            if (!reasoning && thinkMatch[1].trim()) {
              ai.parts.push({ type: 'reasoning', text: thinkMatch[1].trim() });
            }
            const clean = m.content.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
            if (clean) ai.parts.push({ type: 'text', text: clean });
          } else {
            ai.parts.push({ type: 'text', text: m.content });
          }
        } else {
          ai.parts.push({ type: 'text', text: m.content });
        }
      }
      if (Array.isArray(m.tool_calls)) {
        for (const tc of m.tool_calls) {
          let args = {};
          try { args = JSON.parse(tc.function.arguments || '{}'); } catch {}
          ai.parts.push({ type: 'tool', callId: tc.id, name: tc.function.name, args, status: 'done' });
        }
      }
    } else if (m.role === 'tool') {
      const ai = ensureAi();
      const raw = String(m.content || '');
      // 审批结论随工具结果持久化（[[SP-JUDGE]] 标记）→ 重建审批卡片，刷新前后一致
      const jIdx = raw.indexOf('[[SP-JUDGE]]');
      const judge = jIdx >= 0 ? raw.slice(jIdx + 11) : null;
      const content = jIdx >= 0 ? raw.slice(0, jIdx) : raw;
      const p = ai.parts.find((x) => x.type === 'tool' && x.callId === m.tool_call_id)
        || [...ai.parts].reverse().find((x) => x.type === 'tool' && x.result === undefined);
      if (p) {
        p.result = content;
        try { const result = JSON.parse(content); p.isError = !!result.error || (result.exitCode !== undefined && result.exitCode !== 0); p.host = result.host; } catch {}
        // 审批结论随工具结果持久化 → 直接挂在 run 卡上（刷新前后一致）
        if (judge) p.judge = judge.trim();
      }
    }
  }
  return out;
}

const fmtTime = (ts) => {
  if(!ts)return '';
  const d = new Date(ts);
  if(Number.isNaN(d.getTime()))return '';
  const now = new Date();
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  return d.toDateString() === now.toDateString() ? hm : `${d.getMonth() + 1}/${d.getDate()} ${hm}`;
};

// 全局 AI 对话：不绑定某台机器；用「机器」多选决定 AI 能操作哪些服务器
export default function ChatPanel({ hosts, hostsLoaded, probeMap, width, onOpenSettings }) {
  const [msgs, setMsgs] = useState([]);
  const [input, setInput] = useState('');
  const [modelName, setModelName] = useState('');
  const [noModel, setNoModel] = useState(false);
  const [workspaceOpen,setWorkspaceOpen]=useState(false);
  const [workspaceEnabled,setWorkspaceEnabled]=useState(false);
  useEffect(()=>{
    const load=()=>{if(workspaceSupported())api('/workspace').then(config=>setWorkspaceEnabled(!!config.enabled)).catch(()=>{});};
    load();return ws.on('workspace-changed',load);
  },[]);
  const [modelMenu, setModelMenu] = useState(false);
  const [models, setModels] = useState([]);
  const [mode, setMode] = useState(() => localStorage.getItem('shellpilot-mode') || 'ask');
  const [modeMenu, setModeMenu] = useState(false);
  const [effort, setEffort] = useState(() => localStorage.getItem('shellpilot-effort') || 'medium');
  const [effortMenu, setEffortMenu] = useState(false);
  const [chatMenu, setChatMenu] = useState(false);
  const [chats, setChats] = useState([]);
  const [manageChats,setManageChats]=useState(false);
  const [selectedChats,setSelectedChats]=useState([]);
  const [deleteRequest,setDeleteRequest]=useState(null);
  const [deleting,setDeleting]=useState(false);
  const [deleteError,setDeleteError]=useState('');
  const [chatId, setChatId] = useState(() => localStorage.getItem('shellpilot-chat-id') || null);
  const [chatTitle, setChatTitle] = useState('新对话');
  const [toolReqs, setToolReqs] = useState([]);
  const toolReq = toolReqs[0];
  const [progress, setProgress] = useState(null);
  const streamActive=useRef(false);
  const [takingQueue,setTakingQueue]=useState(null);
  const editorRef=useRef(null);
  const [scope, setScope] = useState(() => {
    try { const saved = JSON.parse(localStorage.getItem('shellpilot-agent-scope') || 'null'); return Array.isArray(saved) ? saved : null; } catch { return null; }
  }); // null = 未初始化；[] = 明确取消勾选
  const hostsRef = useRef(hosts);
  hostsRef.current = hosts;
  const validScope = reconcileScope(scope || [], hosts) || [];
  const [scopeMenu, setScopeMenu] = useState(false);
  const [busy, setBusy] = useState(false);  // AI 正在输出/执行
  const [paused,setPaused]=useState(false),[pauseReady,setPauseReady]=useState(false),[queue,setQueue]=useState([]);
  const [memoryNote,setMemoryNote]=useState('');
  const [queueError,setQueueError]=useState('');
  const jobStateRef=useRef({busy:false,paused:false,queue:[]});
  const applyJobState=(state,authoritative=false)=>{
    const sameServer=!state.processId||!jobStateRef.current.processId||state.processId===jobStateRef.current.processId;
    if(sameServer&&state.revision && jobStateRef.current.revision && state.revision<jobStateRef.current.revision)return false;
    if(authoritative||!sameServer)streamActive.current=!!state.busy||!!state.activeId;
    jobStateRef.current=state;
    setBusy(!!state.busy||!!state.activeId||streamActive.current);
    setPaused(!!state.paused);setPauseReady(!!state.pauseReady);setQueue(state.queue||[]);
    return true;
  };
  const listRef = useRef(null);
  const followBottomRef = useRef(true);
  const lastScrollTopRef = useRef(0);
  const lastListHeightRef = useRef(0);
  const [readingHistory,setReadingHistory] = useState(false);
  const setFollowBottom = (follow) => {followBottomRef.current=follow;setReadingHistory(!follow);};
  const scrollToLatest = () => {
    setFollowBottom(true);
    const list=listRef.current;
    if(list){list.scrollTop=list.scrollHeight;lastScrollTopRef.current=list.scrollTop;}
  };
  const onListScroll = () => {
    const list=listRef.current;if(!list)return;
    const movedUp=list.scrollTop<lastScrollTopRef.current-1;
    const resized=lastListHeightRef.current!==list.clientHeight;
    lastListHeightRef.current=list.clientHeight;
    lastScrollTopRef.current=list.scrollTop;
    const atBottom=list.scrollHeight-list.clientHeight-list.scrollTop<=24;
    // Growing the available viewport can clamp scrollTop upward. That is a
    // layout change, not a request to stop following newly generated output.
    if(movedUp && resized)return;
    if(movedUp)setFollowBottom(false);
    else if(atBottom)setFollowBottom(true);
  };
  const touchY = useRef(null);
  const msgsCountRef = useRef(0);
  msgsCountRef.current = msgs.length;

  const loadModels = () => api('/settings').then((s) => {
    const list = s.models.map((m) => ({
      ...m,
      providerName: (s.providers.find((p) => p.id === m.providerId) || {}).name || '?'
    }));
    setModels(list);
    const cur = list.find((x) => x.id === s.defaultModelId) || list[0];
    if (cur) { setModelName(cur.name); setNoModel(false); }
    else { setNoModel(true); setModelName(''); }
  }).catch(() => {});

  const loadChats = () => api('/chats/__global__').then((list)=>{
    setChats(list);setSelectedChats((ids)=>ids.filter((id)=>list.some((chat)=>chat.id===id)));
  }).catch(() => {});

  useEffect(() => { loadModels(); loadChats(); }, []);
  useEffect(() => {
    const restore = () => api('/agent/status').then((status) => {
      if(!applyJobState(status,true))return;
      if ((status.busy || status.queue?.length) && status.chatId) {
        setChatId(status.chatId);
        setMsgs(storedToDisplay(status.messages || []));
        if (Array.isArray(status.scope)) setScope(status.scope);
      }
      setToolReqs(status.approvals || []);
    }).catch(() => {});
    restore();
    return ws.on('_open', restore);
  }, []);

  // 机器列表到位后，默认全部勾选
  useEffect(() => {
    if (!hostsLoaded) return;
    setScope((previous) => {
      const next = reconcileScope(previous, hosts);
      return sameScope(previous, next) ? previous : next;
    });
  }, [hosts, hostsLoaded]);

  // 范围变化 → 告诉后端；WS 断线重连后也要补发（范围状态在服务端内存里）
  useEffect(() => {
    if (scope === null || !hostsLoaded || busy) return;
    const selected = reconcileScope(scope, hosts) || [];
    localStorage.setItem('shellpilot-agent-scope', JSON.stringify(selected));
    ws.send({ type: 'agent-scope', hostIds: selected });
    return ws.on('_open', () => ws.send({ type: 'agent-scope', hostIds: selected }));
  }, [scope, hostsLoaded, hosts, busy]);
  useEffect(() => ws.on('agent-scope', (message) => {
    if (!Array.isArray(message.hostIds)) return;
    setScope((previous) => sameScope(previous, message.hostIds) ? previous : message.hostIds);
  }), []);

  // 点面板其他地方收起下拉
  useEffect(() => {
    const close = (e) => {
      if (!e.target.closest('.model-wrap')) setModelMenu(false);
      if (!e.target.closest('.mode-wrap')) setModeMenu(false);
      if (!e.target.closest('.effort-wrap')) setEffortMenu(false);
      if (!e.target.closest('.chat-menu-wrap')) setChatMenu(false);
      if (!e.target.closest('.scope-wrap')) setScopeMenu(false);
    };
    document.addEventListener('click', close);
    return () => document.removeEventListener('click', close);
  }, []);

  useEffect(() => {
    const offs = [
      ws.on('chat-start', (message) => {
        setBusy(true);
        streamActive.current=true;
        jobStateRef.current={...jobStateRef.current,busy:true};
        setMsgs((prev) => {
          const next = [...prev];
          if(message.text)next.push({role:'user',text:message.text});
          const last = next[next.length - 1];
          if (last && last.role === 'assistant' && last.streaming) return next;
          next.push({ role: 'assistant', streaming: true, parts: [] });
          return next;
        });
      }),
      // 推理/思考流式片段
      ws.on('chat-reasoning-delta', (m) => {
        streamActive.current=true;
        setBusy(true);
        setMsgs((prev) => {
          const next = [...prev];
          let last = next[next.length - 1];
          if (!(last && last.role === 'assistant' && last.streaming)) {
            next.push({ role: 'assistant', streaming: true, parts: [] });
            last = next[next.length - 1];
          }
          const parts = [...last.parts];
          const lp = parts[parts.length - 1];
          if (lp && lp.type === 'reasoning') {
            parts[parts.length - 1] = { ...lp, text: lp.text + m.delta };
          } else {
            parts.push({ type: 'reasoning', text: m.delta });
          }
          next[next.length - 1] = { ...last, parts };
          return next;
        });
      }),
      // 流式文字：追加到最后的文字片段，保持真实顺序
      ws.on('chat-delta', (m) => {
        streamActive.current=true;
        setBusy(true);
        setMsgs((prev) => {
          const next = [...prev];
          let last = next[next.length - 1];
          if (!(last && last.role === 'assistant' && last.streaming)) {
            next.push({ role: 'assistant', streaming: true, parts: [] });
            last = next[next.length - 1];
          }
          const parts = [...last.parts];
          const lp = parts[parts.length - 1];
          if (lp && lp.type === 'text') {
            parts[parts.length - 1] = { ...lp, text: lp.text + m.delta };
          } else {
            parts.push({ type: 'text', text: m.delta });
          }
          next[next.length - 1] = { ...last, parts };
          return next;
        });
      }),
      // 工具卡片：作为新片段插入到当前流式位置
      ws.on('chat-tool-start', (m) => {
        streamActive.current=true;
        setBusy(true);
        setMsgs((prev) => {
          const next = [...prev];
          let last = next[next.length - 1];
          if (!(last && last.role === 'assistant' && last.streaming)) {
            next.push({ role: 'assistant', streaming: true, parts: [] });
            last = next[next.length - 1];
          }
          next[next.length - 1] = { ...last, parts: [...last.parts, { type: 'tool', callId: m.callId, name: m.name, args: m.args, host: m.host, status: 'running', judge: null }] };
          return next;
        });
      }),
      ws.on('chat-tool-end', (m) => {
        setMsgs((prev) => {
          const next = [...prev];
          for (let i = next.length - 1; i >= 0; i--) {
            const msg = next[i];
            if (msg.role !== 'assistant') continue;
            const ridx = [...msg.parts].reverse().findIndex((p) => p.type === 'tool' && (m.callId ? p.callId === m.callId : p.name === m.name && p.status === 'running'));
            if (ridx >= 0) {
              const idx = msg.parts.length - 1 - ridx;
              const parts = [...msg.parts];
              parts[idx] = { ...parts[idx], status: 'done', result: m.result, host: m.host, isError: m.isError };
              next[i] = { ...msg, parts };
              break;
            }
          }
          return next;
        });
      }),
      ws.on('chat-done', (m) => {
        streamActive.current=false;
        setBusy(!!jobStateRef.current.activeId||!!jobStateRef.current.busy);
        setProgress(null);
        setToolReqs((items) => items.filter((item) => item.source !== 'ai'));
        setMsgs((prev) => {
          const next = [...prev];
          const last = next[next.length - 1];
          if (last && last.role === 'assistant' && last.streaming) {
            next[next.length - 1] = { ...last, streaming: false, error: m.error || null,stats:m.stats };
          } else if (m.error) {
            next.push({ role: 'assistant', streaming: false, parts: [], error: m.error,stats:m.stats });
          }
          return next;
        });
      }),
      ws.on('chat-cleared', () => { streamActive.current=false;setBusy(false); setMsgs([]); setChatId(null); setChatTitle('新对话'); }),
      ws.on('tool-request', (m) => {
        setToolReqs((items) => [...items.filter((item) => item.reqId !== m.reqId), m]);
      }),
      ws.on('tool-request-expired', (m) => setToolReqs((items) => items.filter((item) => item.reqId !== m.reqId))),
      ws.on('chat-progress', setProgress),
      ws.on('chat-job-state',applyJobState),
      ws.on('error',(message)=>{if(message.requestType?.startsWith('chat-')){setQueueError(message.message);setTakingQueue(null);}}),
      ws.on("memory-saved",message=>{setMemoryNote("已记住："+message.memory.content);setTimeout(()=>setMemoryNote(""),5000);}),
      ws.on('chat-queue-taken',message=>{
        setInput(previous=>previous.trim()?previous+'\n'+message.text:message.text);
        setTakingQueue(null);
        requestAnimationFrame(()=>editorRef.current?.focus());
      }),
      ws.on('chat-rejected', (m) => setMsgs((items) => [...items, {role:'assistant',parts:[],error:m.error}])),
      ws.on('chat-ai-judging', (m) => {
        // 审批中状态直接标在 run 卡上
        setMsgs((prev) => {
          const next = [...prev];
          for (let i = next.length - 1; i >= 0; i--) {
            const msg = next[i];
            if (msg.role !== 'assistant') continue;
            const ridx = [...msg.parts].reverse().findIndex((p) => p.type === 'tool' && p.name === 'exec_command' && p.status === 'running' && !p.judge);
            if (ridx >= 0) {
              const idx = msg.parts.length - 1 - ridx;
              const parts = [...msg.parts];
              parts[idx] = { ...parts[idx], judging: true };
              next[i] = { ...msg, parts };
              break;
            }
          }
          return next;
        });
      }),
      ws.on('chat-ai-verdict', (m) => {
        // 审批结论标在 run 卡上（不单独出卡片）
        const what = m.decision === 'allow' ? '✅ AI 审批官放行' : m.decision === 'deny' ? '🚫 AI 审批官拒绝' : '🙋 转人工确认';
        setMsgs((prev) => {
          const next = [...prev];
          for (let i = next.length - 1; i >= 0; i--) {
            const msg = next[i];
            if (msg.role !== 'assistant') continue;
            const ridx = [...msg.parts].reverse().findIndex((p) => p.type === 'tool' && p.name === 'exec_command' && p.status === 'running' && !p.judge);
            if (ridx >= 0) {
              const idx = msg.parts.length - 1 - ridx;
              const parts = [...msg.parts];
              parts[idx] = { ...parts[idx], judging: false, judge: `${what}：${m.reason}` };
              next[i] = { ...msg, parts };
              break;
            }
          }
          return next;
        });
      }),
      ws.on('chat-meta', (m) => {
        setChatId(m.chatId);
        setChatTitle(m.title);
        loadChats();
        // 面板还是空的（比如刚刷新）→ 拉取当前对话内容，保证刷新前后一致
        if (msgsCountRef.current === 0 && m.chatId && !jobStateRef.current.busy) {
          api('/chats/__global__/' + m.chatId).then((full) => {
            setMsgs(storedToDisplay(full.messages || []));
          }).catch(() => {});
        }
      }),
      ws.on('chat-list-changed', () => loadChats())
    ];
    return () => offs.forEach((f) => f());
  }, []);

  useEffect(() => {
    if(followBottomRef.current){
      const list=listRef.current;
      if(list){list.scrollTop=list.scrollHeight;lastScrollTopRef.current=list.scrollTop;lastListHeightRef.current=list.clientHeight;}
    }
  }, [msgs]);
  useEffect(() => {
    const list=listRef.current;if(!list)return;
    const observer=new ResizeObserver(()=>{if(followBottomRef.current){list.scrollTop=list.scrollHeight;lastScrollTopRef.current=list.scrollTop;lastListHeightRef.current=list.clientHeight;}});
    observer.observe(list);return ()=>observer.disconnect();
  },[]);

  // 记住当前对话：刷新后自动回到上次正在看的对话（内容、标题一致）
  useEffect(() => {
    try {
      if (chatId) localStorage.setItem('shellpilot-chat-id', chatId);
      else localStorage.removeItem('shellpilot-chat-id');
    } catch {}
  }, [chatId]);

  // 启动时恢复上次对话
  useEffect(() => {
    const saved = localStorage.getItem('shellpilot-chat-id');
    if (!saved) return;
    api('/chats/__global__/' + saved).then((full) => {
      setMsgs(storedToDisplay(full.messages || []));
      setChatId(full.id);
      setChatTitle(full.title || '对话');
      ws.send({ type: 'chat-select', chatId: saved });
    }).catch(() => {});
  }, []);

  const chooseModel = async (id) => {
    setModelMenu(false);
    try {
      const s = await api('/settings');
      await api('/settings', 'PUT', { ...s, defaultModelId: id });
      loadModels();
    } catch {}
  };

  const pickMode = (m) => {
    setModeMenu(false);
    if (m.id === 'full' && mode !== 'full') {
      if (!confirm('「完全托管」：删库、格式化这类高风险命令也不会再询问，直接执行！\n\n确定要开启吗？')) return;
    }
    setMode(m.id);
    localStorage.setItem('shellpilot-mode', m.id);
  };

  const pickEffort = (ef) => { setEffortMenu(false); setEffort(ef.id); localStorage.setItem('shellpilot-effort', ef.id); };

  const toggleScope = (id) => {
    if (busy || !hostsRef.current.some((host) => host.id === id)) return;
    setScope((prev) => {
      const cur = prev || [];
      return reconcileScope(cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id], hostsRef.current);
    });
  };

  const newChat = () => {
    if (busy || queue.length) return;
    setFollowBottom(true);
    setChatMenu(false);
    setMsgs([]);
    setChatId(null);
    setChatTitle('新对话');
    ws.send({ type: 'chat-clear' });
  };

  const openChat = async (c) => {
    if (busy || queue.length) return;
    setFollowBottom(true);
    setChatMenu(false);
    try {
      const full = await api(`/chats/__global__/${c.id}`);
      ws.send({ type: 'chat-select', chatId: c.id });
      setMsgs(storedToDisplay(full.messages || []));
      setChatId(c.id);
      setChatTitle(full.title);
    } catch {}
  };

  const removeChat = async (e, c) => {
    e.stopPropagation();
    if (busy || queue.length) return;
    setDeleteRequest({ids:[c.id],title:c.title,all:false});setDeleteError('');
  };
  const deleteChats=async()=>{
    if(!deleteRequest || deleting || busy || queue.length)return;
    setDeleting(true);setDeleteError('');
    try {
      const result=await api('/chats/__global__/delete','POST',deleteRequest.all?{all:true}:{ids:deleteRequest.ids});
      if(result.currentCleared) {setMsgs([]);setChatId(null);setChatTitle('新对话');}
      setDeleteRequest(null);setSelectedChats([]);await loadChats();
    }catch(error){setDeleteError(error.message);}
    finally {setDeleting(false);}
  };
  const toggleChatSelection=(id)=>setSelectedChats((ids)=>ids.includes(id)?ids.filter((selected)=>selected!==id):[...ids,id]);

  const send = () => {
    const text = input.trim();
    if (!text || noModel) return;
    setInput('');
    ws.send({ type: 'chat', text, mode, effort });
  };

  const decide = (approve, remember) => {
    if (!toolReq) return;
    ws.send({ type: approve ? 'tool-approve' : 'tool-deny', reqId: toolReq.reqId, command: toolReq.command, remember });
    setToolReqs((items) => items.slice(1));
  };

  const curMode = MODES.find((m) => m.id === mode) || MODES[0];
  const curEffort = EFFORTS.find((e) => e.id === effort) || EFFORTS[3];
  const scopeCount = validScope.length;
  const dotOf = (h) => {
    const p = (probeMap || {})[h.id] || {};
    return p.state === 'online' ? 'green' : p.state === 'connecting' ? 'amber' : p.state === 'error' ? 'red' : 'gray';
  };

  return (
    <div className="chat-panel" style={{ width, minWidth: width, '--sp-chat-width':`${width}px` }}>
      <div className="chat-head">
        <img className="chat-avatar" src="/shellpilot.svg" alt="ShellPilot AI" />
        <div className="chat-menu-wrap">
          <button className="chat-model chat-title-btn" title="对话记录" onClick={() => { const v = !chatMenu; setChatMenu(v); if (v) loadChats(); }}>
            # {chatTitle} ▾
          </button>
          {chatMenu && (
            <div className="dropdown-menu chat-menu">
              <button className="menu-item manage" disabled={busy || queue.length>0} onClick={newChat}>＋ 新对话</button>
              <div className="chat-history-actions">
                <button className="btn btn-sm" disabled={busy || queue.length>0 || deleting || !chats.length} onClick={()=>{setManageChats((value)=>!value);setSelectedChats([]);setDeleteRequest(null);}}>{manageChats?'退出管理':'管理对话'}</button>
                <button className="btn btn-sm danger" disabled={busy || queue.length>0 || deleting || !chats.length} onClick={()=>{setDeleteRequest({all:true,ids:chats.map((chat)=>chat.id)});setDeleteError('');}}>清空对话</button>
              </div>
              {manageChats && <div className="chat-history-actions"><button className="btn btn-sm" disabled={deleting} onClick={()=>setSelectedChats(selectedChats.length===chats.length?[]:chats.map((chat)=>chat.id))}>{selectedChats.length===chats.length?'取消全选':'全选'}</button><button className="btn btn-sm danger" disabled={busy || deleting || !selectedChats.length} onClick={()=>{setDeleteRequest({all:false,ids:[...selectedChats]});setDeleteError('');}}>删除所选（{selectedChats.length}）</button></div>}
              {deleteRequest && <div className="chat-delete-confirm" role="group" aria-label="删除对话确认"><p>{deleteRequest.all?'清空全部对话？':deleteRequest.title?`删除「${deleteRequest.title}」？`:`删除选中的 ${deleteRequest.ids.length} 个对话？`}</p><span>删除后无法恢复。</span>{deleteError && <p role="alert">{deleteError}</p>}<div className="chat-history-actions"><button className="btn btn-sm" disabled={deleting} onClick={()=>setDeleteRequest(null)}>取消删除</button><button className="btn btn-sm danger" disabled={busy || deleting} onClick={deleteChats}>{deleting?'正在删除…':'确认删除'}</button></div></div>}
              {(busy || queue.length>0) && <div className="menu-hint">结束任务并处理队列后可切换对话</div>}
              {chats.length === 0 && <div className="menu-hint">还没有历史对话</div>}
              {chats.map((c) => (
                <div key={c.id} className={'chat-item' + (c.id === chatId ? ' on' : '')} onClick={() => manageChats ? toggleChatSelection(c.id) : !deleting && openChat(c)}>
                  {manageChats && <input type="checkbox" aria-label={`选择对话 ${c.title}`} disabled={deleting || busy} checked={selectedChats.includes(c.id)} onClick={(event)=>event.stopPropagation()} onChange={()=>toggleChatSelection(c.id)} />}
                  <span className="ci-title" title={c.title}>{c.title}</span>
                  <span className="ci-time">{fmtTime(c.updatedAt)}</span>
                  <button className="ci-del" title={`删除对话 ${c.title}`} aria-label={`删除对话 ${c.title}`} disabled={busy || queue.length>0 || deleting} onClick={(e) => removeChat(e, c)}>删除</button>
                </div>
              ))}
            </div>
          )}
        </div>
        <div className="model-wrap">
          <button
            className="chat-model"
            title="点击切换模型"
            onClick={() => { const v = !modelMenu; setModelMenu(v); if (v) loadModels(); }}
          >
            {noModel ? '⚠️ 未配置模型' : modelName} ▾
          </button>
          {modelMenu && (
            <div className="dropdown-menu model-menu">
              {models.length === 0 && <div className="menu-hint">还没有模型，点下面去添加</div>}
              {models.map((m) => (
                <button key={m.id} className={'menu-item' + (m.name === modelName ? ' on' : '')} onClick={() => chooseModel(m.id)}>
                  <span className="mi-name">{m.name}</span>
                  <span className="mi-prov">{m.providerName}</span>
                </button>
              ))}
              <button className="menu-item manage" onClick={() => { setModelMenu(false); onOpenSettings(); }}>
                管理服务商与模型…
              </button>
            </div>
          )}
        </div>
      </div>

      {(busy || paused || queue.length>0) && <div className="task-progress"><span>{paused?(pauseReady?'已暂停':'完成当前操作后暂停'):progress?.phase==='tools'?`执行工具（${progress.tools||1}）`:'思考与生成'}{progress && (progress.maxSteps ? ` · ${progress.step}/${progress.maxSteps} 轮` : ` · 第 ${progress.step} 轮`)}</span><div className="queue-actions"><button className="btn btn-sm" onClick={()=>ws.send({type:paused?'chat-resume':'chat-pause'})}>{paused?'继续':'暂停'}</button>{busy && <button className="btn btn-sm danger" onClick={() => ws.send({type:'chat-stop'})}>停止当前任务</button>}</div></div>}
      {memoryNote && <div className="memory-note" role="status">{memoryNote}</div>}

      {workspaceOpen&&<WorkspacePanel onClose={()=>setWorkspaceOpen(false)} onSettings={onOpenSettings}/>}
      <div className="chat-history"><div className="chat-list" ref={listRef} onScroll={onListScroll}
        onWheel={(event)=>{if(event.deltaY<0)setFollowBottom(false);}}
        onTouchStart={(event)=>{touchY.current=event.touches[0]?.clientY;}}
        onTouchMove={(event)=>{const y=event.touches[0]?.clientY;if(touchY.current!==null&&y>touchY.current+2)setFollowBottom(false);touchY.current=y;}}
        onKeyDown={(event)=>{if(['ArrowUp','PageUp','Home'].includes(event.key))setFollowBottom(false);}}
        onPointerDown={(event)=>{
          const right=event.currentTarget.getBoundingClientRect().right;
          if(event.clientX>=right-14 || event.target.closest('details,.command-card,.user-message-toggle'))setFollowBottom(false);
        }}>
        {msgs.length === 0 && (
          <div className="chat-empty">
            <div className="chat-empty-big">说出你想做的事</div>
            <div className="chat-empty-tip">看看 CPU 怎么这么高</div>
            <div className="chat-empty-tip">对比几台机器的磁盘占用</div>
            <div className="chat-empty-tip">帮我装个 nginx</div>
            <div className="chat-empty-warn">当前模式：{curMode.label} —— {curMode.desc}</div>
          </div>
        )}
        {msgs.map((m, i) =>
          m.role === 'user' ? (
            <UserMessage key={i} text={m.text} />
          ) : (
            <div key={i} className={'msg ai' + (m.error ? ' has-err' : '')}>
              {(m.parts || []).map((p, j) => {
                if (p.type === 'reasoning') {
                  const isStillThinking = m.streaming && !(m.parts || []).some((x, k) => k > j && ((x.type === 'text' && x.text) || x.type === 'tool'));
                  return (
                    <details key={j} className="reasoning-box" open={isStillThinking}>
                      <summary className="reasoning-summary">
                        {isStillThinking ? <span className="spinner-dot"></span> : <span>🧠</span>}
                        <span className="reasoning-title">
                          {isStillThinking ? '思考中…' : '已深度思考（点击展开/折叠）'}
                        </span>
                        <span className="reasoning-arrow">▶</span>
                      </summary>
                      <div className="reasoning-content">{p.text}</div>
                    </details>
                  );
                }
                return p.type === 'tool' ? <ToolCard key={p.callId || j} part={p} /> : (p.text ? <div key={j} className="md" dangerouslySetInnerHTML={render(p.text)} /> : null);
              })}
              {m.streaming && (!m.parts || m.parts.length === 0) && (
                <div className="thinking-indicator">
                  <span className="spinner-dot"></span>
                  <span>AI 思考中…</span>
                </div>
              )}
              {m.error && <div className="chat-err">⚠️ {m.error}</div>}
              {!m.streaming&&<ReplyStats stats={m.stats}/>}
            </div>
          )
        )}
      </div>

      {readingHistory && <button className="chat-jump-latest" aria-label="滚到最新消息" onClick={scrollToLatest}><svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M12 4v15M6 13l6 6 6-6"/></svg></button>}</div>
      {queueError && <div className="queue-panel"><div className="form-err" role="alert">{queueError}</div><button className="btn btn-sm" onClick={()=>setQueueError('')}>知道了</button></div>}
      {queue.length>0 && <div className="queue-panel"><div className="queue-heading"><span>排队消息（{queue.length}）</span><button className="btn btn-sm" onClick={()=>ws.send({type:"chat-queue-clear"})}>清空队列</button></div>{queue.map((job,index)=><div className="queue-item" key={job.id}><button className="queue-message" aria-label={"取回排队消息 "+(index+1)} disabled={!!takingQueue} onClick={()=>{setTakingQueue(job.id);ws.send({type:"chat-queue-take",jobId:job.id});}}>{index+1}. {job.text}</button><button className="queue-remove" title="取消排队" aria-label="取消排队" onClick={()=>ws.send({type:"chat-queue-remove",jobId:job.id})}>×</button></div>)}</div>}
      {toolReq && (
        <div className="approval-bar">
          <div className="ab-row">
            <span className="ab-title">AI 请求执行{toolReq.host ? `（${toolReq.host}）` : ''}</span>
            <code className="ab-cmd">{toolReq.command}</code>
          </div>
          {toolReq.preview && <details className="approval-preview" open><summary>文件修改预览：{toolReq.preview.path}</summary><div>修改前</div><pre>{toolReq.preview.before || '（新文件）'}</pre><div>修改后</div><pre>{toolReq.preview.after}</pre></details>}
          <div className="ab-actions">
            <label className="ab-remember">
              <input type="checkbox" id="ab-remember" disabled={!!toolReq.preview} />记住此机器上的命令
            </label>
            <button className="btn btn-sm danger" onClick={() => decide(false, false)}>拒绝</button>
            <button className="btn btn-sm primary" onClick={() => decide(true, document.getElementById('ab-remember').checked)}>✔ 允许</button>
          </div>
        </div>
      )}

      {/* 审批模式：输入框上方左侧 */}
      <div className="pre-input">
        <div className="mode-wrap">
          <button className="btn btn-sm mode-btn" title="切换 AI 执行命令的审批模式" onClick={() => setModeMenu(!modeMenu)}>
            {curMode.label}
          </button>
          {modeMenu && (
            <div className="dropdown-menu mode-menu">
              {MODES.map((m) => (
                <button key={m.id} className={'menu-item' + (m.id === mode ? ' on' : '')} onClick={() => pickMode(m)}>
                  <span className="mi-main">
                    <span className="mi-label">{m.label}</span>
                    <span className="mi-desc">{m.desc}</span>
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="chat-input">
        <ResizableChatInput
          inputRef={editorRef}
          value={input}
          placeholder={workspaceEnabled?'输入工作区或服务器任务…':hosts.length === 0 ? '先在左侧添加一台服务器' : scopeCount === 0 ? '先在下方「机器」里勾选 AI 能操作的服务器' : '输入任务，回车发送…'}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); send(); }
          }}
        />
        <div className="chat-actions">
          <div className="scope-wrap">
            <button className="btn btn-sm mode-btn" title="选择 AI 可以操作哪些机器" onClick={() => setScopeMenu(!scopeMenu)}>
              机器 {scopeCount}/{hosts.length}
            </button>
            {scopeMenu && (
              <div className="dropdown-menu scope-menu">
                {hosts.length === 0 && <div className="menu-hint">还没有服务器，先去左侧添加</div>}
                {hosts.map((h) => (
                  <label key={h.id} className="scope-item">
                    <input type="checkbox" disabled={busy} checked={validScope.includes(h.id)} onChange={() => toggleScope(h.id)} />
                    <span className={'dot ' + dotOf(h)} />
                    <span className="si-name" title={h.name}>{h.name}</span>
                    <span className="si-addr" title={`${h.username}@${h.host}`}>{h.username}@{h.host}</span>
                  </label>
                ))}
                <div className="menu-note">AI 只会在勾选的机器上执行命令</div>
              </div>
            )}
          </div>
          <div className="ca-right">
            {workspaceSupported()&&<button className={'btn btn-sm'+(workspaceOpen?' on':'')} title="工作区" aria-label="工作区" onClick={()=>setWorkspaceOpen(value=>!value)}><FolderIcon size={14}/></button>}
            <div className="effort-wrap">
              <button className="btn btn-sm mode-btn" title="思考深度 — 参数会按模型自动翻译，不支持时自动忽略，不会报错" onClick={() => setEffortMenu(!effortMenu)}>
                思考·{curEffort.label}
              </button>
              {effortMenu && (
                <div className="dropdown-menu mode-menu">
                  {EFFORTS.map((ef) => (
                    <button key={ef.id} className={'menu-item' + (ef.id === effort ? ' on' : '')} onClick={() => pickEffort(ef)}>
                      <span className="mi-main">
                        <span className="mi-label">{ef.label}</span>
                        <span className="mi-desc">{ef.desc}</span>
                      </span>
                    </button>
                  ))}
                  <div className="menu-note">参数按模型自动翻译；不支持时自动忽略，不会报错</div>
                </div>
              )}
            </div>
            <button className="btn btn-sm primary" onClick={send} disabled={noModel || !input.trim()}>{busy || paused || queue.length?'加入队列':'发送'}</button>
          </div>
        </div>
      </div>
    </div>
  );
}
