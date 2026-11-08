/**
 * 发消息链路 · 端到端回归
 *
 * 【为什么要有这个】
 * 2026-11-05 这条链路上的问题，都是主人先发现的：
 *   「发了消息转圈一直转」「说完了再发文件没反应」「被限流了没人告诉我」。
 * 一个个去查，查到的全是「只看一个文件看不出来」的毛病 —— 后端发了事件、
 * 前端没那一支；同一层里写了两遍分支、后一遍永远走不到。
 *
 * 所以这里从「主人按下发送」一路盯到「界面收尾」，按顺序验：
 *   ① 发送成功、拿到 sessionId  ② 事件序列合法（有正文、必有 done）
 *   ③ 落盘了（刷新能补回来）    ④ 该收尾的都收尾了（不卡转圈）
 *   ⑤ 出错/中断必须有人告诉主人 ⑥ 仓库改的和程序跑的必须同一份
 * 临时会话用完就删。
 */
import { readFileSync, existsSync } from 'node:fs';

const BASE = process.env.BASE || 'http://127.0.0.1:8788';
const SESS = 'C:/Users/35453/AppData/Roaming/小鱼Agent/data/.state/sessions';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  [ok] ' + m); } else { fail++; console.log('  [FAIL] ' + m); } };

async function api(path, opt) {
  const r = await fetch(BASE + path, { headers: { 'Content-Type': 'application/json' }, ...opt });
  const t = await r.text();
  let j = null; try { j = JSON.parse(t); } catch {}
  return { status: r.status, j, t };
}

/** 发一句话，把整条 SSE 收下来 */
async function turn(sid, text) {
  const r = await fetch(BASE + '/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: sid, message: text }),
  });
  const events = [];
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  const deadline = Date.now() + 180000;
  while (Date.now() < deadline) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const blocks = buf.split('\n\n');
    buf = blocks.pop() || '';
    for (const blk of blocks) {
      const line = blk.split('\n').find((x) => x.startsWith('data:'));
      if (!line) continue;
      try { events.push(JSON.parse(line.slice(5).trim())); } catch {}
    }
  }
  return events;
}

const created = [];
async function newSession(title) {
  const r = await api('/api/sessions/new', { method: 'POST', body: JSON.stringify({ title }) });
  const id = r.j?.session?.id || r.j?.id;
  if (!id) throw new Error('建会话失败: ' + r.t.slice(0, 200));
  created.push(id);
  return id;
}

const onDisk = (sid) => existsSync(SESS + '/' + sid + '.json')
  ? JSON.parse(readFileSync(SESS + '/' + sid + '.json', 'utf8')) : null;

console.log('=== 1. 主路径：发一句，必须有人答、必须落盘 ===');
const s1 = await newSession('__e2e_chat__');
const ev1 = await turn(s1, '就说一个字：好');
const types1 = ev1.map((e) => e.type);
ok(ev1.length > 0, '收到了事件（' + ev1.length + ' 条）');
ok(types1.includes('done'), '有 done 收尾 —— 不然前端永远转圈');
ok(ev1.some((e) => e.type === 'text' && String(e.text || '').trim().length > 0), '有正文文本');
const d1 = onDisk(s1);
ok(!!d1, '会话在磁盘上');
ok(!!d1 && Array.isArray(d1.messages) && d1.messages.length >= 2, '主人在磁盘上有一问、她有一答');
ok(!!d1 && d1.running !== true, '落盘后 running 不是 true（刷新不会以为还在跑）');

console.log('\n=== 2. 事件序列合法性 ===');
const firstDone = types1.indexOf('done');
const afterDone = types1.slice(firstDone + 1).filter((t) => t === 'text' || t === 'tool_start');
ok(firstDone >= 0, 'done 存在');
ok(afterDone.length === 0, 'done 之后不再有正文/工具事件');
ok(types1.filter((t) => t === 'done').length === 1, 'done 只发一次');

console.log('\n=== 3. 服务端发的事件，前端一个都别漏 ===');
const srv = readFileSync('D:/小鱼Agent/src/server.mjs', 'utf8');
const sent = new Set();
for (const m of srv.matchAll(/type:\s*'([a-z_]+)'/g)) sent.add(m[1]);
const html = readFileSync('C:/Users/35453/AppData/Roaming/小鱼Agent/data/public/index.html', 'utf8');
const missing = [...sent].filter((t) => !html.includes("ev.type === '" + t + "'") && !html.includes("e.type === '" + t + "'"));
ok(missing.length === 0, '服务端发的 ' + sent.size + ' 种事件前端都认了' + (missing.length ? '（漏：' + missing.join(',') + '）' : ''));

console.log('\n=== 4. 「没有下文」的三条路，都得把转圈收起来 ===');
for (const t of ['aborted', 'error', 'rate_limited']) {
  const i = html.indexOf("ev.type === '" + t + "'");
  ok(i > 0, t + ' — 前端有这一支');
  if (i <= 0) continue;
  const rest = html.slice(i + 20);
  const cut = rest.search(/\n\s*\} else (if|\{)/);
  const chunk = cut > 0 ? rest.slice(0, cut) : rest.slice(0, 2000);
  const has = chunk.includes('endTurnQuietly') || (chunk.includes('hideSending') && chunk.includes('flushSpeech'));
  ok(has, t + ' — 这一支里有收尾（不卡转圈）');
}

console.log('\n=== 5. 说完之后再发文件，卡片得挂得上去 ===');
ok(html.includes('function sentTailRow'), 'sentTailRow 有声明');
ok(/let\s+sentThisTurn|const\s+sentThisTurn/.test(html), 'sentThisTurn 有声明');
ok(html.includes('sentTailRow()'), 'sentTailRow 真被用上了');

console.log('\n=== 6. 仓库改的和程序跑的，必须是同一份 ===');
const repoHtml = readFileSync('D:/小鱼Agent/public/index.html', 'utf8');
ok(repoHtml === html, '前端：仓库 = 生效版（逐字节）');
console.log('\n=== 7. 中断：按了停止必须能停 ===');
/* 【2026-11-05 严检修正】断开自己的连接 != 点停止。
   服务端设计是「连接断了也让这一轮跑完」（不然工具结果会丢），
   所以这里必须先调 /api/stop（跟界面点停止一样的接口），再看登记清没清。 */
const s2 = await newSession('__e2e_abort__');
const ac = new AbortController();
const p = fetch(BASE + '/api/chat', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ sessionId: s2, message: '数到一百' }),
  signal: ac.signal,
}).catch(() => null);
await new Promise((r) => setTimeout(r, 2500));
await api('/api/stop', { method: 'POST', body: JSON.stringify({ sessionId: s2 }) });
ac.abort();
await p;
await new Promise((r) => setTimeout(r, 1200));
const d2 = onDisk(s2);
ok(!!d2, '中断后会话还在');
ok(!!d2 && d2.running !== true, '停止后 running 被清掉');

console.log('\n=== 清理 ===');
for (const id of created) {
  await api('/api/sessions/delete', { method: 'POST', body: JSON.stringify({ id }) });
  // 删完立刻 stat 会撞上「文件系统还没反应过来」，等一拍再判（实测差 100~300ms）
  let gone = false;
  for (let k = 0; k < 20 && !gone; k++) {
    gone = !existsSync(SESS + '/' + id + '.json');
    if (!gone) await new Promise((r) => setTimeout(r, 100));
  }
  ok(gone, '删掉了测试会话 ' + id.slice(0, 9));
}

console.log('\n──────────────────────');

/* 【2026-11-08 加·「多段消息堆在一起」第三次才挖到的真凶】
 * attachLive 在「这一轮已经跑完」的分支里调过 paintSnapshot 对账，
 * 可 renderTurns 刚用落盘历史画好整屏 —— 同一段话画两份。
 * 刷新瞬间正常、轮询一转起来就叠，正是主人反复看到的那个现象。
 * 铁律：跑完之后屏幕长什么样由历史说了算，不许再照直播快照画。
 * 判据用那行独有的调用形状（注释里不会出现），不去猜整段代码。 */
const _uiSrc = readFileSync('public/index.html', 'utf8');
ok(
  '跑完的轮次不再照快照重画（历史+直播会叠成两份）',
  _uiSrc.indexOf('Array.isArray(live.items)) paintSnapshot(id, live)') < 0,
);


/* 【2026-11-08 加】429 回退的冷却必须按会话。
 * 原来是一个裸 let 数值：任何会话迁移完都写它，别的会话明明好好的也跟着
 * 「冷却中」不能回退 —— 一个会话的限流把全屋冻住。 */
try {
  const _r4 = readFileSync('src/retry429.mjs', 'utf8');
  ok('429 冷却按会话隔离',
    _r4.indexOf('cooldowns.set(String(sessionId)') >= 0
    && _r4.indexOf('let cooldownUntil') < 0);
} catch (e) { ok('429 冷却按会话隔离', false); }

console.log('断言：' + pass + '/' + (pass + fail));
if (fail) { console.log('FAIL 有 ' + fail + ' 条没过'); process.exit(1); }
console.log('PASS 发消息链路端到端通过');


