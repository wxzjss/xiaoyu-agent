// Context compression: when the history gets too long, fold the old turns into one summary
// message and keep the recent tail verbatim. Nothing is deleted from disk — only the prompt
// gets shorter. The summary is itself merged into later summaries, so it rolls forward.
import { chat } from './llm.mjs';
import { config } from './config.mjs';
import { effectiveContextLimit } from './settings.mjs';
// 纯净模式：压的时候不做摘要，旧对话直接丢（见 pure.mjs 文件头的理由）。
import { pureModeOn } from './pure.mjs';
// 自动档的「拿不准」地带交给小鲸判断（带冷却，不每轮花钱）
import { autoRatioVerdict, contextWindowOf } from './rates.mjs';
import { askWhaleCompress } from './whale-judge.mjs';

/** 摘要消息的标记（只在本地用，不进 API 请求体）。 */
const SUMMARY_FLAG = 'summary';

/**
 * 纯净模式压完之后，原样留住的尾部 token 预算。
 *
 * 不是「越多越好」：纯净模式的用处是干活，历史只要够接着做下去就行。
 * 20000 大约相当于最近十来轮正常对话，长任务（边跑工具边改代码）也够接力。
 */
const PURE_KEEP_TOKENS = 20000;

/** 每条消息的固定结构开销（role / 分隔符等），保守取 4。 */
const PER_MESSAGE_OVERHEAD = 4;

/**
 * 纯净模式：把历史里「人设腔」的痕迹洗掉。
 *
 * 为什么必须洗：主人经常聊到一半才点开纯净模式，这时候历史里的助手回复
 * 全是「（耳朵都竖起来）主人～你好呀 (≧▽≦)」。模型看到这些会当成示范，
 * 只靠系统提示里一句「别用旁白」根本拦不住 —— 实测中途开启后照样一大段旁白加颜文字。
 * 所以把旁白括号、颜文字、对主人的称呼从**发给模型的历史副本**里去掉。
 *
 * 注意：只改副本，不动盘上的记录。主人回头看历史，看到的还是原来的样子。
 */
function stripFlavor(text) {
  let s = String(text ?? '');
  if (!s) return s;
  // 1) 整行只是旁白：直接删掉这一行（最常见的「（歪头）」「（小声嘀咕）……」）
  s = s
    .split('\n')
    .filter((line) => !/^\s*[（(][^）)]{0,120}[）)]\s*$/.test(line))
    .join('\n');
  // 2) 行内的旁白括号（全角/半角都算）
  s = s.replace(/[（(][^（()）]{0,120}[）)]/g, ' ');
  // 3) 颜文字里的特殊符号
  s = s.replace(/[≧≦▽ω˃˂◡•｀´Дﾉ๑ฅﾟ∀ヮ゜°]/g, '');
  // 4) 波浪号连打、重复标点
  s = s.replace(/[～~]+/g, '');
  s = s.replace(/[!！?？]{2,}/g, (m) => m[0]);
  // 5) 对主人的称呼（只在句首/标点后，避免误伤正文里的名词）
  s = s.replace(/(^|[，,。！!？?\s])主人(?=[，,。！!？?\s]|$)/g, '$1');
  // 6) 收尾
  return s
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trim())
    .filter(Boolean)
    .join('\n')
    .trim();
}

/**
 * 纯净模式：把发给模型的历史副本洗一遍。
 *
 * @param {Array} messages 要发给模型的数组（就地改，调用方负责传副本）
 * @returns {number} 删掉了几条（洗完变成空串的整条不要）
 */
export function purifyWire(messages) {
  if (!Array.isArray(messages)) return 0;
  let removed = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (!m || (m.role !== 'assistant' && m.role !== 'user')) continue;
    const before = String(m.content ?? '');
    if (!before) continue;
    const after = stripFlavor(before);
    if (after === before) continue;
    if (!after) {
      // 整段都是旁白/颜文字，洗完什么都不剩 —— 不发给模型
      messages.splice(i, 1);
      removed++;
      continue;
    }
    m.content = after;
  }
  return removed;
}

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
  // 至少留最后一个来回：keepTokens 再小也不能把尾巴删空。
  // 以前纯净模式把预算夹到 0 的时候，这里返回 start，整段历史全没了 ——
  // 模型拿到的是一个空上下文，等于当场失忆，活干不下去。
  const floor = Math.max(1, Math.min(4, messages.length - start));
  let acc = 0;
  let cut = messages.length;
  let taken = 0;
  for (let i = messages.length - 1; i >= start; i--) {
    if (acc >= keepTokens && taken >= floor) break;
    acc += estimateTokens([messages[i]]);
    cut = i;
    taken++;
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

/**
 * 摘要请求自己的超时（毫秒）。
 *
 * 【为什么从 45 秒放宽到 150 秒】
 * 上下文涨到十几万 token 时，摘要要读两万多字符的旧对话再写一段出来，
 * 45 秒根本不够 —— 一到点就被 abort，报 This operation was aborted，
 * 然后整轮跟着断，主人看着就是「一压缩就失忆」。
 * 宁可在这一步多等，也不能因为摘要没写完就把整轮回复扔掉。
 */
const SUMMARY_TIMEOUT_MS = 150000;

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
 * @param {string} [opts.model] 当前会话用的模型名 —— 自动档要按它的窗口算水位
 * @returns {Promise<{compressed:boolean, before:number, after:number, limit?:number, trigger?:number, removed?:number, kept?:number, reason?:string, error?:string}>}
 */
export async function compressHistory({
  messages,
  // 默认取「设置面板里填的那个阈值」，没填才回落到 .env 的 CONTEXT_LIMIT。
  // 填 0（自动档）时，这里按 model 的窗口算出真实水位。
  limit,
  // 保留为兼容老调用方：填多少压多少，所以触发线就是 limit（1.0），
  // 任何小于 1 的值都会让「填的数字」变成假的，直接忽略。
  triggerRatio = 1,
  // 会话 id：自动档在「拿不准」地带要问小鲸，冷却按会话算
  sessionId = '',
  // 尾部预算：优先用显式的 token 数，其次 config.contextKeepTokens，
  // 最后才回落到「limit 的几成」（老配置）。
  keepTokens,
  signal,
  model = '',
} = {}) {
  if (signal?.aborted) return { compressed: false, before: estimateTokens(messages), after: estimateTokens(messages), reason: 'aborted' };

  // 没显式给 limit 就去设置里问（带上模型名，自动档才能算对）
  const cap = limit === undefined ? effectiveContextLimit(model) : limit;
  const before = estimateTokens(messages);
  if (!Number.isFinite(cap) || cap <= 0) {
    return { compressed: false, before, after: before, reason: 'disabled' };
  }
  /**
   * 触发线。
   *
   * 人设模式：涨到水位才动手（不额外花钱）。
   * 纯净模式：**每轮都压**，不管现在多少 —— 它存在的意义就是「把上下文压到最小」，
   *   不是「到线了才压」。界面上那个「历史涨到多少才压」对它不适用。
   */
  const pureNow = pureModeOn();
  /**
   * 触发线。这里跟以前不一样了 —— 以前是「涨到 cap 才压」，而 cap 是窗口的 70%，
   * 遇到 100 万窗口的模型就是 70 万，历史涨到六七十万都不动，主人看到的就是
   * 「一直压不了」。
   *
   * 现在自动档改走「自适应判断」：
   *   - 历史占窗口很低（< 30%）→ 别压，宽裕着呢；
   *   - 占 30%~45% 这段拿不准 → 问小鲸拍板（带冷却，不每轮花钱）；
   *   - 占 45% 以上 → 直接压。
   *
   * 怎么区分「是不是自动档」：cap 恰好等于 autoLimitFor(model)（= 窗口 70%）时，
   * 说明是自动档算出来的；显式填了数字的人要「填多少压多少」，不许自作聪明。
   */
  let trigger;
  // 判定「压完还超没超」的基准线。不能直接用 trigger：临界带里小鲸说「压」时
  // 会把 trigger 临时置 0 让路，拿它当基准则 after(十万多) > 0 恒成立，压得再好也会
  // 被误标成 still-over-limit。所以另记一份真正的判定线。
  let judgeLine;
  if (pureNow) {
    trigger = 0; // 纯净模式每轮都压
  } else if (Math.abs(cap - Math.floor(contextWindowOf(model) * 0.7)) <= 1) {
    // 自动档：按比例判断
    const autoVerdict = autoRatioVerdict(model, before);
    trigger = Math.floor(autoVerdict.window * 0.3); // 低于舒适线就一定不压
    judgeLine = trigger; // 判定基准：舒适线（不受下面 trigger=0 影响）
    if (autoVerdict.verdict === 'critical') {
      // 拿不准 —— 问小鲸。冷却期内沿用上次结论，不重复花钱。
      const judge = await askWhaleCompress({
        sessionId,
        model,
        before,
        window: autoVerdict.window,
        ratio: autoVerdict.ratio,
        signal,
      });
      if (!judge.decide) {
        return {
          compressed: false,
          before,
          after: before,
          limit: cap,
          trigger,
          reason: `whale-says-hold(${judge.source})`,
        };
      }
      trigger = 0; // 她说压 —— 直接压
    } else if (autoVerdict.verdict === 'comfortable') {
      trigger = Math.floor(cap); // 等价于「别压」
    }
    // verdict === 'act'：trigger 保持 30% 线，before 早已超过，会往下压
  } else {
    trigger = Math.floor(cap); // 显式填了数字：填多少压多少
    judgeLine = trigger;
  }
  if (before <= trigger) {
    return { compressed: false, before, after: before, limit: cap, trigger, reason: 'under-trigger' };
  }

  const start = headLength(messages);
  // 头部（system + context）本身就要占掉一块，剩下的才是能给「摘要 + 尾巴」的预算
  const headTokens = estimateTokens(messages.slice(0, start));

  /**
   * 摘要那条消息大约占多少 token —— 先按保守值预留，算完再按真实长度校准。
   */
  const SUMMARY_RESERVE = 600;
  const budget = Math.max(1, Math.min(cap, Number.isFinite(cap) ? cap : 0) - headTokens);
  /**
   * 纯净模式的尾部预算另算，不走「limit 的几成」那一套。
   *
   * 纯净模式是干活用的：历史全丢，只留最近几轮当接力棒，
   * 不然一轮轮攒下来，token 又全花在复述旧对话上了。
   * 上限两万，够长任务接着往下做，又不会把上下文撑起来。
   *
   * 注意这里**不能**走 resolveKeepTokens：它有「至少 CONTEXT_KEEP_TOKENS（默认 8000）
   * 或 limit 的一半」的下限，套到纯净模式上会被抬到 64000，再被 budget 一夹就成 0，
   * 结果是历史全删、一句不剩 —— 实测真的压成 6 token，模型直接失忆。
   * 所以直接取「两万」和「预算」里小的那个，并且至少留一条。
   */
  const pureKeep = pureNow ? Math.max(1, Math.min(PURE_KEEP_TOKENS, budget)) : null;
  const keepTarget = pureNow
    ? pureKeep
    : clampKeep(resolveKeepTokens({ keepTokens, limit: cap }), Math.max(1, budget - SUMMARY_RESERVE));


  const cut = findCut(messages, start, keepTarget);
  if (cut <= start) return { compressed: false, before, after: before, limit: cap, trigger, reason: 'nothing-safe-to-drop' };

  const old = messages.slice(start, cut);
  const tail = messages.slice(cut);

  let summaryText = '';
  let error;
  // 纯净模式：不做摘要，直接把旧对话丢掉。
  //
  // 为什么：主人开纯净模式就是不想让模型被前面那一大堆设定和往事牵着走，
  // 留一句「早期对话摘要」等于又塞了一坨上下文进去。干脆不生成、不留。
  const pure = pureNow;
  if (pure) {
    summaryText = '';
    error = undefined;
  }
  /**
   * 摘要请求的超时与中断。
   *
   * 【关键改动：摘要失败绝不能连累整轮】
   * 以前超时一到就 abort，整轮跟着断掉，主人连一句话都收不到。
   * 现在：超时只砍摘要自己；失败了再重试一次（喂更短的输入，快一些）；
   * 两次都失败也只写占位文案，压缩照做，整轮照跑。
   */
  const runSummary = async (inputText, timeoutMs) => {
    const ac = new AbortController();
    const onAbort = () => { try { ac.abort(); } catch {} };
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }
    const timer = setTimeout(() => { try { ac.abort(); } catch {} }, timeoutMs);
    try {
      const res = await chat({
        messages: [
          { role: 'system', content: SUMMARY_SYSTEM },
          { role: 'user', content: inputText },
        ],
        signal: ac.signal,
      });
      const t = String(res?.choices?.[0]?.message?.content ?? '').trim();
      if (!t) throw new Error('摘要回了个空的');
      return t;
    } finally {
      clearTimeout(timer);
      if (signal) { try { signal.removeEventListener('abort', onAbort); } catch {} }
    }
  };

  if (!pure) {
    // 第一次：完整输入
    try {
      summaryText = await runSummary(renderForSummary(old), SUMMARY_TIMEOUT_MS);
    } catch (err) {
      error = String(err?.message ?? err);
    }
    // 第二次（主人没喊停才试）：把输入砍短一点，省时间
    if (!summaryText && !signal?.aborted) {
      try {
        const shorter = renderForSummary(old).slice(-Math.floor(SUMMARY_INPUT_MAX * 0.6));
        summaryText = await runSummary(shorter, SUMMARY_TIMEOUT_MS);
        error = undefined;
      } catch (err2) {
        error = String(err2?.message ?? err2);
      }
    }
  }

  if (!pure && !summaryText) {
    // 两次都没成：写一句占位，压缩照做。整轮不能因为摘要挂了就不回主人。
    summaryText = `（早期 ${old.length} 条对话的自动摘要没能生成出来${error ? `：${error.slice(0, 160)}` : ''}）`
      + `原文已折叠。要是主人觉得我这边接不上话，把要紧的事再说一遍就行。`;
  }

  /**
   * 压缩后插进历史的那一条。
   *
   * 【为什么 role 还是 user，但必须带 context: true】
   *
   * 以前这条是裸的 `role: 'user'`，结果模型真的把它当成「主人说的话」——
   * 而摘要正文里写的全是上一轮她自己的口吻（「主人，这轮我把你提过的问题全过了一遍…」），
   * 于是模型看到的是「主人告诉我：我把问题过了一遍」。再压几次，历史里就堆了好几条
   * 「冒充主人的假话」，最后一条 2214 字的直接跑偏成英文拒答。
   *
   * 为什么不干脆改成 role: 'system'：有的网关只认一条 system（多一条直接 400），
   * 而 agent.mjs 早就因为「网关会整段丢 system」才额外发一份 context 消息。
   * 所以这里沿用同一套机制：role 仍是 user（兼容性好），但打上 context: true，
   * 并且正文开头把话说死 —— 这是程序给的摘要，不是主人在说话。
   *
   * context: true 还顺手带来三个好处：
   *   1. publicSession 会跳过它（L267），界面上不会冒出一条冒充主人的气泡
   *   2. 回退 / 分支 / 记忆本子都只看非 context 的消息，不会把摘要当成对话内容
   *   3. 纯净模式会把 context 全滤掉（server.mjs L2762），纯净模式本来就不该有摘要
   */
  const makeSummary = () => (pure ? null : {
    role: 'user',
    content:
      '（下面是程序自动生成的「早期对话摘要」，不是主人说的话。'
      + '这段里出现的第一人称是之前那个你的口吻，只当作参考资料，别当成主人在对你提要求。）'
      + `\n\n【早期对话摘要 · 原文已压缩】\n${summaryText}`,
    context: true,
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
  /**
   * 这一轮「至少留几条」，跟 findCut 的 floor 一致。
   *
   * 纯净模式下 trigger 是 0（每轮都压），如果这里不留底线，
   * 循环会一路把尾巴丢到空 —— 实测真的丢成了 after=6、kept=0，
   * 模型拿到一个空上下文，当场失忆，活干不下去。
   * 留最后一个来回（最多四条），够它接着往下做。
   */
  const keepFloor = Math.max(1, Math.min(4, keep.length));
  while (guard++ < 200) {
    const next = withSummary(keep);
    if (estimateTokens(next) <= trigger) break;
    if (keep.length <= keepFloor) break;
    // 一次至少丢一条；保持工具调用和它的结果不拆开
    let cutAt = 1;
    while (cutAt < keep.length) {
      const at = keep[cutAt];
      const prev = keep[cutAt - 1];
      const splitsTool = at?.role === 'tool' || (prev?.role === 'assistant' && prev?.tool_calls?.length);
      if (!splitsTool) break;
      cutAt++;
    }
    // 别一下丢掉超过「留够底线」的量
    cutAt = Math.min(cutAt, keep.length - keepFloor);
    if (cutAt <= 0) break;
    keep = keep.slice(cutAt);
    dropped += cutAt;
  }

  const next = withSummary(keep);
  messages.length = 0;
  messages.push(...next);

  const after = estimateTokens(messages);
  return {
    compressed: true, before, after, limit: cap, trigger,
    removed: old.length + dropped, kept: keep.length,
    ...(after > judgeLine ? { reason: 'still-over-limit' } : {}),
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

