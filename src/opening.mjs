// 开场（opening）：新建会话的那一瞬间，先把她自己那句开场白垫进历史。
//
// 主人原话（2026-10-23）：「我想要的实现方式是在玩家新建会话那一瞬间经历第一轮对话」。
// 主人 2026-10-29 又定了一次口径：开场白变成「每张智能体卡自己的一句话」，
// 功能页那个全局开关撤掉 —— 见下面 cardOpening / setCardOpening。
//
// 历史里垫的是一对：一条 user 引子（看不见）+ 一条 assistant（就是她那张卡的开场白，看得见）。
// 为什么还要那条 user：OpenAI 兼容的接口有不接受 assistant 打头的，垫一条引子最稳；
// 它界面上不显示（openingHeadIndexes 只跳它一个），对模型来说却是真实发生过的一问一答。
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { config } from './config.mjs';
import { cardOpeningEnabled, setCardOpeningEnabled as _setCardOpeningEnabled } from './opening-switch.mjs';

/**
 * 这张卡这次要不要开场。
 *
 * 2026-10-29 起不再看功能页的开关（那个功能已经删了），只看「她那张卡的开场白填了没有」：
 * 填了内容她就开口，留空（比如小鲸）就是一张白纸。
 */
export function openingEnabled(agentId) {
  // 2026-10-31：多一道「开关」。稿子还留着但开关关掉 → 这次不开口。
  // 这样主人想暂时静一静时不用把整段话删了重打。
  if (!cardOpeningEnabled(agentId)) return false;
  return Boolean(String(cardOpening(agentId) || '').trim());
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

/**
 * 每张智能体卡自己的开场白。
 *
 * 2026-10-29 主人改的口径：
 *   「把原来删掉的【一句话】回滚回去，但改名为【开场白】，小鲸的默认留空，
 *     小鱼的默认填功能页【开场白】里面小鱼说的话，【开场白】内输入什么内容，
 *     那么创建会话时智能体会默认自动发送该内容，然后删除功能页原来的【开场白】功能」
 *
 * 所以开场白从「全局两段隐藏对话」变成了「每张卡的一句话」：
 *   · 小鱼默认就是原来那段出厂文本（她还是一上来就那几句）；
 *   · 小鲸默认空着 —— 她本来就不在会话里开场；
 *   · 主人自己建的卡也默认空着，谁想让她开口谁自己填。
 * 存在 .state/agent-openings.json：{ [agentId]: '她开局说的那句话' }。
 * 键在文件里、值是空串 = 主人明确清空过（她不开口），不会再回落到默认。
 */
const CARD_FILE = () => join(config.dataDir, '.state', 'agent-openings.json');

// 【2026-10-31 修 · 这张表被两种键混着写过，读的时候必须认会话 id】
// 表里曾经躺着 577 个形如 smvkyzlei9kg4 的键 —— 那是会话 id，是上一版把 setCardOpening
// 挂到 /api/opening（按会话改开场白的老接口）时写进去的。卡片键只有 xiaoyu / xiaojing / ag_xxx。
// 混着没关系（取值只按卡片 id 查），但会话键不能当成某张卡的开场白，所以出口统一滤一遍。
const looksLikeCardId = (k) => typeof k === 'string' && k.length > 0 && k.length <= 64 && !/^sm[a-z0-9]{8,}$/i.test(k);

function readCardMap() {
  try {
    const j = JSON.parse(readFileSync(CARD_FILE(), 'utf8'));
    if (!j || typeof j !== 'object') return {};
    const out = {};
    for (const [k, v] of Object.entries(j)) {
      if (typeof v === 'string' && looksLikeCardId(k)) out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

/** 这张卡的开场白。没记过的话小鱼用出厂那段，别的卡一律空着。 */
export function cardOpening(agentId) {
  const id = String(agentId || '');
  // 【2026-10-31 修 · 卡是唯一来源，不许再拿老文件顶】
  // 原来「表里没记过 → 小鱼回落到老 .state/opening.json 的 assistant → 再不行出厂段」。
  // 那条回落成了病根：功能页那个入口删了，可 opening.json 里那句老话还在盘上，
  // 于是「功能页开场白删了效果还在」，卡里清空了也照样冒出来。
  // 现在只认卡：表里有这个键（含空串=不开口）就用它；没这个键，小鱼用出厂段，别的卡空着。
  const map = readCardMap();
  if (Object.prototype.hasOwnProperty.call(map, id)) return map[id];
  if (id !== 'xiaoyu') return '';
  return DEFAULT_OPENING_ASSISTANT_TEXT;
}

/** 改这张卡的开场白。传空串 = 她以后不开口（不会回落到默认）。 */
export function setCardOpening(agentId, text) {
  const id = String(agentId || '');
  if (!id) {
    const err = new Error('没说要改哪张卡的开场白');
    err.status = 400;
    throw err;
  }
  /**
   * 【2026-10-29 修 · 不许再往这张表里写会话 id】
   *
   * 这张表叫 agent-openings，键只能是卡片 id。上一版 `/api/opening` 是「按会话改开场白」，
   * 它的 sessionId 被顺手写进了这张卡片表 —— 577 条会话键就是这么来的，
   * 而主人真正改的那张卡（xiaoyu）里一个字都没写进去，于是「填了开场白她不开口」。
   * 现在把口子堵死：会话 id 一律 400，谁再想这么写都写不进来。
   */
  if (/^sm[a-z0-9]{8,}$/i.test(id)) {
    const err = new Error('开场白是按智能体卡存的，不是按会话存的');
    err.status = 400;
    throw err;
  }
  const raw = String(text ?? '').replace(/\r\n/g, '\n');
  /**
   * 【2026-10-29 修 · 写回时别把别人的开场白抹掉】
   *
   * readCardMap() 出口过滤了会话键，如果拿它当底再整表写回，
   * 那 577 条会话键就会被顺手删掉。那批数据不是这次要清的东西（可能还有老会话在用），
   * 所以这里另读一份「原样的文件」当底，只改自己那一格。
   */
  let map = {};
  try {
    const rawFile = JSON.parse(readFileSync(CARD_FILE(), 'utf8'));
    if (rawFile && typeof rawFile === 'object') {
      for (const [k, v] of Object.entries(rawFile)) if (typeof v === 'string') map[k] = v;
    }
  } catch {
    map = readCardMap();
  }
  // 两头空白一律修掉：那玩意儿在界面上看不见，留着只会让「是不是同一句」比较出岔子
  map[id] = raw.trim();
  try {
    const dir = join(config.dataDir, '.state');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(CARD_FILE(), JSON.stringify(map, null, 2), 'utf8');
  } catch (e) {
    const err = new Error('存不进去：' + e.message);
    err.status = 500;
    throw err;
  }
  return { agentId: id, opening: cardOpening(id) };
}

/** 所有卡的开场白文本，给 isOpeningMessage 认「这句是不是开场白」用。 */
function allCardOpenings() {
  const vals = Object.values(readCardMap()).filter((v) => typeof v === 'string' && v.trim());
  vals.push(DEFAULT_OPENING_ASSISTANT_TEXT);
  const legacy = readOpeningPack().assistant;
  if (legacy) vals.push(legacy);
  return vals;
}

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

/**
 * 取消「开过场」的记号。
 *
 * 2026-10-28：切成非主人身份时会把垫在最前面的那两条开场白摘掉，
 * 摘掉之后这笔记号也得跟着销，不然这个会话以后永远补不回开场白。
 */
export function unmarkOpened(sessionId) {
  if (!sessionId) return;
  const state = readState();
  if (!Object.prototype.hasOwnProperty.call(state, sessionId)) return;
  delete state[sessionId];
  writeState(state);
}

/** 这个会话有没有「服务端自己垫过开场白」的记号（只认记号，不看内容）。 */
export function wasOpened(sessionId) {
  if (!sessionId) return false;
  return Object.prototype.hasOwnProperty.call(readState(), sessionId);
}

/**
 * 开场垫的那两条（assistant 那条用的就是这张卡的开场白）。
 *
 * 2026-10-29：文本改成从卡里取（cardOpening），不再读功能页那两段全局文本。
 * user 那条是引子，界面上看不见（见 openingHeadIndexes），对模型来说是真的一问一答。
 */
export function seedOpeningMessages(agentId = 'xiaoyu') {
  const userText = DEFAULT_OPENING_USER_TEXT;
  const assistantText = cardOpening(agentId);
  // 头两条是真的历史记录，不带任何记号 —— 盘里看着就是普通的一问一答。
  const userMsg = { role: 'user', content: userText, _text: userText };
  return { userMsg, assistantText };
}

/**
 * 界面上要从会话开头跳过的下标集合。
 *
 * 2026-10-29 改口径：开场白现在是「她自己默认发出的那句话」，所以**她那条要显示**，
 * 只把那条「在吗」引子藏着。老会话里也是这样 —— 藏引子、显示她的话。
 *
 * 只看位置：跳过 system / context，头一条 user 紧接一条 assistant，且 assistant 那条
 * 确实是开场白文本，就只跳 user 那条。第三轮起什么都不跳，免得误伤真对话。
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
  if (a.role === 'user' && b.role === 'assistant' && isOpeningMessage(a) && isOpeningMessage(b)) {
    // 只藏那条引子；她说的那句留在界面上 —— 那才是「她自动发出来的开场白」
    skip.add(idx[0]);
  }
  return skip;
}


/**
 * 这条消息是不是「开场那一对」里的。
 *
 * 跟上面的按位置判断不同，这个只看内容 —— 专业模式下要把这两条从发给模型的内容里
 * 单独摘掉，那时候手上只有逐条消息，没有整体位置可参考。
 *
 * 判据是文本对得上（现在生效的开场白，或者出厂那两段），空消息永远不算。
 */
export function isOpeningMessage(m) {
  if (!m || (m.role !== 'user' && m.role !== 'assistant')) return false;
  const body = String(m.content ?? '').trim();
  if (!body) return false;
  const t = openingTexts();
  const cands = [t.user, t.assistant, DEFAULT_OPENING_USER_TEXT, DEFAULT_OPENING_ASSISTANT_TEXT, ...allCardOpenings()];
  return cands.some((x) => String(x ?? '').trim() === body);
}

/**
 * 开头那段开场白在哪、有多长 —— 摘的时候只认这一段。
 *
 * 两种形状都要认：
 *   · 新形状（2026-10-29 起）：一条 assistant，她自己说的那句开场白；
 *   · 老形状：user「在吗」+ assistant 那句出厂文本（老会话里还是这样）。
 *
 * 记号锁照旧：openings.json 里没记过这个会话就一律返回 null ——
 * 主人自己打的那句话绝不能当成开场白删掉。
 *
 * @param {string} sessionId
 * @param {Array<object>} messages
 * @returns {{at:number, n:number}|null}
 */
export function openingSpan(sessionId, messages) {
  if (!sessionId || !Array.isArray(messages) || !wasOpened(sessionId)) return null;
  const at = messages.findIndex((m) => m && m.role !== 'system' && !m.context);
  if (at < 0) return null;
  const a = messages[at];
  const b = messages[at + 1];
  if (a && a.role === 'assistant' && isOpeningMessage(a)) return { at, n: 1 };
  if (a && b && a.role === 'user' && b.role === 'assistant' && isOpeningMessage(a) && isOpeningMessage(b)) {
    return { at, n: 2 };
  }
  return null;
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

/* 转发开关·2026-10-29 server.mjs 要从这儿拿这两个（实现仍在 opening-switch.mjs，
 * 这里只是转个手 —— 不转的话 server.mjs 整份加载失败，
 * 退回 asar 老代码，智能体界面就全空了）。 */
export { cardOpeningEnabled, _setCardOpeningEnabled as setCardOpeningEnabled };
