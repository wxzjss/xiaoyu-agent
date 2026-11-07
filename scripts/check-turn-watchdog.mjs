/**
 * 【整轮空闲看门狗】
 *
 * 2026-11-08 主人说「根治」时，现场是这样的：
 *   三个会话同时卡住 —— events 不动、会话文件十几分钟不写，
 *   界面上一直显示「正在跑」。
 *
 * 查下来两处：
 *   ① 只有「等模型」那层有超时（withTimeout / stallGuard），
 *      卡在工具、写盘、某个没人 resolve 的 await 上，完全没人管；
 *   ② `TURN_IDLE_MAX_MS`（整轮空闲）**只是常量表里一个数字**，
 *      整个项目没有一行代码按它去判 —— 60 分钟的摆设。
 *
 * 这个检查守两件事：
 *   · 源码层面：常量真的被用在看门狗上、看门狗真的在 startServer 里启动
 *   · 行为层面：卡住的掐、等工具的不误杀、健康的更不误杀、软掐不退就硬清
 */
import { makeChecker } from './_harness_util.mjs';
import fs from 'node:fs';

const t = makeChecker('harness / 整轮空闲看门狗');
const server = fs.readFileSync('src/server.mjs', 'utf8');
const dl = fs.readFileSync('src/deadline.mjs', 'utf8');

// ── 1. 源码守卫 ────────────────────────────────────────────────
t.ok('TURN_IDLE_MAX_MS 默认 5 分钟', /TURN_IDLE_MAX_MS = msOr\([^)]*5 \* 60 \* 1000/.test(dl));
t.ok('server 里真的启动了看门狗', /globalThis\.__xyTurnWatchdog = createTurnWatchdog\(/.test(server));
t.ok('看门狗用了整轮上限（不再是摆设）', /idleMs:\s*TURN_IDLE_MAX_MS/.test(server));
t.ok('等工具时放宽（不误杀长工具）', /toolIdleMs:\s*TOOL_MAX_MS \+ 60000/.test(server));
t.ok('软掐 + 硬清两段都接上了',
  /abort:\s*\(sid\)[\s\S]{0,200}ac\.abort\('turn-idle'\)/.test(server)
  && /forceClean:\s*\(sid\)[\s\S]{0,240}runningTurns\.delete\(sid\)/.test(server));
t.ok('掐的时候写 diag（可追溯）', /diagLog\('watchdog-start'/.test(server));

// ── 2. 行为 ────────────────────────────────────────────────────
const { createTurnWatchdog } = await import('../src/harness/turn-watchdog.mjs');

function makeWorld({ modelIdleMin = 18, toolIdleMin = 18, healthyIdleSec = 30 } = {}) {
  const now = Date.now();
  const turns = new Map([
    ['stuckLLM', { startedAt: now - 20 * 60 * 1000 }],
    ['stuckTool', { startedAt: now - 20 * 60 * 1000 }],
    ['healthy', { startedAt: now - 20 * 60 * 1000 }],
  ]);
  const lives = new Map([
    ['stuckLLM', { events: [{ type: 'tool_end', at: now - modelIdleMin * 60 * 1000 }] }],
    ['stuckTool', { events: [{ type: 'tool_start', at: now - toolIdleMin * 60 * 1000 }] }],
    ['healthy', { events: [{ type: 'text', at: now - healthyIdleSec * 1000 }] }],
  ]);
  const aborted = [];
  const cleaned = [];
  const wd = createTurnWatchdog({
    turns: () => turns.entries(),
    liveOf: (sid) => lives.get(sid),
    abort: (sid) => aborted.push(sid),
    forceClean: (sid) => cleaned.push(sid),
    idleMs: 5 * 60 * 1000,
    toolIdleMs: 31 * 60 * 1000,
  });
  return { wd, now, aborted, cleaned };
}

{
  const { wd, now, aborted } = makeWorld();
  wd.scan(now);
  t.ok('卡在等模型的被掐掉', aborted.includes('stuckLLM'), aborted.join(','));
  t.ok('等工具的（18 分钟 < 31）不误杀', !aborted.includes('stuckTool'), aborted.join(','));
  t.ok('一直在动的更不误杀', !aborted.includes('healthy'), aborted.join(','));
}

{
  const { wd, now, aborted, cleaned } = makeWorld();
  wd.scan(now);
  t.ok('软掐之后先不硬清', cleaned.length === 0, cleaned.join(','));
  wd.scan(now + 61000);
  t.ok('软掐 60 秒还没退 → 硬清', cleaned.includes('stuckLLM'), cleaned.join(','));
}

{
  /* 等工具超过 31 分钟：这时该掐了 */
  const { wd, now, aborted } = makeWorld({ toolIdleMin: 33 });
  wd.scan(now);
  t.ok('等工具超过上限也要掐', aborted.includes('stuckTool'), aborted.join(','));
}

{
  /* 事件里没有 at 字段（小鲸那条就不带）—— 不能因为算不出时间就误杀 */
  const now = Date.now();
  const turns = new Map([['noAt', { startedAt: now - 20 * 60 * 1000 }]]);
  const lives = new Map([['noAt', { events: [{ type: 'whale' }] }]]);
  const aborted = [];
  const wd = createTurnWatchdog({
    turns: () => turns.entries(),
    liveOf: (sid) => lives.get(sid),
    abort: (sid) => aborted.push(sid),
    idleMs: 5 * 60 * 1000,
    toolIdleMs: 31 * 60 * 1000,
  });
  wd.scan(now);
  t.ok('事件没有 at 时退回开跑时间判（不会漏判）', aborted.includes('noAt'), aborted.join(','));
}

t.done();
