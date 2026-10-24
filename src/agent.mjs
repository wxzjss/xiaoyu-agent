// The agent loop: call model -> run tools -> feed results back -> repeat.
import { streamChat } from './llm.mjs';
import { inflateHistory } from './attach.mjs';
import { toolSchemas, enabledToolSchemas, runTool, setToolContext, beginOutbox } from './tools.mjs';
import { config } from './config.mjs';
import { buildSystemPrompt, setToolLister } from './persona.mjs';
import { pureModeOn, setPureToolLister } from './pure.mjs';
import { compressHistory } from './compress.mjs';

// persona.mjs 不能静态 import tools.mjs（tools.mjs 反过来 import 了 persona，静态成环会炸），
// 所以「当前有哪些工具」靠这里注入。工具清单是**从 schema 现读**的，不是手抄的第二份文案：
// 新增工具自动出现在系统提示里，关掉功能自动消失。
setToolLister(() => enabledToolSchemas());
// 纯净模式的提示里也要报工具清单，同一个来源，不走第二份文案。
setPureToolLister(() => enabledToolSchemas());
import {
  getRetry429,
  bumpStreak,
  resetStreak,
  streakOf,
  inCooldown,
  startCooldown,
  isRateLimited,
  retryDelay,
  sleep,
  handoffSummary,
  handoffMessage,
} from './retry429.mjs';

/**
 * Some OpenAI-compatible gateways drop `system` messages entirely (verified against the
 * configured endpoint: a 1.9k-char system prompt reported prompt_tokens=57, while the same
 * text as a user message reported ~1400). So the instructions travel twice: once as `system`
 * for well-behaved providers, and once as the first `user` message, which no gateway discards.
 */
/**
 * 这个错是不是「流半路断了」：网关掐连接、网络抖动、socket hang up。
 * 跟 429 不一样——不降档、不换会话，而是**接着要**。
 */
function isStreamDropped(err) {
  if (!err) return false;
  if (err.name === 'AbortError') return false;
  const m = String(err.message ?? err);
  return /terminated|aborted|socket hang up|other side closed|ECONNRESET|fetch failed|premature close|UND_ERR_SOCKET|network error/i.test(m);
}

const CONTEXT_PREAMBLE = '下面是本次对话的设定与规则，从现在起一直有效，直到我明确要求更换。接下来才是我要说的话。';

/**
 * The rules text, framed for delivery as a user-role context message.
 *
 * 为什么要把规则发两遍（system 一遍、user 一遍）：很多网关会悄悄丢掉 system，
 * 只发 system 就等于没发规矩。所以副本这一趟是必要的。
 *
 * 纯净模式例外：这时候「规则」只剩一条长度要求，没必要再套一层
 * 「下面是本次对话的设定与规则…」的前言（那句话本身就是人设腔），
 * 而且一份丢了也不影响（它只是让你答短点，不是底线）。所以直接返回空。
 */
export function contextMessage(sessionId = 'default', opts = {}) {
  if (pureModeOn()) return '';
  const rules = buildSystemPrompt({ sessionId, ...opts });
  if (!rules) return '';
  return `${CONTEXT_PREAMBLE}\n\n${rules}`;
}

/** The full rules text: persona card + user rules + 底线/安全词 + live plan progress. */
export function systemPrompt(sessionId = 'default', opts = {}) {
  return buildSystemPrompt({ sessionId, ...opts });
}

/**
 * @param {object} opts
 * @param {AbortSignal} [opts.signal]  user pressed 停止 -> abort the loop
 * @param {Array} opts.messages  conversation (mutated: assistant/tool turns appended)
 * @param {string} [opts.sessionId]  session whose plan board the tools use
 * @param {boolean} [opts.refreshSystem]  rebuild the system prompt + context message
 * @param {boolean} [opts.safeMode]  current turn hit a safe word -> persona演出 off
 * @param {string} [opts.safeWord]  which safe word fired (each word can have its own note)
 * @param {(ev:object)=>void} [opts.onEvent]
 */
export async function runAgent({ messages, signal, sessionId = 'default', refreshSystem = true, safeMode = false, safeWord = '', onEvent = () => {}, snap = null }) {
  let usageTotal = null;

  setToolContext(sessionId, snap, signal);
  // 这一轮发出去的文件（send_file 登记）先开个筐，跑完交回去
  const outbox = beginOutbox();

  if (refreshSystem) {
    const text = systemPrompt(sessionId, { safeMode, safeWord });
    const ctx = contextMessage(sessionId, { safeMode, safeWord });
    // 纯净模式：text 和 ctx 都是空的。这时候一条 system、一条 context 都不该发 ——
    // 空 system 有的网关会直接 400，只有前言的 context 更是纯噪音。
    // 所以先把历史里残留的那两条清掉，再把对话本身整理好。
    if (!text && !ctx) {
      const body = messages.filter((m) => {
        if (m?.role === 'system' && !String(m.content ?? '').trim()) return false;
        if (m?.role === 'system') return false;   // 纯净模式下一条 system 都不要，不是只删空的
        if (m?.context) return false;
        return true;
      });
      messages.length = 0;
      messages.push(...body);
    } else {
      // 走到这里说明 text 有东西（纯净模式那条空分支在上面拦掉了）
      if (messages[0]?.role === 'system') messages[0].content = text;
      if (messages[1]?.role === 'user' && messages[1].context) {
        messages[1].content = ctx;
      } else {
        // First run (or the history was trimmed): (re)insert the context message right after system.
        const rest = messages.filter((m) => m !== messages[0] || m.role !== 'system');
        const sys = messages[0]?.role === 'system' ? [{ role: 'system', content: text }] : [];
        const withoutCtx = rest.filter((m) => !m.context);
        messages.length = 0;
        messages.push(...sys, { role: 'user', content: ctx, context: true }, ...withoutCtx);
      }
    }
  }

  // maxRounds 可以被设成 Infinity（不限）：那就一直跑到模型自己收尾，或用户点「停止」。
  for (let round = 0; round < config.maxRounds; round++) {
    // 每轮调模型前都量一下历史；超了就把旧对话折成摘要。没超就什么都不做（不额外花钱）。
    const compressed = await compressHistory({ messages, signal });
    if (compressed.compressed) {
      onEvent({
        type: 'compressed',
        before: compressed.before,
        after: compressed.after,
        limit: compressed.limit ?? null,
        trigger: compressed.trigger ?? null,
        removed: compressed.removed,
        error: compressed.error ?? null,
      });
    }
    if (signal?.aborted) {
      onEvent({ type: 'aborted' });
      return { text: '', usage: usageTotal, aborted: true, files: outbox };
    }
    let text = '';
    let reasoning = '';
    let toolCalls = [];
    let usage = null;

    // 图片在本机是路径，调模型前才读成 base64；历史本身不动
    /**
     * 撞限流（429 / TPM / 配额）不就地失败：
     * 先按退避等一会儿重试；连续失败到阈值就交出去，让 server 换个新会话接着跑。
     */
    const cfg429 = getRetry429();
    let handedOff = false;
    /** 这一轮里「流断掉又续上」了几次，别无限续 */
    let dropRetries = 0;

    for (let attempt = 0; ; attempt++) {
      try {
        for await (const ev of streamChat({
          messages: inflateHistory(messages),
          tools: enabledToolSchemas(),
          signal,
          sessionId, // 让「会话级模型/思考强度」生效
        })) {
          if (ev.type === 'text') {
            text += ev.text;
            onEvent({ type: 'text', text: ev.text });
          } else if (ev.type === 'reasoning') {
            reasoning += ev.text;
            onEvent({ type: 'reasoning', text: ev.text });
          } else if (ev.type === 'tool_calls') {
            toolCalls = ev.toolCalls;
          } else if (ev.type === 'usage') {
            usage = ev.usage;
          }
        }
        // 成功了就把连续失败清零
        resetStreak(sessionId);
        resetStreak(sessionId + ':drop');
        break;
      } catch (err) {
        if (signal?.aborted) throw err;

        const status = Number(err?.status ?? 0);
        const text_ = String(err?.text ?? err?.message ?? '');
        // 流被掐断：这一轮已经吐出来的字不能丢，先记进历史，然后接着跑
        if (isStreamDropped(err)) {
          const partial = text.trim();
          const n = bumpStreak(sessionId + ':drop');

          if (n > 5) {
            throw new Error('连接一直断（已经重试 5 次了）。先停一下，检查网络，或者稍后再让我接着写。');
          }

          if (partial) {
            // 半截话作为 assistant 落进历史；再补一句指令，让模型知道从哪接着写，
            // 而不是把那半截话当成「说完了」重新开个头。
            messages.push({ role: 'assistant', content: partial });
            messages.push({
              role: 'user',
              content: '（上一句因为网络断了被截断，请从断开的地方直接接着往下写，不要重复已经写过的内容，也不要解释。）',
              _internal: true,
            });
            onEvent({ type: 'text', text: '\n\n（连接断了一下，接着往下写…）\n\n' });
          }

          const wait = retryDelay(Math.min(n, 3));
          onEvent({ type: 'retry', reason: 'stream_drop', attempt: n, waitMs: wait });
          await sleep(wait);
          continue; // 回到 for(attempt) 开头，重新发这次请求
        }

        const limited = isRateLimited(status, text_) || /LLM HTTP 429/.test(text_);



        if (!limited || !cfg429.enabled) throw err;

        const n = bumpStreak(sessionId);

        // 到阈值：交出去换会话（不在这里换，server 那边才管得住会话）
        if (n >= cfg429.migrateThreshold) {
          handedOff = true;
          const summary = handoffSummary(messages);
          throw Object.assign(new Error('撞限流太多次，换会话接着跑'), {
            rateLimited: true,
            handoff: true,
            streak: n,
            summary,
            originalTask: messages.find((m) => m.role === 'user' && !m.context)?.content ?? '',
          });
        }

        // 还没到阈值：退避重试
        if (attempt >= cfg429.maxRetries) {
          throw Object.assign(err, { rateLimited: true, streak: n });
        }
        const wait = retryDelay(attempt + 1);
        onEvent({ type: 'retry', reason: 'rate_limit', attempt: attempt + 1, waitMs: wait, streak: n });
        if (!config.quietRetry) console.log(`[429] 第 ${attempt + 1} 次重试，等 ${wait}ms（连续 ${n} 次）`);
        await sleep(wait);
      }
    }
    if (handedOff) break;

    if (usage) usageTotal = sumUsage(usageTotal, usage);

    if (!toolCalls.length) {
      messages.push({ role: 'assistant', content: text });
      return { text, usage: usageTotal, files: outbox };
    }

    const assistantMsg = {
      role: 'assistant',
      content: text || null,
      tool_calls: toolCalls.map((tc, i) => ({
        id: tc.id || `call_${round}_${i}`,
        type: 'function',
        function: { name: tc.name, arguments: tc.arguments || '{}' },
      })),
    };
    messages.push(assistantMsg);

    for (const call of assistantMsg.tool_calls) {
      onEvent({ type: 'tool_start', id: call.id, name: call.function.name, args: call.function.arguments });
      const { ok, output } = await runTool(call.function.name, call.function.arguments);
      onEvent({ type: 'tool_end', id: call.id, name: call.function.name, ok, output });
      messages.push({
        role: 'tool',
        tool_call_id: call.id,
        content: ok ? output : `ERROR: ${output}`,
      });
      /**
       * 一个工具跑完就检查一次「是不是被叫停了」。
       *
       * 【为什么必须在这里查】
       * abort 只能掐断「正在等网络」的 fetch，掐不断一个已经跑起来的工具
       * （runTool 是同步/异步混着来的，比如 Start-Sleep -Seconds 40 就得等满 40 秒）。
       * 以前不查，主人点「停止」或者点「退出」之后，agent 还老老实实把剩下七个工具
       * 一个一个跑完才肯回来 —— 那个 finally 里的 saveSession 就一直不执行，
       * 于是磁盘上永远只有主人那句话，看起来像「她什么都没回」。
       * 现在跑完手上这一个就停，已经说过的话照样进 finally 落盘。
       */
      if (signal?.aborted) {
        onEvent({ type: 'aborted' });
        return { text, usage: usageTotal, aborted: true, files: outbox };
      }
    }
  }

  // 只有设了具体上限才会走到这里；不限模式（Infinity）下循环只会因 abort 或模型收尾结束。
  if (!Number.isFinite(config.maxRounds)) {
    onEvent({ type: 'aborted' });
    return { text: '', usage: usageTotal, aborted: true, files: outbox };
  }
  const stop = `\n\n[stopped: reached MAX_ROUNDS=${config.maxRounds}]`;
  onEvent({ type: 'text', text: stop });
  messages.push({ role: 'assistant', content: stop.trim() });
  return { text: stop, usage: usageTotal, files: outbox };
}

/**
 * 被中途打断时，历史尾部可能留着「有 tool_calls 却没有 tool 结果」的半截，
 * 直接发出去会被网关拒掉。这里把不齐的那一组整组砍掉（system/context 两条永远保留）。
 */
export function repairHistory(messages) {
  const floor = messages[0]?.role === 'system' ? (messages[1]?.context ? 2 : 1) : 0;
  while (messages.length > floor) {
    const last = messages[messages.length - 1];
    if (last.role === 'tool') {
      let i = messages.length - 2;
      while (i >= floor && messages[i].role === 'tool') i--;
      const owner = messages[i];
      if (!owner || owner.role !== 'assistant' || !owner.tool_calls?.length) {
        messages.pop();
        continue;
      }
      const need = new Set(owner.tool_calls.map((tc) => tc.id));
      for (let k = i + 1; k < messages.length; k++) need.delete(messages[k].tool_call_id);
      if (!need.size) return messages;
      messages.length = Math.max(floor, i);
      continue;
    }
    if (last.role === 'assistant' && last.tool_calls?.length) {
      messages.pop();
      continue;
    }
    if (last.role === 'assistant') messages.pop(); // 被打断、没写完的回答
    return messages;
  }
  return messages;
}

function sumUsage(acc, u) {
  const next = acc ?? { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  return {
    prompt_tokens: next.prompt_tokens + (u.prompt_tokens ?? 0),
    completion_tokens: next.completion_tokens + (u.completion_tokens ?? 0),
    total_tokens: next.total_tokens + (u.total_tokens ?? 0),
  };
}
