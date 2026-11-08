import React, { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import { ws } from '../ws.js';

// An ordinary page section. Never opens dialogs, overlays, or native confirmation.
export default function HostIdentityPrompt({ hostId, hosts }) {
  const [keys, setKeys] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const section = useRef(null);
  const targets = new Set();
  let target = hostId;
  while (target && !targets.has(target)) {
    targets.add(target);
    target = hosts.find((host) => host.id === target)?.jumpHostId;
  }
  // A background host can never insert a card into another machine's workspace.
  const current = keys.find((key) => targets.has(key.hostId) || key.retryHostId === hostId);
  useEffect(() => setError(''), [hostId, current?.fingerprint]);
  useEffect(() => {
    let live = true;
    const refresh = async (hostId) => {
      const records = await api('/ssh/host-keys').catch(() => null);
      if (!live || !Array.isArray(records)) return;
      setKeys(records);
    };
    refresh();
    const timer = setInterval(() => refresh(), 5000);
    const requested = (event) => refresh(event.detail?.hostId);
    window.addEventListener('shellpilot-ssh-identity', requested);
    const offRequired = ws.on('ssh-host-key-required', (message) => {
      if (!message.key?.fingerprint) return;
      setKeys((items) => [...items.filter((key) => key.key !== message.key.key), {...message.key,retryHostId:message.retryHostId}]);
    });
    const offTrusted = ws.on('ssh-host-key-trusted', (message) => {
      setKeys((items) => items.filter((key) => key.hostId !== message.hostId));
      refresh();
    });
    return () => {
      live = false; clearInterval(timer); offRequired(); offTrusted();
      window.removeEventListener('shellpilot-ssh-identity', requested);
    };
  }, []);
  const trust = async () => {
    if (!current || busy) return;
    const key = current;
    setBusy(true); setError('');
    try {
      await api('/ssh/trust', 'POST', { hostId: key.hostId, fingerprint: key.fingerprint });
      setKeys((items) => items.filter((item) => item.key !== key.key));
      window.dispatchEvent(new CustomEvent('shellpilot-ssh-identity-trusted', {detail:{hostId:key.hostId}}));
    } catch (error) { setError(error.message); }
    finally { setBusy(false); }
  };
  if (!current) return null;
  return <section ref={section} className="identity-panel" aria-labelledby="identity-title">
    <div className="identity-heading"><h2 id="identity-title">{current.changed ? '服务器身份已变化，连接已暂停' : '首次连接，等待保存服务器身份'}</h2></div>
    <div className="identity-server"><strong>{current.name || current.host}</strong><span>{current.host}:{current.port}</span></div>
    <p>{current.changed ? '指纹与之前保存的不同，请核实是否重装服务器或更换过 SSH 密钥。' : '已找到服务器。点击下面的按钮保存身份并继续连接，以后不再重复询问。'}</p>
    <div className="identity-fingerprint"><span>当前指纹</span><code>{current.fingerprint}</code></div>
    {current.previous && <div className="identity-fingerprint previous"><span>原指纹</span><code>{current.previous}</code></div>}
    <div className="identity-actions">
      <button className="btn primary" disabled={busy} onClick={trust}>{busy ? '正在保存并连接…' : current.changed ? '信任新指纹并连接' : '信任此服务器并连接'}</button>
    </div>
    {error && <p className="form-err" role="alert">{error}</p>}
  </section>;
}
