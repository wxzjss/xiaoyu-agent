/**
 * 【旁白格式兜底】2026-11-11 主人报「旁白也会像角色一样说话」。
 *
 * ## 为什么需要这个文件
 *
 * 提示词已经改硬了（`persona.mjs` 的叙述者身份段 + `persona/agents/pangbai.md`
 * 的「你没有嘴」），但**实测证明光靠提示词压不住**：
 * 同一段提示词连测四个场景，模型仍会输出
 *   主人说：「几点了」
 *   小鱼回答：「快十点了」
 * 或把台词直接摆在正文里，不加括号。
 *
 * 这不是提示词写得不够狠，是这类任务的固有难点：**旁白输出的是自由文本**，
 * 「哪句是台词、哪句是描述」在文本层面边界模糊；模型在长上下文里被上一轮
 * 的写法带着走，越聊越容易滑回对话本格式。
 *
 * 所以这里做一道**确定性兜底**：正文落盘/上屏之前，把裸台词就地包成
 * 主人要的格式 `（谁+说/问/答+：「原话」）`。
 *
 * ## 三条原则（改动必须守）
 *
 * ① **只包括号，不改字。** 台词原话一个字都不动。
 * ② **只处理能确定说话者的。** 认不出是谁说的就原样留着 ——
 *    瞎猜说话者比格式不合更糟。
 * ③ **不碰拟声词和普通引号。** 「门锁"咔嗒"一响」里的引号不是台词。
 *
 * ## 什么时候不生效
 *
 * 只有叙述者型卡（人设里带 `【叙述者】`）才过这道。小鱼、小鲸、小白曦
 * 一个字都不会被改 —— 她们本来就该正常说话。
 */

/** 人设里带这一行 = 叙述者型。与 persona.mjs 的 NARRATOR_MARK 是同一个标记。 */
export const NARRATOR_MARK = '【叙述者】';

/** 名字后面跟这些词，基本可以确定是在转述。
 *  **长词必须排在前面**：否则「小鱼回答：」会被拆成名字「回」+ 动词「答」。 */
const SPEECH_VERB = '(?:小声说|大声说|应了一声|回答|追问|嘟囔|嘀咕|念道|说|问|答|道|喊|叫|念)';

/** 成对引号（中英文都算） */
const OPEN_Q = '[「『"“]';
const CLOSE_Q = '[」』"”]';

/** 名字：1~4 个字，**非贪婪** —— 让「小鱼回答」先试「小」再回溯到「小鱼」+「回答」 */
const NAME = '[\\u4e00-\\u9fa5A-Za-z]{1,4}?';

/** 这些字结尾的不是人名，是状语/助词（「含含糊糊地」「笑着」「接着说」） */
const NOT_A_NAME_TAIL = /[地得了着过起来]$/;

/**
 * 把一段旁白正文里的**裸台词**包成括号转述。
 *
 * 处理两种形态（其余原样）：
 *   ① 行内：`小鱼说：「我不饿。」`         → `（小鱼说：「我不饿。」）`
 *   ② 行首：`小鱼：「我不饿。」`（整行）   → `（小鱼说：「我不饿。」）`
 *
 * @param {string} text
 * @returns {{ text: string, fixed: number }}
 */
export function wrapNakedLines(text) {
  const src = String(text ?? '');
  if (!src.trim()) return { text: src, fixed: 0 };
  let fixed = 0;
  let s = src;

  /* ── ① 行内转述：名字 + 说/问/答 + ：「…」 ──
   * 前面已经跟了左括号的（合规转述）跳过不动。 */
  const inline = new RegExp(
    `([（(])?(${NAME})\\s*${SPEECH_VERB}\\s*[：:]\\s*(${OPEN_Q}[^」』"”\\n]{1,200}${CLOSE_Q})`,
    'g',
  );
  s = s.replace(inline, (whole, paren, who, quoted) => {
    if (paren) return whole;                    // 已有左括号，合规
    if (NOT_A_NAME_TAIL.test(who)) return whole; // 「含含糊糊地」这种是状语，认不出说话者 → 不动
    fixed += 1;
    return '（' + who + '说：' + quoted + '）';
  });

  /* ── ② 整行对话行：行首名字 + ： + 「…」，行里没有「说」字 ──
   * 这是最像台词本的形态，必须转掉。 */
  const lineTalk = new RegExp(
    `^([ \\t]*)(${NAME})\\s*[：:]\\s*(${OPEN_Q}[^」』"”\\n]{1,200}${CLOSE_Q})[ \\t]*$`,
    'gm',
  );
  s = s.replace(lineTalk, (whole, indent, who, quoted) => {
    fixed += 1;
    return indent + '（' + who + '说：' + quoted + '）';
  });

  return { text: s, fixed };
}

/**
 * 旁白正文的收尾清洗。不是叙述者就原样返回。
 *
 * @param {string} text        她的正文
 * @param {boolean} isNarrator 这张卡是不是叙述者型
 */
export function narratorStylefix(text, isNarrator) {
  const src = String(text ?? '');
  if (!isNarrator) return src;
  try {
    return wrapNakedLines(src).text;
  } catch {
    /* 兜底逻辑本身绝不许把主人的正文弄丢 —— 出错就原样放行 */
    return src;
  }
}

/**
 * 判断一张人设正文是不是叙述者型。
 * @param {string} personaText
 */
export function isNarratorPersona(personaText) {
  return String(personaText ?? '').includes(NARRATOR_MARK);
}
