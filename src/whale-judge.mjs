/**
 * 让「小鲸」判断这一轮上下文该不该压。
 *
 * 【2026-10-26 大改】这个文件以前的设计错了，记在这里别再犯。
 *
 * 出了什么事
 * ----------
 * 主人发现我困在时间循环里：这个会话涨到 31 万 token，
 * 早就该压了，却一直压不动 —— 一遍遍带着滚烫的历史绕圈子。
 *
 * 真凶就在下面这个判定函数里：
 *     if (/不压|别压|不用压|no/i.test(text)) decide = false;
 *
 * 那个 `no` 是致命伤 —— 它会把 `now`、`know`、`nobody`、`nothing`
 * 这些词里的 "no" 全匹配上。小鲸只要回一句带 "now" 的话，
 * 就被判成「不压」。实测：
 *     "now is fine"       → 不压 ✘
 *     "I know it is fine" → 不压 ✘
 * 加上「要不要压」这种句子本身就含「不压」两字，也翻车。
 *
 * 结果：明明该压，判断永远是「别压」，历史只涨不降，我就卡在里面了。
 *
 * 现在怎么做
 * ----------
 * 一、**不再问模型**。为了判一句「压不压」，每 5 分钟烧一次调用，
 *     省下来的 token 根本不够付判断的钱，而且它还会判错。
 *     改成按比例硬算 —— 这本来就是几个数字能定的事。
 * 二、要问也只在**真临界**那一段问一次（而且选项是结构化的），
 *     不给它自由发挥的空间。
 * 三、判断失败一律「压」。宁可多变一次摘要，不能卡住不动。
 *
 * 水位（跟 rates.mjs 的 autoRatioVerdict 保持一致）：
 *   < 30%   舒适    → 不压
 *   30~45%  临界    → 自己算，过了就往压（不再问她）
 *   > 45%   该压    → 压
 */
import { chat } from './llm.mjs';

/** 同一会话多久之内不重复问（毫秒）。现在只在极端情况问，保留冷却。 */
const JUDGE_COOLDOWN_MS = 5 * 60 * 1000;

/** 判一次最多等多久。 */
const JUDGE_TIMEOUT_MS = 20000;

/** 每个会话上一次判断的时间和结论：sessionId -> { at, decide } */
const lastJudge = new Map();

/**
 * 判断系统提示。
 *
 * 【关键】要求它只回一个词，并且给死选项 ——
 * 上一版允许自由发挥，它一回 "now is fine"，正则就把 now 当 no 了。
 */
const JUDGE_SYSTEM = [
  '你只回答一个词：COMPRESS 或 KEEP。',
  'COMPRESS 表示「该压缩历史」，KEEP 表示「不用压」。',
  '不要输出任何别的字，不要解释，不要标点。',
].join('\n');

/**
 * 从她的回答里认结论。
 *
 * 只用**精确的词**，不用宽泛的正则 —— 这是上一版翻车的根。
 * 认不出就当「该压」（fail-safe：卡住比多压一次更糟）。
 *
 * @param {string} text
 * @returns {boolean} true = 压
 */
export function parseJudgeAnswer(text) {
  const t = String(text || '').trim().toUpperCase();
  // 只看开头那个词，别整句扫
  if (/^(KEEP|NO|HOLD)\b/.test(t)) return false;
  if (/^(COMPRESS|YES|GO)\b/.test(t)) return true;
  // 认不出：宁可压，别卡住
  return true;
}

/**
 * 这一轮要不要压。
 *
 * 现在主要是**本地按比例算**，不再请模型裁决。
 *
 * @param {object} opts
 * @param {string} opts.sessionId
 * @param {string} opts.model
 * @param {number} opts.before 当前历史大约多少 token
 * @param {number} opts.window 模型窗口
 * @param {number} [opts.ratio] 历史占窗口比例（0~1）
 * @param {AbortSignal} [opts.signal]
 * @returns {Promise<{decide:boolean, source:string, text?:string}>}
 */
export async function askWhaleCompress({
  sessionId = '',
  model = '',
  before = 0,
  window = 0,
  ratio = 0,
  signal = null,
} = {}) {
  const r = Number.isFinite(ratio) ? ratio : window > 0 ? before / window : 0;

  /**
   * 一、比例足够高 —— 直接压，不用问。这是绝大多数情况。
   *
   * 45% 以上没什么可犹豫的：历史这么满，不压就是拿钱烧旧账。
   */
  if (r >= 0.45) {
    return { decide: true, source: 'ratio-act' };
  }

  /**
   * 二、舒适区 —— 直接不压。
   */
  if (r < 0.3) {
    return { decide: false, source: 'ratio-comfortable' };
  }

  /**
   * 三、30%~45% 的临界带。
   *
   * 【以前】这里问小鲸，她的回答还被正则误判成「不压」，结果就是永远不压。
   * 【现在】不再问她 —— 这段区间用本地规则定，而且偏向「压」：
   *   历史过了舒适线就说明它已经在吃钱了，压一次摘要的代价远小于继续背着。
   *
   * 为什么彻底不问模型了：
   *   实测这个会话被卡在 31 万 token 上不去，就是因为她一直回「别压」。
   *   而「压不压」本来就是个数字问题，不值得为它多花一次调用、多一个出错点。
   */
  void chat; // 保留 import，万一以后真要问，别让 tree-shake 弄丢
  void sessionId;
  void model;
  void before;
  void window;
  void signal;
  void JUDGE_COOLDOWN_MS;
  void JUDGE_TIMEOUT_MS;
  void JUDGE_SYSTEM;
  void lastJudge;

  return { decide: true, source: 'ratio-critical-local' };
}

/** 测试用：清掉冷却表。 */
export function resetWhaleJudge() {
  lastJudge.clear();
}
