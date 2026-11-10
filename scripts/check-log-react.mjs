#!/usr/bin/env node
/**
 * 【2026-11-09 换框架】对话区（#log）改 React 之后的守卫。
 *
 * 这个检查分两层，缺一不可：
 *
 *  一、**源码层**（快，不起浏览器）
 *      · #log 内部不许再有手写 DOM 创建（那是一切「两套账」的来源）
 *      · 规格 5.3 列的旧函数必须真的没了（不是改了名继续活在别处）
 *      · 产物 public/ui/log.bundle.js 必须在仓库里（发布物不带 node_modules）
 *
 *  二、**行为层**（真浏览器 + CDP + 隔离实例）
 *      验的是主人眼睛看到的东西，不是实现细节：
 *        a 正常一轮（说→工具→说）：屏幕上几段、每段出现几次
 *        b 流式中 F5：刷新后不重复、不堆叠、滚动位置不在顶部
 *        c 展开柜子后她发新消息：柜子保持展开、滚动不往旧位置弹
 *        d 鼠标移到思考灰字上：位置不抖（两次 getBoundingClientRect 位移 < 1px）
 *
 * 全程走隔离实例（临时数据目录 + 独立无头 Edge + 独立 CDP 端口），不碰主人正在用的实例。
 *
 * 用法：node scripts/check-log-react.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { startIsolated } from './_test-instance.mjs';
import { connect } from '../_t_cdp.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0;
let fail = 0;
const ok = (cond, name, extra) => {
  if (cond) { pass++; console.log('  OK   ' + name); }
  else { fail++; console.log('  [!!] ' + name + (extra ? '  → ' + extra : '')); }
};
const read = (p) => {
  try { return fs.readFileSync(path.join(ROOT, p), 'utf8'); } catch (e) { return ''; }
};

/* 把注释剥掉再判 —— 注释里提到旧函数名是正常的（我们在注释里解释了为什么删） */
function stripComments(src) {
  return String(src || '')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:\\])\/\/[^\n]*/g, '$1 ');
}

const cnt = (hay, needle) => String(hay || '').split(needle).length - 1;

/* ══════════════════════════════════════════════════════════════════
 * 一、源码层
 * ══════════════════════════════════════════════════════════════════ */
function caseSource() {
  console.log('\n一、源码层：不再有第二条往 #log 写 DOM 的路');

  const chat = read('public/ui/chat.js');
  const hub = read('public/ui/hub.js');
  const html = read('public/index.html');
  const chatCode = stripComments(chat);
  const hubCode = stripComments(hub);
  const htmlCode = stripComments(html);

  /* 1. 规格 5.3 的删除清单 —— chat.js 侧 8 个 */
  for (const name of ['paintSnapshot', 'paintSnapshotInner', 'paintSnapshot0', 'tryLiveAppendFast', 'adoptThink', 'adoptTool', 'liveItemsFeed', 'itemsFromEvents']) {
    ok(!new RegExp('function\\s+' + name + '\\s*\\(').test(chatCode), 'chat.js 里没有 ' + name + '（已被 React 渲染取代）');
  }
  ok(!/document\.createElement/.test(chatCode), 'chat.js 里一次 document.createElement 都没有',
    '出现 ' + cnt(chatCode, 'document.createElement') + ' 次');

  /* 2. hub.js：柜子的 DOM 搬移全废，只剩纯函数 */
  ok(!/document\.createElement/.test(hubCode), 'hub.js 里不再建任何节点（柜子交给渲染层）');
  for (const name of ['addTool', 'adoptThink', 'adoptTool', 'foldLiveTools', 'groupLooseTools', 'hubRefreshTitle']) {
    ok(new RegExp('function\\s+' + name + '\\s*\\(').test(hubCode), 'hub.js 保留 ' + name + ' 的名字（外面还在调，删了会 ReferenceError）');
  }

  /* 3. index.html：规格 5.3 列的那一批绘制函数必须整段没了 */
  const gone = [
    'addAssistant', 'addAssistantAuto', 'openThink', 'paintReasoning',
    'addWhaleBubble', 'pushStreamText', 'paintHistWorkerCard', '_paintWorkerCardCore',
    'paintLiveEvents', 'tryLiveAppendFast', 'itemsFromEvents', 'snapshotFingerprint',
    'liveItemsFeed', 'liveModelPaint', 'liveModelOpen', 'whaleStreamStart',
    'whaleStreamDelta', 'whaleStreamFinish', 'paintSpeech',
  ];
  const stillThere = gone.filter((n) => new RegExp('function\\s+' + n + '\\s*\\(').test(htmlCode));
  ok(stillThere.length === 0, 'index.html 里那批手写 DOM 绘制函数整段删掉了（' + gone.length + ' 个）',
    stillThere.length ? '还在：' + stillThere.join(', ') : '');

  /* 4. 允许留空壳的两个（外面调用点太多），但**不许再碰 DOM** */
  for (const n of ['stampSpeechNode', 'flushSpeech', 'addSysNote', 'addUser']) {
    const m = new RegExp('function\\s+' + n + '\\s*\\([^)]*\\)\\s*\\{([\\s\\S]{0,1200}?)\\n\\}').exec(htmlCode);
    ok(!!m, 'index.html 保留了 ' + n + '（调用点太多，不能删名字）');
    if (m) {
      const body = m[1];
      ok(!/appendChild|innerHTML\s*=|document\.createElement/.test(body),
        n + ' 的壳里没有任何写 DOM 的动作', body.replace(/\s+/g, ' ').slice(0, 120));
    }
  }

  /* 5. 没有「往 #log 里塞节点」的写法 */
  const bad = [
    [/log\.appendChild\s*\(/, 'log.appendChild('],
    [/log\.innerHTML\s*=/, 'log.innerHTML ='],
    [/log\.replaceChildren\s*\(/, 'log.replaceChildren('],
    [/getElementById\(\s*['"]log['"]\s*\)\.appendChild/, "getElementById('log').appendChild"],
    [/getElementById\(\s*['"]log['"]\s*\)\.innerHTML\s*=/, "getElementById('log').innerHTML ="],
  ];
  for (const [re, label] of bad) {
    const inHtml = re.test(htmlCode);
    const inChat = re.test(chatCode);
    const inHub = re.test(hubCode);
    ok(!inHtml && !inChat && !inHub, '没有 `' + label + '`（#log 只许 React 写）',
      [inHtml ? 'index.html' : '', inChat ? 'chat.js' : '', inHub ? 'hub.js' : ''].filter(Boolean).join(' + '));
  }

  /**
   * 5b. **任何变量身上的 replaceChildren 一律不许出现。**
   *
   * 这条是拿真机空白换来的教训：`createSessionEx` 里有一句 `lg.replaceChildren()`
   * （新建会话时清屏）。它把 React 管的子节点从 DOM 里抹掉之后，React 下一次提交
   * 会去删「它以为还在」的节点 —— 提交阶段抛 removeChild NotFoundError，
   * 没有错误边界接得住，**整棵树卸载，屏幕一条不剩**（实测新建会话必现）。
   *
   * 现在没有第二条往 #log 写节点的路，所以这条可以一刀切：全文不许有
   * `.replaceChildren(`（注释不算）。
   */
  ok(!/\.replaceChildren\s*\(/.test(htmlCode + chatCode + hubCode),
    '全文没有 `.replaceChildren(`（清屏一律走「清数据 + 重画」）',
    cnt(htmlCode + chatCode + hubCode, '.replaceChildren(') + ' 处');

  /**
   * 5b-2. **历史写入必须经过 store。**
   *
   * 这条是 QA 真机抓到的「主人那句话每轮显示两遍」的守卫：
   * `logSetHistory` 曾经自己直接写 `LOG_STATE.turns`，绕开了
   * `store.setHistory()` —— 而「落盘后把乐观气泡撤掉」只写在后者里，
   * 于是乐观那颗永远撤不掉，屏幕上是两个一模一样的主人气泡。
   *
   * 现在 logSetHistory 一律转调 store。这条不变式就是钉住它：
   * 只要有人再把「直接写 LOG_STATE.turns」加回来，这里立刻红。
   */
  ok(/window\.__logStore\.setHistory\(sid, turns\)/.test(chatCode),
    'logSetHistory 转调 store.setHistory（撤乐观气泡的钩子挂在它上面）');
  ok(!/LOG_STATE.turnss*=/.test(chatCode.split('window.__logStore.setHistory(sid, turns)')[0]),
    'logSetHistory 没有在 store 之前自己写 LOG_STATE.turns（那会让清账钩子失效）');
  ok(/dropLandedPending/.test(read('src-ui/store.js')), 'store 里有「落盘后撤乐观气泡」（唯一一份）');

  /* 5c. 首帧必须同步提交：createRoot 是并发根，boot 会在首帧提交前写数据 */
  const mainSrc = read('src-ui/main.jsx');
  ok(/flushSync\(\(\)\s*=>\s*root\.render/.test(mainSrc), '首帧用 flushSync 同步提交（不给 boot 留窗口）');
  ok(/from 'react-dom'/.test(mainSrc) && !/flushSync[^\n]*from 'react-dom\/client'/.test(mainSrc),
    'flushSync 从 react-dom 主入口引入（从 react-dom/client 拿是 undefined）');
  ok(/RowBoundary/.test(read('src-ui/RowBoundary.jsx')) && /getDerivedStateFromError/.test(read('src-ui/RowBoundary.jsx')),
    '每条消息套了错误边界（一条坏数据不许毁整屏）');

  /* 6. 产物与构建链 */
  const bundlePath = path.join(ROOT, 'public', 'ui', 'log.bundle.js');
  const hasBundle = fs.existsSync(bundlePath);
  const bundleSize = hasBundle ? fs.statSync(bundlePath).size : 0;
  ok(hasBundle && bundleSize > 50 * 1024, 'public/ui/log.bundle.js 在仓库里（发布物不带 node_modules）',
    hasBundle ? bundleSize + ' 字节' : '文件不存在');
  if (hasBundle) {
    const b = fs.readFileSync(bundlePath, 'utf8');
    ok(b.includes('createRoot'), '产物里是 createRoot（React 18 的挂载方式）');
    ok(!b.includes('jsxDEV'), '产物里没有 jsxDEV（不是 dev 构建，体积不虚）');
  }

  const pkg = JSON.parse(read('package.json') || '{}');
  ok(String((pkg.scripts || {})['build:ui'] || '').includes('esbuild'), 'package.json 有 build:ui 脚本');
  ok(Boolean((pkg.devDependencies || {}).esbuild), 'esbuild 只进 devDependencies');
  ok(/^[~^]?18./.test(String((pkg.devDependencies || {}).react || '')), 'React 18（不是 19）',
    String((pkg.devDependencies || {}).react || ''));
  const builder = read('package.json');
  ok(/public\/\*\*\/\*/.test(builder), '打包白名单里带 public/**/*（产物会跟着一起发）');

  /* 7. #log 只剩一个空容器，由 bundle 接管 */
  ok(/<div id="log"\s*>/.test(html) || /id="log"[^>]*><\/div>/.test(html), '#log 在 HTML 里是空容器');
  ok(/<script src="\/ui\/log\.bundle\.js"><\/script>/.test(html), 'index.html 加载了 log.bundle.js');
}

/* ══════════════════════════════════════════════════════════════════
 * 二、行为层
 * ══════════════════════════════════════════════════════════════════ */

/* 页面里的取样器：只读 DOM，按「主人能看到什么」口径数 */
const SNAP_FN = `window.__lrSnap = function(){
  var lg = document.getElementById('log');
  if (!lg) return null;
  var tx = function(el){ return String((el && el.textContent) || '').replace(/\\s+/g,''); };
  var q = function(sel){ return [].slice.call(lg.querySelectorAll(sel)); };
  var rect = function(sel){
    var e = lg.querySelector(sel);
    if (!e) return null;
    var r = e.getBoundingClientRect();
    return { x: Math.round(r.x*100)/100, y: Math.round(r.y*100)/100, w: Math.round(r.width*100)/100, h: Math.round(r.height*100)/100 };
  };
  return {
    segs: q('.msg.assistant .bubble').map(tx),
    userSegs: q('.msg.user > .bubble').map(tx),
    tool: q('details.tool').length,
    hub: q('details.toolhub').length,
    openDetails: q('details[open]').length,
    think: q('details.think').length,
    notes: q('.sysnote').map(tx),
    text: tx(lg),
    scrollTop: lg.scrollTop,
    scrollHeight: lg.scrollHeight,
    clientHeight: lg.clientHeight,
    atBottom: (lg.scrollHeight - lg.scrollTop - lg.clientHeight) <= 8,
    grayRect: rect('details.think .thinkMeta'),
    hubPeekRect: rect('details.toolhub .hubpeek'),
    react: !!window.__logRoot
  };
}; return 1;`;

/* 网络桩：只换 /api/chat 与 /api/chat/live，其余透传。
 * 关键点：live 的 items 由**服务端那两个真函数**按「已经推了几个事件」算出来，
 * 不是我们编的 —— 否则验的是我的假设，不是代码。 */
function installStub() {
  return `(function(){
  if (window.__lrOrigFetch) return 1;
  window.__lrOrigFetch = window.fetch.bind(window);
  window.__lr = window.__lr || { events: [], steps: [], i: 0, gap: 60, holdOpen: false, liveOverride: null, turns: null };
  var jsonRes = function(o){ return new Response(JSON.stringify(o), { status: 200, headers: { 'content-type': 'application/json' } }); };
  window.fetch = function(u, opt){
    var url = (typeof u === 'string') ? u : ((u && u.url) || '');
    var qa = window.__lr || {};
    if (/\\/api\\/chat$/.test(url)) {
      var evs = qa.events || [], gap = Number(qa.gap == null ? 60 : qa.gap), i = 0;
      var enc = new TextEncoder();
      var stream = new ReadableStream({
        async pull(c){
          if (i >= evs.length) {
            if (qa.holdOpen) { await new Promise(function(){}); return; }
            try { c.close(); } catch(e){}
            return;
          }
          var e = evs[i++];
          qa.i = Math.min(i, (qa.steps || []).length - 1);
          c.enqueue(enc.encode('data: ' + JSON.stringify(e) + '\\n\\n'));
          await new Promise(function(r){ setTimeout(r, gap); });
        }
      });
      return Promise.resolve(new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } }));
    }
    if (url.indexOf('/api/chat/live') >= 0) {
      if (qa.liveOverride) {
        var O = qa.liveOverride;
        return Promise.resolve(jsonRes({ sessionId: qa.sid, running: O.running !== false, startedAt: O.startedAt || Date.now(), events: [], nextSince: 0, items: O.items || [] }));
      }
      var last = (qa.steps || []).length - 1;
      var k = Math.max(0, Math.min(Number(qa.i) || 0, last));
      var items = (qa.steps && qa.steps.length) ? qa.steps[k] : [];
      /* 事件推完了就说「跑完了」——这才和真服务端一致，收尾那条路才会走到 */
      var stillRunning = (Number(qa.i) || 0) < last;
      return Promise.resolve(jsonRes({ sessionId: qa.sid, running: stillRunning, startedAt: qa.startedAt || Date.now(), events: [], nextSince: 0, items: items }));
    }
    if (url.indexOf('/api/sessions/select') >= 0) {
      return Promise.resolve(jsonRes({ session: qa.turns ? { id: qa.sid, turns: qa.turns } : null }));
    }
    return window.__lrOrigFetch(u, opt);
  };
  return 1;
})();`;
}

/* 用服务端真函数把事件前缀算成 items（跟 /api/chat/live 给的一模一样） */
const SRV_SRC = (() => {
  try { return fs.readFileSync(path.join(ROOT, 'src/server.mjs'), 'utf8').replace(/\r\n/g, '\n'); } catch (e) { return ''; }
})();
function grabFn(src, name) {
  const i = src.indexOf('function ' + name + '(');
  if (i < 0) throw new Error('src/server.mjs 里找不到 ' + name);
  const j = src.indexOf('{', i);
  let d = 0;
  for (let k = j; k < src.length; k++) {
    if (src[k] === '{') d++;
    else if (src[k] === '}') { d--; if (d === 0) return src.slice(i, k + 1); }
  }
  throw new Error(name + ' 大括号没配平');
}
const srvFns = new Function(
  grabFn(SRV_SRC, 'appendLiveItem') + '\nreturn { appendLiveItem };',
)();

/** 事件数组 → 每一步之后的 items（模拟服务端一边跑一边攒） */
function stepsOf(events) {
  const steps = [];
  const bag = [];
  steps.push([]);
  for (const e of events) {
    srvFns.appendLiveItem(bag, e);
    steps.push(JSON.parse(JSON.stringify(bag)));
  }
  return steps;
}

let iso = null;
let cdp = null;

async function boot() {
  iso = await startIsolated();
  console.log('隔离实例 ' + iso.base + '（CDP ' + iso.cdpPort + '，数据目录 ' + iso.dataDir + '）');
  cdp = await connect({ port: iso.cdpPort });
  for (let i = 0; i < 100; i++) {
    try {
      const v = await cdp.eval('return { ready: !!document.getElementById("log"), sid: window.sessionId || "", react: !!window.__logRoot };');
      if (v && v.ready && v.sid && v.react) break;
    } catch (e) { /* 还没就绪 */ }
    await sleep(300);
  }
  await cdp.eval(SNAP_FN);
  return iso;
}

const snap = () => cdp.eval('return window.__lrSnap();');

async function watch(n, gapMs) {
  const out = [];
  for (let i = 0; i < n; i++) {
    try { out.push(await snap()); } catch (e) { /* 重载中可能取不到 */ }
    await sleep(gapMs);
  }
  return out;
}

async function arm(payload) {
  await cdp.eval(installStub());
  const sid = await cdp.eval('return window.sessionId || "";');
  const p = Object.assign({ sid }, payload);
  await cdp.eval('window.__lr = Object.assign(window.__lr || {}, ' + JSON.stringify(p) + '); return 1;');
  return sid;
}

/** 让屏幕上有足够高的内容（滚动相关那几条要用） */
async function seedTallHistory(n = 8) {
  const turns = [];
  for (let i = 0; i < n; i++) {
    turns.push({ role: 'user', text: '第 ' + (i + 1) + ' 句：主人问一个普通问题' });
    turns.push({ role: 'assistant', text: '第 ' + (i + 1) + ' 段回复：' + '这是一段用来撑高的正文。'.repeat(12) });
  }
  await cdp.eval('window.renderTurns(' + JSON.stringify(turns) + '); return 1;');
  await sleep(300);
  return turns;
}

/* ── a 正常一轮：说 → 工具 → 说 ───────────────────────────────── */
async function caseNormalTurn() {
  console.log('\n二·a 正常一轮（说 → 工具 → 说）：段数对、每段一份');
  const A = 'QA甲段我先说一句';
  const B = 'QA乙段工具跑完了再说一句';
  const events = [
    { type: 'text', text: A },
    { type: 'tool_start', id: 'lr1', name: 'run_command', args: '{"cmd":"echo hi"}' },
    { type: 'tool_end', id: 'lr1', ok: true, output: 'hi' },
    { type: 'text', text: B },
    { type: 'done' },
  ];
  await arm({
    events,
    steps: stepsOf(events),
    i: 0,
    gap: 120,
    turns: [
      { role: 'user', text: 'QA 主人一句' },
      { role: 'assistant', text: A + '\n\n' + B },
    ],
  });

  await cdp.eval('window.__lrTurnP = window.runTurn({ text: "QA 主人一句" }); return 1;');
  const series = await watch(40, 100);

  let dup = null;
  for (const s of series) {
    if (!s) continue;
    for (const [nm, mark] of [['甲', A], ['乙', B]]) {
      if (cnt(s.text, mark) > 1) { dup = nm + ' 出现 ' + cnt(s.text, mark) + ' 次'; break; }
    }
    if (dup) break;
  }
  ok(!dup, '整个过程任何一刻都没有「同一段出现两遍」', dup || '');
  ok(series.some((s) => s && s.tool === 1), '工具卡出现了', '工具卡数轨迹：' + series.map((s) => (s ? s.tool : 'x')).join(''));
  ok(series.some((s) => s && s.segs.length >= 2), '直播期间屏幕上真的分成了两段',
    '段数轨迹：' + series.map((s) => (s ? s.segs.length : 'x')).join(''));
  ok(series.every((s) => !s || s.segs.length <= 2), '段数从不超过 2（没有中间态堆出来的第三段）',
    '最大 ' + Math.max(0, ...series.map((s) => (s ? s.segs.length : 0))));

  for (let i = 0; i < 80; i++) {
    const b = await cdp.eval('return !!window.busy;');
    if (!b) break;
    await sleep(200);
  }
  await sleep(1500);
  const fin = await snap();
  ok(cnt(fin.text, A) === 1 && cnt(fin.text, B) === 1, '跑完落历史之后，两段各一份',
    '甲 ' + cnt(fin.text, A) + ' 次 / 乙 ' + cnt(fin.text, B) + ' 次');

  /**
   * 【2026-11-10 QA 抓到的真 bug·主人那句话每轮显示两遍】
   *
   * 上面这些断言只看 assistant 那侧（段数 / 每段一次），**没有一条数主人自己的气泡** ——
   * 所以「乐观气泡没被撤掉 + 历史里也有一条」这件事，60 条全绿也照不到。
   * 现在补上：主人那句话在屏幕上必须**恰好一个**气泡。
   * （连带断言「同一段文字不许出现两遍」，把这类翻倍一网打尽。）
   */
  const uCnt = fin.userSegs.filter((t) => t && t.indexOf('QA主人一句') >= 0).length;
  ok(uCnt === 1, '主人那句话屏幕上恰好 1 个气泡（没有被乐观气泡留成两颗）',
    '实际 ' + uCnt + ' 个：' + JSON.stringify(fin.userSegs));
}

/* ── e 主人那句话只许一个气泡（QA 真机抓到的「每轮必现」）────── */
async function casePendingUser() {
  console.log('\n二·e 主人那句话：乐观气泡与落盘历史不许各画一颗（每轮必现的那个 bug）');
  const U = '就用一句话回我：收到。';
  const A = '收到。';
  const events = [{ type: 'text', text: A }, { type: 'done' }];
  /* 先落一份「盘上没有这句」的历史，再走真实路径：
   * addUser（乐观气泡）→ runTurn → 落盘 → settleFromHistory 把历史换进来 */
  await arm({
    events,
    steps: stepsOf(events),
    i: 0,
    gap: 120,
    turns: [{ role: 'user', text: '上一条旧的主人消息' }],
  });
  await cdp.eval('window.addUser(' + JSON.stringify(U) + '); return 1;');
  await sleep(150);
  const during = await cdp.eval('return document.querySelectorAll("#log .msg.user").length;');
  await cdp.eval('window.__lr.turns = ' + JSON.stringify([
    { role: 'user', text: '上一条旧的主人消息' },
    { role: 'user', text: U },
    { role: 'assistant', text: A },
  ]) + '; window.__lrTurnP = window.runTurn({ text: ' + JSON.stringify(U) + ' }); return 1;');

  /* 等这一轮真的收尾（落盘 + 换历史 + 撤乐观气泡） */
  for (let i = 0; i < 80; i++) {
    const b = await cdp.eval('return !!window.busy;');
    if (!b) break;
    await sleep(200);
  }
  await sleep(1200);

  const r = await cdp.eval(`return (function(){
    var lg = document.getElementById('log');
    var tx = function(el){ return String((el && el.textContent) || '').replace(/\s+/g,''); };
    var users = [].slice.call(lg.querySelectorAll('.msg.user')).map(tx);
    var mine = users.filter(function(t){ return t.indexOf('收到') >= 0 || t.indexOf('一句话回我') >= 0; });
    return { all: users, mine: mine };
  })();`);
  ok(r.mine.length === 1, '那句话（"主人说的那一条"）在屏幕上恰好一个气泡',
    '实际 ' + r.mine.length + ' 个：' + JSON.stringify(r.mine));
  ok(!(r.mine.length > 1 && r.mine[0] === r.mine[1]), '没有两颗逐字相同的主人气泡', JSON.stringify(r.mine));
  void during;
}

/* ── b 流式中 F5 ─────────────────────────────────────────────── */
async function caseReload() {
  console.log('\n二·b 流式中 F5：不重复、不堆叠、滚动位置不在顶部');
  const P1 = 'QA重载前已经说完的第一段';
  const P2 = 'QA重载时还在长的第二段';
  const big = [];
  for (let i = 0; i < 6; i++) {
    big.push({ role: 'user', text: '旧的第 ' + (i + 1) + ' 句' });
    big.push({ role: 'assistant', text: '旧的第 ' + (i + 1) + ' 段：' + '用来把屏幕撑高的正文。'.repeat(14) });
  }
  const turns = big.concat([
    { role: 'user', text: 'QA 主人一句（重载）' },
    { role: 'assistant', text: P1 },
  ]);
  const live = {
    running: true,
    startedAt: Date.now(),
    items: [
      { k: 'text', t: P1 },
      { k: 'tool', id: 'lr9', name: 'run_command', args: '{}', status: 'ok', output: 'ok' },
      { k: 'text', t: P2 },
    ],
  };
  /* 落进 storage：reload 之后桩还要在，数据还要在 */
  await arm({ events: [], steps: [], i: 0, turns, liveOverride: live });
  await cdp.eval('localStorage.setItem("__lr_reload", "1"); return 1;');
  const payload = JSON.stringify({ turns, liveOverride: live });
  await cdp.eval('localStorage.setItem("__lr_payload", ' + JSON.stringify(payload) + '); return 1;');

  /* 真 reload：重新装桩 + 重新灌数据（页面脚本会重新跑一遍） */
  await cdp.eval('location.reload(); return 1;').catch(() => {});
  await sleep(2500);
  for (let i = 0; i < 60; i++) {
    try { await cdp.eval(SNAP_FN); break; } catch (e) { await sleep(300); }
  }
  const raw = await cdp.eval('return localStorage.getItem("__lr_payload") || "";');
  if (raw) {
    await cdp.eval(installStub());
    const p = JSON.parse(raw);
    const sidNow = await cdp.eval('return window.sessionId || "";');
    await cdp.eval('window.__lr = Object.assign(window.__lr || {}, ' + JSON.stringify(Object.assign({ sid: sidNow }, p)) + '); return 1;');
    /* 照真实刷新那条路走一遍：历史 → 接上直播 → 画 */
    await cdp.eval('window.renderTurns(' + JSON.stringify(p.turns) + '); return 1;');
    await sleep(200);
    await cdp.eval('window.attachLive(window.sessionId); return 1;');
    await sleep(600);
  }
  await cdp.eval(SNAP_FN);
  const s = await snap();
  ok(cnt(s.text, P1) === 1, '刷新后「重载前那段」只出现一次', '出现 ' + cnt(s.text, P1) + ' 次');
  ok(cnt(s.text, P2) === 1, '刷新后「正在长的那段」只出现一次', '出现 ' + cnt(s.text, P2) + ' 次');
  const qaSegs = s.segs.filter((t) => t.indexOf('QA') === 0);
  ok(qaSegs.length === 2, '本轮那两段各是一个气泡（其余是历史里的旧消息，本来就该在）',
    '本轮段：' + JSON.stringify(qaSegs));
  ok(s.scrollTop > 0, '刷新后滚动位置不在顶部（贴在最新消息那儿）',
    'scrollTop=' + s.scrollTop + ' / 高 ' + s.scrollHeight);
  ok(s.atBottom, '刷新后是贴着底的状态（不是停在半路）',
    '离底 ' + (s.scrollHeight - s.scrollTop - s.clientHeight) + 'px');
  await cdp.eval('localStorage.removeItem("__lr_payload"); localStorage.removeItem("__lr_reload"); return 1;');
}

/* ── c 展开柜子后她发新消息 ───────────────────────────────────── */
async function caseHubStaysOpen() {
  console.log('\n二·c 展开柜子后她发新消息：柜子保持展开、滚动不往旧位置弹');
  const liveA = {
    running: true,
    startedAt: Date.now(),
    items: [
      { k: 'text', t: 'QA先干了两件活' },
      { k: 'tool', id: 'lr21', name: 'run_command', args: '{"cmd":"echo 1"}', status: 'ok', output: '1' },
      { k: 'tool', id: 'lr22', name: 'read_file', args: '{"p":"a.txt"}', status: 'ok', output: 'hi' },
      { k: 'tool', id: 'lr23', name: 'write_file', args: '{"p":"b.txt"}', status: 'ok', output: 'ok' },
    ],
  };
  await arm({ events: [], steps: [], i: 0, turns: await seedTallHistory(6), liveOverride: liveA });
  await cdp.eval('window.logSetLive(window.sessionId, ' + JSON.stringify(liveA) + '); window.renderLog({force:true}); return 1;');
  await sleep(500);

  /* 打开柜门（模拟主人点一下） */
  const opened = await cdp.eval(`return (function(){
    var h = document.querySelector('#log details.toolhub');
    if (!h) return { ok:false, why:'没有柜子' };
    h.open = true;
    return { ok:true, open:h.open };
  })();`);
  ok(opened && opened.ok && opened.open, '柜子被点开了（details.toolhub[open]）', JSON.stringify(opened));
  await sleep(250);
  const before = await snap();
  ok(before.openDetails >= 1, '展开时有 details 是开着的', 'openDetails=' + before.openDetails);

  /* 她发新消息：往清单里加一段正文（= nudgeLive 拿到的新快照） */
  const liveB = JSON.parse(JSON.stringify(liveA));
  liveB.items.push({ k: 'text', t: 'QA她接着说了一句新的' });
  await cdp.eval('window.logSetLive(window.sessionId, ' + JSON.stringify(liveB) + '); window.renderLog({force:true}); return 1;');
  await sleep(400);

  const after = await snap();
  ok(after.openDetails >= 1, '新消息来了之后柜子**仍然展开**（没有被收起）', 'openDetails=' + after.openDetails);
  ok(cnt(after.text, 'QA她接着说了一句新的') === 1, '新消息只出现一次', '出现 ' + cnt(after.text, 'QA她接着说了一句新的') + ' 次');
  ok(after.scrollTop >= before.scrollTop - 1, '滚动位置没有往旧地方弹（scrollTop 不减小）',
    before.scrollTop + ' → ' + after.scrollTop);
  ok(after.atBottom, '新消息一来就滚到了最新（贴底）',
    '离底 ' + (after.scrollHeight - after.scrollTop - after.clientHeight) + 'px');
}

/* ── d 思考灰字不抖 ─────────────────────────────────────────── */
async function caseGrayNoJitter() {
  console.log('\n二·d 鼠标移到思考灰字上：位置不抖（两次 getBoundingClientRect 位移 < 1px）');
  const think = 'QA思考：先想一想这件事要不要拆成三步来做，拆完再动手会比较稳。';
  const live = {
    running: true,
    startedAt: Date.now(),
    items: [
      { k: 'think', t: think },
      { k: 'text', t: 'QA想完了开始说' },
    ],
  };
  await arm({ events: [], steps: [], i: 0, turns: await seedTallHistory(4), liveOverride: live });
  await cdp.eval('window.logSetLive(window.sessionId, ' + JSON.stringify(live) + '); window.renderLog({force:true}); return 1;');
  await sleep(500);

  const probe = await cdp.eval(`return (function(){
    var ea = document.querySelector('#log details.think .thinkMeta');
    var eb = document.querySelector('#log details.toolhub .hubpeek, #log details.think .thinkMeta');
    var r = function(e){ if(!e) return null; var b=e.getBoundingClientRect(); return {x:+b.x.toFixed(2), y:+b.y.toFixed(2), w:+b.width.toFixed(2), h:+b.height.toFixed(2)}; };
    return { meta: r(ea), peek: r(eb), hasMeta: !!ea };
  })();`);
  ok(probe && probe.hasMeta, '思考块右侧的灰字（.thinkMeta）画出来了', JSON.stringify(probe && probe.meta));

  /* ① 鼠标移上去：只该变色，不该改布局 */
  const d1 = await cdp.eval(`return (function(){
    var s = document.querySelector('#log details.think > summary');
    if (!s) return null;
    var b0 = s.getBoundingClientRect();
    s.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    s.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
    return new Promise(function(res){ requestAnimationFrame(function(){
      var b1 = s.getBoundingClientRect();
      res({ dx: +(Math.abs(b1.x-b0.x)).toFixed(3), dy: +(Math.abs(b1.y-b0.y)).toFixed(3),
            dw: +(Math.abs(b1.width-b0.width)).toFixed(3), dh: +(Math.abs(b1.height-b0.height)).toFixed(3) });
    }); });
  })();`);
  ok(d1 && d1.dx < 1 && d1.dy < 1 && d1.dw < 1, '鼠标移上去那一行**一点都没动**（位移 < 1px）',
    d1 ? JSON.stringify(d1) : '取不到 summary');

  /* ② 再触发一次重渲染（数据没变）：灰字位置还得一样 */
  const d2 = await cdp.eval(`return (function(){
    var e0 = document.querySelector('#log details.think .thinkMeta');
    var r0 = e0 ? e0.getBoundingClientRect() : null;
    /* 同样的数据再画一遍（模拟轮询/广播导致的重复渲染） */
    window.renderLog();
    return new Promise(function(res){ requestAnimationFrame(function(){
      var e1 = document.querySelector('#log details.think .thinkMeta');
      var r1 = e1 ? e1.getBoundingClientRect() : null;
      if (!r0 || !r1) return res({ ok:false });
      res({ ok:true, dx:+(Math.abs(r1.x-r0.x)).toFixed(3), dy:+(Math.abs(r1.y-r0.y)).toFixed(3), dw:+(Math.abs(r1.width-r0.width)).toFixed(3) });
    }); });
  })();`);
  ok(d2 && d2.ok && d2.dx < 1 && d2.dy < 1 && d2.dw < 1, '重渲染之后灰字也不动（节点身份稳定）',
    d2 ? JSON.stringify(d2) : '取不到灰字');

  /* ③ CSS 层面的根治：截断类元素不许再用 ellipsis（那正是「为了截断点重新测量」的来源）
   *    【2026-11-10 A7】探针换成 .thinkTitle 本体 —— 那是 flex:1、真会截断的那个；
   *    .thinkMeta（「N 字」）是短词，测它测不出问题。 */
  const css = await cdp.eval(`return (function(){
    var e = document.querySelector('#log details.think .thinkTitle');
    if (!e) return null;
    var cs = getComputedStyle(e);
    return { textOverflow: cs.textOverflow, whiteSpace: cs.whiteSpace, overflow: cs.overflowX };
  })();`);
  ok(css && css.textOverflow === 'clip', '标题不用 ellipsis（text-overflow: clip）', JSON.stringify(css));
  ok(css && css.whiteSpace === 'nowrap', '标题 nowrap（文字变长不会重排换行）', JSON.stringify(css));
}

/* ══════════════════════════════════════════════════════════════════ */

async function main() {
  console.log('== check-log-react：对话区换 React 的守卫 ==');
  caseSource();

  try {
    await boot();
    console.log('页面已就绪：#log 由 React 接管（window.__logRoot 在）');
    await caseNormalTurn();
    await casePendingUser();
    await caseReload();
    await caseHubStaysOpen();
    await caseGrayNoJitter();
  } catch (e) {
    fail++;
    console.log('  [!!] 行为层跑挂了：' + ((e && e.message) || e));
  } finally {
    try { if (cdp) cdp.close(); } catch (e) {}
    try { if (iso) await iso.stop(); } catch (e) {}
  }

  console.log('\n结果：' + pass + ' 通过 / ' + fail + ' 失败');
  process.exit(fail ? 1 : 0);
}

await main();
