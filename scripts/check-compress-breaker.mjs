#!/usr/bin/env node
/**
 * check-compress-breaker.mjs — 【压缩连败要止损，别每轮白花钱】
 *
 * 【2026-11-17 加·比市面上那几家少的最后一件】
 *
 * Claude Code 的 auto-compact 有明确的止损：连续 3 次失败就停手，
 * 还专门有「刚压完又被一个大文件塞满」的抖动检测。
 * 小鱼原来只有 fail-open（压不成就算，原文一条不动）——方向对，但没有止损：
 * 模型持续吐跑题稿时，每一轮都要问它一次、每一轮都失败，
 * 水位几小时不动，钱一轮一轮地烧。
 *
 * 这个哨兵钉四件事，而且**全部真跑**（不只 grep 源码）：
 *   ① 连败 3 次 → 闸门打开；
 *   ② 打开期间 compressBreakerOpen() 返回 true（上层据此跳过 L3）；
 *   ③ 成功一次 → 计数清零、闸门立刻关回去；
 *   ④ 冷却到点自动恢复（不用重启）。
 */
import fs from 'node:fs';
import { makeChecker } from './_harness_util.mjs';

const t = makeChecker('compress / 连败熔断');
const agent = fs.readFileSync('src/agent.mjs', 'utf8');

/* ── 接线：上层得真的用上它 ── */
t.ok('agent 导入了熔断 API', /compressBreakerOpen/.test(agent) && /noteCompressFailure/.test(agent));
t.ok('折叠前先看闸门（熔断时不问模型）',
  /_breakerOpen/.test(agent) && /&& !_breakerOpen/.test(agent));
t.ok('熔断时仍然跑 L2（只停 L3）', /只做 L2 瘦身|只做瘦身/.test(agent));
t.ok('压成了记成功、抛了记失败',
  /noteCompressSuccess\(sessionId\)/.test(agent) && /noteCompressFailure\(sessionId/.test(agent));

/* ── 行为：真跑一遍 ── */
{
  const mod = await import('../src/compress.mjs');
  const {
    compressBreakerOpen, noteCompressFailure, noteCompressSuccess,
    compressBreakerState, __resetCompressBreaker,
    COMPRESS_BREAKER_FAILS, COMPRESS_BREAKER_COOLDOWN_MS,
  } = mod;

  t.ok('默认阈值是 3 次', COMPRESS_BREAKER_FAILS === 3, String(COMPRESS_BREAKER_FAILS));
  t.ok('默认冷却是 30 分钟', Math.round(COMPRESS_BREAKER_COOLDOWN_MS / 60000) === 30,
    Math.round(COMPRESS_BREAKER_COOLDOWN_MS / 60000) + ' 分钟');

  const sid = '__probe_breaker_1';
  __resetCompressBreaker();

  t.ok('一开始不熔断', compressBreakerOpen(sid) === false);

  const o1 = noteCompressFailure(sid, '摘要被洗空');
  t.ok('第 1 次失败：不打开', o1 === false && compressBreakerOpen(sid) === false);
  const o2 = noteCompressFailure(sid, '摘要被洗空');
  t.ok('第 2 次失败：仍不打开', o2 === false && compressBreakerOpen(sid) === false);
  const o3 = noteCompressFailure(sid, '模型超时');
  t.ok('第 3 次失败：当场打开（返回 justOpened）', o3 === true);
  t.ok('打开后 compressBreakerOpen 为 true', compressBreakerOpen(sid) === true);

  const st = compressBreakerState(sid);
  t.ok('状态里记得住次数和最后原因',
    st.fails === 3 && /模型超时/.test(st.lastReason), JSON.stringify(st));
  t.ok('状态里给出「什么时候恢复」', st.openUntil > Date.now());

  /* 别的会话不许被连坐 */
  t.ok('另一个会话不受影响（按会话隔离）', compressBreakerOpen('__probe_breaker_other') === false);

  /* 成功清零 */
  noteCompressSuccess(sid);
  t.ok('成功一次闸门立刻关回去', compressBreakerOpen(sid) === false);
  t.ok('计数清零', compressBreakerState(sid).fails === 0);

  /* 冷却到点自动恢复：把「现在」拨到 openUntil 之后，不该真的 sleep 半小时 */
  __resetCompressBreaker();
  noteCompressFailure(sid, 'x');
  noteCompressFailure(sid, 'x');
  noteCompressFailure(sid, 'x');
  t.ok('冷却期内是打开的', compressBreakerOpen(sid) === true);
  {
    const st2 = compressBreakerState(sid);
    const later = st2.openUntil + 1000;
    t.ok('冷却到点自动恢复（不用重启）', compressBreakerOpen(sid, later) === false);
    t.ok('恢复之后状态里 open 也是 false', compressBreakerState(sid).open === false);
    /* 恢复后再失败一次就立刻再开（fails 保留，不从零数） */
    const o4 = noteCompressFailure(sid, '又失败');
    t.ok('恢复后再失败一次就立刻重新熔断（不从零数起）', o4 === true);
  }
  __resetCompressBreaker();
}

/* ── 关键：别把「这会儿不用压」误数成失败 ──
 * 这个坑很隐蔽：under-trigger 是每轮最常返回的结果（水位没到线），
 * 要是把它也数进连败，一个完全正常的会话三轮就被熔断了。 */
{
  const mod = await import('../src/compress.mjs');
  const skip = mod.isCompressSkipReason;
  t.ok('isCompressSkipReason 可用', typeof skip === 'function');
  if (typeof skip === 'function') {
    for (const r of ['under-trigger', 'aborted', 'disabled', 'too-few-messages(3)', 'head-too-big', 'nothing-safe-to-drop', 'whale-says-hold(model)']) {
      t.ok('「' + r + '」算正常跳过（不喂熔断）', skip(r) === true);
    }
    for (const r of ['summary-body-empty-keep-original', 'summary-failed-need-self-note', 'no-self-note-keep-original', 'still-over-limit', '模型超时']) {
      t.ok('「' + r + '」算真失败（喂熔断）', skip(r) === false);
    }
    t.ok('空原因不算失败', skip('') === false && skip(null) === false);
  }
  t.ok('agent 里真的用了这个分类', /isCompressSkipReason/.test(agent));
}

t.done();
