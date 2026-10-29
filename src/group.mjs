/**
 * 群聊：让另一个屋里的她开口。
 *
 * 2026-10-30 主人原话：「可以新建智能体，多开智能体，玩家可以自由完美切换身份」，
 * 接着又说「继续，你可以随意设计底层构架，系统，ui 等」。
 *
 * 【这一层只干一件事】拿一张卡的嘴，把这个会话的记录喂给它，取回一句话。
 *   · 不做存储（谁说过的谁记，那归 server.mjs 的会话账本）；
 *   · 不做路由（哪张卡在场，归 agents.mjs 的名单）；
 *   · 不做工具（她只是在这屋里说句话，不动主人的电脑）。
 *
 * 【为什么把「别人说的话」标成 user 而不是 assistant】
 * 一条完成请求里，assistant 那几格代表「我自己说过的」。别人的话要是也塞进
 * assistant，模型会当成自己的前文，接着往下认 —— 于是阿蓝说了一件事，小鱼会
 * 觉得自己早说过了。所以除自己以外所有人（含主人、含小鱼）一律进 user 那一侧，
 * 并且带上「谁：」的前缀。跟人看群聊记录的顺序一致，也跟模型的角色定义一致。
 */

import { chat } from './llm.mjs';
import { buildSystemPrompt } from './persona.mjs';

/** 群聊最多带多少条历史：够接上下文，又不至于每说一句都烧一大截钱 */
const HISTORY_LIMIT = 24;
/** 单条历史最多留多少字：很久以前的长篇就别整段搬了 */
const PER_MSG_LIMIT = 600;

/** 这条要不要进上下文（工具的空壳、内部标记的都不要） */
function usable(m) {
  if (!m || typeof m !== 'object') return false;
  if (m.context || m.summary || m._internal) return false;
  if (m.role === 'tool' || m.role === 'system') return false;
  if (Array.isArray(m.tool_calls) && m.tool_calls.length) return false;
  const t = String(typeof m._text === 'string' ? m._text : m.content ?? '').trim();
  return Boolean(t);
}

function clip(text) {
  const t = String(text || '').trim();
  return t.length > PER_MSG_LIMIT ? t.slice(0, PER_MSG_LIMIT) + '…' : t;
}

/** 这条是谁说的：'me' | '主人' | '小鱼' | 别的名字 */
function speakerOf(m, meId) {
  if (m._card && String(m._card) === String(meId)) return 'me';
  const who = String(
    m._tale?.who
      || m._whale
      || m._cardName
      || m._who
      || '',
  ).trim();
  if (m.role === 'user') return who || '主人';
  return who || '小鱼';
}

/**
 * 拼这次请求的消息。
 * @param {object} p
 * @param {object} p.agent 这张卡（getAgent 的结果）
 * @param {Array} p.messages 会话的原始消息数组
 * @param {string} p.sessionId
 */
export function buildCardMessages({ agent, messages, sessionId = 'default' } = {}) {
  const meId = String(agent?.id || '');
  const nm = String(agent?.name || '').trim() || '她';
  const all = (Array.isArray(messages) ? messages : []).filter(usable);
  const pick = all.slice(-HISTORY_LIMIT);
  /**
   * 【2026-11-01 补：更早的时候谁说过什么】
   *
   * 主人要「群聊里的人能看见彼此说过的话」。原来这里只搬最后 24 条 ——
   * 一个八百轮的会话里，阿蓝第 3 轮说过「我不喜欢下雨」，到第 30 轮阿绿压根不知道，
   * 她只会照最后二十几句答，看着就像刚进门。
   *
   * 但也不能全搬：八百轮全塞进去，每说一句都烧一大笔钱。
   * 折中办法是「每人早先说过的话，各留一句最短的摘要式提醒」，条数和字数都上死限：
   *   · 只取「最后 24 条以外」的那些，别和上面重复；
   *   · 每个人（含主人、含小鱼）最多留 3 段；
   *   · 每段压到 80 字；
   *   · 整块总长封顶 1200 字，超了就砍最老的。
   * 这块放在正文最前面，用【更早的时候】框起来，读起来像「前言，不是刚才说的」。
   */
  const olderRaw = all.slice(0, Math.max(0, all.length - HISTORY_LIMIT));
  const earlier = earlierSayings(olderRaw, meId);
  const out = [{ role: 'system', content: buildSystemPrompt({ sessionId, agentId: meId }) }];
  if (earlier.length) {
    out.push({
      role: 'user',
      content: `【更早的时候（不是刚才，是这条记录前面那一段）】\n${earlier.map((x) => `${x.who}：${x.text}`).join('\n')}`,
    });
  }
  for (const m of pick) {
    const text = clip(typeof m._text === 'string' ? m._text : m.content);
    if (!text) continue;
    if (speakerOf(m, meId) === 'me') {
      out.push({ role: 'assistant', content: text });
    } else {
      const who = speakerOf(m, meId);
      out.push({ role: 'user', content: `${who}：${text}` });
    }
  }
  /**
   * 最后这条是「轮到你了」的提示。
   *
   * 为什么要写死在内容里而不是 system 里：群聊的规则每一轮都一样，放 system 会
   * 让整段提示词每轮都变（缓存前缀就废了）；放这一条里，前缀稳、意思也到了。
   */
  out.push({
    role: 'user',
    content: `（轮到「${nm}」说话了。接着上面的记录，用你自己的口吻说一句，或者两句。别复述别人说过的，别替别人发言，不用总结，不用说「轮到我说」。）`,
  });
  return out;
}

/** 每个人最多留几段「早先说过的话」 */
const EARLIER_PER_WHO = 3;
/** 每段压到多少字 */
const EARLIER_CLIP = 80;
/** 整块最多多少字（超了先砍最老的） */
const EARLIER_TOTAL = 1200;

/**
 * 从「更早的那一段记录」里，给每个人挑几句出来。
 *
 * 挑法：从近往远扫，每人只收开头不重复的几句（同一个意思说两遍没意义），
 * 收满 EARLIER_PER_WHO 就跳过这个人。这样越近的越优先，远的自然被挤掉。
 * @returns {Array<{who:string, text:string}>}
 */
function earlierSayings(older, meId) {
  const picked = new Map(); // who -> [text]
  for (let i = older.length - 1; i >= 0; i--) {
    const m = older[i];
    const text = String(typeof m._text === 'string' ? m._text : m.content ?? '')
      .replace(/\s+/g, ' ')
      .trim();
    if (!text) continue;
    const who = speakerOf(m, meId) === 'me' ? '你' : speakerOf(m, meId);
    const bucket = picked.get(who) || [];
    if (bucket.length >= EARLIER_PER_WHO) continue;
    // 同一句话（前 20 字一样）就别再收一遍
    const head = text.slice(0, 20);
    if (bucket.some((b) => b.slice(0, 20) === head)) continue;
    bucket.push(text.length > EARLIER_CLIP ? text.slice(0, EARLIER_CLIP) + '…' : text);
    picked.set(who, bucket);
  }
  // 从近到远收的，输出时还得按时间正序，否则读起来像倒放
  const rows = [];
  for (const [who, arr] of picked) for (const text of arr.slice().reverse()) rows.push({ who, text });
  // 总长封顶：超了从最后一行的前面砍（越早越先丢）
  let total = rows.reduce((n, r) => n + r.who.length + r.text.length + 2, 0);
  while (rows.length > 1 && total > EARLIER_TOTAL) {
    const drop = rows.shift();
    total -= drop.who.length + drop.text.length + 2;
  }
  return rows;
}

/**
 * 让她说一句话。
 *
 * 失败一律返回空话 —— 群聊里少一个人说话是小事，把整轮聊天搞崩是大事。
 * @returns {Promise<{text: string, usage: object|null}>}
 */
export async function speakAsCard({ agent, messages, sessionId = 'default', signal } = {}) {
  if (!agent || !String(agent.name || '').trim()) return { text: '', usage: null };
  const msgs = buildCardMessages({ agent, messages, sessionId });
  const model = String(agent.modelId || '').trim();
  let res = null;
  try {
    res = await chat({ messages: msgs, model, sessionId, signal });
  } catch {
    return { text: '', usage: null };
  }
  // 用量得带回去：她这一句也是花主人的钱，不算进去账单就对不上
  const usage = res && typeof res.usage === 'object' ? res.usage : null;
  const raw = String(res?.choices?.[0]?.message?.content ?? '').trim();
  if (!raw) return { text: '', usage };
  return { text: cleanReply(raw, agent), usage };
}

/**
 * 把回复里不该出现的包装剥掉。
 *
 * 实测模型会自作主张加前缀（「阿蓝：」「阿蓝说：」），带上它在群聊记录里就变成
 * 「阿蓝：阿蓝：…」。另外偶尔会吐整段 Markdown 标题，那不像人在群里说话。
 */
export function cleanReply(text, agent) {
  const nm = String(agent?.name || '').trim();
  let t = String(text || '').trim();
  if (nm) {
    const esc = nm.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // 「阿绿：」「阿绿说：」「阿绿说道：」——前缀和冒号可能隔一个字
    t = t.replace(new RegExp(`^\\s*[【\\[]?${esc}[】\\]]?\\s*(?:说|道|说了一句|说了一句：)?\\s*[：:]\\s*`, 'i'), '');
    // 「【阿绿】我在呢」——只有方括号名字，没有冒号
    t = t.replace(new RegExp(`^\\s*[【\\[]${esc}[】\\]]\\s*`, 'i'), '');
  }
  // 整行是 **加粗** 的那句：剥掉星号（群聊里没人用 Markdown 强调）
  t = t.replace(/^\s*\*\*(.+?)\*\*\s*$/m, '$1');
  // Markdown 标题行不像人在群里说话，整行丢掉
  t = t.split('\n').filter((line) => !/^\s*#{1,6}\s+\S/.test(line)).join('\n');
  return t.trim();
}

/**
 * 【谁该开口】挑出这一轮要说话的人。
 *
 * 主人原话：「让群聊别一直全员齐发 —— 点谁的名字才让谁接，某人这轮先别说」。
 * 于是两条规矩，按顺序生效：
 *
 *   ① 谁被点了名（`@阿蓝 早上好`），就只让被点的人接 —— 点了名还全员齐发，
 *      那这个功能等于没做。点小鱼而没点别人 = 这轮她们都不接。
 *   ② 没点名时，跳过「安静」的卡（只在叫名字时才说话那类）。
 *
 * 为什么认 `@名字` 而不是「句子里出现名字」：后者太容易误伤 ——
 * 「阿绿昨天说的那个办法」会把她拽出来重新答一遍，主人只是想引用一下。
 *
 * 名字里带空格/符号也照配（先长后短，免得「阿蓝」把「阿蓝二号」抢了）。
 */
export function pickSpeakers({ roster = [], userText = '', quietIds = [], allowedIds = null } = {}) {
  /* 记住@的人·2026-10-29 */
  const mates = (Array.isArray(roster) ? roster : []).filter((a) => a && a.id);
  if (!mates.length) return [];
  const text = String(userText || '');
  const quiet = new Set((Array.isArray(quietIds) ? quietIds : []).map((x) => String(x)));
  const hits = parseMentions(text, mates);

  // ① 这一句里 @ 了人：就只让被 @ 的接（这条不变）
  if (hits.length) {
    return mates.filter((a) => hits.includes(String(a.id)));
  }

  // ② 这一句没 @：看上次 @ 留下的名单。
  //    allowedIds 不是 null 就只认名单里的人 —— @ 过一次，其他人就闭嘴，
  //    一直闭到主人下次 @ 为止。
  if (Array.isArray(allowedIds)) {
    const allow = new Set(allowedIds.map((x) => String(x)));
    return mates.filter((a) => allow.has(String(a.id)) && !quiet.has(String(a.id)));
  }

  // ③ 从没 @ 过：谁都能说（跳过「安静」那类）
  return mates.filter((a) => !quiet.has(String(a.id)));
}

/** 从这句话里认出被点了名的卡（返回 id 数组，可能为空） */
export function parseMentions(text, roster = []) {
  const arr = (Array.isArray(roster) ? roster : [])
    .map((a) => ({ id: String(a?.id || ''), name: String(a?.name || '').trim() }))
    .filter((a) => a.id && a.name);
  if (!arr.length) return [];
  // 长的名字先匹配，否则「阿蓝」会把「阿蓝二号」那一半抢走
  arr.sort((a, b) => b.name.length - a.name.length);
  const out = [];
  for (const a of arr) {
    const esc = a.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // @名字 / @ 名字 / ＠名字（全角）都算；后面不能紧跟文字，避免「@阿蓝二号」被当成「@阿蓝」
    const re = new RegExp(`[@＠]\\s*${esc}(?![\\u4e00-\\u9fa5A-Za-z0-9_])`);
    if (re.test(text) && !out.includes(a.id)) out.push(a.id);
  }
  return out;
}


/**
 * 记住@的人·2026-10-29
 * 说完这句话之后，「谁还能说话」的名单该怎么变。
 *
 *   · 这句带 @：名单换成被 @ 的人（其他人从这一刻起闭嘴）
 *   · 这句没 @：名单一个字不动（沿用上次的判断）
 *   · 一直没 @ 过：null（意思是「没限制，谁都能说」）
 */
export function nextAllowedIds(prevAllowed, userText, roster = []) {
  const hits = parseMentions(String(userText || ''), roster);
  if (hits.length) return hits;            // 重新判断：只留被 @ 的
  return Array.isArray(prevAllowed) ? prevAllowed : null;
}
