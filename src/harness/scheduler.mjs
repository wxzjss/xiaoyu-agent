/**
 * 【依赖图调度器】
 *
 * 重做前（agent.mjs:1526-1584）：只有「同一响应里、连续 ≥2 个、全部只读」
 * 才 Promise.all；写类永久串行；主 for 仍逐条 await，并发结果靠 _poMap 旁路塞回。
 * 那是一块窄补丁，不是调度能力 —— 模型发 1 个还是 5 个，全看它自己心情。
 *
 * 这里：按依赖元数据切执行层，无依赖的同批并行，有副作用的分层串行。
 * 事件序列可以交给调度器（独立用/测试时），也可以交回调用方（接入老主循环时），
 * 后者保证现网「tool_start / tool_end 一条条走」的语义一个字不变。
 */

import { groupLayers, classifyCall } from './tool-spec.mjs';
import { makeIdempotencyKey } from './tool-protocol.mjs';

/** 幂等账本：断流续传 / 重复交付时，同一个键只真正跑一次工具。 */
const IDEM = new Map();
const IDEM_MAX = 400;

export function clearIdempotency(sessionId) {
  const pre = String(sessionId || 'default') + '|';
  for (const k of [...IDEM.keys()]) if (k.startsWith(pre)) IDEM.delete(k);
}

export function idempotencySize() { return IDEM.size; }

/** 切层（导出给检查脚本直接验） */
export function plan(calls) {
  return groupLayers(calls);
}

/** 这轮的分层统计 */
export function layerStats(layers) {
  const total = layers.reduce((n, l) => n + l.length, 0);
  const parallelLayers = layers.filter((l) => l.length > 1).length;
  const parallelCalls = layers.filter((l) => l.length > 1).reduce((n, l) => n + l.length, 0);
  return {
    layers: layers.length,
    totalCalls: total,
    parallelLayers,
    parallelCalls,
    maxLayerSize: layers.reduce((m, l) => Math.max(m, l.length), 0),
    parallelHitRate: total ? parallelCalls / total : 0,
  };
}

function withTimeout(p, ms) {
  if (!ms || ms <= 0) return Promise.resolve(p);
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('这个工具超过 ' + Math.round(ms / 1000) + ' 秒没返回')), ms);
    Promise.resolve(p).then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); },
    );
  });
}

/**
 * 执行一批调用。
 *
 * @param {Array} calls  形如 {id, function:{name,arguments}}
 * @param {object} opts
 *   runTool(name, args, sessionId, signal) -> {ok, output, images}
 *   onEvent(ev)             事件回调（emitEvents 为 true 时由本函数发 tool_start/tool_end）
 *   emitEvents  默认 true；接进老主循环时传 false，事件仍由主循环一条条发
 *   sessionId / round      幂等键用
 *   signal / timeoutMs
 *   onlyParallelLayers     只预跑「层内 ≥2 个」的只读批；单个调用和写操作留给
 *                          调用方自己跑（它那边有更精细的超时/中止/图片处理）
 *   onResult(call, result) 每跑完一个的钩子（可选）
 * @returns {{ results: Map<id,result>, byIndex: Array, stats: object }}
 */
export async function executeBatch(calls, opts = {}) {
  const list = Array.isArray(calls) ? calls.filter(Boolean) : [];
  const {
    runTool,
    onEvent = () => {},
    emitEvents = true,
    sessionId = 'default',
    round = 0,
    signal,
    timeoutMs = 0,
    onlyParallelLayers = false,
    onResult = () => {},
  } = opts;

  const results = new Map();
  const byIndex = new Array(list.length).fill(null);
  const posOf = new Map();
  list.forEach((c, i) => posOf.set(c.id || ('__i_' + i), i));

  const layers = plan(list);
  const startedAt = Date.now();

  for (const layer of layers) {
    if (signal && signal.aborted) break;
    /* 接进老主循环时只接管「真能同时跑」的那一层；
     * 单个工具、写操作交给主循环，它那边的超时/中止/图片处理更细。 */
    if (onlyParallelLayers && layer.length < 2) continue;
    const outs = await Promise.all(layer.map(async (c) => {
      const fn = c.function || c;
      const name = String(fn.name || '');
      const args = String(fn.arguments == null ? '' : fn.arguments);
      const key = makeIdempotencyKey(sessionId, round, c.id || name);

      if (IDEM.has(key)) return IDEM.get(key);

      if (emitEvents) {
        try { onEvent({ type: 'tool_start', id: c.id, name, args }); } catch {}
      }
      let r;
      try {
        r = await withTimeout(
          Promise.resolve().then(() => runTool(name, args, sessionId, signal)),
          timeoutMs,
        );
        if (!r) r = { ok: false, output: '（没有返回内容）' };
      } catch (e) {
        r = { ok: false, output: String((e && e.message) || e) };
      }
      if (emitEvents) {
        try {
          onEvent({
            type: 'tool_end', id: c.id, name,
            ok: Boolean(r.ok), output: r.output, images: r.images,
          });
        } catch {}
      }
      IDEM.set(key, r);
      if (IDEM.size > IDEM_MAX) IDEM.delete(IDEM.keys().next().value);
      try { onResult(c, r); } catch {}
      return r;
    }));

    layer.forEach((c, k) => {
      const r = outs[k];
      results.set(c.id, r);
      const i = posOf.get(c.id || ('__i_' + list.indexOf(c)));
      if (Number.isInteger(i)) byIndex[i] = r;
    });
  }

  return {
    results,
    byIndex,
    stats: { ...layerStats(layers), elapsedMs: Date.now() - startedAt, serial: classifyCall(list[0] || {}).sideEffect },
  };
}
