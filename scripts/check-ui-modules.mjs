/**
 * 【模块化这块，守住四条】
 *
 * 主人 2026-11-08：「做 type="module"」。
 *
 * 三个 ui/*.js 变成了 ES 模块，这件事本身有几个**很容易悄悄坏掉**的点：
 *   ① script 标签漏了 type="module" → 文件里有 export/import，浏览器直接报语法错，整页白掉
 *   ② 模块忘了把函数挂回 window → 经典脚本按名字调，全是 undefined
 *   ③ 模块里裸用主脚本的 let/const（比如直接写 sessionId）→ ReferenceError，
 *      而且往往只在某条路径上炸，平时看不出来
 *   ④ 开机不等模块就位 → 白屏
 *
 * 这四条都用源码断言盯住，不需要浏览器。
 */
import { makeChecker } from './_harness_util.mjs';
import fs from 'node:fs';
import path from 'node:path';

const t = makeChecker('ui / 模块化');
const root = process.cwd();
const html = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
const read = (p) => fs.readFileSync(path.join(root, 'public', 'ui', p), 'utf8');

const UI = ['hub.js', 'sessions.js', 'chat.js'];

// ── ① 三个标签都是 module ────────────────────────────────────────
for (const f of UI) {
  t.ok(f + ' 用 type="module" 加载',
    new RegExp('<script type="module" src="/ui/' + f.replace('.', '\\.') + '"></script>').test(html));
}
t.ok('没有残留的普通 <script src="/ui/…">',
  !/<script src="\/ui\/[^"]+\.js"><\/script>/.test(html));

// ── ② 每个模块都有 export，并且挂回 window ───────────────────────
for (const f of UI) {
  const src = read(f);
  t.ok(f + ' 有 export', /^export (async )?function /m.test(src));
  t.ok(f + ' 把函数挂回 window',
    /Object\.assign\(window, \{[\s\S]{0,600}\}\)/.test(src));
}

// ── ③ 模块里不许裸用主脚本的 let/const ──────────────────────────
/* 这几个是最容易裸用的：会话 id / 在跑的轮次 / 谁在跑 / 滚动贴底。
 * 出现一次没加 window. 就是一条只在特定路径上才炸的 ReferenceError。 */
const WATCH = ['sessionId', 'turnsInFlight', 'runningSess', 'stickBottom', 'sessionsCache', 'bulkMode'];
for (const f of UI) {
  const src = read(f);
  const code = src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, ' ')
    .replace(/`(?:[^`\\]|\\.)*`/g, '``')
    .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '""');
  const bad = [];
  for (const n of WATCH) {
    const re = new RegExp('(^|[^.\\w$])' + n + '\\b', 'g');
    let m;
    while ((m = re.exec(code))) {
      const prev = code.slice(Math.max(0, m.index - 8), m.index + m[0].length - n.length);
      if (/window\.\s*$/.test(prev)) continue;
      const after = code.slice(m.index + m[0].length, m.index + m[0].length + 3);
      if (/^\s*:/.test(after)) continue;            // 对象字面量的键
      bad.push(n);
      break;
    }
  }
  t.ok(f + ' 没有裸用主脚本的全局', bad.length === 0, bad.join(', '));
}

// ── ④ 模块桥 + 开机等模块 ───────────────────────────────────────
t.ok('index.html 有「模块桥」', /function bridgeGlobalsForModules\(\)/.test(html));
for (const n of ['sessionId', 'runningSess', 'stickBottom', 'log', 'input', 'turnsInFlight']) {
  const direct = new RegExp("bind\\('" + n + "'").test(html);
  /* turnsInFlight 是 var，本来就在 window 上，不用桥 */
  t.ok('模块桥覆盖 ' + n, direct || n === 'turnsInFlight');
}
t.ok('开机等模块就位（DOMContentLoaded 之后再 bootSessions）',
  /document\.addEventListener\('DOMContentLoaded', r, \{ once: true \}\)[\s\S]{0,120}bootSessions\(\)/.test(html)
  && !/\nconst booted = bootSessions\(\);/.test(html));

/* ── ⑤ 顶层不许直接调用模块里的函数 ─────────────────────────────
 * 主人 2026-11-08 截图报的就是这个：
 *   Uncaught ReferenceError: refreshRunning is not defined（第 19390 行附近）
 *
 * 模块是 deferred，比经典脚本晚执行。顶层写 `refreshRunning()` 就是拿 undefined 当函数。
 * 更坏的是**这一行之后整段脚本都不执行**，可页面看着还行 —— 最难查的那种坏法。
 * 这里把主脚本里所有「顶格调用模块函数」的地方全揪出来。 */
const MOD_FNS = [
  'renderTurns', 'switchSession', 'switchSessionSafe', 'renderLog', 'logSettle',
  'logSetHistory', 'logSetLive', 'paintSnapshot', 'paintSnapshotInner', 'paintSnapshot0',
  'attachLive', 'followLive', 'replayInFlight', 'syncHubHead', 'hubRefreshTitle',
  'groupLooseTools', 'addTool', 'foldLiveTools', 'adoptThink', 'adoptTool',
  'thinkPeekTail', 'hubPeekOf', 'thinkTitleOf', 'refreshRunning', 'renderSessList',
];
const mainScript = [...html.matchAll(/<script(?![^>]*src)(?![^>]*type="module")[^>]*>([\s\S]*?)<\/script>/g)]
  .map((m) => m[1])
  .sort((a, b) => b.length - a.length)[0] || '';
const offenders = [];
for (const line of mainScript.split('\n')) {
  if (!line.trim()) continue;
  if (/^[\s\t]/.test(line)) continue;            // 缩进 = 在函数/回调里，那时模块已经就位
  if (/^(\/\/|\*|\/\*)/.test(line)) continue;    // 注释
  for (const n of MOD_FNS) {
    const at = line.indexOf(n);
    if (at < 0) continue;
    if (new RegExp('[^.\\w$]' + n + '\\b').test(line) === false && at !== 0) continue;
    /* 同一行里在它之前出现了 => 或 function，说明这是**定义**一个稍后才跑的闭包
     * （例如 window.__xySwitch = (id) => switchSession(id)）—— 那是安全的。 */
    const before = line.slice(0, at);
    if (/=>|\bfunction\b/.test(before)) continue;
    offenders.push(n);
    break;
  }
}
t.ok('顶层没有裸调模块函数（会 ReferenceError 并让后面整段不执行）',
  offenders.length === 0,
  offenders.join(', ') + '  ← 包一层 whenModulesReady');
t.ok('有 whenModulesReady 兜底', /function whenModulesReady\(fn\)/.test(html));

t.done();
