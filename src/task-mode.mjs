/**
 * 【办事模式】—— 主智能体不再自己干活，只发任务、检查、验收、压上下文（2026-11-03）。
 *
 * 主人原话：
 *   「将【办事模式】改为，启用后当前会话主智能体会根据任务复杂程度临时创建一个或多个
 *     子智能体（创建的子智能体仅当前会话可见与使用，用完或会话被删除后自动删除），
 *     当前会话的主智能体不负责工作，只负责给子智能体发布任务、检查、验收、压缩等。
 *     子智能体每完成一项任务都需要给主智能体汇报工作情况，让主智能体来检查、找问题
 *     并做出决定，且主智能体会决定如何删除该任务的不重要的占用上下文的内容，
 *     如何简洁摘要重要的内容等」
 *   「主智能体指左侧排序最靠前的已启用且未被禁用的智能体」
 *
 * ── 【2026-11-03 主人：「把办事模式并入专业模式里面」】───────────────
 *
 * 原先这一档是顶栏第三颗独立按钮（fe5c7dc 做后端、bac0633 做界面）。
 * 主人否掉了那个形态：它本来就是「怎么干活」的一部分，另开一颗按钮等于让人
 * 多记一个开关、还多一处可能对不齐的地方。现在它不再是独立档位，而是
 * **专业模式里的一个选项**（'self' 自己动手 / 'workers' 派活），
 * 那个选项的存与读、以及「专业模式关着就一定是 self」这条规矩，
 * 全在 pure.mjs 里（doerOf / setDoer）。
 *
 * 于是本文件**不再有开关**：开关表 .state/task-mode.json 退成历史遗留，
 * 老文件留着不动、也不再读它办事 —— 迁移就是「主人再在专业模式里勾一次」，
 * 没勾就等于没开，这比自动继承一个已经看不见的开关安全。
 *
 * ── 这个文件现在还剩什么 ──────────────────────────────────────────
 *
 *   ① 花名册：每个会话开出来的 worker（.state/task-workers/<sid>.json）；
 *   ② 派活规矩的正文 taskPromptBlock()（由 pure.mjs 在派活那一档拼进提示词）；
 *   ③ 白名单 KEEP_TOOLS（由 agent.mjs 的 toolsForTurn 用来收工具）。
 *
 * 一句话：从「一个模式」降级成「一套给派活用的零件」。
 */
import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync, appendFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { config } from './config.mjs';
import { isToolEnabled } from './features.mjs';
// doerOf 在 pure.mjs。「谁动手」只认它一个，这里不再自己看开关表。
// 注意方向：pure.mjs 只 import 了 task-mode 的 taskPromptBlock，这里 import 回去
// 会不会成环？——不会：ESM 静态成环但两边都只在**函数体里**用对方的导出，
// 求值阶段不碰，所以安全（跟 tools.mjs ↔ persona.mjs 那个坑不一样，那边是模块级常量）。
import { doerOf } from './pure.mjs';

/** 界面上显示的名字。改文案只改这里。 */
export const MODE_NAME = '办事模式';

/** 这一档下，主智能体手上**只留**这些工具。别的全拿走。 */
export const KEEP_TOOLS = [
  'spawn_worker',   // 派活 / 追问 / 收工
  'list_workers',   // 看现在有哪几个在跑、干到哪儿了
  'plan',           // 记任务清单
  'note',           // 记事
  'chronicle_toc', 'chronicle_search', 'chronicle_read', // 翻史书（检查子智能体的说法对不对）
  'folded_list', 'folded_read',                          // 翻折叠箱（压上下文前先确认原文在）
];

function file() {
  return join(config.dataDir, '.state', 'task-mode.json');
}

function logFile() {
  return join(config.dataDir, '.state', 'task.log');
}

function workersDir() {
  return join(config.dataDir, '.state', 'task-workers');
}

/** 读整张表：{ '<sessionId>': true }。坏文件一律当空表（= 全都没开）。 */
function readTable() {
  try {
    const f = file();
    if (!existsSync(f)) return {};
    const j = JSON.parse(readFileSync(f, 'utf8'));
    if (!j || typeof j !== 'object' || Array.isArray(j)) return {};
    // 两种形态都认：{version,on:{sid:true}} 和早年那版扁平的 {sid:true}。
    const src = (j.on && typeof j.on === 'object' && !Array.isArray(j.on)) ? j.on : j;
    const map = {};
    for (const [k, v] of Object.entries(src)) {
      if (k === 'version' || k === 'on') continue;
      if (v === true) map[k] = true;
    }
    return map;
  } catch {
    return {};
  }
}

function writeTable(map) {
  const f = file();
  try {
    mkdirSync(dirname(f), { recursive: true });
    const tmp = f + '.tmp';
    writeFileSync(tmp, JSON.stringify({ version: 1, on: map }, null, 2), 'utf8');
    renameSync(tmp, f);
    return true;
  } catch (e) {
    console.warn('[task-mode] 写不进盘：', String(e?.message ?? e));
    return false;
  }
}

function log(line) {
  try {
    mkdirSync(dirname(logFile()), { recursive: true });
    appendFileSync(logFile(), `[${new Date().toISOString()}] ${line}\n`, 'utf8');
  } catch {
    /* 日志写不进去不影响功能 */
  }
}

/*
 * 【这里原来有两个函数 taskOn / setTaskOn，2026-11-03 删了】
 *
 * 它们是「办事模式」还独立成档时的开关。主人把这一档并进专业模式之后，
 * 谁动手由 pure.mjs 的 doerOf() 说了算，这两个函数已经没有任何调用方 ——
 * 留着就是第二套开关，迟早跟真开关判出两种结果。
 *
 * 老数据（.state/task-mode.json）不读了。真要清，那个文件删掉就行，
 * 删了不影响任何东西 —— 现在没人读它。
 */
/**
 * 【已废弃，别再用了】现在没有「哪些会话开着这一档」这回事了。
 *
 * 谁动手是 pure.json 里的表，想看就自己读 pure.json，或者对每个会话调 doerOf()。
 * 这个函数留着只是怕别的地方还在 import（check-identifiers 会报未定义），一律返空。
 */
export function taskSessions() {
  return [];
}
/* ── 子智能体花名册 ────────────────────────────────────────────────
 *
 * 主人要「创建的子智能体仅当前会话可见与使用，用完或会话被删除后自动删除」。
 * 所以不用全局表，每个会话一个文件：.state/task-workers/<sid>.json。
 * 好处是「会话被删」这件事天然就覆盖了 —— 列表文件跟着场景走，
 * 外面的清理逻辑按会话 id 删一个文件就行，不会漏也不会误伤别人。
 *
 * 记什么：id（子会话 id）、名字、派给它的任务、状态、开始时间、最后一句话、几轮几次工具。
 * 不记正文 —— 正文在子智能体自己的会话里，要看调 spawn_worker 的 query。
 */

function workerFile(sid) {
  const key = String(sid || '').replace(/[^a-zA-Z0-9_-]/g, '');
  if (!key) return '';
  return join(workersDir(), key + '.json');
}

function readWorkers(sid) {
  try {
    const f = workerFile(sid);
    if (!f || !existsSync(f)) return [];
    const j = JSON.parse(readFileSync(f, 'utf8'));
    return Array.isArray(j && j.workers) ? j.workers : [];
  } catch {
    return [];
  }
}

function writeWorkers(sid, list) {
  const f = workerFile(sid);
  if (!f) return false;
  try {
    mkdirSync(dirname(f), { recursive: true });
    const tmp = f + '.tmp';
    writeFileSync(tmp, JSON.stringify({ sessionId: String(sid), workers: list }, null, 2), 'utf8');
    renameSync(tmp, f);
    return true;
  } catch (e) {
    console.warn('[task-mode] 花名册写不进盘：', String(e?.message ?? e));
    return false;
  }
}

/** 这个会话现有的子智能体（给界面和主智能体看）。 */
export function listWorkers(sessionId) {
  return readWorkers(String(sessionId || 'default'))
    .map((w) => ({
      id: String(w.id || ''),
      name: String(w.name || ''),
      task: String(w.task || ''),
      status: String(w.status || 'running'),
      startedAt: Number(w.startedAt) || 0,
      endedAt: Number(w.endedAt) || 0,
      rounds: Number(w.rounds) || 0,
      tools: Number(w.tools) || 0,
      said: String(w.said || ''),
    }))
    .filter((w) => w.id);
}

/** 加一个进花名册（开跑前调）。 */
export function noteWorker(sessionId, worker) {
  const sid = String(sessionId || 'default');
  const list = readWorkers(sid);
  // 调用方不给 id 就自己发一个：门牌号是花名册的事，派活那边不该关心它长什么样。
  const given = String(worker && worker.id || '').trim();
  const used = new Set(list.map((w) => String(w.id)));
  let id = given;
  if (!id) {
    let n = 1;
    while (used.has(String(n))) n += 1;
    id = String(n);
  }
  const at = list.findIndex((w) => String(w.id) === id);
  const rec = {
    id,
    name: String(worker.name || ''),
    task: String(worker.task || ''),
    status: String(worker.status || 'running'),
    startedAt: Number(worker.startedAt) || Date.now(),
    endedAt: Number(worker.endedAt) || 0,
    rounds: Number(worker.rounds) || 0,
    tools: Number(worker.tools) || 0,
    said: String(worker.said || ''),
  };
  if (at >= 0) list[at] = rec;
  else list.push(rec);
  writeWorkers(sid, list);
  return rec;
}

/** 收工时改它的状态（跑完/挂了/超时都走这儿）。 */
export function finishWorker(sessionId, id, patch = {}) {
  const sid = String(sessionId || 'default');
  const key = String(id || '');
  if (!key) return null;
  const list = readWorkers(sid);
  const at = list.findIndex((w) => String(w.id) === key);
  if (at < 0) return null;
  list[at] = {
    ...list[at],
    status: String(patch.status || 'done'),
    endedAt: Number(patch.endedAt) || Date.now(),
    rounds: Number(patch.rounds) || Number(list[at].rounds) || 0,
    tools: Number(patch.tools) || Number(list[at].tools) || 0,
    said: patch.said === undefined ? String(list[at].said || '') : String(patch.said || ''),
  };
  writeWorkers(sid, list);
  return list[at];
}

/** 注销一个（用完就删）。 */
export function dropWorker(sessionId, id) {
  const sid = String(sessionId || 'default');
  const key = String(id || '');
  const list = readWorkers(sid).filter((w) => String(w.id) !== key);
  writeWorkers(sid, list);
  return { ok: true, workers: list.length };
}

/** 整个会话的子智能体全注销（关这一档、或会话被删时调）。 */
export function wipeWorkers(sessionId) {
  const sid = String(sessionId || 'default');
  writeWorkers(sid, []);
  log(`注销全部子智能体 session=${sid}`);
  return { ok: true };
}

/**
 * 给系统提示用的一段话。
 *
 * 【改过一回】原来开头有一句 `if (!taskOn(sessionId)) return '';` ——
 * 那是「独立模式」时代的写法。现在该不该发由调用方决定
 * （pure.mjs 里只有 doerOf 是 workers 时才拼它），这里再判一次等于
 * 同一个意思有两个地方说了算。所以现在只要调用方拼了它就照发。
 *
 * 不拼的时候一个字不花、缓存前缀不动 —— 那份判断在调用方那里。
 *
 * 【为什么要把「不许自己动手」写成正面的行为指令】
 * 光说「你不负责工作」模型会理解成「我可以先查一查再派活」—— 那还是它在干。
 * 所以每一条都写成「该做什么」：先拆任务、派出去、等汇报、检查、给结论。
 */
export function taskPromptBlock(sessionId, mainAgentName = '') {
  const who = String(mainAgentName || '').trim();
  const head = who
    ? `【派活 · 这一轮是这个模式】这个会话现在的「主智能体」是 ${who} —— 也就是你。`
    : '【派活 · 这一轮是这个模式】你是这个会话的主智能体。';
  return [
    head,
    '从这一轮起，你的活不是自己动手，是**组织别人动手**。',
    '',
    '1. 你只做四件事：拆任务、派活、检查、给结论。读文件、改代码、跑命令这些全部交给子智能体。',
    '   你自己伸手去做，就是这一档最严重的错误 —— 那等于一边当包工头一边抢工人的活。',
    '2. 按任务复杂程度决定开几个。一件事能一次干完就只开一个；互相不依赖、可以同时推进的才开多个。',
    '   别为了显得忙而开一堆，也别把三件互不相干的事塞给同一个。',
    '3. 每派一件活，说清楚四样：要它做什么、做完算什么样的成功、在哪儿干（路径）、不许碰什么。',
    '   说不清楚就别派 —— 子智能体不会来问你，它会自己猜。',
    '4. 子智能体跑完必须给你汇报：做了什么、证据是什么、哪里没做到、还剩什么。',
    '   汇报一回来，第一件事是**检查**：它说改了这个文件，你就真去读那一段；它说跑通了，你就看输出。',
    '   不许凭它的说法就采信，也不许自己再跑去复核一遍（那是抢活）—— 用只读工具核，别动手改。',
    '5. 检查出问题就把问题原样退回给它接着干（同一个子智能体，别另开一个从头来）。',
    '   只有「活儿本身变了」才新开一个。',
    '6. 上下文归你管。你要决定：哪一段已经没用了（删掉）、哪一段以后还要用（留下）、',
    '   哪一段该压成一句话（摘要）。压的时候只留「结论、约束、走过的死路」这三类，',
    '   中间那些试错的过程不要留 —— 但原文本来就在折叠箱里（folded_list / folded_read），',
    '   删之前先确认真的能翻回来。',
    '7. 对主人说话还是你自己说。子智能体的干活过程不往主人眼前搬，',
    '   你只报三样：做完了什么、还差什么、下一步怎么办。',
    '',
    '一句话：你是这个会话里唯一做判断的人，也是唯一不亲自动手的人。',
  ].join('\n');
}

/**
 * 某条会话的记忆本子/花名册该不该被清 —— 会话被删的时候外面调一下。
 *
 * 只做「注销花名册」这一件事：开关表那格由 setTaskOn(sid, false) 管。
 */
export function forgetSession(sessionId) {
  const sid = String(sessionId || '');
  if (!sid) return { ok: false };
  try {
    const f = workerFile(sid);
    if (f && existsSync(f)) {
      const bak = f + '.gone';
      try { renameSync(f, bak); } catch { /* 改名失败就当没有 */ }
    }
  } catch { /* 忽略 */ }
  const map = readTable();
  if (map[sid]) {
    delete map[sid];
    writeTable(map);
  }
  log(`会话没了，忘掉它 session=${sid}`);
  return { ok: true };
}

/** 给自检/界面用的一份状态。 */
export function taskInfo(sessionId) {
  const sid = String(sessionId || 'default');
  const list = listWorkers(sid);
  /**
   * available = 【功能】面板里这一档还在不在。
   * 关着的时候这颗按钮要整块拿掉（不是灰掉），跟专业模式一个规矩：
   * 功能关着＝这个功能不存在，所以 on 也一并按 false 报出去，
   * 免得界面上一颗看不见的开关还亮着，而服务端其实已经在按「关」办事。
   */
  let available = true;
  try {
    available = isToolEnabled('spawn_worker') !== false;
  } catch {
    available = true;
  }
  /**
   * on 现在报的是「这个会话此刻是不是在派活」—— 跟真正干活的判断同源
   * （pure.mjs 的 doerOf），而不是老开关表。界面和自检拿到的必须是
   * 「实际会怎么干」，不是一个已经没人看的勾。
   */
  let on = false;
  if (available) {
    try {
      on = doerOf(sid) === 'workers';
    } catch {
      on = false;
    }
  }
  return {
    sessionId: sid,
    available,
    on,
    keepTools: [...KEEP_TOOLS],
    workers: list,
    running: list.filter((w) => w.status === 'running').length,
  };
}

/** 花名册目录（清理/调试用）。 */
export function workersPath() {
  return resolve(workersDir());
}
