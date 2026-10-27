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
import { ensureMemory } from './session-memory.mjs';
// 专业模式：开了就一个字系统提示都不发（见 pure.mjs）。
import { pureModeOn, pureSystemPrompt } from './pure.mjs';
// 顶栏「小鱼」按钮：禁用期间她的记忆本子一个字段都不发（见 memoryBlock）。
import { fishOn } from './fish-presence.mjs';

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
  const parts = [
    PLATFORM_BLOCK,
    loadPersona(),
    REASONING_LANGUAGE_RULE,
    settingsPromptBlock(settings),
    personaModeRules(settings),
    toolBlock(),
    memoryBlock(sessionId),
  ].filter(Boolean);
  if (switched) parts.push(safeModeRules(word));
  return parts.join('\n\n');
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
 * 会话第一次被用到时自动建骨架（ensureMemory），所以不会有「有的会话有本子、有的没有」。
 * 读不到/文件坏了就什么都不加，绝不能因为记忆读不了把整轮对话搞崩。
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
    text = ensureMemory(sessionId) ?? '';
  } catch {
    return '';
  }
  const body = text.trim();
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
    body,
  ].join('\n');
}

export { matchSafeWord };
