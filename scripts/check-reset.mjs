/**
 * 「清空当前」验收 —— /api/reset 是不是真的「原地清空、只留开场白」。
 *
 * 跑法：先 `node src/server.mjs` 起服务，再 `node scripts/check-reset.mjs`
 *     换端口：BASE=http://127.0.0.1:8791 node scripts/check-reset.mjs
 *
 * 它在真服务上建临时会话、塞假对话、打接口、直接读磁盘，验完自己删干净。
 * 验两件事：
 *   ① 清空的语义 —— id/标题/createdAt/记忆本子不动，只清聊天记录留开场白；
 *   ② 别被合流吃回去 —— saveSession 有条给插话用的「磁盘独有接回末尾」，
 *      清空后磁盘必须只剩开场白，不能把旧对话一条条接回来。
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const BASE = process.env.BASE || 'http://127.0.0.1:8787';
const DATA = join(process.env.APPDATA || '', '小鱼Agent', 'data');

const j = async (path, init) => {
  const r = await fetch(BASE + path, init);
  const t = await r.text();
  let v = null;
  try { v = JSON.parse(t); } catch { v = t; }
  return { status: r.status, body: v };
};
const post = (p, o) => j(p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(o ?? {}) });

const sessPath = (id) => join(DATA, '.state', 'sessions', id + '.json');
const readSess = (id) => JSON.parse(readFileSync(sessPath(id), 'utf8'));
const opened = () => {
  try { return JSON.parse(readFileSync(join(DATA, '.state', 'openings.json'), 'utf8')); } catch { return {}; }
};

let pass = 0, fail = 0;
const ok = (cond, name, extra = '') => {
  if (cond) { pass++; console.log('  ✔ ' + name); }
  else { fail++; console.log('  ✘ ' + name + (extra ? '  ← ' + extra : '')); }
};

// —— 建一个测试会话（不会调模型，startOpening 只是垫两条消息）
const made = await post('/api/sessions/new');
const sid = made.body?.session?.id ?? made.body?.id;
if (!sid) { console.log('建会话失败：', JSON.stringify(made).slice(0, 400)); process.exit(1); }
console.log('测试会话 id =', sid);

// 给它挂三条「主人自己的话」+ 记忆本子一条
{
  const s = readSess(sid);
  const before = s.messages.length;
  s.messages.push({ role: 'user', content: '第一句废话' });
  s.messages.push({ role: 'assistant', content: '第一句回答' });
  s.messages.push({ role: 'user', content: '第二句废话' });
  s._whale = { tmp: 1 };
  s._openingPending = true;
  writeFileSync(sessPath(sid), JSON.stringify(s), 'utf8');
  console.log('  塞进会话前 messages =', before, '→', s.messages.length);
}
// 记忆本子写点东西，验证清空不动它
await post('/api/sessions/memory', { id: sid, text: '这是清空前写下的记忆 #RESET-TEST#' });

const beforeSess = readSess(sid);
const beforeRoles = beforeSess.messages.map((m) => m.role + ':' + String(m.content).slice(0, 12));

// —— 真正的动作
const r = await post('/api/reset', { sessionId: sid });
console.log('  /api/reset →', r.status, JSON.stringify(r.body).slice(0, 200));
ok(r.status === 200 && r.body?.ok === true, '接口返回 ok');
ok(r.body?.id === sid, 'id 没变（原地清空，不是新建）', String(r.body?.id));

const after = readSess(sid);
const roles = after.messages.map((m) => m.role);
console.log('  清空后 messages =', after.messages.length, roles.join(','));
ok(roles.every((x) => x === 'system' || x === 'user' || x === 'assistant'), 'roles 合法');
ok(roles.filter((x) => x === 'system').length === beforeSess.messages.filter((m) => m.role === 'system').length,
  'system 提示一条没少');
const keptTalk = after.messages.filter((m) => m.role !== 'system');
ok(keptTalk.length >= 1, '开场白留着（至少一条）', 'kept=' + keptTalk.length);
ok(!after.messages.some((m) => String(m.content).includes('废话')), '主人后来说的废话全清了');
ok(!Object.keys(after).some((k) => k.startsWith('_')), '临时字段（_whale/_openingPending）清干净了',
  Object.keys(after).filter((k) => k.startsWith('_')).join(','));
ok(typeof after.createdAt === 'number' && after.createdAt === beforeSess.createdAt, 'createdAt 没动');
ok(after.updatedAt >= beforeSess.updatedAt, 'updatedAt 更新了');
ok(after.title === beforeSess.title, '标题没变', after.title);

// 记忆本子不动
const mem = await j('/api/sessions/memory?id=' + encodeURIComponent(sid));
const memText = typeof mem.body === 'string' ? mem.body : JSON.stringify(mem.body);
ok(memText.includes('#RESET-TEST#'), '记忆本子没被清（岁月史书/记忆本子不动）', memText.slice(0, 120));

// 会话还在列表里、能正常读
const list = await j('/api/sessions');
const inList = (list.body?.sessions ?? []).some((x) => x.id === sid);
ok(inList, '会话还在列表里（没被删进 .trash）');
const peek = await j('/api/sessions/peek?n=5&id=' + encodeURIComponent(sid));
ok(peek.status === 200, 'peek 读得出来', String(peek.status));

// 再清一次：空会场不该把开场白也清没
const r2 = await post('/api/reset', { sessionId: sid });
const after2 = readSess(sid);
ok(r2.status === 200 && after2.messages.filter((m) => m.role !== 'system').length === keptTalk.length,
  '连点两次，开场白还在', 'kept=' + after2.messages.filter((m) => m.role !== 'system').length);

// 不存在的会话
const r3 = await post('/api/reset', { sessionId: 'nope-not-exist' });
ok(r3.status === 404, '不存在的会话回 404', String(r3.status));

// —— 收拾：把这个测试会话删掉
const del = await post('/api/sessions/delete', { id: sid });
console.log('  清理测试会话 →', del.status);
const gone = !existsSync(sessPath(sid));
ok(gone, '测试会话已清理');

// ═════════════════════════════════════════════
// 第二关：别被 saveSession 的合流吃回去
// saveSession 有条给「插话」用的逻辑：磁盘上有、内存里没有的老消息会接回末尾。
// 清空后那套会把旧对话一条条接回来 —— 这里专门造这个场面。
// ═════════════════════════════════════════════
console.log('\n── 第二关：清空后磁盘别把旧对话接回来');
const made2 = await post('/api/sessions/new');
const sid2 = made2.body?.session?.id;
ok(!!sid2, '建第二个测试会话', String(sid2));
if (sid2) {
  const s = readSess(sid2);
  for (let i = 1; i <= 6; i++) {
    s.messages.push({ role: 'user', content: `第${i}句：主人自己的话 MK${i}` });
    s.messages.push({ role: 'assistant', content: `第${i}句：小鱼的回答 RE${i}` });
  }
  s.updatedAt = Date.now();
  writeFileSync(sessPath(sid2), JSON.stringify(s), 'utf8');

  // 让服务端把这个会话读进内存（peek 会 getSession）
  await j('/api/sessions/peek?n=50&id=' + encodeURIComponent(sid2));
  const rw = await post('/api/reset', { sessionId: sid2 });

  const disk2 = readSess(sid2);
  const diskTalk = disk2.messages.filter((m) => m.role !== 'system');
  ok(diskTalk.length === (rw.body?.kept ?? -1),
    '磁盘上的对话条数 == 接口回的 kept', `disk=${diskTalk.length} api=${rw.body?.kept}`);
  ok(!disk2.messages.some((m) => /MK\d|RE\d/.test(String(m.content))), '旧对话一条没留（MK/RE 全清）');
  ok(!Object.keys(disk2).some((k) => k.startsWith('_')), '磁盘上没残留临时字段',
    Object.keys(disk2).filter((k) => k.startsWith('_')).join(','));
  await post('/api/sessions/delete', { id: sid2 });
}

console.log(`\n结果：${pass} 过 / ${fail} 挂`);
process.exit(fail ? 1 : 0);
