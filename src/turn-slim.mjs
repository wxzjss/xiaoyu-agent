/**
 * 回合内的工具结果瘦身。
 *
 * 【要解决的病】
 * 一个回合里，模型每调一次工具，结果就整段拼进 messages；下一圈把 messages
 * 完整发一遍，于是第 N 圈发出去的是「前 N-1 圈结果之和」。
 *
 * 实测的后果（dsh 量的数，不是猜的）：
 * 同一个会话，prompt_tokens 在 1.4 万 和 861 万 之间跳 —— 差 300 倍。
 * 而那几百万人 token 里，85% 是【前面几圈已经看过的旧工具结果】。
 *
 * 更要命的是它对人设的影响：
 * 模型每圈都在读自己刚读过的几十万字，最新那句话被稀释到几乎看不见。
 * 表现出来就是「每轮都像第一次」—— 时间循环的物理原因就在这儿。
 *
 * 【怎么治】
 * 不删、不丢，只把【旧的】工具结果收成「摘要形态」：
 *   - 最近几圈的：原样留着（模型正要用）
 *   - 更早的：压成「前 2 行 + …共 N 行… + 后 2 行」
 *   - 永远保留「调用过什么工具」这条线索，别让模型以为没调过
 *
 * 【为什么不在压缩那儿做】
 * compressHistory 只在回合开头判一次、且只认「整份历史」。
 * 回合内涨起来的那几百万，它根本看不见。这是两条不同的路，得分开治。
 */

/** 最近几圈的 tool 结果原样留着 —— 模型靠它接着干下一步 */
const KEEP_RECENT_ROUNDS = 2;
/** 老结果缩到前几行 + 后几行 */
const HEAD_LINES = 2;
const TAIL_LINES = 2;
/** 单行最长留多少字符 */
const LINE_MAX = 300;
/** 短于这个长度的结果不值得压（压了也省不了多少，还容易丢信息） */
const MIN_COMPRESS_CHARS = 800;

/**
 * 把一段工具结果压成摘要形态。
 * @param {string} text 原始结果
 * @returns {string}
 */
export function shrinkToolText(text) {
  const s = String(text ?? '');
  if (s.length <= MIN_COMPRESS_CHARS) return s;

  const lines = s.split('\n');
  const clipped = (l) => (l.length > LINE_MAX ? l.slice(0, LINE_MAX) + '…' : l);

  if (lines.length <= HEAD_LINES + TAIL_LINES + 2) {
    // 行数不多但每行很长：按字符砍
    return clipped(s.slice(0, LINE_MAX * (HEAD_LINES + 1))) + `\n…（共 ${s.length} 字符，中间的略）`;
  }

  const head = lines.slice(0, HEAD_LINES).map(clipped);
  const tail = lines.slice(-TAIL_LINES).map(clipped);
  const omitted = lines.length - HEAD_LINES - TAIL_LINES;
  return [...head, `…（中间略过 ${omitted} 行，原文共 ${lines.length} 行 / ${s.length} 字符）…`, ...tail].join('\n');
}

/**
 * 给一份 messages 做「回合内瘦身」。
 *
 * 规矩（三不碰）：
 *   一、不碰主人说的话（role=user）
 *   二、不碰 assistant 的正文（那是它自己的话，也是主人要看的东西）
 *   三、不碰最近 KEEP_RECENT_ROUNDS 圈的 tool 结果（它正要用）
 *
 * 只动更早的那些 tool 结果。
 *
 * 【注意】返回的是新数组、新对象，不改原 messages ——
 * 原 messages 是落盘用的，必须保持完整。这一点别改，
 * 不然主人回来看历史，会发现工具结果被压过，跟当时看到的不一样。
 *
 * @param {Array} messages
 * @returns {{messages:Array, changed:number, savedChars:number}}
 */
export function slimRoundMessages(messages, opts = {}) {
  if (!Array.isArray(messages) || !messages.length) {
    return { messages, changed: 0, savedChars: 0 };
  }

  /**
   * 只瘦「本轮之后」的那部分。
   *
   * 上个回合读过的东西这个回合可能还要用 —— 压了就是失忆。
   * from 由调用方给（本轮那条 user 消息的下标）；没给就整份都算。
   */
  const from = Number.isInteger(opts.from) && opts.from >= 0 ? opts.from : 0;

  // 先找出所有 tool 消息的下标（只认 from 之后的）
  const toolIdxs = [];
  for (let i = from; i < messages.length; i++) {
    if (messages[i] && messages[i].role === 'tool') toolIdxs.push(i);
  }
  if (toolIdxs.length <= KEEP_RECENT_ROUNDS) {
    return { messages, changed: 0, savedChars: 0 };
  }

  // 最近 KEEP_RECENT_ROUNDS 条的保留，前面的都压
  const slimSet = new Set(toolIdxs.slice(0, toolIdxs.length - KEEP_RECENT_ROUNDS));

  let changed = 0;
  let savedChars = 0;
  const out = messages.map((m, i) => {
    if (!slimSet.has(i)) return m;
    if (!m || m.role !== 'tool') return m;
    const raw = m.content;
    // 带图的结果（content 是数组）不动 —— 那是多模态，压了就废了
    if (Array.isArray(raw)) return m;
    const before = String(raw ?? '');
    const after = shrinkToolText(before);
    if (after === before) return m;
    changed++;
    savedChars += before.length - after.length;
    return { ...m, content: after };
  });

  return { messages: changed ? out : messages, changed, savedChars };
}

/**
 * 量一下这份 messages 有多大（字符数 + 粗估 token）。
 *
 * 只写日志、不改逻辑 —— 用来证明「瘦身到底有没有用」。
 * 估算沿用项目里的老办法（1 字符≈1 token，宁高勿低）。
 */
export function measureMessages(messages) {
  if (!Array.isArray(messages)) return { chars: 0, tokens: 0, tools: 0 };
  let chars = 0;
  let tools = 0;
  for (const m of messages) {
    if (!m) continue;
    if (m.role === 'tool') tools++;
    const c = m.content;
    if (typeof c === 'string') chars += c.length;
    else if (Array.isArray(c)) {
      for (const p of c) {
        if (p && typeof p.text === 'string') chars += p.text.length;
        // 图片按一个固定估值算，别真去数字节
        else if (p && p.type === 'image_url') chars += 4000;
      }
    }
  }
  return { chars, tokens: chars, tools };
}
