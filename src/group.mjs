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
 * 主人原话（2026-11-02，第三版，**以这一版为准**）：
 *   「现在艾特只与个性是否打勾有关，个性打勾的角色只要左侧按钮开启了那么只有艾特时开口说话，
 *    个性没打勾的角色只要左侧按钮开启了无论是否被艾特每轮都会说话」
 *   「如果左侧按钮没开启，那么是否被艾特都不会开口说话」
 *
 * 于是规矩只剩两层，先粗后细：
 *
 *   ① **左侧按钮（开关）是最硬的一层**：牌子关着的人，这一轮一句话都不说 ——
 *      被 @ 也不说。她不在场，主人叫她的名字，那就是没人在应。
 *   ② **开关开着的人，谁说只看「个性」那个勾**：
 *        · 个性打了勾 → 只有这一句 @ 了她，她才说（不 @ 就把嘴闭上）；
 *        · 个性没打勾 → 开着就每轮都说，@ 不 @ 都挡不住。
 *   ③ 被 @ 却是关着的牌 → 这一轮没人因这句话开麦（其余人照 ② 算），
 *      免得主人明明在叫一个不在场的人，屏幕上却是别人抢着回。
 *
 * 【作废的老规矩·别再翻】2026-10-29 那版「点谁的名字才让谁接」、2026-11-01 那版
 * 「@ 了没打勾的人 → 从此只留他们说话（锁场）」全部作废。主人这次说得很直：
 * 打不答一句话只看两件事 —— 按钮开没开、个性打没打勾。`allowedIds` 参数
 * 保留只为不让老调用方炸掉，**已经不再影响结果**。
 *
 * 为什么认 `@名字` 而不认「句子里出现名字」：「阿绿昨天说的那个办法」会把她拽出来重答。
 * 名字里带空格/符号也照配（先长后短，免得「阿蓝」把「阿蓝二号」抢了）。
 *
 * @param {object} p
 * @param {Array} p.roster 屋里的卡（顺序 = 说话顺序，谁前谁先说）
 * @param {string} p.userText 主人这句原话
 * @param {Array<string>} p.quietIds 「个性打勾」的卡 = 叫才应
 * @param {Array<string>|null} p.allowedIds 【已停用】旧「锁场」名单，传了也不看
 * @param {Array<string>} p.enabledIds 这一轮开着的牌（不给就是全开）
 */
export function pickSpeakers({ roster = [], userText = '', quietIds = [], allowedIds = null, enabledIds = null } = {}) {
  void allowedIds; // 旧锁场名单：2026-11-02 起不再参与，保留形参只为兼容老调用方
  const mates = (Array.isArray(roster) ? roster : []).filter((a) => a && a.id);
  if (!mates.length) return [];
  const text = String(userText || '');
  const quiet = new Set((Array.isArray(quietIds) ? quietIds : []).map((x) => String(x)));
  /* 关掉的牌：不说话。不传就是全开（老调用方/测试不用跟着改）。 */
  const on = Array.isArray(enabledIds) ? new Set(enabledIds.map((x) => String(x))) : null;
  const alive = on ? mates.filter((a) => on.has(String(a.id))) : mates;
  if (!alive.length) return [];
  const hits = parseMentions(text, mates);
  /* 点了名但点的是关掉的牌：这一轮谁都不因这句话开麦（其余照第二层算） */
  const aliveHits = hits.filter((id) => alive.some((a) => String(a.id) === String(id)));
  const askedOffOnly = hits.length > 0 && !aliveHits.length;
  if (askedOffOnly) return [];
  const hitSet = new Set(aliveHits.map((id) => String(id)));
  // 开关开着的人：打勾的（叫才应）看有没有被叫，没打勾的一律说
  const picked = alive.filter((a) => {
    const id = String(a.id);
    if (!quiet.has(id)) return true;
    return hitSet.has(id);
  });
  /**
   * 【@ 的顺序就是这轮谁先开口】—— 2026-11-02 主人：「根据艾特的顺序可以决定本轮智能体说话顺序」。
   *
   * 被 @ 到的、这一轮真要说话的人，按 `@` 在句子里出现的先后排到最前面
   * （主人打的第一个名字先说），剩下没被点的照「屋里的人」竖列从上往下的老顺序跟在后头。
   *
   * 为什么只搬被 @ 到的：主人打的字是他心里的顺序；竖列顺序是他早上摆好的默认顺序。
   * 一句 @ 了三个人，这三人当然按他打的先后说 —— 但没被点的人没理由插到中间去。
   *
   * AliveHits 已经是「按出现位置排好的」（parseMentions 按 text.indexOf 排），
   * 所以直接拿它当序号表用。
   */
  if (aliveHits.length && picked.length) {
    const rank = new Map(aliveHits.map((id, i) => [String(id), i]));
    const said = (a) => (rank.has(String(a.id)) ? rank.get(String(a.id)) : Number.MAX_SAFE_INTEGER);
    // sort 是稳定的：所有没被点的人都拿 MAX_SAFE_INTEGER，它们的相对次序原样保留
    return picked.slice().sort((a, b) => said(a) - said(b));
  }
  return picked;
}

/**
 * 从这句话里认出被点了名的卡（返回 id 数组，**按 @ 在句子里出现的先后排**）。
 *
 * 【2026-11-02 主人：「根据艾特的顺序可以决定本轮智能体说话顺序」】
 *
 * 上一版是「先按名字长度从长到短试一遍」，所以返回的是**名字长度序**，
 * 不是 @ 出现的位置序 —— 主人打「@阿紫 先说，然后 @阿蓝」，她俩的顺序是随机的。
 * 现在先按位置收齐，再按位置排；名字长短只用来防「阿蓝」抢「阿蓝二号」，
 * 不再决定谁先说。
 */
export function parseMentions(text, roster = []) {
  const arr = (Array.isArray(roster) ? roster : [])
    .map((a) => ({ id: String(a?.id || ''), name: String(a?.name || '').trim() }))
    .filter((a) => a.id && a.name);
  if (!arr.length) return [];
  const text0 = String(text || '');
  // 长的名字先试，否则「阿蓝」会把「阿蓝二号」那一半抢走（只影响匹配，不影响顺序）
  arr.sort((a, b) => b.name.length - a.name.length);
  const posOf = new Map(); // id -> 第一次被 @ 的位置
  for (const a of arr) {
    const esc = a.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // @名字 / @ 名字 / ＠名字（全角）都算；后面不能紧跟文字，避免「@阿蓝二号」被当成「@阿蓝」
    const m = new RegExp(`[@＠]\\s*${esc}(?![\\u4e00-\\u9fa5A-Za-z0-9_])`).exec(text0);
    if (m && !posOf.has(a.id)) posOf.set(a.id, m.index);
  }
  // 按出现位置排 —— 这就是主人打字的顺序，也是这一轮开口的顺序
  return [...posOf.entries()].sort((x, y) => x[1] - y[1]).map(([id]) => id);
}


/**
 * 说完这句话之后，「谁还能说话」的名单该怎么变。
 *
 * 【2026-11-02 整个函数退休了：永远返回 null = 不记账】
 *
 * 主人的新规矩（`pickSpeakers` 里写了）只看两件事：左侧按钮开没开、个性打没打勾。
 * 一个「@ 完之后定下来的常驻名单」会把这两条冲掉 —— 比如他 @ 了阿蓝（没打勾），
 * 按老规矩从此只剩阿蓝说话；可新规矩是「没打勾的开着就每轮都说」，小鱼小鲸
 * 也被算进名单里就会平白闭嘴。所以这里不再立规矩。
 *
 * 为什么还留着这个函数：server.mjs 与一堆测试都在 import 它。留着 + 永远返回 null，
 * 比删掉干净——老调用点不用改，行为统一成「每轮重新判」。
 *
 * @returns {null} 永远 null（= 上一轮没留下任何限制）
 */
export function nextAllowedIds(prevAllowed, userText, roster = [], quietIds = []) {
  void prevAllowed; void userText; void roster; void quietIds;
  return null;
}
