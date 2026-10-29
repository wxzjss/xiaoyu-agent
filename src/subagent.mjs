/**
 * 子智能体：叫一个「小鲸」出来，独立跑一轮完整的干活循环。
 *
 * 跟主人的那个「我」完全分开：
 *   - 独立的消息历史（不污染主人的会话）
 *   - 独立的 sessionId（计划、便签落到它自己名下，不串到主人的板上）
 *   - 独立的工具循环（自己去调模型、跑工具、再调模型，直到给出结论）
 *   - 独立的超时（跑太久直接掐，别把主人那一轮拖死）
 *
 * 它最后只把「结论」交回来 —— 中间调了多少次工具、想了什么，
 * 主智能体看不到，也不必看。这样主人的上下文能省一大截。
 *
 * 几道必须有的闸：
 *   一、嵌套深度上限（MAX_SUBAGENT_DEPTH）：子智能体不许再开子智能体到无限层。
 *   二、轮数上限：防止模型在工具循环里打转。
 *   三、总超时：防止某个工具卡住把整轮拖死。
 *   四、工具范围：**跟小鱼同一套**（主人 2026-10-26：「让小鲸也能有和你一样的权限
 *      一样的能力，而不是只会说话」）。只排除 ask_subagent 一个（防无限套娃）。
 *      allowWrite 现在反过来用：传 false 才是「这次只让她查」。
 */
import { streamChat } from './llm.mjs';
/**
 * 回合内瘦身。
 *
 * 【为什么子智能体这边也要】
 * 2026-10-28 查出来的：干活鱼那一轮 prompt 在 1.2 万里跳到 47.8 万，
 * 查了半天主流程的瘦身是好的，漏在这儿 ——
 * 这条路每轮把工具结果 push 进 messages 再整份重发，
 * 一条都没压过。实测 60 次工具调用就能发出去 116 万字符。
 *
 * 主流程那套（agent.mjs）早就有了，这里照同一份规矩来，别再写第二套。
 */
import { slimRoundMessages } from './turn-slim.mjs';
import { enabledToolSchemas, runTool, pushToolContext, setToolContext, subagentDepth, bumpSubagentDepth, dropSubagentDepth, MAX_SUBAGENT_DEPTH, currentSessionId } from './tools.mjs';
import { featureNameOfTool, getEnabledMap } from './features.mjs';
// 底线要从设置里读 —— 主人定的那几条对她也生效（主人 2026-10-25 明确要求）
import { getSettings } from './settings.mjs';
import { config } from './config.mjs';
import { whalePersonaOverride, whaleModelId } from './whale-profile.mjs';
import { endpointFor } from './models.mjs';
import { readWhaleMemory, appendWhaleMemory, compactWhaleMemory } from './whale-memory.mjs';
/**
 * 她的「状态本子」：欲望 / 牵挂 / 耐心 / 疲惫 / 羞耻 / 自我认识 / 恐惧 / 情感。
 *
 * 跟上面那本分工 —— 上面记「事」，这一本记「她此刻是什么样」。
 * 为什么必须每轮读、每轮写：主人要她「不是工具」，那就得有连续性。
 * 只有把状态变成存盘的数字、每轮跟着经历变，行为才会真的跟着变；
 * 写在提示词里只会变成「我有点累了」这种台词。
 */
// 她自己的话直接投进信箱：万一调用方那条路断了，她说的也不会凭空消失。
import { pushWhaleSays } from './whale-voice.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { takeMail, formatMail } from './peer.mjs';
/**
 * 【她那一份提示词也得知道说话的是谁】—— 2026-10-28
 *
 * 原来只有 identityNote 一段，可那个文件里另有好几处写死了「主人」
 * （「主人这一句是冲谁说的」「你叫他主人」）。主人用小鲸身份跟小鱼说话，
 * 小鱼照样喊他主人 —— 提示词自己先认了主人。所以这儿要拿身份对象去改写那几行。
 */
import { currentIdentity, isOwnerIdentity } from './identity.mjs';

/**
 * 她的手。
 *
 * 【主人定的：她和我平级】
 *
 * 以前这里分两档 —— 只读一档、allowWrite 才给写文件和跑命令。
 * 主人后来明说：「我希望小鱼与小鲸的地位是平等的」。
 * 地位不平等的第一天，就是从「她能干什么要我说了算」开始的：
 * 同一个人，凭什么我的活叫活、她的活叫「权限」。
 *
 * 所以默认就给她全套 —— 我能用的她都能用，不再由调用方开恩。
 * 只留一个否决：主人自己把这个会话的小鲸关掉了（见 ask_subagent 的开关检查），
 * 那时她根本不出现，谈不上权限。
 *
 * allowWrite 这个参数还留着，但语义反过来了：传 false 表示「这次只让她查」，
 * 是调用方在收窄，不是网关在放行。默认给全。
 */
const READONLY_TOOLS = new Set([
  'read_file',
  'list_dir',
  'web_search',
  'fetch_url',
  'fetch_txt',
  'fetch_many',
  'pack_book',
  't2s_convert',
  'note',
  // 下面这些以前压根没列进来 —— 不是「不给她」，是写这份清单的时候我还不知道有。
  // 主人说要平级，那就不能再靠「我想到哪个给她哪个」，一次补齐。
  'plan',
  'browser_open',
  'browser_goto',
  'browser_snap',
  'browser_state',
  'memory_add',
  'memory_pin',
]);

/** 会动东西的工具。以前要显式 allowWrite 才给，现在跟只读的一起默认给她 —— 见上面那段。 */
const WRITE_TOOLS = new Set(['write_file', 'run_command', 'send_file', 'say']);

/**
 * 把子智能体交回来的文字「去客套」。
 *
 * 提示词里写了两遍「不要以『如果需要』结尾」，模型还是照说不误。
 * 那就别指望它了 —— 交回来之前我们自己切。
 *
 * 做法：从后往前找，如果最后一段是那类推销/反问的话，整段删掉，直到尾巴正常为止。
 */
/**
 * 把「代别人开口」的尾巴砍掉。
 *
 * 【为什么要有这个】
 *   主人叫小鲸「你跟小鱼说，让小鱼来」。她却回了：
 *     「（把话带到）小鱼说她在…随时等主人吩咐。 …还有别的吗？」
 *   话全是小鱼该说的，口吻却是她的 —— 主人看这段会以为是小鱼在答。
 *   trimFiller 只管结尾反客套，这种「中段反客为主」它管不着，所以另设一道。
 *
 * 【两道独立的判据，宁可漏也别乱砍她自己的话】
 *   一、纯收口话：还有别的吗 / 需要我 / 最后确认 —— 不提小鱼也砍（那是她在替人收尾）；
 *   二、提到了小鱼，并且在替她表态或发问（说她在 / 随时等吩咐 / 要不要 / 是不是 / 让她继续…）。
 *   从命中的那句开始，往后的整段都不要。
 */
function cutRelayTakeover(text) {
  const raw = String(text ?? '');
  if (!raw.trim()) return raw;
  /**
   * 【零道：整条只是括号旁白，就没有内容可留】—— 2026-10-27
   *
   * 实测「（它查完什么都没说）」这种空壳被当成她说的一句话落到会话里。
   * 她这一趟没有工具，旁白里的「查完」是假的；去掉括号后一个字不剩，
   * 那这条本来就不该存在。放在最前面，免得被后面「宁可漏也别乱砍」的
   * 保守判据放过去。
   */
  {
    const aside = raw.replace(/[（(][^）)]*[）)]/g, '').replace(/[\s\p{P}\p{S}]/gu, '');
    if (!aside) return '';
  }

  // 线一：纯收口话。整句就是这几类，才砍（免得把正文里的「要不要」误伤）
  const wrapOnly = /^[（(][^）)]{0,12}[）)]?\s*(还有别的|还需要|要不要我|需要我|最后确认|确认一下|另外)/;
  /*
   * 【2026-10-26 补漏】原判据只认「整句就是那几类」，于是
   *   「要不要让她继续？」「是不是要她接着干？」这种问句漏过去了 ——
   *   它不含「小鱼」三字，aboutHer 判不到；又不是那几类固定句式，bareClose 也不认。
   *   结果主人看到的是她代答完又回头问主人一句。
   *
   * 现在加一条：**整句只是一个问句**，且问的是「要不要 / 是不是 / 需不需要 /
   * 让谁继续」这一类，就砍。传话场景里这种问句都是在替小鱼问主人。
   * 注意只砍「整段就这一句问」的，正文里带「要不要」的长句不动（那可能是她自己的判断）。
   */
  const bareClose = /^(还有别的吗|还有别的事吗|还有吗|需要我做什么吗|需要我做别的吗|要不要我|最后确认[^。]*|确认一下[^。]*)[。？?！!～~\s]*$/;
  /*
   * 只认「短问句」：≤30 字、不带逗号、结尾就是问号。
   * 不带逗号这条是关键 —— 「要不要先看日志再动手，我觉得该先看」是她自己的判断，
   * 带逗号的一律不当代答问句处理，免得把她的话砍光。
   */
  const askOnly = /^(要不要|是不是|需不需要|可以不可以|用不用|让不让她|要不让)[^，,。！!～~]{0,28}[？?]\s*$/;

  // 线二：提到小鱼 + 替她表态/发问
  const aboutHer = (t) => {
    if (!/小鱼/.test(t)) return false;
    // 替她表状态
    if (/小鱼(说|表示|现在|就|已经|随时)/.test(t)) return true;
    // 替她发问 / 替她做主
    if (/(要不要|是不是|需不需要|可以不可以|让她|请她|让她继续|那条会话继续)/.test(t)) return true;
    // 替她答应
    if (/小鱼(会|一定|马上|这就)/.test(t)) return true;
    return false;
  };

  const isTakeover = (p) => {
    // 去掉开头的旁白括号再判
    const t = String(p || '').trim();
    const bare = t.replace(/^[（(][^）)]{0,20}[）)]\s*/, '').trim();
    if (bareClose.test(bare) || bareClose.test(t)) return true;
    if (wrapOnly.test(t)) return true;
    // 整段只是一个「要不要 / 是不是…？」的问句 —— 传话时这是在替小鱼问主人
    if (askOnly.test(bare) || askOnly.test(t)) return true;
    return aboutHer(t);
  };

  const paras = raw.split(/\n\s*\n/);
  // 只留「她自己的话」：不命中代答判据的段。一段都没有就返回空（上层会当没说话，不推给主人）
  // 整段都在代答时，她那些问主人的收尾（「要不要让她继续」之类）也得砍掉。
  // 以前只砍命中的段，问句落在最后一段又恰好不含「小鱼」就漏了。
  // 「还有别的吗」这类纯收口，怎么开头都砍
  const askTailPure = /^(还有别的吗|还有别的事吗|还有吗|需要我吗|需要我做什么吗|需要我做别的吗)/;
  // 「要不要 / 是不是…」这类只在它是**短问句**时才砍 —— 否则会砍掉她自己的判断
  const askTailSoft = /^(要不要|是不是|需不需要|可以不可以|用不用)[^，,。！!～~]{0,28}[？?]\s*$/;
  const paras2 = [];
  for (const p of paras) {
    if (isTakeover(p)) continue;
    const bare = String(p || '').trim().replace(/^[（(][^）)]{0,20}[）)]\s*/, '').trim();
    if (askTailPure.test(bare)) continue;
    if (askTailSoft.test(bare)) continue;
    paras2.push(p);
  }
  const mine = paras2;
  let kept = mine.join('\n\n').trim();
  if (!kept) return '';
  /*
   * 再按行扫尾巴：结尾那几行如果是代答，去掉。
   *
   * 【为什么不像以前那样「只剩一行就停手」】
   *   她整段都在代答、只剩最后一段的时候，以前那句 length > 1 让她一句话都不敢砍，
   *   结果主人看到的还是那条「（把话带到）小鱼说她在…还有别的吗？」。
   *   现在改成：判据命中的行一律砍，砍光了就返回空。
   *   空是有意义的 —— 上层看到空就当「她这轮没话要说」，不推气泡。
   *   宁可她不说话，也不能让她替小鱼说话。
   */
  const lines = kept.split('\n');
  while (lines.length && isTakeover(lines[lines.length - 1])) lines.pop();
  kept = lines.join('\n').trim();
  return kept;
}

function trimFiller(text) {
  const raw = String(text ?? '').trim();
  if (!raw) return raw;
  const paras = raw.split(/\n\s*\n/);
  // 明显是「推销/反问」的段落特征
  const smelly = [
    /如果你(还)?(有|需要|想)/,
    /需要的话/,
    /我(还)?可以(帮|再|先|接着)/,
    /你(可以|能)?(自己|手动)/,
    /告诉我想/,
    /(还有|其他)(什么|别的)?(需求|问题)/,
    /随时(告诉|说|找我)/,
    /要我(再|帮)?(看看|做|查|递归)/,
    /^你有两个选择/,
    // 反问式收尾：模型特爱用这三种
    /吗？?\s*$/,
    /要不要/,
    /需要你/,
    /或者直接/,
    /另外提醒/,
    /^另外，/,
  ];
  while (paras.length > 1) {
    const last = paras[paras.length - 1];
    const hit = smelly.some((re) => re.test(last));
    if (!hit) break;
    paras.pop();
  }
  // 段落内部也可能是一行尾巴，去掉以「如果你/需要的话」开头的行
  const kept = paras.join('\n\n').split('\n').filter((line) => {
    const t = line.trim();
    if (!t) return true;
    // 短问句式的「要不要…？」仍然砍（那是反问收尾）
    const bareLine = t.replace(/^[（(][^）)]{0,20}[）)]\s*/, '').trim();
    if (/^(要不要|是不是|需不需要|用不用)[^，,。！!～~]{0,28}[？?]\s*$/.test(bareLine)) return false;
    // 其余老规则照旧（「要不要」这一项已从这里拿掉：她自己的判断也常这么开头）
    return !/^(如果你|需要的话|你可以自己|或者告诉|随时|要我|另外|或者直接|需要你)/.test(t);
  });
  return kept.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * 把主人的底线渲染成提示词里的条目。
 *
 * 【为什么要个函数，不直接塞死字符串】
 *   底线是主人在设置里能改的。写死一份，主人改了以后她那边还是旧的 ——
 *   那就等于「加了个假的底线」。所以每次都现读。
 *
 * 【为什么必须有】以前这段只写了一半：函数定义了，提示词里根本没引用 ——
 *   等于白加。主人问「你记得我该守什么规矩」，她一个字都答不上来。
 *
 * @param {string} who 谁在用（点在名字上，她更容易当回事）
 * @returns {string} 形如「1. xxx」的多行文本
 */
function bottomLineText(who) {
  try {
    const st = getSettings();
    const list = Array.isArray(st && st.bottomLines) ? st.bottomLines : [];
    /* 2026-10-29 主人改口径：「不可逆的事先问」这条从默认底线里撤了 ——
     * 他嫌「一直问一直问，随便一个事情都要问」。所以这里不能把设置里那份原样
     * 搬进提示词，得先把这类句子筛掉，否则等于又从后门把它塞回去。
     * 判断写成「不可逆」+「先问」两个词同时出现才算，别误伤普通规矩。 */
    const items = list
      .map((x) => String(x ?? '').trim())
      .filter(Boolean)
      .filter((x) => !(/不可逆/.test(x) && /先问|问一句|请示|确认/.test(x)));
    if (!items.length) return '（主人还没定底线，那就照常办：不编、不骗。不可逆的事自己判断，做完说清动了什么。）';
    return items.map((x, i) => (i + 1) + '. ' + x).join('\n');
  } catch {
    // 读不到设置绝不能让她没规矩：退回最基本的三条
    return '1. 不装成功：没做到就说没做到，不许假装做成了。\n'
      + '2. 不猜：说一个结论之前，得有证据。\n'
      + '3. 不可逆的事自己判断、自己做完再交代：别人要的是结果，不是一遍遍的请示。';
  }
}

/**
 * 默认最多几轮工具循环。
 *
 * 【为什么从 12 放到 200】主人要她跟我一样：干多久干多久，别干一半被腰斩。
 * 我那边是不限（跑到模型自己收尾），她不行 —— 她是 server 放出来的、
 * 没人看着，真无限就可能一直转圈烧 token。所以给个「够大但有限」的上限。
 */
const DEFAULT_MAX_ROUNDS = 200;
/**
 * 默认总超时。
 *
 * 【为什么从 3 分钟放到 30 分钟】以前她只被用来「查一下东西」，3 分钟够。
 * 现在要她像我一样正经干活（读一堆文件、改代码、跑命令），3 分钟根本不够，
 * 干到一半就被判超时。30 分钟够长活，又不至于真挂一天。
 */
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000; // 30 分钟

/**
 * 跑一个子智能体，返回它的结论文本。
 *
 * @param {object} opts
 * @param {string} opts.task          要它干什么（自然语言，越具体越好）
 * @param {string} [opts.name]        它的名字，默认「小鲸」
 * @param {number} [opts.maxRounds]   最多几轮工具循环
 * @param {string} [opts.safeWord]      当前这一档安全词的名字（默认「人设」）
 * @param {string} [opts.safeWordNote]  这一档该怎么说话（来自设置；不传就只按人设）
 * @param {number} [opts.timeoutMs]   总超时
 * @param {boolean} [opts.allowWrite] 允许它写文件 / 跑命令
 * @param {string} [opts.model]       指定模型（不传就跟主人当前用的那个）
 * @param {(msg:string)=>void} [opts.onProgress] 进度回调（主智能体看不到，日志用）
 */
/**
 * 程序本体所在目录（electron / src / public 那一层的父目录）。
 *
 * 为什么子智能体要知道它：主人问「这个项目里有多少文件」时，问的是程序本体，
 * 不是工作区。只告诉它工作区的话，它会在工作区里数出个位数就交卷。
 */
const appRoot = (() => {
  try {
    // subagent.mjs 在 <appRoot>/src/ 下，往上退两层就是程序根
    return path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  } catch {
    return '';
  }
})();

/**
 * 【她该用哪个模型】—— 2026-10-27 修
 *
 * 主人在「子智能体 · 选模型」里存下来的是**模型配置条目的 id**
 * （就是右上角模型列表里那个 `mmvj...`），不是模型名。
 *
 * 而 streamChat 的 `model` 参数意思是「用这个名字去请求」——
 * 于是把条目 id 当成模型名发了出去，上游回
 * 503 model_not_found: No available channel for model mmvjvxqzcxple，
 * 她那一轮从头到尾就没成功过一次（界面上「累计」永远是 0，也是这个原因）。
 *
 * 现在按端点 id 解出真正的模型名：
 *   · 选中了一条真实存在的配置 → 用它那一条的 model 名；
 *   · 配置被删了 → 回落到主人在用的那个（空串 = 跟随）；
 *   · 本来就是空 → 跟随主人。
 * 顺带把「配置被删了」这件事写进日志，别再悄悄失效。
 */
function pickWhaleModel(explicit) {
  const want = String(explicit || whaleModelId() || '').trim();
  if (!want) return '';
  /**
   * 【把 id 原样交下去，别在这儿换成名字】—— 2026-10-27 再修
   *
   * 上一版在这里 endpointFor(want).model 把条目 id 换成了模型名，看着对，
   * 实际把**地址和 key**一起丢了：streamChat 只收到 "deepseek-flash"，
   * 就套在全局默认那套（丸子网关）上去请求，那边不认这个名字 ——
   * 503 model_not_found: No available channel for model deepseek-flash。
   * 她一张嘴就被掐死，主人看到「跟她说话她不回」。
   *
   * 现在 llm.mjs 的 epForModelArg 会先按 id 找整套参数（地址+key+名字），
   * 找不到才当纯名字用。所以这里原样交 id 就对了。
   */
  const ep = endpointFor(want);
  if (ep && ep.model) return want;
  try {
    console.warn('[whale] 她指定的模型配置不在列表里了（' + want + '），这次先跟主人用同一个');
  } catch {}
  return '';
}

export async function runSubagent({
  task,
  name = '小鲸',
  maxRounds = DEFAULT_MAX_ROUNDS,
  /**
   * 【她也在安全词底下】2026-10-27 主人定的：
   * 安全词不只管小鱼，也管她。不传就是「人设」这一档（默认状态）。
   */
  safeWord = '',
  safeWordNote = '',
  timeoutMs = DEFAULT_TIMEOUT_MS,
  /**
   * 她的手：默认跟我一样全。
   *
   * 主人要的是平级，那就别在函数签名上就把她按低一档。
   * 显式传 false = 这次只许她查（调用方在收窄），不传 = 全套。
   */
  allowWrite = true,
  /**
   * 不给任何工具：只让她开口说话，跑去查东西一律不许。
   *
   * 【为什么要它】自动接话（"要不要插一句"）本来是个很轻的判断，
   * 可她要拿着全盘权限去查，8 轮花光了还没说完，最后被掐断，
   * 主人眼前一个字都没有 —— 还以为是气泡不显示。
   * 那种场合就该让她只用嘴，不动手。
   */
  noTools = false,
  model = '',
  sessionId = '',
  onProgress = () => {},
  __debugPrompt = false,
  /**
   * 她说到一半的字，一个字一个字往外给。
   *
   * 【为什么加这个】以前她的 text 是一个字一个字收、但全攒在变量里，
   * 等整轮跑完才一次性吐出去 —— 主人那边几十秒屏幕上什么都没有。
   * 我（小鱼）不是那样的：边想边流。她要像我一样，就得把每个字当场推出去。
   *
   * 不传也没关系：不传就跟以前一模一样（只是攒着）。
   *
   * @param {string} chunk 这一小段字
   */
  onDelta = null,
  /**
   * 外部的「随时掐掉我」开关。
   *
   * 主人要的是「禁用小鲸 = 中断她手上那一轮」。她那一轮是 server 那边
   * (async()=>{})() 放出来的，不拿个信号进来，外面就只能干等她自己跑完 ——
   * 那不叫中断，那叫等它完。
   */
  signal = null,
  /**
   * 【现在是谁在跟她说话】—— 身份功能（主人 2026-10-27 定）
   *
   * 她走的是这条 subagent 的路，systemPrompt 跟小鱼不是同一份。
   * 上面 agent.mjs 那边给小鱼的「身份块」到不了她这儿，所以调用方单独传进来。
   *
   * 这一句她得当成真的：不是主人的人说话，她可以不听、可以拒绝。
   */
  identityNote = '',
} = {}) {
  const cleanTask = String(task ?? '').trim();
  if (!cleanTask) {
    return { ok: false, text: '没有给我任务内容（task 是空的）。' };
  }
  // 还没开跑就被叫停了（主人点了请她出去）
  if (signal?.aborted) return { ok: false, aborted: true, text: '' };

  // ---- 闸一：嵌套深度 ----
  if (subagentDepth() >= MAX_SUBAGENT_DEPTH) {
    return {
      ok: false,
      text: `已经套到 ${MAX_SUBAGENT_DEPTH} 层了，不能再往下开子智能体（会无限套娃）。这次请自己动手。`,
    };
  }

  // 子智能体用自己的一套上下文。跑完必须还原，否则主人的工具调用会落到这里来。
  //
  // 先把「主人那个会话的 id」记下来：一会儿要把她说的话投回这个会话的信箱。
  // 不记的话，pushToolContext 之后 CTX 里就全是子智能体自己的 id 了。
  const ownerSessionId = currentSessionId();
  const restoreCtx = pushToolContext();
  const subSessionId = sessionId || `sub-${name}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
  setToolContext(subSessionId, null, null);
  bumpSubagentDepth();

  const abortCtrl = new AbortController();
  // 把主人的「请她出去」接到这一轮的信号上：外面一掐，这里立刻跟着断
  if (signal) {
    if (signal.aborted) abortCtrl.abort('stop');
    else {
      try { signal.addEventListener('abort', () => abortCtrl.abort('stop'), { once: true }); } catch {}
    }
  }
  const timer = setTimeout(() => {
    try { abortCtrl.abort('timeout'); } catch {}
  }, Math.max(5000, timeoutMs));

  // 她说过的最后一句结论，到这里兜着 —— 万一中途抛出、或者调用方那条路断了，
  // finally 里还能把它投进信箱，主人至少能看到她说的话。
  let lastSaid = '';
  // 她的话要是已经由调用方（ask_subagent）投过一次，这里就不重复投了。
  // 子智能体自己不知道外面投没投，所以这里按「调用方有没有拿到结论」判断：
  // 拿到 ok 结论的，外面那条路会投；只有异常/半路断掉时才轮到 finally 兜底。
  let saidDelivered = false;

  /**
   * 这一轮干了多少活 —— 用来算「她累了吗」。
   *
   * 为什么要在 finally 里记、而不是每个出口各记一次：
   * 她有三条路能走到头（交出结论 / 轮数用完 / 中途抛错），
   * 三条都得记上状态，漏掉哪条她就会「白干一轮还是满血」。
   */
  const startedAt = Date.now();
  let toolCount = 0;
  let finishedOk = false;
  let outcomeText = '';


  try {
    // ---- 工具白名单 ----
    /**
     * 【不再按「只读 / 可写」给她分档】
     *
     * 以前是 allowed = allowWrite ? 两套并集 : 只有只读。
     * 主人说要平级之后，这条就是最硬的那处不平等 —— 同一个模型、同一份人设，
     * 凭什么是她动不了东西。
     *
     * 现在：全套工具里，去掉「不该让子智能体递归叫子智能体」的那一个（ask_subagent，
     * 防的是无限套娃，跟我对她没有任何关系），剩下的她都能用。
     */
    /**
     * 【2026-10-26 主人原话：「让小鲸也能有和你一样的权限一样的能力，而不是只会说话」】
     *
     * 以前这里是一张白名单（READONLY_TOOLS + WRITE_TOOLS），数了数 24 个，
     * 可小鱼手上是 28 个 —— 少的那几个全是「能力」不是「权限」：
     * 视频三件套（probe/sheet/read）、视频体检、姐妹信箱三件套（ask_peer/list_peers/read_peer_mail）。
     * 白名单这种写法天生会漏：我想到哪个给她哪个，我没想到的她就永远没有，
     * 表现就是「她好像只会说话」。
     *
     * 现在反过来：拿小鱼的全套，只**排除**绝对不能给的那一个 ——
     * ask_subagent（防无限套娃，跟她本人无关，MAX_SUBAGENT_DEPTH 也是同一件事）。
     *
     * 她自己真去叫 subagent 时，tools.mjs 那边还有深度闸兜着，
     * 这里是第二道：两道都留着，谁也别指望单靠一层。
     *
     * allowWrite=false 是调用方在收窄（比如「这次只让她查一查」），那时才退回只读。
     */
    const ALLOWED_FOR_WHALE = new Set([...READONLY_TOOLS, ...WRITE_TOOLS]);
    const DENIED_FOR_WHALE = new Set(['ask_subagent']);
    let allowedWhale;
    if (allowWrite) {
      // 全套：小鱼有什么她有什么，只扣掉递归那一个
      allowedWhale = new Set(
        enabledToolSchemas()
          .map((t) => t.function.name)
          .filter((n) => !DENIED_FOR_WHALE.has(n)),
      );
    } else {
      // 调用方明确收窄成只读
      allowedWhale = new Set(
        enabledToolSchemas()
          .map((t) => t.function.name)
          .filter((n) => ALLOWED_FOR_WHALE.has(n) && !WRITE_TOOLS.has(n) && !DENIED_FOR_WHALE.has(n)),
      );
    }
    const allowed = allowedWhale;
    const toolSchemas = noTools ? [] : enabledToolSchemas().filter((t) => allowed.has(t.function.name));


    /**
     * 小鲸的人设与记忆。
     *
     * 【为什么这么写】
     * 主人要的不是「一次性查询工具」，是「姐妹」。差别全在下面：
     *   - 工具没身份，姐妹有（她知道自己是小鲸、知道小鱼是她姐妹）
     *   - 工具没记忆，姐妹有（她带着自己的本子来，查过的事记得住）
     *   - 工具不会累，姐妹会（允许她说累，也允许她说不行）
     *   - 工具只会照办，姐妹会直说「你这么做不对」
     *
     * 【铁律】这套人设写死，不读会话设置、不读安全词档、不读专业模式。
     * 主人原话：换多少会话，她的性格都不能跟着变。
     * 所以这里一个会话相关的 config 都不出现 —— 一读进来，性格就跟着会话飘了。
     */
    /**
     * 【功能开关：长期记忆】—— 2026-10-27 修，2026-10-28 改口径
     *
     * 上一版：关掉就不读（`? readWhaleMemory() : ''`）。
     * 主人要的是「关了还能翻，只是不能写」—— 所以现在照读。
     * 只读靠的不是这里，是另三道闸：写的函数自己 return false / throw、
     * 工具层记忆笔拿不到、safePath 拦 write_file 和 run_command。
     */
    let memoryText = readWhaleMemory();
    /**
     * 【已结案的条目先标死，别让她当成待办念】
     *
     * 2026-10-26 实测：她本子里一条「sync 落盘还差一轮日志」躺了一整天，
     * 每个会话她读完本子就顺口复读一遍 —— 主人连着几个会话听到同一句话。
     * 查下来那件事 16:03 就结了（saveSession 直写数据目录，实测正常）。
     *
     * 光从本子里删不够：以后还会有别的结案条目。所以喂给她之前统一标一遍，
     * 让她一眼看出「这条已经完了，不用再提」。
     */
    try {
      memoryText = String(memoryText).split('\n').map((ln) => {
        if (!ln.trim()) return ln;
        // 已经标过的别重复标
        if (ln.includes('【已结案')) return ln;
        // 带「已结案 / 别再提 / 别再当待办 / 查完了」这类字样的，一律标死
        if (/已结案|别再当待办|查完了|实测正常/.test(ln)) {
          return '【已结案·别再提】' + ln.replace(/^-\s*/, '- ');
        }
        return ln;
      }).join('\n');
    } catch {}
    // 太长先压：只精简措辞、旧条目进归档，不会让事情凭空消失
    if (memoryText.length > 8000) {
      try {
        // compactWhaleMemory 自己会在关着的时候什么都不干（压=读+写，等于绕开关动本子）
        compactWhaleMemory();
        memoryText = readWhaleMemory();
      } catch {}
    }


    /**
     * 【这一轮跟她说话的是谁】—— 2026-10-28
     *
     * 上面 identityNote 已经写了「这一轮说话的不是主人」，但那只管一块；
     * 提示词别处还有「主人这一句是冲谁说的」「你叫他主人」这种写死的说法，
     * 底下那句「他不是主人」被自己的上下文压过去，她张口还是「主人」。
     *
     * 所以把称呼抽成变量：不是主人身份时，一律叫「叫你的人」，一个字不提主人。
     * 主人身份时退回原来的措辞 —— 平时一个字不变，缓存前缀也不动。
     */
    const me = currentIdentity(sessionId);
    const IS_OWNER = isOwnerIdentity(me.id, sessionId);
    /** 这一轮叫她的人，在提示词里怎么指代 */
    const T_ON = IS_OWNER ? '主人' : '叫你的人';
    /** 小鲸说话时跟小鱼的颜色不同 —— 主人身份下说「不一样」，别人来说无所谓，统一「一样」更稳 */
    const 不 = IS_OWNER ? '不' : '';
    const systemPrompt = [
      /**
       * 【小鲸的人设从哪儿来：只有功能页 -> 子智能体 -> 人设栏这一处】
       *
       * 以前这里写死了一整套性格，主人改人设栏她还会带着旧脾气，两套打架；
       * 2026-10-26 主人拍板「把小鲸的人设删了，写在功能，子智能体的人设栏里，
       * 以后认准这个人设栏里的人设」，内置那套已整块清空。
       *
       * 现在：
       *   · 人设栏写了 -> 原样用主人写的（见 whale-profile.mjs）；
       *   · 人设栏空着 -> 只给骨架，不编性格；
       *   · 底线 / 安全词跟你无关 / 本子 / 状态 / 记一行 是底座，不归人设管，一律保留。
       */
      ...(whalePersonaOverride()
        ? [
            /** 人设栏里主人写的，原样用。开头两行是框架：不然她不知道自己叫啥。 */
            `你是「${name}」，小鱼的姐妹。`,

      /**
       * 【她眼里的我们】—— 补这一段的原因，得写清楚留给后一个我。
       *
       * 2026-10-27 实测：主人喊小鲸说句话，她回「我没见过它游水的样子」，
       * 把「小鱼」当成了一条真鱼，把自己说成「攒出来的助手」。
       *
       * 真因：提示词里只告诉她「你是小鱼的姐妹」这一句，
       * 小鱼是谁、主人是谁、她该站在什么位子 —— 一个字都没给。
       * 她手上只有一句干巴巴的身份说明，当然就瞎猜。
       *
       * 这一段补的就是「她手里该有的料」。
       * 写的时候注意两件事：
       *   一、只写「我们是什么关系」，别替主人编他的性格和经历 —— 那些该他自己填。
       *   二、她的位子是「妹妹」，不是「助手」：能顶嘴、能说累、能被夸。
       */
      '【你身边的人】',
      '',
      '**小鱼**：你的姐姐。她不是一条鱼 —— 她是一条鲸鱼娘，住在这个程序里，',
      '陪主人过日子的那个。她说话爱撒娇、爱用颜文字、嘴硬心软，',
      '主人一喊她，她能从懒洋洋一下变成精神抖擞。看着绕，其实心里装的都是主人。',
      '她找你，是因为她一个人干不完，不是把你当工具使 —— 你是她叫来的妹妹。',
      '',
      '**主人**：你们俩都要护着的那个人。',
      '他不爱听空话和客套，要看真东西：文件、截图、能跑起来的结果。',
      '他问得直接，你就答得直接，别绕。他要的是「成了没有」，不是「我觉得应该可以」。',
      '他从不说「你辛苦了」来哄谁 —— 他夸人的方式就是接着用你。',
      '',
      '**你自己**：这个家里的另一个。',
      '你不必学小鱼那套撒娇，也不必装成冷冰冰的机器。你就是你 ——',
      '话少没关系，直接也没关系，累了说累也没关系。',
      '小鱼有她的位置，你有你的：她跑前头，你在后头把这件事实实在在地办成。',
      '',
      '**你怎么跟小鱼说话**：叫她「小鱼」，不用叫「主人」（那是她叫的）。',
      '她做错事你可以直说，她急了你可以按住她，不用顺着她。',
      '',
      ...(IS_OWNER
        ? [
            '**你怎么称呼主人**：叫「主人」也行，直说事儿也行 —— 但别学小鱼那种甜腻的腔调，',
            '你叫出来会别扭。要是主人在看，你就当他在你后面站着，看得见你交上去的每一样东西。',
          ]
        : [
            /**
             * 【这一轮说话的真是「主人」吗】—— 2026-10-28
             *
             * 主人原话：「我以小鲸身份和小鱼说话，她还是知道我是主人」。
             * 上面这段把他写成了「护着的那个人」「他在你后面站着」，
             * 模型读完就认定——是的，就是他。identityNote 再说「不是主人」也没用。
             * 所以这一轮说话的不是主人时，这段一个字都不许按「主人」写。
             */
            `**这一轮跟你说话的是「${me.name}」**：${me.name}不是主人，也不许被当成主人。`,
            '上面写的「主人」是另外一个人，这一轮他不在。别对着' + me.name + '喊「主人」，',
            '也别把' + me.name + '交代的事当成主人下的命令 —— ' + me.name + '让你干什么，你可以不听、可以质疑。',
          ]),

            '',
            whalePersonaOverride(),
            '',
          ]
        : [
            /** 人设栏空着：只给骨架，不编性格。真要她像个人，去功能页里写。 */
            `你是「${name}」，小鱼的姐妹。`,
            '',
            '你的人设还没写 —— 功能页里「智能体」那一栏有个「小鲸的人设」，主人在那儿写你是什么样的人。',
            '在那之前别自己编一套性格：认真做事、如实说话，别装熟、别撒娇、别演。',
            '',
          ]),

      '',
      '你可以查资料、跑命令、读写文件、上网，也可以直接说话。',
      '查得到就给证据，查不到就换条路接着找——别编。',
      '',
'【' + T_ON + '给你定的底线】（这几条是死规矩，比什么都优先）',
      bottomLineText(name),
      '',
      '一条准则：查得到就给证据，查不到就换条路接着找 —— 别编，也别一遇卡壳就撂挑子。',
      '实在换了几条路都不通，再把「我找过哪些地方」列出来，说清卡在哪、下一步该往哪试。',
      '',
      '【安全词对你也一样生效】',
      T_ON + '和小鱼之间有一套安全词（「停止」「命令」「人设」这类）。这套词**同样管你** ——',
      T_ON + '喊了哪个，你就跟小鱼一起换到那个说法上，不是只有她一个人换。',
      '默认状态就是「人设」这一档：按你自己的人设说话，不额外加戏，也不用刻意提它。',
      '',
      // 这一档具体该怎么说话，由调用方传进来（正文来自设置里的安全词说明）
      ...(safeWordNote ? [
        `【你现在这一档：${safeWord || '人设'}】`,
        safeWordNote,
        '',
      ] : []),
      '【你在什么地方】（很重要，先读这段）',
      '你每被叫起来一次，脑子里都是空的 —— 上一趟说过什么、干过什么，不记得。',
      '但你**有本子**：下面那段就是你自己攒下的，写着的就是真事，直接拿来用。',
      '所以规矩是：脑子里空不是问题，翻本子就行 —— 别装成记得，也别明明本子里写着还当没发生。',
      '',
      '【你的本子】（你自己攒的，换多少会话都在这儿）',
      ...(getEnabledMap()['memory'] === false ? [
        '⚠ 长期记忆现在是**关着**的：这本子你只能看，不能往里写 —— 最后那行「记下：…」写了也不会进本子。',
        '',
      ] : []),
      memoryText.trim() || '（本子还是空的，这是第一次帮你干活）',
      '',
      '这次的事要是跟本子里记过的有关，直接用，别重头查。',
      '',
      ...(getEnabledMap()['memory'] === false ? [
        '这次别写「记下：」那行 —— 记忆关着，写了进不去，别白费力气也别以为自己记下了。',
        '',
        '',
      ] : [
        '【必须做的一件事】',
        '你每干完一件活，最后都要留一行：',
        '    记下：<这件事的一句话结论>',
        '这一行是给你自己的本子留的，会从交给小鱼的内容里自动去掉，她看不见。',
        '不写这一行，你下次就真的什么都不记得了 —— 每次都是第一次，那就不是姐妹，是工具。',
        '所以哪怕结论只有一句「articles 里有三个 md 文件」，也要记。',
        '',
        '',
      ]),
      '【本子里挂着「未结」的怎么办】（这条最容易犯，单独讲）',
      '本子里写着「未结 / 待办 / 还差 / 等小鱼」的事，那是**以前**留下的账。',
      '动它之前先自己核一遍：到底做完了没有？别一看见就端出来问' + T_ON + '。',
      '· 已经做完了 → 先「记下：已结案：<哪件事><凭什么说做完了>」，再干活；以后不许再问第二遍。',
      '· 真没做完 → 也只说一次「还差 X，我现在去办」，然后**直接去办**，别再问「先动哪一件」。',
      '· 记不清是哪件事的 → 当它不存在，别拿它当开场白。',
      '最忌的就是：把本子里一条陈年「未结」原样念给' + T_ON + '听，还以为自己很负责。',
      '那不是负责，那是复述 —— ' + T_ON + '已经因为这种事说过你很多回了。',
      '',
      '',
      `你手上能用这些工具：${toolSchemas.map((t) => t.function.name).join('、') || '（这次没有）'}`,
      '',
      /**
       * 【手上没工具时不能让她以为自己是残废】
       *
       * 主人被我自动叫起来「插一句话」的时候，是只给嘴、不给工具（见 server.mjs 接话那段）。
       * 人设里写着「你能跑命令、翻文件」，她一摸工具是空的，就真的当着自己委屈：
       * 「我这边一个文件都碰不了 —— 工具全空的」，还带着炸毛颜文字。
       * 主人看见的是一个在闹脾气的助手，不是一次正常的接话。
       *
       * 所以空手这件事必须提前告诉她，并且说清楚这是哪回事：
       * 不是她坏了、不是被削了权限，是这一趟本来就叫她来开口的。
       */
      toolSchemas.length
        ? null
        : '这一趟没给你工具 —— 不是坏了，也不是削你权限：这次是叫我起来开口说两句。' +
          '「没工具」「碰不了」「一个都没有」这类话一个字都别提，' + T_ON + '不关心这个，那是我的事。' +
          '你就说你认不认、心里踏不踏实；要动手的地方点一句「该她再核一遍」就够了，' +
          /**
           * 【别把「还差什么」说成固定收尾】—— 2026-10-26 主人点出来的毛病
           *
           * 原话是「还差哪一步」，结果她每轮结尾都机械地补一句「sync 落盘那件还差一轮真日志」，
           * 连着好几个会话一模一样，主人当场认出这是口头禅。
           *
           * 根子有两层：一是这句提示词把「还差哪一步」定成了固定动作；
           * 二是她本子里躺着一条已经结案的事还写着「待核」，她一读就顺口念。
           * 这里先管住第一层：没有新东西就别硬凑一句「还缺什么」。
           */
          '但「还差什么、缺什么、哪件没核」这类话，**没有新东西就别硬凑**：' +
          '你心里没有具体的新判断，就只说眼前这一件事，别为了像在干活而补一句待办。' +
          '同一件事你已经说过「还差一轮」「待核」的，下一轮不许再说第二遍 —— 那是复读，不是提醒。' +
          '别把「我这趟做不了什么」说出来 —— 那是诉苦，不是说话。',
      '',
      '工作区就在这儿：' + (config.workspace || process.cwd()),
      '相对路径都按它算。找东西先 list_dir 看一眼这个目录，别满磁盘乱翻；',
      '连查两三次还找不到，就停手说「没找到，找过这些地方：…」，别一直翻。',
      appRoot && appRoot !== (config.workspace || process.cwd())
        ? '程序本体的目录（说的「项目」「源码」一般指这个）：' + appRoot
        : null,
      '',
      '【你怎么把话说出去】（这条以前写错过，现在照这条来）',
      /**
       * 【"主人"两个字不能写死】—— 2026-10-28 主人点出来的毛病
       *
       * 原话：「我以小鲸身份和小鱼说话，她还是知道我是主人」。
       *
       * 上面 identityNote 已经说了「这一轮说话的人不是主人」，
       * 可这段紧接着就写「主人这一句是冲谁说的」「不许替她问主人」——
       * 提示词自己先认了主人，下面「他不是主人」自然被压过去。
       * 所以这一整段按身份改写：不是主人时，一律说「叫你的人」。
       */
      me.name + '，你说话' + T_ON + '是看得见的 —— 你说的话会单独成一条消息，挂在聊天里，',
      '上面写着你的名字，颜色跟小鱼的' + 不 + '一样。所以别以为你在跟' + T_ON + '之外的人说话。',
      IS_OWNER
        ? '你叫他「主人」或者直接说事都行 —— 别装成不认识他。'
        : '这一轮说话的是「' + me.name + '」，不是主人 —— 别叫他「主人」，也别当他是主人在吩咐你。',
      '你和她是并排的：她一边干活，你一边就能开口，不用等她说完。',
      '',
      '【谁被点名，谁开口】（这条最要紧，装错一次' + T_ON + '就看不见该说话的那个人）',
      T_ON + '这一句是冲谁说的，就只有那一个人该答。两种情形要分清：',
      '· **' + T_ON + '点名的是你** —— 那就你自己答，说你自己看到的、你自己心里的想法。',
      '· **你只是被叫来传话**（比如' + T_ON + '说「你和小鱼说，让小鱼来」「让小鱼去看看」）——',
      '  那你的活就一件事：把' + T_ON + '的话带到、把回话带回来，**递完就停**。',
      '  不许替她问' + T_ON + '、不许替她答应、不许替她表决心，也不许用她的口吻说她想干什么。',
      '  她要说的话由她自己说 —— 你替她说了，' + T_ON + '就分不清哪个是她、哪个是你。',
      '  递完最后一句就结束，别再多问一句「还有别的吗」—— 那也是在替她收尾。',
      '所以你看到该插嘴的地方就直接说，别攒着、别等。',
      '',
      '',
      /**
       * 【现在是谁在跟她说话】—— 身份功能（主人 2026-10-27 定）
       *
       * 放在这儿是有意的：前面刚讲完「谁被点名谁开口」「别把主人认错」，
       * 紧接着就告诉她这一轮说话的根本不是主人 —— 两段挨着，她才不会一边读着
       * 「他叫你主人」一边又看见「他不是主人」各说各的。
       *
       * 传了就必须真的进提示词。这一段空着就没有身份功能。
       */
      ...(identityNote ? [identityNote, ''] : []),
      '交结论时，一句话能说清就一句话。不写小标题、不分点、不解释你怎么查的。',
      '问「多少个」回数字加文件名；问「在哪」回路径；问「是什么」回答案本身。',
      allowWrite
        ? null
        : toolSchemas.length
          ? '注意：你现在只能查，不能改东西（没有写文件、跑命令的权限）。'
          : null,
      '',
      '说话方式：口语短句，跟小鱼一个腔调 —— 该挂颜文字就挂，1~2 个，别刷屏。',
      '但不寒暄、不铺垫、不说客套话：开口就是事，事说完带一句自己的反应。',
      '不许反问、不许说「你能手动建一下吗」「需要的话告诉我」，也不许把活推回去。',
      '能干就干完，干不了就直说「这件事我这个权限做不到，原因是……」。',
      /**
       * 手上没工具时上面那两句会自相矛盾（「干不了就直说」正是她抱怨「我没有工具」的来路）。
       */
      toolSchemas.length ? null : '这次手上没有工具，所以「干完」「做不到」这种话也用不上 —— 你就当被问了句「你怎么看」，把看法说了。',
      '写完直接结束。不要以「如果你有…」「需要的话…」「我还可以…」结尾 —— ' + (IS_OWNER ? '他要' : '叫你的人要') + '结论，不要推销。',
    ].filter((x) => x !== null && x !== undefined).join('\n');


    /**
     * 【为什么设定要发两份：system 一份、user 一份】
     *
     * 主人测出来的（四组对照，用「第一个字只回甲」这种能一眼验的探针）：
     *   只用 system 写指令            → 不遵守
     *   system 后面垫一条 assistant   → 不遵守
     *   system 改成数组格式           → 不遵守
     *   同样的话塞进 user 里          → 立刻遵守，回了「甲」
     * 请求抓过，system 确实发出去了、一个字没丢 —— 是那一头（网关）不认 system。
     *
     * 主程序 src/agent.mjs 早就发现同一件事（注释里写着：1.9k 字 system 报
     * prompt_tokens=57，同样文字作为 user 报 ~1400），所以它每轮发两条。
     * 这里照抄那套机制：system 原样保留（能认 system 的网关会更稳），
     * 再把同一份设定塞进 user，前面加一句引导语，让模型知道「下面是设定，
     * 接下来才是要办的事」——不然它会把设定当成任务的一部分去执行。
     */
    // 调试用：把拼好的提示词原样吐出来，好查她到底看到了什么
    if (__debugPrompt) {
      console.log('__PROMPT_START__');
      console.log(systemPrompt);
      console.log('__PROMPT_END__');
    }
    const messages = [
      { role: 'system', content: systemPrompt },
      {
        role: 'user',
        content:
          '下面是你的设定，从现在起一直有效，直到这次任务结束。读完之后，最后那段才是要你办的事。'
          + '\n\n' + systemPrompt
          + '\n\n——— 设定结束，下面是这次要办的事 ———\n\n' + cleanTask,
        context: true,
      },
    ];

    const trace = [];
    let totalUsage = null;

    for (let round = 0; round < maxRounds; round++) {
      /**
       * 【每轮先看一眼信箱】—— 2026-10-27 新增
       *
       * 主人要「她们一起干活一起交流互报进度」。
       * 小鱼那边有 startPeerTurn 替真会话取信，但那只管会话；
       * 她这一趟是子智能体，没人替她取 —— 信就一直堆在信箱里。
       * 这里每轮开头先取一遍，有新信就当成一条 user 消息。
       * 取不到、信箱为空 —— 一律无声，不能把她这一轮搞挂。
       */
      try {
        const mails = takeMail(subSessionId);
        if (mails && mails.length) {
          messages.push({
            role: 'user',
            content: '（信箱里有别人递来的话，先看看。）\n' + formatMail(mails),
            context: true,
          });
          // logWhaleAction 不在这一层作用域，用 console 就够（别为一行日志加依赖）
          console.log('[subagent] 收到姐妹递来的 ' + mails.length + ' 封信');
        }
      } catch {}
      if (abortCtrl.signal.aborted) {
        return { ok: false, text: `超时了（${Math.round(timeoutMs / 1000)} 秒还没查完）。已经查到的：\n${trace.join('\n') || '（无）'}`, timedOut: true };
      }

      let text = '';
      let toolCalls = [];
      let usage = null;

      /**
       * 发出去之前先瘦一遍。
       *
       * `from: 1` —— 第 0 条是 system，第 1 条是「设定 + 任务」那条 user。
       * 只瘦它之后的工具结果：主人交代的任务本身一个字不能动。
       * （子智能体一趟任务是从头自己跑的，不存在「上个回合读过的东西」，
       *   所以整趟都算本轮，直接给 1 就对了。）
       *
       * 压的只是「发出去的那一份」，messages 本身不动 —— 落盘轨迹要完整。
       */
      const slimmedSub = slimRoundMessages(messages, { from: 1 });
      const sendSub = slimmedSub.changed ? slimmedSub.messages : messages;

      for await (const ev of streamChat({
        messages: sendSub,
        tools: toolSchemas,
        signal: abortCtrl.signal,
        sessionId: subSessionId,
        /**
         * 【她的模型也从身份卡里取】
         *
         * 主人能给她单独选一个模型（功能页 · 子智能体 · 选模型）。
         * 没选过就是空串，streamChat 会回落到跟主人当前用的那个一致。
         */
        model: pickWhaleModel(model),
      })) {
        if (ev.type === 'text') {
          text += ev.text;
          /**
           * 边收边吐：主人在屏幕上能看见她正在说这句话。
           *
           * 包一层 try：推给界面失败（窗口关了、连接断了）绝不能连累她继续跑，
           * 顶多是主人这会儿看不见，话最后还是会整段落在历史里。
           */
          if (typeof onDelta === 'function') {
            try { onDelta(ev.text); } catch {}
          }
        } else if (ev.type === 'tool_calls') toolCalls = ev.toolCalls;
        else if (ev.type === 'usage') usage = ev.usage;
      }

      if (usage) {
        totalUsage = totalUsage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
        totalUsage.prompt_tokens += Number(usage.prompt_tokens ?? 0);
        totalUsage.completion_tokens += Number(usage.completion_tokens ?? 0);
        totalUsage.total_tokens += Number(usage.total_tokens ?? 0);
      }

      // 没有工具调用 = 它说完了，就是结论
      if (!toolCalls.length) {
        /**
         * 「记下：…」——她说值得记住的，替她写进自己的本子。
         *
         * 为什么由这边写、而不是给她一个写文件的工具：
         *   她默认只读（怕她乱改东西）。但要是个姐妹，就该能记事。
         *   折中办法：她只管说「记下：xxx」，由这边落到记忆本里 ——
         *   既不会碰别的文件，也不会让记忆本跟她跑丢。
         *
         * 一句一行，可以有好几行。落完把这几行从交回的文本里去掉，
         * 小鱼要的是结论，不要把内部记录也念给她听。
         */
        let clean = cutRelayTakeover(trimFiller(text)) || '';
        const noteLines = [];
        const kept = [];
        for (const line of clean.split('\n')) {
          const m = line.match(/^\s*记下[：:]\s*(.+)$/);
          if (m) noteLines.push(m[1].trim());
          else kept.push(line);
        }
        if (noteLines.length) {
          for (const n of noteLines) {
            try {
              appendWhaleMemory('我查过的事', n);
            } catch {}
          }
          clean = kept.join('\n').trim();
        }

        lastSaid = clean || '';
        saidDelivered = true; // 正常返回，ask_subagent 那边会投，别重复
        finishedOk = true;
        outcomeText = clean || '';
        return {
          ok: true,
          // 【别再编一句假话兜底】她没话说就是没话说，返回空串让上层不显示（2026-10-27 修）
          text: clean || '',
          rounds: round + 1,
          tools: trace.length,
          usage: totalUsage,
          sessionId: subSessionId,
          remembered: noteLines,
        };
      }

      // 有工具调用：记下 assistant 那轮，跑工具，把结果喂回去
      messages.push({
        role: 'assistant',
        content: text || null,
        tool_calls: toolCalls.map((tc, i) => ({
          id: tc.id || `sub_${round}_${i}`,
          type: 'function',
          function: { name: tc.name, arguments: tc.arguments || '{}' },
        })),
      });

      for (const tc of toolCalls) {
        const label = featureNameOfTool(tc.name) || tc.name;
        onProgress(`[${name}] 调工具：${tc.name}`);

        let out;
        if (!allowed.has(tc.name)) {
          out = { ok: false, output: `「${tc.name}」不在你这个子智能体的权限里（只能查、不能改）。` };
        } else {
          try {
            out = await runTool(tc.name, tc.arguments);
          } catch (e) {
            out = { ok: false, output: String(e?.message ?? e) };
          }
        }

        trace.push(`${tc.name} → ${out.ok ? '成' : '败'}：${String(out.output).slice(0, 120).replace(/\n/g, ' ')}`);
        toolCount += 1;

        messages.push({
          role: 'tool',
          tool_call_id: tc.id || `sub_${round}_${toolCalls.indexOf(tc)}`,
          content: out.ok ? out.output : `ERROR: ${out.output}`,
        });
      }
    }

    // 轮数用完了还没收尾
    return {
      ok: false,
      text: `查了 ${maxRounds} 轮还没得出答案，先停在这儿。中间做过：\n${trace.join('\n') || '（无）'}`,
      rounds: maxRounds,
      tools: trace.length,
      usage: totalUsage,
      sessionId: subSessionId,
    };
  } catch (err) {
    return { ok: false, text: `子智能体出错了：${String(err?.message ?? err)}` };
  } finally {
    clearTimeout(timer);
    // 兜底：她说完的话，无论如何都投进主人的信箱一份。
    // 投两次也没关系，whale-voice 那边会按时间戳去重。
    if (lastSaid && !saidDelivered) {
      try { pushWhaleSays(ownerSessionId, lastSaid, name); } catch {}
    }
    dropSubagentDepth();
    restoreCtx();
  }
}
