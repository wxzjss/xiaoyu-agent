const BASE = process.env.BASE || 'http://127.0.0.1:8788';
import fs from 'node:fs';

const api = async (p, o) => {
  const r = await fetch(BASE + p, o);
  const t = await r.text();
  let j = null; try { j = JSON.parse(t); } catch {}
  return { status: r.status, text: t, json: j };
};
const post = (p, b) => api(p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b || {}) });

let pass = 0, total = 0;
const chk = (name, ok, extra) => { total++; if (ok) { pass++; console.log('  [ok] ' + name + (extra ? '  ' + extra : '')); } else console.log('  [FAIL] ' + name + (extra ? '  ' + extra : '')); };

const ag = await (await fetch(BASE + '/api/agents')).json();
const byName = Object.fromEntries(ag.agents.map((a) => [a.name, a]));
const BX = byName['小白曦'];

async function newSid(title) {
  const r = await post('/api/sessions/new', { title });
  const id = r.json?.session?.id || r.json?.id;
  if (!id) throw new Error('建会话失败: ' + r.text.slice(0, 200));
  return id;
}
async function setRoster(sid, ids) {
  await post('/api/agents/group', { sessionId: sid, agentIds: ids });
  await post('/api/agents/group/order', { sessionId: sid, agentIds: ids });
}
function chat(sid, text) {
  return new Promise((resolve) => {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 90000);
    let fbuf = ''; const order = []; let otherDup = 0; const seen = {};
    fetch(BASE + '/api/chat', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: sid, message: text }), signal: ctl.signal,
    }).then(async (r) => {
      const rd = r.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { done, value } = await rd.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop() || '';
        for (const ln of lines) {
          if (!ln.startsWith('data: ')) continue;
          let ev; try { ev = JSON.parse(ln.slice(6)); } catch { continue; }
          if (ev.type === 'text' && typeof ev.text === 'string') { fbuf += ev.text; continue; }
          if (ev.type === 'agent' && ev.who) {
            if (fbuf.trim() && !order.includes('小鱼')) order.push('小鱼');
            seen[ev.who] = (seen[ev.who] || 0) + 1;
            if (seen[ev.who] > 1) otherDup++;
            if (!order.includes(ev.who)) order.push(ev.who);
            continue;
          }
          if (ev.type === 'done') { if (fbuf.trim() && !order.includes('小鱼')) order.push('小鱼'); }
        }
      }
      clearTimeout(timer);
      resolve({ order, fbuf, otherDup, seen });
    }).catch(() => { clearTimeout(timer); resolve({ order, fbuf, otherDup, seen }); });
  });
}

// ---- 1. 叫才应的人（小鲸打勾）排在上面，不该被硬拉出来 ----
console.log('=== 1. 叫才应的人不主动开口 ===');
const s1 = await newSid('__r3a__');
await setRoster(s1, ['xiaojing', 'xiaoyu']);
await post('/api/fish', { sessionId: s1, on: true });
await post('/api/whale', { sessionId: s1, on: true });
await post('/api/agents/quiet', { id: 'xiaojing', quiet: true });
const r1 = await chat(s1, '你好');
const whaleSpoke = (r1.seen && r1.seen['小鲸']) || 0;
chk('小鲸打勾+没点名 → 她没被提前拉出来', whaleSpoke <= 1, '小鲸说了 ' + whaleSpoke + ' 次');
await post('/api/agents/quiet', { id: 'xiaojing', quiet: false });

// ---- 2. 自建卡落盘标记是 _card 不是 _whale ----
console.log('=== 2. 自建卡落盘标记 ===');
const s2 = await newSid('__r3b__');
await setRoster(s2, [BX.id, 'xiaoyu', 'xiaojing']);
await post('/api/fish', { sessionId: s2, on: true });
await post('/api/whale', { sessionId: s2, on: false });
const r2 = await chat(s2, '各说一句');
await new Promise((r) => setTimeout(r, 800));
let disk = null;
for (const f of fs.readdirSync('C:/Users/35453/AppData/Roaming/小鱼Agent/data/.state/sessions')) {
  if (!f.endsWith('.json')) continue;
  try {
    const j = JSON.parse(fs.readFileSync('C:/Users/35453/AppData/Roaming/小鱼Agent/data/.state/sessions/' + f, 'utf8'));
    if (j.id === s2) { disk = j; break; }
  } catch {}
}
const msgs = (disk && disk.messages) || [];
const bxMsg = msgs.find((m) => m._who === BX.name);
chk('小白曦落盘了', !!bxMsg);
chk('自建卡标的是 _card', !!(bxMsg && bxMsg._card), bxMsg ? ('_card=' + (bxMsg._card || '无') + ' _whale=' + (bxMsg._whale || '无')) : '');
chk('自建卡没被错标成 _whale', !(bxMsg && bxMsg._whale));

// ---- 3. 小鲸不在一轮里说两遍 ----
console.log('=== 3. 小鲸不说两遍 ===');
const s3 = await newSid('__r3c__');
await setRoster(s3, ['xiaojing', 'xiaoyu']);
await post('/api/fish', { sessionId: s3, on: true });
await post('/api/whale', { sessionId: s3, on: true });
const r3 = await chat(s3, '小鲸你在吗');
const w3 = (r3.seen && r3.seen['小鲸']) || 0;
chk('小鲸一轮最多说一遍', w3 <= 1, '说了 ' + w3 + ' 次');

// ---- 4. 顺序仍然对 ----
console.log('=== 4. 顺序没被改坏 ===');
const s4 = await newSid('__r3d__');
await setRoster(s4, [BX.id, 'xiaoyu']);
await post('/api/fish', { sessionId: s4, on: true });
await post('/api/whale', { sessionId: s4, on: false });
const r4 = await chat(s4, '各说一句');
chk('小白曦在上 → 她先说', r4.order[0] === BX.name, JSON.stringify(r4.order));

// 清理
for (const sid of [s1, s2, s3, s4]) { try { await post('/api/sessions/delete', { sessionId: sid }); } catch {} }
console.log('\n── 断言：' + pass + '/' + total + ' ──');
process.exit(pass === total ? 0 : 1);
