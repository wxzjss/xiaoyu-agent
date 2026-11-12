/**
 * check-wcard-width.mjs — 子Agent（worker）进度卡片不许超出消息栏
 *
 * 【2026-11-12 接手「测试团队模式」会话的活】主人报：worker 干活进度卡片
 * 超出消息栏左右两侧。根因：「跟消息同宽」那把尺子（#log > details.tool /
 * toolhub / think / .teamBar）漏了聊天流里的 details.wcard —— 它是 #log 的
 * 直接子元素、宽度由内容撑，长名字一顶就横着捅出去（实测改前卡宽 1205px、
 * 右缘超出视口；修后 674px、右缘跟气泡齐平）。
 *
 * 真机验（隔离实例 + CDP）：造一张超长名字的 worker 卡，量三条——
 *   ① 卡宽不得超过气泡列宽 + 16（8px 对齐余量 ×2）；
 *   ② 卡右缘不得超出视口；
 *   ③ 源码里尺子必须含 #log > details.wcard。
 */
import { startIsolated } from './_test-instance.mjs';
import { readFileSync } from 'node:fs';

let pass = 0, fail = 0;
const ok = (m, c, d) => { if (c) { pass++; console.log('  [ok] ' + m + (d ? '  ' + d : '')); } else { fail++; console.log('  [!!] ' + m + (d ? '  ' + d : '')); } };

/* ── ③ 静态：尺子里必须有 wcard ── */
const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
ok('「跟消息同宽」的尺子里收了 #log > details.wcard',
  /#log > details\.wcard \{/.test(html) || /#log > details\.tool[\s\S]{0,120}#log > details\.wcard \{/.test(html));

/* ── ① ② 真机量 ── */
let iso = null, ws = null;
try {
  iso = await startIsolated({ appPort: 8931, cdpPort: 9341 });
  const list = await fetch('http://127.0.0.1:' + iso.cdpPort + '/json/list').then((r) => r.json());
  ws = new WebSocket((list.find((t) => t.type === 'page')).webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  let id = 0; const pend = new Map();
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } };
  const send = (m, p) => new Promise((res) => { const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
  const ev = async (x) => {
    const r = await send('Runtime.evaluate', { expression: x, awaitPromise: true, returnByValue: true });
    if (r?.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 200));
    return r?.result?.result?.value;
  };
  await send('Runtime.enable');
  for (let i = 0; i < 60; i++) { if (await ev('!!(window.__logStore&&window.sessionId)')) break; await new Promise((r) => setTimeout(r, 300)); }

  const out = await ev(`(async function(){
    var sid=window.sessionId,s=window.__logStore;
    var longName='统计鱼-'+'超长名字'.repeat(20);
    s.setHistory(sid,[]);
    s.setLive(sid,{running:true,startedAt:Date.now()-3000,items:[
      {k:'text',t:'派团队去干。'},
      {k:'worker',id:1,name:longName,status:'run',startedAt:Date.now()-3000,steps:[]},
    ]});
    await new Promise(function(r){setTimeout(r,900);});
    var card=document.querySelector('#log details.wcard');
    var bubble=document.querySelector('#log .msg .bubble');
    if(!card) return {err:'没渲染出 worker 卡'};
    function box(el){var r=el.getBoundingClientRect();return {l:Math.round(r.left),r:Math.round(r.right),w:Math.round(r.width)};}
    var c=box(card), b=bubble?box(bubble):null;
    return { 卡宽:c.w, 气泡宽:b?b.w:null, 右差: b?(c.r-b.r):null, 超视口: c.r>window.innerWidth };
  })()`);

  if (out && out.err) { ok('worker 卡渲染', false, out.err); }
  else {
    ok('卡宽不超气泡列 +16px', out.气泡宽 ? out.卡宽 <= out.气泡宽 + 16 : out.卡宽 <= 900,
      '卡 ' + out.卡宽 + ' / 气泡 ' + out.气泡宽);
    ok('卡右缘不超出视口', out.超视口 === false, '右差 ' + out.右差);
  }
} catch (e) {
  ok('真机探针跑通', false, String(e && e.message || e).slice(0, 120));
} finally {
  try { ws && ws.close(); } catch {}
  try { iso && await iso.stop(); } catch {}
}

console.log('\n── worker 卡宽度：' + pass + '/' + (pass + fail) + (fail ? ' 有失败' : ' 全过') + ' ──');
process.exit(fail ? 1 : 0);
