/**
 * 压缩内核（2026-11 全面重做）
 *
 * ============ 为什么推倒重来 ============
 *
 * 老路子（compress.mjs 里那一千五百多行）的病根只有一个：
 * **「什么时候该压」这件事交给了我自己判断。**
 *
 * 具体是这样的：每轮开头程序偷偷跑一次 dryPlan 探线，超线了就往对话里塞一句
 * 「【该你自己压了】」，等我下一轮看见它、想起来、动手写压缩记忆、再下一轮才真压。
 * 中间任何一环掉链子（我忙着跑命令没看见 / 写了我没存 / 存了没读回来），
 * 历史就一路涨到网关打回 400，整个会话当场死掉。
 * 主人看到的「工作鱼2 撑到 2.3 倍、工作鱼3 撑到 3.0 倍」全是这么来的。
 *
 * 所以新内核把职责劈成两半：
 *   · **什么时候压** —— 程序说了算，到线就动手，一次都不等我。
 *   · **压什么、留什么** —— 我说了算，只认我亲手写的压缩记忆，程序一个字不代笔。
 *
 * ============ 三层，从便宜到贵 ============
 *
 *   L1 出门截断     tools.mjs 的 clipToolResult：工具输出超长就落盘、只回头尾。
 *                   （已上线，见提交 f26c105）
 *   L2 历史瘦身     slimHistory：把旧的工具结果、超长的旧正文换成一行占位，
 *                   原文全部落盘可查。**不改条数、不改 id、不改顺序、不拆 tool 配对。**
 *                   不需要我参与，不花钱，随时能跑，跑一百遍结果一样。
 *   L3 真折叠       由 compress.mjs 的老流程负责（清单 + 存档 + 回退点重映射都还在），
 *                   只认我亲手写的 selfNote。
 *
 * ============ 为什么 L2 敢不经我同意就动 ============
 *
 * 因为它**不销毁任何东西**。占位行里写着原文存在哪个文件、一共多少字，
 * 我（或者主人）随时能 read_file 翻回来。真正不可逆的只有 L3，那一步必须我亲手写。
 *
 * 而实测表明 L2 一个人就能干掉绝大部分体积：老会话里工具结果常年占 53%~62%，
 * 而其中九成以上是「三个月前跑的一条命令」—— 我根本不会再去看它，
 * 但它每一轮都在吃 token 和钱。
 */
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { config } from './config.mjs';
import { currentCalibration } from './compress.mjs';

/** 一条消息本身的固定开销（role、分隔符这些），跟老 compress.mjs 保持一个口径。 */
const PER_MESSAGE_OVERHEAD = 4;

/** 落盘形态的图片只记了路径、还没 inflate，按保守值估一笔，宁可高估。 */
const IMAGE_ESTIMATE_CHARS = 10000;

/**
 * 三层闸门。
 *
 * SOFT 定 0.55 是拿实测数字倒推的，不是随手挑的：
 *   · 这个程序的历史里工具结果常年占 53%~62%，而其中九成以上是三个月前跑的命令；
 *   · 一轮里我可能连着跑十几个工具，每跑一个体积就跳一格，跳十几格就是十来个点；
 *   · 老代码在 40% 就开始擦工具过程（`thinHistory`），跑下来没出过事，
 *     说明 40% 动手是安全的 —— 55% 比它晚，但擦得更彻底（连参数一起收）。
 *
 * 等到 1.0 再动手的教训是现成的：工作鱼3 撑到 3.0 倍、code:11115，
 * 就是「以为还宽裕」的代价 —— LLM 的窗口是硬上限，越线不是变慢，是当场死。
 *
 * HARD 0.80 是「不能再拖」的线：这时候 L2 已经跑过，还超说明旧工具结果这条路
 * 已经榨干，剩下能动的只有整段对话 —— 那一步必须我亲手写摘要。
 * 留 20% 缓冲给「折叠本身」，折完落回 0.3~0.5 才有意义。
 */
/**
 * 【2026-11-07 根治·把瘦身线提前】
 *
 * 原来 SOFT 0.55 / HARD 0.80。实测代价是：大会话一直撑到 40 万 token 才动手，
 * 而**每一轮、每一次工具调用都要重新背上这一整坨**。翻真实会话，工具结果占了
 * 上下文的 91%~97% —— 也就是说每多跑一轮，多背的都是旧命令的原文。
 *
 * 现在 0.45 / 0.70：
 *   · SOFT 提前到 45% —— 早一点把旧工具结果擦成结论，别让它们跟着跑一晚上；
 *   · HARD 提前到 70% —— 留 30% 缓冲给折叠本身（折完落回 0.3~0.5 才有意义）。
 *
 * 为什么不怕「改历史废缓存」：slimHistory 是**幂等**的（瘦过的带标记，下一轮不再动）。
 * 所以它只在跨线那一刻改一次历史、废一次缓存，之后前缀重新稳定、缓存照常命中。
 * 反过来，拖着不瘦，是每一轮都在为那些旧原文付钱。
 */
export const SOFT_RATIO = 0.45;
export const HARD_RATIO = 0.7;

/**
 * 【2026-11-07 加·绝对线：不管窗口开多大，背这么多就已经慢了】
 *
 * 只按比例判是不够的 —— 主人在界面里把模型切成了「自动档」，
 * 那个模型窗口 **1,000,000 token**，45% 就是 45 万。
 * 于是会话一路涨到 43 万 token，按比例算还是很「宽裕」，一次都不瘦身。
 *
 * 可「不会死」和「不慢」是两件事：每一轮、每一次工具调用都要把这一整坨
 * 重新发一遍，token 越多首字越慢、越贵。窗口再大也改不了这件事。
 *
 * 所以再加一条按绝对量算的线：
 *   · 12 万 token 起就开始把旧工具结果擦成结论（SOFT）；
 *   · 25 万 token 就是「必须折」了（HARD）。
 * 这两条跟比例取「谁先到」，窗口大也拦不住它提前瘦。
 */
export const SOFT_ABS_TOKENS = 120_000;
export const HARD_ABS_TOKENS = 250_000;

/**
 * 【保命线】到了这条线，就不等我了。
 *
 * 主人 2026-10-30 的死命令是「压缩必须我自己写，不许外包给模型」，我一直照办 ——
 * 但四个会话死在同一件事上：**我忙着干活，忘了写**。工作鱼2 撑到 2.3 倍、
 * 工作鱼3 撑到 3.0 倍（code:11115 prompt is too long）当场终态，会话再也发不出请求。
 *
 * 「被程序折一次、事后我自己看清楚」和「会话当场死亡」之间，只能是前者。
 * 所以 93% 时程序自己动手 —— 但用的是**从我自己的话里摘下来的**机械摘要，
 * 不是叫模型代笔（那才是主人真正不许的事）。
 */
export const CRITICAL_RATIO = 0.93;

/** L2：工具结果超过这么多字就换成占位。 */
export const SLIM_TOOL_CHARS = 3000;
/** L2：assistant 正文超过这么多字就掐头保尾。 */
export const SLIM_TEXT_CHARS = 6000;
/** L2：跑命令那类工具的结果，头尾各留多少。 */
const SLIM_HEAD = 1400;
const SLIM_TAIL = 800;
/** L2：最后这么多条一个字都不碰（近况最要紧，模型下一句就靠它）。 */
export const SLIM_KEEP_TAIL = 14;
/** L2：tool_calls 里的 arguments 超过这个就截。 */
const SLIM_ARGS_CHARS = 2000;

/**
 * 【分级砍，2026-11 实测后加的 —— 这一条比上面所有阈值加起来都重要】
 *
 * 拿「干活鱼」这个真实会话（1477 条 / 685K token）量出来：
 *
 *   正文 tool          353,412 tok（51.6%）
 *   tool_calls 参数    270,311 tok（39.4%）
 *   助手正文            53,752 tok（ 7.8%）
 *
 * 可「超 3000 字的工具结果」加起来只有 46,246 tok —— 也就是说，
 * **它根本不是靠几条巨无霸撑起来的，是几百条两千多字的短结果堆出来的。**
 * 按固定字数设阈值（3000）只捞到 12.8%，剩下 87% 一滴不落地躺在上下文里。
 *
 * 所以改成按「年龄」分级：越靠前的历史砍得越狠。太老的那些本来也只剩
 * 「跑过一条命令」这个事实有用，具体输出早就不看了。
 */
export const SLIM_TOOL_NEAR = 400;
export const SLIM_TOOL_FAR = 120;
const SLIM_ARGS_NEAR = 500;
const SLIM_ARGS_FAR = 150;
/** 越靠前越狠的界线：历史前四成算「老」。 */
const SLIM_OLD_SHARE = 0.4;
/** 近况区默认按窗口的两成半留 —— 到线时 55%，留 25%，压完落回 30% 上下。 */
export const SLIM_KEEP_TOKENS_RATIO = 0.25;

/**
 * 估 token。
 *
 * 口径跟老 compress.mjs 一致（中文 1.5 字/token），**故意估大不估小**：
 * 估小了会以为「还没到线」，等网关打回来就晚了；估大了最多多压一次。
 *
 * 图片单独算：base64 是 dataUrl 就按真实长度，只有路径就按保守常量 ——
 * 这一步以前漏过，带图的会话永远判「没超线」，一路堆到网关打回。
 */
export function estTokens(messages, sessionId) {
  let total = 0;
  /**
   * 【2026-11-01 严检：判定口径必须和量线一致】
   *
   * 原来这里一律按 1.5 字/token 硬算，而 compress.mjs 的 estimateTokens
   * 会乘一个「拿真实 usage 反校出来的 calibRatio」（实测约 1.6）。
   * 同一份历史：量线报 69.6%，这里报 43.7% —— 一个说快爆了，一个说还早，
   * 结果量线一直在催，压缩判定永远 tier=none，**永远不压**，直到撑爆。
   *
   * 现在统一走校准口径。拿不到系数就退回 1.5，绝不把这一轮带崩。
   */
  let perToken = 1.5;
  try {
    const k = Number(currentCalibration(sessionId) || 0);
    if (Number.isFinite(k) && k >= 1 && k <= 8) perToken = 1.5 / k;
  } catch { /* 读不到就用 1.5 */ }
  if (!(perToken > 0.1)) perToken = 1.5;
  for (const m of messages) {
    if (!m) continue;
    total += PER_MESSAGE_OVERHEAD;
    const raw = m.content;
    let textChars = 0;
    let imageChars = 0;
    if (Array.isArray(raw)) {
      for (const p of raw) {
        if (!p) continue;
        if (typeof p.text === 'string') textChars += p.text.length;
        else if (p.type === 'image_url') {
          const url = p.image_url && p.image_url.url;
          imageChars += typeof url === 'string' && url.startsWith('data:') ? url.length : IMAGE_ESTIMATE_CHARS;
        }
      }
    } else if (typeof raw === 'string') {
      textChars = raw.length;
    }
    if (Array.isArray(m._images) && m._images.length) {
      imageChars += m._images.length * IMAGE_ESTIMATE_CHARS;
    }
    if (textChars) total += Math.ceil(textChars / perToken);
    /* 【2026-11-05 修·两套口径对不上，导致「喊该压、压不动」】
     *
     * 图片原来也除 perToken（= 1.5/k），而 compress.mjs 那边明确**不乘**这个系数，
     * 理由是它拿「文字字符/token」实测反校出来的，套到 base64 上会把系数带偏。
     * 结果：带图会话里闸门算出的比例比真压判定高约 k 倍（实测 1.6 倍）——
     * 一边喊「到 80% 该折了」，另一边算出来只有 50%，compressHistory 返回
     * under-trigger，每轮都判定该压、每轮都压不动。
     *
     * 现在图片跟 compress 一样不乘系数：**两边算的是同一件事**。
     * 文字和 tool_calls 照旧乘（那边也是乘的）。
     */
    if (imageChars) total += Math.ceil(imageChars / 1.5);
    if (Array.isArray(m.tool_calls)) {
      let callChars = 0;
      for (const tc of m.tool_calls) {
        const f = tc && tc.function;
        if (!f) continue;
        if (typeof f.name === 'string') callChars += f.name.length;
        if (typeof f.arguments === 'string') callChars += f.arguments.length;
      }
      if (callChars) total += Math.ceil(callChars / perToken);
    }
  }
  return total;
}

/**
 * 头部有几条动不得。
 *
 * system 是设定，紧跟的那条 context user 是「规矩副本」。
 * **摘要不算头部** —— 它带 context 标记但可以再被折叠，当成头部就会永久冻在最前面，
 * 越压前面堆的摘要越多（这个坑老代码里踩过，注释还在 compress.mjs:222-229）。
 */
export function headLength(messages) {
  let n = messages[0] && messages[0].role === 'system' ? 1 : 0;
  if (messages[n] && messages[n].context && !messages[n].summary) n += 1;
  return n;
}

/**
 * 这一段历史现在处在哪一档。
 *
 * @returns {{before:number, limit:number, ratio:number, tier:'none'|'slim'|'hard'}}
 */
export function compactGate(messages, limit, sessionId) {
  const before = estTokens(messages, sessionId);
  const cap = Number(limit) || 0;
  const ratio = cap > 0 ? before / cap : 0;
  let tier = 'none';
  /* 【2026-11-07】比例和绝对量取「谁先到」——
   * 窗口 1M 的时候比例永远到不了，靠的就是下面那两条绝对线（见常量注释）。 */
  if (ratio >= HARD_RATIO || before >= HARD_ABS_TOKENS) tier = 'hard';
  else if (ratio >= SOFT_RATIO || before >= SOFT_ABS_TOKENS) tier = 'slim';
  return { before, limit: cap, ratio, tier };
}

/** 占位行长这样，靠它判断「这条已经瘦过了」，保证幂等。 */
const SLIM_MARK = '[已瘦身·原文';

function slimDir(sessionId) {
  const sid = String(sessionId || 'unknown').replace(/[^\w-]/g, '_');
  return join(config.dataDir, '.state', 'slim', sid);
}

/**
 * 把要被换掉的那段原文存盘，返回可读路径。
 *
 * 存不下来也照样瘦 —— 存盘是加分项，不能因为它失败就把整轮卡住。
 * 但一定要**在改消息之前**存，改完手上就没这个东西了。
 */
function saveSlimOriginal(sessionId, index, role, text) {
  try {
    const dir = slimDir(sessionId);
    mkdirSync(dir, { recursive: true });
    const file = join(dir, String(index).padStart(4, '0') + '-' + role + '-' + Date.now() + '.txt');
    writeFileSync(file, String(text), 'utf8');
    return file;
  } catch {
    return '';
  }
}

/**
 * 掐头保尾地截一段文本。
 *
 * 【为什么必须保尾巴】报错原文全在最后：node 的 `Error: ... at ...`、
 * python 的 Traceback、编译器最后那句 `2 errors`。只留开头等于把最要命的那几行扔了。
 */
function clipMiddle(s, head, tail) {
  const str = String(s);
  if (str.length <= head + tail + 40) return str;
  const cut = str.length - head - tail;
  return str.slice(0, head) + '\n…（中间省略 ' + cut + ' 字）…\n' + str.slice(str.length - tail);
}

/**
 * 【2026-11-05 修·会把整个会话钉死的那条】
 *
 * tool_calls 的 arguments 本来是**一整段 JSON 字符串**。以前直接对它做 clipMiddle，
 * 历史里就留下 `{"path":"a.md","content":"abc…（中间省略 12000 字）…xyz` 这种半截 JSON。
 *
 * 后果分两种，都不轻：
 *   · 校验参数的网关（Azure / 部分中转）：整个请求 400，而且**每轮都 400**，
 *     会话从此发不出话；
 *   · 不校验的模型：读到自己"参数被撕断"的调用记录，照着编下去。
 *
 * 现在：先 JSON.parse，只截那几个可能超长的字段（content / old_string …），
 * 再 stringify 回去 —— 参数仍然合法，被截的地方带标记，原文还在盘上。
 * 解析不了（本来就不是 JSON）才退回字符串截断，那种情况本来也没有 JSON 可破坏。
 */
const BIG_ARG_KEYS = new Set([
  'content', 'old_string', 'new_string', 'text', 'body', 'patch',
  'data', 'value', 'code', 'script', 'prompt', 'html', 'json',
]);

function slimArgsKeepingJson(orig, { head, tail, note }) {
  const mark = '\n' + note;
  let obj = null;
  try { obj = JSON.parse(orig); } catch { obj = null; }
  if (!obj || typeof obj !== 'object') return clipMiddle(orig, head, tail) + mark;

  let touched = 0;
  const walk = (o, depth) => {
    if (!o || typeof o !== 'object' || depth > 4) return;
    for (const k of Object.keys(o)) {
      const v = o[k];
      if (typeof v === 'string' && BIG_ARG_KEYS.has(k) && v.length > head + tail + 40) {
        // 截完必须留标记：模型得知道自己看到的是残的，不然会拿半截内容当真
        o[k] = clipMiddle(v, head, tail) + mark;
        touched++;
      } else if (v && typeof v === 'object') {
        walk(v, depth + 1);
      }
    }
  };
  walk(obj, 0);
  // 没有可截的大字段（比如超长内容塞在别的键名里）→ 退回字符串截断
  if (!touched) return clipMiddle(orig, head, tail) + mark;
  try {
    return JSON.stringify(obj);
  } catch {
    return clipMiddle(orig, head, tail) + mark;
  }
}

/**
 * L2：历史瘦身。
 *
 * 把**旧的**工具结果和**超长的**旧正文换成一行占位，原文落盘。
 *
 * 三条铁律（照抄 ctx-guard 的思路，也是我反复踩坑换来的）：
 *   ① 条数一条不改 —— dsh/小鱼Agent 内部靠下标记账（rewind、回退点、tool 配对），
 *      删一条就可能把账弄断，断了比撑爆还惨；
 *   ② tool_call_id 和 tool_calls 的 id 一个不动 —— 上游按 OpenAI 协议校验，
 *      配不上直接 502；
 *   ③ 幂等 —— 已经瘦过的（带 SLIM_MARK）跳过，跑一百遍结果一样。
 *
 * @returns {{changed:number, before:number, after:number, saved:string[], keepFrom:number}}
 */
export function slimHistory(messages, { sessionId = '', keepTail = SLIM_KEEP_TAIL, keepTokens = 0 } = {}) {
  const before = estTokens(messages, sessionId);
  const head = headLength(messages);

  /**
   * 尾巴从哪儿开始不动：近况是模型下一句的落脚点，一个字都不能碰。
   *
   * 【两套算法，token 预算优先】
   *
   * 给了 keepTokens 就按「从最新往回攒，攒够这么多 token 就停」来划 —— 这才是对的：
   * 一条 2 万字的工具结果和一条 200 字的，凭什么占一样的位子？
   *
   * 没给就退回按条数（`keepTail`），并且**最多让出三成历史**：
   * 一开始写的是 `messages.length - keepTail`，结果短会话完全不瘦身 ——
   * 一个只有 5 条、里面塞了一条 2 万字工具结果的会话（超线恰恰就是这么造成的），
   * 5 - 14 是负数，切点被夹到 1，循环一次都不进，越该压的越压不动。
   */
  let keepFrom;
  if (keepTokens > 0) {
    let acc = 0;
    keepFrom = messages.length;
    for (let i = messages.length - 1; i >= head; i--) {
      const t = estTokens([messages[i]], sessionId);
      // 至少保住最后两条，再多就超预算也不管了 —— 模型下一句全靠它
      if (acc + t > keepTokens && messages.length - i > 2) break;
      acc += t;
      keepFrom = i;
    }
    keepFrom = Math.max(head, keepFrom);
  } else {
    const keepN = Math.max(1, Math.min(keepTail, Math.floor(messages.length * 0.3)));
    keepFrom = Math.max(head, messages.length - keepN);
  }

  /**
   * 年龄分档：历史前四成算「老」。
   * 「老」那批工具结果只留 300 字、「近」那批留 1200 字 —— 越远的事实越不值钱，
   * 但**条数和 id 一个不少**，需要的时候还能按占位里记的原图路径回查。
   */
  const span = Math.max(1, keepFrom - head);
  const oldLine = head + Math.floor(span * SLIM_OLD_SHARE);

  let changed = 0;
  const saved = [];

  for (let i = head; i < keepFrom; i++) {
    const m = messages[i];
    if (!m) continue;
    // 摘要和规矩副本不动：它们是压缩的产物/边界，改了会把压缩链路弄乱
    if (m.summary || m.context) continue;

    // ⓪ 图片：最贵的一块。生图那个会话 8 条消息 601K token，99% 全是 base64 图。
    //   图不落在对话里，落在 .state/images/ 里，上下文只留一行「图在哪儿、多大」。
    if (Array.isArray(m.content)) {
      const n = slimImages(m, sessionId);
      if (n > 0) changed++;
      continue; // 数组形态的正文不走下面那三条（它们都是针对纯字符串的）
    }

    const isOld = i < oldLine;
    const toolLimit = isOld ? SLIM_TOOL_FAR : SLIM_TOOL_NEAR;
    const argsLimit = isOld ? SLIM_ARGS_FAR : SLIM_ARGS_NEAR;

    // ① 工具结果：最肥的一块
    if (m.role === 'tool' && typeof m.content === 'string') {
      const s = m.content;
      if (s.length <= toolLimit || s.includes(SLIM_MARK)) continue;
      const file = saveSlimOriginal(sessionId, i, 'tool', s);
      if (file) saved.push(file);
      const keepHead = Math.min(isOld ? 200 : SLIM_HEAD, Math.max(60, Math.floor(toolLimit * 0.6)));
      const tailN = isOld ? 100 : SLIM_TAIL;
      m.content =
        clipMiddle(s, keepHead, tailN) +
        '\n' + SLIM_MARK + ' ' + s.length + ' 字' + (file ? '，整份在 ' + file : '，存盘失败') +
        '，要原文用 read_file 读它]';
      changed++;
      continue;
    }

    // ② assistant 的长正文：结论通常在前、细节在中、最后的补充在后
    if (m.role === 'assistant' && typeof m.content === 'string') {
      const s = m.content;
      if (s.length > SLIM_TEXT_CHARS && !s.includes(SLIM_MARK)) {
        const file = saveSlimOriginal(sessionId, i, 'assistant', s);
        if (file) saved.push(file);
        m.content =
          clipMiddle(s, SLIM_TEXT_CHARS - SLIM_TAIL, SLIM_TAIL) +
          '\n' + SLIM_MARK + ' 原文 ' + s.length + ' 字' + (file ? '，整份在 ' + file : '，存盘失败') + ']';
        changed++;
      }
      /* 【2026-11-05 修】原来这里是无条件 continue：只要是 assistant 消息，
       * 正文不长就直接跳下一条。可**带工具调用的 assistant，content 经常是空串**，
       * 于是下面第 ③ 条（瘦 tool_calls 参数）一次都没执行到 ——
       * 那条规则写在那儿形同虚设，长参数一直原样占着上下文。
       * 现在正文和参数各管各的，互不挡路。 */
    }

    // ③ tool_calls 的参数：一条 write_file 的参数能有几万字
    if (Array.isArray(m.tool_calls)) {
      for (const tc of m.tool_calls) {
        const f = tc && tc.function;
        if (!f || typeof f.arguments !== 'string') continue;
        if (f.arguments.length <= argsLimit || f.arguments.includes(SLIM_MARK)) continue;
        const orig = f.arguments;
        const file = saveSlimOriginal(sessionId, i, 'args', orig);
        if (file) saved.push(file);
        const keepHead = isOld ? 200 : SLIM_ARGS_NEAR - 400;
        // 【2026-11-05 修】走 slimArgsKeepingJson：先解析再截大字段，
        // 保证瘦完之后仍然是一段合法 JSON。
        const argsNote = SLIM_MARK + ' 参数原文 ' + orig.length + ' 字'
          + (file ? '，整份在 ' + file : '') + ']';
        f.arguments = slimArgsKeepingJson(orig, {
          head: keepHead,
          tail: isOld ? 100 : 400,
          note: argsNote,
        });
        changed++;
      }
    }
  }

  const after = estTokens(messages, sessionId);
  return { changed, before, after, saved, keepFrom };
}

/** 图片文件名的安全化（会话 id 里可能有点号、中文）。 */
function sidSafe(sessionId) {
  return String(sessionId || 'default').replace(/[^\w-]/g, '_').slice(0, 60) || 'default';
}

/** 从图片字节里读宽高（PNG 读 IHDR，JPEG 扫 SOF 段），读不出就 0。 */
function imageSize(buf) {
  try {
    if (buf.length > 24 && buf[0] === 0x89 && buf[1] === 0x50) {
      return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
    }
    if (buf[0] === 0xff && buf[1] === 0xd8) {
      let p = 2;
      while (p + 9 < buf.length) {
        if (buf[p] !== 0xff) { p++; continue; }
        const mk = buf[p + 1];
        const len = buf.readUInt16BE(p + 2);
        if (mk >= 0xc0 && mk <= 0xcf && mk !== 0xc4 && mk !== 0xc8 && mk !== 0xcc) {
          return { height: buf.readUInt16BE(p + 5), width: buf.readUInt16BE(p + 7) };
        }
        p += 2 + len;
      }
    }
  } catch { /* 读不出来就 0，不影响落盘 */ }
  return { width: 0, height: 0 };
}

/**
 * 把一张 base64 图从上下文里摘出来，存成磁盘文件。
 *
 * **为什么一定要做这件事**：生图那个会话只有 8 条消息，却占 601K token，
 * 其中 595K（99%）全是 base64。它一次都没超线只是运气好，第八张图就爆了。
 * 而 base64 进了上下文还有个更隐蔽的害处：**模型并不能真"看"它花钱买来的那 60 万
 * token**，它只是在为一张自己解析不了的字符串付全额。
 *
 * 用内容 sha1 前 16 位当文件名，同一张图重复出现只存一份。
 */
function saveImageFile(sessionId, b64, mime) {
  try {
    const buf = Buffer.from(String(b64).replace(/\s+/g, ''), 'base64');
    if (!buf.length) return null;
    const ext = /jpe?g/.test(mime) ? '.jpg' : /webp/.test(mime) ? '.webp' : /gif/.test(mime) ? '.gif' : '.png';
    const h = createHash('sha1').update(buf).digest('hex').slice(0, 16);
    const dir = join(config.dataDir, '.state', 'images', sidSafe(sessionId));
    mkdirSync(dir, { recursive: true });
    const file = join(dir, h + ext);
    if (!existsSync(file)) writeFileSync(file, buf);
    const sz = imageSize(buf);
    return { file, bytes: buf.length, width: sz.width, height: sz.height };
  } catch {
    return null;
  }
}

/** 把一条消息里所有 dataUrl 图换成「图在哪儿」的文字（幂等：换完就不再是 data: 了）。 */
function slimImages(m, sessionId, opts = {}) {
  const arr = m.content;
  if (!Array.isArray(arr)) return 0;
  // maxChars > 0 时只收「大图」：比它小的原样留着（给模型真看）
  const maxChars = Number(opts.maxChars) > 0 ? Number(opts.maxChars) : 0;
  let hit = 0;
  let imgChars = 0;
  for (let k = 0; k < arr.length; k++) {
    const p = arr[k];
    if (!p || p.type !== 'image_url') continue;
    const url = p.image_url && p.image_url.url;
    if (typeof url !== 'string' || !url.startsWith('data:')) continue; // 外链/已落盘的不动
    if (maxChars > 0 && url.length <= maxChars) continue; // 小图放行，留给模型看
    const mm = /^data:(image\/(?:png|jpe?g|webp|gif));base64,(.+)$/.exec(url);
    if (!mm) continue;
    imgChars += url.length;
    const info = saveImageFile(sessionId, mm[2], mm[1]);
    arr[k] = {
      type: 'text',
      text: '[图片已落盘：'
        + (info ? info.file + '（' + info.width + '×' + info.height + '，'
            + Math.round(info.bytes / 1024) + ' KB）' : '存盘失败')
        + '。图本身不进上下文，要看得用工具打开这个文件]',
    };
    hit++;
  }
  // 全换成文字之后压平成字符串：数组形态本身也要花钱，能省一点是一点
  if (hit > 0 && arr.every((p) => p && p.type === 'text')) {
    m.content = arr.map((p) => p.text).join('\n');
  }
  return hit;
}

/**
 * 【图片永不进上下文】2026-11-01 主人拍的板（建议 ②）
 *
 * 为什么单独开一个、而不是只靠 slimHistory 里那一处：
 *   slimHistory 只在「会话超过 55%」时才跑，而图片是**一开始就不该在里面**的东西 ——
 *   生图那个会话 8 条消息 601K token，其中 99% 是 base64 图，第八张图就该爆了。
 *   等它涨到 55% 再清，等于让一辆超载车先上路再卸货。
 *
 * 所以这个函数不看闸门、不看年龄档、不看近况区：**每一条消息都扫**，
 * 见到 dataUrl 图就落盘换成一行「图在哪儿、多大」。幂等（换完就不再是 data: 了）。
 *
 * 头部的 system 也扫 —— system 里塞图的写法不是没有。
 *
 * @param {Array} messages 完整历史
 * @param {string} sessionId 落盘目录用
 * @returns {{changed:number, saved:number}} 改了几条消息、落了几张图
 */
export function stripImages(messages, sessionId = '', opts = {}) {
  let changed = 0;
  let saved = 0;
  if (!Array.isArray(messages)) return { changed, saved };
  /**
   * 【修·2026-11-06 主人发图我看不见】
   * 原来这里一律全扫全换 —— 主人这一轮刚贴的截图，还没送到模型手上就被换成一行
   * 「图本身不进上下文」，我永远看不见。防的是 base64 堆在历史里把窗口撑爆，
   * 不是防「主人现在给我的这张图」。
   *
   * 所以：**这一轮（最后一条 user 起往后）原样留着，只换历史里的。**
   * 下一轮它自己就进了历史，照样会被换掉，不会再堆积。
   *
   * opts.keepFromUser = true（默认）就按上面的规矩来；
   * 传 false 退回老行为（全扫全换）。
   */
  const keepFromUser = opts.keepFromUser !== false;
  let cut = messages.length;
  if (keepFromUser) {
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      /* 【2026-11-06 修·我把主人的话全排掉了】
       *
       * 上一版写的是 `!m._who`，本意是「跳过别人插话」。可实际上**主人自己说的每一句
       * 都带 `_who: '主人'`** —— 于是这个条件把主人全部排掉，cut 退化成 messages.length，
       * 「保留段」长度为 0，整轮所有消息都被当成历史、图被无门限地全换成文字。
       * 后果就是：主人发图我看不见，read_file 读图也看不见。
       *
       * 正确的判据：只排两类 ——
       *   · `_sysNote`  ：程序自己插的量线提醒，不是人话
       *   · `context`   ：程序拼的早期摘要/引子，不是这一轮的新话
       * 其余 `role === 'user'` 一律算主人的发言（`_who` 是「谁说的」，主人也带）。
       */
      if (m && m.role === 'user' && !m._sysNote && !m.context) { cut = i; break; }
    }
  }
  for (let i = 0; i < cut; i++) {
    const m = messages[i];
    if (!m || !Array.isArray(m.content)) continue;
    const n = slimImages(m, sessionId);
    if (n > 0) {
      changed++;
      saved += n;
    }
  }
  /**
   * 【2026-11-06 本轮的新图也别无限留】
   * 小截图留着没问题（一张几万字符，值）；可主人要是贴一张几 MB 的照片，
   * 一轮里工具调十几次，同一张图就被重发十几次 —— 那才是真撑爆窗口的东西。
   * 所以本轮只留「不算大的」；超大图照样落盘，我照样能用 read_file 打开看。
   */
  let bigSaved = 0;
  for (let i = cut; i < messages.length; i++) {
    const m = messages[i];
    if (!m || !Array.isArray(m.content)) continue;
    bigSaved += slimImages(m, sessionId, { maxChars: 4000000 });
  }
  return { changed, saved, kept: messages.length - cut, bigSaved };
}

/**
 * 【保命】上下文快撑爆、我自己又没顾上写压缩记忆时，程序替我留的底。
 *
 * 三条规矩：
 *   ① **不许叫模型写** —— 只从已经发生过的话里摘（我自己的结论、主人的原话、清单），
 *      一个字都不生成。这是「机械摘要」，不是「另找个人替我回忆」；
 *   ② **必须能被 acceptSelfNote 收下** —— 带编号、够长、没有顾问腔，否则折完等于没折；
 *   ③ **必须标明是兜底的** —— 摘要里第一行就写明白，好让下一次的我看清
 *      「这一段不是我写的，可信度要打折，关键处回查原文」。
 *
 * @param {Array} messages 当前完整历史
 * @param {{planText?:string, segId?:string}} opts 清单原文、段号
 */
export function buildRescueNote(messages, { planText = '', segId = '' } = {}) {
  const head = headLength(messages);
  const body = messages.slice(head).filter(Boolean);
  const out = [];
  out.push('【压缩记忆 · 程序兜底段' + (segId ? ' ' + segId : '') + '】');
  out.push('这一份不是我写的：上下文已到保命线，我这一轮没顾上写压缩记忆，程序从我自己的话里摘了下面这些，保住这一段不丢。关键处请回查原文。');

  const talks = body.filter(
    (m) => m.role === 'assistant' && typeof m.content === 'string' && m.content.trim().length > 20,
  );
  const picked = talks.slice(-6);
  if (picked.length) {
    out.push('我做完了什么（从我自己的话里摘）：');
    for (const m of picked) out.push('- ' + m.content.trim().replace(/\s+/g, ' ').slice(0, 80));
  }

  const users = body.filter(
    (m) => m.role === 'user' && !m._sysNote && typeof m.content === 'string' && m.content.trim().length > 4,
  );
  const u = users.slice(-5);
  if (u.length) {
    out.push('主人要什么（原话摘，比我的转述可信）：');
    for (const m of u) out.push('- ' + m.content.trim().replace(/\s+/g, ' ').slice(0, 60));
  }

  if (planText && String(planText).trim()) {
    out.push('清单：');
    out.push(String(planText).trim().slice(0, 1200));
  }

  out.push('还没做完的事：按上面清单逐条对，别信我这里的摘录，回原文查。');
  return out.join('\n');
}

/**
 * 一轮里该怎么压 —— 一次性给全，调用方照着做就行。
 *
 * **这个函数的存在就是为了让 agent.mjs 不再自己判断。**
 * 老代码里 agent 先探一次线、再自己决定要不要塞提醒、再决定要不要真压，
 * 三处判断各写一遍，任何一处写错就出现「压了没效果」或者「不该压的时候乱压」。
 */
export function planTurnCompact(messages, limit, sessionId) {
  const gate = compactGate(messages, limit, sessionId);
  return {
    ...gate,
    /** 要不要跑 L2（历史瘦身） */
    shouldSlim: gate.tier !== 'none',
    /**
     * 要不要真折叠（L3）。
     *
     * **只有到了 HARD 才要**：L2 已经在同一步里跑过了，跑完还超说明
     * 旧工具结果这条路已经榨干，剩下能动的只有整段对话 —— 那一步必须我亲手写摘要。
     */
    shouldFold: gate.tier === 'hard',
  };
}
