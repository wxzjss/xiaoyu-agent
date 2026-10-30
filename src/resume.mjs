/**
 * 崩溃后续跑。
 *
 * 【要解决什么】
 * 进程兜底（crash-guard.mjs）救不回来的时候会 process.exit(1)，整个程序消失。
 * 那时候正在跑的那一轮，草稿是落了盘，可「她要继续把这件事做完」这个意图没人记得 ——
 * 主人回来只看到半截话，得自己再打一句「接着做」。
 *
 * 这里做两件事：
 *   1. 临死前把「谁被打断了、断在哪个任务上」写进 .state/resume.json（markInterrupted）
 *   2. 下次启动读出来，把那一轮自动起回来（takeInterrupted → 由 server 起一轮）
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

/**
 * 记下「这一轮被强杀了」。
 *
 * @param {object} info
 * @param {string} info.sessionId
 * @param {string} [info.text]      已经说出来的半截话（给模型看「我刚说到这儿」）
 * @param {string} [info.reason]    为什么死的（给人看）
 * @param {string} [info.taskLine]  这一轮的起点（主人最后说的那句话）
 * @param {Array}  [info.openSteps]  清单上还没打勾的步骤（重启后照着往下做）
 */
export function markInterrupted(info = {}) {
  const sessionId = String(info.sessionId || '');
  if (!sessionId) return false;
  try {
    if (!existsSync(DIR)) mkdirSync(DIR, { recursive: true });
    writeFileSync(
      FILE,
      JSON.stringify(
        {
          sessionId,
          at: Date.now(),
          text: String(info.text || '').slice(0, 2000),
          reason: String(info.reason || '进程意外退出').slice(0, 200),
          taskLine: String(info.taskLine || '').slice(0, 500),
          /* 【2026-10-30】重启要「接着干」，光知道「我断在半句话」不够 ——
           * 得知道清单上还剩哪几步没打勾，不然起来只能干等主人说「继续」。 */
          openSteps: Array.isArray(info.openSteps) ? info.openSteps.slice(0, 30) : [],
        },
        null,
        2,
      ),
      'utf8',
    );
    return true;
  } catch {
    return false;
  }
}

/** 只读不删：给界面/日志看「上次是不是崩过」 */
export function peekInterrupted() {
  try {
    if (!existsSync(FILE)) return null;
    const j = JSON.parse(readFileSync(FILE, 'utf8'));
    if (!j || typeof j !== 'object' || !j.sessionId) return null;
    const age = Date.now() - Number(j.at || 0);
    if (!Number.isFinite(age) || age > MAX_AGE_MS) return null;
    return {
      sessionId: String(j.sessionId),
      at: Number(j.at) || 0,
      ageMs: age,
      text: String(j.text || ''),
      reason: String(j.reason || ''),
      taskLine: String(j.taskLine || ''),
      openSteps: Array.isArray(j.openSteps) ? j.openSteps : [],
    };
  } catch {
    return null;
  }
}

/**
 * 取走续跑意图（取完就删，避免每次启动都重跑一遍）。
 * 太老的直接丢掉 —— 隔了一天还替主人接着干，多半是帮倒忙。
 */
export function takeInterrupted() {
  const out = peekInterrupted();
  dropInterrupted();
  return out;
}

export function dropInterrupted() {
  try {
    if (existsSync(FILE)) unlinkSync(FILE);
    return true;
  } catch {
    return false;
  }
}
