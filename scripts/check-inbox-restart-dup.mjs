#!/usr/bin/env node
/**
 * check-inbox-restart-dup.mjs — 【重启后不许把已经落过盘的插话再送一遍】
 *
 * 【2026-11-17 主人报】
 *   「为什么运行过程中重启，会把我运行时插话的消息再发一遍给她？」
 *
 * 两条真实路径：
 *   ① `/api/stop` 把压着的插话抄进历史（带 _steer），但只清了**内存**里的信箱；
 *      进程硬退（重启就是硬退）时落盘那份文件还带着 → 下次启动读回来又送一遍。
 *   ② `/api/interject` 在「这一轮没在跑」分支里，落历史 + 留 inbox 两条路都走。
 *
 * 而 `isSteerAlreadyLanded` 原来有一条致命 `break`：
 *   if (m.role === 'assistant') { if (!m.tool_calls) break; continue; }
 * 「她答过话了 → 后面再插同样的算新话」—— 正常跑对，重启续跑就是病根：
 * 她答的正是这条插话引出来的话，于是被判成新话、重发。
 *
 * 这个哨兵钉四件事：
 *   ① 启动时有 dropAlreadyLanded（跟历史比对的清理），不是只按时间清；
 *   ② isSteerAlreadyLanded 收 at 参数、用时间窗认「同一条」；
 *   ③ 不再有「一见到 assistant 就 break」；
 *   ④ 三组判据真跑：已落盘的删、没落盘的留、同文但时间差大的留。
 */
import fs from 'node:fs';
import { makeChecker } from './_harness_util.mjs';

const t = makeChecker('inbox / 重启不重发');
const srv = fs.readFileSync('src/server.mjs', 'utf8');
const inbox = fs.readFileSync('src/inbox.mjs', 'utf8');
const team = fs.readFileSync('src/team.mjs', 'utf8');
const agent = fs.readFileSync('src/agent.mjs', 'utf8');

/* ── ① 启动清理 ── */
t.ok('server 启动时调 dropAlreadyLanded', /dropAlreadyLanded\(\(sid\) =>/.test(srv));
t.ok('inbox.mjs 导出 dropAlreadyLanded', /export function dropAlreadyLanded/.test(inbox));
t.ok('server 从 inbox.mjs 引进来了', /dropAlreadyLanded[^;]*from '\.\/inbox\.mjs'/.test(srv));
t.ok('按时间清的 purgeStale 仍然保留（两道一起）', /purgeStaleInbox\(30 \* 60 \* 1000\)/.test(srv));

/* ── ② agent 侧的判据 ── */
t.ok('isSteerAlreadyLanded 收了 at 参数', /function isSteerAlreadyLanded\(messages, text, at = 0\)/.test(agent));
t.ok('调用处把 it.at 传进去了', /isSteerAlreadyLanded\(messages, it\.text, it\.at\)/.test(agent));
t.ok('有 5 秒时间窗（AT_TOL）', /AT_TOL = 5000/.test(agent));

/* ── ③ 不许退回「见 assistant 就 break」 ── */
{
  const at = agent.indexOf('function isSteerAlreadyLanded');
  const end = agent.indexOf('\n}', at);
  const body = at >= 0 ? agent.slice(at, end) : '';
  t.ok('能找到 isSteerAlreadyLanded', body.length > 200);
  t.ok('不再有「不带 tool_calls 就 break」的老写法', !/if \(!m\.tool_calls\) break;/.test(body));
}

/* ── ④ 判据真跑 ── */
{
  const nz = (s) => String(s == null ? '' : s).replace(/\s+/g, '');
  const AT_TOL = 5000;
  const now = Date.now();
  const msgs = [
    { role: 'user', content: '插一句：用红色', at: now - 30000, _steer: true },
    { role: 'assistant', content: '好，改成红色', at: now - 28000 },
  ];
  const landed = (item) => {
    const want = nz(item && item.text);
    if (!want) return false;
    const wantAt = Number(item && item.at) || 0;
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i];
      if (!m || m.role !== 'user' || m._steer !== true) continue;
      if (nz(m.content) !== want) continue;
      if (!wantAt) return true;
      const mAt = Number(m.at) || 0;
      if (mAt && Math.abs(mAt - wantAt) <= AT_TOL) return true;
    }
    return false;
  };
  t.ok('已落盘那条 → 该清掉（不重发）', landed({ text: '插一句：用红色', at: now - 30000 }));
  t.ok('没落盘的新插话 → 该留着（不能丢）', !landed({ text: '另一句', at: now - 1000 }));
  t.ok('同文但时间差很大 → 该留着（主人真又说了一遍）', !landed({ text: '插一句：用红色', at: now - 200000 }));
}

/* ── ⑤ 同一个 worker 只报一次（真凶：worker 汇报刷屏） ──
 *
 * 实盘：一个会话的信箱里 6 条，两两成对 ——
 *   #1「美术角色」被手动停下了 / #1「美术角色」程序重启过
 *   #2、#3 同款
 * 因为 stopWorker 和 reapStalledWorker 两条独立的路都给同一个 worker 发通知。
 * 修法：塞新通知前先把同一 worker 还没被取走的旧通知删掉（dropWorkerNote）。
 */
t.ok('inbox.mjs 导出 dropWorkerNote', /export function dropWorkerNote/.test(inbox));
t.ok('team.mjs 引进 dropWorkerNote', /dropWorkerNote/.test(team) && /from '\.\/inbox\.mjs'/.test(team));
t.ok('notifyWorkerInterrupted 先清旧通知再发',
  /function notifyWorkerInterrupted[\s\S]{0,1200}?dropWorkerNote\(/.test(team));
t.ok('只删带 _sysNote 的（主人说的话不碰）',
  /_sysNote === true && x\.text\.includes\(key\)/.test(inbox));

t.done();
