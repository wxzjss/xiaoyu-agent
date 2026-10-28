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
  const pick = (Array.isArray(messages) ? messages : []).filter(usable).slice(-HISTORY_LIMIT);
  const out = [{ role: 'system', content: buildSystemPrompt({ sessionId, agentId: meId }) }];
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
