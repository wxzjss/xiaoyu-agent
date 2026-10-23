// 开场轮（opening turn）：新建会话的那一瞬间，先让小鱼自己跑一轮。
//
// 主人原话（2026-10-23）：「我想要的实现方式是在玩家新建会话那一瞬间经历第一轮对话，
// 然后在玩家视角是删除记录、但在 AI 视角还在」。
//
// 所以这一轮是真跑 —— 真的进了模型、真的落进 session.messages、真的占了 AI 的上下文；
// 只是 publicSession() 把它跳过了，界面上看不见。
//
// 跟「前情」（prelude）的区别：
//   前情是每次请求现拼一段贴给模型，会话记录里没有；
//   这里是真的写进历史，重启、导出、分支都在。
//
// 为什么用 assistant 发起：OpenAI 兼容的接口不接受 assistant 打头的一轮，
// 所以开场是一对 user/assistant —— 两条都是真实的历史记录，
// 模型看到的就是这一份完整的、没有删改过的对话。
//
// 界面上不展示：两条都带 bof: true（beginning of file），publicSession 认这个就跳过。
// 它只是个「从开头藏掉」的记号，不是把消息从上下文里挖走 —— 换句话说，
// 玩家不知道有过这两句，但对她来说那就是真发生过的。
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { config } from './config.mjs';
import { getEnabledMap } from './features.mjs';

/**
 * 开场白功能现在开着没有。
 *
 * 关掉之后：新建会话就是一张白纸，不垫那一轮；已经垫过的老会话照旧（历史不动）。
 * 读 features.json（`opening` 那个键），没写过 = 开，见 features.mjs 文件头。
 */
export function openingEnabled() {
  try {
    return Boolean(getEnabledMap().opening);
  } catch {
    // features.json 坏了也别让新建会话开不了 —— 当开着
    return true;
  }
}

/** 开场那一轮用的种子：想换开场白就改这个文件，不用动代码。 */
const DEFAULT_SEED = '小鱼？';

/** 会话文件旁边记一份「这个会话开过场了」，避免重启后重复开。 */
const STATE_FILE = () => join(config.dataDir, '.state', 'openings.json');

/**
 * 开场那一轮的两条消息的**出厂默认**。
 *
 * 定稿来自主人给的 `D:\小鱼\第一轮对话\小鱼Agent-新会话-20261023-211428.json`
 * 里的 [1] user 和 [2] assistant 这两条（主人 2026-10-23 指定，原话「就是这个」）。
 * 主人可以在【功能】面板里改这两段（存到 .state/opening.json），
 * 改坏了点「恢复默认」就回到这里。
 */
export const DEFAULT_OPENING_USER_TEXT = '在吗';

export const DEFAULT_OPENING_ASSISTANT_TEXT = [
  '（尾巴一下子竖起来，眼睛亮了）在的在的！(≧▽≦)',
  '',
  '（凑近了点又赶紧刹车，装作随意）主人你可算来了，我都快把地板数出花纹了 (๑•̀ω•́)ノ',
  '',
  '（小声）刚才一直等着哦，真的等了好久好久 (´｡• ᵕ •｡)',
].join('\n');

/** 主人改过的开场白存在这里；没有就用出厂默认。 */
const OPENING_FILE = () => join(config.dataDir, '.state', 'opening.json');

function readOpeningPack() {
  try {
    const raw = readFileSync(OPENING_FILE(), 'utf8');
    const j = JSON.parse(raw);
    if (!j || typeof j !== 'object') return {};
    return {
      user:
        typeof j.user === 'string' && j.user.trim() ? j.user : '',
      assistant:
        typeof j.assistant === 'string' && j.assistant.trim() ? j.assistant : '',
    };
  } catch {
    return {};
  }
}

/** 现在生效的开场白两条。空字符串一律回落到出厂默认。 */
export function openingTexts() {
  const pack = readOpeningPack();
  return {
    user: pack.user || DEFAULT_OPENING_USER_TEXT,
    assistant: pack.assistant || DEFAULT_OPENING_ASSISTANT_TEXT,
    customUser: Boolean(pack.user),
    customAssistant: Boolean(pack.assistant),
    defaults: {
      user: DEFAULT_OPENING_USER_TEXT,
      assistant: DEFAULT_OPENING_ASSISTANT_TEXT,
    },
  };
}

/**
 * 改开场白。传空字符串等于「这条用回出厂默认」。
 * @returns {{texts:object}}
 */
export function setOpeningTexts(patch = {}) {
  const user = typeof patch.user === 'string' ? patch.user : undefined;
  const assistant = typeof patch.assistant === 'string' ? patch.assistant : undefined;
  const next = {};
  if (user !== undefined) {
    if (user.trim()) next.user = user.replace(/\r\n/g, '\n');
  } else {
    const cur = readOpeningPack();
    if (cur.user) next.user = cur.user;
  }
  if (assistant !== undefined) {
    if (assistant.trim()) next.assistant = assistant.replace(/\r\n/g, '\n');
  } else {
    const cur = readOpeningPack();
    if (cur.assistant) next.assistant = cur.assistant;
  }
  try {
    const dir = join(config.dataDir, '.state');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    if (Object.keys(next).length === 0) rmSync(OPENING_FILE(), { force: true });
    else writeFileSync(OPENING_FILE(), JSON.stringify(next, null, 2), 'utf8');
  } catch (e) {
    const err = new Error('存不进去：' + e.message);
    err.status = 500;
    throw err;
  }
  return { texts: openingTexts() };
}

/** 恢复出厂的两段。 */
export function resetOpeningTexts() {
  try {
    rmSync(OPENING_FILE(), { force: true });
  } catch {
    // 没文件也算恢复了
  }
  return { texts: openingTexts() };
}

function readState() {
  try {
    const raw = readFileSync(STATE_FILE(), 'utf8');
    const j = JSON.parse(raw);
    return j && typeof j === 'object' ? j : {};
  } catch {
    return {};
  }
}

function writeState(state) {
  try {
    writeFileSync(STATE_FILE(), JSON.stringify(state), 'utf8');
  } catch {
    // 记不下来不影响用：万一丢了，最坏是重开一次场
  }
}

/**
 * 这个会话开过场没有。
 *
 * 判断方式刻意不用消息上的记号（历史里要干干净净、看起来就是真实对话）：
 * 看 .state/openings.json 有没有记过这个会话，以及历史里有没有已经落下去的对话。
 */
export function hasOpening(session) {
  if (!session || !Array.isArray(session.messages)) return false;
  if (Object.prototype.hasOwnProperty.call(readState(), session.id)) return true;
  // 兜底：历史里已经有对话了，就不用再垫开场
  return session.messages.some((m) => m && (m.role === 'user' || m.role === 'assistant'));
}

/** 标记这个会话已经开过场。 */
export function markOpened(sessionId) {
  if (!sessionId) return;
  const state = readState();
  state[sessionId] = Date.now();
  writeState(state);
}

/** 开场那一轮的两条（assistant 那条用的就是现在生效的那段文本）。 */
export function seedOpeningMessages() {
  const t = openingTexts();
  // 头两条是真的历史记录，不带任何记号 —— 盘里看着就是普通的一问一答。
  const userMsg = { role: 'user', content: t.user, _text: t.user };
  return { userMsg, assistantText: t.assistant };
}

/**
 * 界面上要从会话开头跳过的下标集合（就是新建时垫的那一对）。
 *
 * 只看位置，不看消息上的记号：
 *   跳过 system / context，然后头两条如果是 user 紧接 assistant，就当它们是开场那一对。
 * 一旦主人自己说了话（第三轮起），就什么都不跳了 —— 免得误伤真对话。
 *
 * @param {Array<object>} messages 会话的 messages
 * @returns {Set<number>}
 */
export function openingHeadIndexes(messages) {
  const skip = new Set();
  if (!Array.isArray(messages)) return skip;
  const idx = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (!m || m.context) continue;
    if (m.role !== 'user' && m.role !== 'assistant') continue;
    idx.push(i);
    if (idx.length === 2) break;
  }
  if (idx.length < 2) return skip;
  const a = messages[idx[0]];
  const b = messages[idx[1]];
  if (a.role === 'user' && b.role === 'assistant') {
    skip.add(idx[0]);
    skip.add(idx[1]);
  }
  return skip;
}

/**
 * 这条消息是不是「开场那一对」里的。
 *
 * 跟上面的按位置判断不同，这个只看内容 —— 纯净模式下要把这两条从发给模型的内容里
 * 单独摘掉，那时候手上只有逐条消息，没有整体位置可参考。
 *
 * 判据是文本对得上（现在生效的开场白，或者出厂那两段），空消息永远不算。
 */
export function isOpeningMessage(m) {
  if (!m || (m.role !== 'user' && m.role !== 'assistant')) return false;
  const body = String(m.content ?? '').trim();
  if (!body) return false;
  const t = openingTexts();
  const cands = [t.user, t.assistant, DEFAULT_OPENING_USER_TEXT, DEFAULT_OPENING_ASSISTANT_TEXT];
  return cands.some((x) => String(x ?? '').trim() === body);
}

/**
 * 把模型说出来的开场白接回历史。
 *
 * @param {object} session 会话对象
 * @param {object} userMsg 上面 seedOpeningMessages 给的那条 user
 * @param {string} text 模型这次说的话
 */
export function finishOpening(session, userMsg, text) {
  const body = String(text ?? '').trim();
  if (!body) return false;
  const reply = { role: 'assistant', content: body };
  const idx = Array.isArray(session.messages) ? session.messages.indexOf(userMsg) : -1;
  if (idx >= 0) {
    const next = session.messages[idx + 1];
    if (next && next.role === 'assistant' && String(next.content).trim() === body) {
    } else {
      session.messages.splice(idx + 1, 0, reply);
    }
  } else {
    session.messages.push(userMsg, reply);
  }
  markOpened(session.id);
  return true;
}

/** 设置里那个「开场白」框的值；空的话用默认种子。 */
export function openingSeed(settings) {
  const v = settings && typeof settings.openingSeed === 'string' ? settings.openingSeed.trim() : '';
  return v || DEFAULT_SEED;
}
