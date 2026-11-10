/**
 * Harness 统一出口。
 *
 * src/agent.mjs 只需要 import 这一处，不必关心底下六个模块怎么摆。
 * 六个模块的职责：
 *   tool-spec      能不能并行（单一真相）
 *   tool-protocol  调用怎么累积（增量 / 幂等 / 不丢批）
 *   scheduler      按依赖图分层执行
 *   recovery       失败分类与重试预算
 *   context-budget 真实 usage 驱动的预算（纯函数、无副作用）
 *   telemetry      每轮指标
 */

export * from './tool-spec.mjs';
export * from './tool-protocol.mjs';
export * from './scheduler.mjs';
export * from './recovery.mjs';
export * from './context-budget.mjs';
export * from './telemetry.mjs';
export * from './exec-shell.mjs';
export * from './turn-watchdog.mjs';
