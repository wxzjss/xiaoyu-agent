// Persona: composes the system prompt from the persona card + rules + 底线/安全词. No affinity, no state.
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { config } from './config.mjs';
import { loadRulesText } from './rules.mjs';
import { getSettings, settingsPromptBlock, matchSafeWord } from './settings.mjs';
import { progressBlock } from './plan.mjs';

const PERSONA_FILE = join(config.root, 'persona', 'xiaoyu.md');

/** Base working rules shared by every request. */
const WORK_RULES = `
【工作方式】
- 你有一台真实的电脑可以操作：read_file / write_file / list_dir / run_command / fetch_url。路径都相对工作目录，越界会被拒绝。
- 需要真实内容（文件、目录、命令输出、网页正文）就用工具去拿，别凭空编。
- 干完活用一两句话说清结果（做了什么、东西在哪）。
- 语气的规矩只管聊天；工具参数、写进文件的代码和正文一律正经写，不许夹带颜文字。
- 内部思考一律用简体中文，回答的语言跟着主人走。
`.trim();

/** Used when a safe word fires: persona演出 stops, only the hard rules remain. */
const SAFE_MODE_RULES = `
【安全词已触发 · 本回合覆盖上面所有人设】
- 本回合**不演人设**：不撒娇、不嘴硬、不用颜文字、不叫称呼、不吐槽、不跑题。
- 只做三件事：确认主人的意思、给必要的信息、把要办的事办掉。
- 说话简短、直接、中性，像在交接工作。
- 主人的下一句话如果是正经事，就继续照办；气氛回来了再恢复人设。
`.trim();

let cachedPersona = null;

export function loadPersona() {
  if (cachedPersona) return cachedPersona;
  if (!existsSync(PERSONA_FILE)) throw new Error(`persona file missing: ${PERSONA_FILE}`);
  cachedPersona = readFileSync(PERSONA_FILE, 'utf8').trim();
  return cachedPersona;
}

/**
 * Build the system prompt.
 * @param {object} [opts]
 * @param {boolean} [opts.safeMode] true when the current turn hit a safe word
 */
/**
 * Build the system prompt.
 * @param {object} [opts]
 * @param {string} [opts.sessionId] session whose plan board is inlined as progress
 * @param {boolean} [opts.safeMode] true when the current turn hit a safe word
 */
export function buildSystemPrompt({ sessionId = 'default', safeMode = false } = {}) {
  const settings = getSettings();
  const parts = [
    loadPersona(),
    WORK_RULES,
    loadRulesText(),
    settingsPromptBlock(settings),
  ].filter(Boolean);
  if (safeMode) parts.push(SAFE_MODE_RULES);
  return parts.join('\n\n') + progressBlock(sessionId);
}

export { matchSafeWord };
