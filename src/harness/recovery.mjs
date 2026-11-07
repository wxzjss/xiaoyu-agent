/**
 * 【统一恢复策略】
 *
 * 重做前，同一类故障在不同层有不同预算：
 *   llm.mjs:483-542      网关 2 次 / 上下文溢出压一次 / 思考字段降档
 *   agent.mjs:1205-1395  断流 30 次 / 429 退避到 handoff
 *   agent.mjs:1639-1659  每工具独立 AbortController
 *   deadline.mjs:77-92   LLM 10 分钟 / 工具 30 分钟 / 提醒 10 分钟
 *   subagent.mjs:995     只重试 1 次、且 abort 不向下传
 *
 * 这里不推翻现有续传行为（那条主人验过「断流能接上」），只把**分类与预算**
 * 收成一张表，供各层共用；后续要统一时改这一处即可。
 */

import { LLM_IDLE_MS, TOOL_MAX_MS, TOOL_NOTICE_MS, TURN_IDLE_MAX_MS } from '../deadline.mjs';

/** 唯一的时间常量出口，别再各处硬编码 */
export const DEADLINES = Object.freeze({
  llmIdleMs: LLM_IDLE_MS,
  toolMaxMs: TOOL_MAX_MS,
  toolNoticeMs: TOOL_NOTICE_MS,
  turnIdleMs: TURN_IDLE_MAX_MS,
});

export const FAILURE_KIND = Object.freeze({
  RETRYABLE: 'retryable',        // 断流 / 5xx / 静默看门狗
  RATE_LIMIT: 'rate_limit',      // 429
  NEEDS_COMPACT: 'needsCompact', // 上下文溢出
  NEEDS_HANDOFF: 'needsHandoff', // 429 到阈值，换会话续跑
  FATAL: 'fatal',                // 连不上 / 400 / 参数错
  ABORTED: 'aborted',            // 主人喊停
});

/** 一个错误只归一类；顺序即优先级 */
export function classify(err) {
  const e = err || {};
  const name = String(e.name || '');
  const msg = String(e.message || e || '');
  const code = String(e.code || e.status || e.statusCode || '');

  if (name === 'AbortError' || /abort|cancel/i.test(msg)) return FAILURE_KIND.ABORTED;
  if (/rate.?limit|429/.test(code) || /429|rate.?limit/i.test(msg)) return FAILURE_KIND.RATE_LIMIT;
  if (/context.?overflow|context_length|maximum context|prompt too long|too many tokens/i.test(msg)) {
    return FAILURE_KIND.NEEDS_COMPACT;
  }
  if (/ECONNREFUSED|connection refused|ENOTFOUND|bad request|400|invalid_request/i.test(msg)
      || code === '400' || code === '404') return FAILURE_KIND.FATAL;
  /* 【2026-11-07 加·一个字节都没回就别重试了】
   * 上游压根没开始说话（noBytes），续读和重试都救不了 ——
   * 实测那种情况会空转：等超时 10 分钟 → 续一次 → 再等 10 分钟，界面一直显示在跑。
   * 直接归 FATAL，把「上游没回应」这句话交给主人看，比静默重试半小时强。 */
  /* 【2026-11-07 加·超时不再重试】
   * 已经等满整整一个窗口（现在 2 分钟）一个字节都没回来，再等一轮只是把
   * 「卡住」延长成「卡更久」。主人要的是尽快知道「上游挂了」，不是十分钟后才知道。
   * 实测：检查鱼续跑 → 等 120 秒超时 → 归类成「可重试」→ 又等 120 秒 …
   * 界面上的表现就是「一直挂着不动」，跟他报的现象一模一样。 */
  if (e.isTimeout) return FAILURE_KIND.FATAL;
  if (e.noBytes) return FAILURE_KIND.FATAL;
  if (e.streamDropped || /terminated|ECONNRESET|UND_ERR_SOCKET|fetch failed|timed? ?out|stall|静了太久/i.test(msg)
      || /^5\d\d$/.test(code)) return FAILURE_KIND.RETRYABLE;
  return FAILURE_KIND.FATAL;
}

/** 指数退避，封顶 8 秒 —— 和 agent.mjs:1359 的 retryDelay 保持一致 */
export function backoffMs(n) {
  return Math.min(Math.pow(2, Math.max(0, Number(n) || 0)) * 800, 8000);
}

/**
 * 一份预算管到底：每类故障有自己的上限，总耗时也有上限。
 * 用它是为了以后不再出现「断流 30 次、工具 30 分钟、整轮 180 分钟」互相打架。
 */
export function createRecoveryPolicy({ maxRetries = 30, totalBudgetMs = 180 * 60 * 1000 } = {}) {
  const started = Date.now();
  let used = 0;
  const byKind = new Map();

  return {
    /** @returns {{retry:boolean, delayMs:number, reason:string}} */
    shouldRetry(kind) {
      if (kind === FAILURE_KIND.ABORTED || kind === FAILURE_KIND.FATAL) {
        return { retry: false, delayMs: 0, reason: '这类错误重试没用' };
      }
      if (kind === FAILURE_KIND.NEEDS_HANDOFF) {
        return { retry: false, delayMs: 0, reason: '该换会话续跑了' };
      }
      if (kind === FAILURE_KIND.NEEDS_COMPACT) {
        return { retry: byKind.get(kind) ? false : true, delayMs: 0, reason: '压一次再试' };
      }
      if (used >= maxRetries) return { retry: false, delayMs: 0, reason: '重试次数用完了' };
      if (Date.now() - started > totalBudgetMs) return { retry: false, delayMs: 0, reason: '总时间用完了' };
      return { retry: true, delayMs: backoffMs(used), reason: '' };
    },
    note(kind) {
      used++;
      byKind.set(kind, (byKind.get(kind) || 0) + 1);
      // 429 连续到 3 次就交给 handoff，别在此无限退避
      if (kind === FAILURE_KIND.RATE_LIMIT && byKind.get(kind) >= 3) return FAILURE_KIND.NEEDS_HANDOFF;
      return kind;
    },
    exhausted() { return used >= maxRetries || Date.now() - started > totalBudgetMs; },
    snapshot() { return { used, byKind: Object.fromEntries(byKind), elapsedMs: Date.now() - started }; },
  };
}
