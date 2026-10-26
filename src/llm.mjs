// OpenAI-compatible chat client with streaming (SSE) support.
// 端点 / key / 模型名都从 models.mjs 取：界面里能换，.env 只是其中一套。
import { activeEndpoint } from './models.mjs';
import { levelFor, resolveLevel, withEffort, isThinkingUnsupported } from './thinking.mjs';
import { endpointFor } from './models.mjs';
import { getOverride } from './session-overrides.mjs';
import { withTimeout, stallGuard, guardedStream, LLM_IDLE_MS } from './deadline.mjs';

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
 * 把消息整理成「只带模型该看的东西」再发出去。
 *
 * 【为什么必须有这一步】
 * 我们把内部标记都塞在消息对象上（下划线开头）：`_whale` / `_tale` / `_say` /
 * `_usage` / `_mem` / `_ws` / `_text` / `_out` / `_internal` / `_recovered` …
 * 直接 `messages` 原样塞进请求体，模型下次读历史就看见了。
 *
 * 最要命的是 `_tale`：那是「这条是小鲸说的」的标记。
 * 主人要的是「我能一眼认出来，但她自己不能意识到这件事」——
 * 她要是看见历史里自己那条带着 `_tale: {who:'小鲸'}`，立刻就知道
 * 「原来我说的话是被单独标出来的」，那套「不像工具」的戏就演不下去了。
 *
 * 所以：只放行 `role / content / name / tool_calls / tool_call_id`。
 * 万一哪天有人加了新字段忘了这里，后果是「模型看见了内部字段」，
 * 不是「消息丢了内容」—— 这个方向出错更安全。
 */
const WIRE_KEYS = ['role', 'content', 'name', 'tool_calls', 'tool_call_id'];
export function wireMessage(m) {
  if (!m || typeof m !== 'object') return m;
  const out = {};
  for (const k of WIRE_KEYS) {
    if (m[k] !== undefined && m[k] !== null) out[k] = m[k];
  }
  // 网关不接受 content:null（有些连字段缺了都报错），带工具调用的那种补成空串
  if (out.role === 'assistant' && (out.content === undefined || out.content === null)) out.content = '';
  if (out.role === 'tool' && out.content === undefined) out.content = '';
  return out;
}
export function wireMessages(messages) {
  return Array.isArray(messages) ? messages.map(wireMessage) : messages;
}

/**
 * 这个会话实际会用哪个模型的**名字**。
 *
 * 压缩阈值设成「自动」时要按模型窗口算水位，而窗口从 32k 到 1M 差得远，
 * 所以必须在调模型之前就知道用哪个。判断顺序跟 streamChat 完全一致：
 * 会话里临时切过模型 → 用它；否则用全局默认那一套。
 *
 * @param {string} [sessionId]
 * @returns {string} 模型名（认不出来时返回空串）
 */
export function modelNameForSession(sessionId) {
  const ep = endpointForForSession(sessionId) ?? activeEndpoint();
  return String(ep?.model ?? '');
}

/**
 * Stream one chat completion.
 * Yields {type:'text', text} | {type:'reasoning', text} | {type:'tool_calls', toolCalls} | {type:'usage', usage}
 */
export async function* streamChat({ messages, tools, signal, temperature, sessionId }) {
  const ep = endpointForForSession(sessionId) ?? activeEndpoint();
  const body = {
    model: ep.model,
    // 只发模型该看的那几个字段（内部标记一律剥掉，见上方 wireMessage 的注释）
    messages: wireMessages(messages),
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
    /**
     * 【静默闸：建了连接却一个字节都不吐，不能永远等】
     *
     * 真发生过：网关接了连接、握手也成了，然后就没有然后了 —— 不报错、不断开、
     * 不吐字节。fetch 自己不会超时（Node 的 fetch 没有默认超时），下面的读取
     * 就一直挂着。而 agent 那两道闸（哑转闸、整轮时间闸）只在「每一轮开头」判
     * 一次，卡在这儿走不到检查点 —— 主人看到的就是界面停在半句话上，一直不动。
     *
     * LLM_IDLE_MS 管「响应头回来之前」这段静默（默认 5 分钟）。头回来之后、
     * 正在吐字那段由下面的看门狗 StallWatch 管，两边不重叠。
     */
    const r = await withTimeout(
      fetch(ep.baseURL + '/chat/completions', {
        method: 'POST',
        headers: headers(ep),
        body: JSON.stringify(payload),
        signal,
      }),
      LLM_IDLE_MS,
      { what: '等上游开始回话' },
    );
    if (r.ok) {
      res = r;
      break;
    }
    lastStatus = r.status;
    lastText = await withTimeout(r.text().catch(() => ''), LLM_IDLE_MS, { what: '读上游的错误正文' });
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
    /**
     * 【流到一半不动了，也得能认输】
     *
     * 上面那道静默闸只管到「响应头回来」。头回来之后还有更难看的僵死：
     * 吐了半句，然后不吐了、不结束、也不报错，连接就那么挂着 —— 真碰上过。
     *
     * 看门狗：一个定时器盯全程，每收到一块就重置。静默超窗就取消这条流，
     * 于是 for-await 抛错、落进下面的 catch —— 恰好就是已有的「流被中途掐断」
     * 那条路，上层带着已收到的内容去续读，不必另写一套恢复逻辑。
     */
    // 注意：这里别再调 res.body.cancel()。guardedStream 已经拿住了 reader，
    // 外部 cancel 会抛 ERR_INVALID_STATE（ReadableStream is locked）把进程带走。
    const guard = stallGuard({
      what: '上游往这边吐字',
      limitMs: LLM_IDLE_MS,
    });
    for await (const chunk of guardedStream(res.body, guard)) {
    guard.beat('收到数据块');
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
  } catch (err) {
    // 流被掐断了。把已经攒好的 tool_calls 先交出去，别让这一轮白跑；
    // 然后往上抛一个带标记的错，交给 agent 那边决定「续跑」。
    if (acc.size) {
      try {
        yield { type: 'tool_calls', toolCalls: [...acc.values()].filter((t) => t.name) };
        acc.clear();
      } catch {}
    }
    // 看门狗取消流之后抛出来的错，语义就是「静了太久」，跟真断线一样走续读
    const stalled = err?.name === 'AbortError' || /cancel/i.test(String(err?.message ?? ''));
    if (isStreamDropError(err) || stalled) {
      const e = new Error('流被中途掐断（' + (String(err.cause?.code ?? err.message ?? err)) + '）');
      e.streamDropped = true;
      e.received = buf.length;
      throw e;
    }
    throw err;
  }
}

/** Non-streaming helper used by the context summarizer and smoke checks. */
export async function chat({ messages, tools, signal, sessionId = '' }) {
  const ep = activeEndpoint();
  const body = { model: ep.model, messages: wireMessages(messages) };
  if (tools?.length) body.tools = tools;

  // chat 也要带档位（摘要、连通测试都走这里）；关档位同样显式发 disabled
  //
  // sessionId 要从参数里来 —— 以前这里直接引用了一个不存在于本作用域的 sessionId，
  // 一进来就抛 ReferenceError。后果特别隐蔽：压缩上下文时的摘要调用永远失败，
  // 只能吞成"摘要生成失败"的降级文案；「测连通」也一起报错。
  // 不传就当没有会话级覆盖，退回全局档位。
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
