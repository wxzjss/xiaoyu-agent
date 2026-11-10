/**
 * 【每轮指标】
 *
 * 以前判断「她为什么慢」只能翻会话文件数 tool_calls（【检查鱼】265 轮、
 * 【上下文】30 次工具都是这么数出来的）。现在每轮自己记一笔，
 * 下次直接看 .state/harness-metrics.jsonl，不用再考古。
 *
 * 三条原则：不阻塞主流程、文件有上限、只追加不改写任何会话。
 */

import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.mjs';

const FILE = path.join(config.dataDir, '.state', 'harness-metrics.jsonl');
const MAX_BYTES = 2 * 1024 * 1024;
const MAX_LINES = 4000;

let queue = [];
let flushing = false;

function rotateIfNeeded() {
  try {
    const st = fs.statSync(FILE);
    if (st.size <= MAX_BYTES) return;
    const old = FILE + '.1';
    try { fs.unlinkSync(old); } catch {}
    fs.renameSync(FILE, old);
  } catch {}
}

function flush() {
  if (flushing || !queue.length) return;
  flushing = true;
  const batch = queue;
  queue = [];
  // setImmediate：别让一次磁盘写卡住模型那一轮
  setImmediate(() => {
    try {
      fs.mkdirSync(path.dirname(FILE), { recursive: true });
      rotateIfNeeded();
      fs.appendFileSync(FILE, batch.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
    } catch (e) {
      // 指标写失败不该影响干活，但要留个痕，别变成「什么都没发生」
      try { console.warn('[harness-metrics] 写失败：' + String((e && e.message) || e)); } catch {}
    } finally {
      flushing = false;
      if (queue.length) flush();
    }
  });
}

export function appendMetrics(record) {
  if (!record || typeof record !== 'object') return;
  queue.push({ ts: Date.now(), ...record });
  flush();
}

/** 读最近 n 条（给检查脚本 / 以后做面板用） */
export function recentMetrics(n = 50) {
  try {
    const lines = fs.readFileSync(FILE, 'utf8').trim().split(/\r?\n/).filter(Boolean);
    return lines.slice(-Math.max(1, Math.min(n, MAX_LINES))).map((l) => {
      try { return JSON.parse(l); } catch { return null; }
    }).filter(Boolean);
  } catch { return []; }
}

/**
 * 一轮的计量器。
 * 用法：
 *   const m = createTurnMeter(sessionId);
 *   m.startRound(); ... m.endRound({ modelMs, toolCount, usage });
 *   m.noteParallel(stats);
 *   m.finish();   // 落一行
 */
export function createTurnMeter(sessionId) {
  const t0 = Date.now();
  let rounds = 0;
  let toolCount = 0;
  let parallelBatches = 0;
  let parallelCalls = 0;
  let modelMs = 0;
  let toolMs = 0;
  let lastUsage = null;
  let openAt = 0;

  return {
    startRound() { openAt = Date.now(); },
    endRound({ modelMs: ms = 0, toolCount: n = 0, usage = null } = {}) {
      rounds++;
      modelMs += Number(ms) || 0;
      toolCount += Number(n) || 0;
      if (usage) lastUsage = usage;
      openAt = 0;
    },
    noteParallel(stats) {
      if (!stats) return;
      parallelBatches += Number(stats.parallelLayers ?? stats.parallelBatches) || 0;
      parallelCalls += Number(stats.parallelCalls) || 0;
      toolMs += Number(stats.elapsedMs) || 0;
    },
    /** 给 done 事件附的摘要（新增字段，不改旧字段） */
    summary() {
      return {
        rounds, toolCount, parallelBatches,
        parallelHitRate: toolCount ? Math.round((parallelCalls / toolCount) * 100) / 100 : 0,
        modelMs, toolMs, wallMs: Date.now() - t0,
        promptTokens: Number(lastUsage?.prompt_tokens) || 0,
      };
    },
    finish(extra = {}) {
      const rec = { sessionId: String(sessionId || 'default'), ...this.summary(), ...extra };
      appendMetrics(rec);
      return rec;
    },
  };
}
