/**
 * 进行中那一轮的草稿。
 *
 * 为什么要有这个文件：
 *   一轮对话的回复原来只在整轮跑完之后才 saveSession 落盘（server.mjs 的 finally）。
 *   于是「模型已经说了大半、进程被杀 / 电脑断电 / 点了退出」这种情况下，
 *   那一轮从头到尾一个字都不剩 —— 主人重进会话，看到自己问了两句、
 *   小鱼一句没答，还以为是「记忆丢了」。
 *
 *   实测真出过：有个任务跑了两个多小时，中途服务崩了，那一整轮的回复全没了。
 *
 * 做法：
 *   边收字边把「这一轮到目前为止的样子」写进 .state/drafts/<会话id>.json，
 *   节流（默认 1.5 秒最多写一次，且至少新增 40 字才写），不拖慢流。
 *   整轮正常结束时删掉草稿 —— 那时已经进了正式历史，草稿没用了。
 *   下次打开会话发现还有草稿（说明上次没收尾），就把它补成一条正式的助手消息。
 *
 * 草稿里只放「还没进历史的那部分」，格式刻意跟 session.messages 里的条目一致，
 * 补进历史时直接塞进去就行，不用转换。
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, unlinkSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { config } from './config.mjs';

const DIR = join(config.dataDir, '.state', 'drafts');

/** 草稿文件路径。会话 id 只允许安全字符，防止拼出奇怪路径。 */
function draftPath(sessionId) {
  const safe = String(sessionId || '').replace(/[^\w.-]/g, '_');
  return join(DIR, `${safe}.json`);
}

function ensureDir() {
  if (!existsSync(DIR)) {
    try {
      mkdirSync(DIR, { recursive: true });
    } catch {}
  }
}

/**
 * 写一张草稿。
 *
 * @param {string} sessionId
 * @param {object} draft 形如 { at, text, reasoning, toolCalls, startedAt, updatedAt }
 * @returns {boolean} 写成功没有（失败只是少了一份保险，不该影响对话）
 */
export function saveDraft(sessionId, draft) {
  if (!sessionId) return false;
  try {
    ensureDir();
    const body = {
      sessionId,
      startedAt: draft.startedAt || Date.now(),
      updatedAt: Date.now(),
      text: String(draft.text || ''),
      reasoning: String(draft.reasoning || ''),
      toolCalls: draft.toolCalls || null,
    };
    writeFileSync(draftPath(sessionId), JSON.stringify(body), 'utf8');
    return true;
  } catch (e) {
    // 磁盘满 / 权限问题之类：吞掉。草稿只是保险，不能反过来把对话搞挂。
    return false;
  }
}

/** 读草稿。没有就返回 null。 */
export function readDraft(sessionId) {
  try {
    const p = draftPath(sessionId);
    if (!existsSync(p)) return null;
    const j = JSON.parse(readFileSync(p, 'utf8'));
    if (!j || typeof j !== 'object') return null;
    const text = String(j.text || '');
    // 一个字都没有的草稿没意义（比如刚开跑就被杀），不算
    if (!text.trim()) return null;
    return {
      sessionId,
      startedAt: Number(j.startedAt) || 0,
      updatedAt: Number(j.updatedAt) || 0,
      text,
      reasoning: String(j.reasoning || ''),
      toolCalls: j.toolCalls || null,
    };
  } catch {
    return null;
  }
}

/** 删草稿。正常收尾后必须调，不然下次打开会重复补一条。 */
export function dropDraft(sessionId) {
  try {
    const p = draftPath(sessionId);
    if (existsSync(p)) unlinkSync(p);
    return true;
  } catch {
    return false;
  }
}

/** 列出所有还留着草稿的会话 id（启动时可以扫一遍看看有没有遗留）。 */
export function listDrafts() {
  try {
    if (!existsSync(DIR)) return [];
    return readdirSync(DIR)
      .filter((f) => f.endsWith('.json'))
      .map((f) => f.slice(0, -5));
  } catch {
    return [];
  }
}

/**
 * 做一把节流器：决定「这次要不要真的写盘」。
 *
 * 两个条件满足其一就写：
 *   - 距离上次写超过 minGap 毫秒（默认 1500）—— 保证长时间生成的也能定期落；
 *   - 新增字数超过 minChars（默认 40）—— 保证内容确实在推进。
 * 另外 force 为真时无条件写（工具调用、结束前那次）。
 */
export function makeDraftThrottle({ minGap = 1500, minChars = 40 } = {}) {
  let lastAt = 0;
  let lastLen = 0;
  return function shouldWrite(len, force = false) {
    if (force) {
      lastAt = Date.now();
      lastLen = len;
      return true;
    }
    const now = Date.now();
    if (len - lastLen >= minChars && now - lastAt >= 300) {
      lastAt = now;
      lastLen = len;
      return true;
    }
    if (now - lastAt >= minGap && len !== lastLen) {
      lastAt = now;
      lastLen = len;
      return true;
    }
    return false;
  };
}
