import React, { useEffect, useState } from 'react';
import { api } from '../api.js';
import DataBackup from './DataBackup.jsx';
import MemorySettings from './MemorySettings.jsx';
import McpSettings from './McpSettings.jsx';

const rand = (p) => p + '_' + Math.random().toString(36).slice(2, 10);

// 常用服务商模板：一键填 Base URL；没拉到模型列表时提供常用模型兜底
const PRESETS = [
  { key: 'glm', label: '智谱 GLM', hosts: ['bigmodel.cn'], baseURL: 'https://open.bigmodel.cn/api/paas/v4', keySite: 'open.bigmodel.cn', models: ['glm-4.6', 'glm-4.5', 'glm-4.5-air', 'glm-4.5-flash', 'glm-4.5v'] },
  { key: 'deepseek', label: 'DeepSeek', hosts: ['deepseek.com'], baseURL: 'https://api.deepseek.com/v1', keySite: 'platform.deepseek.com', models: ['deepseek-chat', 'deepseek-reasoner'] },
  { key: 'openai', label: 'OpenAI', hosts: ['openai.com'], baseURL: 'https://api.openai.com/v1', keySite: 'platform.openai.com', models: ['gpt-4o', 'gpt-4o-mini', 'gpt-4.1', 'gpt-4.1-mini'] },
  { key: 'kimi', label: 'Kimi', hosts: ['moonshot.cn', 'moonshot.ai'], baseURL: 'https://api.moonshot.cn/v1', keySite: 'platform.moonshot.cn', models: ['kimi-k2-0905-preview', 'kimi-k2-turbo-preview', 'moonshot-v1-8k'] },
  { key: 'siliconflow', label: '硅基流动', hosts: ['siliconflow'], baseURL: 'https://api.siliconflow.cn/v1', keySite: 'cloud.siliconflow.cn', models: ['deepseek-ai/DeepSeek-V3.1', 'Qwen/Qwen3-235B-A22B-Instruct', 'moonshotai/Kimi-K2-Instruct'] },
  { key: 'ollama', label: 'Ollama 本地', hosts: ['11434'], baseURL: 'http://127.0.0.1:11434/v1', keySite: '（本地无需 Key）', models: [] },
  { key: 'lmstudio', label: 'LM Studio 本地', hosts: ['1234'], baseURL: 'http://127.0.0.1:1234/v1', keySite: '（本地无需 Key）', models: [] }
];

function presetFor(baseURL) {
  try {
    const host = new URL(baseURL).host;
    return PRESETS.find((pr) => pr.hosts.some((h) => host.includes(h))) || null;
  } catch {
    return null;
  }
}

export default function SettingsView() {
  const [s, setS] = useState(null);
  const [err, setErr] = useState('');
  const [saved, setSaved] = useState(false);
  const [testState, setTestState] = useState({});   // providerId -> {loading, ok, msg}
  const [chatTest, setChatTest] = useState({});     // modelId -> {loading, ok, msg}
  const [fetchBox, setFetchBox] = useState(null);   // {providerId, models, picked, filter}
  const [showPresets, setShowPresets] = useState({}); // providerId -> bool 显示常用模型行
  const [manual, setManual] = useState({ providerId: '', value: '' }); // 手动输入模型名
  const [newProv, setNewProv] = useState(null);
  const [zoomPct, setZoomPct] = useState(() => Math.round(parseFloat(localStorage.getItem('shellpilot-zoom') || '1') * 100));
  const [hostKeys, setHostKeys] = useState([]);
  const loadSettings=()=>api('/settings','GET',undefined,{timeoutMs:10000}).then(value=>{setS(value);setErr('');}).catch(e=>setErr(e.message));

  useEffect(() => {
    loadSettings();
    const refreshKeys = () => api('/ssh/host-keys').then(setHostKeys).catch(() => {});
    refreshKeys();
    const timer = setInterval(refreshKeys, 6000);
    return () => clearInterval(timer);
  }, []);
  const trustKey = async (key) => {
    try { await api('/ssh/trust', 'POST', {hostId:key.hostId,fingerprint:key.fingerprint}); setHostKeys((items) => items.filter((item) => item.key !== key.key)); }
    catch (error) { setErr(error.message); }
  };

  const save = async (next) => {
    setErr('');
    try {
      await api('/settings', 'PUT', next);
      setS(next);
      setSaved(true);
      setTimeout(() => setSaved(false), 1500);
      return true;
    } catch (e) {
      setErr(e.message);
      return false;
    }
  };

  if (err && !s) return <div className="settings"><div className="form-err">{err}</div><button className="btn" onClick={()=>{setErr('');loadSettings();}}>重新加载配置</button></div>;
  if (!s) return <div className="settings"><div className="empty-center">加载中…</div></div>;

  const providerName = (id) => s.providers.find((p) => p.id === id)?.name || '（服务商已删除）';
  const defaultModel = s.models.find((m) => m.id === s.defaultModelId);

  // ---------- 服务商 ----------
  const updProvider = (id, patch) =>
    setS((prev) => ({ ...prev, providers: prev.providers.map((p) => (p.id === id ? { ...p, ...patch } : p)) }));

  const saveProvider = async (p) => {
    if (!p.baseURL.trim()) { setErr('Base URL 不能为空'); return; }
    await save({ ...s, providers: s.providers.map((x) => (x.id === p.id ? p : x)) });
  };

  const delProvider = async (id) => {
    if (!confirm('确定删除这个服务商？它下面的模型也会一起删除。')) return;
    const models = s.models.filter((m) => m.providerId !== id);
    const def = models.some((m) => m.id === s.defaultModelId) ? s.defaultModelId : (models[0]?.id || null);
    await save({ ...s, providers: s.providers.filter((p) => p.id !== id), models, defaultModelId: def });
  };

  const testProvider = async (p) => {
    setTestState((t) => ({ ...t, [p.id]: { loading: true } }));
    try {
      const r = await api('/ai/test', 'POST', { baseURL: p.baseURL, apiKey: p.apiKey });
      if (r.models.length) {
        setTestState((t) => ({ ...t, [p.id]: { ok: true, msg: `连接成功，拉到 ${r.count} 个模型` } }));
        setFetchBox({ providerId: p.id, models: r.models, picked: new Set(r.models.slice(0, 20)), filter: '' });
      } else {
        setTestState((t) => ({ ...t, [p.id]: { ok: true, msg: r.note || '连接成功，但没有模型列表' } }));
        setShowPresets((x) => ({ ...x, [p.id]: true }));
      }
    } catch (e) {
      setTestState((t) => ({ ...t, [p.id]: { ok: false, msg: e.message } }));
    }
  };

  // ---------- 模型 ----------
  const addModels = async (providerId, names) => {
    const exist = new Set(s.models.filter((m) => m.providerId === providerId).map((m) => m.name));
    const adds = names.filter((n) => n && !exist.has(n)).map((n) => ({ id: rand('m'), providerId, name: n }));
    if (!adds.length) return false;
    const models = [...s.models, ...adds];
    await save({ ...s, models, defaultModelId: s.defaultModelId || adds[0].id });
    return true;
  };

  const addPickedModels = async () => {
    const pid = fetchBox.providerId;
    const picked = [...fetchBox.picked];
    setFetchBox(null);
    await addModels(pid, picked);
  };

  const removeModel = async (id) => {
    const models = s.models.filter((m) => m.id !== id);
    const def = s.defaultModelId === id ? (models[0]?.id || null) : s.defaultModelId;
    await save({ ...s, models, defaultModelId: def });
  };

  const setDefault = async (id) => save({ ...s, defaultModelId: id });

  const addManualModel = async (providerId) => {
    const name = manual.value.trim();
    if (!providerId || !name) { setErr('先选服务商并填写模型名'); return; }
    setManual({ providerId: '', value: '' });
    await addModels(providerId, [name]);
  };

  // ---------- 对话连通性测试 ----------
  const runChatTest = async (p, m) => {
    setChatTest((t) => ({ ...t, [m.id]: { loading: true } }));
    try {
      const r = await api('/ai/chat-test', 'POST', { baseURL: p.baseURL, apiKey: p.apiKey, model: m.name });
      setChatTest((t) => ({ ...t, [m.id]: { ok: true, msg: `通！${r.ms}ms · 模型回复:「${r.reply}」` } }));
    } catch (e) {
      setChatTest((t) => ({ ...t, [m.id]: { ok: false, msg: e.message } }));
    }
  };

  // ---------- 新增服务商 ----------
  const addProvider = async () => {
    if (!newProv.name.trim() || !newProv.baseURL.trim()) { setErr('名称和 Base URL 都要填'); return; }
    const next = { ...s, providers: [...s.providers, { id: rand('p'), ...newProv }] };
    setNewProv(null);
    await save(next);
  };

  const pickTemplate = (pr) => setNewProv({ name: pr.label, baseURL: pr.baseURL, apiKey: '' });

  return (
    <div className="settings">
      <div className="settings-head">
        <h1>配置</h1>
        <div
          className="head-tray-switch"
          title="开启后，点击窗口关闭按钮 (X) 不会退出程序，而是最小化到系统托盘保持后台运行"
          onClick={() => save({ ...s, closeToTray: !s?.closeToTray })}
        >
          <span className="head-switch-label">关闭后后台运行</span>
          <button
            type="button"
            className={'mcp-toggle' + (s?.closeToTray ? ' on' : '')}
            title={s?.closeToTray ? '点击关闭后台运行' : '点击开启后台运行'}
          >
            <div className="mcp-toggle-knob" />
          </button>
        </div>
        <div className="zoom-controls">
          <span className="zoom-label">界面缩放</span>
          <select
            className="zoom-select"
            value={zoomPct}
            onChange={(e) => {
              const p = Number(e.target.value);
              setZoomPct(p);
              localStorage.setItem('shellpilot-zoom', String(p / 100));
              window.dispatchEvent(new Event('shellpilot-zoom'));
            }}
          >
            {[70, 80, 90, 100, 110, 125, 150].map((p) => (
              <option key={p} value={p}>{p}%</option>
            ))}
          </select>
        </div>
        {defaultModel && <span className="default-badge">当前默认模型：{defaultModel.name}</span>}
        {saved && <span className="saved-flash">✅ 已保存</span>}
      </div>

      {err && <div className="form-err">⚠️ {err}</div>}

      <div className="tip-line">
        任何 OpenAI 兼容接口都可以。API Key 只保存在你自己电脑的 <code>data/</code> 目录里，AI 永远看不到它。
        配完每个服务商后，点模型旁的 <code>⚡</code> 实测对话是否连通。
      </div>

      {/* ---------- 已有服务商 ---------- */}
      {s.providers.map((p) => {
        const t = testState[p.id] || {};
        const myModels = s.models.filter((m) => m.providerId === p.id);
        const preset = presetFor(p.baseURL);
        return (
          <div key={p.id} className="card prov-card">
            <div className="row" style={{ gap: 10 }}>
              <div style={{ flex: 1 }}>
                <label>名称</label>
                <input value={p.name} onChange={(e) => updProvider(p.id, { name: e.target.value })} />
              </div>
              <div style={{ flex: 3 }}>
                <label>Base URL <span className="hint">填到版本号为止，一般以 /v1 或 /v4 结尾</span></label>
                <input value={p.baseURL} onChange={(e) => updProvider(p.id, { baseURL: e.target.value })} />
              </div>
            </div>
            <label>API Key {preset && <span className="hint">去 {preset.keySite} 注册获取</span>}</label>
            <input type="password" value={p.apiKey || ''} onChange={(e) => updProvider(p.id, { apiKey: e.target.value })} placeholder="sk-…" />

            <div className="card-actions">
              <button className="btn primary" disabled={t.loading} onClick={() => testProvider(p)}>{t.loading ? '测试中…' : '测试并拉取模型'}</button>
              <button className="btn" onClick={() => saveProvider(p)}>保存修改</button>
              <button className="btn" onClick={() => setShowPresets((x) => ({ ...x, [p.id]: !x[p.id] }))}>＋ 常用模型</button>
              <button className="btn danger" onClick={() => delProvider(p.id)}>删除</button>
            </div>
            {t.msg && <div className={'inline-msg ' + (t.ok ? 'ok' : 'bad')}>{t.ok ? '✅' : '❌'} {t.msg}</div>}

            {/* 常用模型一键添加 */}
            {showPresets[p.id] && (
              <div className="preset-row">
                {(preset?.models || []).length ? (
                  preset.models.map((n) => (
                    <button key={n} className="preset-chip" onClick={() => addModels(p.id, [n])}>
                      ＋ {n}
                    </button>
                  ))
                ) : (
                  <span className="hint">没有这个服务商的内置模型名单，试试「测试并拉取」或手动输入</span>
                )}
                <input
                  className="manual-input"
                  placeholder="或输入模型名回车"
                  value={manual.providerId === p.id ? manual.value : ''}
                  onChange={(e) => setManual({ providerId: p.id, value: e.target.value })}
                  onKeyDown={(e) => { if (e.key === 'Enter') addManualModel(p.id); }}
                />
              </div>
            )}

            {/* 该服务商的模型列表 */}
            <div className="prov-models">
              <span className="sub-label">模型（{myModels.length}）：</span>
              {myModels.length === 0 && <span className="hint">还没有模型 —— 点上方按钮添加</span>}
              {myModels.map((m) => {
                const ct = chatTest[m.id] || {};
                const isDefault = s.defaultModelId === m.id;
                return (
                  <span key={m.id}>
                    <span
                      className={'model-chip' + (isDefault ? ' default' : '')}
                      title={isDefault ? '当前默认模型' : '点击设为默认模型'}
                      onClick={() => !isDefault && setDefault(m.id)}
                    >
                      <span className="star">{isDefault ? '★' : '☆'}</span>
                      <span className="model-name">{m.name}</span>
                      <button className="zap" title="实测对话连通性" disabled={ct.loading} onClick={(e) => { e.stopPropagation(); runChatTest(p, m); }}>{ct.loading ? '…' : '⚡'}</button>
                      <button className="chip-x" title="删除" onClick={(e) => { e.stopPropagation(); removeModel(m.id); }}>×</button>
                    </span>
                    {ct.msg && <span className={'inline-msg chip-msg ' + (ct.ok ? 'ok' : 'bad')}>{ct.ok ? '✅' : '❌'} {ct.msg}</span>}
                  </span>
                );
              })}
            </div>
          </div>
        );
      })}

      {/* ---------- 添加服务商 ---------- */}
      {newProv ? (
        <div className="card new-card">
          <div className="preset-row" style={{ marginBottom: 4 }}>
            <span className="sub-label">从模板填入：</span>
            {PRESETS.map((pr) => (
              <button key={pr.key} className={'preset-chip' + (newProv.baseURL === pr.baseURL ? ' on' : '')} onClick={() => pickTemplate(pr)}>
                {pr.label}
              </button>
            ))}
          </div>
          <div className="row" style={{ gap: 10 }}>
            <div style={{ flex: 1 }}>
              <label>名称</label>
              <input value={newProv.name} onChange={(e) => setNewProv({ ...newProv, name: e.target.value })} placeholder="GLM" />
            </div>
            <div style={{ flex: 3 }}>
              <label>Base URL</label>
              <input value={newProv.baseURL} onChange={(e) => setNewProv({ ...newProv, baseURL: e.target.value })} />
            </div>
          </div>
          <label>API Key</label>
          <input type="password" value={newProv.apiKey} onChange={(e) => setNewProv({ ...newProv, apiKey: e.target.value })} placeholder="sk-…" />
          <div className="card-actions">
            <button className="btn primary" onClick={addProvider}>添加</button>
            <button className="btn" onClick={() => setNewProv(null)}>取消</button>
          </div>
        </div>
      ) : (
        <button className="btn dashed" onClick={() => setNewProv({ name: '', baseURL: '', apiKey: '' })}>＋ 添加服务商</button>
      )}

      <div className="tip-line" style={{ marginTop: 8 }}>
        去哪拿 Key：智谱 open.bigmodel.cn · DeepSeek platform.deepseek.com · OpenAI platform.openai.com · Kimi platform.moonshot.cn · 硅基流动 cloud.siliconflow.cn
      </div>

      {/* ---------- AI 审批官 ---------- */}
      <div className="sec-title">AI 审批官（「AI 审批」模式的大脑）</div>
      <div className="tip-line">
        对话窗切到「AI 审批」模式后，危险命令不再弹窗问你，而是交给这个审批小模型自动判断放行还是拒绝；
        它还能自己跑只读命令收集证据。建议选便宜、响应快的模型（如 flash / mini / lite 系列）。审批全程记录在 audit.log。
      </div>
      <div className="card">
        <label>审批模型</label>
        <select
          value={s.approverModelId || ''}
          onChange={(e) => save({ ...s, approverModelId: e.target.value || null })}
        >
          <option value="">（未配置 —— 危险命令仍弹窗问你）</option>
          {s.models.map((m) => (
            <option key={m.id} value={m.id}>{m.name}（{providerName(m.providerId)}）</option>
          ))}
        </select>
        {s.approverModelId && (
          <div className="inline-msg ok" style={{ marginTop: 8 }}>
            已启用：危险命令将自动审批。切换到「AI 审批」模式即可使用。
          </div>
        )}
      </div>

      {/* ---------- 对话命名模型 ---------- */}
      <div className="sec-title">对话命名模型（可选）</div>
      <div className="tip-line">
        新对话默认用你的第一句话当名字；配置了这个模型后，会由 AI 起一个更短的标题（起名失败自动回退到第一句话）。建议用便宜、快的模型。
      </div>
      <div className="card">
        <label>命名模型</label>
        <select
          value={s.titleModelId || ''}
          onChange={(e) => save({ ...s, titleModelId: e.target.value || null })}
        >
          <option value="">（不配置 —— 用第一句话命名）</option>
          {s.models.map((m) => (
            <option key={m.id} value={m.id}>{m.name}（{providerName(m.providerId)}）</option>
          ))}
        </select>
      </div>

      <MemorySettings settings={s} onSave={save} />
      {/* ---------- 参数 ---------- */}
      <div className="sec-title">生成参数</div>
      <div className="card">
        <div className="row" style={{ gap: 10 }}>
          <div style={{ flex: 1 }}>
            <label>Temperature <span className="hint">控制随机性，不限制任务能力</span></label>
            <input type="number" step="0.1" min="0" max="2" value={s.params.temperature} onChange={(e) => setS((prev) => ({ ...prev, params: { ...prev.params, temperature: +e.target.value } }))} />
          </div>
          <div style={{ flex: 1 }}>
            <label>最大输出 tokens <span className="hint">0＝不设上限</span></label>
            <input type="number" step="256" min="0" value={s.params.maxTokens} onChange={(e) => setS((prev) => ({ ...prev, params: { ...prev.params, maxTokens: +e.target.value } }))} />
          </div>
          <div style={{ flex: 1 }}>
            <label>携带历史轮数 <span className="hint">0＝保留全部历史</span></label>
            <input type="number" step="1" min="0" value={s.params.historyLimit} onChange={(e) => setS((prev) => ({ ...prev, params: { ...prev.params, historyLimit: +e.target.value } }))} />
          </div>
        </div>
        <div className="row" style={{gap:10}}>
          <div style={{flex:1}}><label>任务最多工具轮数 <span className="hint">0＝不设上限</span></label><input type="number" min="0" value={s.params.maxSteps ?? 0} onChange={(e) => setS((prev) => ({...prev,params:{...prev.params,maxSteps:+e.target.value}}))} /></div>
          <div style={{flex:1}}><label>上下文字符预算 <span className="hint">0＝不裁剪上下文</span></label><input type="number" min="0" step="10000" value={s.params.contextChars ?? 0} onChange={(e) => setS((prev) => ({...prev,params:{...prev.params,contextChars:+e.target.value}}))} /></div>
        </div>
        <label>系统提示词（AI 的人设与规矩）</label>
        <textarea rows={4} value={s.systemPrompt} onChange={(e) => setS((prev) => ({ ...prev, systemPrompt: e.target.value }))} />
        <div className="card-actions">
          <button className="btn primary" onClick={() => save(s)}>保存参数</button>
        </div>
      </div>

      <DataBackup onImported={loadSettings}/>

      <div className="sec-title">SSH 服务器指纹</div>
      <div className="card">
        <div className="tip-line">首次连接自动保存指纹，以后自动验证。只有指纹变化才需要处理，直接在对应机器的内容区操作。</div>
        {hostKeys.length === 0 ? <div className="menu-note">没有待确认的服务器指纹</div> : hostKeys.map((key) => <div className="host-key" key={key.key}><b>{key.name || key.host}{key.changed ? ' · 指纹已变化' : ' · 首次连接'}</b><div>{key.host}:{key.port}</div><code>{key.fingerprint}</code>{key.previous && <div>原指纹：{key.previous}</div>}<div><button className="btn btn-sm" onClick={() => trustKey(key)}>核对并信任</button></div></div>)}
      </div>
      <McpSettings settings={s} onSave={save}/>

      <div className="sec-title">操作审计</div>
      <div className="tip-line">AI 每次执行命令都会记录在 <code>data/audit.log</code>，可随时查看它干了什么。</div>

      {/* ---------- 拉取模型弹窗 ---------- */}
      {fetchBox && (
        <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && setFetchBox(null)}>
          <div className="modal wide">
            <div className="modal-title">拉取到 {fetchBox.models.length} 个模型，勾选要添加的</div>
            <input className="fetch-filter" placeholder="搜索过滤…" value={fetchBox.filter} onChange={(e) => setFetchBox({ ...fetchBox, filter: e.target.value })} />
            <div className="fetch-actions">
              <button className="btn btn-sm" onClick={() => setFetchBox({ ...fetchBox, picked: new Set(fetchBox.models) })}>全选</button>
              <button className="btn btn-sm" onClick={() => setFetchBox({ ...fetchBox, picked: new Set() })}>清空</button>
              <span className="hint">已选 {fetchBox.picked.size} 个</span>
            </div>
            <div className="fetch-list">
              {fetchBox.models.filter((n) => n.toLowerCase().includes((fetchBox.filter || '').toLowerCase())).map((n) => (
                <label key={n} className="fetch-item">
                  <input
                    type="checkbox"
                    checked={fetchBox.picked.has(n)}
                    onChange={(e) => {
                      const picked = new Set(fetchBox.picked);
                      e.target.checked ? picked.add(n) : picked.delete(n);
                      setFetchBox({ ...fetchBox, picked });
                    }}
                  />
                  <span>{n}</span>
                </label>
              ))}
            </div>
            <div className="modal-actions">
              <button className="btn" onClick={() => setFetchBox(null)}>取消</button>
              <button className="btn primary" onClick={addPickedModels} disabled={!fetchBox.picked.size}>添加所选（{fetchBox.picked.size}）</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
