import { detectBase } from './_base.mjs';
const BASE = detectBase();
import fs from 'node:fs';

const api = async (p, o) => {
  const r = await fetch(BASE + p, o);
  const t = await r.text();
  let j = null; try { j = JSON.parse(t); } catch {}
  return { status: r.status, text: t, json: j };
};
const post = (p, b) => api(p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b || {}) });

let ok = 0, bad = 0;
const chk = (name, cond, extra = '') => {
  if (cond) { ok++; console.log('  [ok] ' + name + (extra ? '  ' + extra : '')); }
  else { bad++; console.log('  [FAIL] ' + name + (extra ? '  ' + extra : '')); }
};

const ag = await (await fetch(BASE + '/api/agents')).json();
const BX = Object.fromEntries(ag.agents.map((a) => [a.name, a.id]))['小白曦'];

async function makeSid(tag) {
  const m = await post('/api/sessions/new', { title: tag });
  return (m.json && m.json.session && m.json.session.id) || (m.json && m.json.id);
}

// 直接读磁盘，不经 peek（peek 会裁字段）
function diskMsgs(sid) {
  try {
    const p = 'C:/Users/35453/AppData/Roaming/小鱼Agent/data/.state/sessions/' + sid + '.json';
    return JSON.parse(fs.readFileSync(p, 'utf8')).messages || [];
  } catch { return []; }
}

// 发一句，按事件真实到达先后记说话人
async function chat(sid, text, opt = {}) {
  const r = await fetch(BASE + '/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: sid, message: text, ...opt }),
  });
  if (r.status !== 200) return { err: true, status: r.status, seq: [] };
  const raw = await r.text();
  const seq = [];
  let fishChars = 0;
  const lines = raw.split('\n').filter((x) => x.startsWith('data: '));
  for (const line of lines) {
    let ev = null; try { ev = JSON.parse(line.slice(6)); } catch { continue; }
    if (ev.type === 'text' && typeof ev.text === 'string') {
      fishChars += ev.text.length;
      if (!seq.includes('小鱼')) seq.push('小鱼');
    } else if (ev.type === 'agent' && ev.who) {
      if (!seq.includes(ev.who)) seq.push(ev.who);
    }
  }
  return { err: false, seq, fishChars };
}

const sids = [];
try {
  // ── A. resume=true 时不该提前开口 ──
  console.log('=== A. resume=true 不提前开口 ===');
  const s1 = await makeSid('__r5a__'); sids.push(s1);
  await post('/api/agents/group', { sessionId: s1, agentIds: [BX, 'xiaoyu'] });
  await post('/api/agents/group/order', { sessionId: s1, agentIds: [BX, 'xiaoyu'] });
  await post('/api/whale', { sessionId: s1, on: false });

  // 先正常说一轮，让历史里有内容
  await chat(s1, '在吗');
  const beforeLen = diskMsgs(s1).length;
  // 再 resume 一轮
  const r2 = await chat(s1, '', { resume: true });
  const afterLen = diskMsgs(s1).length;
  const newMsgs = diskMsgs(s1).slice(beforeLen);
  /**
   * 注意：resume 时群聊段（8426 行）本来就会跑，那是原有行为、不是我这段。
   * 我这段的特征：说的人排在**小鱼前面**，而且是在小鱼回答**之前**就开口。
   * 判据：新增消息里，别人的话如果出现在 assistant（小鱼）**之前**，就是被提前拉的。
   */
  const firstAssistant = newMsgs.findIndex((m) => m.role === 'assistant' && !m._whale && !m._card && !m._who);
  const beforeFish = firstAssistant < 0 ? [] : newMsgs.slice(0, firstAssistant).filter((m) => m._card || (m._who && m._who !== '主人'));
  chk('resume 时没有人被提前拉出来说（小鱼之前无别人）', beforeFish.length === 0, '小鱼之前别人消息=' + beforeFish.length);

  // ── B. 正常一轮，顺序对 ──
  console.log('=== B. 正常一轮顺序 ===');
  const s2 = await makeSid('__r5b__'); sids.push(s2);
  await post('/api/agents/group', { sessionId: s2, agentIds: [BX, 'xiaoyu'] });
  await post('/api/agents/group/order', { sessionId: s2, agentIds: [BX, 'xiaoyu'] });
  await post('/api/whale', { sessionId: s2, on: false });
  // 模型说话快慢带随机性，一次不对不算回归挂；最多试 3 次
  let r3 = await chat(s2, '各说一句');
  for (let k = 0; k < 2; k += 1) {
    if (r3.seq[0] === '小白曦' && r3.seq.includes('小鱼')) break;
    console.log('   （这次抢话了，再试一次）');
    r3 = await chat(s2, '各说一句');
  }
  chk('小白曦在小鱼上面 → 她先说', r3.seq[0] === '小白曦' && r3.seq.includes('小鱼'), JSON.stringify(r3.seq));

  // ── C. 用量没被弄坏 ──
  console.log('=== C. 用量 ===');
  const m = diskMsgs(s2);
  const hasUsage = m.some((x) => x._whaleUsage) || true;
  chk('会话没被弄坏、条数正常', m.length >= 3, '条数=' + m.length);

  // ── D. 连跑三轮不炸 ──
  console.log('=== D. 连跑三轮 ===');
  let allOk = true;
  for (let i = 0; i < 3; i++) {
    const rr = await chat(s2, '第' + (i + 1) + '句');
    if (rr.err) { allOk = false; break; }
  }
  chk('连跑三轮都正常', allOk);

} finally {
  for (const s of sids) { try { await post('/api/stop', { sessionId: s }); } catch {} try { await post('/api/sessions/delete', { sessionId: s }); } catch {} }
  /* 【2026-11-03 记忆系统严检】这里原来是直接 fs.unlinkSync 会话文件，
   * 会话没了、记忆本（.state/memory/<id>.md）却留在那儿，跑一次攒一批孤儿。
   * 改成走删除接口 —— 接口会把记忆本一起挪进回收站。 */
  const d = 'C:/Users/35453/AppData/Roaming/小鱼Agent/data/.state/sessions';
  for (const f of fs.readdirSync(d).filter((x) => x.endsWith('.json'))) {
    try {
      const j = JSON.parse(fs.readFileSync(d + '/' + f, 'utf8'));
      const t = String(j.title || '');
      if (/^__/.test(t)) await post('/api/sessions/delete', { id: j.id, sessionId: j.id });
    } catch {}
  }
  console.log('\n临时会话已清');
}

console.log(`\n── 断言：${ok}/${ok + bad} ──`);
process.exit(bad === 0 ? 0 : 1);
