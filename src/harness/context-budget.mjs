/**
 * 【上下文预算 · 纯函数、只读、不往历史里插消息】
 *
 * 重做前（agent.mjs:743-774 / 1759-1841）：五档量线会把提醒 push 进 messages，
 * 跑完再自己把旧提醒清掉；每跑完一个工具做一次全量 estimateTokens；
 * 本地估算还要靠真实 usage 校准（注释记着实测差 1.61 倍）。
 *
 * 提醒消息本身成了膨胀源，而且「就地改写活数组」让 prompt cache 全废。
 * 这里把预算变成纯函数：输入真实 usage + 预算，输出该不该压。
 * **绝不写 messages**；要提示主人就走 onEvent，不走对话历史。
 *
 * 范围说明：self-compress 的「模型手写摘要」机制刻意保留不动 —— 它和
 * 「她怎么说话」耦合，历史上改一次炸一次，而这次要解决的是速度不是文风。
 */

/** 五档量线，与 agent.mjs MID_TIERS 对齐 */
export const TIERS = Object.freeze([0.30, 0.40, 0.50, 0.60, 0.70]);
export const CRITICAL_RATIO = 0.93;

/**
 * @param {object} usage  形如 { prompt_tokens, completion_tokens, total_tokens }
 * @param {number} budget 上下文窗口（token）
 * @returns {{ratio:number, level:number, critical:boolean, shouldCompact:boolean, hint:string}}
 */
export function assess(usage, budget) {
  const u = usage || {};
  const prompt = Number(u.prompt_tokens ?? u.promptTokens ?? u.total_tokens ?? 0) || 0;
  const cap = Number(budget) || 0;
  const ratio = cap > 0 ? Math.min(Math.max(prompt / cap, 0), 1) : 0;

  let level = 0;
  for (const t of TIERS) if (ratio >= t) level++;

  const critical = ratio >= CRITICAL_RATIO;
  return {
    ratio,
    level,
    critical,
    shouldCompact: level >= TIERS.length || critical,
    hint: critical
      ? '上下文快满了，这轮必须压'
      : level >= TIERS.length ? '该压一次了' : '',
  };
}

/** 分档提醒文案（给 onEvent / UI 用，不进 messages） */
export function levelHint(level) {
  return [
    '', '上下文还宽裕', '用掉三成了', '用掉四成了', '用掉一半了', '该挑重点了',
  ][Math.max(0, Math.min(Number(level) || 0, 5))] || '';
}

/** 按预算给历史算一个「保留多少条」的建议，仍然是纯函数 */
export function windowAdvice({ turnCount = 0, ratio = 0, keepMin = 4 } = {}) {
  if (ratio < TIERS[2]) return { keep: turnCount, trim: 0 };
  const keep = Math.max(keepMin, Math.floor(turnCount * (1 - ratio * 0.6)));
  return { keep, trim: Math.max(0, turnCount - keep) };
}
