// 端到端验证：小鱼身份下提示词里还剩几个「主人」，以及「（心里）」标记是不是真的发出去了。
// 走真实 chat()，打到本地假上游，把 wire 里的 system / user 抓下来自己数。
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const data = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoyu-whoami-'));
process.env.MINI_AGENT_DATA = data;
fs.mkdirSync(path.join(data, '.state'), { recursive: true });

let captured = null;
const server = http.createServer((req, res) => {
  let buf = '';
  req.on('data', (c) => (buf += c));
  req.on('end', () => {
    try {
      captured = JSON.parse(buf);
    } catch {
      captured = null;
    }
    const body = {
      id: 'x',
      object: 'chat.completion',
      choices: [{ index: 0, message: { role: 'assistant', content: '嗯。' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

fs.writeFileSync(
  path.join(data, '.state', 'models.json'),
  JSON.stringify({
    models: [{ id: 'fakeup', baseURL: `http://127.0.0.1:${port}/v1`, apiKey: 'sk-fake', model: 'fake-model' }],
    activeId: 'fakeup',
    hideEnv: true,
  }),
);

const id = await import('./src/identity.mjs');
const llm = await import('./src/llm.mjs');
const agent = await import('./src/agent.mjs');

const fail = [];
const ok = (cond, msg) => {
  console.log((cond ? '  ✔ ' : '  ✘ ') + msg);
  if (!cond) fail.push(msg);
};

for (const who of ['fish', 'whale', 'owner']) {
  id.setIdentity(who, 'sess1');
  const sys = agent.systemPrompt('sess1');
  const ctx = agent.contextMessage('sess1');
  const nSys = (sys.match(/主人/g) || []).length;
  const nCtx = (ctx.match(/主人/g) || []).length;
  console.log(`\n=== 身份 ${who}：system 里「主人」${nSys} 次 / 规则副本里 ${nCtx} 次`);
  if (who === 'owner') {
    ok(nSys > 0, '主人身份原样保留（不动缓存前缀）');
  } else {
    ok(nSys === 0, `${who} 的 system 里没有「主人」`);
    // 小鲸身份例外一处：head 里那句「她不是你的主人」是对比，必要
    ok(nCtx === 0 || (who === 'whale' && nCtx <= 1), `${who} 的规则副本里没有多余的「主人」`);
  }
}

// 真发一次，看线上那份 wire 长什么样
id.setIdentity('fish', 'sess1');
const mv = await import('./src/merge-voice.mjs');
captured = null;
await llm.chat({
  messages: mv.mergeSameVoice([
    { role: 'system', content: agent.systemPrompt('sess1') },
    { role: 'user', content: agent.contextMessage('sess1'), context: true },
    { role: 'user', content: '在吗', _who: '主人' },
    { role: 'user', content: '（翻着手中的书）', _whoMade: true, _who: '小鱼' },
  ]),
  sessionId: 'sess1',
});

const sent = captured?.messages || [];
console.log('\n=== 线上真实发出的 messages：');
for (const m of sent) {
  const c = String(m.content ?? '');
  console.log(`  [${m.role}] ${c.replace(/\n/g, '⏎').slice(0, 90)}…`);
}
const all = sent.map((m) => String(m.content ?? '')).join('\n');
ok(!/主人/.test(all), '发出去的整份请求里一个「主人」都没有');
ok(all.includes('（心里）'), '「（心里）」标记确实发出去了');

server.close();
console.log(fail.length ? `\n✘ ${fail.length} 项没过` : '\n✔ 全部通过');
process.exit(fail.length ? 1 : 0);
