// Context compression: when the history gets too long, fold the old turns into one summary
// message and keep the recent tail verbatim. Nothing is deleted from disk — only the prompt
// gets shorter. The summary is itself merged into later summaries, so it rolls forward.
import { chat } from './llm.mjs';
import { config } from './config.mjs';
import { effectiveContextLimit } from './settings.mjs';
// 纯净模式：压的时候不做摘要，旧对话直接丢（见 pure.mjs 文件头的理由）。
import { pureModeOn } from './pure.mjs';

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

/** 摘要请求自己的超时（毫秒）：超了就按「摘要失败」走保底路径，不拖死对话。 */
const SUMMARY_TIMEOUT_MS = 45000;

/** 摘要最多喂进去多少字符：太长的话既不省钱也容易超时。 */
const SUMMARY_INPUT_MAX = 24000;

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
  // 整体超长就从最早的地方裁掉：摘要看最近的就有用，远古的聊天细节不值钱
  let text = lines.join('\n');
  if (text.length > SUMMARY_INPUT_MAX) {
    text = '（更早的部分太长，已裁剪）\n' + text.slice(text.length - SUMMARY_INPUT_MAX);
  }
  return text;
}

/**
 * 压缩历史。就地改 messages，返回一份压缩前后统计。
 *
 * 判定线**就是** limit 本身：设置里填多少，涨到多少就压，不打折。
 * （以前是 limit * triggerRatio，默认 0.8 —— 填 64000 实际 51200 就动手，
 *   主人填的数字和真实行为对不上，容易误判。现在填多少就是多少。）
 *
 * 压完之后还要保证真的落到 limit 以内：摘要那条消息本身也占 token，
 * 所以先算好摘要的开销再从尾部预算里扣掉，扣完还不够就把尾巴再裁短。
 *
 * @param {object} opts
 * @param {Array} opts.messages
 * @param {number} [opts.limit] 上下文上限，默认 config.contextLimit；非有限值 = 关闭
 * @param {number} [opts.triggerRatio] 兼容旧参数，只允许 1（或省略）
 * @param {number} [opts.keepTokens] 压缩后原样保留的尾部 token 预算
 * @param {AbortSignal} [opts.signal]
 * @returns {Promise<{compressed:boolean, before:number, after:number, limit?:number, trigger?:number, removed?:number, kept?:number, reason?:string, error?:string}>}
 */
export async function compressHistory({
  messages,
  // 默认取「设置面板里填的那个阈值」，没填才回落到 .env 的 CONTEXT_LIMIT
  limit = effectiveContextLimit(),
  // 保留为兼容老调用方：填多少压多少，所以触发线就是 limit（1.0），
  // 任何小于 1 的值都会让「填的数字」变成假的，直接忽略。
  triggerRatio = 1,
  // 尾部预算：优先用显式的 token 数，其次 config.contextKeepTokens，
  // 最后才回落到「limit 的几成」（老配置）。
  keepTokens,
  signal,
} = {}) {
  if (signal?.aborted) return { compressed: false, before: estimateTokens(messages), after: estimateTokens(messages), reason: 'aborted' };

  const before = estimateTokens(messages);
  if (!Number.isFinite(limit) || limit <= 0) {
    return { compressed: false, before, after: before, reason: 'disabled' };
  }
  // 填多少就是多少：不再乘 0.8
  const trigger = Math.floor(limit);
  if (before <= trigger) {
    return { compressed: false, before, after: before, limit, trigger, reason: 'under-trigger' };
  }

  const start = headLength(messages);
  // 头部（system + context）本身就要占掉一块，剩下的才是能给「摘要 + 尾巴」的预算
  const headTokens = estimateTokens(messages.slice(0, start));

  /**
   * 摘要那条消息大约占多少 token —— 先按保守值预留，算完再按真实长度校准。
   */
  const SUMMARY_RESERVE = 600;
  const budget = Math.max(1, trigger - headTokens);
  const keepTarget = clampKeep(resolveKeepTokens({ keepTokens, limit }), Math.max(1, budget - SUMMARY_RESERVE));

  const cut = findCut(messages, start, keepTarget);
  if (cut <= start) return { compressed: false, before, after: before, limit, trigger, reason: 'nothing-safe-to-drop' };

  const old = messages.slice(start, cut);
  const tail = messages.slice(cut);

  let summaryText = '';
  let error;
  // 纯净模式：不做摘要，直接把旧对话丢掉。
  //
  // 为什么：主人开纯净模式就是不想让模型被前面那一大堆设定和往事牵着走，
  // 留一句「早期对话摘要」等于又塞了一坨上下文进去。干脆不生成、不留。
  const pure = pureModeOn();
  if (pure) {
    summaryText = '';
    error = undefined;
  }
  // 摘要本身也要有上限：模型不回话不能把整轮对话一起拖死
  const ac = new AbortController();
  const onAbort = () => { try { ac.abort(); } catch {} };
  if (signal) {
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }
  const timer = setTimeout(() => { try { ac.abort(); } catch {} }, SUMMARY_TIMEOUT_MS);
  if (!pure) {
    try {
      const res = await chat({
        messages: [
          { role: 'system', content: SUMMARY_SYSTEM },
          { role: 'user', content: renderForSummary(old) },
        ],
        signal: ac.signal,
      });
      summaryText = String(res?.choices?.[0]?.message?.content ?? '').trim();
    } catch (err) {
      error = String(err?.message ?? err);
    } finally {
      clearTimeout(timer);
      if (signal) { try { signal.removeEventListener('abort', onAbort); } catch {} }
    }
  } else {
    clearTimeout(timer);
    if (signal) { try { signal.removeEventListener('abort', onAbort); } catch {} }
  }

  if (!pure && !summaryText) {
    // 摘要失败也要把历史压下来，否则下一次请求直接被网关拒掉。
    summaryText = `（早期 ${old.length} 条对话的自动摘要生成失败${error ? `：${error.slice(0, 120)}` : ''}）`
      + `已丢弃这部分原文，需要细节请让主人重新提供。`;
  }

  // 纯净模式下不生成 summary 那条，直接把旧的一段扔掉
  const makeSummary = () => (pure ? null : {
    role: 'user',
    content: `【早期对话摘要 · 原文已压缩】\n${summaryText}`,
    [SUMMARY_FLAG]: true,
  });

  /**
   * 落到 limit 以内。摘要那条消息自己也要占位置，
   * 所以按「head + summary + tail」重算实际大小；超了就从尾巴最早的地方再丢。
   */
  let keep = tail.slice();
  let dropped = 0;
  let guard = 0;
  // 纯净模式没有 summaryMsg 这一条；用空数组拼，`...[]` 就是什么都不插
  const summaryMsg = makeSummary();
  const withSummary = (tailPart) => (
    summaryMsg ? [...messages.slice(0, start), summaryMsg, ...tailPart] : [...messages.slice(0, start), ...tailPart]
  );
  while (guard++ < 200) {
    const next = withSummary(keep);
    if (estimateTokens(next) <= trigger) break;
    if (!keep.length) break;
    // 一次至少丢一条；保持工具调用和它的结果不拆开
    let cutAt = 1;
    while (cutAt < keep.length) {
      const at = keep[cutAt];
      const prev = keep[cutAt - 1];
      const splitsTool = at?.role === 'tool' || (prev?.role === 'assistant' && prev?.tool_calls?.length);
      if (!splitsTool) break;
      cutAt++;
    }
    keep = keep.slice(cutAt);
    dropped += cutAt;
  }

  const next = withSummary(keep);
  messages.length = 0;
  messages.push(...next);

  const after = estimateTokens(messages);
  return {
    compressed: true, before, after, limit, trigger,
    removed: old.length + dropped, kept: keep.length,
    ...(after > trigger ? { reason: 'still-over-limit' } : {}),
    ...(error ? { error } : {}),
  };
}

/**
 * 压缩后原样保留的尾部有多少 token。
 *
 * 这个数**跟着 limit 走**：主人填 64000，就该留一大段最近对话原样开着；
 * 填 8000 才该只留一点点。固定成 8000 的问题是填多大都只留 8000，
 * 长上下文等于白给 —— 历史上 64k 的设置压完只剩 8k，等于每次都在重头读摘要。
 *
 * 取 limit 的一半，再用 CONTEXT_KEEP_TOKENS（默认 8000）当下限兜底，
 * 老配置里的 CONTEXT_KEEP_RATIO 只剩最后一道兜底。
 */
function resolveKeepTokens({ keepTokens, limit }) {
  const direct = Number(keepTokens);
  if (Number.isFinite(direct) && direct > 0) return direct;
  const r = Number(config.contextKeepRatio);
  const ratio = Number.isFinite(r) && r > 0 && r <= 1 ? r : 0.5;
  const fromLimit = Math.floor(limit * ratio);
  // 下限：再小也得留够「最近几句」和那两条头部，否则压完等于失忆
  const floorTokens = Number(config.contextKeepTokens);
  const floor = Number.isFinite(floorTokens) && floorTokens > 0 ? floorTokens : 8000;
  return Math.max(floor, fromLimit);
}

/** 预算不能超过「limit 减去头和摘要之后剩下的」，否则压了也白压。 */
function clampKeep(want, max) {
  const w = Number(want);
  if (!Number.isFinite(w) || w <= 0) return max;
  return Math.min(w, max);
}

