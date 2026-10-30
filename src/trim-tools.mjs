/**
 * trim-tools.mjs —— 把「过程」压成「结论」（2026-10-30）
 *
 * 【主人怎么说的】「还有调用工具，调用的内容那一大堆代码也会记在上下文里面吗？
 *   如果是，那么就不能每调用完几次，除非很重要，否则就把调查结果记下然后具体代码内容删吗？」
 *
 * 【量出来的】本会话最近 3 轮：主人正文 221 字、我自己的话 2010 字，
 *   工具参数（命令 + 整份代码）26084 字、工具返回结果 50622 字 ——
 *   过程性内容占了 97%。
 *
 * 也就是说一轮活干下来，上下文里真正值钱的只有三千字，
 * 剩下七万多全是「我刚才看了啥、跑了啥」。这些下一秒就没人再看，
 * 可它们会一直躺在历史里，每次请求都重新烧一遍钱，还把要紧的事稀释掉。
 *
 * 所以：**动手之后，把过程擦掉，只留结论。**
 *   - 工具调用的参数（那一整份代码 diff、那条长命令）→ 擦成「（已执行，内容略）」
 *   - 工具返回的长结果（几万字的文件内容）→ 留头留尾一小截，中间写「略」，
 *     但**摘要类**的结果留多一点（那是结论所在）
 *   - 我自己说过的原话一个字不动 —— 那是判断，不是过程
 *   - 最近几轮的原文一律不碰，刚刚说过的话不能说没就没
 */

import { estimateTokens } from './compress.mjs';

/** 工具结果擦完之后最多留多少字（这是真正要塞回历史的量）。 */
export const KEEP_RESULT_CHARS = 800;

/** 结论类工具：结果本身就是答案，多留一点。 */
const KEEP_MORE = new Set([
  'read_file', 'web_search', 'fetch_url', 'fetch_txt', 'grep', 'search',
  'video_probe', 'video_read', 'look_screen', 'chronicle_search', 'chronicle_read',
  'ask_subagent', 'ask_peer', 'read_peer_mail', 'plan', 'note', 'memory_add',
]);

/** 全过程工具：参数和结果都是过程，擦得最狠。 */
const HARD = new Set(['run_command', 'write_file', 'qq_send', 'send_file']);

/** 调用参数擦完留这么长（够认出是哪条命令）。 */
const ARG_KEEP = 160;

/**
 * 擦一段工具结果。
 * @param {string} content
 * @param {string} name 哪个工具
 */
export function thinToolResult(content, name) {
  const t = String(content ?? '');
  const cap = HARD.has(name) ? Math.floor(KEEP_RESULT_CHARS * 0.5) : KEEP_RESULT_CHARS;
  if (t.length <= cap) return { text: t, saved: 0 };
  const head = Math.floor(cap * 0.55);
  const tail = cap - head;
  const text = `${t.slice(0, head)}\n…（这段过程 ${t.length} 字，已擦掉中间 ${t.length - cap} 字；要翻原话看上面的文件路径/会话说）…\n${t.slice(-tail)}`;
  return { text, saved: t.length - text.length };
}

/**
 * 擦调用的参数（那一整份代码）。
 * 只留「哪个工具 + 前一小截」，认得出来就够了。
 */
export function thinToolArgs(args, name) {
  const s = typeof args === 'string' ? args : JSON.stringify(args ?? '');
  if (s.length <= ARG_KEEP) return s;
  return `${s.slice(0, ARG_KEEP)}…（参数共 ${s.length} 字，已擦掉）`;
}

/**
 * 擦一整段历史里的过程（就地返回新数组，不改原数组）。
 *
 * @param {Array} messages
 * @param {object} [o]
 * @param {number} [o.keepRecent] 最近几条一律不碰（默认 12）
 * @returns {{messages:Array, saved:number, tools:number}}
 */
export function thinHistory(messages, o = {}) {
  const keepRecent = Number.isFinite(o.keepRecent) ? o.keepRecent : 12;
  const n = messages.length;
  const edge = Math.max(0, n - keepRecent);
  const out = new Array(n);
  let saved = 0;
  let tools = 0;
  for (let i = 0; i < n; i++) {
    const m = messages[i];
    if (!m || i >= edge) { out[i] = m; continue; }
    // 工具结果
    if (m.role === 'tool') {
      const name = m.name || m.toolName || '';
      const r = thinToolResult(m.content, name);
      if (r.saved > 0) { saved += r.saved; tools++; out[i] = { ...m, content: r.text }; } else out[i] = m;
      continue;
    }
    // 工具的调用参数
    if (m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length) {
      let hit = false;
      const calls = m.tool_calls.map((c) => {
        const name = c.function?.name || c.name || '';
        const raw = c.function?.arguments ?? c.arguments;
        const thin = thinToolArgs(raw, name);
        if (thin !== raw && typeof thin === 'string') hit = true;
        return {
          ...c,
          function: { ...(c.function || {}), arguments: thin, name },
        };
      });
      if (hit) {
        const before = JSON.stringify(m.tool_calls).length;
        const after = JSON.stringify(calls).length;
        saved += Math.max(0, before - after);
        tools++;
        out[i] = { ...m, tool_calls: calls };
      } else out[i] = m;
      continue;
    }
    out[i] = m;
  }
  return { messages: out, saved, tools };
}

/** 估一下擦完能省多少 token（给判断用）。 */
export function thinSaving(messages, o) {
  const before = estimateTokens(messages);
  const { messages: after, saved } = thinHistory(messages, o);
  return { before, after: estimateTokens(after), chars: saved };
}
