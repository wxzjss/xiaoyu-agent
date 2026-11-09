#!/usr/bin/env node
/**
 * 【QA 独立复核 · 2026-11-09】真模型 + 真浏览器：流式跑到一半 F5 / 插话。
 *
 * 跟 check-live-render-dom.mjs 的分工：
 *   · 那份用「可控 SSE 桩」保证确定性，验的是「画法」；
 *   · 这份一个字都不桩 —— 真会话、真模型、真工具调用、真 CDP reload，
 *     验的是「真机上主人会遇到的时机」：正在流式输出 + 调工具的中途按 F5、
 *     以及流式中插一句话。
 *
 * 模型不通 / 上游 502 时**不判红**，打 SKIP —— 那是环境问题，不该算成代码坏了。
 * 但「跑起来了但屏幕上重复/丢字」一定判红。
 *
 * 用法：node scripts/check-live-real-refresh.mjs
 */
import { startIsolated } from './_test-instance.mjs';
import { connect } from '../_t_cdp.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0;
let fail = 0;
let skip = 0;
const ok = (c, m, extra) => {
  if (c) { pass++; console.log('  OK   ' + m); }
  else { fail++; console.log('  [!!] ' + m + (extra ? '  → ' + extra : '')); }
};
const sk = (m, why) => { skip++; console.log('  SKIP ' + m + (why ? '  → ' + why : '')); };

let iso = null;
let cdp = null;
const BASE = () => iso.base;

async function api(path, opt) {
  const r = await fetch(BASE() + path, { headers: { 'Content-Type': 'application/json' }, ...opt });
  const t = await r.text();
  let j = null;
  try { j = JSON.parse(t); } catch {}
  return { status: r.status, j, t };
}
const liveOf = (sid) => api('/api/chat/live?sessionId=' + encodeURIComponent(sid)).then((r) => r.j || {});
const selectOf = (sid) => api('/api/sessions/select', { method: 'POST', body: JSON.stringify({ id: sid }) }).then((r) => (r.j && r.j.session) || null);

const norm = (s) => String(s || '').replace(/\s+/g, '');
const cnt = (hay, needle) => String(hay || '').split(String(needle)).length - 1;
/** 从一段正文里挑一个「够独特」的片段来数次数（绕开 markdown 符号） */
function fp(t) {
  const s = String(t || '');
  const m = s.match(/[A-Za-z0-9_-]{6,}/g);
  if (m && m.length) return m.sort((a, b) => b.length - a.length)[0];
  const c = norm(s);
  return c.length >= 6 ? c.slice(0, 6) : '';
}
const textsOf = (items) => (Array.isArray(items) ? items : []).filter((x) => x && x.k === 'text' && String(x.t || '').trim());

async function waitBoot(sid, ms = 90000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try {
      const v = await cdp.eval('return { ok: !!document.getElementById("log"), sid: window.sessionId || "", n: document.querySelectorAll("#log .msg").length };');
      if (v && v.ok && String(v.sid) === String(sid) && v.n > 0) return true;
    } catch (e) { /* 重载中 */ }
    await sleep(300);
  }
  return false;
}

const snap = () => cdp.eval(`return (function(){
  var lg = document.getElementById('log');
  var tx = function(el){ return String((el && el.textContent) || '').replace(/\\s+/g,''); };
  var q = function(sel){ return [].slice.call(lg.querySelectorAll(sel)); };
  return {
    text: tx(lg),
    liveCount: q('.msg.assistant[data-live-turn="1"]').length,
    allCount: q('.msg.assistant').length,
    asstBubbles: q('.msg.assistant').map(function(m){ return { live: m.dataset.liveTurn === '1', text: tx(m) }; }),
    userBubbles: q('.msg.user').map(tx),
    streaming: q('.bubble.streaming').length
  };
})()`);

/**
 * 「某一整段正文在屏幕上出现了几份」—— 按**容器**数，不是按字串在整屏文本里数。
 *
 * 【为什么不能用「数关键字在整屏文本里出现几次」】
 * 第一版就是这么写的，结果模型自己把 QAAB12 复述了 22 遍，检查报「重复 22 次」——
 * 那是假红，冤枉代码。屏幕上的「重复」只有一个意思：**同一段正文长出两个容器**。
 * 所以判据是「有几个 assistant 容器包含这一段」，正常必须恰好 1。
 */
function bubblesWith(asstBubbles, piece) {
  const n = norm(piece);
  if (!n) return -1;
  return (asstBubbles || []).filter((b) => String(b.text || '').indexOf(n) >= 0).length;
}
/** 完全一样的两条气泡（>8 字才算，免得「好的」这种天然会重复） */
function exactDupBubbles(asstBubbles) {
  const seen = new Map();
  for (const b of (asstBubbles || [])) {
    const t = String(b.text || '');
    if (t.length < 8) continue;
    seen.set(t, (seen.get(t) || 0) + 1);
  }
  return [...seen.entries()].filter(([, n]) => n > 1).map(([t, n]) => n + '×' + t.slice(0, 16));
}

/** 等「跑完了并且屏幕交给历史」（直播节点归零） */
async function waitSettled(ms = 30000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const s = await snap().catch(() => null);
    if (s && s.liveCount === 0 && s.streaming === 0) return s;
    await sleep(500);
  }
  return await snap().catch(() => null);
}

/* ══════════════════════════════════════════════════════════════════
 * A. 真对话，流式中途 reload
 * ══════════════════════════════════════════════════════════════════ */
async function realReload() {
  console.log('\nA、真模型：正在流式输出 + 调工具的中途按 F5');
  const prompt = '请先调用 run_command 工具执行 echo QAAB12。然后写一段**比较长**的回答：'
    + '分成 6 段，每段两到三行，第一段里必须出现 QAAB12，最后一段里必须出现 QACD34。'
    + '每段之间空一行，不要用代码块。';
  const sid = await cdp.eval('return window.sessionId || "";');
  if (!sid) { sk('真机 F5', '页面没有会话'); return; }

  await cdp.eval('window.__qaTurnP = window.runTurn({ text: ' + JSON.stringify(prompt) + ' }); return 1;');

  /* 等「已经吐出正文、而且还在跑」的那一刻 */
  let mid = null;
  const t0 = Date.now();
  while (Date.now() - t0 < 150000) {
    const L = await liveOf(sid).catch(() => null);
    const tx = textsOf(L && L.items);
    if (L && L.running && tx.length >= 1 && String(tx[0].t || '').length >= 8) { mid = L; break; }
    if (L && !L.running && Date.now() - t0 > 45000) break;   // 一轮已经跑完了：等不到了
    await sleep(400);
  }
  if (!mid) {
    const L = await liveOf(sid).catch(() => null);
    sk('真机 F5（流式中途刷新）', '没抓到流式中的窗口（模型没回内容或被限流）: '
      + String((L && L.items || []).length) + ' 个 item');
    return;
  }
  const before = textsOf(mid.items).map((x) => String(x.t || ''));
  console.log('    刷新那一刻服务端已经吐了 ' + before.length + ' 段正文，共 ' + before.join('').length + ' 字；'
    + 'items 形状：' + mid.items.map((x) => x.k).join(','));

  await cdp.eval('location.reload(); return 1;').catch(() => {});
  const up = await waitBoot(sid);
  ok(up, 'F5 之后页面重新画出来了（同一条会话）');
  if (!up) return;
  await sleep(1200);

  const L2 = await liveOf(sid).catch(() => null);
  const s = await snap();
  const tx2 = textsOf(L2 && L2.items).map((x) => String(x.t || ''));
  if (L2 && L2.running) {
    ok(s.liveCount === tx2.length,
      'F5 之后正文容器数 == 服务端 live.items 里的正文条数（' + tx2.length + '）',
      '实际容器 ' + s.liveCount + ' 个 / 清单 ' + tx2.length + ' 段');
    let dup = 0;
    const detail = [];
    for (const t of tx2) {
      const n = bubblesWith(s.asstBubbles, t);
      if (n !== 1) { dup++; detail.push(n + ' 份：' + String(t).slice(0, 14)); }
    }
    ok(dup === 0, 'F5 之后每一段正文在屏幕上恰好一个容器', detail.join(' | '));
    ok(exactDupBubbles(s.asstBubbles).length === 0, 'F5 之后没有两条一模一样的气泡',
      exactDupBubbles(s.asstBubbles).join(' | '));
  } else {
    console.log('    （刷新回来时这一轮已经跑完了，按历史核对）');
  }

  /* 等这一轮真的跑完，再核对最终那一屏 */
  const t1 = Date.now();
  let L3 = null;
  while (Date.now() - t1 < 180000) {
    L3 = await liveOf(sid).catch(() => null);
    if (L3 && !L3.running) break;
    await sleep(700);
  }
  ok(!!(L3 && !L3.running), '这一轮跑完（live.running = false）');
  const fin = await waitSettled(30000);
  ok(fin.liveCount === 0, '跑完之后直播节点全部收掉', '还剩 ' + fin.liveCount);
  const sess = await selectOf(sid);
  const asstText = norm(((sess && sess.turns) || []).filter((x) => x && x.role === 'assistant' && !x.whale).map((x) => x.text).join('\n'));
  ok(asstText.length > 0, '这一轮落盘了（历史里有她的正文，' + asstText.length + ' 字）');
  const allTx = textsOf((L3 && L3.items) || []).map((x) => String(x.t || ''));
  let miss = 0;
  const missDetail = [];
  for (const t of allTx) {
    const k = fp(t);
    if (!k) continue;
    if (asstText.indexOf(norm(k)) < 0) { miss++; missDetail.push(k); }
  }
  ok(miss === 0, '直播里出现过的每一段都落进了历史（没有「屏幕上停半句」）', missDetail.join(','));
  let dup2 = 0;
  const d2 = [];
  for (const t of allTx) {
    const n = bubblesWith(fin.asstBubbles, t);
    if (n !== 1) { dup2++; d2.push(n + ' 份：' + String(t).slice(0, 14)); }
  }
  ok(dup2 === 0, '跑完那一屏里每段正文只有一个容器', d2.join(' | '));
  ok(exactDupBubbles(fin.asstBubbles).length === 0, '跑完那一屏里没有两条一模一样的气泡',
    exactDupBubbles(fin.asstBubbles).join(' | '));
}

/* ══════════════════════════════════════════════════════════════════
 * B. 真对话，流式中途插话
 * ══════════════════════════════════════════════════════════════════ */
async function realInterject() {
  console.log('\nB、真模型：流式中途插话（window.interject 走的就是主人按发送那条路）');
  const prompt = '请先调用 run_command 工具执行 echo QAEF56，然后写一段长回答：分成 6 段，每段两到三行，'
    + '第一段写 QAEF56，最后一段写 QAGH78。不要用代码块。';
  const interj = 'QA 插话：先停一下，改成只回答 QAIJ90 这一句。';
  const sid = await cdp.eval('return window.sessionId || "";');
  if (!sid) { sk('真机插话', '页面没有会话'); return; }

  await cdp.eval('window.__qaTurnP = window.runTurn({ text: ' + JSON.stringify(prompt) + ' }); return 1;');

  /* 等真的开始吐字 */
  let mid = null;
  const t0 = Date.now();
  while (Date.now() - t0 < 150000) {
    const L = await liveOf(sid).catch(() => null);
    const tx = textsOf(L && L.items);
    if (L && L.running && tx.length >= 1 && String(tx[0].t || '').length >= 6) { mid = L; break; }
    if (L && !L.running && Date.now() - t0 > 45000) break;
    await sleep(300);
  }
  if (!mid) { sk('真机插话', '没抓到流式中的窗口（模型没回内容或被限流）'); return; }
  const before = textsOf(mid.items).map((x) => String(x.t || ''));
  const beforeSnap = await snap();
  console.log('    插话那一刻：服务端 ' + before.length + ' 段正文 / 屏幕上 ' + beforeSnap.liveCount + ' 个直播容器');

  const r = await cdp.eval('document.getElementById("input").value = ' + JSON.stringify(interj) + ';'
    + 'var _p = window.interject(); window.__qaInterjectP = _p; return 1;');
  await sleep(1500);

  /* 等这一轮（含续跑那一轮）彻底结束 */
  const t1 = Date.now();
  let L = null;
  let quiet = 0;
  while (Date.now() - t1 < 200000) {
    L = await liveOf(sid).catch(() => null);
    const busy = await cdp.eval('return !!window.busy;').catch(() => false);
    if (L && !L.running && !busy) { quiet++; if (quiet >= 3) break; } else quiet = 0;
    await sleep(900);
  }
  ok(!!(L && !L.running), '插话之后两轮都跑完了（live.running = false）');
  const fin = await waitSettled(30000);

  const sess = await selectOf(sid);
  const turns = (sess && sess.turns) || [];
  const users = turns.filter((x) => x && x.role === 'user').map((x) => String(x.text || ''));
  ok(users.length >= 2, '历史里主人现在有两条消息（原话 + 插话）', '实际 ' + users.length + ' 条：' + JSON.stringify(users.map((x) => x.slice(0, 16))));
  ok(users.length >= 2 && norm(users[users.length - 1]).indexOf(norm('先停一下')) >= 0,
    '插话那条排在最后一条主人消息（位置对）', JSON.stringify(users.slice(-1)));
  /* 插话这条必须排在她第一轮回答之后 —— 用下标判 */
  const ui = turns.findIndex((x) => x && x.role === 'user' && norm(x.text).indexOf(norm('先停一下')) >= 0);
  const aBefore = turns.findIndex((x, i) => i < ui && x && x.role === 'assistant' && !x.whale);
  ok(ui > 0 && aBefore >= 0, '插话排在「她的第一段回答」之后（不是插到很早以前）', 'user@' + ui + ' / assistant@' + aBefore);

  /* 「已说出的字没被截断」：插话前屏幕上那几段，在历史里必须还找得到 */
  const hist = norm(turns.filter((x) => x && x.role === 'assistant').map((x) => x.text).join('\n'));
  let cut = 0;
  const cutDetail = [];
  for (const t of before) {
    const k = fp(t) || norm(t).slice(0, 6);
    if (!k) continue;
    if (hist.indexOf(norm(k)) < 0) { cut++; cutDetail.push(t.slice(0, 18)); }
  }
  ok(cut === 0, '插话前已经说出来的字没被截断（历史里都还在）', cutDetail.join(' | '));

  /* 屏幕上：每一段只落在一个容器里（按容器数，不按字串出现次数） */
  ok(fin.liveCount === 0, '跑完之后直播节点收干净了', '还剩 ' + fin.liveCount);
  let dup = 0;
  const dd = [];
  for (const t of before) {
    const n = bubblesWith(fin.asstBubbles, t);
    if (n !== 1) { dup++; dd.push(n + ' 份：' + String(t).slice(0, 14)); }
  }
  ok(dup === 0, '插话前那几段在屏幕上各只有一个容器（没被画成两份）', dd.join(' | '));
  ok(exactDupBubbles(fin.asstBubbles).length === 0, '插话之后没有两条一模一样的气泡',
    exactDupBubbles(fin.asstBubbles).join(' | '));
  /* 插话那条主人消息在屏幕上也只有一条 */
  const interjBubbles = (fin.userBubbles || []).filter((u) => String(u).indexOf(norm('先停一下')) >= 0);
  ok(interjBubbles.length === 1, '插话那条主人消息在屏幕上只有一条', '实际 ' + interjBubbles.length + ' 条');
}

try {
  iso = await startIsolated();
  console.log('隔离实例 ' + iso.base + '（CDP ' + iso.cdpPort + '）');
  cdp = await connect({ port: iso.cdpPort });
  let ok0 = false;
  for (let i = 0; i < 100; i++) {
    try {
      const v = await cdp.eval('return { ready: !!document.getElementById("log"), sid: window.sessionId || "" };');
      if (v && v.ready && v.sid) { ok0 = true; break; }
    } catch (e) {}
    await sleep(300);
  }
  if (!ok0) throw new Error('页面没起来');
  await realReload();
  /* 换一条干净会话再验插话 */
  const n = await api('/api/sessions/new', { method: 'POST', body: JSON.stringify({ title: '__qa_interject__' }) });
  const nid = n.j && (n.j.session && n.j.session.id || n.j.id);
  if (nid) {
    await cdp.eval('localStorage.setItem("mini-agent.sessionId", ' + JSON.stringify(nid) + '); return 1;');
    await cdp.eval('location.reload(); return 1;').catch(() => {});
    await waitBoot(nid);
    await sleep(800);
    await realInterject();
  } else {
    sk('真机插话', '建会话失败');
  }
} catch (e) {
  fail++;
  console.log('  [!!] 跑挂了：' + (e && e.stack ? e.stack : e));
} finally {
  try { cdp && cdp.close(); } catch (e) {}
  try { iso && await iso.stop(); } catch (e) {}
}

console.log('\n结果: ' + pass + ' 过 / ' + fail + ' 挂 / ' + skip + ' 跳过\n');
process.exit(fail ? 1 : 0);
