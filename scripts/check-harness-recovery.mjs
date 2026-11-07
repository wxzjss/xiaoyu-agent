/** 恢复策略：五类错误分类、退避封顶、预算耗尽、abort 优先。 */
import { makeChecker } from './_harness_util.mjs';
import {
  classify, backoffMs, createRecoveryPolicy, FAILURE_KIND, DEADLINES,
} from '../src/harness/recovery.mjs';

const t = makeChecker('harness / recovery');

const cases = [
  [{ message: 'terminated' }, FAILURE_KIND.RETRYABLE, '断流'],
  [{ message: 'ECONNRESET' }, FAILURE_KIND.RETRYABLE, '连接重置'],
  [{ name: 'AbortError', message: 'stall guard cancel' }, FAILURE_KIND.ABORTED, '看门狗取消'],
  [{ status: 429 }, FAILURE_KIND.RATE_LIMIT, '429'],
  [{ message: '429 Too Many Requests' }, FAILURE_KIND.RATE_LIMIT, '429 文本'],
  [{ message: 'context_length_exceeded' }, FAILURE_KIND.NEEDS_COMPACT, '上下文溢出'],
  [{ message: 'ECONNREFUSED 127.0.0.1' }, FAILURE_KIND.FATAL, '连不上'],
  [{ status: 400 }, FAILURE_KIND.FATAL, '400'],
  [{ name: 'AbortError' }, FAILURE_KIND.ABORTED, '主人喊停'],
];
for (const [err, want, name] of cases) t.ok('分类 · ' + name, classify(err) === want, classify(err));

t.ok('abort 优先于一切', classify({ name: 'AbortError', status: 429, message: 'terminated' }) === FAILURE_KIND.ABORTED);
t.ok('退避从 800ms 起', backoffMs(0) === 800);
t.ok('退避封顶 8 秒', backoffMs(99) === 8000);
t.ok('退避单调不减', backoffMs(1) <= backoffMs(2) && backoffMs(2) <= backoffMs(3));

const p = createRecoveryPolicy({ maxRetries: 3 });
t.ok('断流可重试', p.shouldRetry(FAILURE_KIND.RETRYABLE).retry);
p.note(FAILURE_KIND.RETRYABLE); p.note(FAILURE_KIND.RETRYABLE); p.note(FAILURE_KIND.RETRYABLE);
t.ok('用完预算就停', !p.shouldRetry(FAILURE_KIND.RETRYABLE).retry);
t.ok('fatal 从不重试', !createRecoveryPolicy().shouldRetry(FAILURE_KIND.FATAL).retry);
t.ok('handoff 不重试', !createRecoveryPolicy().shouldRetry(FAILURE_KIND.NEEDS_HANDOFF).retry);
const p2 = createRecoveryPolicy();
t.ok('429 连续 3 次转 handoff', [1, 2, 3].map(() => p2.note(FAILURE_KIND.RATE_LIMIT)).pop() === FAILURE_KIND.NEEDS_HANDOFF);
const p3 = createRecoveryPolicy();
t.ok('压缩只给一次机会', p3.shouldRetry(FAILURE_KIND.NEEDS_COMPACT).retry
  && (p3.note(FAILURE_KIND.NEEDS_COMPACT), !p3.shouldRetry(FAILURE_KIND.NEEDS_COMPACT).retry));
t.ok('预算耗尽可查', createRecoveryPolicy({ maxRetries: 0 }).exhausted());
t.ok('snapshot 有字段', typeof createRecoveryPolicy().snapshot().elapsedMs === 'number');

t.ok('时间常量收口且为正数', ['llmIdleMs', 'toolMaxMs', 'toolNoticeMs', 'turnIdleMs']
  .every((k) => Number.isFinite(DEADLINES[k]) && DEADLINES[k] > 0), JSON.stringify(DEADLINES));

t.done();
