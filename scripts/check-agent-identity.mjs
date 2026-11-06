const BASE = process.env.BASE || 'http://127.0.0.1:8787';
const api = async (p, o) => {
  const r = await fetch(BASE + p, o);
  const t = await r.text();
  let j = null; try { j = JSON.parse(t); } catch {}
  return { status: r.status, text: t, json: j };
};
const post = (p, b) => api(p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b || {}) });

let ok = 0, fail = 0;
const chk = (n, c, e = '') => { if (c) { ok++; console.log('  [ok] ' + n + (e ? '  ' + e : '')); } else { fail++; console.log('  [FAIL] ' + n + (e ? '  ' + e : '')); } };

const ag = await (await fetch(BASE + '/api/agents')).json();
const byName = Object.fromEntries(ag.agents.map((a) => [a.name, a]));
const BX = byName['小白曦'].id;
const made = [];
const mk = async (agentId) => { const r = await post('/api/agents/new-session', { agentId }); const sid = r.json?.session?.id || r.json?.id; if (sid) made.push(sid); return sid; };

console.log('=== 6. 颜色：自建卡不是鱼红也不是鲸蓝 ===');
for (const a of ag.agents) {
  const c = a.color ? String(a.color).toLowerCase() : null;
  console.log('  ' + a.name + ' | builtin=' + a.builtin + ' | color=' + JSON.stringify(c));
}
chk('小白曦有独立颜色', !!byName['小白曦'].color);
chk('小白曦颜色不是内置空值', Boolean(String(byName['小白曦'].color || '').trim()));

console.log('=== 7. 开关：自建卡开关按会话存 ===');
const s = await mk(BX);
const g0 = await (await fetch(BASE + '/api/agents/group?sessionId=' + s)).json();
const bxMember = (g0.members || []).find((m) => m.id === BX);
chk('小白曦在 members 里', Boolean(bxMember), JSON.stringify(bxMember));
chk('默认是开着的', bxMember?.enabled !== false);

// 关掉
const off = await post('/api/agents/group/toggle', { id: BX, sessionId: s, enabled: false });
chk('能关掉', off.status === 200, 'status=' + off.status);
const g1 = await (await fetch(BASE + '/api/agents/group?sessionId=' + s)).json();
const m1 = (g1.members || []).find((m) => m.id === BX);
chk('关掉后 enabled=false', m1?.enabled === false, JSON.stringify(m1));

// 别的会话不受影响（按会话隔离）
const s2 = await mk(BX);
const g2 = await (await fetch(BASE + '/api/agents/group?sessionId=' + s2)).json();
const m2 = (g2.members || []).find((m) => m.id === BX);
chk('另一个会话不受影响（按会话隔离）', m2?.enabled !== false, JSON.stringify(m2));

// 打开
await post('/api/agents/group/toggle', { id: BX, sessionId: s, enabled: true });
const g3 = await (await fetch(BASE + '/api/agents/group?sessionId=' + s)).json();
chk('能再打开', (g3.members || []).find((m) => m.id === BX)?.enabled === true);

console.log('=== 8. 安静勾（叫才应）也按会话存 ===');
await post('/api/agents/quiet', { id: BX, quiet: true, sessionId: s });
const gq = await (await fetch(BASE + '/api/agents/group?sessionId=' + s)).json();
console.log('  quietIds(s) =', JSON.stringify(gq.quietIds));
const gq2 = await (await fetch(BASE + '/api/agents/group?sessionId=' + s2)).json();
console.log('  quietIds(s2) =', JSON.stringify(gq2.quietIds));
await post('/api/agents/quiet', { id: BX, quiet: false, sessionId: s });

console.log('=== 9. 改名 ===');
const oldName = byName['小白曦'].name;
const ren = await post('/api/agents/rename', { id: BX, name: '小白曦2' });
chk('改名接口 200', ren.status === 200, 'status=' + ren.status);
const ag2 = await (await fetch(BASE + '/api/agents')).json();
const renamed = ag2.agents.find((a) => a.id === BX);
chk('名字真改了', renamed?.name === '小白曦2', '现在=' + JSON.stringify(renamed?.name));
chk('颜色没丢', Boolean(renamed?.color), 'color=' + JSON.stringify(renamed?.color));
chk('开场白没丢', Boolean(String(renamed?.opening || '').trim()), '开场白长度=' + String(renamed?.opening || '').length);
// 改回来
await post('/api/agents/rename', { id: BX, name: oldName });
const ag3 = await (await fetch(BASE + '/api/agents')).json();
chk('改回原名', ag3.agents.find((a) => a.id === BX)?.name === oldName);

console.log('=== 清理 ===');
for (const sid of made) { await post('/api/sessions/delete', { id: sid }); }
console.log('删了', made.length);
console.log('\n── 断言：' + ok + '/' + (ok + fail) + ' ──');
