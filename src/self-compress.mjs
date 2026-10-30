/**
 * self-compress.mjs —— 压缩记忆这件事，改成「我自己挑」（2026-10-30）
 *
 * 【为什么要这个文件】主人原话：
 *   「压缩是你自己压缩的吗？如果是，你应该会自己挑那些重要的内容，不重要的直接删，
 *    已完成的任务保留清单就够了，具体做了什么可以简洁成一句话甚至直接删。
 *    为什么会频频出现问题」
 *
 * 他说得对。以前压缩是这么干的：真对话被折成一段，交给一个便宜的摘要模型，
 * 按「主人要什么 / 已经做完 / 还没做完 / 关键约束」四个死标签写五条 ——
 * 挑重点这件事，实际上外包给了一台根本不在场的机器。
 * 它不知道哪条是真要紧、哪条是流水账，只能机械地摘，
 * 于是一份档案写满「run_command(cd "D:\小鱼Agent"; node ...)」这种流水，
 * 真正的目标、卡在哪一步、主人骂过什么，全被埋在里头或者直接漏掉。
 *
 * 现在改成：**压缩那一下，我自己写这一轮的记忆。**
 * 我本来就知道自己在干嘛 —— 目标、清单打到第几步、卡在哪儿、主人原话是什么。
 * 摘要模型退到兜底（我这一轮没回来才用它）。
 */

import { memoryText } from './my-memory.mjs';

/** 压缩记忆开头的记号，收的时候靠它认出「这是压缩写的」并取出存档编号。 */
export const SELF_NOTE_TAG = '【压缩记忆';

/** 一句随笔最多这么长。够写目标+清单+卡点，不许写成流水账。 */
export const SELF_NOTE_MAX = 1200;

/**
 * 拼进 system 提示的那一段：每次开口都提醒「该你自己挑」。
 * 压缩关着的时候返回空串，一个字不花。
 */
export function renderSelfCompressBlock(on = true) {
  if (!on) return '';
  return [
    '【上下文太长的时候，是**你自己挑**重点，不是别人代挑】',
    '真压起来的时候，程序会给你一份旧对话的原文存档编号，让你亲手写一段压缩记忆。规矩：',
    '1. 这段活还在干什么（目标），一定要留 —— 这是后面接得上的唯一理由。',
    '2. 清单打到第几步、哪几步做完打勾了，留清单就行；具体每一步做了什么，缩成一句话，能删就删。',
    '3. 卡在哪儿、什么没成、什么被证明不通 —— 比做过什么重要得多，必须留。',
    '4. 主人原话里的硬要求（不许干的事、他定的规矩、他说过的数）照原样抄，别改写。',
    '5. 其余一律删。工具调用流水、「我先看看」「已经改完」这类过程废话，一个字都不要。',
    '6. 每段开头写「【压缩记忆·存档编号】」，正文最多 1200 字。别人问你要不要继续、你也不许反问我。',
  ].join('\n');
}

/**
 * 真到了要压的时候，给她的那条指令：不是模板填空，是让她按自己的判断整理。
 *
 * @param {object} o
 * @param {string} o.foldedId 原文存档编号（能在 folded 里翻回去）
 * @param {number} o.total 折掉多少条
 * @param {string} [o.headText] 头部（人设/开场那几条），给她个语境
 * @param {string} [o.currentNote] 上一份压缩记忆（要合并，不许丢目标）
 * @param {string} [o.taskHint] 这一轮主人在要求什么
 */
export function buildSelfCompressInstruction(o = {}) {
  const foldedId = String(o.foldedId ?? '未编号');
  const total = Number(o.total) || 0;
  const parts = [
    `【该你自己压缩记忆了】这一轮历史太长，程序已经把折掉的 ${total} 条原文存好了，存档编号：${foldedId}（想翻原话随时能翻）。`,
    '现在请你亲手写这一段的压缩记忆，写给过几天回来接着干的你自己看。别问要不要继续，别铺垫，直接写。',
  ];
  if (o.headText && String(o.headText).trim()) {
    parts.push('', '【开头那几条，给你个语境】', String(o.headText).slice(0, 1200).trim());
  }
  if (o.currentNote && String(o.currentNote).trim()) {
    parts.push('', '【上一份压缩记忆，合并进来，目标不许丢】', String(o.currentNote).slice(0, 1200).trim());
  }
  if (o.taskHint && String(o.taskHint).trim()) {
    parts.push('', '【这一轮主人在要什么】', String(o.taskHint).slice(0, 400).trim());
  }
  parts.push(
    '',
    '【挑重点的规矩】',
    '· 目标必须留一句：这段活到底在干什么。',
    '· 清单：做完的打勾一句话，没做完的写清卡在哪 —— 具体做过什么能删就删。',
    '· 主人原话里的硬要求、他定的规矩、他说的数，原样抄。',
    '· 工具流水、「我先看看」「已经改完」这类过程废话，一个字都不要。',
    `· 开头写「${SELF_NOTE_TAG}·${foldedId}】」，正文最多 ${SELF_NOTE_MAX} 字。`,
  );
  return parts.join('\n');
}

/** 顾问腔：她把自己当成在跟人聊天，反问「要我继续吗」之类。这种不收。 */
const ADVISOR_LINE = /(要我继续|需要我|要不要我|你希望|请问您|我可以帮|是否继续)[^\n]{0,12}[？?]/;

/**
 * 收她写回来的压缩记忆。
 *
 * 规矩：宁可这一次不收（退回让摘要模型兜底），也不许收一句空话 ——
 * 收错了就是把自己压失忆，比不压还糟。
 *
 * @param {string} raw 她这一轮的正文
 * @returns {{ok:boolean, text?:string, reason?:string}}
 */
export function acceptSelfNote(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return { ok: false, reason: '空' };
  const at = s.indexOf(SELF_NOTE_TAG);
  if (at < 0) return { ok: false, reason: '没有编号（对不回是哪一段）' };
  const body = s.slice(at).trim();
  if (body.length < 40) return { ok: false, reason: '太短' };
  if (ADVISOR_LINE.test(body)) return { ok: false, reason: '顾问腔' };
  // 全是工具流水/横杠，也算没写
  const solid = body.replace(/[\s\-*#>|`~·【】]/g, '');
  if (solid.length < 30) return { ok: false, reason: '没有实字' };
  return { ok: true, text: body.slice(0, SELF_NOTE_MAX) };
}

/** 从记忆本里取出最近一条压缩记忆（合并时用）。 */
export function lastSelfNote(sessionId) {
  try {
    const t = memoryText() || '';
    const i = t.lastIndexOf(SELF_NOTE_TAG);
    if (i < 0) return '';
    return t.slice(i, Math.min(t.length, i + SELF_NOTE_MAX));
  } catch {
    return '';
  }
}

/**
 * 真要给她看的那一段「该你压了」。
 *
 * 为什么不复用 buildSelfCompressInstruction：那条是塞进模型对话里的指令，
 * 这条是要**给她自己看**、提醒她这一轮必须先动手把记忆写出来的。
 */
export function selfCompressHint(o = {}) {
  const segId = String(o.segId ?? '未编号');
  const tokens = Number(o.tokens) || 0;
  const window = Number(o.window) || 0;
  const kept = Number(o.kept ?? 0);
  const removed = Number(o.removed ?? 0);
  const pct = window > 0 ? ((tokens / window) * 100).toFixed(1) + '%' : '?';
  const parts = [
    '【该你自己压了】',
    `这一轮历史 ${tokens} token（占窗口 ${pct}），程序已经把最旧的 ${removed} 条原文折好存盘，编号 ${segId}（要翻原话随时能翻），还没真删。`,
    `现在先动手把这一段亲手写成压缩记忆再接着干：写完程序会把那 ${removed} 条折起来、只留你写的这段（最多 ${SELF_NOTE_MAX} 字）。`,
  ];
  if (o.planText && String(o.planText).trim()) {
    parts.push('', '【清单（已做完的打勾就好，别复述过程）】', String(o.planText).trim().slice(0, 1500));
  }
  if (kept) parts.push('', `（尾巴最近 ${kept} 条原文不动，别把它们也写进来）`);
  parts.push(
    '',
    '规矩：目标一句；清单做完的打勾、没做完的写卡在哪；主人原话硬要求照抄；工具流水一个字不要。',
    `开头写「${SELF_NOTE_TAG}·${segId}】」。不许反问我，不许说「要我继续吗」。`,
  );
  return parts.join('\n');
}
