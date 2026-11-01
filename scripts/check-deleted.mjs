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

// ── 4：/api/reset「清空当前」已下线（2026-10-31 主人要求：前端按钮和 47 行动作全删）
console.log('【4】/api/reset 应已下线：返回 410 + gone，不再清空任何东西');
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
      { role: 'assistant', content: '这段对话不该被 reset 清掉' },
    ],
  }), 'utf8');

  const srv = await startServer({ port: 0, quiet: true, selfCheck: false });
  const base = srv.url;
  try {
    const r = await fetch(base + '/api/reset', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: id }),
    });
    const j = await r.json();
    ok(r.status === 410, '/api/reset 返回 410（已下线）', 'status=' + r.status);
    ok(j && j.gone === true, '/api/reset 带 gone:true 说明', JSON.stringify(j).slice(0, 160));

    const after = JSON.parse(readFileSync(sessFile(id), 'utf8'));
    ok(after.messages.some((m) => m.content === '__probe_interject_test__'),
      '下线后：那条探针消息原样还在（没被清）');

    // 再触发几次存盘，确认整条链路都正常、没把消息弄丢
    for (let i = 0; i < 3; i++) {
      await fetch(base + '/api/sessions/rename', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id, title: '验收' + i }),
      });
    }
    const afterSave = JSON.parse(readFileSync(sessFile(id), 'utf8'));
    ok(afterSave.messages.some((m) => m.content === '__probe_interject_test__'),
      '几次存盘之后消息仍在（下线不影响正常存盘）');
  } finally {
    try { await srv.close(); } catch {}
  }
}

process.exit(fail === 0 ? 0 : 1);
