/**
 * 临时端到端验证（跑完就删）：
 * 用假上游 SSE 把主人遇到的那一段完完整整喂给 streamChat，
 * 看它是不是「文字不外泄 + 工具真的交出去」。
 *
 * 用独立数据目录（MINI_AGENT_DATA 指向临时目录）跑，不碰正在用的实例。
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const DATA = process.env.MINI_AGENT_DATA;
if (!DATA) { console.log('✘ 需要 MINI_AGENT_DATA'); process.exit(1); }
fs.mkdirSync(path.join(DATA, '.state'), { recursive: true });

const REAL = '<tool_call name="plan">\n<parameter name="action">update</｜｜DSML｜｜ parameter>';

const sse = (obj) => 'data: ' + JSON.stringify(obj) + '\n\n';
const chunks = [
  sse({ choices: [{ index: 0, delta: { content: '好的，我调用一下。' } }] }),
  sse({ choices: [{ index: 0, delta: { content: '<tool_call name="plan">' } }] }),
  sse({ choices: [{ index: 0, delta: { content: '\n<parameter name="action">update</｜｜DSML｜｜ parameter>' } }] }),
  sse({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }),
  'data: [DONE]\n\n',
];

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
  for (const c of chunks) res.write(c);
  res.end();
});

await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

fs.writeFileSync(path.join(DATA, '.state', 'models.json'), JSON.stringify({
  activeId: 'fake',
  models: [{ id: 'fake', name: 'fake', baseURL: 'http://127.0.0.1:' + port + '/v1', model: 'fake-model', apiKey: 'sk-test', kind: 'chat' }],
}), 'utf8');

const L = await import('../src/llm.mjs');

let text = '';
let calls = [];
try {
  for await (const ev of L.streamChat({
    messages: [{ role: 'user', content: '更新一下计划' }],
    tools: [{ type: 'function', function: { name: 'plan', description: 'x', parameters: { type: 'object', properties: {} } } }],
    signal: undefined,
    sessionId: '__e2e__',
  })) {
    if (ev.type === 'text') text += ev.text;
    if (ev.type === 'tool_calls') calls = ev.toolCalls;
  }
} catch (e) {
  console.log('流抛错:', String(e && e.message).slice(0, 120));
}
server.close();

const bad = [];
const ok = (name, cond, extra = '') => { if (!cond) bad.push(name); console.log((cond ? '  [ok] ' : '  [!!] ') + name + (extra ? '  ' + extra : '')); };

console.log('实得 text =', JSON.stringify(text));
console.log('实得 tool_calls =', JSON.stringify(calls));

ok('屏幕上没有 tool_call 残渣', text.indexOf('<tool_call') < 0 && text.indexOf('parameter') < 0, JSON.stringify(text));
ok('工具被真的交出去（1 个）', calls.length === 1, String(calls.length));
ok('工具名是 plan', calls[0] && calls[0].name === 'plan', String(calls[0] && calls[0].name));
ok('参数 action=update', calls[0] && JSON.parse(calls[0].arguments).action === 'update', String(calls[0] && calls[0].arguments));
ok('标记前那句正常话保住了', text.indexOf('好的，我调用一下。') >= 0, JSON.stringify(text));

console.log(bad.length ? '端到端失败 ' + bad.length + ' 项' : '端到端全过');
process.exit(bad.length ? 1 : 0);
