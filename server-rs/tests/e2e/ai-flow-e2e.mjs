// Mock OpenAI-compatible server + full AI agent loop E2E for the Rust backend.
// Usage: node ai-flow-e2e.mjs <backendPort> <hostId>
import http from 'node:http';

const [, , backendPort, hostId] = process.argv;

// ---------- mock OpenAI ----------
const model = 'mock-model';
const uid = Date.now().toString(36);
let call = 0;
const scripted = [
  // 第 1 轮：推理流 + 工具调用（自动放行的只读命令）
  { reasoning: ['先看', '一下目录'], toolCalls: [{ id: 'call_1', name: 'exec_command', args: { command: 'ls /etc | head -2 #" + uid + "', host: 'self-test' } }], content: '' },
  // 第 2 轮：写命令（触发人工审批），审批后执行
  { reasoning: ['再写个文件'], toolCalls: [{ id: 'call_2', name: 'exec_command', args: { command: 'touch /tmp/sp-ai-e2e-ok-" + uid + "', host: 'self-test' } }], content: '' },
  // 第 3 轮：收尾正文
  { reasoning: [], toolCalls: [], content: '任务完成：已查看目录并创建文件。' },
];

const server = http.createServer((req, res) => {
  if (req.method === 'POST' && req.url.endsWith('/chat/completions')) {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const step = scripted[Math.min(call, scripted.length - 1)];
      call += 1;
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
      for (const t of step.reasoning) send({ choices: [{ delta: { reasoning_content: t } }] });
      if (step.toolCalls.length) {
        for (const tc of step.toolCalls) {
          const args = JSON.stringify(tc.args);
          // 模拟分片流式 tool_calls
          send({ choices: [{ delta: { tool_calls: [{ index: 0, id: tc.id, function: { name: tc.name, arguments: '' } }] } }] });
          const half = Math.floor(args.length / 2);
          send({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: args.slice(0, half) } }] } }] });
          send({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: args.slice(half) } }] } }] });
        }
      }
      if (step.content) {
        for (const ch of step.content.match(/.{1,3}/gs) || []) send({ choices: [{ delta: { content: ch } }] });
      }
      send({ choices: [{ delta: {} }] });
      res.write('data: [DONE]\n\n');
      res.end();
    });
    return;
  }
  res.writeHead(404).end();
});
server.listen(9901, '127.0.0.1', () => console.log('mock-openai ready'));

const api = async (path, method = 'GET', body) => {
  const res = await fetch(`http://127.0.0.1:${backendPort}/api${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, data: await res.json().catch(() => null) };
};

await api('/settings', 'PUT', {
  providers: [{ id: 'p1', name: 'mock', baseURL: 'http://127.0.0.1:9901/v1', apiKey: 'k' }],
  models: [{ id: 'm1', providerId: 'p1', name: model }],
  defaultModelId: 'm1',
  params: { temperature: 0.3, maxTokens: 2048, historyLimit: 12 },
  systemPrompt: '你是测试助手。',
});

const seen = [];
const ws = new WebSocket(`ws://127.0.0.1:${backendPort}/ws`);
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  seen.push(m);
  if (m.type === 'tool-request') {
    // 收到审批卡片 → 批准并记住
    setTimeout(() => ws.send(JSON.stringify({ type: 'tool-approve', reqId: m.reqId, remember: true })), 150);
  }
};
await new Promise((r) => (ws.onopen = r));
ws.send(JSON.stringify({ type: 'chat-clear' }));
ws.send(JSON.stringify({ type: 'agent-scope', hostIds: [hostId] }));
await new Promise((r) => setTimeout(r, 200));
ws.send(JSON.stringify({ type: 'chat', text: '帮我看下/etc并创建文件', mode: 'ask', effort: 'off' }));

const done = await new Promise((resolve) => {
  const t = setTimeout(() => resolve(false), 30000);
  const check = setInterval(() => {
    if (seen.some((m) => m.type === 'chat-done')) { clearInterval(check); clearTimeout(t); resolve(true); }
  }, 200);
});

await new Promise((r) => setTimeout(r, 600));
const types = seen.map((m) => m.type);
const expect = (t) => types.includes(t);
const results = [];
const check = (name, ok) => { results.push([name, ok]); console.log(ok ? 'PASS' : 'FAIL', name); };
check('chat-start', expect('chat-start'));
check('chat-reasoning-delta', seen.some((m) => m.type === 'chat-reasoning-delta' && m.delta === '先看'));
check('chat-tool-start(exec_command)', seen.some((m) => m.type === 'chat-tool-start' && m.name === 'exec_command'));
check('chat-tool-end with real output', seen.some((m) => m.type === 'chat-tool-end' && (m.result || '').length > 0 && !m.result.startsWith('执行出错')));
check('tool-request approval card', expect('tool-request'));
const allDelta = seen.filter((m) => m.type === 'chat-delta').map((m) => m.delta).join('');
check('chat-delta final content', allDelta.includes('任务完成'));
check('chat-done', expect('chat-done'));
check('no error', !seen.some((m) => m.type === 'chat-done' && m.error));
const chats = await api('/chats/__global__');
check('chat persisted', chats.data.length > 0);
const detail = await api('/chats/__global__/' + chats.data[0].id);
const toolMsgs = (detail.data.messages || []).filter((m) => m.role === 'tool');
check('tool result persisted with judge/audit trail', toolMsgs.length === 2);
const audit = await api('/audit');
check('audit has exec entries', audit.data.some((a) => a.action === 'exec'));

// 「记住此命令」→ 第二次同命令应直接自动执行（不再弹审批）
call = 1; // 让 mock 重新走第 2 轮（touch 命令）
seen.length = 0;
ws.send(JSON.stringify({ type: 'chat', text: '再执行一次', mode: 'ask', effort: 'off' }));
await new Promise((resolve) => {
  const t = setTimeout(() => resolve(false), 20000);
  const check2 = setInterval(() => {
    if (seen.some((m) => m.type === 'chat-done')) { clearInterval(check2); clearTimeout(t); resolve(true); }
  }, 200);
});
await new Promise((r) => setTimeout(r, 400));
check('remembered command skips approval', !seen.some((m) => m.type === 'tool-request'));

for (const m of seen) { if (m.type === 'probe' || m.type === 'chat-reasoning-delta' || m.type === 'chat-delta') continue; console.log('EV:', JSON.stringify(m).slice(0, 200)); }
const failed = results.filter(([, ok]) => !ok);
console.log(failed.length ? `E2E-FAIL ${failed.length}` : 'E2E-ALL-PASS');
ws.close();
server.close();
process.exit(failed.length ? 1 : 0);
