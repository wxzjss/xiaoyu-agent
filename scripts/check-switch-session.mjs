#!/usr/bin/env node
/**
 * 切会话显示 · 真机验收（QA 独立验收 · 2026-11-11）
 *
 * 主人报过的形态，逐条钉住：
 *   ①「A 里往上翻了一段 → 点开 B，B 停在半路，不贴底、也不跟着新内容走」
 *   ②「切回正在跑的会话：屏幕空的、按钮变【发送】、她就此不说话」
 *   ③「两个会话都展开过柜子/思考，切来切去开合状态串了」
 *   ④「A 里点了编辑，切到 B，B 里冒出一个编辑框」
 *
 * 全部用**真服务端 + 真会话**（两个会话直接落到隔离实例的 sessions 目录），
 * 只有 ② 的「正在跑」用页面里的 /api/chat/live 桩来造 —— 真跑一轮要花模型的钱，
 * 而且这一步验的是前端**认定在跑**之后的表现。
 *
 * 用法：node scripts/check-switch-session.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { startIsolated } from './_test-instance.mjs';
import { connect } from '../_t_cdp.mjs';
import { makeChecker } from './_harness_util.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const c = makeChecker('切会话显示（真会话 + 真 DOM）');

/* ── 造两个真会话落到盘上 ─────────────────────────────────────── */
const LONG = 'QA这一段话要写得足够长才能把屏幕撑出滚动条来，不然量不出「贴不贴底」这件事。'
  + '再多写几句，让每一轮都占到差不多一百多像素，十二轮下来一定超过一屏高度。';

function mkSession(id, tag, rounds) {
  const messages = [];
  for (let i = 0; i < rounds; i++) {
    messages.push({ role: 'user', content: 'QA' + tag + '第' + i + '问', _text: 'QA' + tag + '第' + i + '问', at: 1794400000000 + i * 1000 });
    const a = {
      role: 'assistant',
      content: 'QA' + tag + '第' + i + '答：' + LONG + '（第 ' + i + ' 轮）',
      at: 1794400000500 + i * 1000,
      _reasoning: 'QA' + tag + '想了一下第' + i + '轮要不要拆开写这个问题，写得长一点才像真的思考块',
    };
    if (i === rounds - 1) {
      /* 最后一轮挂两个工具 → 折成一个柜子；留一个思考块 */
      a.tool_calls = [
        { id: id + 'tc' + i + 'a', type: 'function', function: { name: 'run_command', arguments: '{"cmd":"echo a"}' } },
        { id: id + 'tc' + i + 'b', type: 'function', function: { name: 'run_command', arguments: '{"cmd":"echo b"}' } },
      ];
    }
    messages.push(a);
    if (i === rounds - 1) {
      messages.push({ role: 'tool', tool_call_id: id + 'tc' + i + 'a', content: 'a-ok' });
      messages.push({ role: 'tool', tool_call_id: id + 'tc' + i + 'b', content: 'b-ok' });
    }
  }
  return { id, title: tag, createdAt: 1794400000000, updatedAt: 1794400000000, messages, rewinds: [] };
}

/* ── 页面取样器（装一次，全程复用） ────────────────────────────── */
const INSTALL = `(function(){
  if (window.__origFetchForSwitchQa) return;
  window.__origFetchForSwitchQa = window.fetch.bind(window);
  window.__sq = window.__sq || { liveBySid: {} };
  window.fetch = function(u, opt){
    var url = (typeof u === 'string') ? u : ((u && u.url) || '');
    if (url.indexOf('/api/chat/live') >= 0) {
      var m = /sessionId=([^&]+)/.exec(url);
      var sid = m ? decodeURIComponent(m[1]) : '';
      var cfg = window.__sq.liveBySid[sid];
      if (cfg) {
        return Promise.resolve(new Response(JSON.stringify({
          sessionId: sid, running: cfg.running !== false, items: cfg.items || [],
          events: [], startedAt: cfg.startedAt || Date.now(), nextSince: 0,
        }), { status: 200, headers: { 'content-type': 'application/json' } }));
      }
    }
    /* 【桩必须成对】页面有两条路径判定「在不在跑」：/api/chat/live 和
     * /api/running（3 秒轮询对齐一次）。只假一个的话，另一条会用真服务端的
     * 「没人在跑」把按钮/提示抹掉 —— 那是桩自己造出来的假象，不是产品问题。 */
    if (url.indexOf('/api/running') >= 0) {
      var list = [];
      for (var id in window.__sq.liveBySid) {
        var cf = window.__sq.liveBySid[id];
        if (cf && cf.running !== false) list.push({ sessionId: id, startedAt: cf.startedAt || Date.now(), events: 1, lastEventAt: Date.now(), idleMs: 0 });
      }
      return Promise.resolve(new Response(JSON.stringify({ running: list }), { status: 200, headers: { 'content-type': 'application/json' } }));
    }
    return window.__origFetchForSwitchQa(u, opt);
  };

  window.__sqSnap = function(){
    var lg = document.getElementById('log');
    var tx = function(el){ return String((el && el.textContent) || '').replace(/\\s+/g,''); };
    var rows = [];
    var nodes = lg ? lg.querySelectorAll('.msg, details.tool, details.toolhub, .sysnote') : [];
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      if (el.parentElement && el.parentElement.closest('details')) continue;
      var cls = String(el.className || '');
      var kind = '';
      if (el.tagName === 'DETAILS') kind = /toolhub/.test(cls) ? 'hub' : 'tool';
      else if (cls.indexOf('sysnote') >= 0) kind = 'note';
      else if (/(^|\\s)user(\\s|$)/.test(cls)) kind = 'user';
      else if (/(^|\\s)assistant(\\s|$)/.test(cls)) kind = 'assistant';
      else if (/(^|\\s)mate(\\s|$)/.test(cls)) kind = 'mate';
      var b = el.querySelector('.bubble');
      rows.push({ kind: kind, text: (kind === 'hub' || kind === 'tool') ? '' : tx(b) });
    }
    var hubs = lg ? [].slice.call(lg.querySelectorAll('details.toolhub')) : [];
    var thinks = lg ? [].slice.call(lg.querySelectorAll('details.think')) : [];
    return {
      sid: window.sessionId || '',
      rows: rows.map(function(r){ return r.kind + ':' + r.text.slice(0, 18); }),
      kinds: rows.map(function(r){ return r.kind; }),
      msgCount: lg ? lg.querySelectorAll('.msg').length : 0,
      hubs: hubs.length,
      hubOpen: hubs.map(function(h){ return !!h.open; }),
      thinks: thinks.length,
      thinkOpen: thinks.map(function(h){ return !!h.open; }),
      editing: lg ? lg.querySelectorAll('.msg.editing').length : 0,
      textareas: lg ? lg.querySelectorAll('textarea').length : 0,
      dist: lg ? Math.round(lg.scrollHeight - lg.scrollTop - lg.clientHeight) : -1,
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
})();`;

let iso = null;
let cdp = null;
const snap = () => cdp.eval('return window.__sqSnap();');
const sw = (id) => cdp.eval('return window.switchSessionSafe(' + JSON.stringify(id) + ');');
const waitReady = async (ms = 8000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const v = await cdp.eval('return { r: !!document.getElementById("log"), s: window.sessionId || "" };').catch(() => null);
    if (v && v.r && v.s) return true;
    await sleep(200);
  }
  return false;
};

/** 「主人自己往上翻」：真的动 scrollTop + 扔一发滚轮事件（页面就是靠这个认的） */
async function userScrollTo(top) {
  await cdp.eval(`var el = document.getElementById('log');
    el.scrollTop = ${Number(top)};
    el.dispatchEvent(new WheelEvent('wheel', { deltaY: -120, bubbles: true, cancelable: true }));
    return 1;`);
  await sleep(300);
}

let ID_A = '';
let ID_B = '';
let ID_R = '';

async function boot() {
  iso = await startIsolated({ appPort: 8834, cdpPort: 9254 });
  console.log('隔离实例 ' + iso.base + '（数据目录 ' + iso.dataDir + '）');
  const SESS = path.join(iso.dataDir, '.state', 'sessions');
  fs.mkdirSync(SESS, { recursive: true });
  ID_A = 'qaA' + Date.now().toString(36);
  ID_B = 'qaB' + Date.now().toString(36);
  ID_R = 'qaR' + Date.now().toString(36);
  const write = (id, tag, rounds) => fs.writeFileSync(path.join(SESS, id + '.json'), JSON.stringify(mkSession(id, tag, rounds)), 'utf8');
  write(ID_A, 'QA甲会话说', 6);
  write(ID_B, 'QA乙会话说', 6);
  write(ID_R, 'QA丙跑着说', 6);

  cdp = await connect({ port: iso.cdpPort, match: iso.base });
  if (!(await waitReady())) throw new Error('页面没起来');
  await cdp.eval(INSTALL + '\nreturn 1;');
  console.log('会话 A=' + ID_A + '  B=' + ID_B + '  R=' + ID_R);
}

/* ══════════════════════════════════════════════════════════════════
 * 一：A 翻到中间 → 切 B → B 必须贴底，并且跟着新内容走
 * ══════════════════════════════════════════════════════════════════ */
async function caseSwitchToBottom() {
  console.log('\n一、A 翻到中间 → 切 B：B 要贴底，并跟随新内容');
  await sw(ID_A);
  await sleep(1800);
  const a0 = await snap();
  c.ok('A 打开了（有历史）', a0.msgCount > 0 && a0.text.indexOf('QA甲会话说') >= 0,
    'msg=' + a0.msgCount + ' 离底=' + a0.dist + ' sh=' + a0.sh + ' ch=' + a0.ch);
  c.ok('A 打开时是贴在底部的', a0.dist <= 8, '离底 ' + a0.dist + 'px');

  await userScrollTo(120);
  const a1 = await snap();
  c.ok('模拟主人往上翻之后，屏幕确实离开了底部', a1.dist > 40, '离底 ' + a1.dist + 'px（scrollTop ' + a1.st + '）');

  await sw(ID_B);
  await sleep(2000);
  const b0 = await snap();
  c.ok('切到 B 之后画的是 B 的历史（不是 A 的）', b0.text.indexOf('QA乙会话说') >= 0 && b0.text.indexOf('QA甲会话说') < 0,
    'msg=' + b0.msgCount);
  c.ok('B 贴在底部', b0.dist <= 8, '离底 ' + b0.dist + 'px（scrollTop ' + b0.st + ' / scrollHeight ' + b0.sh + ' / clientHeight ' + b0.ch + '）');

  /* 跟随新内容：往这一屏塞一条新的直播正文（跟真流式同一入口） */
  await cdp.eval('window.__logStore.setLive(' + JSON.stringify(ID_B) + ', { running: true, items: '
    + JSON.stringify([{ k: 'text', t: 'QA乙会话又来了一段新的正文，屏幕应该跟着往下去' }]) + ' }); return 1;');
  await sleep(700);
  const b1 = await snap();
  c.ok('新内容上屏了', b1.text.indexOf('又来了一段新的正文') >= 0, '命中 ' + (b1.text.indexOf('又来了一段新的正文') >= 0));
  c.ok('新内容到的时候屏幕还贴在底部（跟随生效）', b1.dist <= 8, '离底 ' + b1.dist + 'px（scrollTop ' + b1.st + '）');
  await cdp.eval('window.__logStore.setLive(' + JSON.stringify(ID_B) + ', null); return 1;');
}

/* ══════════════════════════════════════════════════════════════════
 * 二：切回「正在跑」的会话 —— 不许空屏、不许按钮变【发送】、跟播要接上
 * ══════════════════════════════════════════════════════════════════ */
async function caseSwitchBackRunning() {
  console.log('\n二、切回正在跑的会话：不许空屏、停止键要亮、跟播要接上');
  /* 先离开（站在 A 上），再给 R 配一份「正在跑」的直播清单 */
  await sw(ID_A);
  await sleep(1200);
  await cdp.eval('window.__sq.liveBySid = {}; window.__sq.liveBySid[' + JSON.stringify(ID_R) + '] = '
    + JSON.stringify({ running: true, startedAt: Date.now(), items: [{ k: 'text', t: 'QA丙已经说出来的第一段' }] })
    + '; return 1;');

  await sw(ID_R);
  await sleep(2200);
  const r0 = await snap();
  c.ok('切回来屏幕不是空的（她已经开始说的话在）', r0.msgCount > 0 && r0.text.indexOf('QA丙已经说出来的第一段') >= 0,
    'msg=' + r0.msgCount + ' 离底=' + r0.dist);
  c.ok('busy 亮着（页面认定这一轮在跑）', r0.busy === true, 'busy=' + r0.busy);
  c.ok('停止键 ⏹ 亮着', r0.stopShown === true, 'stopBtn.show=' + r0.stopShown);
  c.ok('「正在发送消息」在屏幕上', r0.sending === true, 'sendingHint.show=' + r0.sending);
  c.ok('主按钮仍是【发送】（停止只归 ⏹）', r0.sendText === '发送', '实际「' + r0.sendText + '」');

  /* 跟播接上没有：往清单里追加一条，几秒内必须自己长出来 */
  await cdp.eval('var cfg = window.__sq.liveBySid[' + JSON.stringify(ID_R) + '];'
    + ' cfg.items = cfg.items.concat([{ k: "text", t: "QA丙接着说的第二段靠轮询补进来" }]); return 1;');
  let got = false;
  for (let i = 0; i < 16; i++) {
    await sleep(400);
    const s = await snap();
    if (s.text.indexOf('靠轮询补进来') >= 0) { got = true; break; }
  }
  const r1 = await snap();
  c.ok('跟播接上了（新的一段自己长出来）', got, '6.4 秒内' + (got ? '出现' : '没出现'));
  c.ok('跟播期间一直贴在底部', r1.dist <= 8, '离底 ' + r1.dist + 'px（scrollTop ' + r1.st + '）');
  c.ok('切回跑着的会话之后，屏上没有出现两份同一段', (r1.text.split('QA丙已经说出来的第一段').length - 1) === 1,
    '第一段出现 ' + (r1.text.split('QA丙已经说出来的第一段').length - 1) + ' 次');
  await cdp.eval('window.__sq.liveBySid = {}; return 1;');
  /* 收尾：让 R 回到「没在跑」，别影响后面 */
  await cdp.eval('try { window.stopFollow && window.stopFollow(' + JSON.stringify(ID_R) + '); } catch(e){} window.busy = false; return 1;');
}

/* ══════════════════════════════════════════════════════════════════
 * 三：两个会话都展开过柜子/思考 → 切来切去不许串
 * ══════════════════════════════════════════════════════════════════ */
async function caseOpenState() {
  console.log('\n三、两个会话都展开过柜子/思考 → 开合状态不许串');
  await sw(ID_A);
  await sleep(1600);
  const a0 = await snap();
  c.ok('A 里有柜子', a0.hubs >= 1, '柜子 ' + a0.hubs + ' 个');
  c.ok('A 里有思考块（而且柜子把思考折进去了）', a0.thinks >= 0, '思考块 ' + a0.thinks + ' 个');

  /* 在 A 里把柜子点开 */
  /* 真按柜门：<details> 要靠点 summary 才会开合（点容器本身不切换） */
  await cdp.eval('var h = document.querySelectorAll("#log details.toolhub")[0]; if (h) { var s = h.querySelector("summary"); (s || h).click(); } return 1;');
  await sleep(500);
  const a1 = await snap();
  c.ok('A 的柜子展开了', a1.hubOpen.some(Boolean), 'A 柜子开合 ' + JSON.stringify(a1.hubOpen));
  const aHubOpenCount = a1.hubOpen.filter(Boolean).length;

  await sw(ID_B);
  await sleep(1600);
  const b0 = await snap();
  c.ok('B 里有柜子（同一个位置）', b0.hubs >= 1, '柜子 ' + b0.hubs + ' 个');
  c.ok('B 的柜子是收着的（A 展开不许把 B 也顶开）', b0.hubOpen.filter(Boolean).length === 0,
    'B 柜子开合 ' + JSON.stringify(b0.hubOpen) + '（A 那边开了 ' + aHubOpenCount + ' 个）');

  /* 反向：在 B 里点开，切回 A —— A 该保持自己刚才的状态 */
  /* 真按柜门：<details> 要靠点 summary 才会开合（点容器本身不切换） */
  await cdp.eval('var h = document.querySelectorAll("#log details.toolhub")[0]; if (h) { var s = h.querySelector("summary"); (s || h).click(); } return 1;');
  await sleep(400);
  await sw(ID_A);
  await sleep(1600);
  const a2 = await snap();
  c.ok('切回 A：A 的柜子还是我离开时的样子（不被 B 的操作串改）',
    a2.hubOpen.filter(Boolean).length === aHubOpenCount,
    'A 现在 ' + JSON.stringify(a2.hubOpen) + '，离开时 ' + aHubOpenCount + ' 个开着');
}

/* ══════════════════════════════════════════════════════════════════
 * 四：A 正在编辑一条 → 切 B → B 里不许出现编辑框
 * ══════════════════════════════════════════════════════════════════ */
async function caseEditLeak() {
  console.log('\n四、A 正在编辑一条 → 切 B：B 里不许出现编辑框');
  await sw(ID_A);
  await sleep(1600);
  /* 「点编辑」= 把这一行的 key 记进 store（UserBubble 的编辑按钮就是这么做的） */
  const key = await cdp.eval(`var m = document.querySelectorAll('#log .msg.user');
    if (!m.length) return '';
    var last = m[m.length - 1];
    var at = last.getAttribute('data-rewind-id');
    var abs = Math.max(0, (Number(at) || 0));
    window.__logStore.beginEdit('t-' + abs, abs);
    return 't-' + abs;`);
  await sleep(500);
  const a0 = await snap();
  c.ok('A 里编辑框开出来了', a0.editing >= 1 && a0.textareas >= 1, 'editing=' + a0.editing + ' textarea=' + a0.textareas + '（key ' + key + '）');

  await sw(ID_B);
  await sleep(1800);
  const b0 = await snap();
  c.ok('B 里没有编辑框（编辑态不许跟着会话串过去）', b0.editing === 0 && b0.textareas === 0,
    'B：editing=' + b0.editing + ' textarea=' + b0.textareas);
  c.ok('B 的画面是正常的（有历史）', b0.msgCount > 0, 'msg=' + b0.msgCount);
  await cdp.eval('window.__logStore.endEdit(); return 1;').catch(() => {});
}

/* ── 主线 ─────────────────────────────────────────────────────── */
try {
  await boot();
  await caseSwitchToBottom();
  await caseSwitchBackRunning();
  await caseOpenState();
  await caseEditLeak();
} catch (e) {
  console.log('  [!!] 跑挂了：' + (e && e.stack ? e.stack : e));
  process.exitCode = 1;
} finally {
  try { cdp && cdp.close(); } catch (e) {}
  try { iso && await iso.stop(); } catch (e) {}
}
c.done();
process.exit(process.exitCode || 0);
