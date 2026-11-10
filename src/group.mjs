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
/**
 * 【2026-11-05 调·24 → 16，每条 600 → 400】
 *
 * 主人报「办事模式特别慢，还不如不开」。
 *
 * 查：每个 speaker 一次 chat()，上下文 = 24 条 × 600 字 + 系统提示（人设四千多）
 * + earlier 1200 字 ≈ 2 万字（近 3 万 token）。首字延迟自然长，而且 speaker 是串行的。
 *
 * 收一收：16 条 × 400 字 ≈ 6400 字。群聊「刚才谁说了什么」这个量已经够用，
 * 更早的本来就由 earlierSayings 每人留一句兜着。
 */
const HISTORY_LIMIT = 16;
/** 单条历史最多留多少字：很久以前的长篇就别整段搬了 */
const PER_MSG_LIMIT = 400;

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
function speakerOf(m, meId, mainName = '') {
  /**
   * 【这条是谁说的】—— 2026-10-30 修「小鲸的话被当成主人说的」
   *
   * 主人报：屏幕上那条带小鲸名字的话，口气却像小鱼、内容还是错的。
   *
   * 查到根：群聊卡片存进去的标记是 _card（值是她 id）和 _cardVoice，
   * 而这里只认 _tale/_whale/_cardName/_who —— _cardName 这个字段根本不存在。
   * 于是 who 取到空串，落到 role === 'user' ? who || '主人'，
   * 她那张卡在历史里的 role 正是 user → 被认成了「主人」。
   *
   * 后果一串：她看见上下文里「主人」在查日志、在定结论，却不知道那是小鱼干的，
   * 就顺着那个腔调用自己口吻接一句 —— 读起来就像小鱼披着她的名字说话。
   *
   * 改法：把 _card / _cardVoice / _who 都认进来。
   */
  if (m._card && String(m._card) === String(meId)) return 'me';
  const who = String(
    m._tale?.who
      || m._cardName
      || m._who
      || (m._whale ? '小鲸' : '')
      || (m._card ? String(m._card) : '')
      || '',
  ).trim();
  // 卡片声音（_cardVoice）也说明这行是别人说的，不该当主人
  if (m.role === 'user') return who || (m._cardVoice ? '某位同伴' : '主人');
  return who || String(mainName || '').trim() || '小鱼';
}

/**
 * 拼这次请求的消息。
 * @param {object} p
 * @param {object} p.agent 这张卡（getAgent 的结果）
 * @param {Array} p.messages 会话的原始消息数组
 * @param {string} p.sessionId
 */
export function buildCardMessages({ agent, messages, sessionId = 'default', mainName = '' } = {}) {
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
  const earlier = earlierSayings(olderRaw, meId, mainName);
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
    if (speakerOf(m, meId, mainName) === 'me') {
      out.push({ role: 'assistant', content: text });
    } else {
      const who = speakerOf(m, meId, mainName);
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
    content: `（轮到「${nm}」说话了。接着上面的记录，用你自己的口吻说一句，或者两句。别复述别人说过的，别替别人发言，不用总结，不用说「轮到我说」。

  【2026-11-09 主人重做 · 链式接话】上面这段记录是**这一轮**按说话先后排下来的：
  主人先说，然后主智能体答，再然后排在她下面的人一个接一个说。
  你现在能看到的就是「主人 + 排在你前面那些人刚说完的话」—— 后面的人还没开口，所以别提前替她们说。
  每行开头那个名字就是说话的人，别把别人的话认成自己说的。

  记录里「${mainName || '小鱼'}」是这一轮的主智能体（**唯一有 Agent 工作能力**的那个，
  负责查代码、看日志、修东西、派活），不是你，也不是主人：
  · 她的活儿、她的判断、她查到的东西，都算她的，别当成你自己查的，也别替她下结论、别替她报结果；
  · 也别学她的腔调说话 —— 你按你自己的样子说；
  · 你这一轮**没有工具、不能干活**，你自己没真看过的，就别说「我看了一眼」「我去查了」这种话。
  你只需要作为你自己，说你想说的。`
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
function earlierSayings(older, meId, mainName = '') {
  const picked = new Map(); // who -> [text]
  for (let i = older.length - 1; i >= 0; i--) {
    const m = older[i];
    const text = String(typeof m._text === 'string' ? m._text : m.content ?? '')
      .replace(/\s+/g, ' ')
      .trim();
    if (!text) continue;
    const who = speakerOf(m, meId, mainName) === 'me' ? '你' : speakerOf(m, meId, mainName);
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
export async function speakAsCard({ agent, messages, sessionId = 'default', signal, mainName = '' } = {}) {
  if (!agent || !String(agent.name || '').trim()) return { text: '', usage: null };
  const msgs = buildCardMessages({ agent, messages, sessionId, mainName });
  const model = String(agent.modelId || '').trim();
  let res = null;
  try {
    /* 【2026-11-09 主人重做·排在下面的智能体一律禁用 Agent 工作能力】
     * 这里**永远不传 tools**，也不跑 runAgent 的工具循环 —— 只有主智能体
     * （从上往下第一个开着的）有工具、能派活。其余的人只能说一句话。
     * 这条不是「暂时没给」，是口径：别哪天顺手把 tools 加回来。 */
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
 * 【2026-11-10 主人钦点：艾特（@）功能整个删掉】
 *
 * 主人原话：「把【屋里的人】艾特功能删除」。
 *
 * 在此之前有三版规矩叠在一起（被 @ 才说 / @ 了谁就只留谁 / @ 的顺序决定开口顺序），
 * 靠 `parseMentions` 从主人这句话里抠 `@名字`。现在一概不认了：
 *
 *   ① **左侧按钮（开关）是唯一的一层**：牌子开着的，这一轮都说一句；
 *      牌子关着的，一个字都不说。就这样，没有第二层。
 *   ② 「个性打勾＝叫才应」跟着作废 —— 那条规则的全部意义就是「等我 @ 你」，
 *      @ 没了它就成了「永远不说话」，留着只是个坑。勾选框也从界面上撤掉了。
 *   ③ 说话顺序 = 「屋里的人」竖列从上到下（主人自己摆的顺序）。
 *
 * 主人现在想指定谁说话，用左侧按钮开关就行 —— 关掉不想听的那个。
 * 一句话里写 `@阿蓝` 现在就是普通文字，会原样交给她看，不会再有人因为这个被拽出来。
 *
 * `quietIds` / `allowedIds` 形参保留只为不让老调用方炸掉，**已经不再影响结果**。
 *
 * @param {object} p
 * @param {Array} p.roster 屋里的卡（顺序 = 说话顺序，谁前谁先说）
 * @param {string} p.userText 主人这句原话（已不再解析，保留形参兼容）
 * @param {Array<string>} p.quietIds 【已停用】个性打勾名单
 * @param {Array<string>|null} p.allowedIds 【已停用】
 * @param {Array<string>} p.enabledIds 这一轮开着的牌（不给就是全开）
 * @param {boolean} p.keepOrder 保留形参；现在本来就严格按竖列顺序
 */
export function pickSpeakers({ roster = [], userText = '', quietIds = [], allowedIds = null, enabledIds = null, keepOrder = false } = {}) {
  void userText;    // 2026-11-10 起不再解析 @，留着只为兼容老调用方
  void quietIds;
  void allowedIds;
  void keepOrder;
  const mates = (Array.isArray(roster) ? roster : []).filter((a) => a && a.id);
  if (!mates.length) return [];
  /* 关掉的牌：不说话。不传就是全开（老调用方/测试不用跟着改）。 */
  const on = Array.isArray(enabledIds) ? new Set(enabledIds.map((x) => String(x))) : null;
  const alive = on ? mates.filter((a) => on.has(String(a.id))) : mates;
  /* 开着的就都说，顺序照竖列原样 —— 没有别的判断了 */
  return alive;
}

/**
 * 【已停用】从这句话里认出被点了名的卡。
 *
 * 2026-11-10 主人钦点删掉艾特功能，这个函数不再被调用，但**保留导出**：
 * 老调用方 / 老测试 / 第三方脚本 import 它不会炸。
 * 新代码不许再用它 —— check-group-no-mention.mjs 会拦。
 *
 * 真要恢复艾特（主人哪天改主意），git 历史里 v0.9.46 那份是完整的。
 */
export function parseMentions(text, roster = []) {
  void text;
  void roster;
  return [];
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
