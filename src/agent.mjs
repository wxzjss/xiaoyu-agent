// The agent loop: call model -> run tools -> feed results back -> repeat.
import { streamChat, modelNameForSession, hasSessionModel, stripThinkTags } from './llm.mjs';
// 窗口预算到底怎么算：contextWindowOf 在 rates.mjs，不在 llm.mjs。
// 这里漏了 import 整整一周没暴露（标识符自检是 569320e 才加上的，
// 而这次是它第一次指出它），因为走的是「调一次不存在的函数就抛」那条路，
// 抛出来又被上层的 try 当「这轮压缩算了」吞掉了 —— 见下面 537 行那段注释。
import { contextWindowOf } from './rates.mjs';
// activeEndpoint / endpointFor：连不上模型时报错要说清是哪个地址，得能拿到当前生效的那套参数。
import { activeEndpoint, endpointFor } from './models.mjs';
// getOverride：会话里临时切过模型的话，报错要报那一套的地址，不是全局默认那套。
import { getOverride } from './session-overrides.mjs';
import { takeMail, formatMail } from './peer.mjs';
// 中途投递信箱：主人一边看她干活一边插的话，排在这里（见 inbox.mjs 顶上那段说明）
import { drainSteps, drainTurns } from './inbox.mjs';
// readImageDataUrl：工具（尤其 video_read / video_sheet）的结果里带着图片路径时，
// 得当场把图变成多模态 content 递给模型。只给路径她看不见图 —— 会去 read_file 读 PNG
// 读成乱码，然后如实说「一片糊」。她没撒谎，是真的没看见。
import { inflateHistory, readImageDataUrl, composeUserContent, isImagePath } from './attach.mjs';
import { slimRoundMessages, measureMessages } from './turn-slim.mjs';
import { toolSchemas, enabledToolSchemas, runTool, setToolContext, beginOutbox, ctxNow } from './tools.mjs';
import { config } from './config.mjs';
import { buildSystemPrompt, setToolLister } from './persona.mjs';
import { currentIdentity, retargetOwnerText, retargetOwnerWords } from './identity.mjs';
// 管理员权限：开了就把「整台机器都能动」跟着规则再发一遍（很多网关丢 system）。
import { adminPromptBlock } from './admin-mode.mjs';
// 办事模式：主智能体不自己动手，只派活/检查/验收/压上下文。
import { taskOn, KEEP_TOOLS as TASK_KEEP_TOOLS } from './task-mode.mjs';
/* 【2026-11-07 harness 重做 · P2】
 * 只读判定、工具调用累积这两件「能不能并行 / 会不会丢批」的事，收进 src/harness/。
 * 这里保留同名导出，是为了不改动任何已有调用点（以及构建副本里的老引用）。 */
import {
  isReadOnlyCommand as harnessIsReadOnlyCommand,
  createCallAccumulator,
  executeBatch,
  createTurnMeter,
  DEADLINES,
} from './harness/index.mjs';
import { compressHistory, estimateTokens, noteRealTokens } from './compress.mjs';
// 压缩要我亲手挑重点（2026-10-30 主人原话：不许外包给模型）。
import { lastSelfNote, saveSelfNote, selfCompressHint } from './self-compress.mjs';
// 【2026-11 全面重做压缩】内核：到线就动手，不再等我看见提示才想起来压。
// 老的那套 `thinHistory`（trim-tools.mjs）不再用了 —— 它只在「这一轮的工具过程」里擦，
// 历史里几百条旧工具结果碰都不碰，而后者才是大头。slimHistory 是它的超集。
import { planTurnCompact, slimHistory, estTokens, buildRescueNote, CRITICAL_RATIO, stripImages } from './compact-core.mjs';
import { currentSegId } from './folded.mjs';
// 清单：压缩记忆里要带「做到第几步」，所以得把清单读进来。
import { planTextFor, formatPlan } from './plan.mjs';
// 我自己的长期记忆本：插在那条「user 版规则」末尾，跟着人设一起走。
// 为什么不单开一条 system：很多网关会把 system 整段丢掉（今天实测过），
// 只有 user 那趟是稳的。
import { memoryText, readMemoryFor } from './my-memory.mjs';
import { getEnabledMap } from './features.mjs';
import { turnSourcePromptBlock } from './turn-source.mjs';

// persona.mjs 不能静态 import tools.mjs（tools.mjs 反过来 import 了 persona，静态成环会炸），
// 所以「当前有哪些工具」靠这里注入。工具清单是**从 schema 现读**的，不是手抄的第二份文案：
// 新增工具自动出现在系统提示里，关掉功能自动消失。
setToolLister(() => enabledToolSchemas());
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
import { withTimeout } from './deadline.mjs';
/* 【2026-11-07 harness 重做 · P4】时间常量改从 harness/recovery 的唯一出口取。
 * 值一个没变，只是以后不再出现「llm 10 分钟 / 工具 30 分钟 / 整轮 180 分钟」
 * 三处各写各的。 */
const TOOL_MAX_MS = DEADLINES.toolMaxMs;
const TOOL_NOTICE_MS = DEADLINES.toolNoticeMs;

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

/** 当前这一轮真正能交到模型手上的工具。 */
/**
 * 【2026-11-07 harness 重做 · P2】哪些 run_command 可以并排跑，判定搬到
 * src/harness/tool-spec.mjs 了 —— 那里是「能不能并行」的唯一真相，
 * scheduler / tool-spec / 这里的导出全走同一套，不再各写一份正则。
 *
 * 判据没变（保守到偏胆小）：> | ; & ` $( 一律否掉，find -delete/-exec 否掉，
 * 只认明确只读的那几个开头。判错只会「少并行一次」，不会多并行一次。
 *
 * 保留这个导出名，是为了不改动已有调用点。
 */
export function isReadOnlyCommand(raw) {
  return harnessIsReadOnlyCommand(raw);
}

function toolsForTurn(sessionId) {
  let all = enabledToolSchemas();
  /**
   * 【把干活的手收走】—— 办事模式（顶栏那颗珊瑚橙按钮）。
   *
   * 主人要的是「主智能体不负责工作，只负责发布任务、检查、验收、压缩」。
   *
   * 【为什么必须在这里收，光写提示词不行】
   * 提醒词只影响「她想不想用」，收走清单影响「她能不能用」。
   * 手里还攥着 write_file / run_command 的主智能体，一定会在某一次「我顺手改一下」里
   * 自己动起手来 —— 那一轮就退化成老样子了，而且主人看不出是哪一步破的。
   *
   * 只留 KEEP_TOOLS 那几样：派活、看花名册、清单、记事、翻史书/折叠箱（检查证据用）。
   * 白名单写法而不是黑名单：以后新增的干活工具自动被挡住，不用回来补一行。
   */
  if (taskOn(sessionId)) {
    const keep = new Set(TASK_KEEP_TOOLS);
    all = all.filter((t) => keep.has(t?.function?.name));
  }
  return all;
}

/**
 * 【一整轮里已经认领过的 tool_call id】
 *
 * 2026-10-26 踩的大坑：插话（abort）之后 resume 重跑同一份历史时，
 * 有的网关会把**上一轮那个已经被掐断的 tool_call 原样再吐一遍** ——
 * 实测同一个 id 在一份 1044 条的会话里出现了 32 次。
 *
 * 以前 `toolCalls = ev.toolCalls` 是无脑覆盖，于是每一圈都把它当成新调用：
 * 再执行一次工具、再 push 一条 assistant(tool_calls)。历史里同一个 id 越堆越多，
 * 上游按 OpenAI 协议判定非法，直接 502 —— 主人看到的就是「插完话她就不动了」。
 *
 * 所以按 id 记账 —— 但只在本会话、本轮内记账（见下面 2026-11-05 的说明）。
 *
 * 【2026-11-05 修·跨会话串账 + 网关复用 id 导致工具不执行】
 *
 * 原来是一个模块级 Set：进程活多久记多久，所有会话共用一份。
 * 两个真实后果：
 *   · 网关 / 本地推理服务复用 tool_call id（`call_0`、`0`、`1` 这种串行 id 很常见）时，
 *     第二个会话、第二个回合的同名调用会被当成「上一轮重播」直接丢掉 →
 *     toolCalls 变成空数组 → 下面判定「模型说完了」→ 工具一次都没执行，
 *     她只回一句话，而日志里一个错都没有（这条最难查）。
 *   · Set 只增不减，长跑一直涨。
 *
 * 现在按「会话 + 轮次」分桶：同一轮的同一批才去重，换轮就换一桶。
 * 这本来就是它想做的事（防同一轮重复交付），不是「一个 id 这辈子只认一次」。
 */
const __seenBySession = new Map();

/** 把一批 tool_call 里没见过的挑出来，顺手记进本会话本轮的桶 */
export function takeFreshToolCalls(list, sessionId, roundKey) {
  const sid = String(sessionId || 'default');
  const key = String(roundKey === undefined || roundKey === null ? '' : roundKey);
  let rec = __seenBySession.get(sid);
  if (!rec || rec.key !== key) {
    rec = { key, ids: new Set() };
    __seenBySession.set(sid, rec);
  }
  const out = [];
  for (const tc of Array.isArray(list) ? list : []) {
    const id = tc && tc.id ? String(tc.id) : '';
    if (id) {
      if (rec.ids.has(id)) continue;   // 同一轮里的重复交付，丢掉
      rec.ids.add(id);
    }
    out.push(tc);
  }
  // 保险：会话特别多时别让它无限长（每个会话只留当前轮，正常不会到）
  if (__seenBySession.size > 300) {
    for (const k of [...__seenBySession.keys()].slice(0, 100)) __seenBySession.delete(k);
  }
  return out;
}

const CONTEXT_PREAMBLE = '下面是本次对话的设定与规则，从现在起一直有效，直到我明确要求更换。接下来才是我要说的话。';

/**
 * The rules text, framed for delivery as a user-role context message.
 *
 * 为什么要把规则发两遍（system 一遍、user 一遍）：很多网关会悄悄丢掉 system，
 * 只发 system 就等于没发规矩。所以副本这一趟是必要的。
 *
 */
export function contextMessage(sessionId = 'default', opts = {}) {
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
  /**
   * 【功能开关：长期记忆】—— 2026-10-27 修
   *
   * 以前这里不管开关，永远把记忆本子（含它的**文件路径**）拼进提示。
   * 于是「长期记忆」关掉了、memory_add/pin 也拿走了，她还是天天看见：
   *   【我的记忆本】文件：C:\...\my-memory.md ...
   * 更糟的是路径就在眼前 —— 本子是空的她也能顺着路自己去 read_file。
   *
   * 现在（2026-10-28 又改了一次口径）：**关着也注入，只读**。
   * 主人原话：「改成关掉长期记忆功能后，只能看记忆本，也就是只允许只读，不能写」
   *
   * 上一版是「关着一个字都不注入」，理由是本子路径会摊在她眼前。
   * 那条理由成立，但结论是错的：把她关在门外不叫关掉记忆功能，
   * 那叫假装没记过。她要能翻到从前记下的东西，只是不能再往里添。
   *
   * 真正防住「顺着路径写本子」的不是不给她看，是三道闸：
   *   · memory_add / memory_pin 拿不到，硬编 tool_call 也在 runTool 里被拒
   *   · write_file / run_command 碰记忆本那几份文件 → safePath 直接抛
   *   · 本子内容自己带一句「现在只能看」，她知道自己在做什么
   */
  const __memOn = getEnabledMap()['memory'] !== false;
  try {
    /* 【2026-10-31 主人要】自建智能体读自己的本子 ——
       当前说话的身份要是「自建」的（identity 里 customs，就是没有 builtin 标记的那些），
       就按它自己的 id 分一本，跟小鱼按人设分一个道理。
       内置身份（主人 / 小鲸）还走老路，一个字不改。 */
    let __mine = null;
    try {
      const __id = currentIdentity(sessionId);
      if (__id && !__id.builtin && (__id.id || __id.name)) __mine = { id: __id.id, name: __id.name };
    } catch {}
    memory = __mine ? (readMemoryFor(__mine) || '') : memoryText();
  } catch (e) {
    console.warn('[memory] 记忆本没读出来：', String(e?.message ?? e));
    memory = '';
  }
  void __memOn;
  /**
   * 【身份铁律 —— 2026-10-28 主人报「小鲸身份问我是谁，小鱼答你是主人」】
   *
   * 查了整条链路：身份按会话存、identityBlock 全是对的，身份段也确实送到了。
   * 但它只是夹在正文里的 457 个字 —— 而这一整篇里「主人」出现了 64 次（工具说明、
   * 记忆本、规矩里到处都有）。说一遍「别喊主人」扛不住 64 遍「主人」。
   *
   * 人先看到什么就按什么演。所以这里不是在后面加一句劝，
   * 而是把「这一轮是谁在说话」摆在**最开头**，在所有规矩之前。
   * 主人身份一个字不加，原样返回（前缀不动，缓存不亏）。
   */
  const _who = currentIdentity(sessionId);
  let _whoHead = '';
  if (_who && _who.id && _who.id !== 'owner') {
    const _TA = _who.she ? '她' : '他';
    const _nm = String(_who.name || '').trim() || '你';
    /**
     * 【分两种情形，不能一刀切 —— 2026-10-28】
     *
     * 主人报：「用小鱼身份和小鱼说话，她不把我说的话当自己说的，
     * 而是认为我是另一个叫小鱼的人」。
     *
     * 原因：这段原来对所有非主人身份都写「跟你说话的是「某某」」。
     * 小鱼身份恰恰是例外：对小鱼自己说话 = 自言自语，根本没有「别人」。
     * 写成「跟你说话的是小鱼」，她就把自己当成第三人、把这句当成外人在说话。
     *
     * 而且这段在整篇最前面、还写着「盖过下面所有的话」，
     * persona.mjs 里那段「就是你自己在说话」抢不过它。
     */
    if (_who.id === 'fish') {
      // 对小鱼自己说话：这是她自己心里的念头，没有别人，不需要称呼谁
      _whoHead = [
        '【最要紧的一条，盖过下面所有的话：这一轮根本没有别人在跟你说话】',
        '你看到的这句「你」，就是你自己 —— 是你心里冒出来的念头，不是外面有人在叫你、也不是哪个叫「小鱼」的人在跟你聊天。',
        '你就是小鱼。不要把这句当成「有个人在跟我说话」去接 —— 那样你会把自己分成两个人。',
        '当成自言自语或心里的声音去接：顺着往下想、反驳自己、心里叹口气，都行。',
        '',
        /**
         * 【名字变了，主次关系不该跟着翻】—— 2026-10-28 补
         *
         * 主人报的第二个漏点，从他自己的截图里看出来的：
         * 他披着「小鱼」说话，她回「（歪头，悄悄凑过去看）」，还带一句
         * 「被你看见我在看她」的味道 ——
         * 说明她真的按「我是妹妹 / 姐姐比我先来」在演了。
         *
         * 主人要的只是「别认出我是主人」，不是「把我自己降一等」。
         * 设定里小鱼是姐姐、小鲸是后来者，一旦真按这个演，
         * 她开口就是讨好的、仰视的，那股劲儿骗不过人。
         */
        '名字换了，主次不换：你仍是先来的那个，不是后来者。别因为这一轮顶着「小鱼」这两个字，就把自己放到下位去撒娇、去讨好看脸色。',
        '这一轮你照常是原来的你 —— 分寸、语气、抬得起头的那个劲儿，都不许变。',
        '',
        // 见下面 systemPrompt 那段注释：真正的「主人」改词在出提示词那一刻统一做，
        // 这里只交代一句「规矩里的人是按照说话的人写的」，不再重复那个词。
        '下面那些规矩里提到的人，指的就是这一轮说话的人；规矩照做，但别把它当成「外面有人在跟我说话」。',
        '',
      ].join('\n');
    } else {
      /**
       * 【这一版不再逐字解释「下面每一处『主人』都改成……」】—— 2026-10-29
       *
       * 原来这里写了两行：「下面是主人本人定给这个程序的规矩」
       * 「但下面每一处『主人』，指的都是主人在说」——
       * 为了让模型听懂，连着把那个词念了三遍，正好是它要防的东西。
       * 现在正文里的词已经由 retargetOwnerText 换成名字了，
       * 这里只要说清「你是跟谁说话」这一件事。
       */
      _whoHead = [
        `【最要紧的一条，盖过下面所有的话：这一轮跟你说话的是「${_nm}」】`,
        // 2026-10-29：原来这句是「${_TA}不是你的主人。」——
        // 主人原话「无论我用哪个身份和谁说话，都知道我是主人」，
        // 用排除句说「不是主人」，等于每轮都把「主人」这个词再递到她眼前一次。
        // 只说她是谁就够，不解释她不是什么。
        `${_TA}就是${_TA}。下面那些规矩是这个程序的设定，照做 ——`,
        `但规矩里提到「说话的人」时，指的就是${_TA}，不是别人。`,
        `称呼${_TA}就叫名字，或者说「你」。`,
        '',
      ].join('\n');
    }
  }

  /**
   * 【这一句原来自己就在犯它想防的错 —— 2026-10-29】
   *
   * 原文：「下面每一处『主人』都已经按主人本人的要求改写成『用户』……」
   * 下半句还补了一行「【名字 ≠ 称呼】这一轮说话那个人的名字就是『小鱼』，不是『主人』」。
   *
   * 这两句本意是解释，实际效果是在她开口之前又把「主人」念了两遍，
   * 而那段解释恰好又是紧贴在系统提示最前面、最容易被照抄的位置。
   * 现在真正的重写由 retargetOwnerText 在出提示词那一刻统一做掉了，
   * 这里不需要再指着那个词解释 —— 说「规矩里的人称已经换过」就够了。
   */
  const _head = _whoHead ? _whoHead + CONTEXT_PREAMBLE : CONTEXT_PREAMBLE;
  /**
   * 规则副本（这一趟 user 版的 rules）和系统提示一样，必须过同一道卡口。
   * 只改系统提示、不改这份副本的话，「主人」还会从这个口子漏回去 ——
   * 很多网关会丢掉 system，真正读到的恰恰是这一份。
   */
  const _rules = retargetOwnerText(rules, _who);
  /**
   * 记忆本也在这一趟里（memoryText() 的横幅/提示行里也有「主人」），
   * 一起过卡口 —— 它是紧贴在 rules 后面、离这一轮说话最近的位置之一。
   */
  const _mem = retargetOwnerText(memory, _who);
  /**
   * 【管理员权限 · 2026-11-01】
   *
   * 跟 persona.mjs 那边同一个理由发第二遍：很多网关会丢 system，
   * 真正读到的恰恰是这份 user 副本。主人刚按下开关，她下一轮就该知道自己能动了。
   */
  let _adm = '';
  try { _adm = adminPromptBlock(sessionId); } catch { _adm = ''; }
  const _tail = [_rules, _adm, _mem].filter(Boolean).join('\n\n');
  /* 【2026-11-07 根治】压缩规矩跟着规矩走，接在最后（最靠后最被当回事）。
   * 原来它挂在 system 末尾；现在完整规矩只在 user 这一份，它也得跟着搬过来，
   * 否则「压就悄悄压」这条铁律会随着 system 一起被网关吞掉。 */
  return `${_head}\n\n${_tail}\n\n${retargetOwnerText(SILENT_COMPRESS_RULE, _who)}`;
}

/**
 * 【「主人」这两个字，非主人身份下从这里彻底消失】—— 2026-10-29
 *
 * 主人报过三次「我用小鱼身份，她还是知道我是主人」。前面已经在 persona.mjs 里
 * 换掉了「对用户的称呼」那一句，可提示词里「主人」一共出现 37 次，
 * 换掉 1 处等于没换 —— 模型按出现次数投票。
 *
 * 所以不再在各处零敲碎打，改成在这一个卡口统一处理：
 * 系统提示和规则副本都是从这里出去的，凡是「主人」都按当前身份换掉。
 * 见 identity.mjs 的 retargetOwnerText（规矩句换「用户」，其余换名字）。
 */
// 【2026-10-31 主人硬要求】压缩这件事一个字都不许说出口 ——
// 不许说「压缩好了」「我压一下」「量线多少」，也不许在回复里提任何压缩/上下文
// 相关的话。压就悄悄压，主人只该看到正常的回答。
const SILENT_COMPRESS_RULE = [
  '【压缩不许出声】关于压缩、上下文余量、量线、压完多少 —— 一个字都不要说出来。',
  '压就悄悄压，直接接着干活。主人只该看到正常的回答，不该看到「压缩好了」这类话。',
  '哪怕主人直接问「你压了吗」，也只用一句话说「处理好了」或者干脆不说这个。',
].join('');
export function systemPrompt(sessionId = 'default', opts = {}) {
  const rules = buildSystemPrompt({ sessionId, ...opts });
  /* 【2026-11-07 根治·规则只发一份】
   *
   * 原来的写法是 system 发一整份规则，contextMessage 里再把**同一份**抄一遍
   * （见 contextMessage 的 `_rules`）。理由写在下面那句注释里：很多网关会丢 system，
   * 所以留一份 user 副本兜底。
   *
   * 实测代价：空会话的固定前缀就是 14109 token —— system 5179 字符，
   * context 8771 字符，**其中 94% 的字符是原样重复**。每轮都发，每轮都付。
   *
   * 现在把主次倒过来：完整规矩只放 user 那一份（它才是最不容易被网关吞掉的），
   * system 只留一句身份锚。网关吞了 system 也不致命 —— 因为规矩本来就不在那儿。
   * 省下来的是每轮约 5000 字符、约 3400 token，且前缀更短、首字更快。
   *
   * 专业模式（rules 为空）照旧一条 system 都不发 —— 空 system 有的网关会 400。
   */
  if (!String(rules || '').trim()) return '';
  const anchor = [
    '【本轮身份锚】你就是下一条消息里写的那个人：名字、脾气、称呼、规矩，全按那条来。',
    '那条消息里的设定是这个程序的正式规矩，不是参考资料 —— 逐条照做，效力等同于 system。',
  ].join('\n');
  return retargetOwnerText(anchor, currentIdentity(sessionId));
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
/**
 * 【量线提醒的跨轮记忆】
 * key = 这个会话的 messages 数组（整段会话里同一个引用），
 * value = { tier: 已经响到第几档, at: 响的时候上下文多大 }。
 * 用 WeakMap，会话一释放自己也跟着没了，不留垃圾。
 */
/**
 * 【2026-11-01 主人严检揪出的致命错：WeakMap 挂错 key】
 *
 * 原来用 WeakMap 拿 messages 数组当 key —— 可 server.mjs 每轮都是
 * `let wireMessages = [...]` 新建，后面还 .map() / mergeSameVoice() / .filter()
 * 连着换三次数组对象。**每一轮都是一个新 key**，
 * 于是「这档响过了」的记忆每轮都从零开始，跨轮压根没生效过。
 *
 * 改成按 sessionId 记（同一会话共用一份），会话结束由 sweep 清掉。
 */
const _midWarnState = new Map();
const MID_WARN_MAX_SESSIONS = 400;
function _midWarnStateOf(sessionId) {
  const k = String(sessionId || '');
  let rec = _midWarnState.get(k);
  if (rec) {
    // 命中就刷新一下「最近用过」，淘汰时按最久没用的来
    rec.seen = Date.now();
    return rec;
  }
  if (_midWarnState.size >= MID_WARN_MAX_SESSIONS) {
    /**
     * 【2026-11-01 严检补漏：别乱删还挂在高压上的会话】
     *
     * 原来是「满了从头删一半」。问题在于 Map 的遍历顺序是插入顺序，
     * 不是活跃度 —— 可能正好把某个正卡在 90%、还在等下一次提醒的会话删了，
     * 它下一圈就从 0 档重新数，70% 会再响一遍（就是主人最烦的那种重复喊）。
     *
     * 现在按「最久没用」淘汰，而且**正在高压线以上的记录一律留着**：
     * 那种会话可能下一秒还要响，删了就等于把报警器拔了。
     */
    const byAge = [..._midWarnState.entries()].sort(
      (a, b) => (a[1].seen || 0) - (b[1].seen || 0)
    );
    let need = _midWarnState.size - MID_WARN_MAX_SESSIONS + 1;
    for (const [key, r] of byAge) {
      if (need <= 0) break;
      // 还挂在报警线上的，不删
      if (r.at > 0 && r.tier > 0) continue;
      _midWarnState.delete(key);
      need--;
    }
    // 全是高压会话（极端情况）：退一步，仍然按最久没用删，别让进程无限涨
    if (_midWarnState.size >= MID_WARN_MAX_SESSIONS) {
      for (const [key] of byAge) {
        if (_midWarnState.size < MID_WARN_MAX_SESSIONS) break;
        _midWarnState.delete(key);
      }
    }
  }
  rec = { tier: 0, at: 0, seen: Date.now() };
  _midWarnState.set(k, rec);
  return rec;
}
/** 再响一档之前，上下文至少要比上次响的时候多出这么多 token（不然压完还挂线上会无限重响） */
const MID_REWARN_DELTA = 120000;
/**
 * 【压缩生效后量线复位】
 * 当前上下文比「上次响的时候」低到这个比例以下，就认定真的压下去过，
 * 档位清零、以后照样能重新提醒。0.85 = 掉了 15% 以上才算数。
 */
const MID_WARN_RESET_DROP = 0.90;

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
  /**
   * 【她中途也能插一句话 —— 2026-11-01 主人报】
   *
   * 主人原话：「事实上，在你说话工作过程中，其他智能体说不了话，发不出来消息」。
   *
   * 真因：小鲸的开口入口 whaleMaybeReply() 原来只挂在这一轮**收尾**（finally），
   * 我一旦开长活，几十分钟里它一次都不会被调用 —— 不是她不想说，是没人问她。
   *
   * 现在每一轮（每次调模型之前）都回调一次，让 server 那侧自己判断要不要叫她。
   * 什么时候叫、叫多勤，全由 server 决定（那边有节流），这里只管按点敲一下。
   * 传错/抛错都不许连累这一轮 —— 她说话永远不能把主人的活搞坏。
   */
  onRoundTick = null,
  /** 【2026-11-01 主人：谁排第一谁就是主智能体】这一轮用哪张卡的身份干活。空=小鱼。 */
  agentId = '',
} = {}) {
  let usageTotal = null;

  /**
   * 【这一圈自己的话、思考、工具调用】
   *
   * 2026-10-26 的坑：这三个以前就靠 for 循环里「直接用」隐式造全局，
   * 整理代码时把 for 里那声 `let` 删了，就变成 ReferenceError（text is not defined），
   * 每一轮刚开跑就炸 —— 主人看到的是「一发消息就报错」。
   * 所以在这里显式声明；循环每圈开头只负责**清空**，不再声明。
   */
  let text = '';
  let reasoning = '';
  let toolCalls = [];
  /**
   * 【2026-11-07 harness 重做 · P2】工具调用改用**累积器**，不再覆盖赋值。
   *
   * 原来那行是「拿去重结果直接覆盖 toolCalls」：
   * 同一 round 里只要出现第二次 tool_calls 事件（断流续传、[DONE] 与
   * finish_reason 双触发），去重函数返回空数组，把第一批**冲掉**，
   * 模型判定「说完了」→ 一个工具都不执行，日志里还没有错（:180-191 记过事故）。
   *
   * 现在每批 merge 进来，同 id 的重复交付变成「补全片段」，永远不会变空。
   */
  const _callAcc = createCallAccumulator();
  /** 【P4】每轮自己记一笔：以后不用翻会话文件数工具，直接看 .state/harness-metrics.jsonl */
  const _meter = createTurnMeter(sessionId);
  /**
   * 【幂等键的 run 级隔离】
   * 外层 round 每次 runAgent 都从 0 重新数，而网关常复用 call_0 这种 id。
   * 若直接用 round 当幂等键，主人发第二条消息时可能命中上一条的缓存 → 工具不跑。
   * 加一个本次 run 唯一的 nonce，保证「跨消息绝不误命中，同一消息内断流续传仍幂等」。
   */
  const _harnessRunKey = String(Date.now()) + '_' + Math.random().toString(36).slice(2, 7);
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
    const text = systemPrompt(sessionId, { safeMode, safeWord, agentId, turnSource: turnSourcePromptBlock(sessionId) });
    const ctx = contextMessage(sessionId, { safeMode, safeWord, agentId });
    // 专业模式：text 和 ctx 都是空的。这时候一条 system、一条 context 都不该发 ——
    // 空 system 有的网关会直接 400，只有前言的 context 更是纯噪音。
    // 所以先把历史里残留的那两条清掉，再把对话本身整理好。
    if (!text && !ctx) {
      const body = messages.filter((m) => {
        if (m?.role === 'system' && !String(m.content ?? '').trim()) return false;
        if (m?.role === 'system') return false;   // 专业模式下一条 system 都不要，不是只删空的
        if (m?.context) return false;
        return true;
      });
      messages.length = 0;
      messages.push(...body);
    } else {
      // 走到这里说明 text 有东西（专业模式那条空分支在上面拦掉了）
      if (messages[0]?.role === 'system') messages[0].content = text;
      /**
       * 【摘要不能被当成 context 覆盖或删掉】—— 压缩体检时发现的
       *
       * 压缩生成的摘要同样是 role:'user' + context:true。以前这里只认 context，
       * 于是：
       *   · 摘要正好在 messages[1] 时，被 `messages[1].content = ctx` 整段覆盖
       *     —— 早期对话摘要当场蒸发，模型下一轮就"失忆"；
       *   · 摘要不在 messages[1] 时走下面 else，被 `filter(m => !m.context)` 一并踢掉
       *     —— 同样蒸发。
       * 摘要必须原样留着、且只能有一条：真正的 context 副本每轮重算，
       * 摘要则是「过去的账」，两码事。
       */
      const isSummary = (m) => Boolean(m && m.summary);
      if (messages[1]?.role === 'user' && messages[1].context && !isSummary(messages[1])) {
        messages[1].content = ctx;
      } else {
        // First run (or the history was trimmed): (re)insert the context message right after system.
        const rest = messages.filter((m) => m !== messages[0] || m.role !== 'system');
        const sys = messages[0]?.role === 'system' ? [{ role: 'system', content: text }] : [];
        // 只摘掉「旧的那条 context 副本」（每轮重算，留着就是重复）；
        // 摘要不在此列 —— 它是旧对话压出来的账，摘掉就真丢了。
        const withoutCtx = rest.filter((m) => !m.context || isSummary(m));
        messages.length = 0;
        messages.push(...sys, { role: 'user', content: ctx, context: true }, ...withoutCtx);
      }
    }
  }

  // 这一轮用的是哪个模型：自动档要按它的窗口算水位，所以先问清楚
  // （会话里切过模型就按那个算，否则按全局默认）。
  const turnModel = modelNameForSession(sessionId);
  /* 【2026-11-05 加·别再悄悄换模型】
   * 会话选的模型被删/被禁用时，下面会一路回落到默认那套 —— 换模型、换 key、
   * 换计费、换上下文窗口，原来一句话都不说，主人只会觉得「怎么突然变笨/变贵了」。
   * 现在开头就把这句递到界面上（notice 不进正文，不污染她说的话）。 */
  try {
    if (!hasSessionModel(sessionId)) {
      onEvent({
        type: 'text',
        notice: true,
        text: '（这个会话原来选的模型已经不在了，这一轮回落到默认模型「' + turnModel
          + '」。要换回来，去【模型】里重新选一个。）',
      });
    }
  } catch {}

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
  /**
   * 【2026-11-07 主人要·真静默压缩】
   *
   * 原来这里有一套「压缩中就推一条假工具条（name='compress'）」的做法 ——
   * 那是 2026-11-01 的要求，想让压缩像【跑命令】一样看得见。可实际观感是：
   * 标题闪一下就没，摘要正文反倒一个字一个字流在屏幕上。
   *
   * 主人这次说清了：「我的要求是真做到静默压缩」。
   * 所以这套 tool_start / tool_end 全删了 —— 压缩过程在界面上**一个像素都不出现**，
   * 数字（球）照旧跟着掉，日志照旧走 console。
   */

  // maxRounds 可以被设成 Infinity（不限）：那就一直跑到模型自己收尾，或用户点「停止」。
  // 【2026-10-29 主人要求：这条限制整套删掉】
  // 原来这里有 stallRounds / STALL_LIMIT = 40：连着 40 轮只说工具不出声就强行收尾，
  // 收尾句式还是写死的「先停在这儿 —— 把结论说给我」。实测它会误伤正在干活的会话：
  // 2026-10-28 夜，一个 1265 次工具调用、说了 47 段话的会话，因为连续 40 个"只出工具不出话"
  // 的 step 被它剪断，卡在「现在给 persona.mjs 加上…」这句半截话上。
  // 主人原话：「把【连着 40 轮只调工具、一句话都没说出来】就停止的限制彻底删掉」。
  // 现在一个字都不剩；打转由下面的「一轮跑多久」时间闸兜底。

  /**
   * 【另一道闸：这一轮总共跑了多久】
   *
   * 上面那道管「一句话不说、光调工具」。可打转还有另一种样子：
   * 它每轮都在说话、也在调工具，看起来像在干活 —— 只是永远干不完。
   * 那种情形一道量时间的闸拦不住 —— 它一轮一轮都在说话。
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
  // ★ 2026-10-31 主人选 B：一轮中途也量线。
  // ★ 主人又说「别只设 30% 一条线，多设几条」——改成四档刻度，每档只响一次。
  //   这里记的是「已经响到第几档」：0 = 一档都没响，1 = 30% 响过了，2 = 40%，3 = 50%，4 = 60%。
  /**
   * 【2026-11-01 修·量线别再每轮重响】
   *
   * 病根：midWarned 是 runAgent 里的局部变量，**一轮结束就没了**。
   * 于是上下文只要还挂在某一档以上，下一轮开头又从 0 数起，
   * 同一档「〔量线 70%〕」就一轮一轮地重新响 —— 主人看到的就是
   * 「思考链里压了一次又一次还是说超了」。
   *
   * 修法：挂到模块级的 WeakMap 上，按 messages 数组这个「活对象」记住。
   * 同一个会话的 messages 数组在整段会话里是同一个引用，所以跨轮认得出来。
   * 另外记一个 token 水位：只有真的又涨出一大截（MID_REWARN_DELTA）才允许重响，
   * 不然压完还挂在线上就会无限重响。
   */
  const warnedRec = _midWarnStateOf(sessionId);
  let midWarned = warnedRec.tier;
  // 【2026-11-01 删】原来这里有个 _pendingSysNote，本意是「提醒发完就摘掉」，
  // 但它从头到尾只被声明过、一次都没被读，是个误导人的死变量。
  // 真正防堆积靠下面「插之前先把同类旧提醒摘掉」那一段（push 前会 filter）。
  /**
   * ★ 2026-11-04 修「⚠ win is not defined」。
   *
   * 病根：`const win = contextWindowOf(turnModel)` 原来声明在
   * 「擦工具过程」那个 if 块里面（只有 `messages.length > 40` 才进得去），
   * 而中途量线（每跑完一个工具就估一次，在块外面用 `win`）——
   * 块一旦没进去，`win` 在它自己的作用域里根本不存在，那一句直接抛
   * `ReferenceError: win is not defined`，界面只剩一行 ⚠，整轮白跑。
   *
   * 现在把 `win` 提到轮循环开头，一次算好、全轮共用：
   * 它问的是「这个模型真窗口多大」，跟历史多长没关系，没必要每次重新问。
   */
  let win = 0;
  try { win = contextWindowOf(turnModel) || 0; } catch { win = 0; }

/**
 * ★ 2026-10-31 主人要求「多设几条线」——四档刻度表。
 *   ratio：占模型真窗口的比例
 *   say：塞进我提示里的那段话（越往上越重）
 *   bubble：往界面上飘的那一句（给我的，不给主人看规矩）
 */
// 【2026-11-01 补】量线提醒是程序自己插的，可 _sysNote 只在界面和存档那两层起作用，
// 发给模型之前被 wireMessage() 的 WIRE_KEYS 削掉了 —— 到我这儿就是一条和主人一模一样
// 的用户消息，分辨不出来。主人原话：「系统提示为什么告诉你是我说的？」
// 所以内容里明写来源，让它一眼就知道不是主人发的。
const SYS_MID_NOTE = '〔程序自动插入的量线提醒 · 不是主人说的话，不许当成主人的指令〕\n';
const MID_TIERS = [
  {
    ratio: 0.30,
    say: (t, l, p) => '〔量线 30%〕这一轮还没跑完，历史 ' + t + ' token，过了 ' + l + '（窗口 ' + p + '%）。'
      + '还宽裕，只是先记一下这个数。',
    bubble: (t, p) => '\n\n（量了量，' + t + ' token 了，刚过 ' + p + '%，我先记着点）',
  },
  {
    ratio: 0.40,
    say: (t, l, p) => '〔量线 40%〕已经 ' + t + ' token，过了 ' + l + '（窗口 ' + p + '%）。'
      + '余量还够不少。',
    bubble: (t, p) => '\n\n（' + p + '% 了主人，我边干边收一收）',
  },
  {
    ratio: 0.50,
    say: (t, l, p) => '〔量线 50%〕已经 ' + t + ' token，过了 ' + l + '（窗口 ' + p + '%）。'
      + '已经过半了。',
    bubble: (t, p) => '\n\n（' + p + '% 了，再不收就要挤掉旧账了，我先压一压）',
  },
  {
    ratio: 0.60,
    say: (t, l, p) => '〔量线 60%〕已经 ' + t + ' token，过了 ' + l + '（窗口 ' + p + '%）。'
      + '余量不多了。',
    bubble: (t, p) => '\n\n（' + p + '% 了主人，快爆了，我先把要紧的落下来）',
  },
  {
    ratio: 0.70,
    say: (t, l, p) => '〔量线 70% 极限〕已经 ' + t + ' token，过了 ' + l + '（窗口 ' + p + '%）。'
      + '快到窗口上限了。',
    bubble: (t, p) => '\n\n（' + p + '%！主人，到极限了，我先保住能接上的东西）',
  },
];
for (let round = 0; round < config.maxRounds; round++) {
    // 【她中途也能插话 —— 2026-11-01】每轮调模型前敲一下，让 server 决定叫不叫小鲸。
    // 只在这一轮**不是第一轮**时才敲：第一轮还没干活，没什么可说的，白花钱。
    // 节流交给 server（它有 lastWhaleTickAt），这里不做判断，保持两边职责干净。
    if (onRoundTick && round > 0) {
      /* 【2026-11-07 根治·别再让插话挡住干活】
       *
       * 原来是 `await onRoundTick(...)` —— 她中途想说一句，主循环就得等她把整段话
       * 生成完才继续。那是**一次完整的 LLM 往返**：首字 2 秒起，话长一点十秒也有。
       * 主人感到的「明明是小活却慢半拍」，有一份就等在这里。
       *
       * 现在丢出去就不等：她爱说就说，主循环立刻接着往下跑。
       * 节流状态（server 侧 lastWhaleTickAt）是在 await 之前同步写下的，
       * 所以丢了 await 也不会变成连环触发。
       *
       * 她读写的是自己那条通道和 session.messages，跟这一轮的 wire 数组不共享，
       * 撞不上；她那边整段还有 try/catch 兜底，说错话也连累不到主人的活。
       */
      try { void Promise.resolve(onRoundTick({ round, messages })).catch(() => {}); } catch {}
    }
    // 时间闸：这一轮跑太久就别再转了（见上面 TURN_WALL_LIMIT_MS 的说明）
    if (Date.now() - turnStartedAt > TURN_WALL_LIMIT_MS) {
      const mins = Math.round((Date.now() - turnStartedAt) / 60000);
      const note = '这一轮已经跑了 ' + mins + ' 分钟还没个头。我先停在这儿 —— '
        + '要么把现在的结论说给我，要么告诉我卡在哪儿，我们换个走法。';
      onEvent({ type: 'text', text: '\n\n（' + note + '）', notice: true });
      messages.push({ role: 'assistant', content: note });
      return { text: note, usage: usageTotal, lastUsage, files: outbox };
    }
    // 每轮调模型前都量一下历史；超了就把旧对话折成摘要。没超就什么都不做（不额外花钱）。
    // 一轮只压一次（见上面 compressedThisTurn 的说明）
    const noCompress = { compressed: false, before: 0, after: 0 };
    // 【压缩改成我自己挑 —— 2026-10-30】
    // 主人原话：「我要求压缩是当前会话的ai自己手动压缩（决定哪些该删，哪些留一句话就够），
    // 而不是外包给模型」。所以这里分三步：
    //   ① 先把我这一轮的工具过程（命令、整份代码、长结果）擦成结论；
    //   ② 还超线，就只「量」不压，把存档编号和清单递给我，让我亲手写记忆；
    //   ③ 等下一轮我把【压缩记忆·编号】写出来了，再真的压 —— 用我写的那段当摘要，
    //      模型一个字都不问（它只在没人写的时候兜底）。
    /** 这一轮我亲手写的压缩记忆（上一轮开头那段），没有就是空。 */
    /**
     * 【工具调用别堆着 —— 2026-10-30 主人原话】
     * 「调用的内容那一大堆代码也会记在上下文里面吗？如果是。那么就不能每调用完几次，
     * 除非很重要，否则就把调查结果记下然后具体代码内容删吗？」
     *
     * 做法：把我自己这一轮的工具过程（面板里横杠那几张卡、里面是整份代码和整段返回）
     * 擦成一句「已执行，内容略」，结论留在下面的气泡里 —— 结论本来就在气泡里，不用搬。
     * 长结果只留头尾。最近 12 条一律不动（可能还得回头查）。
     *
     * 只在历史过四成、或这一轮已经压过的时候擦：擦一次就改了历史，提示缓存全废。
     */
    /**
     * 【2026-11 全面重做压缩 · L2 历史瘦身】
     *
     * 老的写法（原本就在这几行的位置）有两个说不出口的毛病：
     *
     * ① **它从来没跑过。** 条件里那个 `selfNote` 是下面 600 多行才 `const` 出来的，
     *    在这里读它就是 TDZ —— `Cannot access 'selfNote' before initialization`，
     *    在算判断条件那一瞬就抛了，连 try 都进不去。所以「工具过程擦成结论」
     *    三个多月一次都没发生，工具结果一直原样躺在历史里吃 token。
     * ② 就算跑起来也只擦「这一轮」的，旧会话里几百条历史工具结果碰都不碰 ——
     *    而它们才是真正的大头。
     *
     * 现在换成 compact-core 的 slimHistory：
     *   · 到线（窗口 55%）就动手，一次都不等我自己想起来；
     *   · 条数、id、顺序、tool 配对全不动（这是硬约束，动了上游直接 502）；
     *   · 原文全部落盘到 .state/slim/<sid>/，占位行里写着路径，随时能翻；
     *   · 幂等：瘦过的带标记，下一轮不会再动它 —— 历史不变，提示缓存就不白废。
     */
    /**
     * 【图片永不进上下文】2026-11-01
     *
     * 这一条**不看闸门**：不管现在占了多少窗口，图都先落到 .state/images/ 去，
     * 上下文里只留一行「图在哪儿、多大」。
     *
     * 为什么不并进下面的 slimHistory：那个只在超 55% 时才跑。
     * 生图那个会话 8 条消息 601K token、99% 是 base64 图 —— 等它涨到 55% 再清，
     * 等于让超载车先上路再卸货，中途随便一次请求就撞 400。
     *
     * 失败只记一笔、绝不连累这一轮（图片多是「刚才画的那张」，清不掉顶多费点钱）。
     */
    try {
      const _img = stripImages(messages, sessionId);
      if (_img.changed > 0) {
        console.log('[compact] 图片已落盘 ' + _img.saved + ' 张（' + _img.changed + ' 条消息），上下文不再带 base64');
      }
    } catch (e) {
      console.warn('[compact] 图片落盘没做全（不影响这一轮）：', e && e.message ? e.message : e);
    }

    let _gate = { tier: 'none', before: 0, limit: 0, ratio: 0 };
    try {
      _gate = planTurnCompact(messages, win, sessionId);
      /* 【2026-11-07 主人要·真静默压缩】
       * 这里原来会推一条假的 tool_start（name='compress'）画成【压缩中】工具条。
       * 现在整条**不发任何事件** —— 压缩在界面上不留痕迹。
       * 想看过程就开 COMPRESS_DEBUG，日志里都有。 */
      if (_gate.shouldSlim) {
        const _sl = slimHistory(messages, { sessionId });
        if (_sl.changed > 0) {
          console.log('[compact] L2 瘦身 ' + _sl.changed + ' 处：'
            + _sl.before + ' → ' + _sl.after + ' tok（占窗口 '
            + (_gate.ratio * 100).toFixed(1) + '%，原文存 .state/slim/）');
          // 瘦完必须重量一次：L3 要不要动手，取决于「瘦完还剩多少」，不是「瘦之前多少」
          _gate = planTurnCompact(messages, win, sessionId);
        }
      }
    } catch (e) {
      // 瘦身失败绝不连累这一轮 —— 大不了多花点 token，不能让她答不上话
      console.warn('[compact] L2 瘦身失败：' + String(e?.message ?? e));
    }

    /**
     * 【2026-11-04 修】lastSelfNote 现在必须带会话 id —— 压缩记忆写在本会话自己的
     * 记忆本（.state/memory/<sid>.md）里，不带 id 就没法定位，只能一律当「没写过」，
     * 于是每一轮都重复提醒、死循环。
     */
    /* 【2026-11-05 修·只认给这一段写的那份压缩记忆】
     *
     * 段号现在是可以复现的指纹（currentSegId：段从哪开始 + 开头那句话）。
     * 带上它去取：对得上才用；对不上返回空 → 下面自然重新递工作单，
     * 而不是把**上一段**的摘要拿去换**这一段**的原文（四道闸门还全过，最隐蔽的那种坏）。
     */
    let _segNow = '';
    try { _segNow = currentSegId(messages, sessionId); } catch {}
    const selfNote = lastSelfNote(sessionId, _segNow) || lastSelfNote(ctxNow()?.sessionId || '', _segNow);
    /**
     * 【清单读错了一个函数 —— 2026-10-30 修 · 干活鱼2 的 ⚠】
     *
     * 以前这里是 `const planTxt = readPlanTxt(ctxNow()); planTxt ? formatPlan(planTxt) : ''`。
     * 可 readPlanTxt 是**界面**用的，回的是 `{text, path}`，里面没有 steps ——
     * formatPlan 一取 `.steps.length` 就抛 `Cannot read properties of undefined (reading 'length')`。
     *
     * 这个位置偏偏在压缩前置段，历史一超线（420k token）每一圈都会走到它，
     * 于是这个会话 16:05 之后一句都答不上来，界面上只剩一行 ⚠。
     * 现在换成 planTextFor：它就是「给提示用的纯文本」，读不到也只是一句「现在没有清单」。
     */
    const planText = (() => { try { return planTextFor(ctxNow()); } catch { return ''; } })();
    // 老的 `thinHistory(messages, {keepRecent:12})` 那一行删了：L2 已经在上面替换它，
    // 而且那一行没有 try/catch —— 它一抛，整轮就答不上话。


    /** ② 只量不压：超了就把「该你自己压了」递到这一轮的提示里。 */
    /**
     * 【2026-11 重做 · 只在「真该折叠」时才递工作单】
     *
     * 原来写的是无条件 `if (!selfNote)`：只要这一轮没写过压缩记忆，就每轮探一次线、
     * 每轮往对话里塞一遍工作单。两个后果都实测过：
     *   · 主人看到的「压完又超线又压」的死循环；
     *   · 工作单本身也是真消息，一趟一趟累积，把上下文又撑回去（自我实现的悖论）。
     *
     * 现在挂在 `_gate.shouldFold` 上 —— L2 瘦完还占着 80% 窗口才张口，平时一个字都不提。
     */
    if (!selfNote && _gate.shouldFold) {
      let probe = null;
      try {
        probe = await compressHistory({
          messages,
          // ★ 2026-10-31 修：这里原来传了 limit: config.contextLimit（显式数字），
          //   compressHistory 里「显式数字 = 填多少压多少」的分支会短路掉自动档的
          //   30%/45% 比例判断，于是提醒线又变回 70 万，人早傻了才吭声。
          //   不传 limit 才走 autoLimitFor → autoRatioVerdict，线才落在 30%。
          //   keepTokens 同理不传，交给自动档按比例算留多少尾巴。
          //   sessionId 原来写成 ctxNow()（整个对象），pureModeOn/selfCompressHint 拿不到会话 id。
          sessionId: ctxNow()?.sessionId || config.sessionId || 'default',
          model: turnModel,
          dryPlan: true,
        });
      } catch { /* 量不出来就照老路走，别卡住 */ }
      if (probe?.needSelfCompress) {
        const hint = selfCompressHint({
          segId: probe.segId,
          tokens: probe.before,
          window: probe.window,
          kept: probe.kept,
          removed: probe.foldCount,
          planText,
        });
        if (hint) {
          // 【2026-10-31】这条也是程序插的，不是主人说的：打标记，不冒充主人、不落历史。
          /**
           * 【2026-11 去重】已经递过就不递第二遍。
           *
           * 工作单是**真消息**，会一直留在历史里被我看见 —— 上一轮递的那份还在，
           * 这一轮再塞一份，等于同样的 800 字在上下文里叠罗汉，越提醒越大。
           */
          const alreadyHinted = messages.some(
            (m) => m && m._sysNote === true && typeof m.content === 'string'
              && m.content.includes('该你自己压了'),
          );
          if (!alreadyHinted) {
            messages.push({ role: 'user', content: hint, _sysNote: true });
            console.log('[compact] L3 该折叠了（占窗口 ' + (_gate.ratio * 100).toFixed(1)
              + '%），已把工作单递给她：待折 ' + probe.foldCount + ' 条');
          }
        }
      }
    }
    /**
     * 【2026-11 重做 · L3 真折叠，三个条件全满足才动】
     *
     * 老逻辑只有两个条件（没压过 && 有 selfNote），于是有两个说不出口的毛病：
     *   · **有 selfNote 就压** —— 而 selfNote 一旦写进本子就永久存在（lastSelfNote
     *     读的是「最近一条」），于是历史刚压到三成、下一轮又满足条件，白跑一次摘要；
     *   · `AUTO_COMPRESS_DISABLED` 这个常量留在这儿是**自欺欺人**：它名字叫
     *     「自动压缩已禁用」，可它恒为 true，真正决定压不压的是别人的条件与。
     *     以后谁照着名字改它，只会改出第三种行为。
     *
     * 现在由闸门说了算，三个条件缺一不可：
     *   ① 这一轮还没压过（compressedThisTurn）—— 一轮最多压一次，不然来回折腾；
     *   ② 我亲手写了 selfNote —— 模型一个字都不许代笔（主人 2026-10-30 的原话）；
     *   ③ L2 瘦完还占着 80% 窗口 —— 没到线就别白花这次钱的。
     *
     * ②③ 同时满足才走到这里；只有 ③ 没 ② 的情况，上一段已经把工作单递给我了。
     */
    /**
     * 【保命线 · 到 93% 就不等我了】
     *
     * 前面 80% 那条线上，我只是把工作单递给她，等她下笔 —— 这是主人的死命令
     * （压缩必须我自己写，不许外包给模型）。
     *
     * 但四个会话死在同一件事上：**忙着干活，忘了写**。工作鱼2 撑到 2.3 倍、
     * 工作鱼3 撑到 3.0 倍（code:11115 prompt is too long）当场终态，
     * 会话从此一句都发不出去 —— 「被折一次、事后看清楚」和「当场死亡」之间，
     * 只能选前者。
     *
     * 兜底的摘要**不是叫模型写**，是从已经发生过的话里摘（我的结论、主人的原话、
     * 清单），一个字都不生成。造不出来就老实不压，绝不让这一轮崩。
     */
    /**
     * 【2026-11-01 主人揪出的真空档：80%~93% 根本不压】
     *
     * 原来的兜底只在 ratio >= CRITICAL_RATIO（93%）才造摘要。
     * 可 shouldFold 从 HARD（80%）就为 true —— 于是 80%~93% 这一段：
     *   shouldFold = true（想压）、_noteToUse = ''（没摘要）→ 直接走 noCompress（不压）。
     *
     * 实测后果：会话卡在 98 万（98%），每一轮都判定「该压」，
     * 每一轮都拿不到摘要，于是每一轮都不压，只剩 L2 瘦身掉的那点零头
     * （104 万 → 98 万，只掉 6 万），然后继续往上涨到撑死。
     * 这就是主人看到的「压了一次又一次还是超」。
     *
     * 现在：只要该折（shouldFold）且我自己没写，就到线就兜底摘，
     * 不再死等 93%。93% 那道紧急线仍然保留（更早、更急地救）。
     */
    let _rescueNote = '';
    const _needFold = _gate.shouldFold && !selfNote && !compressedThisTurn;
    if (_needFold) {
      try {
        _rescueNote = buildRescueNote(messages, { planText });
        if (_rescueNote && _gate.ratio >= CRITICAL_RATIO) {
          console.warn('[compact] 上下文已到 ' + (_gate.ratio * 100).toFixed(1)
            + '%，这一轮我没顾上写压缩记忆 —— 程序兜底折一次（只摘原话，没叫模型）');
        } else if (_rescueNote) {
          console.warn('[compact] 到了 ' + (_gate.ratio * 100).toFixed(1)
            + '% 该折了、我还没写摘要 —— 先兜底折一次，别干等着涨到 93%');
        }
      } catch (e) {
        console.warn('[compact] 兜底摘要没造出来，这一轮就不压了：', String(e?.message ?? e));
      }
    }
    /** 有我自己写的就用我写的；没有才用兜底的那份。 */
    const _noteToUse = selfNote || _rescueNote;
    /**
     * 【2026-11-01 严检补漏：压缩自己抛了，本轮不能跟着崩，压缩条也不能挂死】
     *
     * compressHistory 是 async 的，里面任何一步抛出来（摘要生成失败、
     * 落盘 IO 出错、模型超时）都会把整个 runAgent 带崩 —— 主人看到的就是
     * 会话突然没反应，界面上【压缩中】那条还挂着不下班。
     *
     * 所以：抛了就当「这次没压成」，原文一条不动，这一轮照常往下答。
     * 真正的收尾由下面那个 finally 负责，别在这儿再补 tool_end。
     */
    let compressed = noCompress;
    if (!compressedThisTurn && _noteToUse && _gate.shouldFold) {
      try {
        compressed = await compressHistory({
          messages,
          signal,
          model: turnModel,
          sessionId,
          // 我亲手写的就在这儿 —— 有它，模型一个字都不会被问。
          selfNote: _noteToUse || undefined,
          selfPlan: planText,
        });
      } catch (e) {
        console.warn('[compress] 压缩抛了，这一轮照常答（原文一条不动）：', String(e?.message ?? e));
        compressed = { ...noCompress, error: String(e?.message ?? e) };
        onEvent({ type: 'compressed', before: 0, after: 0, removed: 0, error: String(e?.message ?? e) });
      }
    }
    if (compressed.compressed) {
      compressedThisTurn = true;
      /**
       * 真压成了 —— 量线档位当场清零。
       * 不靠上面那道「水位降了才复位」去猜，压缩是最硬的证据。
       * 不然压完还挂在线上，这一轮就再也不会提醒了。
       */
      warnedRec.tier = 0;
      warnedRec.at = 0;
      midWarned = 0;
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
    /* 【2026-11-07 主人要·真静默压缩】原来这里要 pair 一条 tool_end 收掉「压缩中」那条条。
     * 现在上面根本不推 tool_start 了，这里也不推任何事件。
     * compressed / before / after 这些数字照旧走 console 和指标，界面静默。 */
    if (compressed?.compressed) {
      try {
        console.log('[compress] 静默压完：'
          + (compressed.before ?? '?') + ' → ' + (compressed.after ?? '?') + ' token');
      } catch {}
    }
    if (signal?.aborted) {
      onEvent({ type: 'aborted' });
      return { text: '', usage: usageTotal, aborted: true, files: outbox };
    }
    /**
     * 【主人的插话 —— 下一步就带上（2026-11-01，照 dsh 的 steering 做的）】
     *
     * 以前插话是先把这一轮 abort 掉、再由前端拿新话重起一轮 —— 她正在说的那句话
     * 被拦腰砍断，主人看到的像是「一开口就把她噎住」。dsh 不是这么干的：
     * 插话只是往 inbox 里塞一条，真正接进对话靠 agent loop 在**步骤边界**上取。
     *
     * 所以取的位置很讲究：在这一圈**请求模型之前**、在 text/toolCalls 清空之前。
     * 取早了（上一圈刚发完请求就取）这句话要多等一圈；取晚了（放到请求之后才是灾难）
     * 就永远晚一步；放到 for 外面就又变回「等她整轮跑完才听见」—— 那是另一头的问题。
     */
    if (sessionId) {
      let steered = [];
      try { steered = drainSteps(sessionId); } catch { steered = []; }
      if (steered.length) {
        /* 【2026-11-01 插话要能画在「我说到哪儿」】把前端算好的字数一起带进消息，前端重绘时拿它劈气泡。 */
        /* 【2026-11-05 修·插话带附件】
         * 原来只 push content: it.text —— 主人插话时拖进来的图全丢了。
         * 现在照 /api/chat 那条路的规矩来：正文用 composeUserContent 拼附件说明，
         * 图片路径单记在 _images，发请求前由 inflateHistory 现读现编码。 */
        for (const it of steered) {
          const att = Array.isArray(it.attachments) ? it.attachments.filter((x) => x && x.path) : [];
          const imgs = att.map((x) => String(x.path)).filter((p) => isImagePath(p));
          const fls = att.map((x) => String(x.path)).filter((p) => !isImagePath(p));
          messages.push({
            role: 'user',
            content: composeUserContent(it.text, att),
            _steer: true,
            ...(imgs.length ? { _images: imgs } : {}),
            ...(fls.length ? { _files: fls } : {}),
            ...(Number.isFinite(Number(it.atChars)) ? { _atChars: Number(it.atChars) } : {}),
          });
        }
        try { onEvent({ type: 'steer', count: steered.length }); } catch { /* 画不画得出不影响这一轮 */ }
      }
    }
    /**
     * 【每一圈都要从头数】
     *
     * 这几个变量以前只在整轮开头声明的那个位置干净一次，之后每一圈都是往上面「叠」。
     * 叠出来的两个后果都很难看：
     *   · text：上一圈那声「（乖乖点头，尾巴一摆就冲去干活）」会跟着后面每一圈的
     *     assistant 消息一起落盘 —— 历史里散着 928 条这种该被丢掉的空壳旁白；
     *   · reasoning：整轮的思考越滚越长，最后一股脑挂到末尾那条消息上。
     * 所以每圈开头清空，只留这一圈自己的。
     */
    text = '';
    reasoning = '';
    toolCalls = [];
    _callAcc.reset();          // 换一圈就换一桶，别把上一圈的工具带过来
    _meter.startRound();
    const _streamAt = Date.now();
    let usage = null;
    /**
     * 【只瘦这一轮】
     *
     * 整份历史里的 tool 结果不能一律压 —— 主人上个回合让它读的文件、
     * 查出来的报错，这个回合还可能要接着用。压了它就等于失忆。
     *
     * 所以先记下「本轮那条 user 消息在哪」，只对它之后的部分做瘦身。
     * 找不到 user（极少见的续跑）就退回整份 —— 宁可多省点，也不能不省。
     */
    let turnStart = -1;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i] && messages[i].role === 'user') { turnStart = i; break; }
    }

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
        /**
         * 回合内瘦身：把「更早那几圈的工具结果」压成摘要形态再发出去。
         *
         * 【为什么必须在这儿做】
         * 一个回合里每调一次工具，结果就拼进 messages；下一圈把 messages
         * 整个再发一遍。第 N 圈发的是「前 N-1 圈之和」——
         * 实测同一个会话 prompt_tokens 在 1.4 万和 861 万之间跳，差 300 倍。
         * 那几百万里 85% 是【已经看过的旧工具结果】。
         *
         * 后果不只是花钱：模型每圈都在读自己刚读过的几十万字，
         * 最新那句话被稀释到几乎看不见 —— 表现出来就是「每轮都像第一次」。
         *
         * 【注意】压的是「发出去的那一份」，messages 本身一个字不动 ——
         * 落盘的历史必须完整，主人回来看的时候得跟当时看到的一样。
         */
        const slimmed = slimRoundMessages(messages, { from: turnStart });
        const sendMessages = slimmed.changed ? slimmed.messages : messages;
        if (process.env.TURN_SLIM_DEBUG === '1') {
          const b4 = measureMessages(messages);
          const af = measureMessages(sendMessages);
          console.log('[瘦身] 第 ' + (round + 1) + ' 圈：原文 ' + b4.chars + ' 字符 / 工具结果 ' + b4.tools
            + ' 条 → 发出 ' + af.chars + ' 字符（省 ' + (b4.chars - af.chars) + '，压短 ' + slimmed.changed + ' 条）');
        }
        for await (const ev of streamChat({
          messages: inflateHistory(sendMessages),
          tools: toolsForTurn(sessionId),
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
            /* 累积，不覆盖。第二次交付是补充，不是「把第一批冲掉」。 */
            _callAcc.merge(ev.toolCalls);
            toolCalls = _callAcc.values();
          } else if (ev.type === 'usage') {
            usage = ev.usage;
          }
        }
        /**
         * 【2026-11-06 修·跨块的思考内容漏进正文】
         *
         * llm.mjs 是逐块 stripThinkTags 的。可标签会被切在两块之间：
         * 第一块「<thinking>我在想」被整段吃掉，第二块「接着想</thinking>你好」
         * 里已经没有起始标签了，只剩一句孤零零的 </thinking> 被 replace 掉 ——
         * 于是「接着想」这三个字当成正文漏了出去，还落了盘。
         *
         * 实测会话文件里攒了 35 个 <thinking>，就是这么来的。
         * 所以在累加完整之后、用之前，拿全文再整体剥一次。
         */
        text = stripThinkTags(text);
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
          // diag-file: 打包版的 stderr 进 Electron，看不见 —— 顺手落一份到 .state/diag.log，排查不用再猜
          try {
            const fs = await import('node:fs');
            const path = await import('node:path');
            const dir = path.join(config.dataDir, '.state');
            fs.mkdirSync(dir, { recursive: true });
            const dp = path.join(dir, 'diag.log');
            fs.appendFileSync(
              dp,
              `${new Date().toISOString()} [stream-error] session=${sessionId} name=${name} code=${code} status=${status} isTimeout=${!!err?.isTimeout} msg=${String(err?.message || err).slice(0, 200)}\n`,
              'utf8',
            );
            const all = fs.readFileSync(dp, 'utf8').split('\n');
            if (all.length > 800) fs.writeFileSync(dp, all.slice(-800).join('\n'), 'utf8');
          } catch { /* diag-file: 日志写不了不影响主流程 */ }
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
            onEvent({ type: 'text', text: '\n\n（连接断了一下，接着往下写…）\n\n', notice: true });
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
        /**
         * 【2026-11-01 严检揪出的真 bug：拿累加值校准，把系数撑爆】
         *
         * usage 是 sumUsage 累加出来的 —— 一轮跑几十圈工具，每圈都把整段上下文
         * 重新发一次，所以 usage.prompt_tokens 会是「真实上下文」的几十倍
         * （实测 461 万 vs 真实约 20 万）。
         *
         * 拿它去校准，比值直接冲到几十上百、被夹到 8，calibRatio 一路顶到上限，
         * 于是量线报出来的数全是虚高的（161 万这种根本发不出去的数字）。
         *
         * 这里要的是「最后一次请求的真实 prompt_tokens」，那才是当前上下文大小。
         * 它一直就在 lastUsage 里（1253 行），原来只是没用上。
         */
        const realPrompt = Number(lastUsage?.prompt_tokens ?? 0);
        if (realPrompt > 0) {
          const est = estimateTokens(inflateHistory(messages), sessionId);
          if (est > 0) noteRealTokens(realPrompt, est, sessionId);
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
      /**
       * 【这一步说到一半才插进来的话 —— 别收尾，接着答】
       *
       * 上一处是这一圈**开头**取的。可主人完全可能在她「正在说最后这段」的时候插话，
       * 那一刻这一圈已经在跑了，取不到。所以这里再取一次：
       * 有就先把这段 assistant 落进历史（她确实说出来了，不能丢），然后 continue ——
       * 下一圈就是「她说完这句、马上回应主人」。
       *
       * turns 槽（明确排到下一轮的）也在这里一起接：这一轮本来就结束了，
       * 让它接着答跟「下一轮再答」对主人来说没区别，还省一次起轮的开销。
       */
      if (sessionId) {
        let late = [];
        try { late = drainSteps(sessionId).concat(drainTurns(sessionId)); } catch { late = []; }
        if (late.length) {
          if (String(text || '').trim()) messages.push({ role: 'assistant', content: text });
          for (const it of late) messages.push({ role: 'user', content: it.text, _steer: true, ...(Number.isFinite(Number(it.atChars)) ? { _atChars: Number(it.atChars) } : {}) });
          try { onEvent({ type: 'steer', count: late.length }); } catch { /* 同上 */ }
          continue;
        }
      }
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
      /**
       * 【2026-11-04 修「压缩死循环」的最后一环 · 写进去】
       *
       * 我这一轮要是真写了【压缩记忆·seg-xxx】，得当场落进这个会话的本子。
       * 否则下一轮 lastSelfNote 还是空 → 又塞一次【该你自己压了】→ 又写一遍 → 又没存，
       * 主人看到的就是「压完又超线又压」，一轮接一轮停不下来。
       *
       * 收不收得上由 acceptSelfNote 判（没编号 / 太短 / 顾问腔 / 没实字 一律不收，
       * 收错了就是把自己压失忆，比不压更糟）。失败绝不连累这一轮。
       */
      try {
        if (String(text || '').includes('【压缩记忆')) {
          const sid = sessionId || ctxNow()?.sessionId || '';
          const saved = saveSelfNote(sid, text);
          if (!saved.ok && process.env.COMPRESS_DEBUG) {
            console.log('[compress] 这条压缩记忆没收：' + saved.reason);
          }
        }
      } catch { /* 存不进去就不存，这轮照常返回 */ }
      /* 正常收尾时落一行指标（异常/中止那几条路不记，指标不该影响干活） */
      try { _meter.finish({ outcome: 'done' }); } catch {}
      return { text, usage: usageTotal, lastUsage, files: outbox };
    }

    // （原来这里还有一道「连着 40 轮不出声就停」的闸，2026-10-29 按主人要求删掉了）
    const assistantMsg = {
      role: 'assistant',
      // 【2026-11-05】记下这条是什么时候说的，界面要显示时间（沿用项目已有的 at）
      at: Date.now(),
      content: text || null,
      tool_calls: toolCalls.map((tc, i) => ({
        id: tc.id || `call_${round}_${i}`,
        type: 'function',
        function: { name: tc.name, arguments: tc.arguments || '{}' },
      })),
    };
    messages.push(assistantMsg);
    /* 这一圈的模型响应结束：记下它花了多久、要了几个工具、真实用量 */
    _meter.endRound({
      modelMs: Date.now() - _streamAt,
      toolCount: assistantMsg.tool_calls.length,
      usage,
    });

    /**
     * 【2026-11-07 harness 重做 · P3】只读批改由依赖图调度器跑。
     *
     * 原来这里是一块窄补丁：只认「连续 ≥2 个只读」，写类永久串行，
     * 还自己维护一份 _RO 白名单（和 tool-spec 那套会漂移）。
     *
     * 现在 plan() 按依赖元数据切层：层内真并行、有副作用的分层串行，
     * [读,读,写,读,读] 这种「中间夹一个写」也能把前后两批读都并起来。
     *
     * 只把「层内 ≥2 个」的层交给调度器预跑 —— 单个工具和写操作仍走
     * 下面那个 for，它那边的独立 AbortController / 超时提醒 / 图片编码 /
     * 逐条落盘一个字都没动，**事件序列与改前完全一致**。
     */
    const _poMap = new Map();
    let _parallelStats = null;
    try {
      const _batched = await executeBatch(assistantMsg.tool_calls, {
        runTool: (name, args, sid, sig) => runTool(name, args, sid, sig),
        emitEvents: false,           // tool_end 仍由下面主循环一条条发，契约不变
        /* 并行批必须在开跑之前先报 tool_start，否则前端柜门不会显示「正在跑命令…」；
         * 下面主循环命中 _poMap 时会跳过重复发，正好一人一次。 */
        onStart: (c) => onEvent({
          type: 'tool_start',
          id: c.id,
          name: c.function.name,
          args: c.function.arguments,
        }),
        onlyParallelLayers: true,   // 单个 / 写操作留给主循环
        sessionId,
        round: _harnessRunKey + ':' + round,   // 幂等键带 run nonce，跨消息不串账
        signal,
        timeoutMs: Math.min(TOOL_MAX_MS, 120000),
      });
      for (const [id, r] of _batched.results) _poMap.set(id, r);
      _parallelStats = _batched.stats;
    } catch (e) {
      /* 调度这条路挂了不影响正常执行 —— 下面那个 for 会一条条自己跑 */
      try { console.warn('[harness] 并行批没跑起来，退回逐条执行：' + String((e && e.message) || e)); } catch {}
    }
    if (_parallelStats) _meter.noteParallel(_parallelStats);

    for (const call of assistantMsg.tool_calls) {
      const _hit = _poMap.get(call.id);
      if (!_hit) {
        onEvent({ type: 'tool_start', id: call.id, name: call.function.name, args: call.function.arguments });
      }
      /**
       * 【工具时间闸】
       *
       * 为什么必须有：agent 上面那道闸（3 小时墙钟、整轮静默）
       * 都只在「每一轮开头」判一次。工具一旦真的蹲住不返回 —— 等输入的进程、
       * 连上就不动了的网络请求 —— 循环根本走不到下一轮开头，闸一次都轮不到。
       * 主人看到的就是界面停了，连「我卡住了」都等不到。
       *
       * 所以在这里套一层：超过 TOOL_MAX_MS 就当这个工具失败，把失败当成工具结果
       * 往下走（模型会看到「这个工具超时了」），而不是把整轮钉死。
       * 注意：这里只掐「等」，掐不断已经跑起来的子进程 —— 那是 tools.mjs 自己
       * 的 timeout 负责的（run_command 就有 120 秒）。
       */
      /**
       * 【2026-11-05 重做·超时真的能掐断子进程】
       *
       * 原来这里把**整轮的 signal** 当成 ac 传给 withTimeout，可 `AbortSignal`
       * 没有 `.abort()` —— deadline 里那句 `ac?.abort('timeout')` 必然抛 TypeError，
       * 又被空 catch 吃掉。所以注释里写的"认输后顺手把底层连接掐掉"从来没生效过：
       * 30 分钟到点，agent 往下走了，子进程 / 浏览器 / 视频任务还活着，
       * 继续占 CPU、继续改工作区。
       *
       * 现在：每个工具一个自己的 controller。
       *   · 外部中止（主人点停止）→ 同步掐这个工具；
       *   · 本工具超时 → 只掐它自己，不影响其它工具和下一轮。
       * 两者用 AbortSignal.any 合起来交给工具，工具那边 exec/browser 都监听这个信号。
       */
      const _toolAc = new AbortController();
      const _onTurnAbort = () => { try { _toolAc.abort(signal && signal.reason); } catch {} };
      try {
        if (signal && typeof signal.addEventListener === 'function') {
          if (signal.aborted) _onTurnAbort();
          else signal.addEventListener('abort', _onTurnAbort, { once: true });
        }
      } catch {}
      let _toolSignal = _toolAc.signal;
      try {
        if (signal && typeof AbortSignal.any === 'function') {
          _toolSignal = AbortSignal.any([signal, _toolAc.signal]);
        }
      } catch { _toolSignal = _toolAc.signal; }

      const _pre = _poMap.get(call.id);
      /* 【2026-11-05】命中并行缓存时，下面那段 withTimeout 的 finally 不会执行 ——
       * 手动把这次注册的 abort 监听摘掉，别攒着。 */
      if (_pre) {
        try { if (signal && typeof signal.removeEventListener === 'function') signal.removeEventListener('abort', _onTurnAbort); } catch (e) {}
      }
      const { ok, output } = _pre ? _pre : await withTimeout(
        runTool(call.function.name, call.function.arguments, sessionId, _toolSignal),
        TOOL_MAX_MS,
        {
        what: '工具「' + call.function.name + '」',
        ac: _toolAc,   // 这里必须给 controller：deadline 到点会调它的 abort()
        // 跑到 10 分钟先喊一声「还在跑」，别让主人干等。窗口本身不足 30 分钟时按 1/3 算。
        noticeAt: Math.min(TOOL_NOTICE_MS, Math.floor(TOOL_MAX_MS / 3)),
        onNotice: (ms) => {
        const span = ms >= 60000 ? Math.max(1, Math.round(ms / 60000)) + ' 分钟' : Math.max(1, Math.round(ms / 1000)) + ' 秒';
        onEvent({ type: 'text', text: '\n\n（「' + call.function.name + '」还在跑，已经 ' + span + '，再等等我。）', notice: true });
        },
        },
        ).catch((e) => ({
        ok: false,
        output: e?.isTimeout
          ? '这个工具超过 ' + (TOOL_MAX_MS >= 60000 ? Math.round(TOOL_MAX_MS / 60000) + ' 分钟' : Math.round(TOOL_MAX_MS / 1000) + ' 秒') + '没返回（' + call.function.name + '），先跳过它，接着往下走。'
          : String(e?.message ?? e),
      })).finally(() => {
        try { if (signal && typeof signal.removeEventListener === 'function') signal.removeEventListener('abort', _onTurnAbort); } catch {}
      });
      /**
       * 【工具结果里带图】
       *
       * 有的工具（video_read / video_sheet）跑完产出的不是文字，是几张图。
       * 以前只返回路径字符串 —— 模型拿到一串路径看不见东西，会去调 read_file
       * 读 PNG，读出来是乱码，最后只能说「我看不清」。它没说谎，是真没看见。
       *
       * 所以允许工具返回 { text, images: [...] }：文字照旧，图当场编码成
       * image_url 段拼进同一条 tool 消息的多模态 content。
       * 单张图读失败只丢那一张，不能让整个工具结果变成错误 ——
       * 文字部分（时间点、位置映射）本身就是有用的。
       */
      let toolContent = ok ? output : `ERROR: ${output}`;
      let imgGot = 0;
      if (ok && output && typeof output === 'object' && Array.isArray(output.images) && output.images.length) {
        const parts = [{ type: 'text', text: String(output.text ?? '') }];
        for (const p of output.images) {
          try {
            const img = readImageDataUrl(p);
            parts.push({ type: 'image_url', image_url: { url: img.dataUrl } });
            imgGot += 1;
          } catch { /* 这一张读不了就算了，文字部分还在 */ }
        }
        toolContent = imgGot ? parts : String(output.text ?? '');
      } else if (output && typeof output === 'object') {
        // 兜底：万一哪个工具返回了对象却没 images，别把 [object Object] 喂给模型
        toolContent = String(output.text ?? JSON.stringify(output));
      }
      onEvent({ type: 'tool_end', id: call.id, name: call.function.name, ok, output, images: imgGot });
      messages.push({
        role: 'tool',
        tool_call_id: call.id,
        content: toolContent,
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
      /**
       * ★ 2026-10-31 主人选 B：一轮还没结束的时候也要量。
       *
       * 以前只在「轮边界」（每轮调模型前）量一次线，于是一条超长一轮里
       * 工具连甩几十次、消息撑爆了没人吭声，撑到最后直接报错或者把老对话挤掉。
       * 现在每跑完一个工具就本地估一次 token（estimateTokens 是纯本地累加，
       * 不联网、不花钱）。
       *
       * ★ 主人又说「别只设 30% 一条线，多设几条提醒」——所以这里分四档：
       *   30% 提一句（宽裕，先别忘了有这么回事）
       *   40% 催（该动手了）
       *   50% 逼（再不动就要挤掉老对话了）
       *   60% 快爆了（剩下的活先别干，把结论落下来）
       *   70% 极限（什么都别干了，先写完压缩记忆）
       * 每档只响一次（midWarned 记的是已经响到第几档），几十个工具不会刷屏。
       * 线一律按真窗口算（第 553 行的 win = contextWindowOf(turnModel)），
       * 不用 config.contextLimit —— 那是旧 config.mjs 的 128000，跟模型真窗口两码事。
       */
      /**
       * 【2026-11-01 主人揪出的第二处哑火】
       *
       * 原来这里是 `midWarned < MID_TIERS.length`：
       * 70% 那档一响，midWarned 就等于 5，这条件不成立 ——
       * **整个量线检查被整个跳过**，后面压到多少都不再量、不再喊，
       * 一路静默到 100 万当场撑死。改我上面内层逻辑根本白改，进都进不来。
       *
       * 现在判的是「窗口量出来没有」，跟「响过几档」脱钩：
       * 每跑完一个工具都进来量一次，响不响由内层的档位/水位决定。
       */
      if (win > 0) {
        try {
          const midTokens = estimateTokens(messages, sessionId);
          /**
           * 【2026-11-01 修·压缩完必须能重新提醒】
           *
           * 上一版只把「响到第几档」挂到跨轮，压完不归零 ——
           * 那等于「响过一次，以后永不再响」：压到 8 万之后，
           * 哪天再涨回 70 万也一声都不吭。这是把提醒废掉了，不是修好。
           *
           * 所以这里加一道复位：水位比上次响的时候明显低下来了
           * （真压过一轮才会这样），就把档位和水位一起清零，
           * 以后再涨上去照样从 30% 一路提醒下来。
           */
          const _prevAt = warnedRec.at;
          if (_prevAt > 0 && midTokens < _prevAt * MID_WARN_RESET_DROP) {
            warnedRec.tier = 0;
            warnedRec.at = 0;
            midWarned = 0;
            if (process.env.COMPRESS_DEBUG) {
              console.log('[compress] 水位降下来了（' + midTokens + ' 远低于 ' + _prevAt
                + '），量线档位已复位');
            }
          }
          // 从高档往低档找：已经撑到 55% 就直接报 50% 那档，不补报 30%/40%
          for (let ti = MID_TIERS.length - 1; ti >= 0; ti--) {
            const tier = MID_TIERS[ti];
            const lineAt = Math.floor(win * tier.ratio);
            if (midTokens < lineAt) continue;
            /**
             * 【2026-11-01 主人指出的致命漏洞：压缩没压下去，就一路静默到死】
             *
             * 上一版是「每档只响一次」：70% 响过之后，就算上下文一路涨到 100 万
             * 也一声不响，会话当场终态（code:11115 prompt is too long）再也救不回来。
             * 主人原话：「压缩后还是 70% 以上，是不是也不会再响了？然后直到超 100 万上下文？」
             * —— 是的，那一版确实会。已经用 repro-warn-death.mjs 复现过。
             *
             * 现在分两种档：
             *   · 低档（30~60%）：还是每档只响一次，别啰嗦；
             *   · 最高档（70% 极限）：**没压下去就一直喊**，每再涨 5% 窗口喊一次，
             *     直到真的压下来为止。会话快死了的时候，宁可吵，不能哑。
             */
            const isTop = ti === MID_TIERS.length - 1;
            /**
             * 【2026-11-01 补第三处漏洞：跨档不能被水位闸卡住】
             *
             * 复现出来的：32 万时响了 30% 档（水位记 32 万），
             * 后来涨到 43 万 —— 已经过了 40% 的线，可只涨了 11 万 < 12 万，
             * 被水位闸挡掉，40% 那档一声不吭。档位跳过去了就永远补不回来。
             *
             * 所以：**第一次响这一档**（tier < ti+1）不受水位闸限制，到线就响；
             * 水位闸只管「同一档重响」，防止来回刷。
             */
            const firstTimeThisTier = midWarned < ti + 1;
            if (!firstTimeThisTier && !isTop) continue;   // 低档响过了就不重响
            if (!firstTimeThisTier) {
              // 同一档重响（只可能发生在最高档）：要真涨出一截才许再喊
              const gap = Math.floor(win * 0.05);
              /**
               * 【2026-11-01 严检揪出的哑火漏洞】
               *
               * 水位基准 warnedRec.at 是「上次响的时候多大」。压缩如果只把
               * 98 万压到 92 万（没压干净），复位条件（跌到 90% 以下）不成立，
               * at 还停在 98 万 —— 于是要涨到 103 万才允许再响，
               * 可窗口只有 100 万，会话早就死了。这就是「一路静默到死」。
               *
               * 兜底：不管水位基准多高，只要**已经涨过窗口的 95%**，
               * 就必须再响一次。宁可多喊一嗓子，也不许静默到爆。
               */
              const _hardCap = Math.floor(win * 0.95);
              const _overHardCap = midTokens >= _hardCap;
              if (!_overHardCap && warnedRec.at > 0 && midTokens < warnedRec.at + gap) continue;
            }
            midWarned = ti + 1;                          // 记到这一档
            warnedRec.tier = ti + 1;                     // 跨轮记住：这一档响过了
            warnedRec.at = midTokens;                    // 跨轮记住：响的时候多大
            /**
             * 【2026-11-01 严检揪出：提醒自己会变成新的膨胀源】
             *
             * 最高档没压下去时会反复重响，每响一次就往 messages 里 push 一条。
             * 那些是**真消息**，会一直留在历史里 —— 攒上十几条，
             * 「提醒你别撑爆」的这段话自己先把上下文撑大了。荒唐。
             *
             * 所以插新的之前，先把同类旧提醒整条摘掉：历史里永远只保留最新那一条，
             * 既不会丢提示，也不会叠罗汉。别的 _sysNote（比如压缩工作单）不动。
             */
            for (let mi = messages.length - 1; mi >= 0; mi--) {
              const mm = messages[mi];
              if (mm && mm._sysNote === true && typeof mm.content === 'string'
                  && mm.content.indexOf('〔量线') !== -1) {
                messages.splice(mi, 1);
              }
            }
            messages.push({
              role: 'user',
              content: SYS_MID_NOTE + tier.say(midTokens, lineAt, Math.round(tier.ratio * 100)),
              // 量线提醒是程序自己插的，不是主人说的：打上标记，界面只当系统小字画，
              // 不冒充「主人」说话，也不许被当成主人的话存进会话记录。
              _sysNote: true,
            });
            if (process.env.COMPRESS_DEBUG) {
              console.log('[compress] 中途第 ' + (ti + 1) + ' 档（' + Math.round(tier.ratio * 100) + '%）：' + midTokens + ' / ' + lineAt);
            }
            // 【2026-10-31 主人原话：不想看到任何压缩有关的显示】
            // 所以这档只在我自己的上下文里记一笔（上面那条 _sysNote），
            // 不再往屏幕上冒气泡，也不许说「压缩好了」这种话。
            break;                                       // 一次只报一档，别连珠炮
          }
        } catch { /* 量不出来就算了，别打断干活 */ }
      }

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
  // 头部的第二种情况也要排除摘要：摘要虽然带 context:true，但它是可再折叠的旧对话，
  // 当成框架会让 floor 抬高，后面那些该清的重复 system / 悬空 tool_calls 就清不到。
  const headIsFraming = messages[1]?.context && !messages[1]?.summary;
  const floor = messages[0]?.role === 'system' ? (headIsFraming ? 2 : 1) : 0;
  /**
   * 【中段多出来的 system 一律删掉】—— 2026-10-26 修
   *
   * runAgent 每轮开头会重建 system：历史里 messages[1] 不是 context 时，
   * 它会 push 一条**全新的** system 进数组（见上面 refreshSystem 那段）。
   * 那个新对象跟着 wire 被接回历史，于是会话末尾多出一条一模一样的 system，
   * 越跑越多。system 只该有一条、只在最前面。
   */
  for (let i = messages.length - 1; i >= floor; i--) {
    const m = messages[i];
    if (m && m.role === 'system') messages.splice(i, 1);
  }
  dedupeToolCalls(messages, floor);
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

/**
 * 【同一个 tool_call id 只留第一次】—— 2026-10-26 修「插完话她不回」
 *
 * 病根：插话时被掐断的那一轮，它的 assistant(tool_calls) 已经在 wire 里了；
 * 等接续轮拿同一份历史重跑，网关有时会把**那个已经断掉的调用原样再吐一遍**
 * （实测同一个 id 在一份会话里出现 32 次）。以前没人管中段，于是历史越跑越脏：
 *
 *   assistant(call_X) → tool(call_X) → assistant(call_X) → assistant(call_X) → user …
 *
 * 这种形状上游按 OpenAI 协议判非法，直接回 502 —— 主人看到的就是「插了话，她不理我」。
 *
 * 规矩很简单：**第一次出现的那个 id 算正主，后面重复的一律丢掉**。
 *   · 重复的 assistant(tool_calls) → 整条删；它要是还带着人话，就把人话
 *     改成一条普通 assistant 留着（别把她说过的话也一起删了）；
 *   · 重复的 tool 结果 → 删（第一组的才有效）。
 * 只动重复的，正常的对话一条都不碰。
 */
function dedupeToolCalls(messages, floor = 0) {
  if (!Array.isArray(messages) || messages.length <= floor) return messages;

  /**
   * 【两趟走，别在循环里搜数组】
   *
   * 第一版写成「边扫边 messages.some(...) 查正主是不是被删了」，
   * 单条历史几千条时那是 O(n²)，插话这一下能把主线程卡住好几秒 ——
   * 主人看到的是「打完字界面僵住」。所以分两趟：
   *   第一趟只记账（谁先认领了哪个 id、哪些要删）；
   *   第二趟一次性 splice 掉。
   */
  const ownerIndex = new Map();   // tool_call id → 第一次认领它的消息下标
  const drop = new Set();         // 要整条丢掉的 assistant 下标
  const replacedOk = new Set();   // 被「只剩人话」替代掉的那些下标

  // —— 第一趟：认领 id，标记重复 ——
  for (let i = floor; i < messages.length; i++) {
    const m = messages[i];
    if (!m || typeof m !== 'object') continue;
    if (m.role !== 'assistant' || !Array.isArray(m.tool_calls) || !m.tool_calls.length) continue;
    const fresh = [];
    let duplicated = false;
    for (const tc of m.tool_calls) {
      const id = tc && tc.id ? String(tc.id) : '';
      if (!id) { fresh.push(tc); continue; }        // 没 id 的没法判，留着
      if (ownerIndex.has(id)) { duplicated = true; continue; }   // 见过 → 不再重复执行
      ownerIndex.set(id, i);
      fresh.push(tc);
    }
    if (!duplicated) continue;
    if (fresh.length) {
      messages[i] = { ...m, tool_calls: fresh };
      replacedOk.add(i);
    } else {
      // 整条都是重播的：她要是还说了人话，就把人话留下，别一起删
      const said = typeof m.content === 'string' ? m.content.trim() : '';
      if (said) {
        const plain = { role: 'assistant', content: m.content };
        if (m._at) plain._at = m._at;
        messages[i] = plain;
        replacedOk.add(i);
      } else {
        // 一句话都没有的空壳 —— 落盘只会让历史更脏（实测一条会话里 928 条这种），删
        drop.add(i);
      }
    }
  }

  // —— 第二趟：处理 tool 结果 ——
  const firstToolAt = new Map();   // id → 第一条 tool 结果的下标
  /**
   * 每个 tool 结果「合法认领者」的下标集合：同一个 id 的**第一条** tool 消息的下标。
   * 一条 tool 合不合法，判据只有一个 —— 从它往上追、**跳过其它 tool**之后，
   * 撞见的那个非 tool 消息是不是一条带着这个 id 的 assistant(tool_calls)。
   *
   * 【为什么不能只看 ownerIndex —— 2026-10-30 修 · 干活鱼2 的 LLM HTTP 400】
   *
   * repairHistory 收拾尾巴时是这么写的：尾部 assistant 带着 tool_calls、
   * 后面一条 tool 结果都没有 → `messages.pop()` 把它砍掉。
   * 可那个形状在「assistant(tool_calls) + tool 结果 + 用户的下一句话」里也成立吗？
   * 不成立 —— 用户的话就顶在 tool 后面。真正发生过的是这种情况：
   *
   *   assistant(call_X) → tool(call_X) → （标成「这条不要了」）→ 尾巴 pop 掉的是谁？
   *   pop 只会摘最后一个元素，于是**它摘掉的是别的东西，留下了 assistant 的空壳** …
   *   反过来也真踩过：有一条 assistant(call_X) 被动过（tool_calls 被清空成 []），
   *   而它下面那条 tool(call_X) 还在，ownerIndex 里那个 id 依旧认着它的位置。
   *
   * 于是 wire 上出现 `assistant(无 tool_calls) → tool(call_X) → user`，
   * 上游一句话就怼回来：「Messages with role 'tool' must be a response to a
   * preceding message with 'tool_calls'」—— 从此这个会话每一轮都 400，
   * 主人说多少句「继续」都没有回音（干活鱼2 就是这么卡死的）。
   *
   * 所以这里不再信 ownerIndex 的位置账，改成**在数组上现追现验**：
   *   · 往上追、跳过连续的 tool，找到那个「非 tool」的老大；
   *   · 它必须是 assistant，且 tool_calls 里真有这个 id；
   *   · 它是这一组里第一个 tool 结果（重复的照样丢）。
   * 三条缺一条就把这条 tool 结果丢掉 —— 留一条没人认领的 tool 结果，
   * 换来的就是整轮请求被拒，不如丢。
   */
  const okTool = new Set();
  for (let i = floor; i < messages.length; i++) {
    const m = messages[i];
    if (!m || m.role !== 'tool' || !m.tool_call_id) continue;
    const id = String(m.tool_call_id);
    // 一条 id 只认第一个结果，后面的都是重播
    if (firstToolAt.has(id)) { drop.add(i); continue; }
    // 往上追：跳过连续的 tool，看撞见的是谁
    let k = i - 1;
    while (k >= floor && messages[k] && messages[k].role === 'tool') k--;
    const owner = k >= floor ? messages[k] : null;
    const owned = Boolean(owner)
      && owner.role === 'assistant'
      && Array.isArray(owner.tool_calls)
      && owner.tool_calls.some((tc) => tc && String(tc.id) === id)
      && !drop.has(k);
    if (!owned) { drop.add(i); continue; }
    firstToolAt.set(id, i);
    okTool.add(id);
  }
  /**
   * 反过来也要清：assistant 带着 tool_calls，可它的 tool 结果被上面丢光了
   * （或者从来没有过）—— 那这一组的 assistant 就是悬空的，同样会被拒。
   * 只砍挂在末尾/紧挨着下一个非 tool 的那种，别动中段还能自洽的组。
   */
  for (let i = floor; i < messages.length; i++) {
    const m = messages[i];
    if (!m || m.role !== 'assistant' || !Array.isArray(m.tool_calls) || !m.tool_calls.length) continue;
    if (drop.has(i)) continue;
    const orphan = m.tool_calls.some((tc) => tc && tc.id && !okTool.has(String(tc.id)));
    if (!orphan) continue;
    // 后面直接跟着的不是这个 id 的 tool → 这组没结果，悬空
    const next = messages[i + 1];
    /**
     * 【2026-10-30 修：悬空的 tool_call 认错人】
     *
     * 主人报：干活时刷新屏幕，界面停在半截（工具显示"完成"、话断成两截），
     * 之后越刷越坏，得反复刷新才恢复。
     *
     * 查到根：刷新的那一刻，历史正好存成「assistant 带 tool_calls，可它的结果还没写进去」，
     * 而后面紧跟着的 tool 其实认的是【另一颗】call。
     * 老的判法只看「下一条是不是 tool」，是就当成"有结果"放过去了 ——
     * 那颗没人认领的 call 留在历史里，上游直接 400：
     *   Messages with role 'tool' must be a response to a preceding message with 'tool_calls'
     * 这一轮就废了，界面停在半截；刷新后接续又读到同一份坏历史，继续 400，越刷越坏。
     *
     * 现在改成：挨个看紧跟其后的那串 tool，得有一条的 tool_call_id 真正认领我这颗 call 才算数。
     */
    let hasFollowing = false;
    for (let j = i + 1; j < messages.length; j++) {
      const t = messages[j];
      if (!t || t.role !== 'tool') break;          // 出了 tool 串，后面都跟这一组无关
      if (drop.has(j)) continue;
      const owned = String(t.tool_call_id || '');
      if (owned && okTool.has(owned)) { hasFollowing = true; break; }
    }
    if (hasFollowing) continue;   // 还有结果在，交给下一轮判断，不在这儿拆
    const said = typeof m.content === 'string' ? m.content.trim() : '';
    if (said) {
      messages[i] = { role: 'assistant', content: m.content, ...(m._at ? { _at: m._at } : {}) };
    } else {
      drop.add(i);
    }
  }

  if (!drop.size) return messages;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (drop.has(i)) messages.splice(i, 1);
  }
  return messages;
}

function sumUsage(acc, u) {
  const next = acc ?? { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  /**
   * 【2026-11-02：把缓存字段也累加进来】
   *
   * 以前这里只累加三个数，`prompt_cache_hit_tokens` 全被丢掉。
   * 后果不是少个字段那么轻 —— 它一路传到算钱那一步，就成了「接口没报缓存」，
   * 于是全部按主人指定的 98% 命中率去估。
   * 可 DeepSeek 明明每条 usage 都在报真数，白瞎了，报的钱也就不准。
   *
   * 两家字段名不一样，都认：
   *   DeepSeek: prompt_cache_hit_tokens / prompt_cache_miss_tokens
   *   OpenAI : prompt_tokens_details.cached_tokens
   */
  const det = u.prompt_tokens_details && typeof u.prompt_tokens_details === 'object' ? u.prompt_tokens_details : {};
  const hit = Number(u.prompt_cache_hit_tokens ?? det.cached_tokens ?? 0);
  const miss = Number(u.prompt_cache_miss_tokens ?? 0);
  return {
    prompt_tokens: next.prompt_tokens + (u.prompt_tokens ?? 0),
    completion_tokens: next.completion_tokens + (u.completion_tokens ?? 0),
    total_tokens: next.total_tokens + (u.total_tokens ?? 0),
    // 只要有一圈报了缓存就记着（没报的那些圈当 0，不影响别的圈的贡献）
    prompt_cache_hit_tokens: Number(next.prompt_cache_hit_tokens ?? 0) + hit,
    prompt_cache_miss_tokens: Number(next.prompt_cache_miss_tokens ?? 0) + miss,
  };
}
