/**
 * 【思考档位：六档，而且发出去的参数不能错】
 *
 * 主人 2026-11-09 定：「把思考档位只保留 deepseek 官方的那种低、高与最高」→ 再补「还有一个【关】」，「默认档位为高」。
 * 【2026-11-16 主人再定】对照 WorkBuddy（low/medium/high/xhigh，中文「超高」）补齐：
 *   加「中」(medium，OpenAI 官方值) 与「超高」(xhigh，部分网关扩展值，不认就走降档链)。
 *
 * 之前是抄 dsh 的八档（off/on/minimal/low/medium/high/xhigh/max + auto），实测两个坑：
 *   · 「开」只发 thinking:{type:'enabled'}，在这个接入点上**一段思考都没有**，
 *     长会话里直接退化成整轮只回一句「嗯，我在」；
 *   · 带上 thinking 字段时 reasoning_effort 会被网关忽略（同一句话实测）。
 *
 * 所以现在：六档 关/低/中/高/超高/最高，默认高，强度档只发 reasoning_effort，不带 thinking。
 */
import { makeChecker } from './_harness_util.mjs';
import fs from 'node:fs';
import path from 'node:path';
const __ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
import { fileURLToPath } from 'node:url';

const t = makeChecker('thinking / 档位');
const root = __ROOT;
const src = fs.readFileSync(path.join(root, 'src', 'thinking.mjs'), 'utf8');
const html = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');

const mod = await import('../src/thinking.mjs');

// ── ① 六档 ────────────────────────────────────────────────
const ids = mod.LEVELS.map((l) => l.id);
t.ok('档位正好六个', mod.LEVELS.length === 6, ids.join(','));
t.ok('就是 关/低/中/高/超高/最高', ids.join(',') === 'off,low,medium,high,xhigh,max', ids.join(','));

// ── ② 老值都能落到六档里，不会卡住 ────────────────────────────
/* 【2026-11-16 档位扩容】medium / xhigh 不再折算 —— 它们是真档位了。
 * minimal 仍折 low；on/auto/空/乱写仍落 high。 */
const CASES = [
  ['off', 'off'], ['low', 'low'], ['medium', 'medium'], ['high', 'high'],
  ['xhigh', 'xhigh'], ['max', 'max'],
  ['on', 'high'], ['minimal', 'low'],
  ['auto', 'high'], ['', 'high'], ['胡说八道', 'high'],
];
for (const [input, want] of CASES) {
  const got = mod.normalizeLevel(input);
  t.ok('老值 ' + JSON.stringify(input) + ' → ' + want, got === want, got);
}

// ── ③ 兜底口径：跟界面默认显示一致（2026-11-15 主人改回 high） ──
t.ok('没设过跟「高」一致（display 与勾选同一口径）', /const level = normalizeLevel\(raw\.level\)/.test(src)
  && /return 'high';\s*\n\}/.test(src));

// ── ④ 发出去的字段：强度档不许再带 thinking ────────────────────
const fOff = mod.fieldsForLevel('off');
t.ok('关：显式发 disabled', JSON.stringify(fOff.fields).indexOf('"disabled"') >= 0, JSON.stringify(fOff.fields));
for (const lv of ['low', 'medium', 'high', 'xhigh', 'max']) {
  const f = mod.fieldsForLevel(lv);
  t.ok(lv + '：只发 reasoning_effort',
    JSON.stringify(f.fields) === JSON.stringify({ reasoning_effort: lv }),
    JSON.stringify(f.fields));
  t.ok(lv + '：不带 thinking（带了会被网关忽略 effort）', f.fields.thinking === undefined);
}

// ── ⑤ 降档链把新档排进强度梯度 ────────────────────────────────
const order = src.match(/const EFFORT_ORDER = \[([^\]]+)\]/)?.[1] || '';
t.ok('EFFORT_ORDER 是 low→medium→high→xhigh→max',
  order.replace(/[\s']/g, '') === 'low,medium,high,xhigh,max', order.trim());

// ── ⑥ 前端兜底表跟后端一致 ────────────────────────────────────
const fb = html.slice(html.indexOf('const FALLBACK_LEVELS'), html.indexOf('const FALLBACK_LEVELS') + 700);
const fbIds = [...fb.matchAll(/id:\s*'([a-z]+)'/g)].map((m) => m[1]);
t.ok('前端兜底表也是六个', fbIds.join(',') === 'off,low,medium,high,xhigh,max', fbIds.join(','));

// ── ⑦ 删掉的档位不许在源码里复活（minimal/auto/on 仍是非法档位） ──
t.ok('thinking.mjs 里没有 minimal/auto/on 的档位定义',
  !/id:\s*'(minimal|auto|on)'/.test(src));

t.done();
