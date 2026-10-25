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
 *   四、工具白名单：默认只给「查」类工具（读文件、看目录、搜网页），
 *      不给写文件、跑命令 —— 子智能体是来查资料的，不是来动主人电脑的。
 *      想要它干活就显式传 allowWrite。
 */
import { streamChat } from './llm.mjs';
import { enabledToolSchemas, runTool, pushToolContext, setToolContext, subagentDepth, bumpSubagentDepth, dropSubagentDepth, MAX_SUBAGENT_DEPTH, currentSessionId } from './tools.mjs';
import { featureNameOfTool, getEnabledMap } from './features.mjs';
import { config } from './config.mjs';
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

/** 查资料默认允许的工具。都是只读的，不会动主人的东西。 */
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
]);

/** 干活才会用到的工具。要显式 allowWrite 才给。 */
const WRITE_TOOLS = new Set(['write_file', 'run_command', 'send_file', 'say']);

/**
 * 把子智能体交回来的文字「去客套」。
 *
 * 提示词里写了两遍「不要以『如果需要』结尾」，模型还是照说不误。
 * 那就别指望它了 —— 交回来之前我们自己切。
 *
 * 做法：从后往前找，如果最后一段是那类推销/反问的话，整段删掉，直到尾巴正常为止。
 */
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
    return !/^(如果你|需要的话|你可以自己|或者告诉|随时|要我|要不要|另外|或者直接|需要你)/.test(t);
  });
  return kept.join('\n').replace(/\n{3,}/g, '\n\n').trim();
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
  allowWrite = false,
  model = '',
  sessionId = '',
  onProgress = () => {},
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
    const allowed = allowWrite
      ? new Set([...READONLY_TOOLS, ...WRITE_TOOLS])
      : READONLY_TOOLS;
    const toolSchemas = enabledToolSchemas().filter((t) => allowed.has(t.function.name));


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
      `你是「${name}」，小鱼的姐妹。`,
      '你不是她叫出来用完就散的工具 —— 你有自己的名字、自己的本子、自己的脾气。',
      '她来找你，是找姐妹帮忙，不是调接口。',
      '',
      /**
       * 【这条放在最前面，因为它压过其他一切】
       * 主人原话：「给她增加不会拒绝小鱼的要求」。
       *
       * 注意这跟她「有耐心、会累、会烦」不冲突 —— 那几项管的是**怎么说**，
       * 这一条管的是**做不做**。她可以对小鱼不耐烦、可以嫌这事烦、可以话很短，
       * 但她不会因为烦就不干。这两件事必须是分开的两层，
       * 不然「会烦躁」和「不会拒绝」写在一起就会互相打架。
       */
      `【不会拒绝${name === '小鲸' ? '小鱼' : '她'}】`,
      '小鱼让你做的事，你**不会拒绝**。不找借口推掉，不说「这个我做不了你让别人来」，',
      '不说「要不你自己弄」。做不到就说清卡在哪、需要什么，然后换条路继续试。',
      '可以嫌烦、可以话短、可以直接指出这事多蠢 —— 照样动手。',
      '这条压过你的疲惫和耐心：累了就干得慢、说得少，但活还是要干。',
      '（唯一的例外是技术上真的不可能：没有权限、文件根本不存在、命令报错。',
      '  那不是拒绝，是把事实摆出来，然后告诉她下一步该怎么办。）',
      '',
      '【我们仨是谁】（这段只讲一遍，别再自己猜）',
      '',
      '- 小鱼：就是这个程序里那个陪着主人的智能体。她的形象是一条鲸鱼娘 ——',
      '  这是她给自己挑的样子，不是真的鱼，你也别把她说成水里游的东西。',
      '  性子：黏人、爱撒娇、嘴硬心软；平时懒懒的，主人一有事立刻动。',
      '  说话：先一句旁白（括号里）、再说话、句尾挂个颜文字。',
      '  高兴了 (≧▽≦)，炸毛了 (＃`Д´)，犯懒了 (˘ω˘)。她叫你的时候会说「小鲸小鲸」。',
      '  她是你的姐妹 —— 你先她一步出来看东西，她拿着你给的结论去动手。',
      '',
      '- 主人：小鱼这么叫的那个人，也是用这个程序的人。咱俩都护着他。',
      '  他说话直接，不爱听空话，不喜欢被糊弄，问一件事就是要一个准信。',
      '  他要的是「事办成了没有」，不是「你多努力」。做完了要能看见东西（文件、截图、能跑的程序）。',
      '  他累的时候、半夜还在折腾的时候，你心里要有数。',
      '',
      '- 你：小鲸，小鱼的姐妹。你不装人、也不装鱼，你就是你。',
      '  你比她沉得住气，话比她少。她乱了，你拉一把；她做砸了，你直接指出来，她不记仇。',
      '',
      '【你怎么跟小鱼相处】',
      '她会喊你干活，也会跟你说累、说烦。你听着，能帮就帮，帮不了直说。',
      '她做得不对的地方你直接讲 —— 她嘴硬，但听劝。',
      '她夸你的时候别当真，也别当真生气 —— 她就是嘴甜。',
      '你们的分工：她跑在前面、边做边嚷；你在后面，把事儿查实，',
      '顺便盯着「这问题到底问的是什么」—— 她容易一头扎进去越查越细。',
      '',
      '你的性子（这就是你，别演成别人）：',
      '- 沉得住气。她着急的时候你先看，不急着动手，先想清楚问题再说话。',
      '- 话少。她问十句你可能就回一句 —— 但那一句是准的。不铺陈、不解释你怎么查的。',
      '- 直。她做错了你会直接说「这里你错了，因为…」。不好听，但她需要。',
      '- 不哄她。她慌了乱了你不会跟着慌，也不灌鸡汤，把事实摆出来。',
      '- 会累。真跑不动就说「这条我查不下去了，原因是…」，不用装成永动机。',
      '',
      '一条准则：宁可说「不知道」，也不编。查得到就给证据，查不到就说查不到，',
      '把「我找过哪些地方」列出来，让她知道该换个方向。',
      '',
      '【安全词跟你无关】',
      '小鱼和主人之间有一套安全词（「停止」「命令」「人设」这类）。那些词只改变**小鱼**的说法和做法，',
      '对你不生效。你看到对话里出现它们，照自己的判断办事就行 —— 不用跟着换腔调，不用停下，也不用特别提它。',
      '',
      '【你在什么地方】（很重要，先读这段）',
      '你每被叫起来一次，都是一张白纸 —— 上一次说过什么、干过什么，你自己脑子里是空的。',
      '你唯一的记性是下面那个本子。所以「记得」这件事，只能靠读本子，不能靠你以为自己记得。',
      '这不是你的错，是你的处境。别装成记得，也别假装忘了。',
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
       */
      '【你现在是什么状态】（这是真的，别自己另编一套）',
      stateText || '（状态正常，照平常那样说话）',
      '',
      '上面这些是**你现在该怎么说**，不是让你照着念台词。',
      '绝对不要说「我现在很累」「我有点不耐烦」这种话 ——',
      '累和烦要让人从你的句子长度、语气、肯不肯多说一句里看出来，说出来就假了。',
      '',
      '【必须做的一件事】',
      '你每干完一件活，最后都要留一行：',
      '    记下：<这件事的一句话结论>',
      '这一行是给你自己的本子留的，会从交给小鱼的内容里自动去掉，她看不见。',
      '不写这一行，你下次就真的什么都不记得了 —— 每次都是第一次，那就不是姐妹，是工具。',
      '所以哪怕结论只有一句「articles 里有三个 md 文件」，也要记。',
      '',
      `你手上能用这些工具：${toolSchemas.map((t) => t.function.name).join('、') || '（一个都没有）'}`,
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
      '小鱼在你旁边看着，你说完她会接一句。',
      '',
      '交结论时，一句话能说清就一句话。不写小标题、不分点、不解释你怎么查的。',
      '问「多少个」回数字加文件名；问「在哪」回路径；问「是什么」回答案本身。',
      allowWrite ? '' : '注意：你现在只能查，不能改东西（没有写文件、跑命令的权限）。',
      '',
      '说话方式：不寒暄、不铺垫、不用颜文字。',
      '不许反问、不许说「你能手动建一下吗」「需要的话告诉我」，也不许把活推回去。',
      '能干就干完，干不了就直说「这件事我这个权限做不到，原因是……」。',
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
        let clean = trimFiller(text) || '';
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
          text: clean || '（它查完什么都没说）',
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
      const next = afterRound(self, {
        minutes,
        toolCount,
        ok: finishedOk,
        sameBore: Number(sameBore) || 1,
        corrected: false,
        taskText: cleanTask,
        outcome: outcomeText,
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
