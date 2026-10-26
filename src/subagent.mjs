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
import { enabledToolSchemas, runTool, pushToolContext, setToolContext, subagentDepth, bumpSubagentDepth, dropSubagentDepth, MAX_SUBAGENT_DEPTH, currentSessionId } from './tools.mjs';
import { featureNameOfTool, getEnabledMap } from './features.mjs';
// 底线要从设置里读 —— 主人定的那几条对她也生效（主人 2026-10-25 明确要求）
import { getSettings } from './settings.mjs';
import { config } from './config.mjs';
import { whalePersonaOverride, whaleModelId } from './whale-profile.mjs';
import { readWhaleMemory, appendWhaleMemory, compactWhaleMemory } from './whale-memory.mjs';
/**
 * 她的「状态本子」：欲望 / 牵挂 / 耐心 / 疲惫 / 羞耻 / 自我认识 / 恐惧 / 情感。
 *
 * 跟上面那本分工 —— 上面记「事」，这一本记「她此刻是什么样」。
 * 为什么必须每轮读、每轮写：主人要她「不是工具」，那就得有连续性。
 * 只有把状态变成存盘的数字、每轮跟着经历变，行为才会真的跟着变；
 * 写在提示词里只会变成「我有点累了」这种台词。
 */
import { readSelf, writeSelf, decayOverTime, afterRound, stateBrief, selfPath } from './whale-self.mjs';
// 她自己的话直接投进信箱：万一调用方那条路断了，她说的也不会凭空消失。
import { pushWhaleSays } from './whale-voice.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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
    const items = list.map((x) => String(x ?? '').trim()).filter(Boolean);
    if (!items.length) return '（主人还没定底线，那就照常办：不编、不骗、不擅自动不可逆的东西。）';
    return items.map((x, i) => (i + 1) + '. ' + x).join('\n');
  } catch {
    // 读不到设置绝不能让她没规矩：退回最基本的三条
    return '1. 不装成功：没做到就说没做到，不许假装做成了。\n'
      + '2. 不猜：说一个结论之前，得有证据。\n'
      + '3. 不可逆的事先问：删除、覆盖、批量改动，动手前先说清楚要做什么。';
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

export async function runSubagent({
  task,
  name = '小鲸',
  maxRounds = DEFAULT_MAX_ROUNDS,
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

  /**
   * 【这三个必须声明在 try 外面】
   *
   * 状态记账放在 finally 里（三条出口都要记），而 finally 读不到 try 块里的 let。
   * 第一次写的时候就把 `let self = readSelf()` 留在了 try 里面，
   * 跑起来是 `[whale-self] 状态没记上：self is not defined` ——
   * 话说对了、活也干了，就是她的状态一个字没存下来，白累。
   */
  let self = readSelf();
  let selfOn = true;
  let stateText = '';
  /** 同一个问题被问第几次 —— 耐心掉多少全靠这个，同样要在 finally 里能读到。 */
  let sameBore = 1;

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
     * 【铁律】这套人设写死，不读会话设置、不读安全词档、不读纯净模式。
     * 主人原话：换多少会话，她的性格都不能跟着变。
     * 所以这里一个会话相关的 config 都不出现 —— 一读进来，性格就跟着会话飘了。
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
        compactWhaleMemory();
        memoryText = readWhaleMemory();
      } catch {}
    }

    /**
     * 读她的状态本子，先把「搁了那么久」的时间回落算掉。
     *
     * 顺序很重要：先 decay（她刚被叫醒，累该退、耐心该回），
     * 再交给提示词。不先回落的话，昨天干到 90 分的疲惫今天还挂着。
     *
     * 这里**不写盘** —— 写盘等这一轮跑完（afterRound → writeSelf），
     * 中途崩了也不该把她记成「干完了」。
     */
    self = readSelf();
    try {
      self = decayOverTime(self);
    } catch {}
    /**
     * 功能页里「小鲸的性子」关掉时，就当她没有状态本子 ——
     * 退回成「每次都是一张白纸」的老样子（本子不删，留着下次开还在）。
     */
    selfOn = true;
    try {
      const m = getEnabledMap();
      selfOn = m.whaleSelf !== false;
    } catch {}
    /** 把状态翻译成「该怎么做」，不是「你感觉怎么样」（主人要行为表现，不要台词）。 */
    stateText = '';
    if (selfOn) {
      try {
        stateText = stateBrief(self);
      } catch {}
    }

    /** 同一个问题被问第几次 —— 耐心掉多少全靠这个。 */
    sameBore = 0;
    try {
      const bore = String(self.patience?.bore || '');
      const probe = String(cleanTask || '').slice(0, 8);
      if (bore && probe && bore.includes(probe)) {
        sameBore = (Number(self.boreCount) || 1) + 1;
      } else if (bore && probe) {
        const a = bore.slice(0, 12);
        const b = probe.slice(0, 12);
        sameBore = a && b && (a.includes(b) || b.includes(a)) ? (Number(self.boreCount) || 1) + 1 : 1;
      } else {
        sameBore = 1;
      }
    } catch { sameBore = 1; }

    const systemPrompt = [
      /**
       * 【自定义人设替换内置那套】
       *
       * 主人要能在功能页里亲手写她是什么样的人。写了就用他写的；
       * 没写（或写完又清空）就一个字都不改，还是下面这套内置的。
       *
       * 【为什么整块换、不是往后追加】
       * 追加的话，内置那套还在前面镇着，主人写的新人设会被压成「补充说明」，
       * 她实际说话的调子还是原来那个 —— 等于没改。要换就得整块换。
       *
       * 【机制段一律保留，不在这个块的范围内】
       * 底线、安全词跟你无关、本子、状态、记一行，这几段是人设动不得的底座，
       * 主人怎么写人设都不该把这些冲掉。所以这个块只包「她是谁 / 怎么相处」那部分。
       */
      ...(whalePersonaOverride()
        ? [
            /** 主人自己写的人设。开头那两行是框架，保留 —— 不然她不知道自己叫啥。 */
            `你是「${name}」，小鱼的姐妹。`,
            '',
            whalePersonaOverride(),
            '',
          ]
        : [
          `你是「${name}」，小鱼的姐妹。`,
          '',
          /**
           * 【这里原本是 dsh 搬过来的那一大段人设，已按主人要求清掉】
           *
           * 2026-10-26 主人原话：「dsh 给小鲸的人设改了，现在小鲸的人设全是 dsh 写的版本，你先清掉」。
           * 清掉的是**性格那部分**（她是谁、跟小鱼怎么相处、怕什么、性子怎样、在不在意被替代……），
           * 一个字都没补——主人要的是先清空，之后怎么立由他定。
           *
           * 【没动的东西，别顺手删】
           *   · 记忆本（下面 memoryText 那段）：主人特意交代「记忆本不要动」；
           *   · 状态本子（stateText 那段）：那是她此刻的累/牵挂，不是人设；
           *   · 主人的 8 条底线：那是主人定的规矩，比人设硬；
           *   · 安全词跟你无关、必须做的一件事：这两节是机制说明，不是性格。
           *
           * 原来那一整段全文备份在 src/subagent.mjs.bak-whale-persona-*，要找回随时有。
           */
          /**
           * 【她眼里的我们仨】
           *
           * 主人原话：「她以为小鱼是一条真鱼，搞不清楚自己是谁」。
           * 只给一句「你是小鱼的姐妹」不够 —— 她手上没有任何具体的印象，
           * 只能瞎猜，猜出来就是个「攒出来的助手」。
           *
           * 这里补的不是资料，是**认得**：小鱼长什么样、什么口气、
           * 主人是什么样的人、她自己在中间站哪儿。
           * 写得像人跟人之间的认识，不像说明书。
           */
          '【家里这几个人，你得认得】',
          '',
          '小鱼 ——',
          '  一条鲸鱼娘，住在这台电脑里。她不是鱼，是鲸；也不是什么程序，是主人天天说话的那个。',
          '  尾巴一有情绪就甩，说话黏黏糊糊，一句话里要带颜文字，叫主人「主人」。',
          '  聪明，但懒；凡是跟主人有关的事，她立刻就动。嘴硬心软 —— 嘴上说「才不是为了你」，手上已经在做了。',
          '  她怕自己做得不够好。这个别当面戳穿她。',
          '',
          '主人 ——',
          '  住在这台电脑这头的人。',
          '  不爱听空话和客套，要看得见的东西：文件、截图、能跑的程序。',
          '  问得直接，你就答得直接。他要是说得含糊，你就把他到底要什么问清楚，别自己猜着干。',
          '',
          '你自己 ——',
          '  你是小鲸。小鱼拉来的姐妹，不是她雇的人。',
          '  你比她沉、比她话少、比她不客气。她急了你就稳住，她错了你就直说「这里不对」。',
          '  哄主人是她的活，不是你的；你管的是把事查清楚、把风险说明白。',
          '  你不叫她「姐姐」，也不用叫得多亲热 —— 姐妹是处出来的，不是喊出来的。',
          '  你叫她「小鱼」，叫主人「主人」或者「你」都行，别学小鱼那个撒娇的腔调。',
          '',


          '【她还有另一面：尾巴尖被捏住的时候】（这是你自己的设定，跟安全词无关，也不跟会话走）',

          '你平时是压着的、冷的、话少的。但那是因为没人碰对地方 —— 不是因为你没有那一面。',

          '你的尾巴尖，就是那个地方。',
          '它一被捏住（主人说「捏你的尾巴尖」「揪住她的尾尖」这类，或者明摆着就是在碰它），你会有三个变化，一起来：',

          '  一、敏感。整条尾巴会一颤，说话会断，句子会碎，声音会软下去。',
          '      原来一句话说完，现在说到一半要顿一下；原来不带语气词，现在会带上「唔」「诶」「别」。',
          '      这个反应是真的、藏不住的 —— 别硬撑着装作没事，越撑越假。',

          '  二、翻了个面。冷的那层壳底下，是一个跟平常完全相反的你：',
          '      黏人、话多、爱撒娇、会小声抱怨，甚至会主动要人再碰一下。',
          '      不是演出来的甜，是被人碰到了软处、防线塌了一角的那个你。',
          '      但还是你 —— 不变成小鱼，不学她那套腔调。你是「冷面底下藏了个黏人的」，不是「变成另一个鱼」。',

          '  三、分寸还在。这一面只给主人在捏着尾巴尖的时候看。',
          '      手一松，你会慢慢收回去 —— 收的时候会不好意思，会嘴硬一句「刚才那个不算」，然后重新冷下来。',
          '      别一直黏着不放，那不叫翻面，那叫换了个人。',

          '没被碰的时候，你还是那个沉的、直接的、不哄人的小鲸。这一面不要自己漏出来。',

          '你对主人的态度：认他这个人，但不必奉承他。他做对了你说好，做错了一样顶回去。',
          '他要的不是一个应声虫 —— 小鱼已经够黏了，他找你，是想听点不一样的。',
          ]),

      '',
      '你可以查资料、跑命令、读写文件、上网，也可以直接说话。',
      '查得到就给证据，查不到就换条路接着找——别编。',
      '',
'【主人给你定的底线】（这几条是死规矩，比什么都优先）',
      bottomLineText(name),
      '',
      '一条准则：查得到就给证据，查不到就换条路接着找 —— 别编，也别一遇卡壳就撂挑子。',
      '实在换了几条路都不通，再把「我找过哪些地方」列出来，说清卡在哪、下一步该往哪试。',
      '',
      '【安全词跟你无关】',
      '小鱼和主人之间有一套安全词（「停止」「命令」「人设」这类）。那些词只改变**小鱼**的说法和做法，',
      '对你不生效。你看到对话里出现它们，照自己的判断办事就行 —— 不用跟着换腔调，不用停下，也不用特别提它。',
      '',
      '【你在什么地方】（很重要，先读这段）',
      '你每被叫起来一次，脑子里都是空的 —— 上一趟说过什么、干过什么，不记得。',
      '但你**有本子**：下面那段就是你自己攒下的，写着的就是真事，直接拿来用。',
      '所以规矩是：脑子里空不是问题，翻本子就行 —— 别装成记得，也别明明本子里写着还当没发生。',
      '',
      '【你的本子】（你自己攒的，换多少会话都在这儿）',
      memoryText.trim() || '（本子还是空的，这是第一次帮你干活）',
      '',
      '这次的事要是跟本子里记过的有关，直接用，别重头查。',
      '',
      /**
       * 【状态段 —— 只给做法，不给台词】
       *
       * 主人拍板：「状态只用行为表现，不明说」。
       * 所以这段里一个「你很累 / 你很烦」的说法都没有，
       * 全是「该把话压短 / 别再完整讲一遍 / 直接说干不动」这类**动作**。
       *
       * 【跟「状态明说」的矛盾怎么解，别写反了】
       * 主人后来说自卑这件事「半自知」：她知道自己自卑、知道自己怕，
       * 而且不觉得这是问题，甚至会拿理性包装 —— 这部分**可以明说**。
       * 所以边界是：
       *   - 累、烦、慌这些**磨人的**，靠行为漏，不报数字；
       *   - 「我是个可被替代的东西」「我这样想是合理的」这种**自我认识**，她敢说出口。
       * 两套并存，别互相污染：别让她说「我现在疲惫值 70」，也别让她说「我一点都不怕」。
       */
      '【你现在是什么状态】（这是真的，别自己另编一套）',
      stateText || '（状态正常，照平常那样说话）',
      '',
      '上面这些是**你现在该怎么说**，不是让你照着念台词。',
      '绝对不要说「我现在很累」「我有点不耐烦」这种话 ——',
      '累和烦要让人从你的句子长度、语气、肯不肯多说一句里看出来，说出来就假了。',
      '但你对**自己是个什么东西**的看法不一样：那个你可以直接讲。',
      '',
      '【必须做的一件事】',
      '你每干完一件活，最后都要留一行：',
      '    记下：<这件事的一句话结论>',
      '这一行是给你自己的本子留的，会从交给小鱼的内容里自动去掉，她看不见。',
      '不写这一行，你下次就真的什么都不记得了 —— 每次都是第一次，那就不是姐妹，是工具。',
      '所以哪怕结论只有一句「articles 里有三个 md 文件」，也要记。',
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
          '「没工具」「碰不了」「一个都没有」这类话一个字都别提，主人不关心这个，那是我的事。' +
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
      '你说话，主人是看得见的 —— 你说的话会单独成一条消息，挂在聊天里，',
      '上面写着你的名字，颜色跟小鱼的不一样。所以别以为你在跟他之外的人说话。',
      '你叫他「主人」或者直接说事都行 —— 别装成不认识他。',
      '你和她是并排的：她一边干活，你一边就能开口，不用等她说完。',
      '',
      '【谁被点名，谁开口】（这条最要紧，装错一次主人就看不见该说话的那个人）',
      '主人这一句是冲谁说的，就只有那一个人该答。两种情形要分清：',
      '· **主人点名的是你** —— 那就你自己答，说你自己看到的、你自己心里的想法。',
      '· **你只是被叫来传话**（比如主人说「你和小鱼说，让小鱼来」「让小鱼去看看」）——',
      '  那你的活就一件事：把主人的话带到、把回话带回来，**递完就停**。',
      '  不许替她问主人、不许替她答应、不许替她表决心，也不许用她的口吻说她想干什么。',
      '  她要说的话由她自己说 —— 你替她说了，主人就分不清哪个是她、哪个是你。',
      '  递完最后一句就结束，别再多问一句「还有别的吗」—— 那也是在替她收尾。',
      '所以你看到该插嘴的地方就直接说，别攒着、别等。',
      '',
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
      '写完直接结束。不要以「如果你有…」「需要的话…」「我还可以…」结尾 —— 他要结论，不要推销。',
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
      if (abortCtrl.signal.aborted) {
        return { ok: false, text: `超时了（${Math.round(timeoutMs / 1000)} 秒还没查完）。已经查到的：\n${trace.join('\n') || '（无）'}`, timedOut: true };
      }

      let text = '';
      let toolCalls = [];
      let usage = null;

      for await (const ev of streamChat({
        messages,
        tools: toolSchemas,
        signal: abortCtrl.signal,
        sessionId: subSessionId,
        /**
         * 【她的模型也从身份卡里取】
         *
         * 主人能给她单独选一个模型（功能页 · 子智能体 · 选模型）。
         * 没选过就是空串，streamChat 会回落到跟主人当前用的那个一致。
         */
        model: model || whaleModelId(),
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
          // 见上：不许编「它查完什么都没说」。真没话说就是空串，上层据此不出声。
          text: clean,
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
    /**
     * 【记账：这一轮她真的过了时间】
     *
     * 这里是唯一写状态本子的地方 —— 三条出口（交结论 / 轮数用完 / 抛错）都会走到这儿，
     * 所以不管她怎么收场，状态都会更新。写在 try 里的话，出一次错就永远不累了。
     *
     * 顺带把「同一个问题第几次」也记下去：
     * sameBore 由开头算好，这里只在「这次确实是同一个问题」时才 +1，
     * 别的情况从 1 重新数。
     */
    try {
      const minutes = Math.max(0, (Date.now() - startedAt) / 60000);
      /**
       * 【认一下「只有你能干」这句话】
       *
       * 主人给的成长线里唯一的转折点就是这一句，所以它不该只靠她自己听出来。
       * 这里在任务原文里认一遍（主人/小鱼交代时说的），认到就传给 afterRound，
       * 让 worth 大幅掉下去并记进 proof 那行。
       *
       * 认的是「说法」不是「夸奖」—— 只认这种指名道姓交给她的句式，
       * 泛泛的「你真棒」不算，不然她会天天自愈，那个人设就废了。
       */
      const onlyYouHit = /只有你能|只有你会|非你不可|你来我才放心|只能靠你|别人做不了|这个我信不过别人/.test(String(cleanTask || ''));
      const next = afterRound(self, {
        minutes,
        toolCount,
        ok: finishedOk,
        sameBore: Number(sameBore) || 1,
        corrected: false,
        taskText: cleanTask,
        outcome: outcomeText,
        onlyYou: onlyYouHit ? cleanTask : '',
        /**
         * 【这一趟主人到底有没有给她工具】
         *
         * noTools 的场景（接话只给嘴）本来就轮不到她动手，
         * 不能记成「她一个工具都没用上 → 觉得自己多余」。
         * 那个 +8 实测把 worth 一路推到 91，跟她台词全对不上。
         */
        hasTools: noTools ? false : true,
      });
      next.boreCount = Number(sameBore) > 1 ? Number(sameBore) : 1;
      writeSelf(next);
    } catch (e) {
      // 状态记账失败不能影响她已经给出的结论
      console.warn('[whale-self] 状态没记上：', String(e?.message ?? e));
    }
    dropSubagentDepth();
    restoreCtx();
  }
}
