/**
 * check-steer-history-dom.mjs — 「插话落进历史之后，DOM 里是不是真的劈在她那段话中间」
 *
 * 为什么需要这一条：`check-steer-position.mjs` 验的是 items 层（buildMerged 的输出顺序），
 * 但主人看到的是 DOM。中间还隔着 LogView 的分行、RowBoundary、气泡渲染 ——
 * 任何一层把插入的那颗丢掉/合并，items 层再绿也白搭。
 *
 * 数据用服务端的真实形状（publicSession 给插话消息带 steer + steerAt，
 * see server.mjs 的 `_atChars`），所以这条验的就是「F5 之后从历史重画」那条路。
 */
import { startIsolated } from './_test-instance.mjs';

const PORT = { appPort: 8871, cdpPort: 9281 };

const iso = await startIsolated(PORT);
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
  if (r && r.result && r.result.exceptionDetails) return { __err: JSON.stringify(r.result.exceptionDetails).slice(0, 300) };
  return r && r.result && r.result.result ? r.result.result.value : undefined;
};
await send('Runtime.enable');
for (let i = 0; i < 60; i++) { if (await ev('!!(window.__logStore && window.sessionId)')) break; await new Promise((r) => setTimeout(r, 300)); }

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log('  OK   ' + n + (x ? '  ' + x : '')); } else { fail++; console.log('  FAIL ' + n + (x ? '  ' + x : '')); } };

/* 120 字正文，插话发生在第 40 字 */
const FRONT = 'A'.repeat(40);
const BACK = 'B'.repeat(80);
const STEER = '插一句：先别改那个文件';

const out = await ev(`(async function(){
  var sid = window.sessionId, s = window.__logStore;
  s.setHistory(sid, []);
  s.setLive(sid, null);
  await new Promise(r=>setTimeout(r, 200));
  /* 服务端 publicSession 的真实形状：assistant 正文 + 一条带 steer/steerAt 的 user */
  s.setHistory(sid, [
    { role: 'user', text: '把那个错别字修一下' },
    { role: 'assistant', text: '${'A'.repeat(40)}' + '${'B'.repeat(80)}', rewindId: 1 },
    { role: 'user', text: '${STEER}', steer: true, steerAt: 40 },
  ]);
  await new Promise(r=>setTimeout(r, 600));
  function read(){
    var log = document.getElementById('log');
    var rows = [].slice.call(log.querySelectorAll('.msg, .sysnote, details.toolhub')).map(function(e){
      var mine = e.classList.contains('user');
      var txt = String(e.textContent || '');
      return { mine: mine, txt: txt, isNote: /插话/.test(txt) && mine };
    });
    return rows;
  }
  var rows = read();
  var mineIdx = [], asst = [];
  rows.forEach(function(r,i){ if (r.mine) mineIdx.push(i); else asst.push(i); });
  var steerRow = rows.findIndex(function(r){ return r.mine && r.txt.indexOf('插一句') >= 0; });
  /* 她那段正文被劈成的两截：A 段 / B 段 各自成一顆气泡（或同一顆里连着，两种都算，只要顺序对） */
  var joined = rows.map(function(r){ return (r.mine ? 'U' : 'A') + ':' + r.txt.replace(/\\s+/g,'').slice(0,12); });
  var aCount = (function(){ var n=0; rows.forEach(function(r){ if(!r.mine && r.txt.indexOf('AAAA')>=0) n++; }); return n; })();
  var bodyInDom = (function(){ var t=''; rows.forEach(function(r){ if(!r.mine) t += r.txt.replace(/\\s+/g,''); }); return t; })();
  return {
    rows: joined,
    steerRow: steerRow,
    firstAsst: asst.length ? asst[0] : -1,
    lastAsst: asst.length ? asst[asst.length-1] : -1,
    hasFront: bodyInDom.indexOf('AAAAAAAAAA') >= 0,
    hasBack: bodyInDom.indexOf('BBBBBBBBBB') >= 0,
    aLen: (bodyInDom.match(/A/g)||[]).length,
    bLen: (bodyInDom.match(/B/g)||[]).length,
    aCount: aCount,
    steerTag: /插话/.test(String(rows[steerRow] ? rows[steerRow].txt : '')),
  };
})()`);
console.log(JSON.stringify(out, null, 1));

ok('历史里插话那颗气泡画出来了', !!(out && out.steerRow >= 0), 'index=' + (out && out.steerRow));
ok('她那段正文前半（40 个 A）还在', !!(out && out.hasFront), 'A 计数=' + (out && out.aLen));
ok('她那段正文后半（80 个 B）还在', !!(out && out.hasBack), 'B 计数=' + (out && out.bLen));
ok('正文没丢没重复：A=40 / B=80', !!(out && out.aLen === 40 && out.bLen === 80), (out && out.aLen) + '/' + (out && out.bLen));
ok('插话排在她第一段之后（不是整段的最前面）', !!(out && out.steerRow > out.firstAsst),
  '插话@' + (out && out.steerRow) + ' 第一段@' + (out && out.firstAsst));
ok('插话夹在她那段正文中间（后面还有她说的话）', !!(out && out.steerRow < out.lastAsst),
  '插话@' + (out && out.steerRow) + ' 最后一段@' + (out && out.lastAsst));
ok('插话气泡带「插话」小标', !!(out && out.steerTag));

/* 再渲一次（模拟切走再切回 / F5 后从历史重画）：结果必须一模一样。
 * 注意要重新喂**同一份 turns 数据**，不能拿 getSnapshot().turns（那是前端算过的快照）。 */
const ROWS_EXPR = "var log=document.getElementById('log');"
  + "return { rows: [].slice.call(log.querySelectorAll('.msg')).map(function(e){"
  + "  return (e.classList.contains('user')?'U':'A') + ':' + String(e.textContent||'').replace(/[ \\n\\t]+/g,'').slice(0,12);"
  + "}) };";
const again = await ev('(async function(){'
  + " var sid = window.sessionId, s = window.__logStore;"
  + ' s.setHistory(sid, []);'
  + ' await new Promise(function(r){ setTimeout(r, 200); });'
  + " s.setHistory(sid, [{ role: 'user', text: '把那个错别字修一下' },"
  + "   { role: 'assistant', text: 'A'.repeat(40) + 'B'.repeat(80), rewindId: 1 },"
  + "   { role: 'user', text: '插一句：先别改那个文件', steer: true, steerAt: 40 }]);"
  + ' await new Promise(function(r){ setTimeout(r, 500); });'
  + ROWS_EXPR
  + '})()');
ok('重画（切走再切回）后顺序一致', !!(again && JSON.stringify(again.rows) === JSON.stringify(out.rows)),
  JSON.stringify(again && again.rows) + ' vs ' + JSON.stringify(out.rows));


console.log('\n' + pass + ' 过 / ' + fail + ' 挂');
try { ws.close(); } catch (e) {}
try { await iso.stop(); } catch (e) {}
process.exit(fail ? 1 : 0);
