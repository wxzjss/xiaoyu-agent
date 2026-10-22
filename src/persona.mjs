// Persona: composes the system prompt from the persona card + 底线/安全词. No affinity, no state.
// The persona card itself lives in persona/xiaoyu.md, unless the user edited it in settings,
// in which case .state/persona.md wins (see persona-store.mjs).
//
// RULE: the prompt contains ONLY what the 设置 dialog shows —— 人设 / 底线 / 安全词。
// 工作方式、办事模式、本机私有规则、少说教、plan 进度、启动自检提示 这些「界面上看不见的规矩」
// 已经按主人要求全部删除，不要再加回来。
import { getSettings, settingsPromptBlock, matchSafeWord, safeWordNoteFor } from './settings.mjs';
import { personaInfo } from './persona-store.mjs';

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
 * Build the system prompt.
 * @param {object} [opts]
 * @param {string} [opts.sessionId] session whose plan board is inlined as progress
 * @param {boolean} [opts.safeMode] true when the current turn hit a safe word
 * @param {string} [opts.safeWord] which safe word fired (drives which note applies)
 */
export function buildSystemPrompt({ sessionId = 'default', safeMode = false, safeWord = "" } = {}) {
  const settings = getSettings();
  const parts = [
    loadPersona(),
    settingsPromptBlock(settings),
  ].filter(Boolean);
  if (safeMode) parts.push(safeModeRules(safeWord));
  return parts.join('\n\n');
}

export { matchSafeWord };
