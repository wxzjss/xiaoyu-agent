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

async function chat(sid, msg) {
  /* 【2026-11-06 修·没有超时会让整个回归卡死】
   * 实测：18:33 起卡在这一句足足 4 分半，日志一动不动、node 进程还活着。
   * 打的是 /api/chat，真在调模型 —— 上游慢或挂了它就无限等，
   * run-all-checks 永远跑不到最后一行，等于回归没跑。
   * 给个上限：超时就抛，让这条检查干脆地失败，而不是把整批拖死。
   */
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 90000);
  let r;
  let raw;
  try {
    r = await fetch(BASE + '/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId: sid, message: msg }), signal: ac.signal });
    /**
     * 【2026-11-06 再修·超时只管了 fetch，没管读流】
     *
     * 上面那个 timer 原来在 fetch 一返回就 clearTimeout 了 —— 可真正的等待在
     * `r.text()`：模型一个字一个字慢慢吐，或者干脆不吐完，读流那一段照样无限等。
     * 实测整批回归卡在这一条 8 分多钟，前面 20 条全绿也没用。
     * 现在把「发请求 + 读完」整个盖在同一个超时里。
     */
    raw = await r.text();
  } catch (e) {
    console.log('  ✘ 调用超时（90 秒没读完），上游模型太慢或挂了');
    process.exitCode = 1;
    throw e;
  } finally {
    clearTimeout(timer);
  }
  const seq = [];
  let fbuf = '';
  const noteFish = () => { if (fbuf.trim() && !seq.includes('小鱼')) seq.push('小鱼'); };
  for (const blk of raw.split('\n\n')) {
    const l = blk.split('\n').find((x) => x.startsWith('data:'));
    if (!l) continue;
    let ev; try { ev = JSON.parse(l.slice(5).trim()); } catch { continue; }
    if (ev.type === 'text' && typeof ev.text === 'string') { fbuf += ev.text; continue; }
    if (ev.type === 'agent' && ev.who) { noteFish(); if (!seq.includes(ev.who)) seq.push(ev.who); }
  }
  noteFish();
  return { seq, said: fbuf };
}

const ag = await api('/api/agents');
const all = ag.json.agents || [];
const BX = all.filter((a) => !a.builtin && a.name === '小白曦')[0] || all.filter((a) => !a.builtin)[0];
if (!BX) { console.log('没有自建智能体，跳过'); process.exit(0); }

const made = [];
async function setup(ids) {
  const m = await post('/api/sessions/new', { title: '__ord__' });
  const sid = m.json.session.id;
  made.push(sid);
  await post('/api/agents/group', { sessionId: sid, agentIds: ids });
  await post('/api/agents/group/order', { sessionId: sid, agentIds: ids });
  await post('/api/fish', { sessionId: sid, on: ids.includes('xiaoyu') });
  await post('/api/whale', { sessionId: sid, on: ids.includes('xiaojing') });
  for (const id of ids) {
    if (id === 'xiaoyu' || id === 'xiaojing') continue;
    await post('/api/agents/group/toggle', { id, sessionId: sid, enabled: true });
  }
  return sid;
}

const cases = [
  { name: '小白曦↑小鱼（小鲸关）', ids: [BX.id, 'xiaoyu'], want: [BX.name, '小鱼'] },
  { name: '小鱼↑小白曦（小鲸关）', ids: ['xiaoyu', BX.id], want: ['小鱼', BX.name] },
  { name: '小白曦↑小鲸↑小鱼 全开', ids: [BX.id, 'xiaojing', 'xiaoyu'], want: [BX.name, '小鲸', '小鱼'] },
  { name: '小鱼↑小鲸↑小白曦 全开', ids: ['xiaoyu', 'xiaojing', BX.id], want: ['小鱼', '小鲸', BX.name] },
  { name: '小鲸↑小白曦↑小鱼 全开', ids: ['xiaojing', BX.id, 'xiaoyu'], want: ['小鲸', BX.name, '小鱼'] },
];

try {
for (const c of cases) {
  console.log('\n=== ' + c.name + ' ===');
  const sid = await setup(c.ids);
  const g = await api('/api/agents/group?sessionId=' + sid);
  const order = (g.json.agentIds || []).map((id) => (all.find((a) => a.id === id) || {}).name || id);
  console.log('  竖列: ' + order.join(' → '));
  const r = await chat(sid, '各说一句');
  console.log('  开口: ' + r.seq.join(' → '));
  chk('开口顺序 = 竖列顺序', JSON.stringify(r.seq) === JSON.stringify(c.want), JSON.stringify(r.seq) + ' vs ' + JSON.stringify(c.want));
}

} finally {
  // 【2026-11-02】不管上面成功还是中途抛错，测试会话一定要删干净 ——
  // 不然跑一次就留一堆 __ord__ 空会话，主人的会话列表里全是垃圾。
  for (const sid of made) {
    try { await post('/api/sessions/delete', { sessionId: sid, id: sid }); } catch {}
  }
}

console.log('\n──────');
console.log('断言：' + pass + '/' + total);
console.log(pass === total ? 'PASS 全部通过' : 'FAIL 有断言没过');
process.exit(pass === total ? 0 : 1);
