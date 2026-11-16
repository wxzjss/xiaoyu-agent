#!/usr/bin/env node
/**
 * 守一条：真删的消息（删除按钮 / 回退砍尾巴）不许在下一轮存盘时「复活」。
 *
 * 【2026-11-15 事故】/api/sessions/message-delete 和 /api/sessions/rewind 都是
 * 真 splice（真删，非遮蔽），可 saveSession 落盘前有一道「合流」：
 * 磁盘上有、内存里没有的消息会被当成「插话刚 push 进来、还没落盘的那一句」
 * 接回末尾。删掉的那几条正中这个判据 ——
 * 实测（sandbox/_repro_del_resurrect.mjs）：删一条，下一轮存盘它原样回来，
 * 还被排到最末尾（复活 + 乱序）。
 *
 * 修法：删之前把被删消息的指纹（messageKey）登记进 session._deletedKeys，
 * 合流时命中的一律不接。这个检查两头都钉：
 *   ① 源码守卫：两个端点必须登记 _deletedKeys；
 *   ② 行为验证：真删 → 存盘 → 重读，不许复活、不许乱序；
 *   ③ 负向验证：普通「没删过」的合流（插话那条道）必须照旧接得回来。
 *
 * 跑法：node scripts/check-delete-no-resurrect.mjs   （不碰真数据，全程临时目录）
 */
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

let pass = 0;
let fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; console.log('  ❌ ' + name + (extra ? ' —— ' + extra : '')); }
};

// ── ① 源码守卫 ────────────────────────────────────────────────
const __dir = dirname(fileURLToPath(import.meta.url));
console.log('〔源码守卫〕');
const server = readFileSync(join(__dir, '..', 'src', 'server.mjs'), 'utf8');
ok('message-delete 真删前登记 _deletedKeys',
  /const drops = \[\.\.\.drop\]\.sort\(\(a, b\) => a - b\);[\s\S]{0,700}session\._deletedKeys = \[\.\.\._dead\];/.test(server));
ok('rewind 砍尾巴前登记 _deletedKeys',
  /const removed = session\.messages\.length - \(i \+ 1\);[\s\S]{0,900}session\._deletedKeys = \[\.\.\._deadTail\];/.test(server));
ok('两处登记用的都是 messageKey（跟合流端同一套判据）',
  (server.match(/messageKey\(all\[di\]\)/g) || []).length >= 1
  && (server.match(/messageKey\(session\.messages\[_k\]\)/g) || []).length >= 1);

// ── ② 行为验证 ────────────────────────────────────────────────
console.log('〔行为验证：真删 → 存盘 → 重读〕');
const dir = mkdtempSync(join(tmpdir(), 'del-resurrect-'));
process.env.MINI_AGENT_DATA = dir;
const { saveSession, loadSession, messageKey } = await import(pathToFileURL(join(__dir, '..', 'src', 'sessions-core.mjs')).href);

const id = 'sdelregr1';
const msgs = [
  { role: 'system', content: 'sys', context: true },
  { role: 'user', content: '消息1', at: 1000 },
  { role: 'assistant', content: '回复1', at: 2000 },
  { role: 'user', content: '消息2（要删的）', at: 3000 },
  { role: 'assistant', content: '回复2', at: 4000 },
  { role: 'user', content: '消息3', at: 5000 },
];
saveSession({ id, title: 't', createdAt: 1, updatedAt: 1, messages: msgs, rewinds: [] });

// 模拟 message-delete：删「消息2（要删的）」，登记指纹，存盘
const s = loadSession(id);
const di = s.messages.findIndex((m) => m.content === '消息2（要删的）');
const droppedKey = messageKey(s.messages[di]);
s._deletedKeys = [droppedKey];
s.messages.splice(di, 1);
s.updatedAt = Date.now();
saveSession(s);

const s2 = loadSession(id);
const c2 = s2.messages.map((m) => m.content);
ok('删掉的消息没有复活', !c2.includes('消息2（要删的）'), JSON.stringify(c2));
ok('顺序保持原样（不许把尾巴挪到前面）',
  JSON.stringify(c2) === JSON.stringify(['sys', '消息1', '回复1', '回复2', '消息3']), JSON.stringify(c2));

// 连存几轮（真实场景：每轮对话都会 saveSession），还是不许复活
saveSession(s2);
saveSession(loadSession(id));
const s3 = loadSession(id);
ok('再多存两轮也不复活', !s3.messages.map((m) => m.content).includes('消息2（要删的）'));

// ── ③ 负向验证：没登记指纹的「磁盘独有」消息照旧要接回来（插话那条道） ──
console.log('〔负向验证：插话合流照旧工作〕');
const id2 = 'sdelregr2';
saveSession({ id: id2, title: 't2', createdAt: 1, updatedAt: 1, messages: [
  { role: 'system', content: 'sys', context: true },
  { role: 'user', content: '消息A', at: 1000 },
], rewinds: [] });
// 模拟另一条道（别的进程 / 插话）往盘上写了一条内存里还没有的消息
const diskRaw = JSON.parse(readFileSync(join(dir, '.state', 'sessions', id2 + '.json'), 'utf8'));
diskRaw.messages.push({ role: 'user', content: '插话（磁盘独有）', at: 2000 });
writeFileSync(join(dir, '.state', 'sessions', id2 + '.json'), JSON.stringify(diskRaw), 'utf8');
const hot = loadSession(id2);
hot.updatedAt = Date.now();
const saved = saveSession(hot);
const merged = saved.messages.map((m) => m.content);
ok('没删过的磁盘独有消息照旧接回末尾（插话合流没被误伤）',
  merged.includes('插话（磁盘独有）'), JSON.stringify(merged));

try { rmSync(dir, { recursive: true, force: true }); } catch {}

console.log('');
console.log(`结果：${pass} 过 / ${fail} 挂`);
process.exit(fail ? 1 : 0);
