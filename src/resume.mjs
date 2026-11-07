/**
 * 崩溃 / 重启后续跑。
 *
 * 【要解决什么】
 * 进程兜底（crash-guard.mjs）救不回来的时候会 process.exit(1)，整个程序消失。
 * 那时候正在跑的那一轮，草稿是落了盘，可「她要继续把这件事做完」这个意图没人记得 ——
 * 主人回来只看到半截话，得自己再打一句「接着做」。
 *
 * 这里做两件事：
 *   1. 临死前把「谁被打断了、断在哪个任务上」写进 .state/resume.json（markInterrupted）
 *   2. 下次启动读出来，把那一轮自动起回来（由 server 逐条起）
 *
 * 【2026-11-07 重写：一个文件存多条，一个会话一条】
 *
 * 主人报：「一个会话自动重启续跑了，另一个正在运行的会话就停了没跟着续跑」。
 *
 * 老结构只有一个坑位：resume.json 就是一个对象、只有一个 sessionId。
 * 两个会话都在跑时，后写的把先写的覆盖掉 —— 重启后只可能续一个，
 * 另一个就这么无声无息停了。退出那段逻辑更直接：找到第一个有活的会话就 break，
 * 压根没打算记第二个。
 *
 * 现在文件长这样（v2）：
 *   { "v": 2, "items": [ {sessionId, at, ...}, {sessionId, at, ...} ] }
 * 老的 v1（顶层直接就是一条）照样能读，下次写入时自动升级成 v2。
 *
 * 【为什么要单独一个文件】
 * 只在「要死了」这条极窄的路径上用，不能反过来把正常的对话拖下水：
 * 所有写盘都 try/catch 吞掉，读不出来就当没有。
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { config } from './config.mjs';

const DIR = join(config.dataDir, '.state');
const FILE = join(DIR, 'resume.json');

/** 续跑意图最多认多久：超过这个时间的就别再自动跑了（主人早换话题了） */
const MAX_AGE_MS = 24 * 60 * 60 * 1000;

function alive(item) {
  if (!item || typeof item !== 'object' || !item.sessionId) return false;
  const age = Date.now() - Number(item.at || 0);
  return Number.isFinite(age) && age <= MAX_AGE_MS;
}

/** 盘上内容读成数组（兼容 v1 单条），顺手滤掉过期的 */
function readAll() {
  try {
    if (!existsSync(FILE)) return [];
    const j = JSON.parse(readFileSync(FILE, 'utf8'));
    if (!j || typeof j !== 'object') return [];
    const raw = Array.isArray(j.items) ? j.items : (j.sessionId ? [j] : []);
    return raw.filter(alive);
  } catch {
    return [];
  }
}

function writeAll(items) {
  try {
    if (!existsSync(DIR)) mkdirSync(DIR, { recursive: true });
    writeFileSync(FILE, JSON.stringify({ v: 2, items }, null, 2), 'utf8');
    return true;
  } catch {
    return false;
  }
}

/**
 * 白名单：没列进来的字段一律读不到。
 * 这个坑踩了两次了（goal/decisions 一次，intent 一次）—— 加字段时必须也加到这里。
 */
function shape(j) {
  return {
    sessionId: String(j.sessionId),
    at: Number(j.at) || 0,
    ageMs: Date.now() - (Number(j.at) || 0),
    text: String(j.text || ''),
    reason: String(j.reason || ''),
    taskLine: String(j.taskLine || ''),
    openSteps: Array.isArray(j.openSteps) ? j.openSteps : [],
    /* 【2026-11-06 加·5 段式交接】 */
    goal: String(j.goal || ''),
    decisions: Array.isArray(j.decisions) ? j.decisions : [],
    /**
     * 【2026-11-07 修·「写了却读不到」又犯一次】
     *
     * markInterrupted 里 2026-11-05 就把 intent:'continue' 写死了，
     * 注释还写着「现在写入时就把意图写死。开机只看它，不再猜」。
     * 可这个返回是**白名单** —— 上一段注释自己就警告过「没列进来的字段一律读不到」，
     * 结果 intent 偏偏没列。
     *
     * 于是 server.mjs 里那句
     *   const _explicitIntent = String(info && info.intent || '') === 'continue';
     * 永远是 false；下一行 `reallyFinished && !_planLeft` 就直接 return 不续了。
     * **主人报的「有时候只自动重启、没有续跑」，头号原因就是这一行。**
     */
    intent: String(j.intent || ''),
    /**
     * 【2026-11-07 加·该不该开机自动续】
     *
     * 退出时会把「正在跑的」和「清单没打勾的」都记下来。可这两件事性质完全不同：
     *   · 正在跑被打断 → 开机该接着干（那是半截活）
     *   · 清单留着没做完、但人早就没在跑 → 那是老账，主人可能早就不想干了
     * 实测：退出一次记出 8 条「清单还有没做完的」，一键自动续会把 8 个会话同时拉起来，
     * 模型端点直接被我们打爆。
     *
     * 所以只给「真的被打断」的那种打 autoResume，开机只自动续这些；
     * 其余的留在文件里，等主人手动点（POST /api/resume 能指定会话）。
     */
    autoResume: j.autoResume === true,
  };
}

/**
 * 记下「这一轮被强杀了」。
 *
 * 【2026-11-07 改】按 sessionId upsert，不再整份覆盖：
 * 两个会话同时在跑时两条都留得住，重启后能一起续上。
 */
export function markInterrupted(info = {}) {
  const sessionId = String(info.sessionId || '');
  if (!sessionId) return false;
  try {
    const item = {
      sessionId,
      at: Date.now(),
      text: String(info.text || '').slice(0, 2000),
      reason: String(info.reason || '进程意外退出').slice(0, 200),
      taskLine: String(info.taskLine || '').slice(0, 500),
      /* 【2026-10-30】重启要「接着干」，光知道「我断在半句话」不够 ——
       * 得知道清单上还剩哪几步没打勾，不然起来只能干等主人说「继续」。 */
      openSteps: Array.isArray(info.openSteps) ? info.openSteps.slice(0, 30) : [],
      /* 【2026-11-06 加·5 段式交接简报】
       *  原来只存「断在哪、还剩哪几步」—— 醒来只知道接着干，不知道**为什么干**、
       *  也**已经定过什么主意**，于是把做过的重做一遍，或者拐到别的方向去。 */
      goal: String(info.goal || '').slice(0, 300),
      decisions: Array.isArray(info.decisions) ? info.decisions.slice(0, 8).map((x) => String(x || '').slice(0, 200)) : [],
      /**
       * 【2026-11-05 加·显式意图】
       *
       * 根因：写这份文件时明明知道「有活没干完」（不然根本不会写），
       * 可开机那边却要用「最后一条消息长得像不像说完了」去**猜**。
       * 她说一句完整的话再重启 —— 就被判成「已完成」，直接跳过。
       * 现在写入时就把意图写死，开机只看它。
       */
      intent: 'continue',
      /* 只有「这一轮真的在跑、被掐断」才自动续；清单老账不自动续（见 shape 里的说明） */
      autoResume: info.autoResume === true,
    };
    const others = readAll().filter((x) => String(x.sessionId) !== sessionId);
    others.push(item);
    /* 正常也就一两条；留 8 条上限，防止某些异常路径越攒越多 */
    const list = others.sort((a, b) => (Number(b.at) || 0) - (Number(a.at) || 0)).slice(0, 8);
    return writeAll(list);
  } catch {
    return false;
  }
}

/**
 * 看一眼有没有要续跑的。**只读不删。**
 *
 * 无参 → 最近的一条（老调用点全都这么用，语义不变）
 * 给 sessionId → 只取那一条
 * 要看全部 → listInterrupted()
 */
export function peekInterrupted(sessionId) {
  const all = readAll();
  if (!all.length) return null;
  if (sessionId) {
    const hit = all.find((x) => String(x.sessionId) === String(sessionId));
    return hit ? shape(hit) : null;
  }
  const sorted = all.slice().sort((a, b) => (Number(b.at) || 0) - (Number(a.at) || 0));
  return shape(sorted[0]);
}

/**
 * 【2026-11-07 新增】所有还在有效期内的续跑意图，最近的在前面。
 * 开机续跑用它 —— 一个会话一条，全都起回来。
 */
export function listInterrupted() {
  return readAll()
    .slice()
    .sort((a, b) => (Number(b.at) || 0) - (Number(a.at) || 0))
    .map(shape);
}

/**
 * 取走续跑意图（取完就删）。
 * 无参 → 取最近一条并删它；给 sessionId → 只取删那一条。
 */
export function takeInterrupted(sessionId) {
  const out = peekInterrupted(sessionId);
  if (!out) return null;
  dropInterrupted(String(out.sessionId));
  return out;
}

/**
 * 删掉续跑意图。
 * 无参 → 全清（老调用点语义不变）；给 sessionId → 只删那一条。
 *
 * 【为什么必须能只删一条】续跑成功一个就删一个；
 * 另一个还没跑完的不能被顺手清掉 —— 那正是「只有一个续上」的另一半原因。
 */
export function dropInterrupted(sessionId) {
  try {
    if (!existsSync(FILE)) return true;
    if (!sessionId) {
      unlinkSync(FILE);
      return true;
    }
    const rest = readAll().filter((x) => String(x.sessionId) !== String(sessionId));
    if (!rest.length) {
      unlinkSync(FILE);
      return true;
    }
    return writeAll(rest);
  } catch {
    return false;
  }
}
