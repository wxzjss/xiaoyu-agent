#!/usr/bin/env node
/**
 * 发消息显示 · 主人反复报的三件事，在真 DOM 上逐帧钉住（QA 独立验收 · 2026-11-11）
 *
 * 主人报过的原话：
 *   ①「发出去我这句话排在她说的话后面去了」
 *   ②「一轮说了好几段，我说的话堆到这一轮最下面」
 *   ③（修①时新长出来的）「发第二条的一瞬间，第一条的回复消失一下」
 *
 * 这三件事都不能靠读代码判断 —— 屏幕上的**行顺序**才算数。
 * 所以这里在真页面里逐帧抓一份「DOM 阅读顺序表」（user / assistant / 柜子 / 工具卡），
 * 断言的是**下标关系**，不是哪段代码怎么写：
 *   · 我这句话出现在屏幕上之后，**任何一帧**它的下标都必须小于她这一轮最后一行；
 *   · 我这句话**任何一帧**都恰好一份（不许两份、不许消失）；
 *   · 收尾落历史后，顺序仍是 我的 → 她的回答。
 *
 * 网络层用桩（/api/chat 吐编排好的 SSE、/api/chat/live 给按事件前缀算出来的 items、
 * /api/sessions/select 给历史），其余全是线上代码：runTurn 全流程、followLive、
 * finishTurn、store、items.js、LogView —— 一行没绕。
 *
 * 用法：node scripts/check-msg-order.mjs
 */
import { startIsolated } from './_test-instance.mjs';
import { connect } from '../_t_cdp.mjs';
import { makeChecker } from './_harness_util.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const c = makeChecker('发消息显示（DOM 阅读顺序）');

/* ── 页面里的桩 + 取样器 ─────────────────────────────────────────── */
const INSTALL = `(function(){
  if (window.__qaOrigFetch) return;
  window.__qaOrigFetch = window.fetch.bind(window);
  window.__qa = window.__qa || { events: [], gap: 350, sid: '', i: 0 };
  var jsonRes = function(o){ return new Response(JSON.stringify(o), {status:200, headers:{'content-type':'application/json'}}); };
  window.fetch = function(u, opt){
    var url = (typeof u === 'string') ? u : ((u && u.url) || '');
    var qa = window.__qa || {};
    if (/\\/api\\/chat$/.test(url)) {
      var evs = qa.events || [], gap = Number(qa.gap || 350), i = 0;
      var enc = new TextEncoder();
      var stream = new ReadableStream({
        async pull(cc){
          if (i >= evs.length) {
            if (qa.holdOpen) { await new Promise(function(){}); return; }
            try { cc.close(); } catch(e){}
            return;
          }
          var e = evs[i++]; qa.i = i;
          cc.enqueue(enc.encode('data: ' + JSON.stringify(e) + '\\n\\n'));
          await new Promise(function(r){ setTimeout(r, gap); });
        }
      });
      return Promise.resolve(new Response(stream, {status:200, headers:{'content-type':'text/event-stream'}}));
    }
    if (url.indexOf('/api/chat/live') >= 0) {
      if (qa.steps && qa.steps.length) {
        var last = qa.steps.length - 1;
        var k = Math.max(0, Math.min(Number(qa.i) || 0, last));
        var _len = Array.isArray(qa.events) ? qa.events.length : 0;
        var _i = Number(qa.i) || 0;
        if (_i >= _len && _len > 0 && !qa.endAt) qa.endAt = Date.now();
        var running = qa.holdOpen ? true : (_i < _len || (_len > 0 && qa.endAt && (Date.now() - qa.endAt) < 800));
        return Promise.resolve(jsonRes({ sessionId: qa.sid, running: running, items: qa.steps[k], events: [], startedAt: qa.startedAt || Date.now(), nextSince: 0 }));
      }
      return Promise.resolve(jsonRes({ running:false, items:[], events:[], nextSince:0 }));
    }
    if (url.indexOf('/api/sessions/select') >= 0) {
      /* 收尾那一刻：历史必须已经含本轮（流跑完了才给 turnsAfter） */
      var done = (Number(qa.i) || 0) >= ((qa.events || []).length);
      var turns = (done && qa.turnsAfter) ? qa.turnsAfter : qa.turns;
      return Promise.resolve(jsonRes({ session: { id: qa.sid, turns: turns || [] } }));
    }
    return window.__qaOrigFetch(u, opt);
  };

  /* DOM 阅读顺序：把屏幕压成一张「一行一行」的表 */
  window.__qaRows = function(){
    var lg = document.getElementById('log');
    var tx = function(el){ return String((el && el.textContent) || '').replace(/\\s+/g,''); };
    var out = [];
    if (!lg) return out;
    var nodes = lg.querySelectorAll('.msg, details.tool, details.toolhub, .sysnote');
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      if (el.parentElement && el.parentElement.closest('details')) continue;  /* 柜子里的卡不算行 */
      var cls = String(el.className || '');
      var kind = '';
      if (el.tagName === 'DETAILS') kind = /toolhub/.test(cls) ? 'hub' : 'tool';
      else if (cls.indexOf('sysnote') >= 0) kind = 'note';
      else if (/(^|\\s)user(\\s|$)/.test(cls)) kind = 'user';
      else if (/(^|\\s)assistant(\\s|$)/.test(cls)) kind = 'assistant';
      else if (/(^|\\s)mate(\\s|$)/.test(cls)) kind = 'mate';
      var bs = el.querySelectorAll('.bubble');
      var txt = [];
      for (var b = 0; b < bs.length; b++) txt.push(tx(bs[b]));
      out.push({ kind: kind, text: (kind === 'hub' || kind === 'tool') ? '' : (txt[0] || ''), bubbles: txt.length });
    }
    return out;
  };

  window.__qaSnap = function(){
    var lg = document.getElementById('log');
    var rows = window.__qaRows();
    var count = function(k){ var n = 0; for (var i = 0; i < rows.length; i++) if (rows[i].kind === k) n++; return n; };
    var hubs = 0, hubCards = 0, bare = 0;
    if (lg) {
      var hs = lg.querySelectorAll('details.toolhub');
      hubs = hs.length;
      for (var h = 0; h < hs.length; h++) hubCards += hs[h].querySelectorAll('details.tool').length;
      bare = Math.max(0, lg.querySelectorAll('details.tool').length - hubCards);
    }
    return {
      rows: rows.map(function(r){ return r.kind + ':' + r.text.slice(0, 24); }),
      kinds: rows.map(function(r){ return r.kind; }),
      userCount: count('user'),
      assistantRows: count('assistant'),
      assistantBubbles: (function(){ var n = 0; for (var i = 0; i < rows.length; i++) if (rows[i].kind === 'assistant') n += rows[i].bubbles; return n; })(),
      hubs: hubs,
      toolCards: bare,
      hubCards: hubCards,
      thinks: lg ? lg.querySelectorAll('details.think').length : 0,
      errRows: lg ? [].filter.call(lg.querySelectorAll('.sysnote'), function(e){ return String(e.textContent||'').indexOf('渲染出错') >= 0; }).length : 0,
      dist: lg ? Math.round(lg.scrollHeight - lg.scrollTop - lg.clientHeight) : -1,
      st: lg ? Math.round(lg.scrollTop) : -1,
      sh: lg ? lg.scrollHeight : -1,
      ch: lg ? lg.clientHeight : -1,
      st: lg ? Math.round(lg.scrollTop) : -1,
      sh: lg ? lg.scrollHeight : -1,
      ch: lg ? lg.clientHeight : -1,
      sendText: (document.getElementById('send') || {}).textContent || '',
      stopShown: !!(document.getElementById('stopBtn') && document.getElementById('stopBtn').classList.contains('show')),
      sending: !!(document.getElementById('sendingHint') && document.getElementById('sendingHint').classList.contains('show')),
      busy: !!window.busy,
      text: lg ? String(lg.textContent || '').replace(/\\s+/g, '') : '',
    };
  };
  var raw = null;
  try { raw = localStorage.getItem('__qa_payload'); } catch(e){}
  if (raw) { try { window.__qa = Object.assign(window.__qa || {}, JSON.parse(raw)); } catch(e){} }
})();`;

const cnt = (hay, needle) => String(hay || '').split(needle).length - 1;

let iso = null;
let cdp = null;

async function boot() {
  iso = await startIsolated({ appPort: 8831, cdpPort: 9251 });
  console.log('隔离实例 ' + iso.base + '（CDP ' + iso.cdpPort + '）');
  cdp = await connect({ port: iso.cdpPort, match: iso.base });
  for (let i = 0; i < 100; i++) {
    try {
      const v = await cdp.eval('return { ready: !!document.getElementById("log"), sid: window.sessionId || "" };');
      if (v && v.ready && v.sid) return;
    } catch (e) { /* 还没就绪 */ }
    await sleep(300);
  }
  throw new Error('页面没起来（#log / sessionId 一直没就绪）');
}

/** 装桩 + 摆编排（steps 由事件前缀算出来，跟真服务端同一个口径） */
async function arm(payload) {
  await cdp.eval(INSTALL + '\nreturn 1;');
  const sid = await cdp.eval('return window.sessionId || "";');
  const p = Object.assign({ sid, gap: 350 }, payload);
  if (Array.isArray(p.events) && p.events.length) p.steps = await cdp.eval(
    'return (function(evs){ return window.__qaSteps(evs); })(' + JSON.stringify(p.events) + ');').catch(() => null);
  if (!p.steps) {
    /* 桩里拿不到真服务端的合成器 —— 退化成「一条事件一个 item」的近似（够本检查用） */
    p.steps = [[]];
    const bag = [];
    for (const e of (p.events || [])) {
      if (e.type === 'text') bag.push({ k: 'text', t: e.text });
      else if (e.type === 'tool_start') bag.push({ k: 'tool', id: e.id, name: e.name, args: e.args, status: 'run' });
      else if (e.type === 'tool_end') { const t = bag[bag.length - 1]; if (t && t.k === 'tool') { t.status = 'ok'; t.output = e.output || ''; } }
      else if (e.type === 'reasoning') bag.push({ k: 'think', t: e.text });
      p.steps.push(JSON.parse(JSON.stringify(bag)));
    }
  }
  p.i = 0;
  await cdp.eval('window.__qa = Object.assign(window.__qa || {}, ' + JSON.stringify(p) + '); return 1;');
  return sid;
}

const snap = () => cdp.eval('return window.__qaSnap();');

/** 连拍：返回时间线快照数组 */
async function watch(times, gapMs = 100) {
  const out = [];
  for (let i = 0; i < times; i++) {
    try { out.push(await snap()); } catch (e) { /* 重载中 */ }
    await sleep(gapMs);
  }
  return out;
}

/** 等这一轮彻底跑完（busy=false 且 busy 不再亮） */
async function waitIdle(maxMs = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < maxMs) {
    const b = await cdp.eval('return !!window.busy;').catch(() => false);
    if (!b) return true;
    await sleep(200);
  }
  return false;
}

let SID = '';

/* ══════════════════════════════════════════════════════════════════
 * 一：发一句 —— 立刻上屏、位置在她的回答之前、收尾后只有一份
 * ══════════════════════════════════════════════════════════════════ */
async function caseOne() {
  console.log('\n一、发一句：立刻上屏 → 她在回 → 收尾后我这句话只有一份且在她的话之前');
  await cdp.eval('try { window.__logStore.setHistory(window.sessionId, []); } catch(e){}'
    + 'try { window.__logStore.setLive(window.sessionId, null); } catch(e){} return 1;');
  await sleep(300);

  const U = 'QA我说的这一句要验顺序';
  const A = 'QA她回的第一段话';
  await arm({
    events: [{ type: 'text', text: A }, { type: 'done' }],
    turns: [],
    turnsAfter: [{ role: 'user', text: U }, { role: 'assistant', text: A }],
  });

  /* 发 + 60ms 内取第一帧（乐观气泡该在） */
  cdp.eval('window.__qaTurnP = window.runTurn({ text: ' + JSON.stringify(U) + ' }); return 1;').catch(() => {});
  await sleep(60);
  const first = await snap();
  const earlyUser = first.kinds.indexOf('user');
  c.ok('60ms 内我这句话已经在屏幕上（乐观气泡）', earlyUser >= 0 && cnt(first.text, U) === 1,  '行数 ' + first.rows.length + ' 顺序 ' + JSON.stringify(first.rows));
  c.ok('刚发出去那一刻，我这句话是屏幕上最后一行', earlyUser >= 0 && earlyUser === first.kinds.length - 1,  '下标 ' + earlyUser + '/' + (first.kinds.length - 1));

  const series = await watch(40, 100);

  /* 不变式一：任何一帧里我这句话最多一份 */
  const dupFrames = series.map((s, i) => ({ i, n: cnt(s.text, U) })).filter((x) => x.n > 1);
  c.ok('全程我这句话没有出现两份', dupFrames.length === 0, 
    dupFrames.length ? '第 ' + dupFrames[0].i + ' 帧出现 ' + dupFrames[0].n + ' 次' : '');

  /* 不变式二：她一旦开口，我的下标必须小于她这一轮最后一行（不许跑到轮末） */
  let bad = null;
  for (let i = 0; i < series.length; i++) {
    const s = series[i];
    const u = s.kinds.indexOf('user');
    let lastHer = -1;
    for (let k = 0; k < s.kinds.length; k++) if (s.kinds[k] === 'assistant' || s.kinds[k] === 'hub' || s.kinds[k] === 'tool') lastHer = k;
    if (u >= 0 && lastHer >= 0 && u > lastHer) { bad = { i, u, lastHer, rows: s.rows }; break; }
  }
  c.ok('全程我的气泡都在她的话之前（没有跑到轮末）', !bad, 
    bad ? '第 ' + bad.i + ' 帧：我@' + bad.u + ' 她最后一行@' + bad.lastHer + ' ' + JSON.stringify(bad.rows) : '');

  const idle = await waitIdle();
  c.ok('这一轮收尾了（busy=false）', idle);
  await sleep(1200);
  const fin = await snap();

  c.ok('收尾后我这句话只有一份', cnt(fin.text, U) === 1,  '出现 ' + cnt(fin.text, U) + ' 次');
  c.ok('收尾后她的回答只有一份', cnt(fin.text, A) === 1,  '出现 ' + cnt(fin.text, A) + ' 次');
  const ui = fin.kinds.indexOf('user');
  const ai = fin.kinds.indexOf('assistant');
  c.ok('收尾后 DOM 顺序是「我 → 她的回答」', ui >= 0 && ai >= 0 && ui < ai, 
    '我的下标 ' + ui + '，她的下标 ' + ai + '，顺序 ' + JSON.stringify(fin.rows));
  c.ok('收尾后屏幕贴在底部', fin.dist <= 8,  '离底 ' + fin.dist + 'px');
  c.ok('主按钮文案是【发送】', fin.sendText === '发送',  '实际「' + fin.sendText + '」');
  c.ok('没有「这一条渲染出错了」的兜底行', fin.errRows === 0,  fin.errRows + ' 行');
}

/* ══════════════════════════════════════════════════════════════════
 * 二：一轮劈成多段（正文 → 工具 → 正文 → 轮末 → 正文）——
 *     我这句话不许被挤到轮末；工具要折成一个柜子
 * ══════════════════════════════════════════════════════════════════ */
async function caseSegments() {
  console.log('\n二、一轮劈成多段：我这句话全程在她的话之前、工具折成一个柜子');
  await cdp.eval('try { window.__logStore.setHistory(window.sessionId, []); } catch(e){}'
    + 'try { window.__logStore.setLive(window.sessionId, null); } catch(e){} return 1;');
  await sleep(300);

  const U = 'QA我这一句发出去以后要干一段活';
  const S1 = 'QA第一段开工了';
  const S2 = 'QA第二段工具跑完接着汇报';
  const S3 = 'QA第三段轮末之后补一句';
  const events = [
    { type: 'reasoning', text: 'QA思考要不要分三段写这件事得想清楚一点' },
    { type: 'text', text: S1 },
    { type: 'tool_start', id: 'q1', name: 'run_command', args: '{"cmd":"echo 1"}' },
    { type: 'tool_end', id: 'q1', ok: true, output: '1' },
    { type: 'tool_start', id: 'q2', name: 'run_command', args: '{"cmd":"echo 2"}' },
    { type: 'tool_end', id: 'q2', ok: true, output: '2' },
    { type: 'text', text: S2 },
    { type: 'done' },
    { type: 'text', text: S3 },
  ];
  await arm({
    gap: 300,
    events,
    turns: [],
    /* 【2026-11-12 修·这条用例的种子原来没带工具，导致「收尾后柜子外没有裸卡」恒为 0 张（假红）】
     * 真机上「一段活调了两次工具」落历史后，turn 里是带 tools 的（publicSession 的 turnListOf）。
     * 所以这里补上两张工具卡，让「收尾后 = 1 个柜子、柜外 0 张裸卡」这条断言真的验得到东西。 */
    turnsAfter: [
      { role: 'user', text: U },
      {
        role: 'assistant',
        text: S1 + '\n\n' + S2 + '\n\n' + S3,
        tools: [
          { id: 'q1', name: 'run_command', args: '{"cmd":"echo 1"}', ok: true, output: '1' },
          { id: 'q2', name: 'run_command', args: '{"cmd":"echo 2"}', ok: true, output: '2' },
        ],
      },
    ],
  });
  cdp.eval('window.__qaTurnP = window.runTurn({ text: ' + JSON.stringify(U) + ' }); return 1;').catch(() => {});
  const series = await watch(60, 100);

  /* 关键断言：整条时间线里「我」永远在她那一轮第一行之前 */
  let bad = null;
  for (let i = 0; i < series.length; i++) {
    const s = series[i];
    const u = s.kinds.indexOf('user');
    const herFirst = s.kinds.findIndex((k) => k === 'assistant' || k === 'hub' || k === 'tool');
    if (u >= 0 && herFirst >= 0 && u > herFirst) { bad = { i, u, herFirst, rows: s.rows }; break; }
  }
  c.ok('多段轮里我的气泡一直在她开口之前（没有堆到轮末）', !bad, 
    bad ? '第 ' + bad.i + ' 帧：我@' + bad.u + ' 她第一行@' + bad.herFirst + ' ' + JSON.stringify(bad.rows) : '');

  const maxHubs = Math.max(0, ...series.map((s) => s.hubs));
  const maxCards = Math.max(0, ...series.map((s) => s.toolCards));
  c.ok('两张工具卡折成 1 个柜子', maxHubs === 1,  '最多见到 ' + maxHubs + ' 个柜子，裸卡 ' + maxCards + ' 张');
  /* 直播中途只有一张卡时本来就该是单抽屉（还没到能折成柜子的数量），
   * 所以「柜子外没有裸卡」只对**收尾那一帧**成立 —— 那才是主人最后看到的形态。 */
  c.ok('柜子里确实装着 2 张卡', series.some((s) => s.hubCards >= 2),  '柜内最多 ' + Math.max(0, ...series.map((s) => s.hubCards)) + ' 张');

  const idle = await waitIdle(25000);
  c.ok('这一轮收尾了', idle);
  await sleep(1200);
  const fin = await snap();
  for (const [nm, mk] of [['第一段', S1], ['第二段', S2], ['第三段', S3]]) {
    c.ok('收尾后「' + nm + '」只有一份', cnt(fin.text, mk) === 1,  '出现 ' + cnt(fin.text, mk) + ' 次');
  }
  c.ok('收尾后我这句话只有一份（没有因为多段而多画一颗）', cnt(fin.text, U) === 1,  '出现 ' + cnt(fin.text, U) + ' 次');
  const ui = fin.kinds.indexOf('user');
  const ai = fin.kinds.indexOf('assistant');
  c.ok('收尾后顺序仍是「我 → 她这三段」', ui >= 0 && ai >= 0 && ui < ai,
    '我的下标 ' + ui + '，她第一行 ' + ai + '，顺序 ' + JSON.stringify(fin.rows));
  c.ok('收尾后柜子外没有裸工具卡', fin.toolCards === 0 && fin.hubs === 1,
    '柜子 ' + fin.hubs + ' 个 / 裸卡 ' + fin.toolCards + ' 张 / 柜内 ' + fin.hubCards + ' 张');
}

/* ══════════════════════════════════════════════════════════════════
 * 三：连发两条 —— 发第二条的一瞬间，第一条的回答不许消失（也不许变两份）
 * ══════════════════════════════════════════════════════════════════ */
async function caseTwoInARow() {
  console.log('\n三、连发两条：第二条开跑瞬间，第一条的回答不许消失 / 变两份');
  const U1 = 'QA第一条消息';
  const A1 = 'QA第一条的回复内容在这里';
  const U2 = 'QA第二条消息';
  const A2 = 'QA第二条的回复内容';
  /* 屏幕先落在「已经聊过一轮」的历史上 */
  await arm({
    events: [{ type: 'text', text: A2 }, { type: 'done' }],
    turns: [{ role: 'user', text: U1 }, { role: 'assistant', text: A1 }],
    turnsAfter: [
      { role: 'user', text: U1 }, { role: 'assistant', text: A1 },
      { role: 'user', text: U2 }, { role: 'assistant', text: A2 },
    ],
  });
  await cdp.eval('try { window.__logStore.setHistory(window.sessionId, '
    + JSON.stringify([{ role: 'user', text: U1 }, { role: 'assistant', text: A1 }]) + '); } catch(e){}'
    + 'try { window.__logStore.setLive(window.sessionId, null); } catch(e){} return 1;');
  await sleep(400);
  const before = await snap();
  c.ok('发第二条之前，第一条的回复在屏幕上（1 份）', cnt(before.text, A1) === 1,  '出现 ' + cnt(before.text, A1) + ' 次');

  await cdp.eval('window.__qa = Object.assign(window.__qa || {}, { i: 0 }); return 1;');
  cdp.eval('window.__qaTurnP = window.runTurn({ text: ' + JSON.stringify(U2) + ' }); return 1;').catch(() => {});
  const series = await watch(40, 100);

  const firstFrames = series.slice(0, 12);   // 头 1.2 秒：最容易闪没的窗口
  const lostA1 = firstFrames.filter((s) => cnt(s.text, A1) !== 1);
  c.ok('发第二条头 1.2 秒里，第一条的回复一直是一份（没有闪没、没有变两份）', lostA1.length === 0, 
    lostA1.length ? lostA1.length + ' 帧不对，首帧出现 ' + cnt(firstFrames[0].text, A1) + ' 次' : '');
  const lostAll = series.filter((s) => cnt(s.text, A1) > 1);
  c.ok('整条时间线里第一条的回复从没变成两份', lostAll.length === 0, 
    lostAll.length ? lostAll.length + ' 帧出现两份' : '');

  const idle = await waitIdle(20000);
  c.ok('第二轮收尾了', idle);
  await sleep(1200);
  const fin = await snap();
  c.ok('收尾后第一条的回复只有一份', cnt(fin.text, A1) === 1,  '出现 ' + cnt(fin.text, A1) + ' 次');
  c.ok('收尾后第二条的回复只有一份', cnt(fin.text, A2) === 1,  '出现 ' + cnt(fin.text, A2) + ' 次');
  c.ok('两条消息各一份', cnt(fin.text, U1) === 1 && cnt(fin.text, U2) === 1, 
    'U1 ' + cnt(fin.text, U1) + ' 次 / U2 ' + cnt(fin.text, U2) + ' 次');
  const iU1 = fin.kinds.indexOf('user');
  const iA1 = fin.kinds.indexOf('assistant');
  c.ok('收尾后顺序仍是「我的第一条 → 她的第一条回复」', iU1 >= 0 && iA1 > iU1, 
    JSON.stringify(fin.rows));
  c.ok('收尾后贴在底部', fin.dist <= 8,  '离底 ' + fin.dist + 'px（scrollTop ' + fin.st + ' / scrollHeight ' + fin.sh + ' / clientHeight ' + fin.ch + '）');
}

/* ── 主线 ─────────────────────────────────────────────────────── */
try {
  await boot();
  SID = await cdp.eval('return window.sessionId || "";');
  console.log('当前会话 ' + SID);
  /* 把「服务端清单合成器」搬进页面：直接用 src/server.mjs 的真函数，不自己编 */
  const srvSrc = (await import('node:fs')).readFileSync(new URL('../src/server.mjs', import.meta.url), 'utf8');
  const grab = (name) => {
    const i = srvSrc.indexOf('function ' + name + '(');
    if (i < 0) return '';
    const j = srvSrc.indexOf('{', i);
    let d = 0;
    for (let k = j; k < srvSrc.length; k++) {
      if (srvSrc[k] === '{') d++;
      else if (srvSrc[k] === '}') { d--; if (d === 0) return srvSrc.slice(i, k + 1); }
    }
    return '';
  };
  const fns = grab('appendLiveItem') + '\n' + grab('buildLiveItems');
  if (fns.trim()) {
    await cdp.eval('window.__qaSteps = function(evs){ ' + fns
      + '\n var steps=[[]], bag=[]; for (var i=0;i<evs.length;i++){ appendLiveItem(bag, evs[i]); steps.push(JSON.parse(JSON.stringify(bag))); } return steps; }; return 1;');
  } else {
    console.log('  [--] 没从 src/server.mjs 抠到 appendLiveItem/buildLiveItems，用简化桩');
  }

  await caseOne();
  await caseSegments();
  await caseTwoInARow();
} catch (e) {
  console.log('  [!!] 跑挂了：' + (e && e.stack ? e.stack : e));
  process.exitCode = 1;
} finally {
  try { cdp && cdp.close(); } catch (e) {}
  try { iso && await iso.stop(); } catch (e) {}
}
c.done();
process.exit(process.exitCode || 0);
