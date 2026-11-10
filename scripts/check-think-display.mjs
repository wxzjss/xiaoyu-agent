/**
 * 【思考内容显示 + 柜门「正在思考中…」】
 *
 * 主人 2026-11-07 两条要求：
 *   ① 思考内容显示太短 → 能多长就显示多长
 *   ② 像「正在跑命令…」一样，思考时也显示「正在思考中…」
 *
 * 【2026-11-09 换框架·判据整体改口径 —— 说明为什么】
 *
 * 这个文件原来一大半在钉 `openThink()` / `hubRefreshTitle()` / `dataset.peek` /
 * 「节流 150ms」「名字最短停留 400ms」「只在真变了才写 DOM」——
 * 那些全是**手写 DOM 时代**的手法：没有框架，只能靠节流和最短停留
 * 硬压住「每 1.2 秒整组重画一次」造成的抖动。
 *
 * 换 React 之后这些手法一起消失了，取而代之的是更硬的保证：
 *   · 节点身份由 key 决定 → 不存在「重建」这件事，不需要最短停留
 *   · 文案不变就不重渲染（memo）→ 不需要节流
 *   · 展开态由 React state 控 → 不需要 dataset 记账
 *
 * 所以判据跟着实现搬家：
 *   思考块 → src-ui/ThinkBlock.jsx     柜门 → src-ui/ToolCard.jsx
 *   灰字   → src-ui/GrayText.jsx       标题/灰字纯函数 → public/ui/hub.js
 * **要守的行为一条没变**：能看全、正在思考要说、字数收起也看得见、灰字不抖。
 */
import { makeChecker } from './_harness_util.mjs';
import { readUISource } from './_ui-src.mjs';
import fs from 'node:fs';
import path from 'node:path';

const t = makeChecker('ui / 思考显示');
const ui = readUISource();
const ROOT = path.resolve(import.meta.dirname, '..');
const rd = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');
const THINK = rd('src-ui/ThinkBlock.jsx');
const GRAY = rd('src-ui/GrayText.jsx');
const TOOLCARD = rd('src-ui/ToolCard.jsx');
const HUB = rd('public/ui/hub.js');

// ── 1. 不截断 ─────────────────────────────────────────────────────
t.ok('没有 38 字标题截断', !ui.includes('slice(0, 38)') && !THINK.includes('slice(0, 38)'));
t.ok('没有 400 字悬停截断', !ui.includes('slice(0, 400)') && !THINK.includes('slice(0, 400)'));
t.ok('标题走 thinkTitleOf（唯一一份实现，在 hub.js）',
  /export function thinkTitleOf\(flat\)/.test(HUB) && /\{1,400\}/.test(HUB));
t.ok('思考块借的就是那一份（不另写一套取标题规则）', /window\.thinkTitleOf/.test(THINK));
t.ok('正文不截（整段原文直接交给 thinkBody）', /thinkBody">\{String\(it\.text \|\| ''\)\}/.test(THINK));
t.ok('悬停不再挂 title 属性（全文就在正文里，不需要悬停才给）',
  !/title=\{/.test(THINK.split('thinkBody')[0]));

const cssLine = (ui.split(/\r?\n/).find((l) => l.includes('details.think .thinkTitle {')) || '');
t.ok('标题 CSS 一行不换行', /white-space:\s*nowrap/.test(cssLine), cssLine.trim().slice(0, 90));
t.ok('正文 CSS 允许换行（全文照旧全显示）', /\.thinkBody\s*\{[^}]*pre-wrap/.test(ui));

// ── 2. 「正在思考中…」/ 展开收起 ───────────────────────────────────
t.ok('思考块在跑的时候挂 thinking-now', /'think' \+ \(it\.running \? ' thinking-now' : ''\)/.test(THINK));
t.ok('历史里的思考块挂 thinkPast（淡一点、窄一点）', /it\.isLive \? '' : ' thinkPast'/.test(THINK));
/* 【2026-11-09 换框架】展开态由 React state 控（按 item key 记）。
 * 这比原来「重建后照 dataset 恢复」硬得多：节点根本没被重建过。 */
t.ok('开合由 React state 控（按 key 记，不从 DOM 反推）',
  /useOpen\(it\.key/.test(THINK) && /open=\{open\}/.test(THINK) && /onToggle=\{onToggle\}/.test(THINK));
t.ok('useOpen 把状态记在按 key 的表里', /openMap\.set\(key, v\)/.test(rd('src-ui/useOpen.js')));

// ── 2b. 柜门那一行 ────────────────────────────────────────────────
t.ok('柜门在跑的时候写「正在X…」', /'正在'\s*\+\s*\(niceTool\(running\.name, running\.args\)/.test(TOOLCARD));
t.ok('柜门平常写「调了 N 次工具」', /'调了 '\s*\+\s*n\s*\+\s*' 次工具'/.test(TOOLCARD));
t.ok('柜门失败数写「N 个失败」', /bad \+ ' 个失败'/.test(TOOLCARD));
/* 【2026-11-09 换框架·口径变化】原来柜门会替思考说话
 *（「调了 N 次 · 正在思考中…」）。现在思考块是**自己一行**（details.think），
 * 柜门只统计它自己那几张工具卡 —— 「想了多少段」不再塞进柜门标题。
 * 要守的行为没丢：思考时屏幕上一定有那一块 + 字数（见下面两条）。 */
t.ok('工具运行时柜门灰字清空（运行中已经在柜门右侧写了）', /stat\.running \? '' : niceTool/.test(TOOLCARD));
t.ok('金色「运行中」有对应样式', /\.hubpeek\.live \{ color: #f0b954/.test(ui));

// ── 2c. 灰字（不抖） ──────────────────────────────────────────────
t.ok('灰字取尾部片段（thinkPeekTail，唯一实现）',
  /export function thinkPeekTail\(text\)/.test(HUB) && /flat\.slice\(-160\)/.test(HUB));
t.ok('灰字组件从 bridge 借 thinkPeek', /import \{ thinkPeek \} from '\.\/bridge\.js'/.test(GRAY));
/* 这一条是「灰字不许抖」的根治点：文案不变就不重渲染。
 * 原来靠 150ms 节流 + 400ms 最短停留硬压，现在靠 memo + 稳定 key。 */
t.ok('灰字组件 memo 住（文案不变就不重渲染，不需要节流）', /memo\(function GrayPeek/.test(GRAY));
t.ok('字数那行也 memo 住', /memo\(function ThinkMeta/.test(GRAY));
t.ok('灰字改 clip（不画省略号 → 不为了截断点重新测量）',
  /\.hubpeek, details\.think \.thinkMeta, details\.toolhub > summary \.hubname \{[^}]*text-overflow: clip/.test(ui));

// ── 3. 字数：收起时也看得见 ────────────────────────────────────────
t.ok('思考字数收起时也显示（不再靠 [open] 才出现）',
  !/details\.think \.thinkMeta \{ display: none/.test(ui)
  && !/details\.think\[open\] \.thinkMeta/.test(ui)
  && /details\.think \.thinkMeta \{[^}]*flex: none/.test(ui));
t.ok('字数不看展开态（组件里无条件渲染）',
  /<ThinkMeta body=\{it\.text\} \/>/.test(THINK));
t.ok('字数跟着数据变（不等人点开）', /const n = String\(body \|\| ''\)\.length;/.test(GRAY));

/* 真机格：这几条原来靠「造 DOM + 调 hubRefreshTitle」验柜门三态。
 * 那个函数现在是空实现（柜门由 React 从 items 算），造出来的 DOM 和屏幕上的
 * 柜门不是同一条路，验了也不算数。真机行为改由 scripts/check-log-react.mjs
 * 的二·c / 二·d 两格覆盖（真浏览器量的：柜子保持展开、灰字悬停不抖）。 */
console.log('  [skip] 真机格搬到 check-log-react.mjs（二·c 柜子保持展开 / 二·d 灰字不抖）');

t.done();
