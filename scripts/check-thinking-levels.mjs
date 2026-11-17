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
import { fileURLToPath } from 'node:url';

const __ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const t = makeChecker('thinking / 档位');
const root = __ROOT;
const src = fs.readFileSync(path.join(root, 'src', 'thinking.mjs'), 'utf8');
const html = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
/* 【2026-11-17 加】还要验 server 的新会话默认值、以及 llm 的降档分支 */
const srv = fs.readFileSync(path.join(root, 'src', 'server.mjs'), 'utf8');
const agentSrc = fs.readFileSync(path.join(root, 'src', 'llm.mjs'), 'utf8');

const mod = await import('../src/thinking.mjs');

// ── ① 七档（2026-11-17 加回「自动」） ──────────────────────
const ids = mod.LEVELS.map((l) => l.id);
t.ok('档位正好七个', mod.LEVELS.length === 7, ids.join(','));
t.ok('就是 自动/关/低/中/高/超高/最高', ids.join(',') === 'auto,off,low,medium,high,xhigh,max', ids.join(','));
/* 自动排第一位：界面按数组顺序画选项，主人最常选的那个放最上面 */
t.ok('自动排第一个', ids[0] === 'auto', ids[0]);
t.ok('默认档位就是自动', mod.DEFAULT_LEVEL === 'auto', mod.DEFAULT_LEVEL);

// ── ② 老值都能落到七档里，不会卡住 ────────────────────────────
/* 【2026-11-17 改】默认从 high 变成 auto（主人钦点）。
 * 认不出的、空的一律落 auto —— 它比写死 high 更贴合实际（每轮现算）。 */
const CASES = [
  ['auto', 'auto'], ['off', 'off'], ['low', 'low'], ['medium', 'medium'],
  ['high', 'high'], ['xhigh', 'xhigh'], ['max', 'max'],
  ['minimal', 'low'],
  ['on', 'auto'], ['', 'auto'], ['胡说八道', 'auto'],
];
for (const [input, want] of CASES) {
  const got = mod.normalizeLevel(input);
  t.ok('老值 ' + JSON.stringify(input) + ' → ' + want, got === want, got);
}

// ── ③ auto 真的会按「干不干活」解析成具体档位 ──────────────────
t.ok('auto + 有工具 → high', mod.resolveLevel('auto', { hasTools: true }) === 'high');
t.ok('auto + 没工具 → low', mod.resolveLevel('auto', { hasTools: false }) === 'low');
t.ok('auto + toolHeavy → high', mod.resolveLevel('auto', { toolHeavy: true }) === 'high');
t.ok('auto + 空 ctx → low（当聊天）', mod.resolveLevel('auto', {}) === 'low');
/* 显式选的档位一个字都不许被 auto 逻辑改动 */
for (const lv of ['off', 'low', 'medium', 'high', 'xhigh', 'max']) {
  t.ok('显式 ' + lv + ' 原样返回', mod.resolveLevel(lv, { hasTools: true }) === lv);
}
/* 网关绝不能收到 'auto' 这个字面值 */
t.ok('fieldsForLevel 绝不会把 auto 漏给网关',
  JSON.stringify(mod.fieldsForLevel('auto', { baseURL: 'https://api.openai.com/v1', model: 'x' }))
    .indexOf('"auto"') < 0);

// ── ④ 兜底口径：跟界面默认显示一致（2026-11-17 改为 auto） ──────
t.ok('没设过落 auto（display 与勾选同一口径）', /const level = normalizeLevel\(raw\.level\)/.test(src)
  && /return DEFAULT_LEVEL;/.test(src));

// ── ⑤ 发出去的字段：强度档不许再带 thinking ────────────────────
const fOff = mod.fieldsForLevel('off');
t.ok('关：显式发 disabled', JSON.stringify(fOff.fields).indexOf('"disabled"') >= 0, JSON.stringify(fOff.fields));
for (const lv of ['low', 'medium', 'high', 'xhigh', 'max']) {
  const f = mod.fieldsForLevel(lv);
  t.ok(lv + '：只发 reasoning_effort',
    JSON.stringify(f.fields) === JSON.stringify({ reasoning_effort: lv }),
    JSON.stringify(f.fields));
  t.ok(lv + '：不带 thinking（带了会被网关忽略 effort）', f.fields.thinking === undefined);
}

// ── ⑥ 降档链把新档排进强度梯度 ────────────────────────────────
const order = src.match(/const EFFORT_ORDER = \[([^\]]+)\]/)?.[1] || '';
t.ok('EFFORT_ORDER 是 low→medium→high→xhigh→max',
  order.replace(/[\s']/g, '') === 'low,medium,high,xhigh,max', order.trim());

// ── ⑦ 前端兜底表跟后端一致 ────────────────────────────────────
const fb = html.slice(html.indexOf('const FALLBACK_LEVELS'), html.indexOf('const FALLBACK_LEVELS') + 800);
const fbIds = [...fb.matchAll(/id:\s*'([a-z]+)'/g)].map((m) => m[1]);
t.ok('前端兜底表也是七个', fbIds.join(',') === 'auto,off,low,medium,high,xhigh,max', fbIds.join(','));
t.ok('前端初始值也是 auto（别先闪一下别的档）', /level:\s*'auto'/.test(html));

// ── ⑧ 新会话默认档位 = auto ──────────────────────────────────
t.ok('新会话默认档位是 auto', /const NEW_SESSION_DEFAULT_LEVEL = 'auto'/.test(srv));
t.ok('新会话落盘用常量而不是硬编码 low', !/setOverride\(id, \{ level: 'low' \}\)/.test(srv));

// ── ⑨ 「值不被认」能降一档（xhigh 在官方 OpenAI 会 400） ────────
t.ok('有 isEffortValueRejected 判据', typeof mod.isEffortValueRejected === 'function');
t.ok('xhigh 被拒能认出来', mod.isEffortValueRejected(400, 'unsupported reasoning effort: xhigh') === true);
t.ok('key 错不该被当成档位问题', mod.isEffortValueRejected(400, 'invalid api key') === false);
t.ok('5xx 不该被当成档位问题', mod.isEffortValueRejected(500, 'unsupported reasoning effort') === false);
t.ok('llm.mjs 主路径会降一档', /isEffortValueRejected\(r\.status, lastText\)/.test(agentSrc));

// ── ⑩ 删掉的档位不许在源码里复活（minimal/on 仍是非法档位） ──────
t.ok('thinking.mjs 里没有 minimal/on 的档位定义',
  !/id:\s*'(minimal|on)'/.test(src));

// ── ⑪ 描述不许太长（长了会把档位名挤成竖排，2026-11-17 主人报过） ──────
{
  const longest = mod.LEVELS.reduce((a, l) => (String(l.desc || "").length > String(a.desc || "").length ? l : a), { desc: "" });
  t.ok("最长描述不超过 12 字（超了容易把名字挤扁）", String(longest.desc || "").length <= 12,
    longest.name + ": " + longest.desc);
  /* 前端兜底表同理 */
  const fbl = [...fb.matchAll(/desc:s*'([^']+)'/g)].map((m) => m[1]);
  const fl = fbl.reduce((a, d) => (d.length > a.length ? d : a), "");
  t.ok("前端兜底表描述也不超 12 字", fl.length <= 12, fl);
  /* 菜单项名字不许缩、不许换行 —— 这是竖排的直接原因 */
  t.ok('档位名有 flex:0 0 auto + nowrap 保护', html.includes('.cfgMenuItem > span:not(.ck):not(.desc)'));
}

t.done();
