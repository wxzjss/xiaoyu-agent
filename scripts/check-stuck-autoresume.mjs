/**
 * 【掐轮之后自己接回来】
 *
 * 主人 2026-11-08 凌晨：「为什么小鱼Agent里面的会话总是做任务做着做着自己停了」。
 *
 * diag.log 现场（00:53~01:07，十四分钟六个会话）：
 *   静了 700 秒 / 325 秒 / 443 秒 / 306 秒 / 310 秒 / 305 秒
 * 看门狗把这些轮次一个个掐掉了 —— 这本身没错（真卡住总得有人动手），
 * 错在**掐完就撒手**：界面上那一轮就停在半路，没人接手，主人只能自己再打一句。
 *
 * 「自己停了」= 掐了 + 没人接。
 * 所以这个检查守的是后半截：
 *   · 掐之前一定先敲 onStuck（不然根本不知道要接）
 *   · 接之前一定等旧轮退干净（不然两轮同时改同一个 messages 数组）
 *   · 接的时候补一句框架消息（context: true，不画成主人说的话）说清原因
 *   · 接的动作走 startQueuedTurn（跟定时任务、插话接续同一条路）
 *   · 必须有次数上限，别在上游真挂时「掐→接→掐」转到天亮
 */
import { makeChecker } from './_harness_util.mjs';
import fs from 'node:fs';

const t = makeChecker('harness / 掐轮后自动接回');
const server = fs.readFileSync('src/server.mjs', 'utf8');
const wd = fs.readFileSync('src/harness/turn-watchdog.mjs', 'utf8');

// ── 1. 看门狗那半边：要留出口子 ────────────────────────────────
t.ok('看门狗支持 onStuck 回调', /const onStuck = typeof opts\.onStuck === 'function'/.test(wd));
t.ok('onStuck 在 abort 之前敲（先把账记下来再动手）',
  /onStuck\(sid[\s\S]{0,80}abort\(sid\)/.test(wd));

// ── 2. server 那半边：真的接住了 ───────────────────────────────
t.ok('server 定义了 scheduleStuckRetry', /function scheduleStuckRetry\(sid, info = \{\}\)/.test(server));
t.ok('看门狗启动时把 onStuck 接上', /onStuck:\s*\(sid, info\) => \{\s*try \{ scheduleStuckRetry\(sid, info\); \}/.test(server));
t.ok('有次数上限常量（主人钦定 10）', /const STUCK_RETRY_MAX = 10;/.test(server));
t.ok('有半小时窗口（过一阵子重新记账）', /const STUCK_RETRY_WINDOW = 30 \* 60 \* 1000;/.test(server));
t.ok('超限时老实停手并留痕', /stuck-retry-give-up/.test(server));
t.ok('等旧轮退干净再接手（看 ac.signal.aborted）',
  /const stillAlive = Boolean\(t && t\.ac && !t\.ac\.signal\.aborted\)/.test(server));
t.ok('最多等 90 秒，等不到也不无限等', /waited < 90000/.test(server));
t.ok('补的那句是框架消息（前端不画成主人说的）',
  /context: true,[\s\S]{0,160}_sysNote: true,[\s\S]{0,260}刚才那一轮静了/.test(server));
t.ok('接的动作走 startQueuedTurn', /await startQueuedTurn\(sessionId, null\)/.test(server));
t.ok('接成功/失败都写 diag', /diagLog\('stuck-retry'/.test(server) && /diagLog\('stuck-retry-fail'/.test(server));

// ── 3. 别把「主人点停止」也当成卡住去接 ────────────────────────
/* scheduleStuckRetry 只挂在看门狗的 onStuck 上，而 onStuck 只在
 * 「静默超过上限」时才调用 —— 主人点停止走的是另一条路（signal.aborted），
 * 不会经过这里。这条断言是防止以后有人图省事把它挂到全局 abort 上。 */
t.ok('scheduleStuckRetry 不挂在 abort / 点停止 那条路上',
  !/signal\.aborted[\s\S]{0,300}scheduleStuckRetry\(/.test(server));

t.done();
