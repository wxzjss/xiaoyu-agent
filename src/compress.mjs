// Context compression: when the history gets too long, fold the old turns into one summary
// message and keep the recent tail verbatim. Nothing is deleted from disk — only the prompt
// gets shorter. The summary is itself merged into later summaries, so it rolls forward.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chat } from './llm.mjs';
import { config } from './config.mjs';
import { effectiveContextLimit } from './settings.mjs';
// 【2026-10-28 改】专业/快速模式不再有单独的压缩规则：到水位才压、压就写摘要、
// 尾巴按 limit 的比例留 —— 跟人设模式一模一样（主人原话「改为正常的压缩规则」）。
// 下面还有两处残留会问 pureModeOn()（哪几档走得通、条数太少不压），
// 那两条是「门槛」不是「规则」，留着。
import { pureModeOn } from './pure.mjs';
// 自动档的「拿不准」地带交给小鲸判断（带冷却，不每轮花钱）
import { autoRatioVerdict, contextWindowOf } from './rates.mjs';
import { askWhaleCompress } from './whale-judge.mjs';

/** 摘要消息的标记（只在本地用，不进 API 请求体）。 */
const SUMMARY_FLAG = 'summary';

const SUMMARY_BLOCK_TAG = /^\s*(主人要什么|已经做完|已完成|还没做完|未做完|待办|关键约束|结论|约束|现状|进度|背景|目标|备注)\s*[:：]/;
const SUMMARY_FACT_LINE = /\d|[\\/][\w.-]+|`[\w.]+`|[\w-]+\.(mjs|js|json|md|html|ts|py|exe|ps1|txt)\b/;
const SUMMARY_ADVISOR = /(建议|要不要我|如果这是|如果你需要|请提供|需要你确认|需要确认|这看起来像|这串消息|你这段对话|我无法|我不能|有个明显问题|不一致|不是一回事|套模板|空转|困在|回放|测试桩|到底|我检查了|我发现|总结来说|下一步方案|只输出|四行标签|不许有|不合格|纠正|现在开始输出)/;

/**
 * 【2026-10-28：这个常量已经不用了，留着只为一行注释有处可指】
 *
 * 原来是「专业模式压完留两万」，现在专业/快速模式跟人设模式同一套预算
 * （见 resolveKeepTokens），两万这个数不再参与任何计算。
 */
const PURE_KEEP_TOKENS = 20000;

/** 每条消息的固定结构开销（role / 分隔符等），保守取 4。 */
const PER_MESSAGE_OVERHEAD = 4;

/**
 * 专业模式：把历史里「人设腔」的痕迹洗掉。
 *
 * 为什么必须洗：主人经常聊到一半才点开专业模式，这时候历史里的助手回复
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
 * 专业模式：把发给模型的历史副本洗一遍。
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
/**
 * 【估算系数：拿真实用量自己校】
 *
 * 实测过的事：这个端点报回来的 prompt_tokens，跟「字符数 ÷ 1.5」差得不少。
 * 同一份历史，估 47,439、真 76,603，差 1.61 倍；再往前更狠。
 *
 * 估少了会怎样：明明该压了，判断说「还没到」，于是接着往上下文里堆，
 * 堆到网关那边直接打回来 —— 主人看到的就是「怎么突然不回了」。
 *
 * 所以这里记一个系数：每拿到一次真实 usage，就用「真 ÷ 估」把系数往真值挪一点
 * （挪一半，别一下跳满 —— 单次用量可能含缓存、复算，不一定干净）。
 * 夹在 1~8 之间：小于 1 说明估高了，那也是毛病；大于 8 基本是数据脏了。
 */
let calibRatio = 1.6;   // 起点就用实测那个 1.61，别从 1 慢慢爬

/** 真实用量回来了：校准一下估算系数 */
export function noteRealTokens(realTokens, estimatedTokens) {
  const real = Number(realTokens);
  const est = Number(estimatedTokens);
  if (!Number.isFinite(real) || !Number.isFinite(est) || real <= 0 || est <= 0) return;
  const ratio = Math.min(8, Math.max(1, real / est));
  calibRatio = calibRatio * 0.5 + ratio * 0.5;
}

/** 现在用的系数是多少（测试/排查用） */
export function currentCalibration() {
  return calibRatio;
}

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
      total += Math.ceil(p.length / 1.5 * calibRatio);
    }
  }
  return total;
}

/**
 * 头部两条（system + context）永远不动。
 *
 * 【必须排除摘要】摘要也带 context:true，和上下文副本长得一样。历史里没有那条
 * 上下文的会话（老会话、回退之后、专业模式清过），摘要会落到 messages[1]，
 * 这里就会把它当头部保住 —— 结果每压一次就多出一份摘要层层堆着，越压越大，
 * 跟文件头承诺的「摘要会滚进后续摘要」正好相反。摘要可以被再折叠，不算头部。
 */
function headLength(messages) {
  let n = messages[0]?.role === 'system' ? 1 : 0;
  if (messages[n]?.context && !messages[n]?.summary) n += 1;
  return n;
}

/**
 * 从尾部往前攒够 keepTokens，得到候选切点，再往前挪到安全位置。
 * 安全 = 不把 assistant(tool_calls) 和它的 tool 结果拆开。
 */
/**
 * 把被截断的原文写到 .state/oversize/ 下，返回路径（存不了就返回空串）。
 * 为什么不直接删：主人亲手打的那句话可能几万字，丢了就真找不回来了。
 */
function saveOversize(sessionId, index, text) {
  const dir = join(config.dataDir, ".state", "oversize");
  mkdirSync(dir, { recursive: true });
  const sid = String(sessionId || "unknown").replace(/[^\w-]/g, "_");
  const file = join(dir, sid + "-" + index + "-" + Date.now() + ".txt");
  writeFileSync(file, text, "utf8");
  return file;
}

function findCut(messages, start, keepTokens) {
  // 至少留最后一个来回：keepTokens 再小也不能把尾巴删空。
  // 以前专业模式把预算夹到 0 的时候，这里返回 start，整段历史全没了 ——
  // 模型拿到的是一个空上下文，等于当场失忆，活干不下去。
  //
  // 【2026-10-27 补：可压缩的消息本来就不到 4 条时，别再硬留 4 条】
  // 真踩过：历史是「system + context + 一条 68 万字符的巨型 user 消息 + 两句短的」，
  // 可压缩的只有 3 条，min(4, 3) = 3 → 循环刚开始 taken 是 0，小于 3，
  // 于是一路把三条全吃进 keep，最后切点落到头部 → 返回 -1 → 上层报
  // nothing-safe-to-drop，那条巨型消息原样留着，下一次照样撞窗，永远压不动。
  // 切点只需守两条规矩：至少留 floor 条、且不拆工具对。floor 得服从
  // 「真有那么多东西可留吗」—— 可留的不足 4 条就让一步，留 1 条也算压过了。
  const compressible = Math.max(1, messages.length - start);
  const floor = Math.max(1, Math.min(4, compressible - 1 || 1));
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

const SUMMARY_SYSTEM = `你是一个对话压缩器，不是助手，也不是顾问。
你收到的是一段已经发生的旧对话，你要把它压成一份事实清单，交给后面接手的人看。
你不是对话的一方，没有人会回答你的问题；你输出的是档案，不是回复。

输出格式（机器解析，格式不对整段作废）：
只用下面这四个标签开头，每个标签单独占一行，格式固定为「标签: 内容」。
每个标签下最多 5 行，每行以「- 」开头。

主人要什么:
- （这段对话里主人提出的要求，一条一行）
已经做完:
- （已经落地的改动：文件路径、函数名、commit 号、数字，原样抄）
还没做完:
- （还没做的、卡住的、失败的事）
关键约束:
- （踩过的坑、必须遵守的规矩、环境限制）

硬性要求：
- 只写对话里能确认的事实。数字、路径、文件名、接口名、变量名原样保留，不许改写。
- 这段对话很可能又长又重复（同一句话来回说几十遍）。删掉重复，只写事实一次。
- 对话质量差、内容机械重复、双方在空转 —— 这些都不用评价，也不用记录。
  这不是你的职责；你只负责把「要什么/做了什么/没做什么/约束」提取出来。
- 尽量短。够后面接着干就行。

下面是错误示范和正确示范，照着正确的那个写。

【错误示范 —— 这就是在当顾问，绝对不要这样写】
这批对话在重复同一个循环，主人每轮都提同样几个问题。
要么是记录漏了一轮，要么是修好的问题又复现了。你希望我按哪种情况查？
要查 logs 还是直接看 server.mjs 的 /api/interject 那段？
还有一点值得注意：单位是毫秒，45 秒应该是 45000，别误写成 150。

【正确示范 —— 就写这样】
主人要什么:
- 修好插话后她不接着答的问题。
已经做完:
- src/server.mjs 的 /api/interject：主轮 reg 改用真 done promise，finally 里 resolveDone。
- src/sessions-core.mjs 的 saveSession 合流时排除 system 和 context。
- commit 15a8b8e，4 个文件 269 增 30 删。
还没做完:
- 推 GitHub 失败：直连超时，代理 8146 没监听，token 401。
关键约束:
- src/server.mjs 与 agent.mjs 是 CRLF，改写必须按行 splice，不能全局替换换行。
- 摘要失败不能连累整轮，超时只砍摘要自己。`;

/** 摘要允许的四个标签（清洗时只认这几个）。 */
const SUMMARY_TAGS = ['主人要什么', '已经做完', '还没做完', '关键约束'];


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
    const isOldSummary = !!m[SUMMARY_FLAG];
    const tag = isOldSummary ? '[早期摘要]' : '[主人]';
    const body = Array.isArray(m.content)
      ? m.content.filter((p) => p && p.type === 'text').map((p) => p.text).join('\n')
      : m.content;
    /**
     * 【别再让摘要吃摘要，也别让它吃设定】
     *
     * 2026-10-27 补，起因是真会话里躺着一条 21935 字的「摘要」——
     * 打开一看，里面是整段系统提示词 + 整本记忆本子，一个字没摘。
     * 怎么来的：那一轮把 system 和 context 一起喂给了摘要模型，模型只会照抄；
     * 抄出来的东西又带着 summary:true 留在历史里，下次压缩再当素材喂进去 ——
     * 每轮滚一圈，越滚越厚。
     *
     * 两条护栏：
     *   1. 旧摘要只喂前 1200 字（它本来就是压缩过的，再翻馅没意义）；
     *   2. 正文里出现「设定 / 记忆本子」的标志行就切掉 ——
     *      那不是对话内容，是被误当素材抄进来的。
     */
    let one = String(body ?? '');
    for (const mark of ['\n下面是本次对话的设定与规则', '\n【这个会话的记忆本子】', '\n# 会话记忆']) {
      const at = one.indexOf(mark);
      if (at > 0) one = one.slice(0, at);
    }
    if (isOldSummary) {
      // 3. 开头就是系统提示词 / 设定块 —— 说明这条摘要是把设定照抄进来的，整条作废
      const head = one.slice(0, 200);
      if (/下面是本次对话的设定与规则/.test(head) || /【PERSONA_LOAD】/.test(head) || /【你在哪儿】/.test(head)) {
        continue;
      }
    }
    const capChars = isOldSummary ? 1200 : 4000;
    lines.push(`${tag} ${one.slice(0, capChars)}`);
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
  let before = estimateTokens(messages);
  const beforeOrigin = before;
  if (!Number.isFinite(cap) || cap <= 0) {
    return { compressed: false, before, after: before, reason: 'disabled' };
  }
  /**
   * 触发线。
   *
   * 人设模式：涨到水位才动手（不额外花钱）。
   * 【2026-10-28 改：专业/快速模式不再「每轮都压、压完不留摘要」】
   * 主人原话：「还有专业模式与快速模式的压缩规则改为正常的压缩规则」。
   *
   * 原来这两档是特殊待遇：不看水位每轮都压、压的时候不做摘要直接把旧对话丢掉、
   * 只留两万 token 的尾巴。当时的理由写得很足（专业模式就是不想被往事牵着走）。
   * 但代价是两个说不出口的毛病：
   *   · 每轮压一次 = 每轮白花一次摘要/裁剪，长任务里光压就压掉几十块；
   *   · 旧对话直接丢 = 丢的东西找不回来，主人回头翻记录一片空白。
   * 现在跟人设模式走同一套：到水位才压、压就写摘要、按 limit 的比例留尾巴。
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
  /**
   * 压完之后「历史大概落到多少 token」——和 trigger 分开记。
   * trigger 回答的是「要不要压」，targetAfter 回答的是「压完留多大」。
   * 小鲸在临界带说「压」会把 trigger 设成 0（只表示允许动手），
   * 一旦拿它当落地目标，落盘前那个循环就永远不满足，一路丢到只剩 4 条。
   */
  let targetAfter = 0;
  if (pureNow) {
    /**
     * 【2026-10-28 改：跟人设模式同一个触发线】
     *
     * 原来这里是 `trigger = PURE_KEEP_TOKENS / 2`（两万就压），
     * 后来改成了「每轮都压」。两种写法的共同点是：都跟主人填的上下文上限无关，
     * 都跟「历史到底涨到多高了」无关 —— 那就不叫压缩策略，叫定时清空。
     *
     * 现在按主人填的那个 limit 走：显式填了数字就「到多少压多少」，
     * 没填（自动档）就走下面自动档那条比例判断。
     */
    trigger = Math.floor(cap);
    judgeLine = trigger;
  } else if (Math.abs(cap - Math.floor(contextWindowOf(model) * 0.7)) <= 1) {
    // 自动档：按比例判断
    const autoVerdict = autoRatioVerdict(model, before);
    trigger = Math.floor(autoVerdict.window * 0.3); // 低于舒适线就一定不压
    judgeLine = trigger; // 判定基准：舒适线（不受下面 trigger=0 影响）
    // 压完想落到多大：按窗口的 15%。小鲸说「压」只代表允许动手，
    // 不代表要压到只剩零头 —— 这一点必须和下面的 trigger 分开记（见 targetAfter）。
    targetAfter = Math.floor(autoVerdict.window * 0.15);
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
  // 专业模式：历史条数太少也不压（压完只剩摘要，等于开局失忆）
  const PURE_MIN_MSGS = 8;
  if (pureNow && messages.length <= PURE_MIN_MSGS) {
    return {
      compressed: false, before, after: before, limit: cap, trigger,
      reason: 'too-few-messages(' + messages.length + ')',
    };
  }  if (before <= trigger) {
    if (process.env.COMPRESS_DEBUG) {
      console.log('[compress] 不到线：before=' + before + ' trigger=' + trigger + ' cap=' + cap + ' 条数=' + messages.length);
    }
    return { compressed: false, before, after: before, limit: cap, trigger, reason: 'under-trigger' };
  }

  const start = headLength(messages);
  // 头部（system + context）本身就要占掉一块，剩下的才是能给「摘要 + 尾巴」的预算
  const headTokens = estimateTokens(messages.slice(0, start));

  /**
   * 【头部自己就装不下：别再假装能压】
   *
   * 2026-10-27 补。真踩过：那条携带旧记忆的摘要涨到 21935 字，光「system + 它」
   * 就吃 7800 token；主人把上下文上限填成 8000，于是不管怎么压尾巴，
   * 总量永远在 11000 上下 —— 压了个寂寞，还每轮白花一次摘要请求的钱。
   *
   * 这时唯一对的做法是把话说清楚：**上限太小了，压不动**。
   * 用 reason='head-too-big' 交回去，让上层提示主人把上限调大，
   * 而不是在后台无声无息地空转。
   */
  if (Number.isFinite(cap) && cap > 0 && headTokens >= cap) {
    if (process.env.COMPRESS_DEBUG) {
      console.log('[compress] 头部就超窗口：headTokens=' + headTokens + ' cap=' + cap + '（system ' + (start > 0 ? '在' : '不在') + '）');
    }
    return { compressed: false, before, after: before, limit: cap, trigger, reason: 'head-too-big', headTokens };
  }

  /**
   * 摘要那条消息大约占多少 token —— 先按保守值预留，算完再按真实长度校准。
   */
  const SUMMARY_RESERVE = 600;
  /**
   * 尾巴预算的独立下限（token）。
   *
   * 尾巴不该因为主人把阈值填小就被砍光 —— 填小是「早点动手压」，
   * 不是「连最近的对话也别留」。历史上真的出现过 713 条压到 13 条。
   * 只有 cap 自己比这条线还窄时才让步（见下面 keepTarget 的算）。
   */
  const CONTEXT_KEEP_FLOOR = 6000;
  /** 压完至少留这么多条消息（不够就在日志里报出来，别再静默） */
  const MIN_KEEP_MSGS = 8;
  /**
   * 但头部吃掉窗口九成以上时，「保持 8 条」就是压不下去的唯一原因 ——
   * 那种情况下留 1 条尾巴，把总量压到线下，比留 8 条超线更好。
   */
  const hardTail = Number.isFinite(cap) && cap > 0 && headTokens > cap * 0.9;
  const budget = Math.max(1, Math.min(cap, Number.isFinite(cap) ? cap : 0) - headTokens);
  /**
   * 尾巴预算：专业/快速模式**不再另算**，跟人设模式同一套（2026-10-28）。
   *
   * 原来这两档写死两万：历史全丢，只留最近几轮当接力棒。
   * 主人要求「改成正常的压缩规则」之后，这里跟着走 resolveKeepTokens ——
   * 主人填 64000 就留一大段，填 8000 才留一点点，跟人设模式一模一样。
   */
  void PURE_KEEP_TOKENS;

  /**
   * 人设模式下的尾巴预算，按顺序让步：
   *   1. 主人显式填的 keepTokens 说了算；
   *   2. 否则按 limit 的比例算（老逻辑）；
   *   3. 但**不低于 CONTEXT_KEEP_FLOOR**，除非 cap 自己都装不下；
   *   4. 最后才受 budget 约束 —— 且不允许被夹到 0 以下（以前就是被夹成 1，
   *      findCut 只够留 floor 那 4 条，713 条压成 13 条）。
   *
   * 「budget - SUMMARY_RESERVE」这层额外惩罚去掉了：摘要真占多少，
   * 后面那个 while 循环会按 estimateTokens 实际裁，不需要在这儿先扣一遍。
   */
  const wantKeep = resolveKeepTokens({ keepTokens, limit: cap });
  // cap 自己比下限还窄时，以 cap 的 40% 为限（总得给摘要和头部留点位置）
  const floorKeep = Math.min(CONTEXT_KEEP_FLOOR, Math.max(1, Math.floor(cap * 0.4)));
  const wantWithFloor = Math.max(wantKeep, floorKeep);
  const keepTarget = clampKeep(wantWithFloor, Math.max(1, budget));


  // 注意是 let：下面那段「尾巴不能只剩 4 条」的兜底会把它往前挪（窄窗口必走这条路）
  /**
   * 【单条消息本身就把窗口撑爆：先把它截断，别硬扛】
   *
   * 2026-10-27 补。真踩过：一条 68 万字符的 user 消息（约 72 万 token），
   * 比窗口本身还大。findCut 从尾巴往前攒，攒到它的时候已经无可再让，
   * 切点只能用回头部 → 返回 -1 → 上层报 nothing-safe-to-drop，
   * 于是这条消息原样留着，下一轮照样撞窗，而且永远压不动 —— 死循环。
   *
   * 光靠丢旧对话救不了：要救的是这条消息自身。
   * 做法：把超预算的那条截到预算的 85%，末尾留一句「已截断」的说明；
   * 原文不删，另存到 .state/oversize/ 下（主人给的东西不能凭空消失）。
   */
  {
    const windowTok = Number.isFinite(cap) && cap > 0 ? cap : budget + headTokens;
    const hardCap = Math.max(2000, Math.floor(windowTok * 0.85));
    for (let i = 0; i < messages.length; i++) {
      const m = messages[i];
      if (!m || typeof m.content !== "string") continue;
      const self = estimateTokens([m]);
      if (self <= hardCap) continue;
      const keepChars = Math.max(500, Math.floor(m.content.length * (hardCap / self)));
      let savedPath = "";
      try { savedPath = saveOversize(sessionId, i, m.content); } catch {}
      const omitted = m.content.length - keepChars;
      const mark = "……【这段太长，超出上下文窗口，后面 " + omitted + " 字已省略"
        + (savedPath ? "，原文存到 " + savedPath : "") + "】";
      m.content = m.content.slice(0, keepChars) + mark;
      console.warn("[compress] 第 " + i + " 条消息自身体积就超窗口（" + self + " token > " + hardCap
        + "），已截断到 " + keepChars + " 字符" + (savedPath ? "，原文存 " + savedPath : ""));
    }
  }

  // 截断之后再算切点：上一步可能已经把某条巨型消息压到窗口以内
  //
  // 【回填 before】截断改了 messages 的内容，before 还是原来的数。
  // 不重算的话，后面 log 和返回值全是假的 —— 实测就出现过
  // before=729631 而实际已经降到 599425，看着像「压了个寂寞」。
  const beforeAfterTrim = estimateTokens(messages);
  if (beforeAfterTrim < before) {
    if (process.env.COMPRESS_DEBUG) {
      console.log("[compress] 截断单条巨型消息：before " + before + " → " + beforeAfterTrim);
    }
    before = beforeAfterTrim;
  }
  // 截断已经压到线内了，就不用再丢旧对话 —— 那会把近况也削掉
  if (before <= trigger) {
    if (process.env.COMPRESS_DEBUG) {
      console.log("[compress] 截断后已在线内：before=" + before + " trigger=" + trigger);
    }
    return { compressed: true, before, after: before, limit: cap, trigger, reason: "trimmed-oversize", kept: messages.length };
  }
  let cut = findCut(messages, start, keepTarget);
  if (cut <= start) {
    // 兜底：实在没得切，返回 trimmed 的结果而不是谎报 nothing-safe-to-drop
    if (beforeAfterTrim < beforeOrigin) {
      return { compressed: true, before: beforeAfterTrim, after: before, limit: cap, trigger, reason: "trimmed-oversize", kept: messages.length };
    }
    return { compressed: false, before, after: before, limit: cap, trigger, reason: "nothing-safe-to-drop" };
  }

  /**
   * 兜底：cap 被填得比头部还小时（headTokens 常 9k~21k，主人却填 8000），
   * 上面的预算会算成 1，findCut 只留 floor 那 4 条。4 条尾巴 = 当场失忆。
   *
   * 这里硬性把切点往前挪到够 MIN_KEEP_MSGS 条。代价是 after 可能略超 cap ——
   * 有意识的取舍：超一点只是多花钱，削到 4 条是活干不下去。
   * 挪的时候仍然不拆 assistant(tool_calls) 与它的 tool 结果。
   */
  {
    let keepCount = messages.length - cut;
    let probe = cut;
    // 【2026-10-27 补】wantTail 也得服从「真有那么多条可留吗」。
    // 以前这里写死 MIN_KEEP_MSGS（8）：历史里只挂着 3 条可压缩消息时，
    // probe 一路退到 start 就 break，切点又落回头部 → 上层拿到 -1 →
    // 报 nothing-safe-to-drop → 那条巨型消息原样留着，永远压不动。
    // 现在最多退到「除了留 1 条什么都别留」为止。
    const tailCap = Math.max(1, messages.length - start);
    const wantTail = hardTail ? 1 : Math.min(MIN_KEEP_MSGS, Math.max(1, tailCap - 1 || 1));
    while (keepCount < wantTail && probe > start) {
      let back = probe - 1;
      // 不拆工具对：往前挪时如果 probe 是 tool 或前一条是带 tool_calls 的 assistant，就继续往前
      while (back > start) {
        const at = messages[back];
        const prev = messages[back - 1];
        const splitsTool = at?.role === 'tool' || (prev?.role === 'assistant' && prev?.tool_calls?.length);
        if (!splitsTool) break;
        back--;
      }
      if (back <= start) break;
      probe = back;
      keepCount = messages.length - probe;
    }
    if (probe < cut) cut = probe;
  }

  const old = messages.slice(start, cut);
  const tail = messages.slice(cut);

  let summaryText = '';
  let error;
  /**
   * 【2026-10-28 改：专业/快速模式也做摘要了】
   *
   * 原来这里写着「专业模式不做摘要，直接把旧对话丢掉」，理由是
   * 「主人开专业模式就是不想被往事牵着走」。
   *
   * 主人现在要求换成正常压缩规则，这条理由就站不住了：
   * 丢掉的原文找不回来，主人回头翻记录一片空白 —— 摘要只要两三千 token，
   * 换来的是「这一段干过什么」还留着，比省那点钱划算。
   *
   * 注意下面 `pure` 这个变量还留着：它现在只表示「这一轮是专业/快速模式」，
   * 不再决定「压不压摘要」。历史里那几条注释写的是旧口径，改的时候已经同步过。
   */
  const pure = pureNow;
  void pure;
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
        // 摘要必须跟当前会话用同一个模型 / 同一套端点：会话切了模型，
        // 摘要却还拿全局默认去算，压出来的东西对不上那个模型的窗口和风格。
        model,
        sessionId,
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

  {
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
    /**
     * 第三次（重试）：模型没守格式，跑题当顾问了。
     *
     * 实测：喂一段机械重复的对话进去，模型经常不写标签，而是回一段
     * 「这批对话在重复同一个循环…你希望我按哪种情况查？」这种点评。
     * 那种东西进了历史就是毒 —— 后面接手的模型会以为自己是个顾问。
     *
     * 所以先验格式：至少要有两个标签。不合格就把「上次你跑题了，
     * 只输出四个标签」再要一遍；还不行就干脆不压（见下面 summaryText 为空的分支）。
     */
    const looksStructured = (t) => {
      const ls = String(t || '').split('\n');
      return ls.filter((l) => SUMMARY_BLOCK_TAG.test(l.trim())).length >= 2;
    };
    /**
     * 最多再要两次。每次把「上一次错在哪」写得比上次更硬
     * —— 实测这种模型只加一句「请用标签」是不听的，得点名它错在哪。
     */
    const RETRY_HINTS = [
      '【纠正】你上一次的输出不合格：没有使用那四个标签，而是评价了这段对话、还问了对方要怎么做。'
      + '现在只输出：主人要什么: / 已经做完: / 还没做完: / 关键约束: 这四行标签，'
      + '每个标签下面用 "- " 列事实。不许有第五行标签，不许有任何解释、评论、提问、结尾语。',
      '【最后一次】再重复一遍：输出必须形如\n'
      + '主人要什么:\n- ...\n已经做完:\n- ...\n还没做完:\n- ...\n关键约束:\n- ...\n'
      + '只要这四段。不要写"你贴的这段""我先确认""下一步你要哪个"。现在开始输出。',
    ];
    for (const hint of RETRY_HINTS) {
      if (!summaryText || looksStructured(summaryText) || signal?.aborted) break;
      try {
        const retry = await runSummary(renderForSummary(old) + '\n\n' + hint, SUMMARY_TIMEOUT_MS);
        if (looksStructured(retry)) { summaryText = retry; error = undefined; }
        else { summaryText = summaryText || retry; }
      } catch (err3) {
        error = String(err3?.message ?? err3);
        break;
      }
    }
  }

  /**
   * 【摘要两次都没成 → 这一轮不压，原文一条不动】
   *
   * 以前这里是写一句「原文已折叠」然后照压 —— 等于把早期几千条对话
   * 直接扔进碎纸机，只留一句「摘要没生成出来」。
   * 实测丢过 798 条、864 条原文，主人回头翻记录一片空白，还以为是自己记错。
   *
   * 摘要做不出来，就不该动画事。宁可这次不压、上下文暂时大一点，
   * 也不能把他的话扔掉 —— 扔掉的东西是找不回来的。
   * 下一轮如果摘要能出来，自然会再压。
   */
  if (!pure && !summaryText) {
    return {
      compressed: false,
      before,
      after: before,
      limit: cap,
      reason: 'summary-failed-keep-original',
      error: error || '摘要没生成出来',
    };
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
   *   3. 专业模式会把 context 全滤掉（server.mjs L2762），专业模式本来就不该有摘要
   */
/**
 * 摘要后处理：把模型没听进去的那几条洗掉。
 *
 * 提示词里已经写明「纯文本、不要建议、不要评论对话质量、不要提问」，但实测喂进来
 * 一段机械重复的对话时，模型照样回「我建议你…」「这看起来像无意义的重复灌注」
 * 「你的描述和我记录的不一致」—— 顾问腔换着花样来，光靠关键词黑名单堵不住。
 *
 * 所以这里不跟它打词表战，改用**结构**：
 * 摘要是给后续干活用的账本，只认「块标签 + 事实行」这一种形状，
 * 其余（寒暄、评论、建议、提问）一律不留。
 *
 * 只做保守清洗，不做语义改写 —— 宁可少留一句废话，也不能把事实数字洗掉。
 * 万一模型完全没按格式写（老模型、换了个模型），退回到「限长 + 去 Markdown」，
 * 不会把整个摘要清空。
 */
/** 一行是不是「事实」：带数字 / 路径 / 文件名 / 命令的，基本可以信。 */
/** 顾问腔：即使落在标签下的行里，带这些词的也不要。 */

function cleanSummary(text) {
  let s = String(text ?? '');
  if (!s) return s;
  // ── 先做通用的干净化 ────────────────────────────────
  // 1) 围栏代码块记号（保留里面内容，只去 ``` 那一行）
  s = s.replace(/^\s*```[^\n]*$/gm, '');
  // 2) Markdown 记号：标题 #、粗体 **、__、反引号
  s = s.replace(/^\s{0,3}#{1,6}\s+/gm, '');
  s = s.replace(/\*\*([^*\n]+)\*\*/g, '$1');
  s = s.replace(/__([^_\n]+)__/g, '$1');
  s = s.replace(/`([^`\n]+)`/g, '$1');
  // 3) 列表记号统一成「- 」
  s = s.replace(/^\s*[•·*+]\s+/gm, '- ');

  // ── 再按结构筛 ────────────────────────────────────
  // 关键判断：模型守不守格式。
  // 守格式（出现 ≥2 个标签）→ 严格模式：只留四个标签下的行，标签外的一律不要。
  // 不守格式 → 宽松模式：只按顾问腔/空话过滤，尽量保事实（老模型/换模型时的退路）。
  const rawLines = s.split('\n').map((l) => l.trim()).filter(Boolean);
  const tagHits = rawLines.filter((l) => SUMMARY_BLOCK_TAG.test(l)).length;
  const strict = tagHits >= 2;

  /** 明显的「空话」开头：寒暄、评论、复述自己在干什么 */
  const noise = /^(我|你|好的|收到|明白|了解|嗯|当然|另外|不过|但是|同时|此外|所以|因此|总结来说|总的来说|主人说|小鱼回|这说明|这两件事|从第|需要|这种|这样|如果)/;

  let kept = [];
  if (strict) {
    // 严格模式：认标签。标签下的每一行都留（只砍顾问腔），
    // 标签外的行必须「像事实」（带数字/路径）才留 —— 那是模型的额外补充。
    // 注意：标签下的行不再要求含数字，否则「合流时排除 system 和 context」这种
    // 关键结论会被误杀（实测就吃过这个亏，摘要只剩一句 commit 号）。
    let inTag = false;
    for (const line of rawLines) {
      const isTag = SUMMARY_BLOCK_TAG.test(line);
      if (isTag) {
        inTag = SUMMARY_TAGS.some((t) => new RegExp('^\\s*' + t + '\\s*[:：]').test(line));
        if (inTag) {
          kept.push(line.replace(/\s*[:：]\s*/, ': ').trim());
        } else if (SUMMARY_FACT_LINE.test(line) && !SUMMARY_ADVISOR.test(line)) {
          kept.push(line);
        }
        continue;
      }
      if (SUMMARY_ADVISOR.test(line)) continue;
      if (inTag) { kept.push(line); continue; }
      if (SUMMARY_FACT_LINE.test(line) && !noise.test(line)) kept.push(line);
    }
  } else {
    // 宽松模式（模型没按标签写）：砍顾问腔和空话行，其余照留。
    // 另外：以「- 」开头却一个数字/路径都没有的，基本是评论，不是事实，也丢掉。
    kept = rawLines.filter((line) => {
      if (SUMMARY_ADVISOR.test(line)) return false;
      if (noise.test(line) && !SUMMARY_FACT_LINE.test(line)) return false;
      if (/^-\s/.test(line) && !SUMMARY_FACT_LINE.test(line) && line.length < 60) return false;
      return true;
    });
  }
  s = kept.join('\n');

  // ── 最后兜底：限长 ──────────────────────────────────
  // 摘要长期留在历史里，超过这个长度就开始挤占「真正该留的对话」。
  // 按句子边界截，避免截断在半个数字上。
  const SUMMARY_TEXT_MAX = 2400;
  if (s.length > SUMMARY_TEXT_MAX) {
    const head = s.slice(0, SUMMARY_TEXT_MAX);
    const lastStop = Math.max(head.lastIndexOf('。'), head.lastIndexOf('\n'), head.lastIndexOf('；'));
    s = (lastStop > SUMMARY_TEXT_MAX * 0.5 ? head.slice(0, lastStop + 1) : head) + '\n（摘要过长，已截断）';
  }
  s = s.replace(/\n{3,}/g, '\n\n').trim();
  // 全被洗空了也得给一句实话，别留下一条空摘要占着位置
  return s || '（这段早期对话没有压出可用的事实，原文已折叠）';
}

  const makeSummary = () => ({
    role: 'user',
    content:
      '（下面是程序自动生成的「早期对话摘要」，不是主人说的话。'
      + '这段里出现的第一人称是之前那个你的口吻，只当作参考资料，别当成主人在对你提要求。）'
      + `\n\n【早期对话摘要 · 原文已压缩】\n${cleanSummary(summaryText)}`,
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
  // 专业模式没有 summaryMsg 这一条；用空数组拼，`...[]` 就是什么都不插
  const summaryMsg = makeSummary();
  const withSummary = (tailPart) => (
    summaryMsg ? [...messages.slice(0, start), summaryMsg, ...tailPart] : [...messages.slice(0, start), ...tailPart]
  );
  /**
   * 这一轮「至少留几条」，跟 findCut 的 floor 一致。
   *
   * 专业模式下 trigger 是 0（每轮都压），如果这里不留底线，
   * 循环会一路把尾巴丢到空 —— 实测真的丢成了 after=6、kept=0，
   * 模型拿到一个空上下文，当场失忆，活干不下去。
   * 留最后一个来回（最多四条），够它接着往下做。
   */
  const keepFloor = Math.max(1, Math.min(4, keep.length));
  while (guard++ < 200) {
    const next = withSummary(keep);
    // 【2026-10-27 补】这里不能拿 trigger 当目标。
    // 小鲸在临界带说「压」时 trigger 会被设成 0（表示允许动手），
    // 可一旦拿 0 当「压完要落到多少」，这个循环就永远不满足、一路丢到 keepFloor。
    // 实测：历史 34.8 万 token、该留 17.5 万，结果只剩 4 条（3727 token）—— 当场失忆。
    // 现在用 targetAfter（窗口的 15%）当落地目标，它一定是个正数。
    const landAt = Number.isFinite(targetAfter) && targetAfter > 0
      ? targetAfter
      : (trigger > 0 ? trigger : Math.floor(cap * 0.15));
    if (estimateTokens(next) <= landAt) break;
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
  // 尾巴被削得太薄 = 近况没了，模型接着干会失忆。不是致命错，但必须留痕。
  const thin = keep.length < MIN_KEEP_MSGS;
  if (thin) {
    console.warn('[compress] 尾巴只剩 ' + keep.length + ' 条（低于 ' + MIN_KEEP_MSGS
      + '），cap=' + cap + ' headTokens=' + headTokens + ' keepTarget=' + keepTarget
      + ' before=' + before + ' after=' + after);
  }
  if (process.env.COMPRESS_DEBUG) {
    console.log('[compress] 压了：before=' + before + ' after=' + after + ' trigger=' + trigger + ' cap=' + cap + ' 剩 ' + keep.length + ' 条');
  }
  return {
    compressed: true, before, after, limit: cap, trigger,
    removed: old.length + dropped, kept: keep.length,
    ...(thin ? { thinTail: keep.length } : {}),
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

