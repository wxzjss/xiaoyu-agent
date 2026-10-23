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
// 纯净模式：开了就一个字系统提示都不发（见 pure.mjs）。
import { pureModeOn, pureSystemPrompt } from './pure.mjs';

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
  // 纯净模式：人设、思考语言、说话规矩、安全词、人设档、会话记忆全部不发
  // —— 主人要的就是「只看对话本身」。这里必须是第一判断，免得后面任何一块漏出去。
  // 但只发一条「答短点」：系统提示全空的话，模型没有任何长度锚点，会突然拉长篇大论。
  if (pureModeOn()) return pureSystemPrompt();

  const settings = getSettings();
  const word = String(safeWord ?? '').trim();
  // 「人设」是基线档，不是临时切换：它不覆盖人设档，只是同一条规则换一说法。
  // 只有主人喊了别的安全词、且不是「人设」自己，才走临时切换那段。
  const switched = Boolean(safeMode) && word !== '' && word !== personaWord(settings);
  const parts = [
    loadPersona(),
    REASONING_LANGUAGE_RULE,
    settingsPromptBlock(settings),
    personaModeRules(settings),
    memoryBlock(sessionId),
  ].filter(Boolean);
  if (switched) parts.push(safeModeRules(word));
  return parts.join('\n\n');
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
    body,
  ].join('\n');
}

export { matchSafeWord };
