/**
 * 【2026-11-18 主人问·工作区为什么不分会话】
 *
 * 原话：「工作区不应该是按会话分的吗？为什么所有工作区都在同一个文件夹下？」
 *
 * 查下来是真的：`config.workspace` 是个**全局常量**，所有会话共用一份。
 * 打包版 = `<数据目录>/workspace`，开发版 = 进程 cwd（也就是仓库根）。
 * 于是主人的真实数据目录里躺着 255 个文件：`_pw.mjs`、`_lw.out`、`patch/`、
 * `sandbox/`… 全是不同会话、不同时期留下的临时脚本，谁也分不清哪条是哪条。
 *
 * 现在：**每个会话一个自己的子目录**，默认就是它的工作区。
 *
 * 【为什么要留「共享区」】
 * 换掉工作区最大的风险不是技术，是**旧文件突然「不见了」**：
 *   · 老会话里她引用的 `dump/logs/x.out`、主人自己放进来的素材，都还在根目录；
 *   · 直接切过去，`read_file('dump/logs/x.out')` 立刻变成 path outside workspace，
 *     她会说「文件没了」—— 其实没丢，只是被关在门外了。
 *
 * 所以：**根目录保留为共享区，读写都放行**，只是「相对路径」默认落到会话自己的目录。
 * 这样老文件一个都访问不到不了的情况不会发生，新活也不会再往根上堆。
 *
 * 【为什么不迁移】
 * 255 个文件里大部分是 `_pw*.mjs` 这种一次性脚本，看不出归属。硬迁等于瞎猜，
 * 迁错了主人的素材就跑到别的会话里去了。宁可让它留在共享区，主人自己认领。
 *
 * 【关掉】
 * 设环境变量 `WORKSPACE_PER_SESSION=0` 就退回老行为（全局一份），
 * 出问题能立刻退回去，不用改代码。
 */
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { AsyncLocalStorage } from 'node:async_hooks';
import { config } from './config.mjs';

/**
 * 【2026-11-18】「现在这条异步链路在替哪个会话干活」。
 *
 * 为什么不能只靠一个模块级变量：主人在 A 会话发消息、同时 B 会话还在跑，
 * 两个工具调用交错执行 —— 单变量会被后一个冲掉，A 的活写到 B 的目录里。
 * AsyncLocalStorage 是 Node 给这种场景准备的：一次 run() 里面整条异步链路
 * 都读得到同一个值，互不串。
 *
 * 由 tools.mjs 的 setToolContext / runWithContext 负责往里塞。
 */
const SID_STORE = new AsyncLocalStorage();

/** 在「这个会话」的上下文里跑一段（并发安全） */
export function runInSession(sessionId, fn) {
  return SID_STORE.run(String(sessionId ?? ''), fn);
}

/** 当前异步链路在替哪个会话干活（拿不到就空串） */
export function currentSessionId() {
  try { return String(SID_STORE.getStore() ?? ''); } catch { return ''; }
}

/** 会话 id 只许这几个字符，防止 `../..` 这种把目录跳出去 */
const SID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** 这个开关关了就退回「全局一份」 */
export function perSessionOn() {
  const v = String(process.env.WORKSPACE_PER_SESSION ?? '').trim().toLowerCase();
  if (!v) return true;                 // 默认开
  return !(v === '0' || v === 'false' || v === 'off' || v === 'no');
}

/** 共享区（老行为那个目录）：所有会话都能读写，旧文件都在这儿 */
export function sharedWorkspace() {
  return resolve(config.workspace || process.cwd());
}

/**
 * 某个会话自己的工作区。目录不存在就建出来（懒创建）。
 *
 * 兜底：拿不到合法会话 id、或者开关关了 → 返回共享区。
 * 宁可退回老行为，也不要因为一个坏 id 让她整轮都写不了文件。
 *
 * @param {string} sessionId
 * @returns {string} 绝对路径
 */
export function workspaceFor(sessionId) {
  const base = sharedWorkspace();
  if (!perSessionOn()) return base;
  const sid = String(sessionId ?? '').trim();
  if (!SID_RE.test(sid)) return base;
  const dir = join(base, 'sessions', sid);
  try { mkdirSync(dir, { recursive: true }); } catch { /* 建不出来就用共享区，别卡死这一轮 */ return base; }
  return dir;
}

/** 所有会话目录的父目录（`<共享区>/sessions`）—— 用来判断「这是别人的工作区」 */
export function sessionsRoot() {
  return join(sharedWorkspace(), 'sessions');
}
