/**
 * 【2026-11-08 加】干完活不列清单 —— 站岗
 *
 * 主人原话：「这不是第一次了，别的会话也出现过，我要求根治」
 *
 * 背景：agent.mjs 里有 progressBlock 每轮提醒清单进度，但它只在**已经有清单**时才说话。
 * 一旦那个会话压根没建清单（活照干、文件照改），它就是一片静默，等于零保护。
 * 结果就是主人来问「清单都做完了？为什么没打勾」。
 *
 * 这里守三件事：
 *   1. plan.mjs 里 planEmptyHint / markToolTouched / resetToolTouched 三个函数都还在
 *   2. agent.mjs 真的调了它们（不是写了没人用 —— 以前就吃过这个亏）
 *   3. 行为对：没动手不说话、动过手且没清单要说话、有清单了闭嘴
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeChecker } from './_harness_util.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const t = makeChecker('清单缺失看守');

// ── 1. 三个函数都在 ─────────────────────────────────────────────
const planPath = path.join(ROOT, 'src', 'plan.mjs');
const planSrc = fs.readFileSync(planPath, 'utf8');
t.ok('plan.mjs 有 planEmptyHint', /export function planEmptyHint\b/.test(planSrc));
t.ok('plan.mjs 有 markToolTouched', /export function markToolTouched\b/.test(planSrc));
t.ok('plan.mjs 有 resetToolTouched', /export function resetToolTouched\b/.test(planSrc));

// ── 2. agent.mjs 真的在用 ───────────────────────────────────────
const agentSrc = fs.readFileSync(path.join(ROOT, 'src', 'agent.mjs'), 'utf8');
t.ok('agent.mjs 从 plan.mjs 引了这三个', /import\s*\{[^}]*planEmptyHint[^}]*\}\s*from\s*'\.\/plan\.mjs'/.test(agentSrc));
t.ok('agent.mjs 跑完工具会 markToolTouched()', /markToolTouched\s*\(/.test(agentSrc));
t.ok('agent.mjs 每轮开头 resetToolTouched()', /resetToolTouched\s*\(/.test(agentSrc));
t.ok('提醒真的塞进 toolContent 了', /toolContent\s*=\s*_need/.test(agentSrc));

// ── 3. 行为验证 ─────────────────────────────────────────────────
const { planEmptyHint, markToolTouched, resetToolTouched, planAction } = await import('../src/plan.mjs');
const k = '__gate_probe_' + Date.now();

resetToolTouched();
const a = planEmptyHint(k);
t.ok('没动手 → 不说话', a === '', JSON.stringify(a));
markToolTouched();
const warn = planEmptyHint(k);
t.ok('动过手没清单 → 要说话', warn.length > 0 && warn.includes('清单缺失'));
planAction(k, { action: 'create', goal: '探针', steps: ['甲', '乙'] });
const c = planEmptyHint(k);
t.ok('有清单了 → 闭嘴', c === '', JSON.stringify(c));
resetToolTouched();

// 清掉探针清单
try {
  const f = path.join(ROOT, '.state', 'plan', k + '.json');
  if (fs.existsSync(f)) fs.unlinkSync(f);
  const f2 = path.join(ROOT, '..', '.state', 'plan', k + '.json');
  if (fs.existsSync(f2)) fs.unlinkSync(f2);
} catch {}

t.done();
