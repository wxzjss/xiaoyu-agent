/**
 * check-shrink-refollow.mjs — 「长屏 → 短屏 → 再来内容」还要贴底，但**人在翻历史时不许动他**
 *
 * 主人报过的那一串「最新一条看不见 / 得手动滚一下才回来」里，最难的一条是这个：
 *   · 长会话滚在中间 → 切到一个内容比视口还短的会话（浏览器把 scrollTop 夹到 0）
 *     → 再发一句让内容长过视口 → 屏幕停在顶部（实测收尾后离底 87~119px）。
 * 根因是「贴底」的账被内容长高/收缩 clamp 污染，且我们自己写 scrollTop 的那一发
 * 被误判成「他往上滚了」。
 *
 * 这条检查同时钉**反向**：人真的往上翻的时候，新内容一根手指都不许动 ——
 * 防止有人为了修上面那条，把「跟随」变成「永远拽到底」。
 */
import { startIsolated } from './_test-instance.mjs';

const iso = await startIsolated({ appPort: 8873, cdpPort: 9283 });
const list = await fetch('http://127.0.0.1:' + iso.cdpPort + '/json/list').then((r) => r.json());
const page = list.find((t) => t.type === 'page' && /index\.html|\/$/.test(t.url || '')) || list.find((t) => t.type === 'page');
if (!page) { console.log('没有可调试的页面'); process.exit(1); }
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
let id = 0; const pend = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } };
const send = (method, params) => new Promise((res) => { const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r && r.result && r.result.exceptionDetails) return { __err: JSON.stringify(r.result.exceptionDetails).slice(0, 400) };
  return r && r.result && r.result.result ? r.result.result.value : undefined;
};
await send('Runtime.enable');
for (let i = 0; i < 60; i++) { if (await ev('!!(window.__logStore && window.sessionId)')) break; await new Promise((r) => setTimeout(r, 300)); }

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log('  OK   ' + n + (x ? '  ' + x : '')); } else { fail++; console.log('  FAIL ' + n + (x ? '  ' + x : '')); } };

/* ── 一：长屏 → 短屏 → 再长 ─────────────────────────────────── */
const A = await ev(`(async function(){
  var s = window.__logStore, log = document.getElementById('log');
  function dist(){ return log.scrollHeight - log.scrollTop - log.clientHeight; }
  function longTurns(n, tag){
    var t = [];
    for (var i = 0; i < n; i++) t.push({ role: 'user', text: tag + '问' + i });
    for (var j = 0; j < n; j++) t.push({ role: 'assistant', text: tag + '答' + j + '：' + '字'.repeat(80) });
    return t;
  }
  /* 1) 长会话，滚到中间 */
  window.sessionId = 'qaShrinkA';
  s.setHistory('qaShrinkA', longTurns(30, 'QA长'));
  await new Promise(function(r){ setTimeout(r, 600); });
  log.scrollTop = Math.floor((log.scrollHeight - log.clientHeight) / 2);
  log.dispatchEvent(new Event('scroll'));
  await new Promise(function(r){ setTimeout(r, 300); });
  var mid = { st: log.scrollTop, dist: dist() };
  /* 2) 切到一个「内容比视口还短」的会话（浏览器会把 scrollTop 夹到 0）*/
  window.sessionId = 'qaShrinkB';
  s.setHistory('qaShrinkB', [{ role: 'user', text: 'QA短问' }, { role: 'assistant', text: 'QA短答' }]);
  await new Promise(function(r){ setTimeout(r, 600); });
  var shortState = { st: log.scrollTop, dist: dist(), sh: log.scrollHeight, ch: log.clientHeight };
  /* 3) 这个会话里继续来内容，长过视口（模拟她接着说）*/
  var more = [{ role: 'user', text: 'QA短问' }, { role: 'assistant', text: 'QA短答' }];
  for (var k = 0; k < 8; k++) more.push({ role: 'assistant', text: '接着说第' + k + '段：' + '字'.repeat(80) });
  s.setHistory('qaShrinkB', more);
  await new Promise(function(r){ setTimeout(r, 800); });
  return { mid: mid, shortState: shortState, after: { st: log.scrollTop, dist: dist(), sh: log.scrollHeight, ch: log.clientHeight } };
})()`);
console.log(JSON.stringify(A));
ok('① 长屏能滚到中间（前提成立）', !!(A && A.mid && A.mid.dist > 100), 'dist=' + (A && A.mid && A.mid.dist));
ok('② 切短屏后内容确实比视口矮', !!(A && A.shortState && A.shortState.sh <= A.shortState.ch + 2),
  (A && A.shortState && (A.shortState.sh + '/' + A.shortState.ch)));
ok('③ 短屏再来内容 → 自动回到底部（以前停在顶部）', !!(A && A.after && A.after.dist <= 8),
  '离底 ' + (A && A.after && A.after.dist) + 'px');

/* ── 二（反向）：人在翻历史，新内容一根手指都不许动 ─────────── */
const B = await ev(`(async function(){
  var s = window.__logStore, log = document.getElementById('log');
  function dist(){ return log.scrollHeight - log.scrollTop - log.clientHeight; }
  function longTurns(n){
    var t = [];
    for (var i = 0; i < n; i++) t.push({ role: 'user', text: 'QA二问' + i });
    for (var j = 0; j < n; j++) t.push({ role: 'assistant', text: 'QA二答' + j + '：' + '字'.repeat(80) });
    return t;
  }
  window.sessionId = 'qaShrinkC';
  var base = longTurns(30);
  s.setHistory('qaShrinkC', base);
  await new Promise(function(r){ setTimeout(r, 600); });
  /* 人往上翻：先派发 wheel（真实意图），再改 scrollTop */
  log.dispatchEvent(new WheelEvent('wheel', { deltaY: -120, bubbles: true }));
  log.scrollTop = 200;
  log.dispatchEvent(new Event('scroll'));
  await new Promise(function(r){ setTimeout(r, 300); });
  var before = { st: log.scrollTop, dist: dist() };
  /* 同屏来新内容 */
  var more = base.concat([{ role: 'assistant', text: 'QA新来一段：' + '字'.repeat(200) }]);
  s.setHistory('qaShrinkC', more);
  await new Promise(function(r){ setTimeout(r, 800); });
  return { before: before, after: { st: log.scrollTop, dist: dist() } };
})()`);
console.log(JSON.stringify(B));
ok('④ 人往上翻之后，新内容不抢他的位置（st 没被拽到底）',
  !!(B && B.after && Math.abs(B.after.st - B.before.st) <= 8),
  '翻到 st=' + (B && B.before && B.before.st) + ' → 新内容后 st=' + (B && B.after && B.after.st));

console.log('\n' + pass + ' 过 / ' + fail + ' 挂');
ws.close();
try { await iso.stop(); } catch {}
process.exit(fail ? 1 : 0);
