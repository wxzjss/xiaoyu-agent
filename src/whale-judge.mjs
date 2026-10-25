// 让「小鲸」判断这一轮上下文该不该压。
//
// 为什么需要她：自动档按窗口比例判断出来一段「拿不准」的中间地带（30%~45%），
// 这时候光看数字拍不出准主意 —— 历史里可能全是干货（该压）、也可能刚开头（别压）。
// 让另一个我（小鲸）看一眼当前状况，回一句「压」或「不压」，比死公式聪明。
//
// 两条硬规矩：
//   1. 省钱：同一会话判断过一次，JUDGE_COOLDOWN_MS 之内不再问。否则每一轮都问一遍，
//      省下来的 token 还不够付判断的钱。
//   2. 不污染她的记忆本子：这里只调一次非流式 chat，不走 runSubagent 那套
//      （那套会读写 whale-memory、跑工具循环，为了判一句「压不压」太重了）。
import { chat } from './llm.mjs';

/** 同一会话多久之内不重复问小鲸（毫秒）。默认 5 分钟。 */
const JUDGE_COOLDOWN_MS = 5 * 60 * 1000;

/** 判一次最多等多久。等太久还不如自己拍板 —— 判断不值得拖慢主人的回复。 */
const JUDGE_TIMEOUT_MS = 20000;

/** 每个会话上一次问小鲸的时间和结论：sessionId -> { at, decide } */
const lastJudge = new Map();

const JUDGE_SYSTEM = [
  '你是小鲸，负责替主会话判断「现在这一轮上下文要不要压缩」。',
  '压缩的意思是：把旧的对话折成一段摘要，只保留最近几轮，省下 token。',
  '判断原则：',
  '- 历史已经很满、或者离模型窗口没多少余量了 → 该压（回"压"）。',
  '- 历史还不算多、正在做的事离不开前面的上下文 → 别压（回"不压"）。',
  '只回一个字或两个字：压 / 不压。不要解释，不要标点。',
].join('\n');

/**
 * 问小鲸这一轮该不该压。
 *
 * @param {object} opts
 * @param {string} opts.sessionId 会话 id（冷却按它算）
 * @param {string} opts.model 当前模型名
 * @param {number} opts.before 当前历史大约多少 token
 * @param {number} opts.window 模型窗口
 * @param {number} [opts.ratio] 历史占窗口比例（0~1）
 * @param {AbortSignal} [opts.signal]
 * @returns {Promise<{decide:boolean, source:'whale'|'cooldown'|'fallback', text?:string}>}
 *   decide=true 表示「该压」。
 */
export async function askWhaleCompress({
  sessionId = '',
  model = '',
  before = 0,
  window = 0,
  ratio = 0,
  signal = null,
} = {}) {
  const key = String(sessionId || '');
  const now = Date.now();
  const prev = key ? lastJudge.get(key) : null;
  // 冷却期内：沿用上一次的结论，不再花一次钱
  if (prev && now - prev.at < JUDGE_COOLDOWN_MS) {
    return { decide: prev.decide, source: 'cooldown' };
  }

  const pct = Number.isFinite(ratio) ? Math.round(ratio * 100) : 0;
  const userLine =
    `当前模型窗口约 ${window} tokens，历史已经占 ${before} tokens（约 ${pct}%）。` +
    `这一轮要不要压缩？只回「压」或「不压」。`;

  // 自己给个超时：判断不值得拖住整轮
  const combo = new AbortController();
  const timer = setTimeout(() => combo.abort(), JUDGE_TIMEOUT_MS);
  const onAbort = () => combo.abort();
  if (signal) {
    if (signal.aborted) combo.abort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }

  let decide;
  let source = 'whale';
  try {
    const json = await chat({
      messages: [
        { role: 'system', content: JUDGE_SYSTEM },
        { role: 'user', content: userLine },
      ],
      signal: combo.signal,
      sessionId,
    });
    const text = String(json?.choices?.[0]?.message?.content ?? '').trim();
    // 认「不压」优先：只要出现「不压」就当不压，避免「不压」被下面的「压」误判
    if (/不压|别压|不用压|no/i.test(text)) decide = false;
    else if (/压|yes/i.test(text)) decide = true;
    else decide = undefined;
    if (decide === undefined) {
      // 她没给出能认的答案 —— 用比例兜底：过了舒适线就压
      decide = true;
      source = 'fallback';
    }
  } catch (err) {
    // 问不到她（超时 / 网络 / 限流）：按比例兜底，别让判断卡住这一轮
    decide = true;
    source = 'fallback';
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
  }

  if (key) lastJudge.set(key, { at: now, decide });
  return { decide, source };
}

/** 测试用：清掉冷却表。 */
export function resetWhaleJudge() {
  lastJudge.clear();
}
