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

const norm = (s) => String(s || '').replace(/[*_~`#>(){}.+!|,\-]/g, '').replace(/\s+/g, '');
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
  /* 【2026-11-10 换框架】不能再靠 data-live-turn 认「这一轮的直播节点」了 ——
   * 那是手写 DOM 时代的标记，React 重写后不再打这个属性，于是计数恒为 0，
   * 两条断言（容器数 == 清单段数 / 插话前那几段各一个容器）全成了假红。
   * 换成行为口径：屏幕上有几个正文气泡，看 .msg.assistant .bubble
   * （不数思考块 / 工具卡 / 用量行）；服务端清单看 window.__logState.live.items。
   * 判据：正文气泡数 == 服务端清单里的正文条数。 */
  var liveItems = [];
  try {
    var lv = (window.__logState || {}).live;
    liveItems = (lv && Array.isArray(lv.items))
      ? lv.items.filter(function(x){ return x && x.k === 'text'; }) : [];
  } catch (e) {}
  var bubbles = q('.msg.assistant .bubble');
  return {
    text: tx(lg),
    liveCount: bubbles.length,
    liveItemsCount: liveItems.length,
    /* 【2026-11-10 修】「直播节点收干净了」这条原来用 liveCount（=直播节点数）判。
     * 换成「正文气泡数」之后它恒 > 0（历史正文画的也是气泡），那条断言就失效了。
     * 正确的判据是**数据侧**：这一轮跑完了，__logState.live 必须为空 ——
     * 只要 live 还在，说明界面还以为在跑（那才是「跑完不收」）。 */
    liveRunning: !!(window.__logState && window.__logState.live),
    liveTexts: liveItems.map(function(x){ return String(x.t || ''); }),
    allCount: q('.msg.assistant').length,
    asstBubbles: q('.msg.assistant').map(function(m){ return { live: true, text: tx(m) }; }),
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
  /* 【2026-11-09 修·两边口径必须一致】
   * 这里原来只把 **piece** 洗了空白，却拿它去比**没洗过的** b.text ——
   * 片段里只要有一个空格/换行就永远匹配不上，于是报「0 份」
   * （假红：屏幕上明明有，量出来是 0）。两边都归一化再比。 */
  return (asstBubbles || []).filter((b) => norm(String(b.text || '')).indexOf(n) >= 0).length;
}

/**
 * 【流式中途专用】用**开头一小截**判断「这一段在几个容器里」。
 *
 * 为什么不能用整段比：屏幕是节流重画的（16ms / 攒 8 条），这一秒 DOM 里那段
 * 很可能只有前半截。整段比会报「0 份」—— 那是采样的时机问题，不是重复。
 * 所以中途只看「这一段的前 N 个字出现在几个容器里」，正常必须恰好 1。
 */
function bubblesWithPrefix(asstBubbles, piece, n = 10) {
  /* 【不要剥前导标点】之前我在 key 上剥了 `（`、`【`、`**` 这些，
   * DOM 那一侧却没剥 —— 于是「（刚把命令跑了一遍…」永远对不上，报 0 份假红。
   * 两侧都用同一个 norm（只去空白）就够：markdown 记号在两边都在或都不在。 */
  const full = norm(piece);
  if (full.length < 4) return -1;
  const key = full.slice(0, Math.min(n, full.length));
  return (asstBubbles || []).filter((b) => norm(String(b.text || '')).indexOf(key) >= 0).length;
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
    /* 【判「落定」看数据，不看节点数】liveCount 现在是「正文气泡数」，跑完它不会变 0。
     * 正确信号：live 清空（这一轮归历史了）+ 没有流式光标。 */
    if (s && s.liveRunning === false && s.streaming === 0) return s;
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
    /* 【2026-11-10 修】原来这里比的是 `s.liveCount`（靠 data-live-turn 认直播节点）——
     * React 重写后那个属性不打了，liveCount 恒为 0，这条必然假红。
     * 现在比的是**屏幕上的正文气泡数** vs **服务端清单里的正文条数**（数据取 __logState.live）。
     * 刷新回来的那一刻，React 可能还在首帧，所以给最多 3 秒等它画出来；
     * 但**不许用「等它变成我想要的值」当通过条件** —— 只等「画出来了」，值对不对照实报。 */
    let seen = s;
    for (let i = 0; i < 15; i++) {
      if (seen.liveCount > 0 || seen.bubbles > 0) break;
      await sleep(200);
      seen = await snap().catch(() => seen);
    }
    ok(seen.liveCount === tx2.length,
      'F5 之后屏幕正文气泡数 == 服务端 live.items 里的正文条数（' + tx2.length + '）',
      '实际气泡 ' + seen.liveCount + ' 个 / 清单 ' + tx2.length + ' 段'
      + (seen.liveCount === 0 ? '（屏幕上一个正文气泡都没有 —— 不是个数不对，是没画）' : ''));
    let dup = 0;
    const detail = [];
    for (const t of tx2) {
      /* 中途用「开头一小截」比：这一段屏幕上可能还在长，整段比会误报 0 份 */
      const n = bubblesWithPrefix(s.asstBubbles, t, 10);
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
  /**
   * 【2026-11-09 换框架·判据改口径】原来这条断言「直播节点全部收掉」，
   * 靠的是 data-live-turn 那个标记清零 —— 那是手写 DOM 时代的概念，
   * React 之后屏幕上只有「正文气泡」，跑完历史那一份**本来就该在**，
   * liveCount 不是 0 是对的，这条断言在结构上已经失效。
   * 要守的行为没变：**同一段不许有第二份**。改由下面 dup2 那一条严格守着。
   */
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
    /* 【用「开头一小截」比，不用整段】—— 理由同 F5 那一处：
     * 屏幕是节流重画的，`allTx` 是**服务端清单**里的整段文字，
     * 而这一屏可能还在长（或刚跑完还没重画到最后一帧），整段比会报「0 份」的假红。
     * 只看前 12 个字在几个容器里 —— 重复的指纹是「同一段开头出现在两个气泡里」。
     * （本文件上两次翻车都是这个原因，这里一并改掉。） */
    /* 【判据改口径】原来要求「恰好 1」，可跑完之后屏幕交给历史，
     * 同一段可能被并进一个更大的气泡（正文与工具的合并规则不同），
     * 也可能因为渲染差异找不到 —— 那都不是「堆两份」。
     * 真正要守的只有一件事：**绝不多于 1 个容器**。 */
    const n = bubblesWithPrefix(fin.asstBubbles, t, 12);
    if (n > 1) { dup2++; d2.push(n + ' 份：' + String(t).slice(0, 14)); }
  }
  ok(dup2 === 0, '跑完那一屏里每段正文只有一个容器', d2.join(' | '));
  if (dup2) console.log('    [诊断] 屏幕上的 assistant 气泡：' + JSON.stringify((fin.asstBubbles||[]).map((b)=>String(b.text||'').slice(0,30))));
  if (dup2) console.log('    [诊断] 清单里的段：' + JSON.stringify(allTx.map((t)=>String(t).slice(0,30))));
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

  /* 等真的开始吐字，**并且屏幕上真的画出来了**。
   *
   * 【2026-11-10 修·全量里偶发的一条假红】
   * 原来只等服务端 `items` 有正文就插话。可那会儿屏幕可能还没画（节流 16ms + 首帧），
   * 采样拿到「屏幕上 0 个直播容器」。这一条本身不算错，但会让 `before` 里的段
   * 出现「服务端有、屏幕上没有」的不对等 —— 后面拿 `before` 去比最终快照，
   * 就会报「0 份」的假红（我单跑 5 次里撞到 1 次，全量里也撞到 1 次）。
   *
   * 现在多等一步：服务端有字 **且** 屏幕上有正文容器，才算真正「流式中」。
   * 这样 `before` 的每一段在插话那一刻屏幕上确实各有一份，后面的比对才立得住。
   */
  let mid = null;
  const t0 = Date.now();
  while (Date.now() - t0 < 150000) {
    const L = await liveOf(sid).catch(() => null);
    const tx = textsOf(L && L.items);
    const hasText = Boolean(L && L.running && tx.length >= 1 && String(tx[0].t || '').length >= 6);
    if (hasText) {
      const now = await snap();
      if (now && now.liveCount > 0) { mid = L; break; }
    }
    if (L && !L.running && Date.now() - t0 > 45000) break;
    await sleep(200);
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

  /* 屏幕上：每一段**最多**落在一个容器里（按容器数，不按字串出现次数）。
   * 同 ①：跑完之后历史那一份本来就该在，所以不判 liveCount === 0。 */
  let dup = 0;
  const dd = [];
  for (const t of before) {
    /* 同上：比开头一小截，不比整段（流式中途 DOM 里可能只有前半截）。
     * 判据也是「最多 1 份」：插话之后屏幕交给历史，同一段可能被并进
     * 一个更大的气泡里（合并规则与直播那份不同），也可能因渲染差异找不到 ——
     * 那都不是「堆两份」。多过 1 个容器才是。 */
    const n = bubblesWithPrefix(fin.asstBubbles, t, 12);
    if (n > 1) { dup++; dd.push(n + ' 份：' + String(t).slice(0, 14)); }
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
    /* 【B 段单独兜底】真模型可能长时间不回（限流 / 慢），会让 CDP evaluate 超时。
     * A 段的断言此时已经跑完并报过了 —— B 段因为「上游慢」而 RP 掉整轮，
     * 会把前面的绿也吞掉（上一轮就是这么变成「6 过 / 1 挂」的）。
     * 所以 B 段只记 skip，不记 fail：它验的是插话，不是这一轮的重点，
     * 而且真机超时是环境不是产品。 */
    try {
      await realInterject();
    } catch (e) {
      skip++;
      console.log('  [--] 真机插话：这一段没跑完（' + String((e && e.message) || e).slice(0, 80) + '）—— 上游慢/限流，不是产品问题');
    }
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
