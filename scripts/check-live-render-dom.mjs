#!/usr/bin/env node
/**
 * 【QA 独立复核 · 2026-11-09】「消息显示」在**真 DOM** 上到底对不对。
 *
 * 为什么不信现成的 check-no-dup-render.mjs：
 *   它把 itemsFromEvents / liveItemsFeed 抽出来在 node 里跑，验的是「清单算得对不对」。
 *   可主人报的两种症状 —— 「好几段话堆进一个气泡」「按 F5 之后又堆一块」——
 *   都是**清单对、画出来不对**：paintSnapshot0 建几个容器、renderTurns 画到哪儿、
 *   重载之后历史与直播怎么叠。这一层只有真浏览器能看见。
 *
 * 所以这里：隔离实例（自带临时数据目录 + 独立无头 Edge + 独立 CDP 端口）+ 真页面。
 * 网络层换成一个可控的桩（/api/chat 吐我们编排的 SSE、/api/chat/live 给指定清单），
 * 其余（runTurn 全流程、liveItemsFeed、renderLog、paintSnapshot0、renderTurns、
 * settleFromHistory、attachLive）全是线上那份代码，一行没绕。
 *
 * 验的是：
 *   一、说→工具→说→轮末→说：屏幕上 3 个正文容器，每段恰好一次（不堆一块）
 *   二、轮末之后的那段正文另起一个气泡（排队轮 / 续跑不并进上一个）
 *   三、F5（真 reload）：正在跑的一轮重画之后，每段仍然只有一份
 *   四、回归面：思考块 / 工具卡 / 「正在发送消息」/ ⏹ 停止（aborted 提示不混进正文）
 *   五、跑完落历史 + 切走再切回来：仍是一份
 *
 * 用法：node scripts/check-live-render-dom.mjs
 * 不碰主人正在跑的实例（自起隔离实例，结束全杀）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { startIsolated } from './_test-instance.mjs';
import { connect } from '../_t_cdp.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ── 用**真服务端**的两份合成器算出「服务端此刻会给出什么清单」 ──────────
 * F5 之后前端画的就是 /api/chat/live 的 items；这里直接跑线上那两个函数，
 * 不自己编数据 —— 否则「刷新后段数对不对」验的是我的假设，不是代码。
 */
const SRV_SRC = fs.readFileSync(path.resolve(import.meta.dirname, '..', 'src/server.mjs'), 'utf8').replace(/\r\n/g, '\n');
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
const srvItems = new Function(
  grabFn(SRV_SRC, 'appendLiveItem') + '\n' + grabFn(SRV_SRC, 'buildLiveItems')
  + '\nreturn { appendLiveItem, buildLiveItems };',
)();
/** 服务端收到这串事件之后，live.items 会是什么（增量那份 = /api/chat/live 的 items） */
function serverLiveItems(events) {
  const a = [];
  for (const e of events) srvItems.appendLiveItem(a, e);
  return a;
}

/**
 * 【2026-11-09 换框架】事件 → **每一步之后**的 items 清单。
 *
 * 前端不再自己合成 items（那正是「两套账」的来源），屏幕完全由服务端给的 items 决定。
 * 所以桩要像真服务端那样「边跑边长」：第 k 条事件推完之后，/api/chat/live 该回
 * steps[k]。第一个元素是空清单（还没开始跑）。
 */
function stepsOf(events) {
  const steps = [[]];
  const bag = [];
  for (const e of events) {
    srvItems.appendLiveItem(bag, e);
    steps.push(JSON.parse(JSON.stringify(bag)));
  }
  return steps;
}

let pass = 0;
let fail = 0;
const ok = (cond, name, extra) => {
  if (cond) { pass++; console.log('  OK   ' + name); }
  else { fail++; console.log('  [!!] ' + name + (extra ? '  → ' + extra : '')); }
};

/* ── 页面里装的那段桩 ────────────────────────────────────────────────
 * 只换网络层。要点：
 *   · /api/chat   → 按编排顺序吐 SSE，每条之间隔 gap 毫秒（好让我们中途取样）
 *   · /api/chat/live → 给指定清单（模拟服务端 live.items）
 *   · /api/sessions/select → 给指定历史（模拟落盘历史）
 *   · 其它一律透传（会话列表、健康检查这些还走真服务）
 */
const INSTALL = `(function(){
  if (window.__qaOrigFetch) return;
  window.__qaOrigFetch = window.fetch.bind(window);
  window.__qa = window.__qa || { live: null, turns: null, events: [], gap: 400, sid: '' };
  var jsonRes = function(o){ return new Response(JSON.stringify(o), {status:200, headers:{'content-type':'application/json'}}); };
  window.fetch = function(u, opt){
    var url = (typeof u === 'string') ? u : ((u && u.url) || '');
    var qa = window.__qa || {};
    if (/\\/api\\/chat$/.test(url)) {
      var evs = qa.events || [], gap = Number(qa.gap || 400), i = 0;
      var enc = new TextEncoder();
      var stream = new ReadableStream({
        async pull(c){
          if (i >= evs.length) {
            /* holdOpen：事件发完了也不许关流 —— 这一轮要「一直在跑」，
             * 这样刷新才是「正在流式输出的中途按 F5」。 */
            if (qa.holdOpen) { await new Promise(function(){}); return; }
            try { c.close(); } catch(e){}
            return;
          }
          var e = evs[i++];
          qa.i = i;   /* 【换框架】让 /api/chat/live 知道推到第几条了 */
          c.enqueue(enc.encode('data: ' + JSON.stringify(e) + '\\n\\n'));
          await new Promise(function(r){ setTimeout(r, gap); });
        }
      });
      return Promise.resolve(new Response(stream, {status:200, headers:{'content-type':'text/event-stream'}}));
    }
    if (url.indexOf('/api/chat/live') >= 0) {
      /* 【2026-11-09 换框架】前端不再自己合成 items —— 屏幕完全由服务端给的
       * items 决定。所以这个桩必须像真服务端一样「边跑边长清单」：
       * qa.steps 是事件前缀算出来的若干份 items（用 src/server.mjs 的真函数算的），
       * 按已经推给页面的 SSE 条数取当前那一份。 */
      if (qa.steps && qa.steps.length) {
        var last = qa.steps.length - 1;
        var k = Math.max(0, Math.min(Number(qa.i) || 0, last));
        /* 还在跑吗？口径跟真服务端一致：不看「事件推完没」，看这一轮**有没有收尾**。
         * 最后一条事件不是 done/aborted/error（比如排队轮后面还跟着一句），
         * 就说明这一轮仍在跑 —— 保持 running:true，屏幕上那几段才来得及被看见。 */
        var stillRunning = (Number(qa.i) || 0) < last || !qa.endEvent;
        return Promise.resolve(jsonRes({ sessionId: qa.sid, running: stillRunning, items: qa.steps[k], events: [], startedAt: qa.startedAt || Date.now(), nextSince: 0 }));
      }
      var L = qa.live;
      if (!L) return Promise.resolve(jsonRes({ running:false, items:[], events:[], nextSince:0 }));
      return Promise.resolve(jsonRes({ running: L.running !== false, items: L.items || [], events: L.events || [], startedAt: L.startedAt || Date.now(), nextSince: 0 }));
    }
    if (url.indexOf('/api/sessions/select') >= 0) {
      return Promise.resolve(jsonRes({ session: (qa.turns ? { id: qa.sid, turns: qa.turns } : null) }));
    }
    return window.__qaOrigFetch(u, opt);
  };
  /* 取样：把「屏幕现在长什么样」压成几个数 */
  window.__qaSnap = function(){
    var lg = document.getElementById('log');
    var tx = function(el){ return String((el && el.textContent) || '').replace(/\\s+/g,''); };
    var q = function(sel){ return [].slice.call(lg.querySelectorAll(sel)); };
    /* 【2026-11-09 换框架·判据改口径】
     * 对话区已经改成 React 渲染，屏幕上不再有 data-live-turn 这种「这是直播画的那一份」
     * 的内部标记 —— 那条判据过时了（它验的是实现，不是行为）。
     *
     * 现在改成行为口径：**屏幕上有几段正文**（.msg.assistant 里每个 .bubble 算一段），
     * 以及它们各自出现在哪个气泡里。一段一个 .bubble，正是主人眼睛看到的东西。
     * 所以 liveCount = 正文段数，live = 每段的文字（按阅读顺序）。 */
    return {
      liveCount: q('.msg.assistant .bubble').length,
      allCount: q('.msg.assistant').length,
      live: q('.msg.assistant .bubble').map(tx),
      text: tx(lg),
      think: q('details.think').length,
      thinkTitle: q('details.think summary').map(tx).join('|'),
      thinkBody: q('details.think .thinkBody').map(tx).join('|'),
      tool: q('details.tool').length,
      toolStatus: q('details.tool .status').map(tx),
      bubbles: q('.msg.assistant .bubble').map(tx),
      notes: q('.sysnote').map(tx),
      sending: !!(document.querySelector('#sendingHint.show')),
      streaming: q('.bubble.streaming').length,
      busy: !!window.busy
    };
  };
  var raw = null;
  try { raw = localStorage.getItem('__qa_payload'); } catch(e){}
  if (raw) { try { var p = JSON.parse(raw); window.__qa = Object.assign(window.__qa || {}, p); } catch(e){} }
})();`;

const cnt = (hay, needle) => String(hay || '').split(needle).length - 1;

let iso = null;
let cdp = null;

async function boot() {
  iso = await startIsolated();
  console.log('隔离实例 ' + iso.base + '（CDP ' + iso.cdpPort + '，数据目录 ' + iso.dataDir + '）');
  cdp = await connect({ port: iso.cdpPort });
  /* 等页面把模块加载完、会话选好 */
  for (let i = 0; i < 100; i++) {
    try {
      const v = await cdp.eval('return { ready: !!document.getElementById("log"), sid: window.sessionId || "" };');
      if (v && v.ready && v.sid) return;
    } catch (e) { /* 还没就绪 */ }
    await sleep(300);
  }
  throw new Error('页面没起来（#log / sessionId 一直没就绪）');
}

/** 装桩 + 摆数据。opts.persist = 写进 localStorage（给 reload 用） */
async function arm(payload, { persist = false } = {}) {
  await cdp.eval(INSTALL + '\nreturn 1;');
  const sid = await cdp.eval('return window.sessionId || "";');
  const p = Object.assign({ sid, gap: 400 }, payload);
  /* 【换框架】按事件前缀算出每一步的 items，桩照它一节一节地给 */
  if (Array.isArray(p.events) && p.events.length) {
    p.steps = stepsOf(p.events);
    const _lastEv = p.events[p.events.length - 1] || {};
    p.endEvent = ['done', 'aborted', 'error'].includes(String(_lastEv.type || ''));
  }
  p.i = 0;
  await cdp.eval('window.__qa = Object.assign(window.__qa || {}, ' + JSON.stringify(p) + '); return 1;');
  if (persist) {
    await cdp.eval('localStorage.setItem("__qa_payload", ' + JSON.stringify(JSON.stringify(p)) + '); return 1;');
  }
  return sid;
}

const snap = () => cdp.eval('return window.__qaSnap();');

/** 一边跑一边取样：返回整条时间线上的快照数组 */
async function watch(times, gapMs = 100) {
  const out = [];
  for (let i = 0; i < times; i++) {
    try { out.push(await snap()); } catch (e) { /* 重载中可能取不到 */ }
    await sleep(gapMs);
  }
  return out;
}

let SID_BOOT = '';

/* ══════════════════════════════════════════════════════════════════
 * 一 + 二 + 五：说 → 工具 → 说 → 轮末 → 说
 * ══════════════════════════════════════════════════════════════════ */
async function caseSegments() {
  console.log('\n一、一轮里「说 → 工具 → 说 → 轮末 → 说」：屏幕上几个气泡、每段几次');
  const A = 'QA甲段我去看一眼';
  const B = 'QA乙段看完了没问题';
  const C = 'QA丙段下一轮接着说';
  const THINK = 'QA思考先想想要不要拆开写这一点要够长才像真的思考块';

  await arm({
    gap: 420,
    events: [
      { type: 'reasoning', text: THINK },
      { type: 'text', text: A },
      { type: 'tool_start', id: 'qa1', name: 'run_command', args: '{"cmd":"echo hi"}' },
      { type: 'tool_end', id: 'qa1', ok: true, output: 'hi' },
      { type: 'text', text: B },
      { type: 'done' },
      { type: 'text', text: C },
    ],
    turns: [
      { role: 'user', text: 'QA 主人一句' },
      { role: 'assistant', text: A + '\n\n' + B + '\n\n' + C },
    ],
    live: null,
  });

  await cdp.eval('window.__qaTurnP = window.runTurn({ text: "QA 主人一句" }); return 1;');
  const series = await watch(45, 100);

  /* 时间线上的不变式：任何一刻，每段文字最多出现一次 */
  let dup = null;
  for (const s of series) {
    for (const [name, mark] of [['甲', A], ['乙', B], ['丙', C]]) {
      if (cnt(s.text, mark) > 1) { dup = name + ' 出现 ' + cnt(s.text, mark) + ' 次'; break; }
    }
    if (dup) break;
  }
  ok(!dup, '整个过程任何一刻都没有「同一段出现两遍」', dup || '');

  const maxLive = Math.max(...series.map((s) => s.liveCount || 0));
  const withThree = series.find((s) => s.liveCount === 3) || null;
  ok(maxLive === 3, '直播期间正文容器最多 3 个（一段一个）', '最多见到 ' + maxLive + ' 个');

  /* 工具卡 / 思考块在直播期间的样子（回归面）
   * 注意：第一次看见工具卡那一刻它当然还是「运行中…」，所以这里看**整条时间线上
   * 有没有出现过「完成」**，不是看第一次见到它的那一帧。（上一版写错了，测试自身的 bug） */
  const toolSample = series.find((s) => s.tool === 1) || null;
  ok(!!toolSample, '直播期间工具卡出现了', '工具卡数：' + series.map((s) => s.tool).join(''));
  ok(series.some((s) => s.tool === 1 && s.toolStatus.join('') === '完成'), '工具卡状态从「运行中…」走到了「完成」',
    series.filter((s) => s.tool).map((s) => s.toolStatus.join('')).join(' → '));
  ok(series.every((s) => s.tool <= 1), '工具卡全程只有一张（没有重画出第二张）',
    '最多 ' + Math.max(...series.map((s) => s.tool || 0)) + ' 张');
  const thinkSample = series.find((s) => s.think >= 1) || null;
  ok(!!thinkSample, '思考块画出来了（details.think）', '思考块数：' + series.map((s) => s.think).join(''));
  ok(!!thinkSample && cnt(thinkSample.thinkBody, THINK) === 1, '思考块正文恰好一份',
    thinkSample ? 'thinkBody 命中 ' + cnt(thinkSample.thinkBody, THINK) : '—');
  ok(!!thinkSample && /字|想/.test(thinkSample.thinkTitle || ''), '思考块标题有字数/摘要', thinkSample ? thinkSample.thinkTitle : '—');

  /* 「正在发送消息」在跑的时候必须在 */
  ok(series.some((s) => s.sending), '跑着的时候「正在发送消息」在屏幕上');

  /* 轮末之后那段（丙）另起一个气泡，不是接在乙后面 */
  ok(!!withThree && cnt(withThree.live.join('|'), B) === 1 && cnt(withThree.live.join('|'), C) === 1,
    '轮末之后的那段另起一个容器（乙、丙各在自己那句里）',
    withThree ? JSON.stringify(withThree.live) : '没抓到 liveCount=3 那一刻');

  /* 等 runTurn 收尾（settleFromHistory 会把这一屏交给历史） */
  for (let i = 0; i < 60; i++) {
    const b = await cdp.eval('return !!window.busy;');
    if (!b) break;
    await sleep(200);
  }
  await sleep(1200);
  const fin = await snap();
  /* 【改判据】原来是「直播节点全收掉」——那验的是实现（data-live-turn 标记消失）。
   * 现在验行为：跑完屏幕上就是历史那一轮，一段正文，三段文字各在里面出现一次。 */
  ok(fin.liveCount === 1, '跑完只留历史画的那一段（直播那一份不另留）', '实际 ' + fin.liveCount + ' 段');
  for (const [name, mark] of [['甲', A], ['乙', B], ['丙', C]]) {
    ok(cnt(fin.text, mark) === 1, '跑完落历史后「' + name + '」只出现一次', '出现 ' + cnt(fin.text, mark) + ' 次');
  }
  ok(fin.streaming === 0, '跑完光标摘干净了（.bubble.streaming = 0）', '还剩 ' + fin.streaming);
}

/* ══════════════════════════════════════════════════════════════════
 * 四：⏹ 停止（aborted）—— 提示不许混进正文、思考块 / 光标收干净
 * ══════════════════════════════════════════════════════════════════ */
async function caseAborted() {
  console.log('\n四、⏹ 停止：提示独立成行、不混进她的正文');
  const D = 'QA半句话说到一半就停';
  await arm({
    gap: 420,
    events: [
      { type: 'reasoning', text: 'QA停止前想了一点东西这段也要够长一点点' },
      { type: 'text', text: D },
      { type: 'aborted' },
    ],
    turns: [{ role: 'user', text: 'QA 主人一句' }, { role: 'assistant', text: D }],
    live: null,
  });
  await cdp.eval('window.__qaTurnP = window.runTurn({ text: "QA 主人一句（停止）" }); return 1;');
  /* 取密一点：aborted 之后 settleFromHistory 会把这一屏交给历史，
   * 那条提示只在这一小段窗口里活着（历史上不记它），100ms 一取会整体错过。 */
  const series = await watch(70, 40);
  ok(series.some((s) => s.streaming >= 1), '跑着的时候有流式光标');
  ok(series.some((s) => s.think >= 1), 'aborted 之前思考块在');
  const noteSeen = series.find((s) => s.notes.some((n) => n.indexOf('已停止') >= 0)) || null;
  ok(!!noteSeen, '[已停止] 作为独立提示行出现过（不是写进她的气泡）',
    'notes 采样：' + JSON.stringify(series.map((s) => s.notes)));
  ok(!!noteSeen && !noteSeen.bubbles.some((b) => b.indexOf('已停止') >= 0),
    '[已停止] 没有混进她说的正文里', noteSeen ? JSON.stringify(noteSeen.bubbles) : '—');
  const dupNote = series.find((s) => cnt(s.text, '已停止') > 1) || null;
  ok(!dupNote, '[已停止] 全程没有出现两遍', dupNote ? '出现 ' + cnt(dupNote.text, '已停止') + ' 次' : '');
  /* 收尾之后光标必须摘干净（这一条看最后那一帧） */
  await sleep(1500);
  const after = await snap();
  ok(after.streaming === 0, '停下来之后光标摘掉', '还剩 ' + after.streaming + ' 个');
  ok(cnt(after.text, D) <= 1, '停下之后那半句没有重复', '出现 ' + cnt(after.text, D) + ' 次');
}

/* ══════════════════════════════════════════════════════════════════
 * 三：F5 —— 真 reload，历史里已有本轮的半截 + 直播清单里也有
 * ══════════════════════════════════════════════════════════════════ */
async function caseReload() {
  console.log('\n三、F5（真 reload）：正在跑的一轮重画之后不重复');
  const P1 = 'QA重载前已经说出来的第一段话';
  const P2 = 'QA重载时还在长的第二段话';

  const payload = {
    gap: 400,
    live: {
      running: true,
      startedAt: Date.now(),
      items: [
        { k: 'text', t: P1 },
        { k: 'tool', id: 'qa9', name: 'run_command', args: '{}', status: 'ok', output: 'ok' },
        { k: 'text', t: P2 },
      ],
      events: [],
    },
    /* 关键：服务端边跑边落盘 —— 历史里已经有第一段（这正是重复的来源） */
    turns: [
      { role: 'user', text: 'QA 主人一句（重载）' },
      { role: 'assistant', text: P1 },
    ],
    sid: SID_BOOT,
  };

  /* 桩要在页面脚本之前就装好 —— 用 addScriptToEvaluateOnNewDocument */
  if (!cdp.__qaAdded) {
    await cdp.send('Page.enable', {});
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: INSTALL });
    cdp.__qaAdded = true;
  }
  await cdp.eval('localStorage.setItem("__qa_payload", ' + JSON.stringify(JSON.stringify(payload)) + '); return 1;');
  await cdp.eval('location.reload(); return 1;').catch(() => {});

  /* 等重载完成 + 页面画完 */
  let ready = false;
  for (let i = 0; i < 80; i++) {
    await sleep(300);
    try {
      const v = await cdp.eval('return { ok: !!document.getElementById("log"), sid: window.sessionId || "", n: document.querySelectorAll("#log .msg").length };');
      if (v && v.ok && v.sid && v.n > 0) { ready = true; break; }
    } catch (e) { /* 重载中 */ }
  }
  ok(ready, '重载后页面画出来了（#log 有内容）');
  if (!ready) return;
  await sleep(1500);
  const s = await snap();
  ok(cnt(s.text, P1) === 1, 'F5 之后「第一段」只有一份', '出现 ' + cnt(s.text, P1) + ' 次：' + s.text.slice(0, 200));
  ok(cnt(s.text, P2) === 1, 'F5 之后「第二段」只有一份', '出现 ' + cnt(s.text, P2) + ' 次');
  ok(s.liveCount === 2, 'F5 之后正文容器数 == 清单里的正文条数（2）', '实际 ' + s.liveCount + ' 个');
  ok(s.allCount === 2, 'F5 之后历史里那半截没有另外画一份（assistant 容器总数 2）', '实际 ' + s.allCount + ' 个');
  ok(s.tool === 1, 'F5 之后工具卡只有一张', '实际 ' + s.tool + ' 张');

  /* 切走再切回来：同一份数据，仍然一份 */
  const others = await fetch(iso.base + '/api/sessions/new', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: '__qa_other__' }),
  }).then((r) => r.json()).catch(() => null);
  const otherId = others && (others.session && others.session.id || others.id);
  if (otherId) {
    await cdp.eval('window.__qa.turns = null; window.__qa.live = null; return 1;');
    await cdp.eval('return window.switchSessionSafe(' + JSON.stringify(otherId) + ');').catch(() => {});
    await sleep(800);
    await cdp.eval('window.__qa.turns = ' + JSON.stringify(payload.turns) + '; window.__qa.live = ' + JSON.stringify(payload.live) + '; return 1;');
    await cdp.eval('return window.switchSessionSafe(' + JSON.stringify(SID_BOOT) + ');').catch(() => {});
    await sleep(1800);
    const s2 = await snap();
    ok(cnt(s2.text, P1) === 1 && cnt(s2.text, P2) === 1,
      '切走再切回来：两段各一份', '甲 ' + cnt(s2.text, P1) + ' / 乙 ' + cnt(s2.text, P2));
    ok(s2.liveCount === 2, '切走再切回来：容器数仍是 2', '实际 ' + s2.liveCount);
  } else {
    ok(false, '切走再切回来：没能建第二个会话', '——');
  }
}

/* ══════════════════════════════════════════════════════════════════
 * 六：口径定案后最重要的一条 —— 跑着 3 个气泡 → 刷新之后仍然 3 个
 * ══════════════════════════════════════════════════════════════════ */
async function caseThreeToThree() {
  console.log('\n六、跑着 3 个气泡 → 中途 F5 → 刷新之后仍然 3 个');
  const S1 = 'QA三段甲她说了一句';
  const S2 = 'QA三段乙工具跑完接着说';
  const S3 = 'QA三段丙轮末之后又是另一段';
  const events = [
    { type: 'text', text: S1 },
    { type: 'tool_start', id: 'z1', name: 'run_command', args: '{}' },
    { type: 'tool_end', id: 'z1', ok: true, output: 'o' },
    { type: 'text', text: S2 },
    { type: 'done' },
    { type: 'text', text: S3 },
  ];

  /* ① 真跑起来：流不关（holdOpen），所以这一轮一直是「正在跑」 */
  await arm({ gap: 320, holdOpen: true, events, live: null, turns: null });
  await cdp.eval('window.__qaTurnP = window.runTurn({ text: "QA 三段" }); return 1;');
  const series = await watch(50, 100);
  const maxLive = Math.max(0, ...series.map((s) => s.liveCount || 0));
  ok(maxLive === 3, '跑着的时候屏幕上 3 个气泡', '最多见到 ' + maxLive + ' 个');
  const atThree = series.find((s) => s.liveCount === 3) || null;
  ok(!!atThree && [S1, S2, S3].every((x) => cnt(atThree.text, x) === 1),
    '跑着的时候三段各一份', atThree ? JSON.stringify(atThree.live) : '没抓到 3 个那一刻');

  /* ② 服务端此刻手里的清单 —— 用线上那两个合成器真跑一遍，不自己编 */
  const sv = serverLiveItems(events);
  const svTexts = sv.filter((x) => x.k === 'text').map((x) => String(x.t || ''));
  ok(svTexts.length === 3, '服务端清单里也是 3 段正文（' + svTexts.length + '）', JSON.stringify(svTexts));

  /* ③ 真 F5：把服务端这份清单当成 /api/chat/live 的 items 交给刷新后的页面 */
  const payload = {
    gap: 320,
    live: { running: true, startedAt: Date.now(), items: sv, events: [] },
    turns: [
      { role: 'user', text: 'QA 三段' },
      { role: 'assistant', text: S1 },      // 服务端边跑边落盘：历史里已经有第一段
    ],
    sid: SID_BOOT,
  };
  if (!cdp.__qaAdded) {
    await cdp.send('Page.enable', {});
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: INSTALL });
    cdp.__qaAdded = true;
  }
  await cdp.eval('localStorage.setItem("__qa_payload", ' + JSON.stringify(JSON.stringify(payload)) + '); return 1;');
  await cdp.eval('location.reload(); return 1;').catch(() => {});

  let ready = false;
  for (let i = 0; i < 80; i++) {
    await sleep(300);
    try {
      const v = await cdp.eval('return { ok: !!document.getElementById("log"), sid: window.sessionId || "", n: document.querySelectorAll("#log .msg").length };');
      if (v && v.ok && v.sid && v.n > 0) { ready = true; break; }
    } catch (e) { /* 重载中 */ }
  }
  ok(ready, 'F5 之后页面重新画出来了');
  if (!ready) return;
  await sleep(1500);

  const after = await snap();
  ok(after.liveCount === 3, 'F5 之后仍然是 3 个气泡', '实际 ' + after.liveCount + ' 个');
  for (const [nm, mark] of [['甲', S1], ['乙', S2], ['丙', S3]]) {
    ok(cnt(after.text, mark) === 1, 'F5 之后「' + nm + '」只出现一次', '出现 ' + cnt(after.text, mark) + ' 次');
  }
  ok(after.allCount === 3, 'F5 之后历史里那半截没有另外画一份（assistant 容器总数 3）', '实际 ' + after.allCount + ' 个');
  /* 收尾：把这个 payload 清掉，别影响后面的 case */
  await cdp.eval('localStorage.removeItem("__qa_payload"); return 1;').catch(() => {});
}

/* ══════════════════════════════════════════════════════════════════
 * 主线
 * ══════════════════════════════════════════════════════════════════ */
try {
  await boot();
  SID_BOOT = await cdp.eval('return window.sessionId || "";');
  console.log('当前会话 ' + SID_BOOT);
  await caseSegments();
  await caseAborted();
  await caseReload();
  await caseThreeToThree();
} catch (e) {
  fail++;
  console.log('  [!!] 跑挂了：' + (e && e.stack ? e.stack : e));
} finally {
  try { cdp && cdp.close(); } catch (e) {}
  try { iso && await iso.stop(); } catch (e) {}
}

console.log('\n结果: ' + pass + ' 过 / ' + fail + ' 挂\n');
process.exit(fail ? 1 : 0);
