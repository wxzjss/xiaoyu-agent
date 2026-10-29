/**
 * 「删掉的消息别自己走回来」验收 —— 2026-10-29
 *
 * 这个脚本就是当初那个 bug 的现场：插话把一条消息写进磁盘，主人把它从历史里删掉，
 * 然后任何一次 saveSession（收尾、下次开这轮）都会拿磁盘那份来合流，
 * 旧版会把删掉的那条当「插话新增」接回末尾 —— 删几次回来几次。
 *
 * 检查三件事：
 *   1) 不带 _deletedKeys 的普通合流：磁盘独有的一条，照样接回（插话还得能用）
 *   2) 登记了 _deletedKeys：同一条，不许接回
 *   3) 真实服务器 /api/reset：清完之后再存几次盘，被清掉的对话不许复活
 *
 * 只写临时数据目录，不碰主人真数据。
 */
import { mkdtempSync, rmSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'chk-deleted-'));
mkdirSync(join(home, '.state', 'sessions'), { recursive: true });
process.env.MINI_AGENT_DATA = home;
process.env.MINI_AGENT_QUIET = '1';

const { saveSession, loadSession, messageKey } = await import('../src/sessions-core.mjs');

const sessFile = (id) => join(home, '.state', 'sessions', id + '.json');

let pass = 0, fail = 0;
const ok = (cond, name, extra = '') => {
  if (cond) { pass++; console.log('  [ok] ' + name); }
  else { fail++; console.log('  [FAIL] ' + name + (extra ? ' | ' + extra : '')); }
};

// ── 1 & 2：直接打 saveSession
function seed(id, msgs) {
  writeFileSync(sessFile(id), JSON.stringify({
    id, title: '验收', createdAt: 1, updatedAt: 1, messages: msgs,
  }), 'utf8');
}

const INTJ = { role: 'user', content: '__probe_interject_test__', _at: 111 };

console.log('【1】普通合流：插话那条该被接回（这条不能改坏）');
{
  const id = 'smvchk1';
  seed(id, [{ role: 'user', content: '第一句' }, { role: 'assistant', content: '回复' }]);
  // 内存里是「磁盘那份 + 插话新来的那条」，插话已经先落盘了
  seed(id, [{ role: 'user', content: '第一句' }, { role: 'assistant', content: '回复' }, INTJ]);
  // 内存副本里没有 INTJ（相当于旧副本），没有 _deletedKeys
  const mem = { id, title: '验收', createdAt: 1, updatedAt: 1,
    messages: [{ role: 'user', content: '第一句' }, { role: 'assistant', content: '回复' }] };
  saveSession(mem);
  const after = JSON.parse(readFileSync(sessFile(id), 'utf8'));
  ok(after.messages.length === 3 && after.messages.some((m) => m.content === INTJ.content),
    '插话的消息被接回来了（3 条）', '实际 ' + after.messages.length + ' 条');
}

console.log('【2】登记了 _deletedKeys：同一条不许接回');
{
  const id = 'smvchk2';
  seed(id, [{ role: 'user', content: '第一句' }, { role: 'assistant', content: '回复' }, INTJ]);
  const mem = { id, title: '验收', createdAt: 1, updatedAt: 1,
    messages: [{ role: 'user', content: '第一句' }, { role: 'assistant', content: '回复' }],
    _deletedKeys: [messageKey(INTJ)] };
  saveSession(mem);
  const after = JSON.parse(readFileSync(sessFile(id), 'utf8'));
  ok(after.messages.length === 2, '删掉的消息没被接回（2 条）', '实际 ' + after.messages.length + ' 条');
  ok(!after.messages.some((m) => m.content === INTJ.content), '测试条不在磁盘上');
  ok(Array.isArray(after._deletedKeys) && after._deletedKeys.includes(messageKey(INTJ)),
    '_deletedKeys 跟着落盘（重启/刷新后还记得）');
}

console.log('【3】普通会话不该平白多出 _deletedKeys 字段');
{
  const id = 'smvchk3';
  seed(id, [{ role: 'user', content: '就一句' }]);
  const mem = { id, title: '验收', createdAt: 1, updatedAt: 1,
    messages: [{ role: 'user', content: '就一句' }, { role: 'assistant', content: '好' }] };
  saveSession(mem);
  const after = JSON.parse(readFileSync(sessFile(id), 'utf8'));
  ok(!('_deletedKeys' in after), '没删过东西就不写这个字段', JSON.stringify(Object.keys(after)));
}

// ── 4：真实服务器 /api/reset
console.log('【4】真实 /api/reset：清完再存几次盘，清掉的对话不许复活');
{
  const { startServer } = await import('../src/server.mjs');
  const id = 'smvchk4';
  writeFileSync(sessFile(id), JSON.stringify({
    id, title: '验收', createdAt: 1, updatedAt: Date.now(),
    messages: [
      { role: 'system', content: '人设' },
      { role: 'user', content: '开场白' },
      { role: 'assistant', content: '在' },
      { role: 'user', content: '__probe_interject_test__' },
      { role: 'assistant', content: '这是一段要被清掉的对话' },
    ],
  }), 'utf8');

  // startServer 返回的是句柄 { port, url, close() }，不是 node 的 net.Server
  const srv = await startServer({ port: 0, quiet: true, selfCheck: false });
  const base = srv.url;

  const r = await fetch(base + '/api/reset', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId: id }),
  });
  const j = await r.json();
  ok(r.status === 200 && j.ok, '/api/reset 返回 ok', JSON.stringify(j).slice(0, 160));

  const afterReset = JSON.parse(readFileSync(sessFile(id), 'utf8'));
  ok(!afterReset.messages.some((m) => m.content === '__probe_interject_test__'),
    '清完当场：测试条没了');
  ok(Array.isArray(afterReset._deletedKeys) && afterReset._deletedKeys.length > 0,
    '清完当场：删过的指纹登记进文件了', String(afterReset._deletedKeys && afterReset._deletedKeys.length));

  // 再触发几次存盘（改名 = 每次都会走 saveSession，而且是最原始的那条路）
  for (let i = 0; i < 3; i++) {
    await fetch(base + '/api/sessions/rename', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id, title: '验收' + i }),
    });
  }
  const afterSave = JSON.parse(readFileSync(sessFile(id), 'utf8'));
  ok(!afterSave.messages.some((m) => m.content === '__probe_interject_test__'),
    '存盘 3 次之后：测试条还是不在', afterSave.messages.map((m) => String(m.content).slice(0, 12)).join(' / '));
  ok(!afterSave.messages.some((m) => m.content === '这是一段要被清掉的对话'),
    '存盘 3 次之后：被清掉的对话也没回来');

  await srv.close();
}

console.log('');
console.log(fail === 0 ? `PASS 全部通过（${pass} 项）` : `FAIL ${fail} 项没过 / ${pass} 项通过`);
rmSync(home, { recursive: true, force: true });
process.exit(fail === 0 ? 0 : 1);
