/**
 * 端到端回归：关小鱼 + 关小鲸，只留自建智能体，必须有人开口，
 * 而且那句话必须真的通过 SSE 推到前端（不是只躺在 live 里）。
 *
 * 用法：node scripts/e2e-mate-speaks.mjs
 * 自查：临时建会话 → 测 → 删会话、还原开关。不碰主人的正式会话。
 */
const BASE = process.env.BASE || 'http://127.0.0.1:8788';

let pass = 0, total = 0;
const chk = (label, cond, extra = '') => {
  total++;
  if (cond) { pass++; console.log('  [ok] ' + label + (extra ? '  ' + extra : '')); }
  else console.log('  [FAIL] ' + label + (extra ? '  ' + extra : ''));
};

async function api(path, opt) {
  const r = await fetch(BASE + path, opt);
  const t = await r.text();
  let j = null; try { j = JSON.parse(t); } catch {}
  return { status: r.status, text: t, json: j };
}
const post = (p, b) => api(p, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b),
});

console.log('=== 1. 建临时会话 ===');
const made = await post('/api/sessions/new', { title: '__e2e_mate_speaks__' });
const sid = made.json?.session?.id;
chk('临时会话建好了', !!sid, sid || made.text.slice(0, 120));
if (!sid) { console.log('\nFAIL 建不了会话，停'); process.exit(1); }

let exitCode = 0;
try {
  console.log('\n=== 2. 找一个自建智能体 ===');
  const ag = await api('/api/agents');
  const custom = (ag.json?.agents || []).filter((a) => !a.builtin);
  chk('有自建智能体', custom.length > 0, custom.map((a) => a.name).join('、'));
  if (!custom.length) throw new Error('没有自建智能体');
  const mate = custom[0];

  console.log('\n=== 3. 群里只留它，小鱼小鲸都关掉 ===');
  await post('/api/agents/group', { sessionId: sid, agentIds: [mate.id] });
  await post('/api/fish', { sessionId: sid, on: false });
  await post('/api/whale', { sessionId: sid, on: false });
  const g = await api('/api/agents/group?sessionId=' + sid);
  const byId = Object.fromEntries((g.json?.members || []).map((m) => [m.id, m]));
  chk('小鱼是关着的', !byId.xiaoyu || byId.xiaoyu.enabled === false); // 不在群里 = 也等于关了
  chk('小鲸是关着的', byId.xiaojing && byId.xiaojing.enabled === false);
  chk('自建智能体是开着的', byId[mate.id] && byId[mate.id].enabled === true);

  console.log('\n=== 4. 发一句话，看谁开口 ===');
  const r = await fetch(BASE + '/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: sid, message: '你好，请说一句话' }),
  });
  let buf = '';
  const dec = new TextDecoder();
  const events = [];
  for await (const chunk of r.body) {
    buf += dec.decode(chunk, { stream: true });
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const raw = buf.slice(0, i); buf = buf.slice(i + 2);
      for (const line of raw.split('\n')) {
        if (!line.startsWith('data:')) continue;
        const txt = line.slice(5).trim();
        if (!txt || txt === '[DONE]') continue;
        try { events.push(JSON.parse(txt)); } catch {}
      }
    }
  }
  const said = events.filter((e) => e.type === 'agent' && e.agentId === mate.id && String(e.text || '').trim());
  chk('自建智能体真的开口了', said.length > 0, said.length ? '「' + String(said[0].text).slice(0, 40) + '…」' : '一句话都没有');
  chk('它的话是通过 SSE 发到前端的（不是只在服务端）', said.length > 0);
  chk('小鲸没有替它说话', !events.some((e) => e.type === 'whale_text' && String(e.text || '').trim()));
  if (!said.length) exitCode = 1;
} catch (e) {
  console.log('  [FAIL] 测崩了：' + (e && e.message ? e.message : e));
  exitCode = 1;
} finally {
  console.log('\n=== 5. 收尾：删临时会话 ===');
  const del = await post('/api/sessions/delete', { id: sid });
  chk('临时会话删掉了', del.status === 200 && (del.json?.ok !== false), 'status=' + del.status + ' ' + String(del.text).slice(0, 60));
}

console.log('\n────────────');
console.log('断言：' + pass + '/' + total);
console.log(pass === total && exitCode === 0 ? 'PASS 全部通过' : 'FAIL 有未通过项');
process.exit(pass === total && exitCode === 0 ? 0 : 1);
