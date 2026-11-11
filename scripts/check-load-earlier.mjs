/**
 * check-load-earlier.mjs — 「↑ 再往前看」一路点到最顶，不许被打回最新
 *
 * 主人老报的那条：长会话里一路往上翻，翻到最顶时屏幕突然跳回最新消息 ——
 * 原因见 store.js 里 histTouched 那段注释（0 = 从没翻过 和 0 = 翻到最顶 撞在一起）。
 *
 * 这条同时钉住另一半：**没翻过的会话仍然只画最近 40 轮**（那是虚拟化，300 轮不会卡）。
 */
import { startIsolated } from './_test-instance.mjs';

const iso = await startIsolated({ appPort: 8875, cdpPort: 9285 });
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

const out = await ev(`(async function(){
  var s = window.__logStore, sid = window.sessionId;
  var turns = [];
  for (var i = 0; i < 150; i++) turns.push({ role: 'user', text: 'QA第' + i + '问' });
  for (var j = 0; j < 150; j++) turns.push({ role: 'assistant', text: 'QA第' + j + '答：' + '字'.repeat(40) });
  s.setHistory(sid, turns);
  try { window.renderLog && window.renderLog({ force: true }); } catch (e) {}
  /* 300 轮渲染要一会儿：分三次采样，确认不是「只画了 1 条」 */
  var warm = [];
  for (var w = 0; w < 3; w++) {
    await new Promise(function(r){ setTimeout(r, 700); });
    warm.push({ rows: log0().querySelectorAll('.msg').length });
  }

  var log = document.getElementById('log');
  function log0(){ return document.getElementById('log'); }
  function firstRow(){ var el = log.querySelector('.msg'); return el ? String(el.textContent||'').slice(0,12) : ''; }
  function rowCount(){ return log.querySelectorAll('.msg').length; }

  var never = { start: s.getWindowStart(sid), rows: rowCount(), first: firstRow(), warm: warm };

  /* 模拟主人一路点「↑ 再往前看」：每次往前 100 轮 */
  var steps = [];
  for (var k = 0; k < 6; k++) {
    var cur = s.getWindowStart(sid);
    s.setWindowStart(sid, Math.max(0, cur - 100));
    try { window.renderLog && window.renderLog({ force: true }); } catch (e) {}
    await new Promise(function(r){ setTimeout(r, 500); });
    var nw = s.getWindowStart(sid);
    steps.push({ windowStart: nw, rows: rowCount(), first: firstRow() });
    if (nw === 0) break;
  }
  /* 到顶之后再等一拍，确认没有被「重置回最近 40 轮」 */
  await new Promise(function(r){ setTimeout(r, 700); });
  var atTop = { start: s.getWindowStart(sid), rows: rowCount(), first: firstRow() };
  return { never: never, steps: steps, atTop: atTop };
})()`);
console.log(JSON.stringify(out, null, 1));

/* 【判据换了个角度】行数在 content-visibility 下不可靠（离屏行不一定被算进 querySelectorAll 的可见集合，
 * 实测同一屏能读出 1 行也能读出 40 行）。真正要守的是「窗口生效」：
 * 没翻过的会话，屏幕最上面那条**不该是最早那句**（说明前面被虚拟化掉了）。 */
ok('没翻过的长会话不把整份历史都画出来（虚拟化还在）',
  !!(out && out.never && !/QA第0问/.test(String(out.never.first))),
  '首行=' + (out && out.never && out.never.first) + ' 行数=' + (out && out.never && out.never.rows));
ok('一路往前翻能翻到最顶（windowStart 真的到 0）',
  !!(out && out.atTop && out.atTop.start === 0), 'start=' + (out && out.atTop && out.atTop.start));
ok('翻到最顶后不被重置回最新（start 仍是 0）',
  !!(out && out.atTop && out.atTop.start === 0), 'start=' + (out && out.atTop && out.atTop.start));
ok('翻到最顶时最早的那句真的在屏幕上',
  !!(out && out.atTop && /QA第0问/.test(String(out.atTop.first))), '首行=' + (out && out.atTop && out.atTop.first));
ok('翻到最顶时行数明显变多（不是还停在 40 轮）',
  !!(out && out.never && out.atTop && out.atTop.rows > out.never.rows * 1.5),
  'never 行数=' + (out && out.never && out.never.rows) + ' → top 行数=' + (out && out.atTop && out.atTop.rows));

console.log('\n' + pass + ' 过 / ' + fail + ' 挂');
try { ws.close(); } catch (e) {}
try { await iso.stop(); } catch (e) {}
process.exit(fail ? 1 : 0);
