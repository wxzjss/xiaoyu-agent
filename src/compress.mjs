// Context compression: when the history gets too long, fold the old turns into one summary
// message and keep the recent tail verbatim. Nothing is deleted from disk — only the prompt
// gets shorter. The summary is itself merged into later summaries, so it rolls forward.
import { chat } from './llm.mjs';
import { config } from './config.mjs';

/** 摘要消息的标记（只在本地用，不进 API 请求体）。 */
const SUMMARY_FLAG = 'summary';

/** 每条消息的固定结构开销（role / 分隔符等），保守取 4。 */
const PER_MESSAGE_OVERHEAD = 4;

/**
 * 粗估 token 数。实测这个端点：纯中文约 1.45 字符/token，纯英文约 4.67。
 * 按最坏情况（1.5 字符/token）估，宁可高估也不被网关打回来。
 */
export function estimateTokens(messages) {
  let total = 0;
  for (const m of messages) {
    total += PER_MESSAGE_OVERHEAD;
    // content 可能是多模态数组：只取文字段，base64 不计入预算
    const raw = m.content;
    const textOnly = Array.isArray(raw)
      ? raw.filter((p) => p && p.type === 'text').map((p) => p.text).join('\n')
      : raw;
    const parts = [textOnly];
    if (m.tool_calls) for (const tc of m.tool_calls) parts.push(tc.function?.name, tc.function?.arguments);
    for (const p of parts) {
      if (typeof p !== 'string' || !p) continue;
      total += Math.ceil(p.length / 1.5);
    }
  }
  return total;
}

/** 头部两条（system + context）永远不动。 */
function headLength(messages) {
  let n = messages[0]?.role === 'system' ? 1 : 0;
  if (messages[n]?.context) n += 1;
  return n;
}

/**
 * 从尾部往前攒够 keepTokens，得到候选切点，再往前挪到安全位置。
 * 安全 = 不把 assistant(tool_calls) 和它的 tool 结果拆开。
 */
function findCut(messages, start, keepTokens) {
  let acc = 0;
  let cut = messages.length;
  for (let i = messages.length - 1; i >= start; i--) {
    if (acc >= keepTokens) break;
    acc += estimateTokens([messages[i]]);
    cut = i;
  }
  while (cut > start) {
    const at = messages[cut];
    const prev = messages[cut - 1];
    const splitsTool = at?.role === 'tool' || (prev?.role === 'assistant' && prev?.tool_calls?.length);
    if (!splitsTool) return cut;
    cut--;
  }
  return -1;
}

const SUMMARY_SYSTEM = `你是一个对话压缩器。把给你的早期对话压成一份事实清单，供后续继续干活时参考。

要求：
- 中文，纯文本，不要 Markdown 标题。
- 按这几块写：主人要什么 / 已经做完什么（含具体文件路径、命令、数字）/ 还没做完什么 / 关键约束和结论。
- 只写能从对话里确认的事实，不要推测、不要评价、不要客套。
- 数字、路径、文件名、接口名、变量名必须原样保留。
- 尽量短，够后面接着干就行。`;

function renderForSummary(messages) {
  const lines = [];
  for (const m of messages) {
    if (m.role === 'tool') {
      lines.push(`[工具结果] ${String(m.content ?? '').slice(0, 1200)}`);
      continue;
    }
    if (m.role === 'assistant') {
      const calls = (m.tool_calls ?? []).map(
        (tc) => `${tc.function?.name}(${String(tc.function?.arguments ?? '').slice(0, 300)})`,
      );
      const text = String(m.content ?? '').trim();
      if (text) lines.push(`[小鱼] ${text.slice(0, 2000)}`);
      if (calls.length) lines.push(`[调用] ${calls.join(' ')}`);
      continue;
    }
    const tag = m[SUMMARY_FLAG] ? '[早期摘要]' : '[主人]';
    const body = Array.isArray(m.content)
      ? m.content.filter((p) => p && p.type === 'text').map((p) => p.text).join('\n')
      : m.content;
    lines.push(`${tag} ${String(body ?? '').slice(0, 4000)}`);
  }
  return lines.join('\n');
}

/**
 * 压缩历史。就地改 messages，返回一份压缩前后统计。
 * 判定线 = limit * triggerRatio（默认 1M 的 80% = 800k），超了才动手。
 * @param {object} opts
 * @param {Array} opts.messages
 * @param {number} [opts.limit] 上下文上限，默认 config.contextLimit；非有限值 = 关闭
 * @param {number} [opts.triggerRatio] 到上限的几成就触发，默认 config.contextTriggerRatio
 * @param {number} [opts.keepRatio] 压缩后保留的尾部比例，默认 config.contextKeepRatio
 * @param {AbortSignal} [opts.signal]
 * @returns {Promise<{compressed:boolean, before:number, after:number, limit?:number, trigger?:number, removed?:number, kept?:number, reason?:string, error?:string}>}
 */
export async function compressHistory({
  messages,
  limit = config.contextLimit,
  triggerRatio = config.contextTriggerRatio,
  keepRatio = config.contextKeepRatio,
  signal,
} = {}) {
  if (signal?.aborted) return { compressed: false, before: estimateTokens(messages), after: estimateTokens(messages), reason: 'aborted' };

  const before = estimateTokens(messages);
  if (!Number.isFinite(limit) || limit <= 0) {
    return { compressed: false, before, after: before, reason: 'disabled' };
  }
  const ratio = Number.isFinite(triggerRatio) && triggerRatio > 0 && triggerRatio <= 1 ? triggerRatio : 0.8;
  const trigger = Math.floor(limit * ratio);
  if (before <= trigger) {
    return { compressed: false, before, after: before, limit, trigger, reason: 'under-trigger' };
  }

  const start = headLength(messages);
  const keepTokens = Math.max(1, Math.floor(limit * Math.max(0.05, Math.min(0.9, keepRatio))));
  const cut = findCut(messages, start, keepTokens);
  if (cut <= start) return { compressed: false, before, after: before, limit, trigger, reason: 'nothing-safe-to-drop' };

  const old = messages.slice(start, cut);
  const tail = messages.slice(cut);

  let summaryText = '';
  let error;
  try {
    const res = await chat({
      messages: [
        { role: 'system', content: SUMMARY_SYSTEM },
        { role: 'user', content: renderForSummary(old) },
      ],
      signal,
    });
    summaryText = String(res?.choices?.[0]?.message?.content ?? '').trim();
  } catch (err) {
    error = String(err?.message ?? err);
  }

  if (!summaryText) {
    // 摘要失败也要把历史压下来，否则下一次请求直接被网关拒掉。
    summaryText = `（早期 ${old.length} 条对话的自动摘要生成失败${error ? `：${error.slice(0, 120)}` : ''}）`
      + `已丢弃这部分原文，需要细节请让主人重新提供。`;
  }

  const summaryMsg = {
    role: 'user',
    content: `【早期对话摘要 · 原文已压缩】\n${summaryText}`,
    [SUMMARY_FLAG]: true,
  };

  const next = [...messages.slice(0, start), summaryMsg, ...tail];
  messages.length = 0;
  messages.push(...next);

  const after = estimateTokens(messages);
  return { compressed: true, before, after, limit, trigger, removed: old.length, kept: tail.length, ...(error ? { error } : {}) };
}
