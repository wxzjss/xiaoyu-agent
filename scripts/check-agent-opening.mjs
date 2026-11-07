const BASE = process.env.BASE || 'http://127.0.0.1:8788';
const api = async (p, o) => {
  const r = await fetch(BASE + p, o);
  const t = await r.text();
  let j = null; try { j = JSON.parse(t); } catch {}
  return { status: r.status, text: t, json: j };
};
const post = (p, b) => api(p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b || {}) });

let ok = 0, fail = 0;
const chk = (name, cond, extra = '') => {
  if (cond) { ok++; console.log('  [ok] ' + name + (extra ? '  ' + extra : '')); }
  else { fail++; console.log('  [FAIL] ' + name + (extra ? '  ' + extra : '')); }
};

const ag = await (await fetch(BASE + '/api/agents')).json();
const BX = Object.fromEntries(ag.agents.map((a) => [a.name, a.id]))['小白曦'];
const made = [];
const mk = async (agentId) => {
  const r = await post('/api/agents/new-session', { agentId });
  const sid = r.json?.session?.id || r.json?.id;
  if (sid) made.push(sid);
  return sid;
};

/**
 * 【2026-11-07 修·主人把小鱼的开场白关了，这两条不该红】
 *
 * 原来硬性要求「小鱼会话一定有开场白」。可主人 2026-11-07 在设置里把
 * `xiaoyu` 的开场白关掉了（.state/agent-opening-switch.json 里 `{"xiaoyu": false}`），
 * 于是这两条永远 FAIL —— **红的不是 bug，是脚本没尊重主人的设置**。
 *
 * 现在先读那个开关：关着就 SKIP 并说明原因，开着才检查。
 * 小白曦那两条照旧（他没关）。
 */
import fs from 'node:fs';
import path from 'node:path';

let xiaoyuOpeningOn = true;
try {
  const appdata = process.env.APPDATA || '';
  const f = joinSafe(appdata, '小鱼Agent', 'data', '.state', 'agent-opening-switch.json');
  if (f && fs.existsSync(f)) {
    const j = JSON.parse(fs.readFileSync(f, 'utf8'));
    xiaoyuOpeningOn = j.xiaoyu !== false;
  }
} catch { /* 读不到就当开着（老行为） */ }

function joinSafe(...parts) {
  try { return path.join(...parts.filter(Boolean)); } catch { return ''; }
}

console.log('=== 1. 开场白：只有小鱼时 ===');
const s1 = await mk('xiaoyu');
const sel1 = await post('/api/sessions/select', { id: s1 });
const t1 = sel1.json?.session?.turns || [];
const opening1 = t1.find((t) => t.role === 'assistant');
if (!xiaoyuOpeningOn) {
  console.log('  [skip] 小鱼的开场白在设置里关着（agent-opening-switch.json: xiaoyu=false），跳过这两条');
} else {
  chk('小鱼会话有开场白', Boolean(opening1), '条数=' + t1.length);
  chk('小鱼的开场白不标 whale（就是她自己）', !opening1?.whale, 'whale=' + JSON.stringify(opening1?.whale));
}

console.log('=== 2. 开场白：用小白曦开 ===');
const s2 = await mk(BX);
const sel2 = await post('/api/sessions/select', { id: s2 });
const t2 = sel2.json?.session?.turns || [];
const op2 = t2.find((t) => t.role === 'assistant');
chk('小白曦会话有开场白', Boolean(op2));
chk('开场白标的是小白曦', op2?.whale === '小白曦', 'whale=' + JSON.stringify(op2?.whale));

console.log('=== 3. 没填开场白的卡 ===');
const PB = Object.fromEntries(ag.agents.map((a) => [a.name, a.id]))['旁白'];
const s3 = await mk(PB);
const sel3 = await post('/api/sessions/select', { id: s3 });
const t3 = sel3.json?.session?.turns || [];
const op3 = t3.find((t) => t.role === 'assistant');
chk('旁白没填开场白 → 不硬造一句', !op3 || !String(op3.text || '').trim(), 'assistant条数=' + t3.filter((t) => t.role === 'assistant').length);

console.log('=== 4. 屋里的人 ===');
const g2 = await (await fetch(BASE + '/api/agents/group?sessionId=' + s2)).json();
chk('用她开会话后她在屋里', (g2.names || []).includes('小白曦'), JSON.stringify(g2.names));
/* 【2026-11-08 改准·这不是问题，是主人自己定的规矩】
 * 我昨天在 notes 里写「与设计说明不一致，待确认」——那是我读错了注释。
 * agents.mjs 里写得很清楚，主人 2026-11-01 的原话：
 *   「新建会话时明明只选了小白曦，左栏却总有小鱼」
 *   → 存过的名单一个字都不动，要平行、要能只留一张卡。
 * 所以「只选小白曦的会话，屋里没有小鱼」是**故意的**，不是漏。
 * 这里只报数，不判红。 */
console.log('  [note] 屋里的人实际是：' + JSON.stringify(g2.names)
  + '（只选了小白曦的会话不补小鱼 —— 主人 2026-11-01 定的「名单一个字都不动」）');

console.log('=== 5. 普通新建会话（不绑卡）===');
const s5 = (await post('/api/sessions/new', { title: '普通会话' })).json?.session?.id;
if (s5) made.push(s5);
const g5 = await (await fetch(BASE + '/api/agents/group?sessionId=' + s5)).json();
chk('普通新会话屋里只有小鱼小鲸', JSON.stringify(g5.names) === JSON.stringify(['小鱼', '小鲸']), JSON.stringify(g5.names));
const sel5 = await post('/api/sessions/select', { id: s5 });
const op5 = (sel5.json?.session?.turns || []).find((t) => t.role === 'assistant');
/* 同一条原因：小鱼的开场白在设置里关着 → 普通新会话本来就不该有开场白 */
if (!xiaoyuOpeningOn) {
  console.log('  [skip] 小鱼的开场白关着，这条不适用');
} else {
  chk('普通新会话开场白是小鱼的', Boolean(op5) && !op5.whale, 'whale=' + JSON.stringify(op5?.whale));
}

console.log('=== 清理 ===');
for (const sid of made) { await post('/api/sessions/delete', { id: sid }); }
console.log('删了', made.length, '个');
console.log('\n── 断言：' + ok + '/' + (ok + fail) + ' ──');
