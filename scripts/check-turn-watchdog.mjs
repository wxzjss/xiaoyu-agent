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
/* 【2026-11-08 改】5 分钟 → 12 分钟。
 * 5 分钟那条线把「正在思考」也算进去了，主人凌晨六个会话全撞在这上面。 */
t.ok('TURN_IDLE_MAX_MS 默认 12 分钟', /TURN_IDLE_MAX_MS = msOr\([^)]*12 \* 60 \* 1000/.test(dl));
/* 【2026-11-11 改】4 分钟 → 8 分钟。
 * 依据是真机 diag.log：上游静默 313 秒（5 分 13 秒）被 4 分钟那把尺子掐了，
 * 而那一轮其实在正常干活 —— 推理模型 + 网关缓冲，5 分钟不吐字是常态。
 * 8 分钟 = 给「想得久」留足余量，又不是无限等（下面行为用例仍守「真空转要掐」）。 */
t.ok('LLM_IDLE_MS 默认 8 分钟（推理模型+网关缓冲，5 分钟不吐字仍属正常）',
  /LLM_IDLE_MS = msOr\([^)]*8 \* 60 \* 1000/.test(dl));
t.ok('server 里真的启动了看门狗', /globalThis\.__xyTurnWatchdog = createTurnWatchdog\(/.test(server));
t.ok('看门狗用了整轮上限（不再是摆设）', /idleMs:\s*TURN_IDLE_MAX_MS/.test(server));
t.ok('等工具时放宽（不误杀长工具）', /toolIdleMs:\s*TOOL_MAX_MS \+ 60000/.test(server));
t.ok('等模型另立一档（不吃整轮上限）', /llmIdleMs:\s*LLM_IDLE_MS \+ 60000/.test(server));
t.ok('软掐 + 硬清两段都接上了',
  /abort:\s*\(sid\)[\s\S]{0,200}ac\.abort\('turn-idle'\)/.test(server)
  && /forceClean:\s*\(sid\)[\s\S]{0,240}runningTurns\.delete\(sid\)/.test(server));
t.ok('掐的时候写 diag（可追溯）', /diagLog\('watchdog-start'/.test(server));
t.ok('掐之前敲 onStuck（好让自动续跑接住）', /onStuck:\s*\(sid, info\)/.test(server));

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
    idleMs: 12 * 60 * 1000,
    toolIdleMs: 31 * 60 * 1000,
    llmIdleMs: 8 * 60 * 1000,
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
    idleMs: 12 * 60 * 1000,
    toolIdleMs: 31 * 60 * 1000,
    llmIdleMs: 8 * 60 * 1000,
  });
  wd.scan(now);
  t.ok('事件没有 at 时退回开跑时间判（不会漏判）', aborted.includes('noAt'), aborted.join(','));
}

/* ── 【2026-11-08 核心修复】别再把「想得久」当成「卡死了」 ──────────
 *
 * 主人报「做任务做着做着自己停了」，diag.log 里六个会话全是撞 5 分钟那条线。
 * 下面两条守的就是这个：静默很久但**还在正常等模型**的，不能掐。 */
{
  const now = Date.now();
  const turns = new Map([['thinking', { startedAt: now - 9 * 60 * 1000 }]]);
  /* 最后一条是模型吐的字（5 分 13 秒前，就是 diag.log 里那 313 秒）→ 此刻在等它回下一句
   * → 走 llm 档（8 分钟），5.2 < 8 不掐。 */
  const lives = new Map([['thinking', { events: [{ type: 'text', at: now - 313 * 1000 }] }]]);
  const aborted = [];
  const wd = createTurnWatchdog({
    turns: () => turns.entries(),
    liveOf: (sid) => lives.get(sid),
    abort: (sid) => aborted.push(sid),
    idleMs: 12 * 60 * 1000,
    toolIdleMs: 31 * 60 * 1000,
    llmIdleMs: 8 * 60 * 1000,
  });
  wd.scan(now);
  t.ok('在等模型、静了 313 秒（真机被误杀那次）→ 不掐', !aborted.includes('thinking'), aborted.join(','));
}
{
  const now = Date.now();
  /* 整轮已经 9 分钟，但最后一条事件不带 at，算下来「静默」按开跑时间 = 9 分钟。
   * 修复前整轮档是 5 分钟 → 必掐；现在 12 分钟 → 不该掐。 */
  const turns = new Map([['quiet9', { startedAt: now - 9 * 60 * 1000 }]]);
  const lives = new Map([['quiet9', { events: [{ type: 'whale' }] }]]);
  const aborted = [];
  const wd = createTurnWatchdog({
    turns: () => turns.entries(),
    liveOf: (sid) => lives.get(sid),
    abort: (sid) => aborted.push(sid),
    idleMs: 12 * 60 * 1000,
    toolIdleMs: 31 * 60 * 1000,
    llmIdleMs: 8 * 60 * 1000,
  });
  wd.scan(now);
  t.ok('静了 9 分钟但不是真空转 → 不掐（修复前 5 分钟就误杀）', !aborted.includes('quiet9'), aborted.join(','));
}
{
  /* 反过来：真·真空转（一直没有像样的事件）也要在 12 分钟后动手，不能变成永不管 */
  const now = Date.now();
  const turns = new Map([['dead', { startedAt: now - 13 * 60 * 1000 }]]);
  const lives = new Map([['dead', { events: [{ type: 'whale' }] }]]);
  const aborted = [];
  const wd = createTurnWatchdog({
    turns: () => turns.entries(),
    liveOf: (sid) => lives.get(sid),
    abort: (sid) => aborted.push(sid),
    idleMs: 12 * 60 * 1000,
    toolIdleMs: 31 * 60 * 1000,
    llmIdleMs: 8 * 60 * 1000,
  });
  wd.scan(now);
  t.ok('真·真空转 13 分钟 → 还是要掐', aborted.includes('dead'), aborted.join(','));
}
{
  /* onStuck：掐之前要先敲一下（自动续跑靠它） */
  const now = Date.now();
  const turns = new Map([['x', { startedAt: now - 20 * 60 * 1000 }]]);
  const lives = new Map([['x', { events: [{ type: 'tool_start', at: now - 40 * 60 * 1000 }] }]]);
  const stuck = [];
  const wd = createTurnWatchdog({
    turns: () => turns.entries(),
    liveOf: (sid) => lives.get(sid),
    abort: () => {},
    onStuck: (sid, info) => stuck.push({ sid, info }),
    idleMs: 12 * 60 * 1000,
    toolIdleMs: 31 * 60 * 1000,
    llmIdleMs: 8 * 60 * 1000,
  });
  wd.scan(now);
  t.ok('掐之前先敲 onStuck（自动续跑接得住）', stuck.length === 1 && stuck[0].sid === 'x', JSON.stringify(stuck));
}

{
  /* 【2026-11-08 核心现场】续跑轮一个事件都不推，能空挂 12 分钟
   * 【2026-11-11】等模型那档 4→8 分钟后，这里用 9 分钟：仍要早于整轮 12 分钟动手。 */
  const now = Date.now();
  const turns = new Map([['empty', { startedAt: now - 9 * 60 * 1000 }]]);
  const lives = new Map([['empty', { events: [] }]]);
  const aborted = [];
  const wd = createTurnWatchdog({
    turns: () => turns.entries(),
    liveOf: (sid) => lives.get(sid),
    abort: (sid) => aborted.push(sid),
    idleMs: 12 * 60 * 1000,
    toolIdleMs: 31 * 60 * 1000,
    llmIdleMs: 8 * 60 * 1000,
  });
  wd.scan(now);
  t.ok('一个事件都没有 → 按等模型那档 9 分钟就掐（不空挂到 12 分钟）', aborted.includes('empty'), aborted.join(','));
}

/* 源码守卫：续跑轮不许再把事件吞掉 */
const serverSrc = fs.readFileSync('src/server.mjs', 'utf8');
/* 判据认「续跑轮」这个函数体：它后面紧接着 repairHistory(history)。
 * 不能写「全文件不许有 onEvent: () => {}」——别的路径（小鲸、子智能体）
 * 有意用空回调，一刀切会冤枉它们。 */
t.ok('续跑轮的事件接上了 send（不是空的 onEvent）',
  /onEvent: \(ev\) => \{ try \{ send\(ev\); \} catch \{\} \},[\s\S]{0,120}repairHistory\(history\)/.test(serverSrc));
/* 【2026-11-08 补】光把 onEvent 改成 send 是不够的：
 * send 只在 /api/chat 和 startQueuedTurn 里局部定义，续跑函数里调它会抛
 * ReferenceError 被吞掉，事件照样全丢。必须连 live 和局部 send 一起补齐。 */
t.ok('续跑轮有自己的 live（事件要有地方落）',
  /runningTurns\.set\(sessionId, turn\);[\s\S]{0,900}const live = openLiveForQueuedTurn\(sessionId\)/.test(serverSrc));
t.ok('续跑轮有自己的局部 send（不是引用别人作用域的）',
  /const live = openLiveForQueuedTurn\(sessionId\);\s*\n\s*const send = \(ev\) =>/.test(serverSrc));

t.done();
