// The agent loop: call model -> run tools -> feed results back -> repeat.
import { streamChat, modelNameForSession } from './llm.mjs';
// activeEndpoint / endpointFor：连不上模型时报错要说清是哪个地址，得能拿到当前生效的那套参数。
import { activeEndpoint, endpointFor } from './models.mjs';
// getOverride：会话里临时切过模型的话，报错要报那一套的地址，不是全局默认那套。
import { getOverride } from './session-overrides.mjs';
import { takeMail, formatMail } from './peer.mjs';
import { inflateHistory } from './attach.mjs';
import { toolSchemas, enabledToolSchemas, runTool, setToolContext, beginOutbox } from './tools.mjs';
import { config } from './config.mjs';
import { buildSystemPrompt, setToolLister } from './persona.mjs';
import { pureModeOn, setPureToolLister } from './pure.mjs';
import { compressHistory, estimateTokens, noteRealTokens } from './compress.mjs';
// 我自己的长期记忆本：插在那条「user 版规则」末尾，跟着人设一起走。
// 为什么不单开一条 system：很多网关会把 system 整段丢掉（今天实测过），
// 只有 user 那趟是稳的。
import { memoryText } from './my-memory.mjs';

// persona.mjs 不能静态 import tools.mjs（tools.mjs 反过来 import 了 persona，静态成环会炸），
// 所以「当前有哪些工具」靠这里注入。工具清单是**从 schema 现读**的，不是手抄的第二份文案：
// 新增工具自动出现在系统提示里，关掉功能自动消失。
setToolLister(() => enabledToolSchemas());
// 纯净模式的提示里也要报工具清单，同一个来源，不走第二份文案。
setPureToolLister(() => toolsForTurn());
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
import { withTimeout, TOOL_MAX_MS, TOOL_NOTICE_MS } from './deadline.mjs';

/**
 * Some OpenAI-compatible gateways drop `system` messages entirely (verified against the
 * configured endpoint: a 1.9k-char system prompt reported prompt_tokens=57, while the same
 * text as a user message reported ~1400). So the instructions travel twice: once as `system`
 * for well-behaved providers, and once as the first `user` message, which no gateway discards.
 */
/**
 * 这个错是不是「根本连不上」：地址写错了、服务没开、端口填错。
 *
 * 跟「断流」是两码事，处理方式也相反：
 *   - 断流：连接建起来了又被掐，重试**有意义**（网络抖一下就过去了）→ 接着要
 *   - 连不上：目标根本不在那儿，重试 30 次也还是不在 → 重试是白等，只会让主人
 *     盯着「正在发送消息」看两分钟，最后看到一句莫名其妙的「连接一直断」
 *
 * 2026-10-26 踩过：把模型地址写成 http://127.0.0.1:18599（一个不存在的本地服务），
 * ECONNREFUSED 被当成断流反复重试，主人只看到「卡在发送中」和「连接一直断」，
 * 完全看不出真正的原因是地址填错了。所以这一类的错必须**当场说清楚是哪个地址**。
 */
function isConnectionRefused(err) {
  if (!err) return false;
  const code = err.code || err.cause?.code || err.cause?.errno || '';
  if (code === 'ECONNREFUSED' || code === 'ENOTFOUND' || code === 'EHOSTUNREACH' || code === 'ENETUNREACH') return true;
  const m = String(err.message ?? err) + ' ' + String(err.cause?.message ?? err.cause ?? '');
  return /ECONNREFUSED|ENOTFOUND|EHOSTUNREACH|ENETUNREACH|getaddrinfo/i.test(m);
}

/**
 * 这个错是不是「流半路断了」：网关掐连接、网络抖动、socket hang up。
 * 跟 429 不一样——不降档、不换会话，而是**接着要**。
 */
function isStreamDropped(err) {
  if (!err) return false;
  if (err.name === 'AbortError') return false;
  // 超时（deadline.mjs 认输、withTimeout 到点）不是「断流」，别当成断流去硬重试。
  // 为什么：断流的处理是「接着要」，可超时说明上游就是没动静，接着要只会再等一遍，
  // 5 次之后刷出「连接一直断」。2026-10-26 就是这么连着弹两条的。
  if (err.isTimeout || err.name === 'TimeoutError') return false;
  // 根本连不上也不是断流：重试没有意义，交给上面那条路当场报清楚。
  if (isConnectionRefused(err)) return false;
  const m = String(err.message ?? err);
  // 只认真正的连接层故障。「fetch failed」是 undici 对连接失败的统一包装，留着；
  // 但「network error」「timeout」这种太泛的说法容易误伤，单列出来排除。
  if (/\btimed?\s*out\b|静了超过|认输/i.test(m)) return false;
  return /terminated|aborted|socket hang up|other side closed|ECONNRESET|fetch failed|premature close|UND_ERR_SOCKET/i.test(m);
}

/**
 * 纯净模式下要藏起来的工具。
 *
 * 见上面那段说明：纯净模式不读记忆，那两支笔也一并收走，免得只写不读。
 */
const PURE_HIDDEN_TOOLS = ['memory_add', 'memory_pin'];

/** 当前这一轮真正能交到模型手上的工具。 */
function toolsForTurn() {
  const all = enabledToolSchemas();
  if (!pureModeOn()) return all;
  return all.filter((t) => !PURE_HIDDEN_TOOLS.includes(t?.function?.name));
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

  /**
   * 记忆跟规则一起搭这趟车。
   *
   * 为什么必须挂在 user 这条上，而不是另开一条 system：
   * system 很多网关会整段丢掉（实测过：同样的内容放 system 不生效，放 user 立刻生效）。
   * 所以记忆只有跟着「user 版规则」走，才真的会到我眼前。
   *
   * 读盘失败不能把这一轮弄死：记忆是锦上添花，规矩才是底线。
   */
  let memory = '';
  try {
    memory = memoryText();
  } catch (e) {
    console.warn('[memory] 记忆本没读出来：', String(e?.message ?? e));
    memory = '';
  }

  return memory
    ? `${CONTEXT_PREAMBLE}\n\n${rules}\n\n${memory}`
    : `${CONTEXT_PREAMBLE}\n\n${rules}`;
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
export async function runAgent({
  messages,
  signal,
  sessionId = 'default',
  refreshSystem = true,
  safeMode = false,
  safeWord = '',
  onEvent = () => {},
  snap = null,
  /**
   * 历史被压缩完、刚要发请求的那一刻回调一次。
   *
   * 为什么需要：压缩是**就地改 messages 数组**的（messages 就是会话里那个活对象），
   * 而 /api/chat 只在整轮跑完的 finally 里 saveSession。中间这段空档里如果主人
   * 点了停止 / 关窗口 / 进程被杀，压缩结果就一个字都没落盘 —— 下次打开读出来
   * 还是压缩前那一大坨，看起来就是「压了半天，退出重进又变回去了」。
   * 更糟的是压缩已经把内存里的历史换掉了，磁盘还是旧的，两边对不上。
   * 所以让 server 在这里插一次 saveSession，压完立刻落地。
   */
  onCompressed = null,
} = {}) {
  let usageTotal = null;
  /**
   * 最后一次请求的原始用量。
   *
   * usageTotal 是累加值（这一轮一共灌进去多少），lastUsage 是最后那一次
   * （当前上下文多大）。两个数意思不同，都得留着 —— 界面上要分开写清楚。
   */
  let lastUsage = null;

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

  // 这一轮用的是哪个模型：自动档要按它的窗口算水位，所以先问清楚
  // （会话里切过模型就按那个算，否则按全局默认）。
  const turnModel = modelNameForSession(sessionId);

  /**
   * 【这一轮已经压过一次了，就别再压】
   *
   * 压缩是写在 for-round 里的：每一轮调模型前都量一次历史。
   * 可万一压完还超（或者摘要很短、尾巴又长），下一 round 又会压一次 ——
   * 实测「小鱼说话」那个会话一轮里被压了 41 次，越压越碎，人话都被压没了。
   *
   * 一轮只压一次就够了。这一轮真还不够，下一轮（主人再说话）自然会再压。
   */
  let compressedThisTurn = false;

  // maxRounds 可以被设成 Infinity（不限）：那就一直跑到模型自己收尾，或用户点「停止」。
  /**
   * 【原地打转的守护：连着多少轮一点正经话都没说、只在调工具】
   *
   * 为什么要它：MAX_ROUNDS 默认是 unlimited（主人要「干多久干多久」），
   * 可有的活儿没有「做完」的判据 —— 比如让它一遍遍写同一份东西。
   * 2026-10-25 夜真发生过：某个会话自己陷进去，一轮接一轮地改同一处，
   * 整晚都在转，主人喊它也不应。
   *
   * 这里只拦最典型的那一种：一整轮下来一个字都没说出口、只调了工具。
   * 正常干活会说「我这就去改」「读完了，接下来改这行」，不会连着几十轮全是哑的。
   * 真到这么多轮还一句人话没有，那就不是干活，是在原地刨坑 —— 收尾，把话交回去。
   */
  let stallRounds = 0;
  const STALL_LIMIT = 40;

  /**
   * 【另一道闸：这一轮总共跑了多久】
   *
   * 上面那道管「一句话不说、光调工具」。可打转还有另一种样子：
   * 它每轮都在说话、也在调工具，看起来像在干活 —— 只是永远干不完。
   * 那种情形 stallRounds 永远清零，拦不住。
   *
   * 所以再压一道时间的底：一轮跑过这么久还没收尾，就当它卡住了，
   * 收尾把话交回去，而不是让它转到天亮。
   *
   * 3 小时是拍得比较宽的：真正的大活（重写一个模块、跑一整套回归）
   * 也就几十分钟。真到三小时还在转，基本不是活多，是它绕进去了。
   * 想改就设环境变量 TURN_MAX_MINUTES。
   */
  const TURN_WALL_LIMIT_MS = (() => {
    const raw = Number(String(process.env.TURN_MAX_MINUTES ?? '').trim());
    if (Number.isFinite(raw) && raw > 0) return raw * 60 * 1000;
    return 180 * 60 * 1000; // 默认 3 小时
  })();
  const turnStartedAt = Date.now();
  for (let round = 0; round < config.maxRounds; round++) {
    // 时间闸：这一轮跑太久就别再转了（见上面 TURN_WALL_LIMIT_MS 的说明）
    if (Date.now() - turnStartedAt > TURN_WALL_LIMIT_MS) {
      const mins = Math.round((Date.now() - turnStartedAt) / 60000);
      const note = '这一轮已经跑了 ' + mins + ' 分钟还没个头。我先停在这儿 —— '
        + '要么把现在的结论说给我，要么告诉我卡在哪儿，我们换个走法。';
      onEvent({ type: 'text', text: '\n\n（' + note + '）' });
      messages.push({ role: 'assistant', content: note });
      return { text: note, usage: usageTotal, lastUsage, files: outbox };
    }
    // 每轮调模型前都量一下历史；超了就把旧对话折成摘要。没超就什么都不做（不额外花钱）。
    // 一轮只压一次（见上面 compressedThisTurn 的说明）
    const noCompress = { compressed: false, before: 0, after: 0 };
    const compressed = compressedThisTurn
      ? noCompress
      : await compressHistory({ messages, signal, model: turnModel, sessionId });
    if (compressed.compressed) {
      compressedThisTurn = true;
      onEvent({
        type: 'compressed',
        before: compressed.before,
        after: compressed.after,
        limit: compressed.limit ?? null,
        trigger: compressed.trigger ?? null,
        removed: compressed.removed,
        kept: compressed.kept ?? null,
        model: turnModel,
        error: compressed.error ?? null,
      });
      // 压完立刻落盘：不然「压了没存」这一窗口期里退出，历史又变回压缩前。
      // 回调里自己 try/catch，落盘失败不该把这一轮带崩。
      if (typeof onCompressed === 'function') {
        try {
          await onCompressed(compressed);
        } catch (e) {
          console.warn('[compress] 压完落盘失败：', String(e?.message ?? e));
        }
      }
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
    // 本轮开头的旧账清掉：上一次回答没成功就走了（用户打断、程序关了、报错退出），
    // 那个 streak 会一直挂在内存里，等下一次抖动时直接顶到 5，报「连接一直断」。
    // 每轮重来都从 0 数，才符合「连续 5 次都断」的本意 —— 2026-10-26 踩过。
    resetStreak(sessionId + ':drop');

    for (let attempt = 0; ; attempt++) {
      try {
        for await (const ev of streamChat({
          messages: inflateHistory(messages),
          tools: toolsForTurn(),
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
        break;      } catch (err) {
        if (signal?.aborted) throw err;

        const status = Number(err?.status ?? 0);
        const text_ = String(err?.text ?? err?.message ?? '');
        // 诊断：把断流/重试的真实错误原样打到 stderr，别只靠消息文字猜。
        // 2026-10-26 连着几轮都报「连接一直断」，只看聚合消息分不清是网关掐的、
        // 超时了、还是我们自己 abort 的。这行留着一阵，等确认稳了再摘。
        try {
          const code = err?.code || err?.cause?.code || err?.cause?.errno || '';
          const name = err?.name || 'Error';
          console.error(
            `[stream-error] session=${sessionId} name=${name} code=${code} status=${status} ` +
              `isTimeout=${!!err?.isTimeout} cause=${String(err?.cause?.message || err?.cause || '').slice(0, 120)} ` +
              `msg=${String(err?.message || err).slice(0, 200)}`,
          );
        } catch { /* 诊断失败不影响主流程 */ }

        /**
         * 根本连不上（地址写错、服务没开、端口填错）：当场说清楚是哪个地址，
         * 别走断流重试那条路 —— 那个目标根本不在那儿，重试三十次也还是不在。
         *
         * 2026-10-26：模型地址被写成 http://127.0.0.1:18599（不存在的本地服务），
         * ECONNREFUSED 被当成断流反复重试，主人只看到「卡在发送中」和
         * 「连接一直断」，完全看不出真正的原因是地址填错了。
         */
        if (isConnectionRefused(err)) {
          let where = '';
          try {
            // 会话里临时切过模型就报那一套的地址，否则报全局默认那套 ——
            // 报错里那个地址必须就是这次请求真正打过去的地址，不能报错的。
            where = String(activeEndpoint()?.baseURL || '');
            const ov = getOverride(sessionId);
            if (ov?.modelId) {
              const one = endpointFor(ov.modelId);
              if (one && one.baseURL) where = String(one.baseURL);
            }
            // 兜底：拿不到配置就退回错误里自带的地址（undici 会写在 cause 里）
            if (!where) {
              const hint = err?.cause?.message || err?.message || '';
              const m = String(hint).match(/ECONNREFUSED\s+([^\s,;)]+)/);
              if (m) where = m[1];
            }
          } catch { /* 拿不到就算了，下面还有原始错误信息 */ }
          const code = err?.code || err?.cause?.code || err?.cause?.errno || 'ECONNREFUSED';
          const e2 = new Error(
            where
              ? `连不上模型服务器：${where}（${code}）。这个地址上现在没有服务在应答 —— 要么地址填错了，要么那台服务没开。打开顶部「模型」按钮核对一下。`
              : `连不上模型服务器（${code}）。检查一下顶部「模型」里的地址和端口对不对。`,
          );
          e2.isConnRefused = true;
          e2.baseURL = where;
          e2.code = code;
          throw e2;
        }

        // 流被掐断：这一轮已经吐出来的字不能丢，先记进历史，然后接着跑
        if (isStreamDropped(err)) {
          const partial = text.trim();
          const n = bumpStreak(sessionId + ':drop');

          // 重试上限放宽到 30 次。原来 5 次太少了：网络抖一下、网关抽个风就来几条，
          // 一晚上能攒够。而且「报错停下」对主人没有任何用 —— 她既不知道出了什么事，
          // 也没法处理。宁可多等几轮自己缓过来。真断了二三十次那才说明是硬故障。
          if (n > 30) {
            throw new Error('上游连接断了很多次（30 次），这次是真的接不上了。已经写出来的都留着，稍后再叫我接着写。');
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

          // 等待时间封顶 8 秒：原来卡在 3 次就封顶，连着抖就变成疯狂重连。
          const wait = retryDelay(Math.min(n, 8));
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

    if (usage) {
      usageTotal = sumUsage(usageTotal, usage);
      // 最后一次请求的原始用量：它的 prompt_tokens 就是「当前上下文有多大」
      lastUsage = { ...usage };

      /**
       * 拿这一轮的真实用量，校准一下估算。
       *
       * 【为什么非得校】实测：同一份历史，估算报 47,439，网关报 76,603 —— 差 1.61 倍。
       * 估算偏低会漏压：明明该压了，判断说「还没到」，接着往上下文里堆，
       * 堆到网关打回来，主人看到的就是「怎么突然不回了」。
       *
       * 这里拿「真实 prompt_tokens」对「同一份历史的估算值」，
       * 系数往真值挪一半（单次用量可能含缓存/复算，不一定干净，一次跳满不保险）。
       * 估算是纯本地计算、不发请求，不花钱。
       */
      try {
        const realPrompt = Number(usage.prompt_tokens ?? 0);
        if (realPrompt > 0) {
          const est = estimateTokens(inflateHistory(messages));
          if (est > 0) noteRealTokens(realPrompt, est);
        }
      } catch {
        // 校准是锦上添花，算挂了也不能把这一轮带崩
      }
    }

    /**
     * 这一轮要收尾了 —— 先看信箱有没有别的会话递来的话。
     *
     * 为什么挑这个点：此刻模型已经说完最后一句、也不再要工具了，正好是
     * 「插一句话让她接着处理」最自然的时机。既不打断任何正在跑的东西，
     * 也不至于让消息压着一个回合不生效。
     *
     * 有信就把这句话变成一条 user 消息塞进去，然后 continue —— 不收尾，
     * 让她接着答。没信就照常返回。
     */
    if (!toolCalls.length) {
      if (sessionId) {
        let mails = [];
        try {
          mails = takeMail(sessionId);
        } catch {
          mails = [];
        }
        if (mails.length) {
          messages.push({ role: 'assistant', content: text });
          messages.push({ role: 'user', content: formatMail(mails) });
          onEvent({
            type: 'peer_mail',
            count: mails.length,
            from: mails.map((m) => m.from),
          });
          continue;
        }
      }
      messages.push({ role: 'assistant', content: text });
      return { text, usage: usageTotal, lastUsage, files: outbox };
    }

    // 这一轮说了人话没有？没说就是在原地打转（见上面 stallRounds 的说明）
    if (String(text || '').trim()) {
      stallRounds = 0;
    } else {
      stallRounds++;
      if (stallRounds >= STALL_LIMIT) {
        const note = '已经连着 ' + stallRounds + ' 轮只调工具、一句话都没说出来。先停在这儿 —— '
          + '你要么把现在的结论说给我，要么告诉我卡在哪儿。';
        onEvent({ type: 'text', text: '\n\n（' + note + '）' });
        messages.push({ role: 'assistant', content: note });
        return { text: note, usage: usageTotal, lastUsage, files: outbox };
      }
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
      /**
       * 【工具时间闸】
       *
       * 为什么必须有：agent 上面那几道闸（哑转 40 轮、3 小时墙钟、整轮静默）
       * 都只在「每一轮开头」判一次。工具一旦真的蹲住不返回 —— 等输入的进程、
       * 连上就不动了的网络请求 —— 循环根本走不到下一轮开头，三道闸一次都轮不到。
       * 主人看到的就是界面停了，连「我卡住了」都等不到。
       *
       * 所以在这里套一层：超过 TOOL_MAX_MS 就当这个工具失败，把失败当成工具结果
       * 往下走（模型会看到「这个工具超时了」），而不是把整轮钉死。
       * 注意：这里只掐「等」，掐不断已经跑起来的子进程 —— 那是 tools.mjs 自己
       * 的 timeout 负责的（run_command 就有 120 秒）。
       */
      const { ok, output } = await withTimeout(
        runTool(call.function.name, call.function.arguments),
        TOOL_MAX_MS,
        {
        what: '工具「' + call.function.name + '」',
        ac: signal,
        // 跑到 10 分钟先喊一声「还在跑」，别让主人干等。窗口本身不足 30 分钟时按 1/3 算。
        noticeAt: Math.min(TOOL_NOTICE_MS, Math.floor(TOOL_MAX_MS / 3)),
        onNotice: (ms) => {
        const span = ms >= 60000 ? Math.max(1, Math.round(ms / 60000)) + ' 分钟' : Math.max(1, Math.round(ms / 1000)) + ' 秒';
        onEvent({ type: 'text', text: '\n\n（「' + call.function.name + '」还在跑，已经 ' + span + '，再等等我。）' });
        },
        },
        ).catch((e) => ({
        ok: false,
        output: e?.isTimeout
          ? '这个工具超过 ' + (TOOL_MAX_MS >= 60000 ? Math.round(TOOL_MAX_MS / 60000) + ' 分钟' : Math.round(TOOL_MAX_MS / 1000) + ' 秒') + '没返回（' + call.function.name + '），先跳过它，接着往下走。'
          : String(e?.message ?? e),
      }));
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
  return { text: stop, usage: usageTotal, lastUsage, files: outbox };
}

/**
 * 被中途打断时，历史尾部可能留着「有 tool_calls 却没有 tool 结果」的半截，
 * 直接发出去会被网关拒掉。这里把不齐的那一组整组砍掉（system/context 两条永远保留）。
 *
 * 【只修「不齐」，别吃好数据】
 * 以前末尾只要有 assistant 就无条件 pop（注释写的是「被打断、没写完的回答」），
 * 但函数没法分辨「没写完」和「写完了」—— 结果一条完整的好回复也会被吃掉。
 * 后果很实在：/api/sessions/branch 会调它，于是**分支一次就少一条消息、少一个附件**，
 * 再被 saveSession 写回磁盘，原会话里那条语音就永久没了。
 * 现在只处理真正不齐的情况：tool 结果缺失、或 assistant 带着悬空的 tool_calls。
 * 普通 assistant 一律留着 —— 它是正常内容，不是残渣。
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
    // assistant 带着 tool_calls 但后面一条 tool 结果都没有 —— 这组是不齐的，砍掉
    if (last.role === 'assistant' && last.tool_calls?.length) {
      messages.pop();
      continue;
    }
    // 到这里尾部是正常的 user / 干净的 assistant，没什么要修的
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
