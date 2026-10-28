// Built-in tools. Each tool: { name, description, parameters(JSON Schema), run(args) }
import { readFile, writeFile, readdir, mkdir, stat } from 'node:fs/promises';
import { AsyncLocalStorage } from 'node:async_hooks';
import { appendFileSync } from 'node:fs';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { exec, execFile } from 'node:child_process';
import { resolve, dirname, isAbsolute, relative, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.mjs';
import { planAction, noteAction } from './plan.mjs';
import { isToolEnabled, getEnabledMap, featureNameOfTool, enabledToolNames } from './features.mjs';
import { snapshotBeforeWrite } from './rewind.mjs';
import { webSearch, formatResults } from './search.mjs';
import { sendFileTool } from './tools-sendfile.mjs';
import { sayTool } from './tools-say.mjs';
import { browserTools } from './tools-browser.mjs';
import { videoTools } from './tools-video.mjs';
import { postMail, peekMail, takeMail, mailCount, formatMail } from './peer.mjs';
import { listSessions, getLastSessionId } from './sessions-core.mjs';

const LIMIT = 20000;

const ROOT = resolve(config.workspace);
/** 程序自己的安装目录（src 的上一级），scripts/ 和 dump/ 都在这下面 */
const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Per-run context (which session is talking) so plan/note land in the right board. */
/** 专业模式下不该出现的工具（见 runTool 里那道闸）。 */
const FOREIGN_IN_PURE = ['memory_add', 'memory_pin'];

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
 * 让一段异步逻辑跑在「这一轮自己的上下文」里。
 *
 * server 侧那一轮开跑的地方这样用：
 *   await runWithToolContext({ sessionId, snap, signal }, () => runAgent(...))
 * 这笔活儿里所有工具调用就只认自己的 sessionId / snap / signal。
 */
export function runWithToolContext(ctx, fn) {
  return CTX_STORE.run(ctx, fn);
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
   * 这一次是不是「小鲸在场」那个调用。
   * true 时 safePath 不限工作区（主人给了她全权）。
   * 默认 false：我自己跑的时候照旧只能在工作区里。
   */
  fullAccess: false,
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
  return CTX.sessionId || 'default';
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
  CTX.outbox = [];
  return CTX.outbox;
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
    if (getEnabledMap()['memory'] !== false) return false; // 开着：随便
    return stateBlocked(abs);
  } catch { return false; }
}

function safePath(p, { tool = '' } = {}) {
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
  // 她那一次：全盘放开
  if (CTX.fullAccess === true) return abs;
  const rel = relative(ROOT, abs);
  if (rel.startsWith('..') || isAbsolute(rel)) {
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
const READ_ONLY_TOOLS = new Set(['read_file', 'list_dir']);

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
    if (getEnabledMap()['memory'] !== false) return false; // 开着：随便
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

function clip(s) {
  return s.length > LIMIT ? `${s.slice(0, LIMIT)}\n...[truncated ${s.length - LIMIT} chars]` : s;
}

export const tools = [
  {
    name: 'read_file',
    description:
      '读一个文本文件的内容。工作区里的相对路径，或主人机器上的绝对路径都行（带中文、空格也没问题）。大文件会截断。',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string', description: '工作区里的相对路径' } },
      required: ['path'],
    },
    async run({ path }) {
      return clip(await readFile(safePath(path, { tool: 'read_file' }), 'utf8'));
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
    name: 'run_command',
    description:
      '在本机跑一条命令（Windows 上是 PowerShell，工作区当前目录）。装依赖、跑脚本、压包、转格式、调 ffmpeg、查环境全都靠它。返回 stdout 和 stderr 合并的结果。',
    parameters: {
      type: 'object',
      properties: { command: { type: 'string' } },
      required: ['command'],
    },
    run({ command }) {
      // 按「这条异步链路自己的上下文」取 signal，不碰全局那份。
      // 用全局的那份会被别的会话顶掉，害得这条命令跟着别人一起被掐。
      const signal = (ctxNow() || CTX).signal;
      return new Promise((done) => {
        const child = exec(
          command,
          { cwd: ROOT, timeout: 120000, maxBuffer: 4 * 1024 * 1024, shell: process.platform === 'win32' ? 'powershell.exe' : '/bin/sh' },
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
            else if (err && !stdout && !stderr) parts.push(`exit ${err.code}: ${err.message}`);
            done(clip(parts.join('\n').trim() || '(no output)'));
          },
        );
        // 主人点停止 / 点退出：立刻把子进程砍掉，别让整轮卡在一个跑不完的命令上。
        let aborted = false;
        let onAbort = null;
        if (signal && typeof signal.addEventListener === 'function') {
          if (signal.aborted) {
            aborted = true;
            try { child.kill('SIGTERM'); } catch {}
          } else {
            onAbort = () => {
              aborted = true;
              try { child.kill('SIGTERM'); } catch {}
              // PowerShell 有时候不吃 SIGTERM，2 秒后补一刀
              setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 2000);
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
      '重启前会等最多几秒把这一轮的话落盘。用完就别再指望这一轮还能继续跑工具了。',
    parameters: {
      type: 'object',
      properties: {
        reason: { type: 'string', description: '为什么要重启（写给自己以后看，主人也会看到）' },
      },
      required: [],
    },
    async run({ reason = '' } = {}) {
      /**
       * 为什么走 HTTP 调自己，而不是 process.exit(75)：
       * 这一条命令可能正跑在「几秒后要给主人回话」的中间，
       * 直接把自己的进程干掉，那条回话就没了、草稿也落不干净。
       * 走接口让 server 那边按它的规矩收尾（先回执、再退），稳当。
       *
       * 端口从环境变量拿，拿不到就用常见默认；再不行把几个端口都试一遍。
       */
      const tryPorts = () => {
        const out = [];
        const p = Number(process.env.PORT || process.env.XIAOYU_PORT || 0);
        if (p) out.push(p);
        for (const c of [8788, 8787, 8790, 8791]) if (!out.includes(c)) out.push(c);
        return out;
      };

      for (const port of tryPorts()) {
        try {
          const r = await fetch('http://127.0.0.1:' + port + '/api/app/restart', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ reason: String(reason || '') }),
          });
          const j = await r.json().catch(() => null);
          if (r.ok && j && j.ok) {
            return '好，正在重启（' + (reason ? '原因：' + reason : '没写原因') + '）。过几秒窗口会重新立起来。';
          }
          if (r.status === 501) {
            return '这次不行：' + (j && j.error ? j.error : '这个窗口不是从桌面图标打开的，没法自己重启') +
              '。要从桌面图标打开的那个程序里点才行。';
          }
        } catch {
          // 这个端口不通，换下一个
        }
      }
      return '没找到能重启的入口（端口都没连上）。可能要主人手动关掉再开一次。';
    },
  },
  {
    name: 'plan',
    description:
      '维护这次任务的分步清单：多步的活儿开工前先列出 3~8 步，做一步勾一步，随时能读回来。别没计划就开干。',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['create', 'update', 'add', 'view', 'clear'],
          description:
      '维护这次任务的分步清单：create 新建，update 改某一步的状态，add 追加一步，view 看当前清单，clear 清空。长任务先用它把步骤列出来，别做到一半忘了。',
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
      },
      required: ['action'],
    },
    async run(args) {
      // 清单按会话分：必须走这一轮自己的上下文（ctxNow），不能认全局 CTX ——
      // 两个会话同时跑的时候，全局那份早就被后开跑的顶掉了，清单会写进别人的单子。
      const me = (ctxNow() || CTX).sessionId || 'default';
      return planAction(me, args).text;
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
      // 便签跟清单存在同一块板子上，一样按会话分
      const me = (ctxNow() || CTX).sessionId || 'default';
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
      const me = CTX.sessionId || 'default';
      if (!to) return '要告诉我是哪个会话（to）。先用 list_peers 看一眼有哪些。';
      if (String(to) === String(me)) return '那是你自己（' + me + '），别给自己发。';
      const title = (() => {
        try {
          const s = listSessions().find((x) => x.id === me);
          return s ? s.title : '';
        } catch {
          return '';
        }
      })();
      const r = postMail({ from: me, to: String(to), text, fromTitle: title });
      if (!r.ok) return '没送出去：' + r.error;
      const head = '话已经放进「' + to + '」的信箱了。';
      if (!wake) {
        return head + '她下次说话时会看到（不打断她现在手上的活）。';
      }
      // 叫醒：让 server 那边替她开一轮。只有明确要求才做，因为要花钱。
      const hook = CTX.wakePeer;
      if (typeof hook !== 'function') return head + '（这个环境下没法叫醒她，她下次说话时会看到）';
      try {
        const out = await hook(String(to));
        return head + (out && out.ok ? '已经叫醒她，她这就去看。' : '叫醒没成功：' + ((out && (out.note || out.error)) || '未知原因'));
      } catch (e) {
        return head + '叫醒没成功：' + String(e?.message ?? e);
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
      const me = CTX.sessionId || 'default';
      let list = [];
      try {
        list = listSessions();
      } catch (e) {
        return '列不出来：' + String(e?.message ?? e);
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
      const lines = others.map((s) => {
        const cnt = (() => {
          try {
            return mailCount(s.id);
          } catch {
            return 0;
          }
        })();
        const when = s.updatedAt ? new Date(s.updatedAt).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '';
        return '- ' + s.id + '  「' + (s.title || '没名字') + '」  ' + (s.turns || 0) + ' 轮  ' + when + (cnt ? '  （她信箱里有 ' + cnt + ' 封没看的）' : '');
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
      const me = CTX.sessionId || 'default';
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
        headers: { 'User-Agent': 'Mozilla/5.0 (小鱼Agent)' },
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
      if (!converterReady()) return '转简库没装上（缺 opencc-js），先别急着转，跟我说一声。';
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
      if (!src.trim()) return '没东西可转，把 text 或 path 给我一个。';
      const out = toSimplified(src, { from });
      return out === src ? `本来就是简体，一字没动：\n${out}` : out;
    },
  },
  sayTool,
  sendFileTool,
  ...browserTools,
  ...videoTools,
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
        const arch = r.archived > 0 ? `，${r.archived} 条旧记录已归档` : '';
        return `记下了（${r.id}，现在共 ${r.count}/${r.limit} 条${arch}）。`;
      } catch (e) {
        return '没记上：' + String(e?.message ?? e);
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
        return `钉住了（${r.section}）。这条不会被淘汰。`;
      } catch (e) {
        return '没钉上：' + String(e?.message ?? e);
      }
    },
  },
  {
    name: 'ask_subagent',
    description:
      '叫一个子智能体（叫「小鲸」）去替你查事情。它自己会翻文件、看目录、搜网页、抓网页，查完把结论交回来。适合：要读一堆文件才能答的问题、要上网翻好几页才能确认的事。它拿到的历史和你完全分开，所以不占你的上下文。默认只有查的权限，动不了主人的东西；要它动手得显式给 allowWrite。'
      + '\n\n【主人点名要她查的时候必须用这个】主人说「让小鲸去查」「叫小鲸看看」这种话，就走这个工具，别自己查完了再替她复述 —— 她得有自己的本子、自己的一份。'
      + '你自己叫她说两句（不经过这个工具）时她是空手的、只带嘴，抱怨「没工具」是误会，别理也别替她解释。',
    parameters: {
      type: 'object',
      properties: {
        task: { type: 'string', description: '要它查什么，说具体点：查哪个文件、确认什么事、回答哪个疑问' },
        name: { type: 'string', description: '给它起个名，不填就叫「小鲸」' },
        allowWrite: { type: 'boolean', description: '要不要给它写文件 / 跑命令的权限。默认不给，只查。' },
        maxRounds: { type: 'number', description: '最多让它跑几轮工具循环，默认 12' },
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
        const sid = CTX.sessionId || 'default';
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
        const push = CTX.pushEvent;
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
          pushWhaleSays(CTX.sessionId || 'default', r.text, displayName, sayMeta);
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
        return '岁月史书翻不开：' + String(e?.message ?? e);
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
        return '岁月史书搜不动：' + String(e?.message ?? e);
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
        return '岁月史书读不动：' + String(e?.message ?? e);
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
export function enabledToolSchemas() {
  const on = new Set(enabledToolNames());
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

export async function runTool(name, rawArgs) {
  const tool = tools.find((t) => t.name === name);
  if (!tool) return { ok: false, output: `unknown tool: ${name}` };
  if (!isToolEnabled(name)) {
    const feat = featureNameOfTool(name) || name;
    return { ok: false, output: `「${feat}」现在是关着的，用不了这个工具。要用的话先在顶部【功能】里打开。` };
  }
  /**
   * 专业模式下的记忆笔：一律拦下。
   *
   * 专业模式不读记忆（它连人设都不带），那就不能让人往里写 ——
   * 只写不读等于黑洞：记进去的东西下一轮自己看不见，攒满 80 条还自动归档。
   * 这一道是防模型凭记忆硬写一个 tool_call 出来。
   */
  if (FOREIGN_IN_PURE.includes(name) && (await import('./pure.mjs')).pureModeOn()) {
    return { ok: false, output: '专业模式下不读也不记记忆，这个工具暂时收起来了。要用就先把专业模式关掉。' };
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
  if (['memory_add', 'memory_pin'].includes(name) && getEnabledMap()['memory'] === false) {
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
  if (name === 'write_file' && CTX.snap) {
    try {
      snapshotBeforeWrite(CTX.snap, args?.path);
    } catch {}
  }
  try {
    return { ok: true, output: await tool.run(args, CTX) };
  } catch (err) {
    return { ok: false, output: String(err?.message ?? err) };
  }
}
