/**
 * 【思考档位：只许四档，而且发出去的参数不能错】
 *
 * 主人 2026-11-09 定：
 *   「把思考档位只保留 deepseek 官方的那种低、高与最高」→ 再补一句「还有一个【关】」
 *   「默认档位为高」
 *
 * 之前是抄 dsh 的八档（off/on/minimal/low/medium/high/xhigh/max + auto），实测两个坑：
 *   · 「开」只发 thinking:{type:'enabled'}，在这个接入点上**一段思考都没有**，
 *     长会话里直接退化成整轮只回一句「嗯，我在」；
 *   · 带上 thinking 字段时 reasoning_effort 会被网关忽略（同一句话实测）。
 *
 * 所以现在：只留 关/低/高/最高，默认高，而且**强度档只发 reasoning_effort，不带 thinking**。
 */
import { makeChecker } from './_harness_util.mjs';
import fs from 'node:fs';
import path from 'node:path';

const t = makeChecker('thinking / 档位');
const root = process.cwd();
const src = fs.readFileSync(path.join(root, 'src', 'thinking.mjs'), 'utf8');
const html = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');

const mod = await import('../src/thinking.mjs');

// ── ① 只剩四档 ────────────────────────────────────────────────
const ids = mod.LEVELS.map((l) => l.id);
t.ok('档位正好四个', mod.LEVELS.length === 4, ids.join(','));
t.ok('就是 关/低/高/最高', ids.join(',') === 'off,low,high,max', ids.join(','));

// ── ② 老值都能落到四档里，不会卡住 ────────────────────────────
/* 【2026-11-11 改·主人要求「模型页的思考档位在系统里默认设为【关】」】
 * 兜底档从 high 改成 off 之后，认不出来的老值也该落到 off（而不是回到高）。
 * 这里把期望一起改掉 —— 不改的话这条检查会拿旧口径去拦新行为。 */
const CASES = [
  ['off', 'off'], ['low', 'low'], ['high', 'high'], ['max', 'max'],
  ['on', 'off'], ['minimal', 'low'], ['medium', 'off'], ['xhigh', 'max'],
  ['auto', 'off'], ['', 'off'], ['胡说八道', 'off'],
];
for (const [input, want] of CASES) {
  const got = mod.normalizeLevel(input);
  t.ok('老值 ' + JSON.stringify(input) + ' → ' + want, got === want, got);
}

// ── ③ 默认关 ──────────────────────────────────────────────────
t.ok('没设过就是「关」（主人 2026-11-11 定的系统默认）', /const level = normalizeLevel\(raw\.level\)/.test(src)
  && /return 'off';\s*\n\}/.test(src));

// ── ④ 发出去的字段：强度档不许再带 thinking ────────────────────
const fOff = mod.fieldsForLevel('off');
t.ok('关：显式发 disabled', JSON.stringify(fOff.fields).indexOf('"disabled"') >= 0, JSON.stringify(fOff.fields));
for (const lv of ['low', 'high', 'max']) {
  const f = mod.fieldsForLevel(lv);
  t.ok(lv + '：只发 reasoning_effort',
    JSON.stringify(f.fields) === JSON.stringify({ reasoning_effort: lv }),
    JSON.stringify(f.fields));
  t.ok(lv + '：不带 thinking（带了会被网关忽略 effort）', f.fields.thinking === undefined);
}

// ── ⑤ 前端兜底表跟后端一致 ────────────────────────────────────
const fb = html.slice(html.indexOf('const FALLBACK_LEVELS'), html.indexOf('const FALLBACK_LEVELS') + 600);
const fbIds = [...fb.matchAll(/id:\s*'([a-z]+)'/g)].map((m) => m[1]);
t.ok('前端兜底表也是四个', fbIds.join(',') === 'off,low,high,max', fbIds.join(','));

// ── ⑥ 删掉的档位不许在源码里复活 ──────────────────────────────
t.ok('thinking.mjs 里没有 xhigh/minimal 的档位定义',
  !/id:\s*'(xhigh|minimal|medium|auto|on)'/.test(src));

t.done();
