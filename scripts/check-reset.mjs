/**
 * 「清空当前已下线」验收 —— 2026-10-31
 *
 * 【为什么改成这样】主人要求把「清空当前」这个功能整个拿掉（前端按钮和 47 行动作全删，
 * /api/reset 返回 410 + gone）。原来那份 check-reset.mjs 验的是「原地清空、只留开场白」，
 * 功能一下线，它必然全挂——挂的是旧口径，不是真 bug。
 * 现在改成验「下线之后没人能再清掉我的会话」，这才是眼下要保的东西。
 *
 * 跑法：先起服务，再 `BASE=http://127.0.0.1:8788 node scripts/check-reset.mjs`
 *      默认 8788（本机实际端口），端口不对就用 BASE 覆盖。
 */
import { readFileSync, writeFileSync, existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

const BASE = process.env.BASE || 'http://127.0.0.1:8788';
const DATA = join(process.env.APPDATA || '', '小鱼Agent', 'data');

let pass = 0, fail = 0;
const ok = (cond, label, got) => {
  if (cond) { pass++; console.log('  ✔ ' + label); }
  else { fail++; console.log('  ✘ ' + label + (got !== undefined ? '  ← ' + got : '')); }
};

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

const id = 'smvchkreset' + Date.now().toString(36);
console.log('测试会话 id = ' + id);

const PROBE = '__reset_probe_should_survive__';

try {
  // 建一个带假对话的会话
  writeFileSync(sessPath(id), JSON.stringify({
    id, title: '下线验收', createdAt: Date.now() - 10000, updatedAt: Date.now(),
    messages: [
      { role: 'system', content: '人设' },
      { role: 'user', content: '开场白' },
      { role: 'assistant', content: '在' },
      { role: 'user', content: PROBE },
      { role: 'assistant', content: '这句必须活着' },
    ],
    _whale: 'x', _openingPending: true,
  }, null, 2), 'utf8');

  const before = readSess(id);
  console.log('  塞进会话前 messages = ' + before.messages.length);

  // ① 打接口：必须 410 + gone
  const r = await post('/api/reset', { sessionId: id });
  console.log('  /api/reset → ' + r.status + ' ' + JSON.stringify(r.body).slice(0, 130));
  ok(r.status === 410, '/api/reset 返回 410（已下线）', 'status=' + r.status);
  ok(r.body && r.body.gone === true, '带 gone:true', r.body && r.body.gone);

  // ② 会话内容一条没少
  const after = readSess(id);
  ok(after.messages.length === before.messages.length,
    '会话条数一点没变（没被清）', after.messages.length + ' vs ' + before.messages.length);
  ok(after.messages.some((m) => m.content === PROBE),
    '探针消息原样还在');
  ok(after.title === before.title, '标题没变', after.title);

  // ③ 连打三次还是不让清
  for (let i = 0; i < 3; i++) await post('/api/reset', { sessionId: id });
  const after3 = readSess(id);
  ok(after3.messages.some((m) => m.content === PROBE),
    '连打三次之后探针仍在');

  // ④ 不存在的会话：也得是 410（功能整个没了，跟会话在不在无关）
  const r2 = await post('/api/reset', { sessionId: 'smvNoSuchSession' });
  ok(r2.status === 410, '不存在的会话也回 410（功能层面就下线了）', 'status=' + r2.status);
} catch (e) {
  fail++;
  console.log('  ✘ 异常：' + (e && e.message || e));
} finally {
  // 【2026-11-03 记忆系统严检】别直接 unlink 会话文件 —— 那样记忆本会变成孤儿。
  try { await post('/api/sessions/delete', { id }); console.log('  清理测试会话 → ok（走接口，记忆本一起收）'); } catch {}
}

console.log('\n结果：' + pass + ' 过 / ' + fail + ' 挂');
process.exit(fail === 0 ? 0 : 1);
