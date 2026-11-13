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
 * ── 【2026-11-01 主人：「删除专业模式，回滚办事模式」】────────────────
 *
 * 中间有一段时间这一档被并进了专业模式（当成里面的一个「谁动手」选项）。
 * 主人否掉了那个形态：专业模式整块删掉，这一档回到独立的开关 —— 顶栏一颗
 * 「办事模式」按钮，按会话各开各的，存在 .state/task-mode.json。
 *
 * ── 这个文件里有什么 ──────────────────────────────────────────────
 *
 *   ① 开关：taskOn() / setTaskOn() / taskFeatureOn()；
 *   ② 花名册：每个会话开出来的 worker（.state/task-workers/<sid>.json）；
 *   ③ 派活规矩的正文 taskPromptBlock()（由 persona.mjs 拼进系统提示）；
 *   ④ 白名单 KEEP_TOOLS（由 agent.mjs 的 toolsForTurn 用来收工具）。
 *
 * 一句话：开关在这里，规矩在这里，谁动手只认 taskOn 一个来源。
 */
import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync, appendFileSync, statSync, rmSync } from 'node:fs';
import { join, dirname, resolve, basename } from 'node:path';
import { config } from './config.mjs';
import { featureOnFor } from './features.mjs';

/** 界面上显示的名字。改文案只改这里。 */
export const MODE_NAME = '办事模式';

/** 这一档下，主智能体手上**只留**这些工具。别的全拿走。 */
export const KEEP_TOOLS = [
  'spawn_worker',   // 派活 / 追问 / 收工
  'spawn_workers',  // 一次派好几件，让它们同时干
  'tell_worker',    // 干活途中补一句（改方向、加要求）
  'watch_worker',   // 看它现在干到哪儿了
  'list_workers',   // 看现在有哪几个在跑、干到哪儿了
  'plan',           // 记任务清单
  'note',           // 记事
  'chronicle_toc', 'chronicle_search', 'chronicle_read', // 翻史书（检查子智能体的说法对不对）
  'folded_list', 'folded_read',                          // 翻折叠箱（压上下文前先确认原文在）
  /* 【2026-11-06 修·自相矛盾：让它去验收，却不给验收工具】
   *  提示词第 4 条写着「它说改了这个文件，你就真去读那一段」「用只读工具核」，
   *  可白名单里原来只有派活那几个 —— read_file / list_dir 全被收走了。
   *  结果是它要么凭汇报空口采信，要么违约自己跑去看（两样都比给只手糟）。
   *  只放两只「只读的手」回来：读文件、列目录。
   *  写文件、跑命令、改代码仍旧一概不给 —— 那才是「抢活」。 */
  'read_file',      // 验收：它说改了哪儿，真去看一眼
  'list_dir',       // 验收：它说在哪儿干，真去列一下
  /* 【2026-11-06 加·search_files】
   *  agent.mjs 的只读白名单里早就写了这个名字，可这个工具从来没被实现过 ——
   *  结果她为了搜一个词，只能 node -e 现写一小段脚本读全目录，
   *  一次搜索就是一次完整的模型往返。【检查鱼】那个会话里这种调用出现了 66 次。
   *  现在补上：搜东西有专门的手，验收也用它。 */
  'search_files',   // 搜：这个函数/字符串在哪儿
  /* 【2026-11-06 修·办事模式把「服务主人」的手也收走了】
   *  这三个不是「干活工具」，是「听主人话」用的：
   *   · restart_self —— 主人说重启，得能重启（这是重启的唯一正经入口）
   *   · send_file    —— 主人要文件，得发得出去
   *   · ask_peer     —— 要问屋里另一个人，得能问
   *  收走它们，等于办事模式下主人叫不动她，跟「只派活别动手」不是一回事。 */
  'restart_self', 'send_file', 'ask_peer',
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
    /* 【2026-11-06 修·BOM 会让办事模式开关静默失效】
     *  PowerShell 的 Set-Content -Encoding utf8 会写 EF BB BF，
     *  JSON.parse 直接抛错，下面那句 catch 一吞就返回空表 ——
     *  表现是「明明开了办事模式，重开一次就没了」，还一句日志都没有。
     *  admin-mode.json 就这么丢过管理员权限。读之前先削 BOM。 */
    let _raw = readFileSync(f, 'utf8');
    if (_raw.charCodeAt(0) === 0xfeff) _raw = _raw.slice(1);
    const j = JSON.parse(_raw);
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

/* 【2026-11-03 办事模式严检】日志超过 512KB 就轮转：老的改名 .1（只留一份），新日志重新开。
 * 原来这个文件只 append 不轮转，155KB 里 78% 都是「会话没了，忘掉它」这种清理记录，
 * 攒久了白占地方。只留一档不带时间戳，免得轮转本身又变成只增不减的目录。 */
const LOG_ROTATE_BYTES = 512 * 1024;

function rotateLogIfBig() {
  try {
    const f = logFile();
    if (!existsSync(f)) return;
    if (statSync(f).size < LOG_ROTATE_BYTES) return;
    const old = f + '.1';
    try { if (existsSync(old)) rmSync(old, { force: true }); } catch {}
    renameSync(f, old);
  } catch { /* 轮转失败就算了，绝不能影响功能 */ }
}

function log(line) {
  try {
    mkdirSync(dirname(logFile()), { recursive: true });
    rotateLogIfBig();
    appendFileSync(logFile(), `[${new Date().toISOString()}] ${line}\n`, 'utf8');
  } catch {
    /* 日志写不进去不影响功能 */
  }
}

/**
 * 【这个会话现在是不是办事模式】—— 【2026-11-11 整档删除·这里显式钉死 false】
 *
 * features.mjs 里那份「办事模式」定义已删，但主人机器上 .state/task-mode.json
 * 还可能残留着 `"<sid>": true` —— 下面的 readTable 对「记过就按记的」会照旧
 * 返回 true，光删定义关不掉它（老机器会诈尸：persona 又把「你只派活别动手」
 * 拼回提示词、agent.mjs 的 toolsForTurn 又把干活工具收走）。
 *
 * 团队模式有自己的闸（features.mjs 的 team 功能 + team.mjs 的 teamOn()），
 * 跟这张旧表再无关系。这里永远 false —— 想恢复办事模式，先把团队模式那套
 * 整个想清楚再动，别偷偷把这张表接回去。
 */
export function taskOn(sessionId) {
  return false;
}

/** 开 / 关。返回 { ok, sessionId, on }。 */
export function setTaskOn(sessionId, on) {
  const sid = String(sessionId || 'default');
  const map = readTable();
  const want = on === true;
  if (want) map[sid] = true;
  else delete map[sid];
  const ok = writeTable(map);
  log(`${want ? '开' : '关'} session=${sid} ok=${ok}`);
  /* 关掉这一档 = 这个会话的子智能体全部注销（主人要的是「用完就没」）。 */
  if (!want) wipeWorkers(sid);
  return { ok, sessionId: sid, on: want && taskOn(sid) };
}

/**
 * 【功能】页里「办事模式」这一档还开着吗。
 *
 * 关掉它 = 顶栏那颗按钮整块消失、POST 也拒掉（跟其它功能一个规矩：
 * 功能关着＝这个功能不存在，不是灰着让你点）。
 */
export function taskFeatureOn(sessionId = '') {
  try {
    /* 【2026-11-10 按会话】功能开关改成按会话之后，这一档也得问会话 ——
     * 不然主人在这个会话里已经把「办事模式」关掉，按钮还亮着（假关）。
     * 不带 sessionId 时走三级回退的第二级（全局值），老调用照样成立。 */
    /* 没有 sessionId 就传空串：三级回退会自动跳过会话表，直接看全局值、再退 defaultOn。
     * 跟原来 `getEnabledMap()['taskmode']` 逐字等价，但不再出现「裸读全局表」这种写法
     * （check-feature-readpaths 会把裸读当成假关的源头，一律不许）。 */
    /* 【2026-11-11 主人：「办事模式……删了」】
     *
     * 【办事模式】功能整档删掉了（features.mjs 里那份定义已删）。
     * 但主人机器上的功能表里还残留着 `taskmode: true` 这个键 ——
     * featureOnFor 对「不认识的 id」按老行为「记过就按记的」，会照旧返回 true，
     * 所以这里必须显式钉死 false，不能靠功能表。
     *
     * 派活工具（spawn_worker / spawn_workers）从此闸死，等【团队模式】
     * 上线后换新的闸。worker 花名册（writeWorkers 那套）保留不动 ——
     * 团队模式直接复用这层。 */
    return false;
  } catch {
    return false;
  }
}

/** 现在哪些会话开着。 */
export function taskSessions() {
  return Object.keys(readTable());
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
    /* 【2026-11-06 修·BOM 会让花名册整份读空】
     *  跟 readTable 同一个毛病：文件头带 UTF-8 BOM（EF BB BF）时
     *  JSON.parse 直接抛错，下面 catch 一吞就返回 []，
     *  于是「派出去的人在哪儿」一个都看不见，还没有任何日志。
     *  写盘用的是 JSON.stringify，不带 BOM；坏的只可能是被人手改过。
     *  读之前先削掉。 */
    let _raw = readFileSync(f, 'utf8');
    if (_raw.charCodeAt(0) === 0xfeff) _raw = _raw.slice(1);
    const j = JSON.parse(_raw);
    return Array.isArray(j && j.workers) ? j.workers : [];
  } catch {
    return [];
  }
}

/**
 * 【2026-11-10 加·花名册的读改写要串行化】
 *
 * 病根不是「没加锁」，是**更简单也更致命的一条**：`writeWorkers` 会
 * `JSON.stringify(整个列表)` 整份覆盖。而每个写函数的模式都是
 * 「readWorkers() → 改 → writeWorkers()」——
 * 两个 worker 并发 noteWorkerProgress 的时序：
 *   A 读（5 条）→ B 读（还是 5 条）→ A 写（6 条）→ B 写（6 条，A 那条被覆盖）
 * 结果：**后写的把先写的整个覆盖掉**。
 *
 * 实测复现（50 个并发 noteWorkerProgress，真时间错位）：
 *   progress 数组长度 = 1（期望 >0）、sendWorkerMail({to:'#9'}) → notHere=true
 * 也就是说「A 收尾后写回旧列表 → 覆盖掉 B 新写的进度/信件」。
 *
 * 为什么不用文件锁：Node 是单线程，进程内串行化就够，而且这个项目本来就单进程。
 * 跨进程（dev + 安装版同时开）情况下面这层也保不住，但那是另一个问题
 * （config.dataDir 不同就各跑各的；同 dataDir 双开本来就不该发生）。
 *
 * 修法：每个会话一条 promise 链，后一个写等前一个写完。
 *   · 失败也继续（`prev.then(fn, fn)`）—— 一个写挂了不能把整条队列堵死
 *   · 写完删 key，别让 Map 无限涨
 */
const _writeChain = new Map();
function withWriteLock(sid, fn) {
  const key = String(sid || 'default');
  const prev = _writeChain.get(key) || Promise.resolve();
  const next = prev.then(fn, fn);
  _writeChain.set(key, next.catch(() => {}).then(() => {
    if (_writeChain.get(key) === next) _writeChain.delete(key);
  }));
  return next;
}

function writeWorkers(sid, list) {
  const f = workerFile(sid);
  if (!f) return false;
  try {
    mkdirSync(dirname(f), { recursive: true });
    /**
     * 【2026-11-10 修·并发写会撞同一个临时文件名】
     *
     * 原来是 `const tmp = f + '.tmp'` —— **固定名字**。
     * 多个 worker 同时 `noteWorkerProgress` 时，两个写会抢同一个 tmp：
     *   A 写 tmp → B 写 tmp（覆盖 A）→ A rename 走（搬走的是 B 的内容）→ B rename 时 tmp 已不存在 → ENOENT
     * 结果就是「进度丢行」+ 偶发写盘失败，而且丢了不报错。
     *
     * 照 sessions-core.mjs 的 `writeFileAtomic` 模板改：
     *   · 名字带 pid + 随机后缀 → 两个写天然分开
     *   · 以点开头 → listSessions 那类遍历天然跳过，不会把 tmp 当数据
     *   · 后缀不是 .json → 认错过的东西不会再认错
     *
     * ⚠️ 这只解决「撞 tmp 名」，**不解决「整份覆盖丢更新」** —— 后者靠上面的 withWriteLock。
     */
    const tmp = dirname(f) + '/.tmp-' + basename(f) + '-' + process.pid + '-' + Math.random().toString(36).slice(2, 8);
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
      /* 【2026-11-13 子 Agent 续上】brief = 派活时的完整任务原文（含汇报要求），
       * 续跑要靠它接着干 —— task 只留了前 200 字，不够。accept/resumes 同理。 */
      brief: String(w.brief || ''),
      accept: String(w.accept || ''),
      resumes: Number(w.resumes) || 0,
      status: String(w.status || 'running'),
      startedAt: Number(w.startedAt) || 0,
      endedAt: Number(w.endedAt) || 0,
      rounds: Number(w.rounds) || 0,
      tools: Number(w.tools) || 0,
      said: String(w.said || ''),
      /* 【2026-11-11 团队模式】进度行和信箱一起带出去 —— /api/team/workers
       * 的轮询要靠它画卡片上的「干到第几步」，不能再让前端一个一个 workerDetail。 */
      progress: Array.isArray(w.progress)
        ? w.progress.map((x) => ({ at: Number(x && x.at) || 0, line: String((x && x.line) || '') }))
        : [],
      mails: Array.isArray(w.mails) ? w.mails.length : 0,
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
    /* 【2026-11-13 子 Agent 续上】brief（完整任务原文）与 resumes（已被续跑几次，
     * 防崩溃循环：同一条活最多自动续 2 次，再挂就老实标 interrupted 等人来）。
     * 没显式传就继承旧记录 —— 改状态不许把这些抹了。 */
    brief: worker.brief !== undefined
      ? String(worker.brief || '')
      : (at >= 0 ? String(list[at].brief || '') : ''),
    resumes: worker.resumes !== undefined
      ? Number(worker.resumes) || 0
      : (at >= 0 ? Number(list[at].resumes) || 0 : 0),
    status: String(worker.status || 'running'),
    startedAt: Number(worker.startedAt) || Date.now(),
    endedAt: Number(worker.endedAt) || 0,
    rounds: Number(worker.rounds) || 0,
    tools: Number(worker.tools) || 0,
    said: String(worker.said || ''),
    /* 没显式传就继承旧记录里的 —— 否则「改个状态」会把信箱和进度一起清掉。 */
    mails: Array.isArray(worker.mails)
      ? worker.mails.slice(-8)
      : (at >= 0 && Array.isArray(list[at].mails) ? list[at].mails.slice(-8) : []),
    progress: Array.isArray(worker.progress)
      ? worker.progress.slice(-12)
      : (at >= 0 && Array.isArray(list[at].progress) ? list[at].progress.slice(-12) : []),
  };
  if (at >= 0) list[at] = rec;
  else list.push(rec);
  writeWorkers(sid, list);
  return rec;
}

/**
 * 【2026-11-03 · 多智能体协同：给 worker 递话】
 *
 * 主人问：「真的能实现主智能体发号施令，多个子智能体协同工作并实时向主智能体汇报，
 * 并且主智能体能在子智能体工作过程中随时发布新指令吗？」
 *
 * 原来只有一条路：spawn_worker 是同步的 —— 主智能体把活交出去就冻在那儿等，
 * 等它回来才能说下一句。于是「中途改指令」在结构上不可能：它没机会开口。
 *
 * 现在加两样：
 *   ① 信箱 —— 主智能体（或主人）随时往某个 worker 的信箱塞一句话；
 *      worker 每轮工具循环开头先看信箱，有新话就当成一条 user 消息吃进去。
 *   ② 台账 —— worker 每干一步都往 progress 里记一行，主智能体随时能读。
 *
 * 信箱跟花名册存在同一个文件里（worker 记录上的 mails 字段），不另起一个文件：
 * 一个 worker 的「它是谁 / 它在干什么 / 有什么话没吃」本来就是同一件事，
 * 拆成两个文件迟早对不齐（这一版前面刚因为「账本各记各的」重做过整个显示层）。
 */
const MAIL_MAX = 8;          // 一个 worker 最多攒几句没读的话（防主智能体刷屏）
const PROGRESS_MAX = 12;     // 进度只留最近这些行

/** 往某个 worker 的信箱塞一句话。它会在这轮工具循环的下一个开头吃掉。 */
export function sendWorkerMail(sessionId, workerId, text, from = '主智能体') {
  const sid = String(sessionId || 'default');
  const key = String(workerId || '').trim();
  const body = String(text || '').trim();
  if (!key) return { ok: false, error: '没说给哪个 worker' };
  if (!body) return { ok: false, error: '内容是空的' };
  const list = readWorkers(sid);
  const at = list.findIndex((w) => String(w.id) === key);
  if (at < 0) return { ok: false, error: '这个会话里没有 #' + key + ' 这个 worker' };
  const mails = Array.isArray(list[at].mails) ? list[at].mails.slice() : [];
  mails.push({ at: Date.now(), from: String(from || ''), text: body.slice(0, 2000) });
  while (mails.length > MAIL_MAX) mails.shift();
  list[at] = { ...list[at], mails };
  writeWorkers(sid, list);
  return { ok: true, queued: mails.length };
}

/** 取走某个 worker 攒着的所有话（取完就清，跟 peer 信箱同一套语义）。 */
export function drainWorkerMail(sessionId, workerId) {
  const sid = String(sessionId || 'default');
  const key = String(workerId || '').trim();
  if (!key) return [];
  const list = readWorkers(sid);
  const at = list.findIndex((w) => String(w.id) === key);
  if (at < 0) return [];
  const mails = Array.isArray(list[at].mails) ? list[at].mails : [];
  if (!mails.length) return [];
  list[at] = { ...list[at], mails: [] };
  writeWorkers(sid, list);
  return mails;
}

/** worker 每干一步记一行，主智能体随时能读。 */
export function noteWorkerProgress(sessionId, workerId, line) {
  const sid = String(sessionId || 'default');
  const key = String(workerId || '').trim();
  const body = String(line || '').trim();
  if (!key || !body) return null;
  const list = readWorkers(sid);
  const at = list.findIndex((w) => String(w.id) === key);
  if (at < 0) return null;
  const progress = Array.isArray(list[at].progress) ? list[at].progress.slice() : [];
  progress.push({ at: Date.now(), line: body.slice(0, 300) });
  while (progress.length > PROGRESS_MAX) progress.shift();
  list[at] = { ...list[at], progress };
  writeWorkers(sid, list);
  return list[at];
}

/** 读某个 worker 的完整档案（含信箱和进度）。 */
/* 【2026-11-03 加】把这一轮里「谁干了什么」做成一小份快照，挂到那条助手消息上。
 * 为什么必须存进历史：办事模式的流水只活在内存事件流里，一轮跑完事件流就换了 ——
 * 主人看到的就是「派活 运行中…然后没了」，子智能体干活的证据凭空消失。
 * 存进历史之后，翻回来、刷新、换会话再看，卡都还在（历史是唯一权威）。 */
export function workersSnapshot(sessionId) {
  const sid = String(sessionId || 'default');
  const out = [];
  for (const w of readWorkers(sid)) {
    if (!w || !w.id) continue;
    const steps = Array.isArray(w.progress) ? w.progress.slice(-40).map((x) => ({ kind: 'step', t: String(x).slice(0, 400) })) : [];
    const st = String(w.status || 'running');
    /* 【2026-11-03 修·干完了却显示「没干成」/「干活中」】
     * finishWorker 存的状态是 'reported'（成功汇报完）与 'failed'，不是 'done'/'running'。
     * 原来只认 'done'，于是每一张成功的卡都永远停在「干活中…」——
     * 主人看到的正是「明明跑完了，卡上还写着干活中」。 */
    const _okLike = st === 'done' || st === 'reported' || st === 'ok';
    /* 【2026-11-11 团队模式加两档】stopped = 主人手动停的；interrupted = 程序
     * 重启时它还在跑（进程没了，活断在半路）。前端要分别画「停了」「中断了」。 */
    let status = _okLike ? 'ok' : (st === 'failed' || st === 'error' ? 'err' : 'run');
    if (st === 'stopped') status = 'stopped';
    if (st === 'interrupted') status = 'interrupted';
    // 一步都没走、也没在跑的那种空记录不往历史里写（省得留一堆空卡）
    if (!steps.length && st !== 'running') continue;
    out.push({
      id: String(w.id),
      name: String(w.name || ('worker-' + w.id)),
      status,
      /* 【2026-11-11 团队模式】卡片要显示「跑了多久」「几轮几次工具」，没有时间算不了 */
      startedAt: Number(w.startedAt) || 0,
      rounds: Number(w.rounds) || 0,
      tools: Number(w.tools) || 0,
      steps,
      note: String(w.said || w.error || '').slice(0, 400),
    });
  }
  return out.slice(0, 8);
}

export function workerDetail(sessionId, workerId) {
  const sid = String(sessionId || 'default');
  const key = String(workerId || '').trim();
  const list = readWorkers(sid);
  const w = list.find((x) => String(x.id) === key);
  return w ? JSON.parse(JSON.stringify(w)) : null;
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
 * 【改过两回】原来开头有一句 `if (!taskOn(sessionId)) return '';`，一度删掉，
 * 让调用方（pure.mjs 的 doerOf）去判；现在专业模式删了、开关回到 taskOn，
 * 判断仍在调用方（persona.mjs：taskOn 为真才拼），这里不再判第二遍 ——
 * 同一个意思只有一个地方说了算。
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
    '从这一轮起，你的活主要是**组织别人动手** —— 但只在「值得组织」的时候。',
    '',
    '1. 你主要做四件事：拆任务、派活、检查、给结论。',
    '   **但小事你自己做。** 判断标准就一句：派出去省下的时间，比来回交接花掉的多不多？',
    '   · 一步就能完的（读一个文件、跑一条命令、改一处、查一个数）→ **你自己做**，别派。',
    '     派出去是「你写一遍要求 → 它读一遍 → 它做 → 回来你核对」四步，比你自己做慢好几倍。',
    '   · 要同时推进几件互不相干的事 → 派，而且一次 spawn_workers 全派出去（它们真的并行）。',
    '   · 一件事要跑很多轮、会占满上下文 → 派，让它自己去绕，别弄脏你的上下文。',
    '   派活是**加速手段**，不是形式。为了「像个包工头」而把小事也派出去，是最糟的用法。',
    '   反过来，明明三件独立的事你偏要自己一件件做，也是错 —— 那是浪费并行。',
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
    '7. **干活途中可以随时改指令**：它跑着的时候你想明白了什么，就用 tell_worker 递进去 ——',
    '   不必等它回来。想先看它干到哪儿了，watch_worker。',
    '   互不依赖的几件活要一起开工，用 spawn_workers 一次派出去（它们真的同时干，不是一个一个排队）。',
    '   多个 worker 可以同时在跑（各自开各自的），你轮流 watch 它们、各自补话，不用排队等。',
    '8. 对主人说话还是你自己说。子智能体的干活过程不往主人眼前搬，',
    '   你只报三样：做完了什么、还差什么、下一步怎么办。',
    '',
    '一句话：判断归你，脏活分散出去；但「要不要派」本身就是第一个判断 —— 小事自己顺手做了最快。',
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
   * 关着的时候这颗按钮要整块拿掉（不是灰掉），规矩是：
   * 功能关着＝这个功能不存在，所以 on 也一并按 false 报出去，
   * 免得界面上一颗看不见的开关还亮着，而服务端其实已经在按「关」办事。
   */
  let available = true;
  try {
    available = taskFeatureOn(sid);
  } catch {
    available = true;
  }
  /**
   * on 报的是这个会话真实的开关值（.state/task-mode.json 里那一格），跟真正
   * 干活的判断同源（taskOn）。界面和自检拿到的必须是
   * 「实际会怎么干」，不是一个已经没人看的勾。
   */
  let on = false;
  if (available) {
    try {
      on = taskOn(sid);
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
