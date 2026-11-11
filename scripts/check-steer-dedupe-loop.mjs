/**
 * 【插话双写·agent loop 那一半】—— 2026-11-11
 *
 * 主人 2026-11-11 说清了他的真实用法：
 *   「我以前的插话消息全是走的直接回车，然后点【直接发送】」
 * ——也就是说插话这条路是他的**主路径**，不是边缘情况。所以它必须确定性可验。
 *
 * 验收的场景（真跑 agent loop，假上游，不联网）：
 *   首字延迟窗口里 /api/interject 判「没在跑」，把主人的话**带 _steer 直推进历史**；
 *   前端随后重发同一句（撞 409）→ 改走 steer → 这句又被塞进信箱 →
 *   agent loop 在下一步 drainSteps 取到它 —— **不能**再 push 第二份。
 *
 * 这条检查钉两件事：
 *   ① 历史里已经有那份（带 _steer、同文）→ 取信箱时跳过，上游请求里只出现一次；
 *   ② 历史里没有（正常插话）→ 照常插进去，一次不丢。
 *
 * 跑法：node scripts/check-steer-dedupe-loop.mjs
 */
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const data = fs.mkdtempSync(path.join(os.tmpdir(), 'xy-steer-dup-loop-'));
process.env.MINI_AGENT_DATA = data;
fs.mkdirSync(path.join(data, '.state'), { recursive: true });

let pass = 0, fail = 0;
const ok = (cond, name, extra) => {
  if (cond) { pass++; console.log('  OK   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '  — ' + extra : '')); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms = 8000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (fn()) return true; await sleep(20); }
  return false;
}

/* ── 假上游（照 _t_steer.mjs 的 SSE 写法，不然测的是没在用的非流式路）──────── */
const bodies = [];
let release = null;
let replyFor = () => null;
function sseChunk(obj) { return 'data: ' + JSON.stringify(obj) + '\n\n'; }
function writeSse(res, msg) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
  if (msg && Array.isArray(msg.toolCalls) && msg.toolCalls.length) {
    res.write(sseChunk({
      id: 'chatcmpl-fake',
      choices: [{
        index: 0,
        delta: {
          role: 'assistant',
          tool_calls: msg.toolCalls.map((tc, i) => ({
            index: i, id: tc.id, type: 'function',
            function: { name: tc.name, arguments: tc.arguments },
          })),
        },
      }],
    }));
  } else if (msg && msg.text) {
    res.write(sseChunk({ id: 'chatcmpl-fake', choices: [{ index: 0, delta: { role: 'assistant', content: msg.text } }] }));
  }
  res.write(sseChunk({
    id: 'chatcmpl-fake',
    choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
    usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
  }));
  res.write('data: [DONE]\n\n');
  res.end();
}

const up = http.createServer((req, res) => {
  let buf = '';
  req.on('data', (c) => (buf += c));
  req.on('end', async () => {
    let j = null;
    try { j = JSON.parse(buf); } catch { j = null; }
    bodies.push(j);
    const n = bodies.length;
    if (n === 1) await new Promise((r) => { release = r; });   // 第一次先挂住，等我们把话插进去
    writeSse(res, replyFor(n));
  });
});
await new Promise((r) => up.listen(0, '127.0.0.1', r));
const upPort = up.address().port;
fs.writeFileSync(path.join(data, '.state', 'models.json'), JSON.stringify({
  models: [{ id: 'fakeup', baseURL: `http://127.0.0.1:${upPort}/v1`, apiKey: 'sk-fake', model: 'fake-model' }],
  activeId: 'fakeup',
  hideEnv: true,
}));

const inbox = await import('../src/inbox.mjs');
const agent = await import('../src/agent.mjs');

const SID = 'zz-steer-dup';
const userTexts = () => {
  const b = bodies[bodies.length - 1] || {};
  const ms = Array.isArray(b.messages) ? b.messages : [];
  return ms.filter((m) => m && m.role === 'user').map((m) => String(m.content ?? ''));
};
const countIn = (arr, s) => arr.filter((t) => t.includes(s)).length;

/* ── ① 直推那份已经在历史里 → 取信箱时不能再落第二份 ─────────────── */
console.log('\n① 直推的那份已带 _steer 躺在队尾 → 信箱里同一句不再重复插入');
{
  bodies.length = 0;
  release = null;
  inbox.clearInbox(SID);
  replyFor = (n) => (n === 1
    ? { toolCalls: [{ id: 'call_1', name: 'list_dir', arguments: '{"path":"."}' }] }
    : { text: '两件事都办了。' });

  const CHAT = '顺便说一句：别删任何文件';
  const history = [
    { role: 'user', content: '先把目录列一下' },
    /* 这就是 /api/interject 判「没在跑」时直推进来的那份 */
    { role: 'user', content: CHAT, _steer: true, at: Date.now() },
  ];

  const events = [];
  const p = agent.runAgent({ messages: history, sessionId: SID, onEvent: (e) => events.push(e) });
  ok(await waitFor(() => bodies.length === 1), '第 1 次请求发出去了（她正在干活）');

  /* 前端重发同一句撞 409 之后塞进信箱的那一份 */
  inbox.steer(SID, CHAT);
  ok(inbox.inboxCount(SID) === 1, '信箱里确实压了一份同文插话');
  if (release) release();
  await p;

  const u = userTexts();
  ok(bodies.length >= 2, '她跑到了第 2 次请求', 'requests=' + bodies.length);
  ok(countIn(u, '别删任何文件') === 1, '第 2 次请求里这句只出现一次（不再双写）', '出现 ' + countIn(u, '别删任何文件') + ' 次: ' + JSON.stringify(u).slice(0, 160));
  ok(inbox.inboxCount(SID) === 0, '信箱取空了（不会再来一遍）');
}

/* ── ② 正常插话（历史里没有那份）→ 必须照常插进去，一次不丢 ────────── */
console.log('\n② 正常插话：历史里没有同文 → 照常插进下一步');
{
  bodies.length = 0;
  release = null;
  inbox.clearInbox(SID);
  replyFor = (n) => (n === 1
    ? { toolCalls: [{ id: 'call_2', name: 'list_dir', arguments: '{"path":"."}' }] }
    : { text: '好，我停下等你说。' });

  const CHAT = '先等等，别动那个文件';
  const history = [{ role: 'user', content: '把文件改一下' }];
  const events = [];
  const p = agent.runAgent({ messages: history, sessionId: SID, onEvent: (e) => events.push(e) });
  ok(await waitFor(() => bodies.length === 1), '第 1 次请求发出去了');
  inbox.steer(SID, CHAT);
  if (release) release();
  await p;

  const u = userTexts();
  ok(countIn(u, '别动那个文件') === 1, '插话照常进了下一步（且只有一次）', JSON.stringify(u).slice(0, 160));
  ok((u[u.length - 1] || '').includes('别动那个文件'), '而且是她下一步先看到的那条');
  ok(inbox.inboxCount(SID) === 0, '信箱取空');
}

/* ── ③ 主人真想说两遍（中间她答过话）→ 不许吞 ───────────────────── */
console.log('\n③ 中间她答过话 → 同样的再来一句照常插（不吞）');
{
  bodies.length = 0;
  release = null;
  inbox.clearInbox(SID);
  replyFor = (n) => (n === 1
    ? { text: '第一句我记下了。' }
    : { text: '第二句也记下了。' });

  const CHAT = '这句话我要说两遍';
  const history = [
    { role: 'user', content: '开头' },
    { role: 'user', content: CHAT, _steer: true, at: Date.now() },
    { role: 'assistant', content: '第一句我记下了。' },   // ← 她答过了
  ];
  const events = [];
  const p = agent.runAgent({ messages: history, sessionId: SID, onEvent: (e) => events.push(e) });
  ok(await waitFor(() => bodies.length === 1), '第 1 次请求发出去了');
  inbox.steer(SID, CHAT);
  if (release) release();
  await p;

  const u = userTexts();
  ok(countIn(u, '说两遍') === 2, '她答过之后再说一遍 → 两条都在（没被误吞）', '出现 ' + countIn(u, '说两遍') + ' 次');
}

console.log('\n──────────────────────');
console.log('结果: ' + pass + ' 过 / ' + fail + ' 挂');
console.log('──────────────────────');
try { up.close(); } catch {}
try { fs.rmSync(data, { recursive: true, force: true }); } catch {}
process.exit(fail ? 1 : 0);
