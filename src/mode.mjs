/**
 * 会话现在处在哪一档（安全词语义上的）。
 *
 * 主人原话：新会话如果没说别的安全词，那从一开始就等于在「人设」这一档里聊。
 * 所以不存在「还没进入任何档」的状态——默认就是 persona。
 *
 * 存在 session.mode = { word, since }：
 *   - word === personaWord() -> 人设档（默认，基线）
 *   - word 是别的安全词     -> 主人喊过它，后续轮次继续保持那一档，直到再切
 *
 * 老会话没有 mode 字段，读出来一律当人设档，不改盘。
 */
import { personaWord } from './persona.mjs';
import { getSettings, matchSafeWord } from './settings.mjs';

/** 某个会话当前生效的档位词名。 */
export function sessionModeWord(session) {
  const settings = getSettings();
  const base = personaWord(settings);
  const w = session?.mode?.word;
  if (!w) return base;
  const words = Array.isArray(settings.safeWords) ? settings.safeWords : [];
  // 词被主人从设置里删了 -> 回落到基线，别留个幽灵档
  return words.includes(w) ? w : base;
}

/** 这一档是不是人设基线档。 */
export function inPersonaMode(session) {
  return sessionModeWord(session) === personaWord(getSettings());
}

/**
 * 这一轮要不要按安全词切换档位。
 * @returns {{word:string, switched:boolean}}
 *   switched=false 表示没喊别的词，继续待在当前档（新建会话就是人设档）
 */
export function applySafeWord(session, message) {
  const settings = getSettings();
  const base = personaWord(settings);
  // 走 matchSafeWord 而不是自己 includes：它会把全角标点换成半角再比，
  // 主人用中文输入法打完字顺手带的「，」「！」不该让安全词失灵。
  const hit = matchSafeWord(message, settings) || '';

  // 喊了「人设」= 明确回到基线，不算切换，但也不该把档位记成别的
  const current = sessionModeWord(session);
  if (!hit) return { word: current, switched: false };

  if (hit === base) {
    if (current !== base) {
      session.mode = { word: base, since: Date.now() };
      return { word: base, switched: false, backToBase: true };
    }
    return { word: base, switched: false };
  }

  // 真正的切换：这一轮按它说话，之后继续保持这一档
  session.mode = { word: hit, since: Date.now() };
  return { word: hit, switched: true };
}
