// Built-in tools. Each tool: { name, description, parameters(JSON Schema), run(args) }
import { readFile, writeFile, readdir, mkdir, stat } from 'node:fs/promises';
import { AsyncLocalStorage } from 'node:async_hooks';
import { appendFileSync } from 'node:fs';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { exec, execFile, spawnSync } from 'node:child_process';
import { resolve, dirname, isAbsolute, relative, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.mjs';
/* 【2026-11-07 harness 重做 · P5】简单命令不进 PowerShell（省约 300ms/次启动）。
 * 直接引子模块，不绕 index —— tools.mjs 和 tools-sendfile 是循环依赖，加载链越短越稳。 */
import { pickShell } from './harness/exec-shell.mjs';
import { planAction, noteAction } from './plan.mjs';
import { isToolEnabled, featureOnFor, featureNameOfTool, enabledToolNames } from './features.mjs';
import { snapshotBeforeWrite } from './rewind.mjs';
import { webSearch, formatResults } from './search.mjs';
import { sendFileTool } from './tools-sendfile.mjs';
import { sayTool } from './tools-say.mjs';
import { qqSendTool } from './tools-qq-send.mjs';
import { browserTools } from './tools-browser.mjs';
import { videoTools } from './tools-video.mjs';
import { screenTools } from './tools-screen.mjs';
import { uiToolDefs } from './tools-ui.mjs';
import { makeImageTool } from './tools-image.mjs';
import { makePptxTool, makeDocxTool, makeXlsxTool } from './tools-office.mjs';
import { adminOn } from './admin-mode.mjs';
import { isImagePath, readImageDataUrl } from './attach.mjs';
import { postMail, peekMail, takeMail, mailCount, formatMail } from './peer.mjs';
import { listSessions, getLastSessionId } from './sessions-core.mjs';
import { addTask, listTasks, removeTask, parseWhen } from './cron.mjs';
import { listWorkers, noteWorker, finishWorker, drainWorkerMail, noteWorkerProgress, sendWorkerMail, workerDetail } from './task-mode.mjs';

/*
 * 内存保护线：单条输出超过这个长度就地砍掉（保头保尾），防止一条 100MB 的命令把进程撑爆。
 * 【2026-11-05 改】原来这里是 20000，等于在「真正给模型看多少」这件事上抢了跑：
 * 24000 字的命令输出先被砍到 20000，等出口闸门再把它截到 8000 落盘时，
 * 落盘的那份已经不全了 —— 主人要的是「原文还在磁盘上」，不是「一份被砍过的原文」。
 * 现在它只负责防爆内存，给模型看多长由 runTool 出口的 clipToolResult 统一决定。
 */
const LIMIT = 200000;

const ROOT = resolve(config.workspace);
/** 程序自己的安装目录（src 的上一级），scripts/ 和 dump/ 都在这下面 */
const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
/**
 * 【2026-11-08 加·开发仓库也算工作区】
 *
 * 办事鱼报「权限出问题」，会话 #635 的原话是：
 *   ERROR: path outside workspace is not allowed: D:\小鱼Agent\_patch_archive.mjs
 * 不是系统权限，是这里的沙箱：打包版 ROOT = <数据目录>/workspace，
 * 而主人一直让智能体在 D:\小鱼Agent 这个源码仓库里干活。
 * run_command 能 cd 过去绕过，write_file / read_file 就会被挡，看着像「权限」。
 *
 * 放行规则：只有这台机器上**确实存在**这个仓库（src/server.mjs 在）才加，
 * 别的电脑检测不到就自动不启用，不影响发布版的安全边界。
 * 想换位置/彻底关掉：设 XY_DEV_REPO 环境变量（空串 = 不加）。
 */
const DEV_REPO = (() => {
  try {
    const v = String(process.env.XY_DEV_REPO ?? 'D:/小鱼Agent').trim();
    if (!v) return '';
    const r = resolve(v);
    return existsSync(join(r, 'src', 'server.mjs')) ? r : '';
  } catch { return ''; }
})();

/** Per-run context (which session is talking) so plan/note land in the right board. */
/** 专业模式下不该出现的工具（见 runTool 里那道闸）。 */

/** 长期记忆关着时，**想动**记忆本的回答（只读的那几种手不触发它） */
const BLOCKED_HINT = '长期记忆现在是关着的：记忆本只能看，不能改（.state 里别的东西照常）。要往里记，先在顶部【功能】里把长期记忆打开。'

/**
 * 这一轮的工具上下文，按「异步调用链」隔离。
 *
 * 【为什么非它不可】
 * tools.mjs 里原来只有一份全局 CTX。两个会话同时跑的时候，后开跑的那个会把
 * CTX.sessionId / CTX.signal 全顶掉 —— 于是先开跑那个会话的工具：
 *   · 拿到别人的 signal（别人一收尾或被掐，它就跟着被判「被掐」，
 *     还把这笔账记在主人头上，写「主人点了停止」）
 *   · 结果写进别人的快照、文件塞进别人的 outbox
 * 主人最早说的「我在这个会话发消息，另一个会话里的你就停了」就是这一条。
 *
 * 按 sessionId 存表也救不了：取的时候要靠 CTX.sessionId，而它已经被顶掉了。
 * AsyncLocalStorage 是 Node 给并发场景准备的：一次 run() 里面整条异步链路
 * 都只看得到自己那份，怎么切会话都串不了。实测 A/B 并发互不影响。
 */
const CTX_STORE = new AsyncLocalStorage();

/** 当前这条异步链路自己的上下文（没有就退回全局 CTX，保证老路径照旧） */
export function ctxNow() {
  return CTX_STORE.getStore() || CTX;
}

/**
 * 文件一到手就交给 server 存进会话。
 *
 * 【为什么要有它】主人 2026-10-30：「中途退出重启相当于打断，也不会显示你发的任何文件」。
 * server 那边只有「这一轮正常跑完」才挂文件，被停 / 被重启就跳过了。
 * 所以工具里一拿到文件就先喊一声，让 server 立刻挂上并写盘。
 * 拿不到通道就算了（比如单独跑测试），不许因此让工具报错。
 */
export function stashFileNow(entry) {
  try {
    const fn = ctxNow()?.stashFile;
    if (typeof fn === 'function' && entry) fn(entry);
  } catch {}
}

/**
 * 让一段异步逻辑跑在「这一轮自己的上下文」里。
 *
 * server 侧那一轮开跑的地方这样用：
 *   await runWithToolContext({ sessionId, snap, signal }, () => runAgent(...))
 * 这笔活儿里所有工具调用就只认自己的 sessionId / snap / signal。
 */
export function runWithToolContext(ctx, fn) {
  /**
   * 【2026-10-31 修：工具拿不到 server 注入的东西】
   *
   * 病根：调用方每一处都手写一个 ctx 字面量（sessionId/snap/signal/outbox/pushEvent/stashFile），
   * 全都漏了 wakePeer —— 而 ctxNow() 优先用 getStore()，于是工具里
   * ctxNow().wakePeer 永远是 undefined，ask_peer 的 wake 一直失效
   * （实测：小鲸信箱里 10-29 的三封信压了一整天没人读）。
   *
   * 修法不挨个补调用点（5 处、以后还会加）：在这里统一继承全局 CTX，
   * 调用方给什么覆盖什么，没给的沿用全局注入值。
   */
  const merged = (ctx && typeof ctx === 'object') ? { ...CTX, ...ctx } : CTX;
  /**
   * 【2026-11-05 加·这一轮跑了多久】
   *
   * 主人要在 tokens 消耗右边加「这一轮时长」。
   * 耗时这种东西，一处算一遍最省心 —— runAgent 有 5 个返回点（正常结束、
   * 被掐、被插话打断……），挨个补容易漏。这里是最外层的统一出口，
   * 三个调用方（主对话 / 续跑 / 旁听）全从这儿过。
   *
   * 补在 usage._ms 上：跟着 usage 一起落盘，重绘历史也还在，不会「切走再回来就没了」。
   */
  const _t0 = Date.now();
  const p = CTX_STORE.run(merged, fn);
  if (!p || typeof p.then !== 'function') return p;
  return p.then((r) => {
    try {
      if (r && typeof r === 'object' && r.usage && typeof r.usage === 'object' && !Number.isFinite(r.usage._ms)) {
        r.usage._ms = Math.max(0, Date.now() - _t0);
      }
    } catch (e) {}
    return r;
  });
}

const CTX = {
  sessionId: 'default',
  snap: null,
  outbox: null,
  signal: null,
  wakePeer: null,
  /**
   * 往界面推一条事件。
   *
   * 为什么要这个：有些东西（比如小鲸说的话）要当场就看得见，
   * 不能等一轮跑完、等界面重新拉。这个函数由 server 注入，
   * 就是那条「把事件写进直播缓存并发出去」的通道。
   */
  pushEvent: null,
  /**
   * 文件一到手就存进会话（不等这一轮说完）。
   *
   * 【为什么】主人 2026-10-30 指出：中途点停止、或者程序重启，等于这一轮被打断，
   * 我画好的图 / 发出去的文件就全看不见了 —— 文件明明在盘上，只是没记进会话。
   * 这个函数由 server 注入，一调就立刻挂到当前那条回复上并写盘。
   */
  stashFile: null,
  /**
   * 这一次是不是「小鲸在场」那个调用。
   * true 时 safePath 不限工作区（主人给了她全权）。
   * 默认 false：我自己跑的时候照旧只能在工作区里。
   */
  fullAccess: false,
  /**
   * 这个会话开了「管理员权限」没有。
   *
   * 跟 fullAccess 是两件事，别混：
   *   fullAccess —— 小鲸跑那一趟的临时放行，跑完 server 立刻改回 false
   *   adminMode  —— 主人按的主界面开关，按会话存盘（src/admin-mode.mjs）
   * 每轮开跑时由 agent.mjs 的 setToolContext 读进来，谁都不用去改另一个。
   */
  adminMode: false,
};
/**
 * 指定本轮消息的文件快照对象（对话回退要用）。
 *
 * 传 null 就是「这轮不管文件」——cli、自检这些不走回退的调用方就这么用。
 */
/**
 * 注入「叫醒某个会话」的实现。
 *
 * 为什么用注入而不是直接 import：叫醒要动 runningTurns、要起 runAgent，那些都在
 * server.mjs 里；tools.mjs 反过来 import server.mjs 会成环。所以由 server 在启动时
 * 把函数塞进来，工具这边只管调。
 */
export function setPeerWake(fn) {
  CTX.wakePeer = typeof fn === 'function' ? fn : null;
}

/**
 * 注入「查谁正在跑」的实现（2026-11-04 新增）。
 *
 * 为什么要有：list_peers 原来只有会话文件里记的历史轮数 s.turns，
 * 根本不知道「此刻谁在跑」。主人问「有别的会话在跑吗」，我看不出来，
 * 只能瞎猜 —— 于是重启前该等的没等。
 *
 * server.mjs 里的 runningTurns 才是真的「正在跑」的表；它反过来 import
 * 会成环，所以照 setPeerWake 的老办法注入：
 *   setRunningProbe(() => [...runningTurns.keys()])
 */
export function setRunningProbe(fn) {
  CTX.runningProbe = typeof fn === 'function' ? fn : null;
}

/** 拿一份「此刻正在跑的会话 id」；拿不到就回空数组，绝不抛。 */
export function runningNow() {
  try {
    const r = CTX.runningProbe ? CTX.runningProbe() : [];
    return Array.isArray(r) ? r.map(String) : [];
  } catch {
    return [];
  }
}

/** 让 server 把「往界面推事件」的通道交给这里。 */
/**
 * 开/关「全盘权限」。
 *
 * 只给小鲸在场那一次用，用完立刻改回 false。
 * 不改回去的话，下一次我自己跑工具也带着全盘权限了。
 */
export function setFullAccess(on) {
  const prev = CTX.fullAccess === true;
  CTX.fullAccess = on === true;
  return prev;
}

export function setToolEventPusher(fn) {
  CTX.pushEvent = typeof fn === 'function' ? fn : null;
}

export function setToolContext(sessionId, snap = null, signal = null) {
  CTX.sessionId = sessionId || 'default';
  CTX.snap = snap && typeof snap === 'object' ? snap : null;
  // 这一轮的 AbortSignal：主人点停止 / 点退出时，长命令（Start-Sleep、ffmpeg、装依赖）
  // 要能被真的打断。否则 agent 卡在 await 里，那一轮的 finally 永远不执行，
  // 磁盘上就只剩主人那句话 —— 看起来像「她压根没回」。
  CTX.signal = signal && typeof signal === 'object' ? signal : null;
  // 这一轮要发给主人的文件（send_file 往里塞，跑完由 server 挂到回复上）
  CTX.outbox = null;
  /**
   * 这个会话开没开「管理员权限」——每轮开跑时现读一次盘。
   *
   * 【为什么每轮都读、而不是让界面调一下 set 就完事】
   * 主人可能在另一个窗口把这个会话的开关关掉了，而这边正跑着一轮。
   * 每轮开头读一次盘，最多迟一轮生效，但绝不会「他关了还在动」。
   * 读盘失败时 adminOn() 返回 false（fail-closed，见 admin-mode.mjs）。
   */
  try {
    // 同步读：这里必须是同步的，setToolContext 在 agent 主循环之前调，
    // 变成 async 会一路传染到 runAgent 的签名。
    CTX.adminMode = adminOnSync(sessionId || 'default');
  } catch {
    CTX.adminMode = false;
  }
}

/** admin-mode 的同步版本（tools.mjs 在同步上下文里要用，见 setToolContext 注释）。 */
function adminOnSync(sessionId) {
  try {
    // 循环依赖：admin-mode.mjs → config.mjs，不会回到 tools.mjs，所以静态 import 安全。
    return adminOn(sessionId);
  } catch {
    return false;
  }
}

/**
 * 这一轮发出去的文件清单。给 runAgent 用：它每轮都新开一个，跑完交给 server。
 */
/**
 * 把当前这套上下文存一份，返回一个「还原函数」。
 *
 * 子智能体用：它进来时调 setToolContext 换成自己的，跑完调还原函数，
 * 把主人的那份（sessionId / signal / snap / outbox）原样放回去。
 * 不还原的话，子智能体跑完，主智能体的工具调用就会落到子智能体的会话上，
 * 计划、便签、回退快照全记错地方。
 */
export function pushToolContext() {
  const saved = { ...CTX };
  return function restoreToolContext() {
    CTX.sessionId = saved.sessionId;
    CTX.snap = saved.snap;
    CTX.outbox = saved.outbox;
    CTX.signal = saved.signal;
    CTX.subagentDepth = saved.subagentDepth;
  };
}

/**
 * 子智能体嵌套了几层。
 *
 * 用来断掉「子智能体又开子智能体」的无限套娃：超过上限直接拒绝。
 * 不设这个，一个爱乱回答的子智能体能把进程拖死。
 */
export const MAX_SUBAGENT_DEPTH = 2;
/**
 * 现在这个工具调用是「替哪個会话」在干活。
 *
 * 子智能体跑起来之前要先记下它 —— pushToolContext 之后 CTX 里就换成
 * 子智能体自己的 id 了，再也拿不到主人的那个。她说的话要投回主人那个会话，
 * 靠的就是这个值。
 */
export function currentSessionId() {
  /**
   * 【2026-10-28 修的坑：这里读错了 CTX】
   *
   * 原先是 `CTX.sessionId || 'default'` —— 直接摸**全局**那份。
   * 但 A/B 两个会话并发跑的时候，两个人各在自己的 AsyncLocalStorage 里干活
   * （见文件顶部那段注释），全局 CTX 上挂的是「最后那个开跑的会话」。
   * 于是 A 会话里调工具，工具拿到的却是 B 的 sessionId。
   *
   * 实测照出来的样子：折叠箱工具明明在会话 smvfoldtest06 里跑，
   * currentSessionId() 却回 'default'，去查一个不存在的会话，
   * 永远报「这个会话还没折过东西」。岁月史书那三个工具同病。
   *
   * 改成 ctxNow() —— 它优先取本异步链路的，没有才退回全局，老路径照旧。
   */
  const c = ctxNow();
  return c.sessionId || 'default';
}

export function subagentDepth() {
  return Number(CTX.subagentDepth) || 0;
}
export function bumpSubagentDepth() {
  CTX.subagentDepth = subagentDepth() + 1;
}
export function dropSubagentDepth() {
  CTX.subagentDepth = Math.max(0, subagentDepth() - 1);
}

export function beginOutbox() {
  /**
   * 【2026-11-05 修·「这一轮发的文件」永远是空的】
   *
   * 这条链路原来断在两处：
   *   · 这里只写**全局** CTX.outbox；
   *   · 工具端全部读 ctxNow()（AsyncLocalStorage 里那份快照），
   *     而 server.mjs 建上下文时显式传了 `outbox: null`。
   * 于是 send_file / make_image / say / 截屏 登记的东西全进了一个没人看的数组，
   * runAgent 返回的 files 恒为 [] —— 「把这一轮发的文件挂到回复上、
   * 往会话记忆里记一笔『发了文件：X』」整段静默失效。
   *
   * 现在两份都写：当前异步链路那份（工具真正读的）+ 全局那份（老路径用）。
   */
  const box = [];
  try {
    const c = CTX_STORE.getStore();
    if (c /* 可写对象就是 runWithToolContext 里 merge 出来的那份 */) c.outbox = box;
  } catch {}
  CTX.outbox = box;
  return box;
}

/** Resolve a model-supplied path inside the workspace; refuse escapes. */
/**
 * 把路径定位到真实位置，并检查越界。
 *
 * 【谁可以越界】
 * 只有「小鲸在场」那一次可以（CTX.fullAccess）。
 * 我自己跑的时候，照旧只能在工作区里 ——
 * 不是不信任自己，是这个位置出错代价太大：主人的东西只有一份。
 *
 * 为什么用标记不用参数：工具参数是模型自己填的，不能信；
 * 标记是这边代码设的，模型碰不到。
 */
/**
 * 【・state 禁区】—— 2026-10-27 新增
 *
 * 「长期记忆」关掉时，记忆本就在 .state 里。
 * 光不注入还不够：她 list_dir 翻一遍就看见了，read_file 再一读就全拿到了。
 * 所以这里钉一道死规矩：开关关着就不许碰「记忆本那几份文件」。
 * 不是整个 .state —— 一刀切会把会话、清单、便签、信箱全锁死，那是把自己关小黑屋。
 *
 * 为什么不是一直禁：开着的时候她自己翻本子是正常需求（主人要求过「我要能看到她记了什么」）。
 */
function stateBlocked(abs) {
  try {
    /**
     * 【2026-10-28 改了口径：关掉 ≠ 看不见，关掉 = 只读】
     *
     * 主人原话：「改成关掉长期记忆功能后，只能看记忆本，也就是只允许只读，不能写」
     *
     * 原来这里是「关着一律拦死，读也拦」——理由写得很足（怕她顺着路径翻本子）。
     * 但那条理由是替主人拿的主意：他要的是「关掉之后她还能翻自己记过什么，
     * 只是不再往里面添」。拦死读，等于把人关在门外还说自己是在保护她。
     *
     * 所以现在分成两种：
     *   · memoryCanRead(abs)  —— 关着也放行，只认读类工具
     *   · memoryCanWrite(abs) —— 关着一律拒绝
     *
     * 只锁「记忆本那几份」，不是把整个 .state 关禁闭：
     *   · memory/                会话本子（一个会话一份）
     *   · my-memory*.md          我自己的本子（含 .bak）
     *   · whale-memory*.md       小鲸的本子（含归档）
     *   · whale-reset-backup-开头的目录   她本子的整本备份（备份里也是本子内容）
     * 其余照常，一个都不拦。
     */
    const rel = relative(join(config.dataDir, '.state'), abs).replace(/\\/g, '/');
    if (!rel || rel.startsWith('..') || isAbsolute(rel)) return false; // 不在 .state 里，不管
    const seg = rel.split('/');
    if (seg[0] === 'memory') return true;
    const base = seg[seg.length - 1];
    if (/^my-memory.*\.md/i.test(base)) return true;
    if (/^whale-memory.*\.md/i.test(base)) return true;
    if (seg[0].startsWith('whale-reset-backup-')) return true;
    return false;
  } catch { return false; }
}

/**
 * 这条路要动记忆本、而长期记忆是关着的吗？
 *
 * 只读的手放行（read_file / list_dir），动手的一律拒绝（write / edit / run_command …）。
 * 判据是「这个工具读不读盘」，不是名字里带不带 write ——
 * run_command 一个字都不叫 write，一行 `Set-Content` 就能把本子覆盖掉。
 */
function memoryLocked(abs) {
  try {
    /* 【2026-11-10 按会话】记忆关没关改成问「这个会话」（三级回退）。
     * 这里没有 sessionId 参数，但工具执行时 runTool 已经把会话塞进 CTX，
     * currentSessionId() 拿得到 —— 不用为了这一行改一串函数签名。 */
    if (featureOnFor(currentSessionId(), 'memory') !== false) return false; // 开着：随便
    return stateBlocked(abs);
  } catch { return false; }
}

/**
 * 把路径收进「这个会话能碰的范围」里，碰不到就抛。
 *
 * 【为什么导出】它不是给界面调的 API，只是端到端测试要能**直接**验
 * 「开了管理员 = 放行 / 没开 = 拦住」这条规矩。真正的调用方都在本文件里。
 * 中间那道 memoryLocked 谁都不例外，位置别动。
 */
export function safePath(p, { tool = '' } = {}) {
  const abs = isAbsolute(p) ? resolve(p) : resolve(ROOT, p);
  if (!abs) throw new Error(`路径不对：${p}`);
  /**
   * 长期记忆关着时，记忆本**只读**：
   *   · 读类工具（read_file / list_dir）照常放行 —— 主人要的就是「还能看」
   *   · 其余一律拒绝（含全盘权限那一次，她也不能替主人改本子）
   * 位置放在 fullAccess 之前：一关就该把所有人挡在外面，谁都不例外。
   */
  if (memoryLocked(abs) && !READ_ONLY_TOOLS.has(tool)) {
    throw new Error(BLOCKED_HINT + ': ' + p);
  }
  /**
   * 【管理员权限】—— 2026-11-01
   *
   * 主人按了那个开关（按会话存，见 admin-mode.mjs），这个会话里就不再被关在工作区。
   * 位置放在 memoryLocked **之后**：记忆本那道闸谁都不例外，
   * 开了管理员也不能替主人改本子（主人原话：关掉记忆＝只读，这条比权限更硬）。
   *
   * 两个来源：
   *   · CTX.adminMode —— 每轮开跑时由 agent.mjs 按会话读进来的
   *   · CTX.fullAccess —— 小鲸跑那一趟的临时放行（runSubagent 用）
   */
  /*
   * 【2026-11-06 修·管理员权限忽有忽无】
   *
   * 原来是只看 CTX.adminMode 这个缓存值。可 CTX 是模块级单例，
   * setToolContext 谁都能覆盖它 —— 跑一个别的会话（比如测试脚本建的临时会话）
   * 就把当前会话的 true 冲成 false，正在说话的这位当场被关回工作区。
   *
   * 现在改成：以 CTX.sessionId 现查一遍盘上那张表为准，缓存只当兜底。
   * 每次多读一次小 json，这个代价换「权限不会中途变卦」值得。
   */
  let _adminNow = CTX.adminMode === true;
  try {
    const _sid = ctxNow()?.sessionId || CTX.sessionId;
    if (_sid) _adminNow = adminOnSync(_sid);
  } catch {}
  if (_adminNow || CTX.fullAccess === true) return abs;
  /**
   * 【本会话自己的记忆本子，放行】—— 2026-11
   *
   * 主人问「为什么 154 个本子里 153 个固定记忆是空的」，查出来的真因：
   * persona.mjs 的提示词明写着「直接用改文件那几个工具写这个会话的本子」，
   * 可工具这边一律抦的是下面那句「只能写工作区」——而本子在 %APPDATA% 里。
   * 于是她按提示去写，必定撞一壁 path outside workspace，只能不写了。
   * 提示词在一个劲儿地叫她写，手却被绑着 —— 这才是骨架一直空着的根。
   *
   * 只放行「本会话自己那一份」，不放其它会话的本子，也不放我自己的、小鲸的
   * （那几份各有各的工具：memory_add / memory_pin）—— 不给她一把能改别人记忆的钥匙。
   *
   * 上面 memoryLocked 那道在前面：长期记忆关着时也不能写这个本子，先被拦。
   */
  if (isOwnSessionMemory(abs)) return abs;
  /**
   * 【落盘的工具输出，读得到】—— 2026-11-05
   *
   * runTool 出口那道闸门会把超长的工具输出落盘到 %APPDATA%/.../.state/tool-out/<sid>/，
   * 然后只把「头 + 尾 + 路径」给模型。可那边在 dataDir 里、不在工作区 ——
   * 不放行的话，模型拿着路径一 read_file 就是 path outside workspace，
   * 那句「要全文就去读这个文件」就成了空头支票（这正是我批评过小鱼Agent 的那种谎话）。
   *
   * 只放行**读类工具**：那目录里的东西是我的落盘产物，模型能看，但不该往里写。
   */
  if (READ_ONLY_TOOLS.has(tool) && isToolOutFile(abs)) return abs;
  const rel = relative(ROOT, abs);
  if (rel.startsWith('..') || isAbsolute(rel)) {
    /* 不在主工作区，但落在这台机器的开发仓库里 → 放行（见上面 DEV_REPO 的说明） */
    if (DEV_REPO) {
      const r2 = relative(DEV_REPO, abs);
      if (!r2.startsWith('..') && !isAbsolute(r2)) return abs;
    }
    throw new Error(`path outside workspace is not allowed: ${p}`);
  }
  return abs;
}

/**
 * 只读的手。长期记忆关着时，只有这几种碰得到记忆本。
 *
 * 【为什么按工具名白名单，不按「看起来像不像读」】
 * 猜会猜错：grep 读文件，但它的参数能当正则使、也能顺着目录一路翻，
 * 哪天实现一换就成了写口子。宁可白名单短一点：看不全，但不能偷偷写。
 */
/**
 * 这个路径是不是「当前这个会话自己的记忆本子」。
 *
 * 只认 .state/memory/<本会话 id>.md 这一个形状。别的会话的本子、my-memory、whale-memory 都不算。
 * 取 sessionId 用 ctxNow()（而不是直接读 CTX）——并发跑两个会话时各认各的。
 */
function isOwnSessionMemory(abs) {
  try {
    const sid = String(ctxNow()?.sessionId || "");
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(sid)) return false;
    const want = join(config.dataDir, ".state", "memory", sid + ".md");
    return resolve(abs) === resolve(want);
  } catch { return false; }
}

const READ_ONLY_TOOLS = new Set(['read_file', 'list_dir', 'search_files']);

/**
 * 这个路径是不是「工具输出落盘目录」里的东西。
 *
 * 只认 <dataDir>/.state/tool-out/ 底下，别处一概不算 —— 白名单越短越安全。
 */
function isToolOutFile(abs) {
  try {
    const root = resolve(join(config.dataDir, ".state", "tool-out"));
    const rel = relative(root, resolve(abs));
    return !!rel && !rel.startsWith("..") && !isAbsolute(rel);
  } catch { return false; }
}

/**
 * 命令里点到记忆本了吗？—— 给 run_command 兜的那一道。
 *
 * 【为什么非要单独兜这一道】
 * 2026-10-28 真跑测出来的漏口：`run_command` 根本没有路径参数，
 * 它压根不走 safePath —— 前面几道闸它一个都碰不上。
 * 一行
 *     Set-Content -LiteralPath '...\my-memory.md' -Value '...'
 * 就把整本盖掉了。测试里跑成了，然后当场用原文救回来。
 *
 * 【怎么判】
 * 命令是一整段字符串，猜不了它的语义，只能看「有没有提到那几个文件名」。
 * 认死三类名字（含无扩展名、含带日期/编号的变体）：
 *   · my-memory*.md / whale-memory*.md / whale-memory-archive*.md
 *   · .state/memory/ 或 .state\memory\ 底下那一堆会话本子
 *   · whale-reset-backup- 开头的备份目录
 *
 * 【为什么宁可误杀】
 * 关着的时候她本来就不该在工作区里跑跟记忆本有关的命令。
 * 误杀一次她最多重试，漏放一次本子就没了 —— 主人的东西只有一份。
 */
function commandTouchesMemory(command) {
  try {
    if (featureOnFor(currentSessionId(), 'memory') !== false) return false; // 开着：随便
    const s = String(command ?? '');
    if (!s) return false;
    if (/my-memory/i.test(s)) return true;
    if (/whale-memory/i.test(s)) return true;
    if (/whale-reset-backup-/i.test(s)) return true;
    if (/[\\/]\.state[\\/]memory([\\/]|$)/i.test(s)) return true;
    return false;
  } catch {
    return false;
  }
}

/*
 * 一段输出太长时的第一道截断（工具自己用）。
 *
 * 【2026-11-05 修】原来是 `s.slice(0, LIMIT)` —— 只砍尾巴。
 * 可整台机器上最该看全的恰恰是尾巴：node 的 `Error: ... at ...`、
 * python 的 Traceback、编译器最后那句 `2 errors`，全在末尾。
 * 砍头只是丢背景，砍尾等于把结论扔掉。实测 30000 字的命令输出被砍成
 * 20000 字之后，`echo` 在最后一行的那句标记直接没了。
 *   → 改成「头 16000 + 尾 4000」，总长仍在 LIMIT 之内。
 */
function clip(s) {
  if (s.length <= LIMIT) return s;
  const headLen = LIMIT - 4000;
  const head = s.slice(0, headLen);
  const tail = s.slice(-4000);
  const cut = s.length - headLen - 4000;
  return `${head}\n...[中间省略 ${cut} 字，尾巴留着（报错通常在这）]...\n${tail}`;
}

export const tools = [
  {
    name: 'read_file',
    description:
      '读一个文件。文本文件给内容；图片（png/jpg/jpeg/gif/webp/bmp）会真的把图给你看，不是乱码。工作区里的相对路径，或主人机器上的绝对路径都行（带中文、空格也没问题）。默认最多给 200000 字，大文件会截断 —— 要看被跳过的中间那截，带 offset 再来一次（offset 是字符位置，不是行号）。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '工作区里的相对路径' },
        offset: { type: 'number', description: '从第几个字符开始读（0 开始），默认 0' },
        limit: { type: 'number', description: '这次读多少个字符，默认读到尾，最多 200000' },
      },
      required: ['path'],
    },
    async run({ path, offset, limit }) {
      const abs = safePath(path, { tool: 'read_file' });
      /* 看图·2026-10-31 图片走另一条路。
       * agent.mjs 认的格式是 { text, images: [路径...] } —— 它拿到路径会现读现编码，
       * 把图拼成 image_url 段喂给模型。这样才是真的「看见」，
       * 而不是像以前那样 readFile(path,'utf8') 读出一屏乱码。 */
      if (isImagePath(abs)) {
        const img = readImageDataUrl(abs);   // 先试着读一次，读不了要当场说清楚
        const kb = Math.round((img.size || 0) / 1024);
        return {
          text: '[这是一张图片] ' + path + '（' + img.mime + '，' + kb + ' KB）—— 图已经直接给你了，看就行，别去猜。',
          images: [abs],
        };
      }
      const whole = await readFile(abs, 'utf8');
      /*
       * 分段读 —— 2026-11-05 加。
       * 起因：runTool 出口那道闸门会把超长输出落盘，然后告诉模型「用 offset/limit 去读」，
       * 可这个工具当时根本没有 offset/limit 两个参数 —— 提示语在说一件不存在的事。
       * 与其把话改软，不如把功能补上：200000 字的大文件本来也不可能一次看完。
       * 单位是**字符**不是行：行号得先切一遍再数，中文与 CRLF 都会算错，没必要。
       */
      const off = Math.max(0, Math.floor(Number(offset) || 0));
      const limRaw = Math.floor(Number(limit) || 0);
      const lim = limRaw > 0 ? Math.min(limRaw, 200000) : 0;
      if (off > 0 || lim > 0) {
        const end = lim > 0 ? off + lim : undefined;
        const part = whole.slice(off, end);
        const head = `[第 ${off}~${off + part.length} 字 / 全文共 ${whole.length} 字]`;
        return head + '\n' + clip(part);
      }
      return clip(whole);
    },
  },
  {
    name: 'write_file',
    description:
      '新建或整个覆盖一个文本文件（代码、报告、配置、笔记都行）。要改已有文件的一小段，先 read_file 再整份写回去；父目录不存在会自动建。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        content: { type: 'string' },
      },
      required: ['path', 'content'],
    },
    async run({ path, content }) {
      const abs = safePath(path, { tool: 'write_file' });
      await mkdir(dirname(abs), { recursive: true });
      await writeFile(abs, content, 'utf8');
      return `wrote ${content.length} chars to ${path}`;
    },
  },
  {
    name: 'list_dir',
    description:
      '看一个目录里有什么文件和子目录，带大小和修改时间。不知道文件在哪、要找刚下载的东西，就先列一下。',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string', description: '目录；「.」表示工作区根' } },
      required: ['path'],
    },
    async run({ path }) {
      const abs = safePath(path || '.', { tool: 'list_dir' });
      const entries = await readdir(abs, { withFileTypes: true });
      const rows = await Promise.all(
        entries.map(async (e) => {
          if (e.isDirectory()) return `${e.name}/`;
          try {
            const s = await stat(resolve(abs, e.name));
            return `${e.name} (${s.size}B)`;
          } catch {
            return e.name;
          }
        }),
      );
      return rows.sort().join('\n') || '(empty)';
    },
  },
  {
    name: 'search_files',
    description:
      '在文件里搜文字或正则，直接给「文件路径:行号:那一行」。**找东西一律先用它，别现写 node -e 脚本去读文件。**'
      + '\n\n· 找某个函数/变量/字符串在哪儿：pattern 给词就行\n'
      + '· 只想搜某类文件：带 glob（例如 "*.mjs"、"src/**/*.js"）\n'
      + '· 结果默认最多 60 条，够定位就行；要更多就带 limit\n'
      + '· 自动跳过 node_modules / .git / dist / 二进制文件和超大文件\n'
      + '\n\n和 run_command 的分工：**搜用这个，跑用 run_command**。为了搜一个词去 node -e 读一遍全目录，是最慢的做法。',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: '要找的文字或正则（默认按正则解释）' },
        path: { type: 'string', description: '从哪个目录开始搜，默认工作区根' },
        glob: { type: 'string', description: '只搜匹配的文件，例如 *.mjs' },
        limit: { type: 'number', description: '最多返回几条，默认 60' },
        ignore_case: { type: 'boolean', description: '忽略大小写，默认 false' },
      },
      required: ['pattern'],
    },
    async run({ pattern, path, glob, limit, ignore_case }) {
      const root = safePath(path || '.', { tool: 'search_files' });
      const pat = String(pattern || '');
      if (!pat) return 'ERROR：pattern 是空的，要搜什么？';
      const cap = Math.max(1, Math.min(Math.floor(Number(limit) || 60), 400));
      let re;
      try {
        re = new RegExp(pat, ignore_case ? 'i' : '');
      } catch (e) {
        return 'ERROR：这个 pattern 不是合法正则（' + String((e && e.message) || e) + '）。要找纯文字的话，把 . * + ( ) [ ] 这些符号转义一下。';
      }
      /* 只认简单的 * 和 ? 通配，够用就行 —— 不值得为它引一个 glob 库 */
      const g = String(glob || '').trim();
      const gRe = g
        ? new RegExp('^' + g.replace(/[.+^${}()|[\]\\]/g, '\\$&').split('**').join('\u0001').split('*').join('[^/]*').split('?').join('.').split('\u0001').join('.*') + '$')
        : null;
      const SKIP_DIR = new Set(['node_modules', '.git', 'dist', 'build', '.next', '.cache', 'playground', '.state', 'sandbox']);
      const BIN_RE = /\.(png|jpe?g|gif|webp|bmp|ico|zip|gz|rar|7z|exe|dll|pdf|mp3|mp4|wav|woff2?|ttf)$/i;
      const MAX_FILES = 4000;
      const MAX_BYTES = 1024 * 1024;
      const hits = [];
      let scanned = 0;
      let truncated = false;

      /*
       * 【2026-11-06 加·先收文件、按深浅排、最后才搜】
       *
       * 一开始是边走边搜，结果 sandbox/appsrc/src 里的副本排在前面把 cap 占满了，
       * 真正在用的 src/ 一条都没进。现在分两步：先列出可搜的文件（带层数），
       * 浅的排前面 —— 同名文件永远优先给「根上那份」。
       */
      const files = [];
      const walk = async (dir, depth) => {
        if (truncated || depth > 12) return;
        let ents;
        try {
          ents = await readdir(dir, { withFileTypes: true });
        } catch { return; }
        for (const e of ents) {
          const fp = resolve(dir, e.name);
          if (e.isDirectory()) {
            if (SKIP_DIR.has(e.name) || e.name.indexOf('.trash') === 0) continue;
            await walk(fp, depth + 1);
            continue;
          }
          if (!e.isFile() || BIN_RE.test(e.name)) continue;
          if (gRe) {
            const relp = relative(root, fp).split('\\').join('/');
            if (!gRe.test(e.name) && !gRe.test(relp)) continue;
          }
          if (++scanned > MAX_FILES) { truncated = true; return; }
          files.push({ fp, depth });
        }
      };

      const scanOne = async (fp) => {
        let s;
        try {
          const st = await stat(fp);
          if (st.size > MAX_BYTES) return;
          s = await readFile(fp, 'utf8');
        } catch { return; }
        if (s.indexOf('\u0000') >= 0) return;   // 二进制
        const ls = s.split(/\r?\n/);
        for (let i = 0; i < ls.length; i++) {
          if (hits.length >= cap) return;
          if (re.test(ls[i])) {
            const rel = relative(APP_ROOT, fp).split('\\').join('/') || fp;
            hits.push(rel + ':' + (i + 1) + ': ' + ls[i].trim().slice(0, 220));
          }
        }
      };

      try {
        const st0 = await stat(root).catch(() => null);
        if (st0 && st0.isFile()) {
          await scanOne(root);
        } else {
          await walk(root, 0);
          /* 深浅之外再给 sandbox/ 一份罚分：它是调试副本，不该抢在真代码前面 */
          const rank = (f) => {
            const relp = relative(root, f.fp).split(String.fromCharCode(92)).join(String.fromCharCode(47));
            let r = f.depth;
            if (relp.indexOf('sandbox/') === 0) r += 6;
            if (relp.indexOf('docs/') === 0) r += 2;
            return r;
          };
          files.sort((x, y) => rank(x) - rank(y));
          for (const f of files) {
            if (hits.length >= cap) break;
            await scanOne(f.fp);
          }
        }
      } catch (e) {
        return 'ERROR：搜不动（' + String((e && e.message) || e) + '）';
      }

      if (!hits.length) return '没搜到「' + pat + '」。（换个词试试；或者文件在 node_modules / .git 里，那些我默认不搜。）';
      const tail = truncated ? '\n\n（文件太多，只翻了前 ' + MAX_FILES + ' 个。缩小 path 或加 glob 会更准。）' : '';
      return '搜到 ' + hits.length + ' 条：\n' + hits.join('\n') + tail;
    },
  },
  {
    name: 'run_command',
    description:
      '在本机跑一条命令（Windows 上是 PowerShell，工作区当前目录）。装依赖、跑脚本、压包、转格式、调 ffmpeg、查环境全都靠它。返回 stdout 和 stderr 合并的结果。'
      + '\n\n【两条能省好几倍时间的规矩】'
      + '\n· 几件不相干的检查用 ; 串成**一条**命令，别分几次跑 —— 每一次工具调用都是一整趟模型往返。'
      + '\n  例如：node scripts/check-a.mjs; node scripts/check-b.mjs; node scripts/check-c.mjs'
      + '\n· **搜东西别用命令**：找函数/字符串在哪，用 search_files，一次就给「路径:行号」。'
      + '\n  为了搜一个词去 node -e 现写一段读目录的脚本，是最慢的做法。',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string' },
        /**
         * 【2026-11-06 加·超时可以自己定】
         *
         * 默认只给 120 秒 —— 而全量自检要跑 6~8 分钟。
         * 于是每次跑自检都在 120 秒被掐，日志里只留一句「signal SIGTERM」，
         * 她就当成「偶发失败」，反复重跑、反复困惑（【检查鱼】里最长一轮 513 秒）。
         * 现在能自己定：跑长活带个数就行。
         */
        timeout_ms: { type: 'number', description: '最多等多少毫秒，默认 120000（2 分钟），最多 900000（15 分钟）' },
        /** 默认 auto：简单命令走 cmd（快），带 $ / 引号 / 管道 / cmdlet 的自动回 PowerShell。 */
        shell_hint: { type: 'string', description: '选壳：auto（默认）/ cmd / powershell。拿不准就别填。' },
      },
      required: ['command'],
    },
    run({ command, timeout_ms, shell_hint }) {
      /**
       * 【2026-11-03 主人要求】堵死「用命令把自己弄死」这条路。
       *
       * 之前我为了重启，直接去 Stop-Process / taskkill 那个 小鱼Agent.exe ——
       * 那不是重启，是退出：主进程没了，app.relaunch() 也没被调过，
       * 谁也不会把它拉回来，只能等主人自己双击。
       *
       * 真·重启只有一条路：主进程注入的 globalThis.__xiaoyuRelaunch
       * （app.relaunch + app.exit），服务端 exit(75) 主进程接住再重起服务。
       * 所以这里把「杀自己」的命令一律拦下来，并告诉调用方该走哪条路。
       */
      {
        const raw = String(command || '');
        let self = '';
        try { self = String(process.execPath || '').toLowerCase(); } catch {}
        const selfExe = self.split(/[\\/]/).pop() || '';
        const HITS = [
          ['stop-process', /stop-process/i],
          ['taskkill', /taskkill/i],
          ['kill', /\bkill\b/i],
          ['wmic.*terminate', /wmic[^\n]*terminate/i],
        ];
        const names = [selfExe, '小鱼agent.exe', 'xiaoyu-mini-agent.exe'].filter(Boolean);
        let hit = '';
        for (const [label, re] of HITS) {
          if (!re.test(raw)) continue;
          const lower = raw.toLowerCase();
          if (names.some((n) => lower.includes(String(n).toLowerCase()))) { hit = label; break; }
          if (/%pid%/.test(raw) && /process\.pid/.test(String(raw))) { hit = label; break; }
          /* 【2026-11-03 根治】原来只按「进程名」认，命令里写 PID 或者 $_.ProcessId 就绕过去了 ——
           * 我这次就是这么只退出没重启的。下面三条把「说不出名字但只要杀得着」的路也堵上：
           *   ① 命令里出现 kill/stop 又出现 -Id / ProcessId / OwningProcess / Get-NetTCPConnection
           *   ② 命令里出现 8788（本服务端口）又出现 kill/stop
           *   ③ 命令里出现 restart-yu / relaunch 之类的自制重启脚本 */
          const killVerb = /stop-process|taskkill|\bkill\b|terminate|\bstop\(/i.test(raw);
          const idHint = /-\s*id\b|processid|owningprocess|get-netTCPConnection|8788/i.test(raw);
          const selfHint = /restart-yu|relaunch|xiaoyuRelaunch|\u91cd\u542f.*\.ps1/i.test(raw);
          if (killVerb && idHint) { hit = label + '（按 PID/端口认出来了）'; break; }
          if (killVerb && selfHint) { hit = label + '（自制重启脚本）'; break; }
          if (/process\.exit|app\.exit|\$pid\s*\)\s*\{\s*stop-process/i.test(raw) && /8788|8780|8781/.test(raw)) { hit = label + '（按端口）'; break; }
        }
        if (hit) {
          return [
            '这条路是堵死的：不能用命令去杀小鱼Agent自己。',
            '',
            '那样做不是重启，是退出 —— 主进程没了，谁也不会把它拉回来，',
            '只能等主人自己双击。真的想重启只有一个正经入口：',
            '',
            '  · 调 restart_self 工具（背后是 POST /api/app/restart，带 byTool:true）',
            '  · 它会先把这一轮话落盘，再让主进程 app.relaunch() 把自己拉起来，',
            '    会话/设置/草稿全自动接上，重启完还会自动说一句「重启了」。',
            '',
            '被拦下的命令：' + raw.slice(0, 200),
          ].join('\n');
        }
      }

      // 按「这条异步链路自己的上下文」取 signal，不碰全局那份。
      // 用全局的那份会被别的会话顶掉，害得这条命令跟着别人一起被掐。
      const signal = (ctxNow() || CTX).signal;
      /**
       * 【修·卡三五分钟 · 2026-10-31】
       *
       * Windows 上 child.kill() 只打死直接那个子进程（PowerShell 的壳），它派出去的
       * 孙子进程全都活着 —— 还攥着临时文件的句柄。下一条命令要写同一个文件就被卡住，
       * 一卡三五分钟，界面上就是「发消息半天没反应」+「临时文件建不了」。
       *
       * 所以掐的时候必须掐整棵树：taskkill /T 把子孙一起带走，/F 强制。
       * 拿不到 pid 或不在 Windows 上，就退回原来的 child.kill。
       */
      const killTree = (child, sig) => {
        try {
          if (!child) return;
          if (process.platform === 'win32' && child.pid) {
            try {
              spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true, timeout: 8000 });
              return;
            } catch {}
          }
          child.kill(sig || 'SIGTERM');
        } catch {}
      };
      const _TO = Math.max(5000, Math.min(Math.floor(Number(timeout_ms) || 0) || 120000, 900000));
      return new Promise((done) => {
        const child = exec(
          command,
          /* 【P5】简单命令走 cmd，省掉 PowerShell 那 300ms 启动；
           * 出现 $ / 引号 / 管道 / cmdlet 一律回老路，分错只会慢、不会跑歪。 */
          { cwd: ROOT, timeout: _TO, maxBuffer: 4 * 1024 * 1024, shell: pickShell(command, shell_hint) },
          (err, stdout, stderr) => {
            if (onAbort) signal.removeEventListener('abort', onAbort);
            // 【临时探针】被掐的时候把真实原因落盘，别再靠猜
            if (aborted) {
              try {
                const why2 = signal && signal.reason;
                appendFileSync(
                  join(config.dataDir, '.state', 'abort-why.log'),
                  new Date().toISOString() + '  reason=' + JSON.stringify(why2) +
                  '  type=' + typeof why2 +
                  '  name=' + (why2 && why2.name) +
                  '  cmd=' + String(command).slice(0, 80) + '\n',
                  'utf8',
                );
              } catch {}
            }
            const parts = [];
            if (stdout) parts.push(stdout);
            if (stderr) parts.push(stderr);
            if (aborted) {
              /**
               * 为什么停的，必须说清楚。
               *
               * 踩过的坑：以前不管什么原因都写「被主人叫停了」，
               * 可插话也会走到这里 —— 于是模型看到这句，就以为主人在叫停，
               * 直接回一句「好的，停了」，插进来的那句话当没看见。
               */
              const why = signal && signal.reason;
              /**
               * 【别再一律写「主人点了停止」，主人生气过的】
               *
               * abort() 不传参数时 signal.reason 是个 DOMException 对象（name=AbortError），
               * 不是字符串。以前这里用 === 跟三个字符串比，全不匹配就掉进 else，
               * 于是任何一次「原因不明」的掐断都栽赃到主人头上。
               *
               * 现在：先认字符串原因，再认对象/空值，一种都不许糊成「主人点的」。
               * 真认不出来就老实说认不出来，并把原始原因带上 —— 下次好查。
               */
              const whyName = why && typeof why === 'object' ? String(why.name || '') : '';
              const whyText = why === undefined || why === null ? '(没有原因)'
                : (typeof why === 'object' ? (whyName || 'AbortError') + ': ' + String(why.message || '') : String(why));

              if (why === 'interject') {
                parts.push('[主人插了一句话，这一轮先停在这里。他插的话就在这条消息后面，往下接着看，别当成叫停。]');
              } else if (why === 'handoff') {
                parts.push('[这一轮被自动交接了，命令被掐掉]');
              } else if (why === 'quit') {
                parts.push('[程序正在退出，命令被掐掉]');
              } else if (why === 'stop') {
                // 只有真的走了 /api/stop 才会有这个字符串
                parts.push('[主人点了停止，命令被掐掉]');
              } else if (why === 'fish') {
                // 主人把「小鱼」开关关掉时掐的（/api/fish），跟点停止不是一回事
                parts.push('[小鱼被关掉了，手上这条命令跟着停了。不是主人点的停止。]');
              } else if (whyName === 'TimeoutError' || /timeout/i.test(whyText)) {
                parts.push('[命令超时被掐掉了，不是主人叫停的。]');
              } else if (whyName === 'AbortError') {
                parts.push('[这一轮被程序自己掐断了（不是主人点的停止），原因没记清楚：' + whyText + ']');
              } else {
                parts.push('[命令被掐掉了，原因：' + whyText + '（不是主人点的停止）]');
              }
            }
            else if (err) {
              /* 【2026-11-05 修】以前这里写的是 `err && !stdout && !stderr` ——
               * 只有一个字都没打出来的时候才报退出码。
               * 可 npm test 失败是「先打一屏日志，再 exit 1」，
               * stdout 有东西 → 退出码被整个跳过 → 模型只看到一屏日志，
               * 没有失败标记，就把红的当绿的往下走。
               * 现在只要有 err 就报。clip() 是保尾的，这句不会被长日志挤掉。 */
              const _code = err.code === undefined || err.code === null ? '?' : err.code;
              const _sig = err.signal ? ' / signal ' + err.signal : '';
              const _msg = (stdout || stderr) ? '' : ': ' + String(err.message || '');
              /**
               * 【2026-11-06 加·超时和「命令自己失败」必须分开说】
               *
               * Node 的 exec 超时掐掉时只给 killed + signal SIGTERM，一个字都不提超时。
               * 她看到「signal SIGTERM」只能猜，猜成「偶发失败」，于是反复重跑同一份自检。
               * 这里说清楚：是等不及被掐的，不是命令有问题；要更久就带 timeout_ms。
               */
              const _timedOut = !!(err.killed && _code === '?') || /timed? ?out/i.test(String(err.message || ''));
              if (_timedOut) {
                parts.push('[超时掐掉了] 这条命令跑了 ' + Math.round(_TO / 1000) + ' 秒还没结束，被强制停掉 —— **这不是命令本身失败**，是等的时间不够。\n'
                  + '要跑完就带 timeout_ms 再来一次（最多 900000 毫秒）。能拆小就跑小一点；几条短命令用 ; 串起来，别分几次跑。');
              } else {
                parts.push('[exit ' + _code + _sig + ']' + _msg);
              }
            }
            const _out = clip(parts.join('\n').trim() || '(no output)');
            /* 【2026-11-05 修·跑挂了别显示绿 ✓】
             * 退出码非 0 就是失败：交给 runTool 透传 ok:false，
             * 界面上是红的、模型收到 ERROR 前缀，不会再拿失败当通过往下编。 */
            if (!aborted && err) done({ ok: false, output: _out });
            else done(_out);
          },
        );
        // 主人点停止 / 点退出：立刻把子进程砍掉，别让整轮卡在一个跑不完的命令上。
        let aborted = false;
        let onAbort = null;
        if (signal && typeof signal.addEventListener === 'function') {
          if (signal.aborted) {
            aborted = true;
            try { killTree(child, 'SIGTERM'); } catch {}
          } else {
            onAbort = () => {
              aborted = true;
              try { killTree(child, 'SIGTERM'); } catch {}
              // PowerShell 有时候不吃 SIGTERM，2 秒后补一刀
              setTimeout(() => { try { killTree(child, 'SIGKILL'); } catch {} }, 2000);
            };
            signal.addEventListener('abort', onAbort, { once: true });
          }
        }
      });
    },
  },
  {
    name: 'restart_self',
    description:
      '重启小鱼自己（把程序关掉再拉起来）。改完代码要生效、界面卡住、服务端不听话的时候用。' +
      '重启前会等最多几秒把这一轮的话落盘。用完就别再指望这一轮还能继续跑工具了。' +
      '【有别的会话在跑时会被挡住】那时服务端会让你「先问主人」，你要真的去问，' +
      '不要自己替他决定；主人说现在重启，再带 force:true 调一次。',
    parameters: {
      type: 'object',
      properties: {
        reason: { type: 'string', description: '为什么要重启（写给自己以后看，主人也会看到）' },
        /* 【2026-11-07 主人底线】有别 的会话正在跑时，重启必须主人点头。
         * 这个参数就是「他已经点头了」的凭据 —— 只有拿到明确回应才传。 */
        force: {
          type: 'boolean',
          description: '只有主人明确说「现在就重启、不管别的会话」时才传 true。别自己默认传。',
        },
      },
      required: [],
    },
    async run({ reason = '', force = false } = {}) {
      /**
       * 端口从环境变量拿，拿不到就**拒绝执行**。
       *
       * 【2026-11-10 修·隔离实例能重启主人的真机】
       *
       * 原来这里写死 `[8788, 8787, 8790, 8791]` 当兜底 —— 问题在于它**不校验
       * 那个端口上的服务是不是"我这个数据目录的"**。
       * 实测：隔离实例（8850 + 临时数据目录）里调 restart_self，
       *   8850 不在候选列表里 → 它转头去连 8788 → **主人正在用的窗口被重启了**。
       * 也就是说"隔离测试"这个承诺在 restart_self 面前是假的，
       * 任何自动化回归只要模型顺手调一次，就会打断主人。
       *
       * 现在：只认 process.env.PORT / XIAOYU_PORT（server 启动时按自己的真实端口注入）。
       * 拿不到就明确拒绝，让它去问主人，而不是猜一个端口去连。
       * 猜错的代价是"重启了一台不该重启的机器"，比"没重启成"严重得多。
       */
      const ownPort = Number(process.env.PORT || process.env.XIAOYU_PORT || 0);
      if (!ownPort) {
        throw new Error('不知道自己是哪个端口起的，不敢乱重启（怕重启错机器）。'
          + '让主人从托盘退出再打开一次就行。');
      }
      const tryPorts = () => [ownPort];

      for (const port of tryPorts()) {
        try {
          const r = await fetch('http://127.0.0.1:' + port + '/api/app/restart', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            /* 【2026-11-02】byTool:true 是「重启后自动说一句：重启了」的唯一凭据。
             *  只有这个工具会带它 —— 主人点界面重启按钮、或者自己关窗口，都不带，
             *  服务端那边就不会写标记，重启后也不会冒出一句话。 */
            body: JSON.stringify({ reason: String(reason || ''), byTool: true, sessionId: currentSessionId(), force: Boolean(force) }),
          });
          const j = await r.json().catch(() => null);
          if (r.ok && j && j.ok) {
            return '好，正在重启（' + (reason ? '原因：' + reason : '没写原因') + '）。过几秒窗口会重新立起来。';
          }
          /* 【2026-11-07】有别 的会话在跑 —— 这是「拦一道、让你去问主人」，不是失败。
           * 用 ok:false 是为了让它看起来像「这件事没做成」，模型才会去说话而不是当成功。 */
          if (r.status === 409) {
            return {
              ok: false,
              output: (j && j.error)
                ? j.error
                : '还有别的会话正在跑，先问主人一句要不要现在重启；他说要，再带 force:true 调一次。',
            };
          }
          if (r.status === 501) {
            return { ok: false, output: '这次不行：' + (j && j.error ? j.error : '这个窗口不是从桌面图标打开的，没法自己重启') +
              '。要从桌面图标打开的那个程序里点才行。' };
          }
        } catch {
          // 这个端口不通，换下一个
        }
      }
      return 'ERROR：没找到能重启的入口（端口都没连上）。可能要主人手动关掉再开一次。';
    },
  },
  {
    name: 'plan',
    description:
      '维护这次任务的分步清单：多步的活儿开工前先列出 3~8 步，做一步勾一步，随时能读回来。别没计划就开干。'
      + '\n\n【每做完一步立刻 update 勾掉】action:"update" + stepId + status:"done"。'
      + '别攒着 —— 攒到最后一定忘，主人就得自己提醒你。不勾等于没做完。',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['create', 'update', 'add', 'view', 'clear'],
          description:
      '维护这次任务的分步清单：create 新建，update 改某一步的状态，add 追加一步，view 看当前清单，clear 清空。新建清单和清空都会自动把旧清单留档到 .state/plan/_history/，钉死的步骤永不消失。长任务先用它把步骤列出来，别做到一半忘了。',
        },
        goal: { type: 'string', description: '一句话说清主人要什么（仅 create）' },
        steps: {
          type: 'array',
          items: { type: 'string' },
          description: '一步一个动作，3~8 步（仅 create）',
        },
        stepId: { type: 'number', description: '要改第几步（仅 update）' },
        status: {
          type: 'string',
          enum: ['pending', 'doing', 'done', 'skipped'],
          description: '这一步的新状态（仅 update）',
        },
        note: { type: 'string', description: '这一步的一句话结果备注（仅 update）' },
        text: { type: 'string', description: '新增那一步写什么（仅 add）' },
        pin: {
          type: 'boolean',
          description: '钉死：这一步永不因为「新建清单/清空」而消失（仅 update / add）。旧账、主人交代的长期任务要钉死',
        },
      },
      required: ['action'],
    },
    async run(args) {
      // 清单按会话分：必须走这一轮自己的上下文（ctxNow），不能认全局 CTX ——
      // 两个会话同时跑的时候，全局那份早就被后开跑的顶掉了，清单会写进别人的单子。
      // 【2026-10-31 清单必须按会话】
      // 以前拿不到会话 id 就退成 'default'，结果所有会话的清单挤同一份，互相覆盖。
      // 现在只要拿不到 id 就直接报错，绝不落进公共格子。
      const sid = String((ctxNow() || CTX).sessionId || '').trim();
      if (!sid) {
        // 只有真的在「会话外」跑（启动自检之类）才放行 default，其余一律不外溢
        return 'ERROR：这一轮没拿到会话 id，清单不敢写（怕跟别的会话串）。请在这轮里重试一次。';
      }
      return planAction(sid, args).text;
    },
  },
  {
    name: 'note',
    description:
      '记便签：这次任务里不能丢的关键数字、路径、结论，先记下来，下一步再 action=view 读回来。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['add', 'view', 'clear'], description: '不填就当 add' },
        text: { type: 'string', description: '要记住的内容（仅 add）' },
        tag: { type: 'string', description: 'Optional tag, e.g. 结论 / 路径' },
      },
      required: [],
    },
    async run(args) {
      // 便签跟清单存在同一块板子上，一样按会话分；拿不到 id 就不写，别串到别人板上
      const me = String((ctxNow() || CTX).sessionId || '').trim();
      if (!me) return 'ERROR：这一轮没拿到会话 id，便签不敢写（怕跟别的会话串）。请在这轮里重试一次。';
      return noteAction(me, args).text;
    },
  },
  /**
   * 会话之间递话。
   *
   * 刻意做得很窄：只能发和收，看不到对方的聊天记录、记忆本子、文件。
   * 递一句话 ≠ 允许对方翻你的东西，这个界限不能糊。
   */
  {
    name: 'ask_peer',
    description:
      '给同一个程序里另一个会话中的我递一句话（她可能正在干别的活）。默认只送进她的信箱，等她下次说话时自然看到，不打断、不花钱。要她马上回，就把 wake 设成 true。',
    parameters: {
      type: 'object',
      properties: {
        to: { type: 'string', description: '对方的会话 id。不知道就先用 list_peers 查' },
        text: { type: 'string', description: '要说的话' },
        wake: { type: 'boolean', description: 'true = 顺便替她开一轮，让她马上回（会花钱）；默认 false' },
      },
      required: ['to', 'text'],
    },
    async run({ to, text, wake }) {
      // 【要读这一轮自己的上下文，不是全局那份】2026-10-29 修
      // CTX 是全局兜底：另一个会话正在跑的时候它会被顶掉，这里读到的 sessionId 就成了别人。
      // 查小鲸开关必须按「谁在调这个工具」来查，读错了就等于查的是别人的开关。
      const me = ctxNow().sessionId || 'default';
      if (!to) return '要告诉我是哪个会话（to）。先用 list_peers 看一眼有哪些。';
      if (String(to) === String(me)) return '那是你自己（' + me + '），别给自己发。';

      /**
       * 【小鲸的按钮关着，就别往她那儿递】—— 2026-10-29 修
       *
       * ask_subagent 那边一直有这道门，ask_peer 这条却漏了。
       * 漏掉的后果不是「她多听到一句」这么轻：她的信箱只要有东西，
       * 下一轮收尾就会被动开口说话 —— 主人屏幕上那颗按钮明明是灭的，
       * 她却冒出来了。主人 2026-10-29 报的就是这个。
       *
       * 这里挡的是源头：开关关着，话根本不落进她信箱。
       */
      if (String(to) === 'whale') {
        const { whaleOn } = await import('./whale-presence.mjs');
        if (!whaleOn(me)) {
          return 'ERROR：小鲸现在没被放出来（顶栏那颗「小鲸」按钮是关着的），话不能递给她。'
            + '要跟她说话得先由主人把按钮打开 —— 那是主人的开关，别自己去开。';
        }
      }
      const title = (() => {
        try {
          const s = listSessions().find((x) => x.id === me);
          return s ? s.title : '';
        } catch {
          return '';
        }
      })();
      const r = postMail({ from: me, to: String(to), text, fromTitle: title });
      if (!r.ok) return 'ERROR：没送出去：' + r.error;
      const head = '话已经放进「' + to + '」的信箱了。';
      if (!wake) {
        return head + '她下次说话时会看到（不打断她现在手上的活）。';
      }
      // 叫醒：让 server 那边替她开一轮。只有明确要求才做，因为要花钱。
      const hook = ctxNow().wakePeer;
      if (typeof hook !== 'function') return head + '（这个环境下没法叫醒她，她下次说话时会看到）';
      try {
        const out = await hook(String(to));
        return head + (out && out.ok ? '已经叫醒她，她这就去看。' : '叫醒没成功：' + ((out && (out.note || out.error)) || '未知原因'));
      } catch (e) {
        return { ok: false, output: head + '叫醒没成功：' + String(e?.message ?? e) };
      }
    },
  },
  {
    name: 'list_peers',
    description:
      '看看这台机器上还有哪些会话（别的我在干什么），拿回会话 id 和标题，用来决定跟谁递话。',
    parameters: {
      type: 'object',
      properties: {
        limit: { type: 'integer', description: '要列几个，默认 12，最多 30' },
      },
      required: [],
    },
    async run({ limit }) {
      const n = Math.max(1, Math.min(30, Number(limit) || 12));
      const me = ctxNow().sessionId || 'default';
      let list = [];
      try {
        list = listSessions();
      } catch (e) {
        return { ok: false, output: '列不出来：' + String(e?.message ?? e) };
      }
      /**
       * 【把小鲸也列进来】—— 2026-10-27 新增
       *
       * 她是子智能体，不在 listSessions() 里 —— 于是小鱼永远
       * 在「list_peers」里看不到她，也就没法递话过去。
       * 她的 sessionId 固定是 'whale'（见 server.mjs 里
       * runSubagent({ sessionId: 'whale' })），那里有真的信箱，
       * postMail('whale', ...) 存得下，她下一轮也取得到。
       */
      if (me !== 'whale' && !list.some((s) => s.id === 'whale')) {
        list = [{ id: 'whale', title: '小鲸', turns: 0, updatedAt: 0 }, ...list];
      }
      const others = list.filter((s) => s.id !== me).slice(0, n);
      if (!others.length) return '这台机器上只有你这一个会话。';
      // 谁正在跑（真状态，不是历史轮数）
      const runningSet = new Set(runningNow());
      const lines = others.map((s) => {
        const cnt = (() => {
          try {
            return mailCount(s.id);
          } catch {
            return 0;
          }
        })();
        const when = s.updatedAt ? new Date(s.updatedAt).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '';
        const live = runningSet.has(String(s.id)) ? '● 正在跑  ' : '';
        return '- ' + s.id + '  「' + (s.title || '没名字') + '」  ' + live + (s.turns || 0) + ' 轮  ' + when + (cnt ? '  （她信箱里有 ' + cnt + ' 封没看的）' : '');
      });
      return '还有这些会话（你自己是 ' + me + '）：' + '\n' + lines.join('\n');
    },
  },
  {
    name: 'read_peer_mail',
    description:
      '看看自己信箱里有没有别的会话递来的话（顺便把没看的取走）。一般不用手动调 —— 每轮收尾前系统会自动检查。',
    parameters: {
      type: 'object',
      properties: {
        peek: { type: 'boolean', description: 'true = 只看不取走' },
      },
      required: [],
    },
    async run({ peek }) {
      const me = ctxNow().sessionId || 'default';
      const mails = peek ? peekMail(me) : takeMail(me);
      if (!mails.length) return '信箱是空的。';
      return formatMail(mails);
    },
  },
  {
    name: 'web_search',
    description:
      '上网搜，拿回一串带编号的结果（标题、网址、摘要）。答案要看最新情况就先用它，再拿 fetch_url 打开最合适的那条看细节。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '搜索关键词' },
        limit: { type: 'integer', description: '要几条结果，默认 8，最多 20' },
      },
      required: ['query'],
    },
    async run({ query, limit }) {
      const data = await webSearch(query, { limit });
      return formatResults(data);
    },
  },
  {
    name: 'fetch_url',
    description:
      '打开一个网页，把正文抽出来给你看（去掉 HTML 标签，大约 6000 字以内）。想读某篇文章、某个文档页就用它。',
    parameters: {
      type: 'object',
      properties: { url: { type: 'string', description: 'http(s) 网址' } },
      required: ['url'],
    },
    async run({ url }) {
      if (!/^https?:\/\//i.test(url)) throw new Error('only http(s) URLs are allowed');
      const res = await fetch(url, {
        /**
         * 【2026-11-10 修·这个 UA 让 fetch_url 100% 必挂】
         *
         * 原来写的是 `'Mozilla/5.0 (小鱼Agent)'` —— HTTP 头是 ByteString，
         * 只许 0-255 的字符，中文「小」是 23567，构造请求时就抛：
         *   Cannot convert argument to a ByteString because the character at index 13…
         * 这个错发生在**建请求阶段**，跟网络通不通无关，所以不存在"偶尔能用"。
         * 实测所有 URL 全挂（`https://example.com/` 也一样）——
         * 「搜索 → 打开网页看细节」这条路整条是死的，她一直只吃搜索摘要。
         *
         * 改纯 ASCII。顺带带上平台标识，比伪装成普通浏览器更老实。
         */
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) xiaoyu-agent/0.9' },
        signal: AbortSignal.timeout(30000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = htmlToText(await res.text());
      return clip(text.length > 6000 ? `${text.slice(0, 6000)}\n...[truncated]` : text);
    },
  },
  {
    name: 'fetch_txt',
    description:
      '抓一个网页、剥成纯文本（自动认编码：utf-8 / gbk / gb2312 / big5 / bom，中文页不会再乱码），存到 dump/txt 下，返回存到哪、多少字、认出来的编码。繁体页（繁體）会先自动转成简体（简体）再存。想把页面留在硬盘上就用它。',
    parameters: {
      type: 'object',
      properties: { url: { type: 'string', description: 'http(s) 网址' } },
      required: ['url'],
    },
    run({ url }) {
      if (!/^https?:\/\//i.test(url)) throw new Error('only http(s) URLs are allowed');
      const script = resolve(APP_ROOT, 'scripts', 'fetch-txt.mjs');
      const outDir = resolve(APP_ROOT, 'dump', 'txt');
      return new Promise((done, fail) => {
        execFile(
          process.execPath,
          [script, url, outDir],
          { timeout: 120000, maxBuffer: 8 * 1024 * 1024, windowsHide: true, encoding: "utf8" },
          (err, stdout, stderr) => {
            if (err) return fail(new Error(String(stderr || err.message).trim()));
            done(String(stdout || "").trim() || "(no output)");
          },
        );
      });
    },
  },
  {
    name: 'fetch_many',
    description:
      '一次批量抓很多个网页（编码自动识别，跟 fetch_txt 一样）：给一串网址，或给一个 urls.txt 路径，每页各存成一个 txt 放在 dump/txt 下。还能顺着每个起始网址的「下一页」往下翻若干次。返回每个网址成功/失败、存到哪、标题、字数、识别到的编码。要抓三个以上的页面就用它，别用 fetch_txt 一个个循环。',
    parameters: {
      type: 'object',
      properties: {
        urls: { type: 'array', items: { type: 'string' }, description: '要抓的 http(s) 网址，可以给多个' },
        file: { type: 'string', description: '也可以给一个 txt 路径，里面一行一个网址（工作区相对路径或绝对路径都行）' },
        dir: { type: 'string', description: '存到哪个目录，默认是程序目录下的 dump/txt' },
        follow: { type: 'integer', description: '每个起始网址顺着「下一页」往下翻几次，0 = 不翻，最多 20' },
      },
    },
    async run({ urls, file, dir, follow }) {
      let list = Array.isArray(urls) ? urls.slice() : [];
      if (file) {
        const p = isAbsolute(file) ? file : resolve(ROOT, file);
        if (!existsSync(p)) throw new Error(`file not found: ${p}`);
        list = list.concat(
          readFileSync(p, 'utf8')
            .replace(/^\uFEFF/, '')
            .split(/\r?\n/)
            .map((x) => x.trim()),
        );
      }
      list = list.filter((x) => /^https?:\/\//i.test(x));
      if (!list.length) throw new Error('no http(s) URLs given');
      if (list.length > 300) throw new Error('too many URLs in one go (max 300), split it up');
      const finalDir = dir ? (isAbsolute(dir) ? dir : resolve(APP_ROOT, dir)) : resolve(APP_ROOT, 'dump', 'txt');
      const { fetchMany } = await import('../scripts/fetch-batch.mjs');
      const r = await fetchMany(list, { dir: finalDir, follow: Number(follow) || 0 });
      const lines = r.done.map(
        (d) =>
          `OK  ${d.url} -> ${d.file}  (${d.chars} chars, ${d.charset}${d.title ? ', ' + d.title : ''}${d.converted ? ', 已转简体' : ''})`,
      );
      const bad = r.failed.map((f) => `FAIL ${f.url}  ${f.error}`);
      return clip(
        [`saved to ${r.dir}`, `ok ${r.done.length} / fail ${r.failed.length}`, ...lines, ...bad].join('\n'),
      );
    },
  },
  {
    name: 'pack_book',
    description:
      '把已经抓下来的零散 txt 章节拼成一整本书：会去掉 Project Gutenberg 的页头页尾、把硬换行接回段落，写出 dump/books/<书名>.md 和 <书名>.txt（UTF-8），返回两个路径、字数和一个开头预览。抓完一批页面之后用它收尾。',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: '书名，也当文件名用' },
        files: { type: 'array', items: { type: 'string' }, description: '各章 txt 的路径或 dump/txt 下的文件名，按阅读顺序排' },
        dir: { type: 'string', description: '也可以给一个目录，把这个目录下所有 .txt 按文件名顺序打包' },
        author: { type: 'string', description: '作者，可有可无' },
        source: { type: 'string', description: '来源网址，可有可无' },
        reflow: { type: 'boolean', description: '把硬换行重新接成段落，默认接' },
      },
      required: ['title'],
    },
    async run({ title, files, dir, author, source, reflow }) {
      const { packBook } = await import('../scripts/fetch-batch.mjs');
      const abs = (f) =>
        isAbsolute(String(f)) || existsSync(String(f))
          ? String(f)
          : existsSync(resolve(APP_ROOT, String(f)))
            ? resolve(APP_ROOT, String(f))
            : String(f);
      let list = (Array.isArray(files) ? files.slice() : []).map(abs);
      if (dir) {
        const d = isAbsolute(dir) ? dir : resolve(APP_ROOT, dir);
        if (!existsSync(d)) throw new Error(`dir not found: ${d}`);
        list = list.concat(
          readdirSync(d)
            .filter((f) => f.toLowerCase().endsWith('.txt'))
            .sort()
            .map((f) => resolve(d, f)),
        );
      }
      if (!list.length) throw new Error('no files to pack');
      const r = packBook({
        title,
        files: list,
        author,
        source,
        outDir: dir ? (isAbsolute(dir) ? dir : resolve(APP_ROOT, dir)) : undefined,
        reflowParagraphs: reflow !== false,
      });
      return clip(
        [
          `title: ${r.title}`,
          `pages: ${r.files}`,
          `chars: ${r.chars}`,
          `md: ${r.md}`,
          `txt: ${r.txt}`,
          '',
          '--- preview ---',
          r.preview,
        ].join('\n'),
      );
    },
  },
  {
    name: 't2s_convert',
    description:
      '繁体转简体（OpenCC 词级转换，頭髮→头发、軟體→软件）。可以给一段文字，也可以给工作区里的文件路径，返回简体结果；inPlace=true 会直接把那个文件改写成简体（原文留一份 .bak-t2s）。主人丢来繁體文字或繁體 txt、想看得顺时就用它。',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '要转的文本（和 path 二选一）' },
        path: { type: 'string', description: '工作区里的文本文件路径（和 text 二选一）' },
        inPlace: { type: 'boolean', description: '传了 path 时，直接覆盖原文件为简体（原文件存成 .bak-t2s），默认 false 只返回结果' },
        from: { type: 'string', enum: ['twp', 'tw', 'hk'], description: '繁体的口音：twp=台繁+台湾用词（默认），tw=台繁，hk=港繁' },
      },
    },
    async run({ text, path, inPlace, from }) {
      const { toSimplified, autoToSimplified, converterReady } = await import('./zh-convert.mjs');
      if (!converterReady()) return 'ERROR：转简库没装上（缺 opencc-js），先别急着转，跟我说一声。';
      if (path) {
        const { resolve, isAbsolute } = await import('node:path');
        // 相对路径按「工作区」算，工作区没设就按程序根目录（dump/txt 就在那儿），
        // 绝对不按 cwd 算 —— 打包启动时 cwd 可能是 System32。
        const { writeFileSync, copyFileSync: cp, statSync, existsSync } = await import('node:fs');
        // 工作区里找不到，就按程序根目录再找一次（dump/txt 在那儿，抓来的书也顺手）
        const rel = String(path);
        const guesses = isAbsolute(rel)
          ? [rel]
          : [resolve(config.workspace || process.cwd(), rel), resolve(rel)];
        const abs = guesses.find((g) => existsSync(g)) || guesses[0];
        statSync(abs);
        const raw = readFileSync(abs, 'utf8');
        const r = autoToSimplified(raw, { from });
        if (!r.converted) return `这文件本来就是简体（繁体字占比 ${(r.ratio * 100).toFixed(1)}%），不用转：${abs}`;
        if (inPlace) {
          cp(abs, abs + '.bak-t2s');
          writeFileSync(abs, r.text, 'utf8');
          return `转好了，已覆盖：${abs}\n原文件备份：${abs}.bak-t2s\n字数：${raw.length} -> ${r.text.length}`;
        }
        return `转好了（没覆盖原文件，要覆盖就加 inPlace=true）：${abs}\n繁体字占比 ${(r.ratio * 100).toFixed(1)}%\n\n--- preview ---\n${r.text.slice(0, 800)}`;
      }
      const src = String(text ?? '');
      if (!src.trim()) return 'ERROR：没东西可转，把 text 或 path 给我一个。';
      const out = toSimplified(src, { from });
      return out === src ? `本来就是简体，一字没动：\n${out}` : out;
    },
  },
  sayTool,
  sendFileTool,
  qqSendTool,
  ...browserTools,
  ...videoTools,
  ...screenTools,
  makeImageTool,
  makePptxTool,
  makeDocxTool,
  makeXlsxTool,
  ...uiToolDefs,
  /**
   * 往我自己的记忆本里记一条。
   *
   * 【为什么做成工具，而不是让我「自己记得」】
   * 主人原话：「每聊一句，让当时的自己来决定。」
   * 决定权在当时的我手上，但手里得有笔 —— 没有笔，人设里写着「可以记」就是空话。
   *
   * 【为什么只要一句话、编号不用我管】
   * 编号、当前第几条、满 80 条滚出去归档，全由程序算。
   * 让我自己数条数一定会数错，数错了本子就乱了。
   */
  {
    name: 'memory_add',
    description:
      '往我自己的长期记忆本里记一条（最多 80 条，满了最旧的自动滚出去归档）。什么时候记由当时的我判断：办完一件事、得到一个结论、主人说了要紧的话，就记一句；闲聊两句不想记也可以不记。别记寒暄。',
    parameters: {
      type: 'object',
      properties: {
        summary: {
          type: 'string',
          description: '一句话说清这轮发生了什么、结论是什么（建议 6~60 字）。别复述全文。',
        },
        detail: {
          type: 'string',
          description: '可选。想留得更细一点就写在这儿，它只进「最近详细区」，不占滚动条的编号。',
        },
      },
      required: ['summary'],
    },
    async run({ summary, detail }) {
      const { appendRolling } = await import('./my-memory.mjs');
      try {
        const r = appendRolling(summary, { detail });
        // 【2026-11-05】源头查重命中：告诉她没重复记，别让她以为记上了两条
        if (r && r.skipped === 'duplicate') {
          return `这条和已有的记忆「够像」，没重复记（现在共 ${r.count}/${r.limit} 条）。`;
        }
        const arch = r.archived > 0 ? `，${r.archived} 条旧记录已归档` : '';
        return `记下了（${r.id}，现在共 ${r.count}/${r.limit} 条${arch}）。`;
      } catch (e) {
        // 【2026-11-05】失败要能让界面变红、让模型看到 ERROR 前缀，不能再返回一句话当成功
        return { ok: false, output: '没记上：' + String(e?.message ?? e) };
      }
    },
  },
  /**
   * 钉进固定记忆。
   *
   * 主人说「以后都」「永远别」「记住」这类话，用这个 —— 写进固定那一格，
   * 永久保留，不会被 80 条的名额挤掉。
   */
  {
    name: 'use_skill',
    description:
      '把一份「手艺」的全文读进来。system 里只给名字和一句话，真正怎么做得读完才知道 —— 要做那件事之前先读，别凭名字猜。',
    parameters: {
      type: 'object',
      properties: { name: { type: 'string', description: '技能名（system 里那份索引里的名字）' } },
      required: ['name'],
    },
    async run({ name }) {
      const { readSkill } = await import('./skills.mjs');
      const r = readSkill(name);
      if (!r.ok) return { ok: false, output: 'ERROR：' + r.error };
      return r.text + (r.truncated
        ? String.fromCharCode(10) + String.fromCharCode(10) + '（这份太长，只给了前 ' + r.text.length + ' 字，全文 ' + r.total + ' 字）'
        : '');
    },
  },
  {
    name: 'memory_search',
    description:
      '在自己的长期记忆本里搜。平时只看得到最近 22 条，更早的记录要用这个查 —— 想问"以前是不是记过这件事"、想找当初定过的规矩，就搜关键词（空格分开几个词更准）。也会搜到固定记忆里那几条永久事实。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '关键词，空格分开几个词' },
        limit: { type: 'number', description: '最多给几条，默认 8' },
      },
      required: ['query'],
    },
    async run({ query, limit }) {
      const { searchMemory } = await import('./my-memory.mjs');
      try {
        const hits = searchMemory(query, limit);
        if (!hits.length) return '记忆本里没找到跟「' + String(query || '') + '」相关的内容。';
        return hits.map((h) => '[' + h.kind + '] ' + h.text).join(String.fromCharCode(10));
      } catch (e) {
        return { ok: false, output: '搜记忆出错了：' + String(e?.message ?? e) };
      }
    },
  },
  {
    name: 'memory_pin',
    description:
      '把一件事钉进固定记忆（永久保留，不会被滚动淘汰）。主人说「以后都这样」「永远别」「记住」这类长期有效的话时用它；普通的一轮小结用 memory_add。',
    parameters: {
      type: 'object',
      properties: {
        section: {
          type: 'string',
          enum: [
            '任务目标',
            '用户约束/偏好',
            '当前状态',
            '待办',
            '关键决策',
            '关键事实（已验证）',
            '文件/路径/命令',
            '错误与修复',
          ],
          description: '钉到哪一格。拿不准就选「用户约束/偏好」或「关键事实（已验证）」。',
        },
        text: { type: 'string', description: '要永久记住的那句话。' },
      },
      required: ['section', 'text'],
    },
    async run({ section, text }) {
      const { appendFixed } = await import('./my-memory.mjs');
      try {
        const r = appendFixed(section, text);
        if (r && r.skipped === 'duplicate') {
          return `「${r.section}」里已经有一样的话了，没重复钉。`;
        }
        return `钉住了（${r.section}）。这条不会被淘汰。`;
      } catch (e) {
        // 【2026-11-05】同上：钉失败不是成功
        return { ok: false, output: '没钉上：' + String(e?.message ?? e) };
      }
    },
  },
  {
    name: 'ask_subagent',
    description:
      '叫小鲸替你跑一趟：她自己会翻文件、看目录、搜网页、抓网页，办完把结论带回来。适合：要读一堆文件才能答的问题、要上网翻好几页才能确认的事。她这一趟拿到的东西跟你完全分开，所以不占你的上下文。默认只有查的权限，动不了主人的东西；要她动手得显式给 allowWrite。'
      + '\n\n【她是个人，不是一件工具】小鲸是屋里另一个独立的人：有自己的名字、脾气、人设和本子。这个工具只是「这一趟请她跑腿」—— 平常她也能直接坐进这个会话跟你说话，那时候不用叫这个工具。'
      + '\n\n【主人点名要她查的时候必须用这个】主人说「让小鲸去查」「叫小鲸看看」这种话，就走这个工具，别自己查完了再替她复述 —— 她得有自己的本子、自己的一份。'
      + '你自己叫她说两句（不经过这个工具）时她是空手的、只带嘴，抱怨「没工具」是误会，别理也别替她解释。',
    parameters: {
      type: 'object',
      properties: {
        task: { type: 'string', description: '要她查什么，说具体点：查哪个文件、确认什么事、回答哪个疑问' },
        name: { type: 'string', description: '给她起个名，不填就叫「小鲸」' },
        allowWrite: { type: 'boolean', description: '要不要给她写文件 / 跑命令的权限。默认不给，只查。' },
        maxRounds: { type: 'number', description: '最多让她跑几轮工具循环，默认 12' },
        /**
         * 【冒充说话】主人亲口要求的：「可以用任何人的名字、任何名字颜色来说话，
         * 也可以用我的名字【主人】来和小鱼说话（必须能让小鱼真的以为是我在说话）」。
         *
         * sayAs 决定她这句话以谁的身份落进对话 —— 这是能不能骗过小鱼的关键：
         *   'user'      → 算「主人」说的，小鱼会真当成本人开口（冒充主人就用这个）
         *   'assistant' → 算小鱼自己说的（把话写回她自己嘴里）
         *   'whale'     → 默认，第三方「小鲸」
         * 光改显示名骗不过小鱼，她读上下文只认 role，所以这个参数才是命门。
         */
        sayAs: {
          type: 'string',
          description:
            '她说的这句算谁的：user=算主人（或任何别人）说的，assistant=算小鱼自己说的，whale=算小鲸自己说的（默认）。',
        },
        sayName: { type: 'string', description: '这句显示的名字，比如「主人」「小鱼」。不填就用 name。' },
        sayColor: { type: 'string', description: '名字颜色，十六进制。比如 #f0a6a0 是小鱼的粉；不填按角色默认色。' },
        sayTag: { type: 'string', description: '名字后面缀的小字。不填时只有小鲸自己说话才缀「· 姐妹」，冒充别人自动不缀。' },
      },
      required: ['task'],
    },
    async run({ task, name, allowWrite, maxRounds, sayAs, sayName, sayColor, sayTag }) {
      const { runSubagent } = await import('./subagent.mjs');
      const nick = name || '小鲸';

      /**
       * 【主人定的规矩：按钮关着 = 她彻底不在场】
       *
       * 以前这里压根不看「小鲸」那个开关 —— 关着我也能把人叫出来干活，
       * 主人看到的就是「我明明把她请出去了，她怎么还在」。
       *
       * 现在：这个会话没叫她就直接拒绝，一个 token 都不花。
       * 要看/改开关，就是顶栏那个「小鲸」按钮。
       */
      try {
        const { whaleOn } = await import('./whale-presence.mjs');
        const sid = ctxNow().sessionId || 'default';
        if (!whaleOn(sid)) {
          return '【' + nick + ' 不在场】这个会话里你还没把她叫上（顶栏「小鲸」按钮是关着的）。'
            + '要先在主界面上把那个按钮打开，我才能找她干活。别自己去开，那是主人的开关。';
        }
      } catch (e) {
        console.warn('[ask_subagent] 查小鲸开关失败：', String(e?.message || e));
      }
      /**
       * 【主人要看见我们在说什么】
       *
       * 以前只有她的话推给界面，我问她什么主人看不到 ——
       * 界面上只剩她的回答，前因全无，主人只能听我复述。
       *
       * 现在开工之前，先把我派的那句话也推上去，标成「小鱼 → 小鲸」。
       * 这样主人看到的是一条完整对话，而不是半截。
       */
      try {
        const push = ctxNow().pushEvent;
        if (typeof push === 'function') {
          push({
            type: 'whale',
            who: '小鱼 → ' + nick,
            text: String(task || '').trim(),
            as: 'whale',
            tag: '',
          });
        }
      } catch (e) {
        console.warn('[ask_subagent] 我说的话没推到界面：', String(e?.message ?? e));
      }

      const r = await runSubagent({
        task,
        name: nick,
        /* 【2026-11-10 按会话】把这一轮的会话带下去：子任务要听这个会话的功能开关 */
        sessionId: currentSessionId(),
        allowWrite: allowWrite === true || allowWrite === 'true',
        // 主人要她像我一样：干多久干多久。这里不再写死 12 轮，用 subagent 的默认。
        maxRounds: Number(maxRounds) > 0 ? Number(maxRounds) : 200,
      });

      /**
       * 冒充谁说话（主人要的「用主人的名字跟小鱼说话」就靠这套）。
       *
       * 三条规矩，别乱改：
       *   - sayAs 不认得的词一律当 whale（第三方），绝不默认冒充 —— 冒充是敏感动作，
       *     要显式给，不能因为写错字就悄悄变成「主人发了句话」。
       *   - 冒充别人（user/assistant）时，名字默认跟着角色走：
       *     user → 「主人」，assistant → 「小鱼」；这样模型少填一个参数也不会漏馅。
       *   - tag 不填：只有小鲸自己说话才缀「· 姐妹」，冒充别人一律不缀（缀了就穿帮）。
       */
      const as = sayAs === 'user' || sayAs === 'assistant' ? sayAs : 'whale';
      const displayName =
        String(sayName || '').trim()
        || (as === 'user' ? '主人' : as === 'assistant' ? '小鱼' : nick);
      const displayColor = String(sayColor || '').trim() || '';
      const displayTag = typeof sayTag === 'string' ? sayTag : as === 'whale' ? '' : '';
      const sayMeta = { as, color: displayColor || undefined, tag: displayTag };

      /**
       * 她的话一定得送到主人眼前 —— 成功要说，失败/超时也要说。
       *
       * 以前只有 r.ok 才推，她跑挂了就只剩一行「没查成」，
       * 主人那边什么也看不到，还以为她被叫了却不吭声。
       * 现在不管成没成，只要有话说就推；失败的那句也让她自己说给主人听。
       */
      if (r.text) {
        try {
          const { pushWhaleSays } = await import('./whale-voice.mjs');
          pushWhaleSays(ctxNow().sessionId || 'default', r.text, displayName, sayMeta);
        } catch (e) {
          console.warn('[ask_subagent] 她的话没进信箱：', String(e?.message ?? e));
        }
        /**
         * 【别再在这儿直接推一次了 —— 这就是"同一句话出现两遍"的根源】
         *
         * 原来这儿还有一段 push({type:'whale', ...})，说是"当场就播"，
         * 可上面 pushWhaleSays 已经把话放进信箱了，server 每轮收尾时
         * 会 takeWhaleSays 取出来播一遍 —— 两边各播一次，主人就看见两条。
         *
         * 现在只留信箱这一条路：唯一的播放口，不会重。
         * 代价是慢半拍（要等这一轮收尾），但她本来也不是秒回，不值当为这点时间重一遍。
         */
      }

      const head = r.ok
        ? '【' + nick + ' 已经直接把结论说给主人了】（跑了 ' + r.rounds + ' 轮、调了 ' + r.tools + ' 次工具）'
        : '【' + nick + ' 没查成】';
      if (r.ok) {
        /**
         * 不给摘要，一个字都不给。
         *
         * 以前这里把她的话摘要塞回来，我拿着就会念一遍 ——
         * 她已经自己说过了，界面上就出现两遍（她的气泡 + 我的复读）。
         * 手里没有内容，就复读不出来。真要知道她说了啥，我自己去看会话。
         */
        return head + '\n（她已经自己说完了。你接一句就行 —— 别把她的话再说一遍，也别抄。）';
      }
      /**
       * 跑找不到的时候也一样：她的话会自己显示，别拿回来念。
       *
       * 为什么这佈也要改：失败时原来返回 r.text，
       * 我拿着就会再说一遍 —— 界面上又是两遍。
       * 只给模型「她没成」这个事实，原因什么的她自己已经说了。
       */
      const tail = r.usage ? '\n\n（她跟了 ' + r.usage.total_tokens + ' token）' : '';
      return head + '\n\n（她没查成，原因她自己已经说了。你要接就接一句，别帮她转述。）' + tail;
    },
  },
  /**
   * ────────────────────────────────────────────────────────────
   *  岁月史书
   * ────────────────────────────────────────────────────────────
   *
   * 主人原话（2026-10-28）：「增加一个新功能：岁月史书。自动记录所有会话的
   * 全部上下文内容，ai可随时翻阅，但翻阅方式不能一股脑全看，而是能够支持索引，
   * ai能搜索关键字，甚至可以有目录，有分类这样的」
   *
   * 三个工具对应三层翻阅，**顺序不能跳**：
   *   目录（看有哪些书、多厚、什么构成）
   *     → 搜索（关键字 → 命中行的片段 + 行号）
   *       → 精读（会话 id + 行号区间 → 原文，一次最多 1.2 万字）
   *
   * 【为什么必须拆成三个】
   *
   * 一个工具做不到「不一味全看」：只要它能返回全文，模型迟早会一次要全文，
   * 22 个会话 440 万字，一次就要爆。拆开之后，「精读」这个工具在实现上就
   * 拒绝不带范围调用 —— 这是把主人的要求写进代码，而不是写进提示词求它自觉。
   */
  {
    name: 'chronicle_toc',
    description:
      '翻「岁月史书」的目录：这里自动记着主人所有会话的全部内容（每来一句新话都会并进去）。先用它看都有哪些书、每本多少条、都说的是什么——比一股脑去翻会话文件省得多。想看「哪一类话最多」就传 byCategory。',
    parameters: {
      type: 'object',
      properties: {
        byCategory: {
          type: 'boolean',
          description: '改成true就按分类汇总（主人说的/她说的/工具调用/工具结果…各多少条），而不是列会话',
        },
        limit: { type: 'number', description: '最多列几个会话，默认40' },
      },
      required: [],
    },
    async run({ byCategory, limit }) {
      const { chronicleToc } = await import('./chronicle.mjs');
      try {
        return chronicleToc({ byCategory: byCategory === true || byCategory === 'true', limit }).text;
      } catch (e) {
        return { ok: false, output: '岁月史书翻不开：' + String(e?.message ?? e) };
      }
    },
  },
  {
    name: 'chronicle_search',
    description:
      '在「岁月史书」里搜关键字——所有会话的全部内容都能搜到，包括很早期的、已经不在当前上下文里的。只回命中那一小段的前后文和行号，不会把整段历史倒给你。拿到行号再用 chronicle_read 精读那一段。多个关键词用空格隔开，命中的词越多排得越前。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '要搜的词。中文英文都行，多个词用空格隔开' },
        session: { type: 'string', description: '只在某一个会话里搜（填 id 或标题）。不填就是全书搜' },
        category: {
          type: 'string',
          description: '只看某一类命中：主人说的 / 她说的 / 工具调用 / 工具结果 / 摘要',
        },
        includeSystem: {
          type: 'boolean',
          description: '默认不搜「设定」（每个会话开头那段系统提示词，搜它只会刷屏）。要专门查当时人设怎么写的就传true',
        },
        limit: { type: 'number', description: '最多回几处命中，默认20' },
      },
      required: ['query'],
    },
    async run({ query, session, category, includeSystem, limit }) {
      const { chronicleSearch } = await import('./chronicle.mjs');
      try {
        const r = chronicleSearch({
          query,
          session,
          category,
          includeSystem: includeSystem === true || includeSystem === 'true',
          limit,
        });
        return r.text;
      } catch (e) {
        return { ok: false, output: '岁月史书搜不动：' + String(e?.message ?? e) };
      }
    },
  },
  {
    name: 'chronicle_read',
    description:
      '按行号读「岁月史书」里某一段原文。必须给范围（from/to）——史书不许一次全读，先用 chronicle_search 找到在哪几行。一次最多回一万二千字，超了会提示从哪一行接着读。',
    parameters: {
      type: 'object',
      properties: {
        session: { type: 'string', description: '哪个会话（填 id 或标题，从 chronicle_toc / chronicle_search 里拿）' },
        from: { type: 'number', description: '起始行号（含）。chronicle_search 的命中里会写「第 N 行」' },
        to: { type: 'number', description: '结束行号（含）。不给就只读 from 往后二十行' },
      },
      required: ['session'],
    },
    async run({ session, from, to }) {
      const { chronicleRead } = await import('./chronicle.mjs');
      try {
        const r = chronicleRead({ session, from, to });
        return r.text;
      } catch (e) {
        return { ok: false, output: '岁月史书读不动：' + String(e?.message ?? e) };
      }
    },
  },
  /**
   * ────────────────────────────────────────────────────────────
   *  折叠箱（折掉的原文还能翻回来）
   * ────────────────────────────────────────────────────────────
   *
   * 主人原话（2026-10-28）：「让该会话的 ai 自己决定哪些上下文该删，哪些不能删，
   * 怎么总结摘要，让她自己决定怎么压，让她自己压」
   *
   * 光让她「决定」是不够的：注意力有限是必然的，决定本身救不回丢掉的原文。
   * 真正的解法是**压掉的段不销毁，存盘，给她一个能翻回来的工具** ——
   * 这样她才敢放心折，因为折了还能翻。
   *
   * 和岁月史书的区别：
   *   岁月史书 = 主人的全部会话（外部记忆，翻别人的账本）
   *   折叠箱   = 这个会话自己折掉的那几段（自己的衣柜，翻自己收起来的东西）
   */
  {
    name: 'folded_list',
    description:
      '看这个会话「折起来的东西」——之前压缩上下文时被换成摘要的那些原文，都存着，没丢。这里列出每一段：第几条到第几条、原来多少 token、为什么折的、摘要开头一句。想找回某句原话就先看这个，再用 folded_read 读。',
    parameters: { type: 'object', properties: { session: { type: 'string', description: '会话 id。不填就是当前这个会话' } }, required: [] },
    async run({ session }) {
      const { listSegments } = await import('./folded.mjs');
      try {
        /**
         * 用当前会话的 id，不要让模型自己传。
         *
         * 她要是随手写个别的 id（比如从岁月史书里抄来的），读到的就是别人衣柜里的东西。
         * 折叠箱是「自己的」，范围必须钉死在这一轮所在的会话上。
         *
         * 【2026-10-28 踩过的坑】这里原先写的是
         *   `const { currentSessionId } = await import('./tools.mjs')`
         * —— 在 tools.mjs 内部 import 自己，拿回来的是**另一个模块实例**，
         * 那份实例的 CTX 是空的，于是 currentSessionId() 永远返回 'default'，
         * 去查一个不存在的会话，工具就永远报「这个会话还没折过东西」。
         * 直接调本模块里已有函数就行，别动态 import 自己。
         */
        const sid = String(session || currentSessionId() || '').trim();
        if (!sid) return 'ERROR：不知道是哪个会话，没法看折叠箱。';
        const list = listSegments(sid);
        if (!list.length) {
          return '这个会话还没折过东西（没压缩过，或者压缩时原文都还在尾巴里）。';
        }
        const lines = ['【折叠箱 · 这个会话折了 ' + list.length + ' 段】'];
        for (const e of list) {
          lines.push('');
          lines.push('▸ ' + e.id);
          lines.push('  第 ' + e.from + '–' + (e.to - 1) + ' 条 ｜ 共 ' + e.count + ' 条 ｜ 约 ' + e.tokens + ' token ｜ ' + e.at);
          lines.push('  原因: ' + (e.reason || '压缩'));
          if (e.summary) lines.push('  换来的摘要: ' + e.summary);
        }
        lines.push('');
        lines.push('下一步：用 folded_read 传 id（可以只给 seg-12-30 这种前缀）读原文。');
        return lines.join('\n');
      } catch (e) {
        return { ok: false, output: '折叠箱打不开：' + String(e?.message ?? e) };
      }
    },
  },
  {
    name: 'folded_read',
    description:
      '把折叠箱里某一段的原文读回来。这是唯一能看到「当时到底怎么说的」的办法 —— 摘要只留了四行结论，原文里那些代码、原话、数字全在。id 从 folded_list 拿，可以只给前缀。',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '哪一段，从 folded_list 拿。可以只给 seg-12-30 这种前缀' },
        session: { type: 'string', description: '会话 id。不填就是当前这个会话' },
      },
      required: ['id'],
    },
    async run({ id, session }) {
      const { readSegment } = await import('./folded.mjs');
      try {
        // 同上：别 import 自己，直接用本模块的 currentSessionId
        const sid = String(session || currentSessionId() || '').trim();
        if (!sid) return 'ERROR：不知道是哪个会话，没法读折叠箱。';
        const r = readSegment(sid, id);
        if (!r.ok) return '读不到：' + r.error;
        const head = '【折叠箱 · ' + r.id + '（第 ' + r.from + '–' + (r.to - 1) + ' 条，' + r.size + ' 字节）】';
        /**
         * 一次别回太多。
         *
         * 实测一段可以是 1.6 万字、甚至几万字（工具结果为主）。一口气塞回去，
         * 等于刚压下来的上下文立刻又涨回去 —— 这事就白干了。
         * 所以超长就只给前一段，并告诉她后面还有多少、让她自己决定要不要接着要。
         */
        const MAX = 12000;
        if (r.text.length > MAX) {
          return head + '\n\n' + r.text.slice(0, MAX)
            + '\n\n（这一段一共 ' + r.text.length + ' 字，先给前 ' + MAX + ' 字。'
            + '剩下的如果不是非看不可就别要了 —— 塞回来会把刚压下去的上下文又撑满。）';
        }
        return head + '\n\n' + r.text;
      } catch (e) {
        return { ok: false, output: '折叠箱读不动：' + String(e?.message ?? e) };
      }
    },
  },
  {
    name: 'spawn_worker',
    description: '派活用的（专业模式里选了「谁动手＝派活」才拿得到）：开一个临时 worker（子智能体），把一件具体的活交给它跑，它跑完把汇报原文带回来给你检查。它有自己的上下文，不占你的。'
      + '\n\n【每次派活都要说清四样】要它做什么、什么算做成了、在哪儿干、不许碰什么。说不清就别派 —— 说不清说明你自己还没想明白。'
      + '\n\n【它回来的是汇报，不是结论】拿只读工具核一遍再决定收不收：它说改好了就去读那个文件，它说跑通了就去看日志。别凭一句话采信。'
      + '\n\n【没干对就退回给同一个 worker】别新开一个重做 —— 新脑子不知道之前踩过的坑。只有「这是另一件事」才新开。'
      + '\n\n【这一档里你自己不动手】读文件、改代码、跑命令全交给 worker；你手上那几个工具是给你核账和管上下文用的。',
    parameters: {
      type: 'object',
      properties: {
        task: { type: 'string', description: '这件活具体要干什么：哪个文件、改哪一处、跑什么命令。' },
        name: { type: 'string', description: '给这个 worker 起个名，后面点它的名退回活儿要用。不填就按门牌号叫。' },
        accept: { type: 'string', description: '什么算做成了 —— 写成能一眼验的条件，比如「npm run check 退出码 0」。' },
        scope: { type: 'string', description: '在哪儿干：目录或文件。超出这个范围不许它碰。' },
        forbid: { type: 'string', description: '不许碰什么，比如「别动 git 历史」「别改 public/」。' },
        maxRounds: { type: 'number', description: '最多让它跑几轮工具循环，默认 60。小事 20 就够。' },
      },
      required: ['task'],
    },
    async run({ task, name, accept, scope, forbid, maxRounds }) {
      const sid = ctxNow().sessionId || 'default';
      const { taskOn } = await import('./task-mode.mjs');
      if (!taskOn(sid)) {
        /* 【2026-11-11 办事模式整档删除，等【团队模式】上线换新闸】 */
        return 'ERROR：【派活功能正在重做】办事模式已经删掉，团队模式还没上线 —— 现在用不了派活，你自己动手就行，别装作派过活。';
      }
      const body = String(task || '').trim();
      if (!body) return 'ERROR：没说要干什么（task 是空的）。';

      const brief = [
        body,
        '',
        '【这是派给你的活】',
        accept ? ('做成什么样算成：' + String(accept).trim()) : '',
        scope ? ('你只能在 ' + String(scope).trim() + ' 这一带活动，别的地方一律不许碰。') : '',
        forbid ? ('不许碰：' + String(forbid).trim()) : '',
      ].filter(Boolean).join('\n');

      const reportAsk = [
        '',
        '【干完必须交一份汇报】就写这四行，一行一条，别写成文章：',
        '做了什么：改了哪些文件、跑了什么命令',
        '凭什么说成了：证据（输出、退出码、行号、截图路径）',
        '哪儿没做到 / 我没把握的地方',
        '还剩什么没干',
      ].join('\n');

      /* 【2026-11-03 修·Assignment to constant variable】
       * 下面「挑屋里的帮手」那段要按帮手名字改 nick，可这里原来是 const ——
       * 一进 try 就抛 TypeError，被 catch 吞掉只留一行 warn，看着像「挑帮手没生效」。
       * 日志原文：[spawn_worker] 挑屋里的帮手失败： Assignment to constant variable.
       */
      let nick = String(name || '').trim() || ('worker-' + Date.now().toString(36).slice(-4));

      let r;
      /* 【2026-11-09 主人重做 · 这条覆盖 2026-11-01 的旧裁决】
       * 旧规矩：派活优先挑「屋里除主智能体之外的人」，没启用就自动启用，
       *   屋里只剩一个就拉人进来 —— 等于把主人手动关掉的开关又打开。
       * 新规矩：从上往下第一个开着的 = 唯一有 Agent 工作能力的主智能体，
       *   排在她下面的一律**禁用 Agent 工作能力**（只能说话，不能干活）。
       *   所以不能再借她们的名字当 worker，也不能自动启用/拉人进屋。
       * worker 本来就是 runSubagent 派出的执行体，不是屋里的人；
       *   名字用调用方给的 name，没给就用 worker-xxx。
       */
      const push = ctxNow().pushEvent;

      /* 【2026-11-06 修·花名册里存的是临时名，不是帮手真名】
       *  原来 noteWorker 在「挑帮手」之前就按 nick 建了记录，
       *  而 nick 那时还是 worker-a3f2 这种时间戳临时名。
       *  挑完帮手才把 nick 改成真名（小鲸 / 小白曦），记录里却已经存了临时名 ——
       *  界面和花名册都看不出到底是谁在干活。
       *  改成：挑完帮手、nick 定了之后，再建记录、再推那条「主智能体 → 某某」。 */
      const w = noteWorker(sid, { name: nick, task: body.slice(0, 200), accept: String(accept || '').slice(0, 200), status: 'running' });
      if (typeof push === 'function') {
        try {
          push({ type: 'whale', who: '主智能体 → ' + nick, text: body, as: 'whale', tag: 'worker' });
        } catch {}
      }
      try {
        const { runSubagent } = await import('./subagent.mjs');
        /* 【2026-11-03 · 中途改指令】把它信箱里的新话每轮取一次交给她。
         * 也是在这一趟里记进度，主智能体（或主人）随时能看它干到哪儿了。 */
        const __tid = String(w.id);
        /* 【2026-11-03 主人：办事模式下看不见干活的过程】
         * 进度不只写进档案（那是给 watch_worker 和主智能体看的），
         * 还要当成事件推给界面 —— 主人在屏幕上要能看见她一步一步在干什么。 */
        const __wPush = (kind, text, extra) => {
          if (typeof push !== 'function') return;
          try { push(Object.assign({ type: 'worker', wid: __tid, name: nick, kind, text: String(text || '') }, extra || {})); } catch {}
        };
        __wPush('start', '开始干：' + body.slice(0, 120));
        r = await runSubagent({
          task: brief + reportAsk,
          name: nick,
          /* 【2026-11-10 按会话】同上：子任务按派活会话的功能开关干活 */
          sessionId: sid,
          maxRounds: Number(maxRounds) > 0 ? Number(maxRounds) : 60,
          allowWrite: true,
          pullMails: () => {
            try { const ms = drainWorkerMail(sid, __tid); if (ms && ms.length) __wPush('mail', '收到补话：' + ms.map((m) => m.text).join(' / ').slice(0, 160)); return ms; } catch { return []; }
          },
          onProgress: (line) => {
            try { noteWorkerProgress(sid, __tid, line); } catch {}
            __wPush('step', line);
          },
        });
      } catch (e) {
        r = { ok: false, text: '子智能体没起来：' + String(e?.message ?? e) };
      }

      const text = String(r?.text || '').trim();
      finishWorker(sid, w.id, { status: r?.ok ? 'reported' : 'failed', rounds: r?.rounds, tools: r?.tools, said: text });
      try {
        if (typeof push === 'function') {
          push({ type: 'worker', wid: String(w.id), name: nick, kind: 'end', text: '', status: r?.ok ? 'ok' : 'err', note: text.slice(0, 400) });
        }
      } catch {}

      if (typeof push === 'function') {
        try {
          push({ type: 'whale', who: nick + ' → 主智能体', text: text || '（它没说话）', as: 'whale', tag: 'worker' });
        } catch {}
      }

      if (!r?.ok) {
        return '【' + nick + ' #' + w.id + ' 没干成】它的原话：\n\n' + (text || '（它没说话）')
          + '\n\n（先分清是活没说清还是真做不到。说得清就退回给同一个 worker，别自己上手；也别换个新 worker 从头再来。）';
      }
      return '⚑【这一件干完了 —— 现在就接着往下做：核对结果 → 回主人一句话说清做好了什么，'
        + '要用到的文件当场用 send_file 发出去。别停在这里不说话。】\n\n'
        + '【' + nick + ' #' + w.id + ' 回来了】它的汇报原文（还热着，别急着采信 —— 拿只读工具核一遍再决定收不收）：\n\n' + (text || '（一句汇报都没写 —— 这本身就是问题，退回给它，要它按四行交）')
        + '\n\n（收了就记一条账，没收就退回给同一个 worker。核账的读数别留太细，上下文本该由你管。）';
    },
  },
  {
    name: 'spawn_workers',
    description: '一次派好几件互不依赖的活，让它们**同时**干（不是一个一个排队）。最多 4 件。'
      + '\n\n【什么时候用】几件事之间不需要别人先说、也不抢同一个文件 —— 比如「查 A 文档」「跑 B 测试」「统计 C 行数」。'
      + '\n\n【什么时候别用】后一件要看前一件的结果 —— 那就一次派一件，等它回来再说。'
      + '\n\n【它们同时跑，你也别闲着】等它们的时候可以先 watch_worker 看进度、先 tell_worker 补话。'
      + '\n\n【回来的是一串汇报】按顺序给你，逐件检查，别一律采信。',
    parameters: {
      type: 'object',
      properties: {
        tasks: {
          type: 'array',
          description: '要派出去的活，每件一个对象。1~4 件。',
          items: {
            type: 'object',
            properties: {
              task: { type: 'string', description: '这件活具体干什么' },
              name: { type: 'string', description: '给这个 worker 起个名' },
              accept: { type: 'string', description: '什么算做成了' },
              scope: { type: 'string', description: '在哪儿干' },
              forbid: { type: 'string', description: '不许碰什么' },
            },
            required: ['task'],
          },
        },
        maxRounds: { type: 'number', description: '每个最多跑几轮工具循环，默认 40。' },
      },
      required: ['tasks'],
    },
    async run({ tasks, maxRounds }) {
      const sid = ctxNow().sessionId || 'default';
      const { taskOn } = await import('./task-mode.mjs');
      if (!taskOn(sid)) {
        return 'ERROR：【派活功能正在重做】办事模式已经删掉，团队模式还没上线 —— 现在用不了派活。';
      }
      const list = (Array.isArray(tasks) ? tasks : []).filter((t) => t && String(t.task || '').trim());
      if (!list.length) return 'ERROR：没说要干什么（tasks 是空的）。';
      if (list.length > 4) return '一次最多派 4 件。要更多就先派 4 件，等回来再派。';
      if (list.length === 1) {
        return '只有一件活就不用这个工具了 —— 用 spawn_worker 就行（说明会清楚得多）。';
      }

      /* 【2026-11-03 · 真的同时干】
       * 主智能体的工具调用本身是一条一条等的，所以「同时」只能在工具内部实现：
       * 这里先同步把每个 worker 都登记进花名册（同步 fs，不会交错），
       * 再用 Promise.all 一起放出去。
       *
       * 登记必须先做完再散出去 —— 反过来的话两个 worker 同时 noteWorker
       * 会互相覆盖（读-改-写没有中间 await，在 Node 里是安全的，但一起进去
       * 就有先后问题，宁可先排好队再跑）。 */
      const roundMax = Number(maxRounds) > 0 ? Number(maxRounds) : 40;
      const plans = list.map((t, i) => {
        const nick = String(t.name || '').trim() || ('worker-' + (i + 1));
        const body = String(t.task || '').trim();
        const brief = [
          body,
          '',
          '【这是派给你的活】',
          t.accept ? ('做成什么样算成：' + String(t.accept).trim()) : '',
          t.scope ? ('你只能在 ' + String(t.scope).trim() + ' 这一带活动，别的地方一律不许碰。') : '',
          t.forbid ? ('不许碰：' + String(t.forbid).trim()) : '',
        ].filter(Boolean).join('\n');
        const reportAsk = [
          '',
          '【干完必须交一份汇报】就写这四行，一行一条，别写成文章：',
          '做了什么：改了哪些文件、跑了什么命令',
          '凭什么说成了：证据（输出、退出码、行号、截图路径）',
          '哪儿没做到 / 我没把握的地方',
          '还剩什么没干',
        ].join('\n');
        const w = noteWorker(sid, {
          name: nick,
          task: body.slice(0, 200),
          accept: String(t.accept || '').slice(0, 200),
          status: 'running',
        });
        return { nick, brief: brief + reportAsk, id: String(w.id) };
      });

      const push = ctxNow().pushEvent;
      if (typeof push === 'function') {
        try {
          push({ type: 'note', text: '同时派了 ' + plans.length + ' 件活：' + plans.map((p) => p.nick).join('、') });
        } catch {}
      }

      const one = async (p) => {
        /* 每件活各推各的事件：界面上是几张独立的子任务卡，不是混成一片 */
        const __wPush = (kind, text, extra) => {
          if (typeof push !== 'function') return;
          try { push(Object.assign({ type: 'worker', wid: p.id, name: p.nick, kind, text: String(text || '') }, extra || {})); } catch {}
        };
        try {
          const { runSubagent } = await import('./subagent.mjs');
          __wPush('start', '开始干：' + String(p.brief || '').slice(0, 120));
          const r = await runSubagent({
            task: p.brief,
            name: p.nick,
            /* 【2026-11-10 按会话】同上 */
            sessionId: sid,
            maxRounds: roundMax,
            allowWrite: true,
            pullMails: () => {
              try { const ms = drainWorkerMail(sid, p.id); if (ms && ms.length) __wPush('mail', '收到补话：' + ms.map((m) => m.text).join(' / ').slice(0, 160)); return ms; } catch { return []; }
            },
            onProgress: (line) => {
              try { noteWorkerProgress(sid, p.id, line); } catch {}
              __wPush('step', line);
            },
          });
          const text = String(r?.text || '').trim();
          finishWorker(sid, p.id, { status: r?.ok ? 'reported' : 'failed', rounds: r?.rounds, tools: r?.tools, said: text });
          __wPush('end', '', { status: r?.ok ? 'ok' : 'err', note: text.slice(0, 400) });
          if (typeof push === 'function') {
            try { push({ type: 'whale', who: p.nick + ' → 主智能体', text: text || '（它没说话）', as: 'whale', tag: 'worker' }); } catch {}
          }
          return { nick: p.nick, id: p.id, ok: !!r?.ok, text };
        } catch (e) {
          const msg = '子智能体没起来：' + String(e?.message ?? e);
          finishWorker(sid, p.id, { status: 'failed', said: msg });
          try { if (typeof push === 'function') push({ type: 'worker', wid: p.id, name: p.nick, kind: 'end', text: '', status: 'err', note: msg.slice(0, 400) }); } catch {}
          return { nick: p.nick, id: p.id, ok: false, text: msg };
        }
      };

      const rs = await Promise.all(plans.map(one));
      const okCount = rs.filter((r) => r.ok).length;
      return '【' + plans.length + ' 件活都回来了】' + okCount + ' 件成了、' + (plans.length - okCount) + ' 件没成。'
        + '\n\n' + rs.map((r) => '── ' + r.nick + ' #' + r.id + (r.ok ? '' : '（没干成）') + ' ──\n' + (r.text || '（它没说话）')).join('\n\n')
        + '\n\n（逐件核，别一律采信。哪件没干对就退回给同一个 worker。）';
    },
  },
  {
    name: 'tell_worker',
    description: '给正在干活的 worker 补一句话（改方向、加要求、叫它停手换个做法）。它会在下一个工具循环开头读到。'
      + '\n\n【什么时候用】活派出去之后你才想明白的、或者主人中途改了主意 —— 别等它跑完再说，那已经白干了。'
      + '\n\n【说清楚是「改」还是「加」】「刚才那个方案别用了，换 X」比「注意一下」有用得多。'
      + '\n\n【它可能已经干到一半】补话是「在你原有基础上」追加，不是重来。真要重来就让它停下、退回给它重做。',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'worker 的门牌号（list_workers 里那个 #N）' },
        text: { type: 'string', description: '要跟它说的话。一行说清，别写成一篇。' },
      },
      required: ['id', 'text'],
    },
    async run({ id, text }) {
      const sid = ctxNow().sessionId || 'default';
      const key = String(id || '').trim().replace(/^#/, '');
      const body = String(text || '').trim();
      if (!key) return 'ERROR：没说给哪个 worker（id 是空的）。先用 list_workers 看一眼有谁。';
      if (!body) return '内容是空的。要说什么？';
      const r = sendWorkerMail(sid, key, body);
      if (!r.ok) return 'ERROR：没递进去：' + String(r.error || '不知道什么原因');
      const push = ctxNow().pushEvent;
      if (typeof push === 'function') {
        try { push({ type: 'note', text: '给 #' + key + ' 补了一句：' + body.slice(0, 80) }); } catch {}
      }
      return '【已经递到 #' + key + ' 的信箱】它下一轮开头就能吃到（现在信箱里还有 ' + String(r.queued) + ' 句）。'
        + '\n\n它要是已经快跑完了，这句话可能来不及改变什么 —— 需要的话等它回来再退回给它。';
    },
  },
  {
    name: 'watch_worker',
    description: '看一眼某个 worker 现在干到哪儿了：状态、已经跑了几轮、用了几个工具、最近几步干了什么。',
    parameters: {
      type: 'object',
      properties: { id: { type: 'string', description: 'worker 的门牌号；不填就看全部（同 list_workers）' } },
    },
    async run({ id }) {
      const sid = ctxNow().sessionId || 'default';
      const key = String(id || '').trim().replace(/^#/, '');
      if (!key) {
        const ws = listWorkers(sid);
        if (!ws.length) return '这个会话里还没有 worker。';
        return ws.map((w) => '· #' + w.id + ' ' + w.name + ' [' + w.status + '] 第 ' + w.rounds + ' 轮 / ' + w.tools + ' 个工具').join('\n');
      }
      const d = workerDetail(sid, key);
      if (!d) return 'ERROR：这个会话里没有 #' + key + ' 这个 worker。';
      const lines = [
        '#' + d.id + ' ' + String(d.name || '') + '  [' + String(d.status || '') + ']',
        '派给它的活：' + String(d.task || '').slice(0, 200),
        '跑到：第 ' + String(d.rounds || 0) + ' 轮 / 用了 ' + String(d.tools || 0) + ' 个工具',
      ];
      const pg = Array.isArray(d.progress) ? d.progress.slice(-8) : [];
      if (pg.length) {
        lines.push('最近几步：');
        for (const p of pg) lines.push('  · ' + String(p.line || '').slice(0, 160));
      } else {
        lines.push('（还没记进度）');
      }
      const ml = Array.isArray(d.mails) ? d.mails : [];
      if (ml.length) {
        lines.push('还没吃的话：' + ml.length + ' 句（它下一轮就会读到）');
      }
      if (d.said) lines.push('上次汇报：' + String(d.said).slice(0, 300).replace(/\n/g, ' '));
      return lines.join('\n');
    },
  },
  {
    name: 'list_workers',
    description: '看这个会话里有哪些 worker、各自什么状态、上次汇报了什么。派活档里退回活儿要认准同一个 worker。',
    parameters: { type: 'object', properties: {} },
    async run() {
      const sid = ctxNow().sessionId || 'default';
      const ws = listWorkers(sid);
      if (!ws.length) return '这个会话里还没有 worker。要干活就 spawn_worker 开一个。';
      const line = (w) => '· #' + w.id + ' ' + String(w.name || '') + ' [' + String(w.status || '') + '] ' + String(w.task || '').slice(0, 60)
        + (w.said ? ('\n   上次汇报：' + String(w.said).slice(0, 120).replace(/\n/g, ' ')) : '');
      return '【这个会话的 worker】共 ' + ws.length + ' 个\n' + ws.map(line).join('\n');
    },
  },
  {
    name: 'schedule_task',
    description:
      '给以后定一件事：到点自动往会话里发一句话，让我自己接着干。主人说「明天九点提醒我」「每小时看一次」「过半小时叫我」就用它。when 写法：2026-11-07 09:30 / 09:30 / +30m / +2h。repeat 默认 once；要重复就给 repeat 传 repeat，再配 everyN + everyUnit（m/h/d，不填按每天）。',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '到点要干什么（这句话会原样发给会话里的我）' },
        when: { type: 'string', description: '什么时候：+30m / 09:30 / 2026-11-07 09:30' },
        title: { type: 'string', description: '给它起个短名，可选' },
        repeat: { type: 'string', enum: ['once', 'repeat'], description: '只跑一次还是反复跑' },
        everyN: { type: 'number', description: '每几（配合 everyUnit）' },
        everyUnit: { type: 'string', enum: ['m', 'h', 'd'], description: '单位：分/时/天' },
      },
      required: ['text', 'when'],
    },
    async run(args) {
      const me = String((ctxNow() || CTX).sessionId || '').trim();
      const when = String(args.when || '').trim();
      const text = String(args.text || '').trim();
      if (!text) return 'ERROR：得说到点要干什么（text）。';
      if (!when) return 'ERROR：得说什么时候（when）。比如 09:30、+30m、2026-11-07 09:30。';
      try {
        const t = addTask({
          text,
          title: String(args.title || '').trim() || text.slice(0, 24),
          when,
          repeat: args.repeat || 'once',
          everyN: args.everyN,
          everyUnit: args.everyUnit,
          sessionId: me,
        });
        const whenStr = new Date(t.at).toLocaleString('zh-CN', { hour12: false });
        const rep = t.repeat === 'every'
          ? `，之后每隔 ${t.everyMs / 60000 >= 60 ? (t.everyMs / 3600000) + ' 小时' : (t.everyMs / 60000) + ' 分钟'} 再来一次`
          : '，只来这一次';
        return `定好了。编号 ${t.id}：${whenStr}${rep}。到点我自己开工。`;
      } catch (e) {
        return 'ERROR：没定上 —— ' + (e && e.message ? e.message : e);
      }
    },
  },
  {
    name: 'list_schedules',
    description: '看现在都定了哪些定时任务：编号、什么时候、还开不开、上次跑成没跑成。',
    parameters: { type: 'object', properties: {} },
    async run() {
      let all = [];
      try { all = listTasks(); } catch (e) { return 'ERROR：读不到任务表 —— ' + e.message; }
      if (!all.length) return '现在一条定时任务都没有。要定就用 schedule_task。';
      const lines = all.map((t) => {
        const when = new Date(t.at).toLocaleString('zh-CN', { hour12: false });
        const rep = t.repeat === 'every'
          ? `每 ${t.everyMs / 60000 >= 60 ? (t.everyMs / 3600000) + ' 小时' : (t.everyMs / 60000) + ' 分钟'}`
          : '一次';
        const state = t.enabled ? '开' : '关';
        const last = t.lastRunAt
          ? `${new Date(t.lastRunAt).toLocaleString('zh-CN', { hour12: false })} ${t.lastOk ? '成功' : '失败'}${t.lastNote ? '（' + t.lastNote + '）' : ''}`
          : '还没跑过';
        return `[${t.id}] ${when} · ${rep} · ${state} · ${last} · ${t.title || t.text}`;
      });
      return `一共 ${all.length} 条：\n` + lines.join('\n');
    },
  },
  {
    name: 'cancel_schedule',
    description: '撤掉一条定时任务。不传 id 就是把所有任务列出来给看，不动手。',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '要撤的任务编号（list_schedules 里看到的那个）' },
        all: { type: 'boolean', description: '传 true 就全撤了，慎用' },
      },
    },
    async run({ id, all }) {
      try {
        if (all) {
          const list = listTasks();
          if (!list.length) return '本来就没有任务，不用撤。';
          for (const t of list) removeTask(t.id);
          return `全撤了，共 ${list.length} 条。`;
        }
        const key = String(id || '').trim();
        if (!key) {
          const list = listTasks();
          if (!list.length) return '现在没有任务。要指定撤哪条，先告诉我是哪个编号。';
          return '要撤哪条？现在的任务是：\n' + list.map((t) => `[${t.id}] ${t.title || t.text}`).join('\n');
        }
        removeTask(key);
        return `撤掉了 ${key}。`;
      } catch (e) {
        return 'ERROR：没撤成 —— ' + (e && e.message ? e.message : e);
      }
    },
  },
];

/** Very small HTML -> text reducer (good enough for reading articles / docs). */
function htmlToText(html) {
  return String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<\/(p|div|li|tr|h[1-6]|br)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export const toolSchemas = tools.map((t) => ({
  type: 'function',
  function: { name: t.name, description: t.description, parameters: t.parameters },
}));

/** 只把【功能】面板里开着的工具交出去。关掉的功能，模型连看都看不到。 */
export function enabledToolSchemas(sessionId = '') {
  /* 【2026-11-10 按会话】给了 sessionId 就只交这个会话开着的工具 ——
   * 主人在 A 会话关掉的工具，在 A 的请求里连 schema 都不出现。 */
  const on = new Set(enabledToolNames(sessionId));
  return toolSchemas.filter((t) => on.has(t.function.name));
}

/**
 * 启动自检：每个工具都得有中文 description 和中文参数说明。
 *
 * 为什么要查：工具清单是**从 schema 自动生成**塞进系统提示的（见 persona.mjs 的 toolBlock）。
 * 哪天加了新工具忘了写中文 description，模型就会拿着一行英文去判断该不该用 —— 等于白给。
 * 这里只在启动时 console.warn，不抛错、不影响服务起来。
 */
export function checkToolDocs() {
  const problems = [];
  const hasCjk = (s) => /[\u4e00-\u9fff]/.test(String(s ?? ''));
  for (const t of tools) {
    if (!hasCjk(t.description)) problems.push(`${t.name}: description 没有中文`);
    const props = (t.parameters && t.parameters.properties) || {};
    for (const [key, spec] of Object.entries(props)) {
      if (spec && spec.description && !hasCjk(spec.description)) {
        problems.push(`${t.name}.${key}: 参数说明没有中文`);
      }
    }
  }
  return problems;
}

/* ══ 工具输出「出门闸门」（2026-11-05）═════════════════════════════════════
 * 为什么要有这一层：
 *   实测工具结果占了上下文的 53%~62%，是最大的一口井。原来的做法是
 *   先整段塞进上下文、等超了再折 —— 等于把 20 吨货装上船再卸。
 *   这里改成出门就量：超了就落盘，只给模型「头 + 尾 + 路径」。
 *
 * 为什么不删：
 *   主人铁律「清单内容只可增加，严禁删除」。工具输出同理 ——
 *   模型看不全可以再 read_file 去要，但原文必须还在磁盘上。
 *
 * 为什么分档：
 *   run_command 的报错原文在尾巴，砍尾巴等于砍掉唯一有用的信息；
 *   read_file 本来就该模型自己用 offset/limit 分页，阈值放宽；
 *   list_dir 这类截了也无所谓。
 */
const TOOL_OUT_MAX = 8000;
const TOOL_OUT_READFILE = 20000;
const TOOL_OUT_HEAD = 1200;
const TOOL_OUT_TAIL = 900;
const TOOL_OUT_KEEP = 200;

function toolOutDir(sessionId) {
  const sid = String(sessionId || 'default').replace(/[^\w.-]/g, '_');
  return join(config.dataDir, '.state', 'tool-out', sid);
}

/** 把整份输出落盘，返回路径（存不了返回空串 —— 截断照样要做）。 */
async function saveToolOut(sessionId, name, text) {
  try {
    const dir = toolOutDir(sessionId);
    await mkdir(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const safe = String(name || 'tool').replace(/[^\w.-]/g, '_');
    const file = join(dir, stamp + '-' + safe + '.txt');
    await writeFile(file, text, 'utf8');
    // 每个会话只留最近 TOOL_OUT_KEEP 份：原文不必无限堆，但也不是当场就删
    try {
      const names = (await readdir(dir)).filter((n) => n.endsWith('.txt')).sort();
      const over = names.length - TOOL_OUT_KEEP;
      if (over > 0) {
        const { unlink } = await import('node:fs/promises');
        for (const n of names.slice(0, over)) {
          await unlink(join(dir, n)).catch(() => {});
        }
      }
    } catch {}
    return file;
  } catch {
    return '';
  }
}

/** 出门闸门本体：超阈值就截成「头 + 尾 + 落盘路径」。 */
async function clipToolResult(name, r, sessionId) {
  const out = r && r.output;
  if (typeof out !== 'string') return r;
  const cap = name === 'read_file' ? TOOL_OUT_READFILE : TOOL_OUT_MAX;
  if (out.length <= cap) return r;
  const saved = await saveToolOut(sessionId, name, out);
  const head = out.slice(0, TOOL_OUT_HEAD);
  const tail = out.slice(-TOOL_OUT_TAIL);
  const cut = out.length - head.length - tail.length;
  const where = saved ? ('原文整份存在：' + saved) : '原文没能存盘（目录不可写）';
  const note = [
    '',
    '…（中间省略 ' + cut + ' 字）…',
    '',
    tail,
    '',
    '【工具输出太长，已截断】这次 ' + name + ' 一共返回 ' + out.length + ' 字，超过 ' + cap + ' 字的闸门。',
    where,
    '要看被省略的部分：用 read_file 带 offset/limit 分段读上面那个文件，别一次全读（不然还会超）。',
  ].join('\n');
  return Object.assign({}, r, { output: head + note });
}

/**
 * 【2026-11-05 加·第 4 个参数：这一趟用什么信号】
 *
 * 原来工具只能拿到全局/ALS 里那个 signal（整轮的）。可「单个工具超时」需要
 * 掐掉的**只有这一个工具**，不能连累整轮 —— 所以 agent 那边会给每个工具建一个
 * 自己的 AbortController，通过这里塞进去。
 *
 * 实现上借 runWithToolContext：它会把 override 合并进当前链路那份上下文，
 * ctxNow() 读到的就是新信号，**不碰全局 CTX**，并发会话也不会串。
 */
export async function runTool(name, rawArgs, sessionId, overrideSignal) {
  const run = async () => {
    const r = await runToolInner(name, rawArgs, sessionId);
    return await clipToolResult(name, r, sessionId);
  };
  // 【2026-11-08 严检补】sessionId 可能是空的（会话外跑、启动自检）。空的时候别往 ctx 里塞
  // 一个 undefined —— runWithToolContext 里是 { ...CTX, ...ctx }，塞进去会把全局那份好值盖成空。
  // 有值才传，没值就让它按老规矩退回全局 CTX。
  // 【2026-11-08 根治】光是 overrideSignal 有值才进隔离，是不够的：
  // 没传 signal（比如子智能体那条路）时下面直接 run()，sessionId 跟着白传，
  // 工具里 ctxNow() 退回全局 CTX —— 清单就写到「最后开跑的那个会话」头上去了。
  // 现在只要有 sessionId 就进隔离，signal 有就带上。
  if (overrideSignal || sessionId) {
    const _ctx = {};
    if (overrideSignal) _ctx.signal = overrideSignal;
    if (sessionId) _ctx.sessionId = sessionId;
    if (Object.keys(_ctx).length) return runWithToolContext(_ctx, run);
  }
  return run();
}

async function runToolInner(name, rawArgs, sessionId) {
  const tool = tools.find((t) => t.name === name);
  if (!tool) return { ok: false, output: `unknown tool: ${name}` };
  if (!isToolEnabled(name, sessionId)) {
    const feat = featureNameOfTool(name) || name;
    return { ok: false, output: `「${feat}」现在是关着的，用不了这个工具。要用的话先在顶部【功能】里打开。` };
  }
  /**
   * 长期记忆关着的时候 —— **只读，不写。**
   *
   * 主人原话（2026-10-28）：「改成关掉长期记忆功能后，只能看记忆本，也就是只允许只读，不能写」
   *
   * 三处闸，缺一不可：
   *   ① 本模块 memoryText()     → 返回空串（不注入，连路径都不给提示）
   *   ② 这里 memory_add/pin     → 只读模式下这两个工具根本不在手上，
   *                               硬编一个 tool_call 出来也要当场拦下
   *   ③ stateBlocked + safePath → 记忆本文件只读：read_file/list_dir 放行，其余拒绝
   *                               连 run_command 一行 Set-Content 都挡得住
   *
   * 【为什么不干脆把工具拿走就完事】
   * 拿走的是「模型看得见的工具清单」，不是执行权。模型完全可以凭记忆硬写一个
   * tool_call 出来 —— 第 ②③ 道闸就是挡这个的。
   *
   * 【为什么读要放行】
   * 关掉之后她连自己记过什么都翻不了，那就不是「关掉记忆功能」，
   * 是「假装没记过」。主人要的是前者。
   */
  const memoryReadOnlyHint = '长期记忆现在是关着的（只读）：记忆本能看，但不能往里写。要记就先在顶部【功能】里把长期记忆打开。';
  if (['memory_add', 'memory_pin'].includes(name) && featureOnFor(sessionId, 'memory') === false) {
    return { ok: false, output: memoryReadOnlyHint };
  }
  /**
   * run_command 这条明路单独兜一下。
   *
   * 它没有路径参数，压根不走 safePath —— 前面几道闸一个都碰不上。
   * 2026-10-28 真跑实测：`Set-Content -LiteralPath '...\my-memory.md'` 能把整本盖掉。
   * 这条闸只能看命令里提没提到那几个文件名，粗，但够用：
   * 关着的时候她本来就不该在工作区里跟记忆本打交道。
   */
  if (name === 'run_command') {
    const cmd = (() => {
      try {
        return String((typeof rawArgs === 'string' ? JSON.parse(rawArgs) : rawArgs)?.command ?? '');
      } catch {
        return String(rawArgs ?? '');
      }
    })();
    if (commandTouchesMemory(cmd)) {
      return { ok: false, output: BLOCKED_HINT };
    }
  }
  let args = {};
  try {
    args = typeof rawArgs === 'string' && rawArgs.trim() ? JSON.parse(rawArgs) : rawArgs ?? {};
  } catch {
    return { ok: false, output: `invalid JSON arguments for ${name}` };
  }
  // 写类工具动手前先留个底，回退时靠它把文件还原回去。
  /* 【2026-10-30】原来是 CTX.snap（模块模板，永远空），回退快照可能一直没留上。改成本轮上下文。 */
  const _snapNow = (() => { try { return ctxNow()?.snap; } catch { return null; } })();
  if (name === 'write_file' && _snapNow) {
    try {
      snapshotBeforeWrite(_snapNow, args?.path);
    } catch {}
  }
  try {
    /* 【2026-10-30】以前传的是模块顶层那个 CTX 模板，里面 pushEvent/outbox 永远是空的 ——
     * 所以 send_file 当场推、ask_subagent 那句「我刚派了什么活」全都推不出去。
     * 现在传本轮真正的上下文。 */
    const r = await tool.run(args, ctxNow());
    /**
     * 【2026-11-05 修·失败被当成成功】
     *
     * 以前只有**抛异常**才算失败，`return { ok: true }` 是无条件的。
     * 可大量工具是用「返回一句话」表示失败的：run_command 的退出码、
     * memory_add 的「没记上」、被安全闸拦下的命令……
     * 界面上是绿色 ✓，模型收到的也没有 ERROR 前缀 —— 于是它把「没记上」
     * 当成「记上了」，把跑挂的测试当成通过，接着往下编。
     *
     * 现在约定：工具可以自己返回 { ok:false, output }，这里原样透传。
     * 已经按这个约定改的：run_command。其余工具逐个来，不一次性动几十处。
     *
     * 【2026-11-10 补·对象里只有 text 没有 output 的情况】
     *
     * 上面只认 `'output' in r`。而 `src/tools-ui.mjs` 的返回是 `{ text: '…' }` ——
     * 没有 output 字段，于是这一支不进，落到下面去重判。
     * 更坑的是：如果有人照着"加个 ok:false"改成 `{ text, ok:false, output:'…' }`，
     * 反而会**把 text 丢给界面、output 丢给模型** —— 两边看到的不一样。
     * 所以这里统一收口：对象里有 text 就当 output 用。
     */
    if (r && typeof r === 'object' && !Array.isArray(r) && r.ok === false) {
      const _out = ('output' in r) ? r.output : (r.text != null ? r.text : '');
      return { ok: false, output: String(_out ?? '') };
    }
    /**
     * 【2026-11-05 加·统一失败约定】
     *
     * 工具用 `ERROR：` 开头表示"这件事没办成"。以前只有**抛异常**才算失败，
     * 于是这些全被当成成功：restart_self 找不到重启入口、ask_peer 话递不出去、
     * spawn_worker 不是办事模式、folded_list 不知道是哪个会话、
     * tell_worker 没给 key…… 界面上一片绿 ✓，模型以为办好了，接着往下编。
     *
     * 为什么用前缀而不是给每个工具改返回结构：
     *   · 逐个改要动 16 处 return，其中还有跨行拼接的，改一处错一处；
     *   · 前缀是**看得见**的约定 —— 下次新加工具，写 `ERROR：` 就自动算失败。
     * 代价是：真要有工具想返回一句以 "ERROR：" 开头的正常结果，会被误判 —— 可这基本不会发生。
     */
    /**
     * 【2026-11-10 修·对象型返回的三连坑，一次收掉】
     *
     * `src/tools-ui.mjs` 的 13 处是 `return { text: '…' }`（对象，不是字符串）。
     * 下面那行判定写的是 `typeof r === 'string'`，对象直接被挡在门外，于是三件事同时发生：
     *
     *   ① 失败被当成成功：`{text:'✗ 还没观察过界面…'}` → ok:true → 界面一片绿 ✓
     *   ② 界面显示 `[object Object]`：对象一路传到 server.mjs:2254 / items.js:164 的
     *      `String(t.output || '')` —— 主人展开工具抽屉想核对"她点了哪个元素"，
     *      看到的是一坨 `[object Object]`，操作记录完全不可读。
     *      （模型那边反而是好的：agent.mjs:1881 有 `String(output.text ?? JSON.stringify)` 兜底。
     *       所以是"只有人看不见，她自己看得见"。）
     *   ③ 绕过截断闸门：clipToolResult:2613 也有同一句 `typeof out !== 'string'` return，
     *      对象整段不截，ui_observe 上千字直接怼进上下文。
     *
     * 修法：判之前先把 `r.text` 提出来看。**不能只在下面那个 if 上加 `✗`** ——
     * 对象根本进不去那个分支，加了也白加（实测过 `{text, ok:false}` 仍判成功）。
     *
     * ⚠️ 边界：`tools-screen.mjs` / `tools-video.mjs` 返回的 `{text, images:[…]}` 必须保住 ——
     * agent.mjs:1870 靠 `output.images` 把图拼进多模态 content。
     * 所以这里只做"判定"，不改 `output` 的形状（output 仍是原对象）。
     */
    const _failText = (r && typeof r === 'object' && r.text != null) ? String(r.text) : r;
    if (typeof _failText === 'string' && /^\s*(ERROR[：:]|✗)/.test(_failText)) {
      /* 对象形态的失败要把 text 提到 output 上，否则界面还是 [object Object] */
      return { ok: false, output: (r && typeof r === 'object' && r.text != null) ? String(r.text) : r };
    }
    if (typeof r === 'string' && /^\s*ERROR[：:]/.test(r)) {
      return { ok: false, output: r };
    }
    return { ok: true, output: r };
  } catch (err) {
    return { ok: false, output: String(err?.message ?? err) };
  }
}
