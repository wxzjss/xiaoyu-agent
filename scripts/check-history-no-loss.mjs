#!/usr/bin/env node
/**
 * 守两条（2026-11-15 主人报·修理鱼会话「20:13 和 21:43 之间的消息全消失了」）：
 *
 * ① **收起的旧工具结果副本不许进历史**
 *    `collapseOldToolBodies` 给「发给模型的那份拷贝」换的是**新对象**
 *    （Object.assign({}, m, {content: brief, _collapsed:true})）。
 *    下游「wire 里 seen 没有的就接回 history」那三处只认对象身份 ——
 *    新对象一个都不在 seen 里，于是每条被收起的旧工具结果都被当成新消息 push 进历史。
 *    实测会话 smwg61ggmhd4a：一次续跑多出 **238 条**重复 tool
 *    （tool_call_id 与前面完全一样，上游会 400），真正的新对话被挤到后面。
 *    修法：三处循环 + commitWireBack 都认 `_collapsed`，一律不接。
 *
 * ② **压缩过的会话，磁盘上比内存新的消息必须接回来**
 *    `saveSession` 的合流原来在 `compressedAnywhere` 时**一条 diskOnly 都不接**，
 *    假设「磁盘有、内存没有 = 已被折进摘要」。可只要某个进程攥着压缩前的旧副本保存，
 *    磁盘上压缩之后新产生的消息就会被整段丢掉（重启一次 → 中间一段全没）。
 *    修法：只有「比内存最后一条还旧」的才当已折叠跳过；**更新的必须接**。
 *
 * 跑法：node scripts/check-history-no-loss.mjs
 */
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; console.log('  ❌ ' + name + (extra ? ' —— ' + extra : '')); }
};
const __dir = dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(join(__dir, '..', p), 'utf8');
const server = read('src/server.mjs');

console.log('〔① 收起的工具结果副本不许进历史〕');
ok('collapseOldToolBodies 打 _collapsed 记号', /_collapsed: true/.test(server));
ok('commitWireBack 跳过 _collapsed', /if \(m\._collapsed === true\) continue;/.test(server));
ok('三处 wire→history 接回循环也跳过 _collapsed',
  (server.match(/if \(m && m\._collapsed === true\) continue;/g) || []).length >= 3);

console.log('〔② 压缩后：磁盘上更新的消息要接回来（真跑一遍 saveSession）〕');
const dir = mkdtempSync(join(tmpdir(), 'hist-noloss-'));
process.env.MINI_AGENT_DATA = dir;
const { saveSession, loadSession } = await import(pathToFileURL(join(__dir, '..', 'src', 'sessions-core.mjs')).href);

const id = 'shistloss1';
// 盘上：system + 摘要 + 两条新消息（12:00、13:00）
saveSession({
  id, title: 't', createdAt: 1, updatedAt: 1,
  messages: [
    { role: 'system', content: 'sys', context: true },
    { role: 'user', content: '早期对话摘要', context: true, summary: true, at: 500 },
    { role: 'user', content: '盘上较新的那条', at: 1794700000000 },
    { role: 'assistant', content: '盘上更新的回答', at: 1794700100000 },
  ],
  rewinds: [],
});

// 内存：压缩前的旧副本（有摘要、但最后一条比盘上更早）+ 自己的内容
const stale = loadSession(id);
stale.messages = [
  { role: 'system', content: 'sys', context: true },
  { role: 'user', content: '早期对话摘要', context: true, summary: true, at: 500 },
  { role: 'user', content: '内存里较旧的一条', at: 1794600000000 },
];
stale.updatedAt = Date.now();
saveSession(stale);

const after = loadSession(id);
const texts = after.messages.map((m) => String(m.content || ''));
ok('磁盘上比内存新的消息没被丢掉',
  texts.includes('盘上较新的那条') && texts.includes('盘上更新的回答'), JSON.stringify(texts));
ok('内存里那份也还在', texts.includes('内存里较旧的一条'));

console.log('〔③ 负向：不该把「已经被压掉的老消息」接回来〕');
const id2 = 'shistloss2';
saveSession({
  id: id2, title: 't2', createdAt: 1, updatedAt: 1,
  messages: [
    { role: 'system', content: 'sys', context: true },
    { role: 'user', content: '摘要2', context: true, summary: true, at: 100 },
    { role: 'user', content: '早已折进摘要的老话', at: 1794000000000 },
    { role: 'user', content: '最新的那句', at: 1794900000000 },
  ],
  rewinds: [],
});
const st2 = loadSession(id2);
st2.messages = [
  { role: 'system', content: 'sys', context: true },
  { role: 'user', content: '摘要2', context: true, summary: true, at: 100 },
  { role: 'user', content: '最新的那句', at: 1794900000000 },
];
saveSession(st2);
const t2 = loadSession(id2).messages.map((m) => String(m.content || ''));
ok('已折叠的老消息不会被接回来（不重复）', !t2.includes('早已折进摘要的老话'), JSON.stringify(t2));

try { rmSync(dir, { recursive: true, force: true }); } catch {}

console.log('');
console.log(`结果：${pass} 过 / ${fail} 挂`);
process.exit(fail ? 1 : 0);
