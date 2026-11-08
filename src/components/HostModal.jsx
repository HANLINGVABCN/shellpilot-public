import React, { useState } from 'react';
import { api } from '../api.js';

export default function HostModal({ host, hosts = [], onClose, onSaved }) {
  const editing = !!host;
  const [f, setF] = useState({
    name: host?.name || '',
    host: host?.host || '',
    port: host?.port || 22,
    username: host?.username || 'root',
    group: host?.group || '',
    jumpHostId: host?.jumpHostId || '',
    authType: host?.authType || 'password',
    password: '',
    keyPath: host?.keyPath || '',
    keyContent: '',
    passphrase: ''
  });
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setF((p) => ({ ...p, [k]: e.target.value }));

  const existingGroups = Array.from(new Set(hosts.map((h) => (h.group || '').trim()).filter(Boolean)));
  const jumpCandidates = hosts.filter((h) => !editing || h.id !== host.id);

  const save = async () => {
    setErr('');
    if (!f.name.trim() || !f.host.trim() || !f.username.trim()) {
      setErr('名称、IP 地址、用户名都要填');
      return;
    }
    setBusy(true);
    try {
      if (editing) await api('/hosts/' + host.id, 'PUT', f);
      else await api('/hosts', 'POST', f);
      onSaved();
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal">
        <div className="modal-title">{editing ? '编辑服务器' : '添加服务器'}</div>
        <div className="form">
          <div className="row">
            <div style={{ flex: 2 }}>
              <label>备注名称 <span className="hint">比如「我的小鸡」</span></label>
              <input value={f.name} onChange={set('name')} placeholder="我的 VPS" />
            </div>
            <div style={{ flex: 1 }}>
              <label>所属分组 <span className="hint">可选</span></label>
              <input list="sp-host-groups" value={f.group} onChange={set('group')} placeholder="如：生产环境" />
              <datalist id="sp-host-groups">
                {existingGroups.map((g) => <option key={g} value={g} />)}
              </datalist>
            </div>
          </div>
          <div className="row">
            <div style={{ flex: 2 }}>
              <label>IP 地址 / 域名</label>
              <input value={f.host} onChange={set('host')} placeholder="1.2.3.4" />
            </div>
            <div style={{ flex: 1 }}>
              <label>端口</label>
              <input value={f.port} onChange={set('port')} placeholder="22" />
            </div>
          </div>
          <div className="row">
            <div style={{ flex: 1 }}>
              <label>登录用户名</label>
              <input value={f.username} onChange={set('username')} placeholder="root" />
            </div>
            <div style={{ flex: 1 }}>
              <label>跳板机 (ProxyJump) <span className="hint">可选任意其他机器中转</span></label>
              <select value={f.jumpHostId} onChange={set('jumpHostId')}>
                <option value="">直连（不使用跳板机）</option>
                {jumpCandidates.map((jh) => (
                  <option key={jh.id} value={jh.id}>{jh.name} ({jh.username}@{jh.host}:{jh.port || 22})</option>
                ))}
              </select>
            </div>
          </div>
          <label>认证方式</label>
          <div className="seg">
            <button className={f.authType === 'password' ? 'on' : ''} onClick={() => setF((p) => ({ ...p, authType: 'password' }))}>密码</button>
            <button className={f.authType === 'key' ? 'on' : ''} onClick={() => setF((p) => ({ ...p, authType: 'key' }))}>SSH 密钥</button>
          </div>
          {f.authType === 'password' ? (
            <>
              <label>密码</label>
              <input type="password" value={f.password} onChange={set('password')} placeholder={editing ? '留空则不修改' : '服务器密码'} />
            </>
          ) : (
            <>
              <label>私钥文件路径 <span className="hint">比如 C:\Users\你\.ssh\id_ed25519，两种方式选一种</span></label>
              <input value={f.keyPath} onChange={set('keyPath')} placeholder={editing && host?.keyPath ? host.keyPath : ''} />
              <label>或直接粘贴私钥内容 <span className="hint">-----BEGIN OPENSSH PRIVATE KEY----- 开头那段</span></label>
              <textarea rows={3} value={f.keyContent} onChange={set('keyContent')} placeholder={editing ? '留空则不修改' : '粘贴私钥内容'} />
              <label>密钥口令 <span className="hint">没设置过就留空</span></label>
              <input type="password" value={f.passphrase} onChange={set('passphrase')} placeholder="留空 = 无口令" />
            </>
          )}
          {err && <div className="form-err">⚠️ {err}</div>}
          <div className="modal-actions">
            <button className="btn" onClick={onClose}>取消</button>
            <button className="btn primary" disabled={busy} onClick={save}>{busy ? '保存中…' : '保存'}</button>
          </div>
        </div>
      </div>
    </div>
  );
}
