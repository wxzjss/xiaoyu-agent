// OpenAI-compatible chat client with streaming (SSE) support.
// 端点 / key / 模型名都从 models.mjs 取：界面里能换，.env 只是其中一套。
import { activeEndpoint } from './models.mjs';
import { levelFor, resolveLevel, withEffort, isThinkingUnsupported } from './thinking.mjs';
import { endpointFor } from './models.mjs';
import { getOverride } from './session-overrides.mjs';

/**
 * 这个错误是不是「连接被中途掐断」。
 *
 * undici（Node 内置 fetch）在流被对端关闭时会抛 TypeError: terminated，
 * cause 往往是 ECONNRESET / UND_ERR_SOCKET，或者干脆什么都没有。
 * 这类错误跟「key 错」「模型不存在」完全不是一回事，必须自己接住。
 */
export function isStreamDropError(err) {
  if (!err) return false;
  const name = String(err.name ?? '');
  const msg = String(err.message ?? '');
  const causeCode = String(err.cause?.code ?? '');
  const causeMsg = String(err.cause?.message ?? '');
  if (name === 'AbortError') return false; // 那是用户主动停的，别当网络抖动
  if (/terminated/i.test(msg)) return true;
  if (/ECONNRESET|EPIPE|UND_ERR_SOCKET|ETIMEDOUT|socket hang up/i.test(causeCode)) return true;
  if (/ECONNRESET|EPIPE|socket hang up|other side closed/i.test(causeMsg)) return true;
  if (/fetch failed/i.test(msg) && !/HTTP \d/.test(msg)) return true;
  return false;
}

function headers(ep) {
  const h = { 'Content-Type': 'application/json' };
  if (ep.apiKey) h.Authorization = 'Bearer ' + ep.apiKey;
  return h;
}

/**
 * 这次请求该用哪套模型参数。
 *
 * 会话里临时切过模型就用它 —— 通过 endpointFor 只读取那一套，**绝不改 activeId**，
 * 所以别的会话和右上角面板都不受影响。
 *
 * @param {string} [sessionId]
 */
function endpointForForSession(sessionId) {
  if (!sessionId) return null;
  const ov = getOverride(sessionId);
  if (!ov.modelId) return null;
  return endpointFor(ov.modelId); // 模型被删了就返回 null，下面会回落到默认那套
}

/**
 * Stream one chat completion.
 * Yields {type:'text', text} | {type:'reasoning', text} | {type:'tool_calls', toolCalls} | {type:'usage', usage}
 */
export async function* streamChat({ messages, tools, signal, temperature, sessionId }) {
  const ep = endpointForForSession(sessionId) ?? activeEndpoint();
  const body = {
    model: ep.model,
    messages,
    stream: true,
    stream_options: { include_usage: true },
  };
  if (tools?.length) body.tools = tools;
  if (temperature !== undefined) body.temperature = temperature;

  /**
   * 思考档位：模型自己的设置优先，否则用全局；auto 按这轮有没有工具现算。
   * 有工具 = 要干活，给 high；纯聊天给 low。
   *
   * 关键：**关档位必须显式发 thinking:{type:disabled}**，不能靠省略字段——
   * 这个网关省略字段就是默认开思考（详见 thinking.mjs 的 fieldsForLevel）。
   */
  const ov = sessionId ? getOverride(sessionId) : {};
  // 会话自己设了强度就用它；没设就跟这个模型在右上角里的设置走
  const cfgLevel = ov.level || levelFor(ep.id ?? 'env');
  const effort = resolveLevel(cfgLevel, { hasTools: Boolean(tools?.length) });

  // 只有「模型不支持思考」才降；key 错 / 网络断 / 值不合法都直接抛。
  let res = null;
  let lastStatus = 0;
  let lastText = '';
  let level = effort;
  for (let guard = 0; guard < 8; guard++) {
    const payload = withEffort(body, level).body;
    const r = await fetch(ep.baseURL + '/chat/completions', {
      method: 'POST',
      headers: headers(ep),
      body: JSON.stringify(payload),
      signal,
    });
    if (r.ok) {
      res = r;
      break;
    }
    lastStatus = r.status;
    lastText = await r.text().catch(() => '');
    if (!isThinkingUnsupported(r.status, lastText)) {
      throw new Error(`LLM HTTP ${r.status}: ${lastText.slice(0, 500)}`);
    }
    // 模型不支持思考：退到「什么都不发」
    if (!level) throw new Error(`LLM HTTP ${lastStatus}: ${lastText.slice(0, 500)}`);
    level = null;
  }

  if (!res) {
    throw new Error(`LLM HTTP ${lastStatus}: ${lastText.slice(0, 500)}`);
  }

  const acc = new Map(); // index -> {id, name, arguments}
  const decoder = new TextDecoder();
  let buf = '';

  /**
   * 断流自愈：一次流式请求最多续 2 次。
   *
   * 已经交给调用方的内容（yield 出去的）不会重复——这里只把「还没读到的那部分」
   * 从断点继续读完。续的时候带着已收到的内容再去要一次，模型会把话写完。
   */
  try {
    for await (const chunk of res.body) {
    buf += decoder.decode(chunk, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).replace(/\r$/, '');
      buf = buf.slice(nl + 1);
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      let json;
      try { json = JSON.parse(payload); } catch { continue; }

      if (json.usage) yield { type: 'usage', usage: json.usage };
      const delta = json.choices?.[0]?.delta;
      if (!delta) continue;

      const reasoning = delta.reasoning_content ?? delta.reasoning;
      if (reasoning) yield { type: 'reasoning', text: reasoning };
      if (delta.content) yield { type: 'text', text: delta.content };

      for (const tc of delta.tool_calls ?? []) {
        const idx = tc.index ?? 0;
        const cur = acc.get(idx) ?? { id: '', name: '', arguments: '' };
        if (tc.id) cur.id = tc.id;
        if (tc.function?.name) cur.name += tc.function.name;
        if (tc.function?.arguments) cur.arguments += tc.function.arguments;
        acc.set(idx, cur);
      }

      const finish = json.choices?.[0]?.finish_reason;
      if (finish === 'tool_calls' && acc.size) {
        yield { type: 'tool_calls', toolCalls: [...acc.values()].filter((t) => t.name) };
        acc.clear();
      }
    }
  }

    if (acc.size) yield { type: 'tool_calls', toolCalls: [...acc.values()].filter((t) => t.name) };
  } catch (err) {
    // 流被掐断了。把已经攒好的 tool_calls 先交出去，别让这一轮白跑；
    // 然后往上抛一个带标记的错，交给 agent 那边决定「续跑」。
    if (acc.size) {
      try {
        yield { type: 'tool_calls', toolCalls: [...acc.values()].filter((t) => t.name) };
        acc.clear();
      } catch {}
    }
    if (isStreamDropError(err)) {
      const e = new Error('流被中途掐断（' + (String(err.cause?.code ?? err.message ?? err)) + '）');
      e.streamDropped = true;
      e.received = buf.length;
      throw e;
    }
    throw err;
  }
}

/** Non-streaming helper used by the context summarizer and smoke checks. */
export async function chat({ messages, tools, signal }) {
  const ep = activeEndpoint();
  const body = { model: ep.model, messages };
  if (tools?.length) body.tools = tools;

  // chat 也要带档位（摘要、连通测试都走这里）；关档位同样显式发 disabled
  const ov2 = sessionId ? getOverride(sessionId) : {};
  const effort = resolveLevel(ov2.level || levelFor(ep.id ?? 'env'), { hasTools: Boolean(tools?.length) });
  let lastStatus = 0;
  let lastText = '';
  let level = effort;
  for (let guard = 0; guard < 8; guard++) {
    const payload = withEffort(body, level).body;
    const res = await fetch(ep.baseURL + '/chat/completions', {
      method: 'POST',
      headers: headers(ep),
      body: JSON.stringify(payload),
      signal,
    });
    if (res.ok) return res.json();
    lastStatus = res.status;
    lastText = await res.text().catch(() => '');
    if (!isThinkingUnsupported(res.status, lastText)) {
      throw new Error(`LLM HTTP ${lastStatus}: ${lastText.slice(0, 500)}`);
    }
    if (!level) break;
    level = null;
  }
  throw new Error(`LLM HTTP ${lastStatus}: ${lastText.slice(0, 500)}`);
}
