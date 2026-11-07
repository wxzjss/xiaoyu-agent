/** 指标：字段齐全、不阻塞、能落盘能读回、不写会话。 */
import { makeChecker } from './_harness_util.mjs';
import { appendMetrics, recentMetrics, createTurnMeter } from '../src/harness/telemetry.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../src/config.mjs';

const t = makeChecker('harness / telemetry');

const m = createTurnMeter('__check_harness__');
m.startRound();
m.endRound({ modelMs: 120, toolCount: 3, usage: { prompt_tokens: 4200 } });
m.noteParallel({ parallelLayers: 1, parallelCalls: 3, elapsedMs: 45 });
const s = m.summary();
for (const k of ['rounds', 'toolCount', 'parallelBatches', 'parallelHitRate', 'modelMs', 'toolMs', 'wallMs', 'promptTokens']) {
  t.ok('summary 有 ' + k, Object.prototype.hasOwnProperty.call(s, k));
}
t.ok('parallelHitRate 算对', s.parallelHitRate === 1, String(s.parallelHitRate));
t.ok('promptTokens 取真实 usage', s.promptTokens === 4200);

// 不阻塞：appendMetrics 必须立刻返回
const t0 = Date.now();
appendMetrics({ sessionId: '__check_harness__', kind: 'probe' });
t.ok('appendMetrics 立即返回（<50ms）', Date.now() - t0 < 50, (Date.now() - t0) + 'ms');

// 等异步 flush 落盘
await new Promise((r) => setTimeout(r, 250));
const file = path.join(config.dataDir, '.state', 'harness-metrics.jsonl');
t.ok('指标文件真的落盘了', fs.existsSync(file), file);
const rows = recentMetrics(20);
t.ok('能读回刚才那条', rows.some((x) => x.sessionId === '__check_harness__' && x.kind === 'probe'));
t.ok('每条都有时间戳', rows.every((x) => Number.isFinite(x.ts)));

// finish 返回完整记录
const rec = createTurnMeter('__check_harness__').finish({ kind: 'finish' });
t.ok('finish 返回记录且带 sessionId', rec.sessionId === '__check_harness__' && rec.kind === 'finish');

// 绝不碰会话文件
const sessDir = path.join(config.dataDir, '.state', 'sessions');
const before = fs.existsSync(sessDir) ? fs.readdirSync(sessDir).length : 0;
appendMetrics({ sessionId: '__check_harness__', kind: 'noop' });
const after = fs.existsSync(sessDir) ? fs.readdirSync(sessDir).length : 0;
t.ok('不新增任何会话文件', before === after, before + ' → ' + after);

t.done();
