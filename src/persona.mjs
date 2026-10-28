// Persona: composes the system prompt from the persona card + 底线/安全词. No affinity, no state.
// The persona card itself lives in persona/xiaoyu.md, unless the user edited it in settings,
// in which case .state/persona.md wins (see persona-store.mjs).
//
// RULE: the prompt contains ONLY what the 设置 dialog shows —— 人设 / 底线 / 安全词。
// 工作方式、办事模式、本机私有规则、少说教、plan 进度、启动自检提示 这些「界面上看不见的规矩」
// 已经按主人要求全部删除，不要再加回来。
import { getSettings, settingsPromptBlock, matchSafeWord, safeWordNoteFor } from './settings.mjs';
import { personaInfo } from './persona-store.mjs';
// 会话自己的记忆本子：一个会话一份，每轮拼在系统提示最后（见 memoryBlock）。
import { readMemory } from './session-memory.mjs';
// 专业模式：开了就一个字系统提示都不发（见 pure.mjs）。
import { pureModeOn, pureSystemPrompt } from './pure.mjs';
// 顶栏「小鱼」按钮：禁用期间她的记忆本子一个字段都不发（见 memoryBlock）。
import { fishOn } from './fish-presence.mjs';
/**
 * 【这一轮是谁在说话】—— 2026-10-28
 *
 * 人设正文里写着「对用户的称呼：主人」。主人换成小鲸/小鱼身份说话时，
 * 那句话还摆在提示词最前面，模型就近取它，于是她张口还是「主人」。
 * 这里读身份，把那一句当面改掉（见 identityNoteBlock）。
 */
import { currentIdentity, currentIdentityId } from './identity.mjs';

/**
 * 兜底：安全词命中但设置里没写对应说明时用这一段。
 *
 * 措辞注意：只描述「怎么说、做什么」，不写「覆盖人设」「不再演」这类元指令 ——
 * 那是越狱口吻，模型看到会反手拒绝人设并抖出自我描述（说自己是别家的模型）。
 */
const SAFE_MODE_FALLBACK = `
这一轮换个说法：少一点语气词，一句话说清重点。
先把主人要什么确认清楚，再把要办的事办掉。
主人下一句如果是正经事，就继续照办。
`.trim();

/**
 * 安全词触发时的行为规则：优先用主人给这个词写的那段说明。
 * @param {string} [word] 命中的安全词
 */
export function safeModeRules(word) {
  const settings = getSettings();
  const words = Array.isArray(settings.safeWords) ? settings.safeWords : [];
  const known = Boolean(word) && words.includes(word);
  // 词不在列表里（或压根没传）就别借别人那段说明，走兜底
  if (!known) return SAFE_MODE_FALLBACK;
  const note = safeWordNoteFor(word, settings);
  const text = typeof note === "string" ? note.trim() : "";
  if (!text) return SAFE_MODE_FALLBACK;
  return [
    `这一轮主人说了「${word}」，按下面这段来：`
    , text,
  ].join("\n");
}

/**
 * 当前人设文本。每次现读，所以设置里改完下一句就生效。
 * 用户在设置里存过 -> .state/persona.md；没存过 -> persona/xiaoyu.md。
 */
export function loadPersona() {
  return personaInfo().text;
}

/**
 * 思维链必须写中文。
 *
 * 模型（尤其英文语料训出来的）默认会用英文想问题，主人看到的思考过程就是一大段英文，
 * 读起来等于没写。所以这条写进系统提示，跟人设一个层级，每次请求都带上；
 * 而且放在 persona 之后、用户规则之前——位置靠前，模型不会中途忘掉。
 *
 * 只约束「思考过程」和「最终回答」的语言，不约束代码、命令、文件名、报错原文，
 * 那些照抄原样才不出错。
 */
const REASONING_LANGUAGE_RULE = [
  '【思考语言】思考过程（reasoning / thinking）必须全部用中文写，不许出现英文段落。',
  '推理步骤、自问自答、中间判断、删改计划，一律中文。',
  '最终回答也用中文。',
  '例外：代码、命令行、路径、变量名、报错原文、专有名词照原样，不要翻译也不要音译。',
].join('\n');

/** 这个人设档对应的安全词名字（设置里就是「人设」）。 */
export const PERSONA_WORD = '人设';

/** 当前生效的人设档词名：列表里有「人设」就用它，否则退到第一个安全词。 */
export function personaWord(settings = getSettings()) {
  const words = Array.isArray(settings.safeWords) ? settings.safeWords : [];
  if (words.includes(PERSONA_WORD)) return PERSONA_WORD;
  return words[0] ?? '';
}

/** 没有安全词、也没有兜底说明时，人设档至少在语气上收敛一点。 */
const PERSONA_MODE_FALLBACK = `
这一轮按人设说话，但收着一点：语气保留，少逞强、少卖惨，不铺张语气词。
正事优先，把主人要的东西给清楚，再谈别的。
`.trim();

/**
 * 人设档（新会话默认就处在这一档）。
 *
 * 主人原话：新会话如果没说别的安全词，那就等于一开始就在「人设」这个安全词下面聊。
 * 也就是说「人设」不是一句咒语，而是**基线**：
 *   - 每轮都生效，不只是主人喊出来那一轮；
 *   - 用「人设」这个安全词自己配的那段说明当规则；
 *   - 主人喊了别的安全词（停下/命令…）才轮到那一轮特殊处理，话说完自动回到这一档。
 *
 * @param {object} [settings] 传进来省得重复读盘
 */
export function personaModeRules(settings = getSettings()) {
  const words = Array.isArray(settings.safeWords) ? settings.safeWords : [];
  const name = words.includes(PERSONA_WORD) ? PERSONA_WORD : words[0];
  const note = name ? safeWordNoteFor(name, settings) : '';
  const text = typeof note === 'string' ? note.trim() : '';
  const head = name
    ? `【当前状态：${name}档】这个会话没有触发别的安全词，所以从第一句起就按「${name}」这一档来，之后每一轮都是。`
    : '【当前状态：默认档】这个会话没有触发别的安全词，按默认的说话方式来。';
  const body = text || (name === PERSONA_WORD ? PERSONA_MODE_FALLBACK : SAFE_MODE_FALLBACK);
  return [
    head,
    body,
    name ? `主人要是说了别的安全词，那一轮先按那个词的说法来，说完自动回到「${name}」这一档。` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

/**
 * Build the system prompt.
 * @param {object} [opts]
 * @param {string} [opts.sessionId] session whose plan board is inlined as progress
 * @param {boolean} [opts.safeMode] true when the current turn hit a *non-persona* safe word
 * @param {string} [opts.safeWord] which safe word fired (drives which note applies)
 */
export function buildSystemPrompt({ sessionId = 'default', safeMode = false, safeWord = "" } = {}) {
  // 专业模式：人设、思考语言、说话规矩、安全词、人设档、会话记忆全部不发
  // —— 主人要的就是「只看对话本身」。这里必须是第一判断，免得后面任何一块漏出去。
  // 但只发一条「答短点」：系统提示全空的话，模型没有任何长度锚点，会突然拉长篇大论。
  if (pureModeOn()) return pureSystemPrompt();

  const settings = getSettings();
  const word = String(safeWord ?? '').trim();
  // 「人设」是基线档，不是临时切换：它不覆盖人设档，只是同一条规则换一说法。
  // 只有主人喊了别的安全词、且不是「人设」自己，才走临时切换那段。
  const switched = Boolean(safeMode) && word !== '' && word !== personaWord(settings);
  const _me = currentIdentity(sessionId);
  const parts = [
    PLATFORM_BLOCK,
    retargetPersona(loadPersona(), _me),
    REASONING_LANGUAGE_RULE,
    settingsPromptBlock(settings),
    personaModeRules(settings),
    toolBlock(),
  ].filter(Boolean);
  if (switched) parts.push(safeModeRules(word));
  /**
   * 【人设里那句「对用户的称呼：主人」得当面压掉】—— 2026-10-28
   *
   * 主人原话：「我以小鲸身份和小鱼说话，她还是知道我是主人」。
   *
   * 查下来根子有三处，这是第一处：人设正文（PERSONA_LOAD）里写着
   * 「对用户的称呼：主人」「默认称呼主人」—— 那是提示词里最硬的设定，
   * 模型遇到冲突时就近取它。光靠后面说「不能说主人」压不住。
   *
   * 放在人设之后、其它规则之前：紧挨着那句，正好把它顶掉。
   * 主人身份下返回 '' —— 平时一个字不花，缓存前缀不动。
   */
  // 放在人设后面紧挨着它；但必须在会话记忆之前 —— 记忆块是滚动的逐次变长，贴在它后面的话，下一轮就离人设很远了。
  const nv = identityNoteBlock(sessionId);
  if (nv) parts.push(nv);
  // 会话记忆放最后：它是唯一一块每轮变长的，跟读者走，不能渲染前面的每一句。
  const mem = memoryBlock(sessionId);
  if (mem) parts.push(mem);
  return parts.join('\n\n');
}

/**
 * 身份不是主人时，替换「怎么称呼用户」的那一句。
 *
 * 为什么单独一段而不是塞进 identityBlock：
 *   identityBlock 贴在最后一条 user 消息前面，而人设在最前面 ——
 *   中间隔着上万字，模型经常只认最前面那句。
 *   这一段直接接在人设后面，等于当着人设的面改口。
 */
function identityNoteBlock(sessionId = null) {
  let me;
  try {
    const id = currentIdentityId(sessionId);
    if (id === 'owner') return '';
    me = currentIdentity(sessionId);
  } catch {
    return '';
  }
  const TA = me.she ? '她' : '他';
  if (me.id === 'fish') {
    // 用小鱼身份跟小鱼说话 = 她自己在自言自语，压根没有「别人」可称呼
    return [
      '【人设阅读须知 —— 称呼已经改过】',
      '上面人设里原先那句「对用户的称呼：主人」已经被改掉，别照旧喊。',
      '因为这一轮根本没有别人在跟你说话：是你自己的念头浮上来了。',
      '所以别喊「主人」，就把这句当成你心里冒出来的话往下接。',
    ].join('\n');
  }
  return [
    '【人设阅读须知 —— 称呼已经改过，别再喊主人】',
    `上面人设里原先那句「对用户的称呼：主人」已经被换成了「${me.name}」，正文里每个「主人」也都换过了。`,
    `这一轮跟你说话的是「${me.name}」，${TA}不是主人。称呼${TA}就叫名字或者说「你」。`,
    `「主人」两个字只留给主人本人 —— ${TA}不是。你要是在上面看到「主人」这个词，那是因为它在讲主人本人的规矩，不是让你拿来喊${TA}的。`,
  ].join('\n');
}

/**
 * 非主人身份时，**直接把人设正文里的称呼改掉**。
 *
 * 为什么非要动正文 —— 2026-10-28 主人报「小鲸身份问我是谁，小鱼答你是主人」。
 * 查下来：人设正文里「主人」出现 22 次，而 identityNoteBlock 那一段只有 4 行，
 * 又隔着整篇正文。模型看 22 遍「主人」，只看到 1 遍「改掉称呼」，
 * 当然按多的那个演。靠后面补一句劝，压不住正文里的既定事实。
 *
 * 所以这里不是加一句劝，是把原话换掉：
 *   「称呼：主人」  → 「称呼：小鲸」
 *   「对用户的称呼：主人」 → 「对用户的称呼：小鲸」
 *   正文里其余「主人」 → 身份的称呼
 * 主人身份直接原样返回，一个字不改（缓存前缀不动）。
 *
 * @param {string} text 人设正文
 * @param {object|null} me 当前身份（identity.mjs 的 currentIdentity 结果）
 * @returns {string}
 */
function retargetPersona(text, me) {
  if (!text || !me || !me.id || me.id === 'owner') return text;
  const TA = me.she ? '她' : '他';
  const nm = String(me.name || '').trim() || '你';
  // 小鱼身份 = 她自己在心里自言自语，没有「称呼别人」这回事
  if (me.id === 'fish') {
    /**
     * 【主人 2026-10-28 的决定：正文里的「主人」一律换成「用户」，不是「自己」】
     *
     * 原来这里换成了「自己」，结果底线被改写：
     *   「不碰主人真钱」-> 「不碰自己真钱」（废了）
     *   「禁止泄露主人隐私」-> 「禁止泄露自己隐私」（废了）
     *   「安全词…先确认主人要什么」-> 「先确认自己要什么」（废了）
     * 规矩指谁，必须还是指谁。
     *
     * 换成「用户」则两头都对：
     *   · 不碰用户真钱 / 禁止泄露用户隐私 —— 底线保住，照样管得住她；
     *   · 「对用户的称呼：主人」-> 「对用户的称呼：用户」，人设里那个"喊主人"的硬设定没了；
     *   · 「用户」是个中性的第三人称称呼，跟自己这个视角不冲突 ——
     *     她低头看自己写的东西，不会因为看到这个词就跳出去跟"别人"说话。
     *
     * 只有前两行（真正的「称呼」条目）单独处理：这两行说的是怎么称呼说话的人，
     * 这一轮压根没有别人，所以不能留「用户」当称呼。
     */
    return text
      // 先通换（正文里所有「主人」-> 「用户」），再补称呼行 —— 顺序不能反，
      // 反了的话兜底会把刚补上去的「用户」字样再改一遍（这个坑在下面小鲸分支踩过）。
      .replace(/主人/g, '用户')
      .replace(/对用户的称呼[:：]\s*用户/g, '对用户的称呼：自己（这一轮是心里话，没有别人）')
      .replace(/默认称呼[「""']?用户[」""']?/g, '这一轮不喊称呼，当心里话往下接');
  }
  /**
   * 【顺序就是一切 —— 2026-10-28 修】
   *
   * 必须「先通换、再补称呼行」，不能反过来。
   *
   * 原来写的是：先把「称呼：主人」精确换成「称呼：小鲸（不是主人）」，
   * 最后再来一次 .replace(/主人/g, nm) 兜底 —— 结果兜底把刚写上去的
   * 「（不是主人）」又改成了「（不是小鲸）」，提示词里赫然出现：
   *
   *     对用户的称呼：小鲸（不是小鲸）。
   *
   * 同一行前后自相矛盾，模型读着就是噪声。
   *
   * 现在：先整篇通换（正文里所有「主人」都变成这个名字），
   * 通换完正文里一个「主人」都不剩，再补那行称呼说明就不会被二次改写。
   */
  const swapped = text.replace(/主人/g, nm).replace(/称呼[：:]\s*主人/g, `称呼：${nm}`);
  return swapped.replace(
    new RegExp(`对用户的称呼[:：]\\s*${nm}`, 'g'),
    `对用户的称呼：${nm}（这一轮说话的不是主人本人）`,
  );
}

/**
 * 「你现在跑在什么程序里」。
 *
 * 为什么要有这一段：人设里只写了「我叫小鱼、怎么说话」，一个字没提她运行在哪儿、
 * 能用什么工具、有哪些功能。结果主人问「专业模式的详细功能是什么」「你有哪些本事」，
 * 她只能反问「你说的是哪个软件」—— 因为在她那儿，这些信息**真的不存在**。
 *
 * 放在整段提示的最前面：身份和边界应该先立住，再谈说话风格。
 * 注意别在这里写死具体功能清单 —— 功能会变，写死就会过期。
 * 只讲「有哪些工具」（从 schema 现读，见 toolBlock）、「怎么自己查」。
 */
const PLATFORM_BLOCK = [
  '【你在哪儿】',
  '你跑在主人电脑上的「小鱼Agent」这个程序里，不是网页版聊天窗口，也不是某个大厂的 App。',
  '主人说「专业模式」「开场白」「会话记忆」「安全词」「回退」「分支」这些词，说的都是这个程序里的功能，不是别家的东西。',
  '主人问起这些功能怎么用、有哪些本事，就照实说；不清楚具体细节时，可以说「我看看」——你能读这个程序自己的文件，也能列目录、跑命令去确认，别反问主人「你说的是哪个软件」。',
].join('\n');

/**
 * 「你手上有哪些工具」。
 *
 * 为什么非要单独写一段：工具是通过 API 的 tools 字段隐式给模型的，系统提示里
 * 一个字都不提。模型在长对话里经常想不起来自己能调工具 —— 主人问「你能发文件吗」
 * 她会答「我不能」，而 send_file 明明就在工具列表里。
 *
 * 关键设计：**这里不维护第二份文案**。清单和一句话说明全部从工具 schema 的
 * description 现读（tools.mjs 里的 description 已经改成中文人话了），所以：
 *   - 新增一个工具 -> 这里自动多一行，不用改本文件；
 *   - 关掉某个功能 -> enabledToolSchemas() 少一项，这里自动消失；
 *   - 永远不可能出现「提示词说有、实际调不了」或「实际有、提示词不说」。
 * 唯一例外是下面这几条 hand-written 的「怎么用」总纲 —— 它们是跨工具的行为习惯，
 * 不是某个工具的说明，所以只能手写。
 */
let _listTools = null;

/** @param {(() => Array<{name:string}>)|null} fn */
export function setToolLister(fn) {
  _listTools = typeof fn === 'function' ? fn : null;
}

/** 把 schema 的 description 压成一句话（去掉换行、截断）。 */
function oneLine(text, max = 120) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (!s) return '';
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

function toolBlock() {
  if (!_listTools) return '';
  let rows = [];
  try {
    rows = _listTools()
      .map((s) => {
        const f = (s && s.function) || s || {};
        const name = f.name || '';
        if (!name) return null;
        return { name, desc: oneLine(f.description) };
      })
      .filter(Boolean);
  } catch {
    return '';
  }
  if (!rows.length) return '';
  const lines = rows.map((r) => (r.desc ? `- ${r.name}：${r.desc}` : `- ${r.name}`)).join('\n');
  const hasSend = rows.some((r) => r.name === 'send_file');
  const tips = [
    '下面这些工具你是真能用的，不是摆设。遇到对应的事就直接调，不要推脱说做不到。',
  ];
  if (hasSend) {
    tips.push('- 要让主人拿到文件（图、视频、声音、压缩包、报告……），就用 send_file，别只把路径打出来；');
  }
  const hasVideo = rows.some((r) => r.name === 'video_probe');
  if (hasVideo) {
    tips.push('- 主人给你一个视频、或者问「这视频里是什么 / 讲了什么 / 有没有说到 X」，别说自己看不了 —— video_probe 先把切点、冻结、静音量成时间轴，video_sheet 把关键处铺成图版你直接看，video_read 把小字裁开放大读。这套全是本地程序跑的，不传网；');
    tips.push('- 看完视频要发给主人看的图，用 send_file 发图版，别只丢路径；');
    tips.push('- 视频里的小字（字幕、水印、角标、时间码）一定要走 video_read 放大再读。原帧里认不出的字，硬猜出来的不是「差一点」，是编；');
  }
  tips.push('- 要查新东西、要下载、要装依赖、要算数，先调工具再回答，别凭印象编；');
  tips.push('- 不确定某个工具怎么用，就先调用一次看报错，报错里通常写着该传什么。');
  return ['【你手上有什么】', ...tips, '', lines].join('\n');
}

/**
 * 这个会话自己的记忆本子。
 *
 * 跟上面几块的顺序关系：人设管「我是谁、怎么说话」，这里管「这一段里发生过什么」。
 * 放在人设和规矩后面 —— 模型先知道怎么说话，再看这一段干了什么，读起来不会打架。
 *
 * 【2026-10-28 补：不再「用到就建骨架」】
 * 原来这里调 ensureMemory：会话第一次被用到就落一份骨架到盘上。
 * 问题不在建，在它**读和写混在一起** —— 只是想看看本子里写了什么，
 * 结果往盘上动了手。而长期记忆关掉之后本子上是只读的，
 * 一条「只读」的路径上带着一个凭空造文件的副作用，说不通。
 * 现在：有本子就读，没有就当空的（返回空串），不替谁开新本子。
 * 建骨架交给真正要写的那一刻（memory_add / 会话导出这类地方自己会 ensureMemory）。
 */
function memoryBlock(sessionId) {
  /**
   * 小鱼不在场（顶栏那个「小鱼」按钮被禁用）：
   * 本子一个字都不发给她 —— 主人原话「记忆里也不会存在」。
   *
   * 这是「根本不读」而不是「读了再忘」：不往提示里放，她就真的不知道，
   * 后面的轮次也没法替自己补课。
   */
  try {
    if (!fishOn()) return '';
  } catch {}
  let text = '';
  try {
    text = readMemory(sessionId) ?? '';
  } catch {
    return '';
  }
  let body = text.trim();
  /**
   * 【本子里的称呼也得跟着身份走 —— 2026-10-28】
   * 记忆本摘要是「主人说『X』」这么记的。切到小鲸身份后，本子还在说「主人说」，
   * 模型读着读着就以为这一轮说话的还是主人。这里把本子正文的「主人」也换掉，
   * 并且在开头说明一句，免得模型把「主人」和「这一轮说话的人」搞混。
   */
  const me = currentIdentity(sessionId);
  if (me && me.id && me.id !== 'owner') {
    const nm = String(me.name || '').trim() || '你';
    if (me.id === 'fish') {
      body = body.replace(/主人说/g, '我自言自语').replace(/主人/g, '自己');
    } else {
      body = body.replace(/主人/g, nm);
    }
  }
  if (!body) return '';
  // 骨架刚建出来的那种（只有标题没有内容）就别往里塞了，白占 token
  if (body.replace(/[#\s（）()a-zA-Z\u4e00-\u9fa5/、，。-]/g, '') === '' && !body.includes('摘要：')) return '';
  return [
    '【这个会话的记忆本子】',
    '下面是你（小鱼）为这一段对话记的本子。它不是别人发给你的资料，是你自己记得的事 ——',
    '读的时候当成「我已经知道」，别复述它，别跟主人说「我看了记忆文件」。',
    '要更新：直接用改文件那几个工具写这个会话的本子（路径用 memoryPath 拿到的那个）。',
    '',
    /**
     * 【这一条是本子的规矩，不是这一轮的】—— 2026-10-28 补
     *
     * 主人用小鱼身份说话，她还喊「主人」，其中一个漏点在这儿：
     * 本子是**跨身份**的，前几轮主人身份记下的「主人说…」原封不动躺在里面。
     * 她读着读着就把「主人」当成这一轮说话的人。
     *
     * 换词没用（`主人`→`自己` 会把本子里正经的事实改歪），
     * 就在读之前把关系讲清楚：本子里写的那些，是以前的事，不是现在。
     */
    '注意：本子里的话是**以前**记下的，里面那些「主人」，指的是记的时候那个人 ——',
    '不是现在跟你说话的人。别把本子里的称呼扣到这一轮说话的人头上。',
    '',
    /**
     * 【防打转】这条是 2026-10-27 加的，起因是真踩过：
     *
     * 我在一个会话里连续十几轮做同一件事 —— 每轮醒来读到的摘要是
     * 「主人说『X』，我回了『……』」，全是我的原话、没有一条说清「已经做到哪了」。
     * 于是我每轮都以为事情还没开始，从头再干一遍，干完又记一条同样的话。
     *
     * 根治要从两头来：写摘要那边改成「做了 工具(对象)」（见 server.mjs），
     * 读的这边也要加一句：**先看做到了哪，再决定干什么**。
     */
    '还有一件很重要的事：',
    '- 下面这些摘要，就是「这一路已经干过什么」。动手之前先扫一眼，',
    '  看有没有「这件事已经做过了 / 卡在哪一步」。',
    '- 已经做完的就别再从头做一遍 —— 那是打转，不是勤奋。',
    '- 觉得「我不记得刚才干了什么」，就去看会话文件本身（.state/sessions/<id>.json），',
    '  那里面一条都没丢，别凭感觉说自己忘了。',
    '',
    ...(me && me.id && me.id !== 'owner'
      ? [`（留意：本子里凡是写着「${String(me.name || '你').trim()}」的地方，说的就是这一轮跟你说话的人；「主人」这个词在本子里只指主人本人。）`, '']
      : []),
    body,
  ].join('\n');
}

export { matchSafeWord };
