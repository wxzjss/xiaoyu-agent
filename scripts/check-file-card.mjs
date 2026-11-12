/**
 * check-file-card.mjs — 发文件的三态站岗：直播有卡、落历史有卡、空正文也有卡
 *
 * 【2026-11-12 主人问：发文件会不会超出消息栏左右两侧？发出来后会不会前端不显示？】
 * 真机实测（隔离实例）：三种状态卡片都在——
 *   直播推 {k:'file'} → 卡渲染；setHistory(turn.out) → 卡还在；
 *   空正文只有 out 的轮（stashFile 占位形态）→ 卡照样在。
 * 宽度：.fileCard max-width 300px / .fileRow 320px，右缘远在消息栏内（实测右缘差 374px），
 * 左缘 -8px 是工具卡同款的对齐惯例（边框比气泡左缘凸 8px）。不会溢出、不会消失。
 * 这里钉住这三态 + 宽度，防止以后重写时回退。
 */
import { startIsolated } from './_test-instance.mjs';

let pass = 0, fail = 0;
const ok = (m, c, d) => { if (c) { pass++; console.log('  [ok] ' + m + (d ? '  ' + d : '')); } else { fail++; console.log('  [!!] ' + m + (d ? '  ' + d : '')); } };

let iso = null, ws = null;
try {
  iso = await startIsolated({ appPort: 8963, cdpPort: 9363 });
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
    var sid=window.sessionId,s=window.__logStore,log=document.getElementById('log');
    function cards(){ var L2=document.getElementById('log')||log; return [].slice.call(L2.querySelectorAll('.fileRow,.fileCard')).map(function(e){var r=e.getBoundingClientRect();return {l:Math.round(r.left),r:Math.round(r.right),w:Math.round(r.width)};}); }
    function bubble(){ var L3=document.getElementById('log')||log; var b=L3.querySelector('.msg .bubble'); if(!b) return null; var r=b.getBoundingClientRect(); return {l:Math.round(r.left),r:Math.round(r.right)}; }
    var LONG='季度报告-这是一个相当长的文件名用来测溢出表现.xlsx';
    var res={};
    s.setHistory(sid,[]);
    s.setLive(sid,{running:true,startedAt:Date.now()-1000,items:[
      {k:'text',t:'发你。'},
      {k:'file',kind:'file',name:LONG,size:123456,path:'D:/x/a.xlsx',key:'fk1'},
    ]});
    var _seen=0,_trace=[]; for (var _w = 0; _w < 80; _w++) { var Lw=document.getElementById('log'); var _n=Lw?Lw.querySelectorAll('.fileRow,.fileCard').length:0; _trace.push(_n); if(_n>_seen) _seen=_n; if(_n) break; await new Promise(function (r) { setTimeout(r, 100); }); }
    res.trace=_trace.join(''); try { var _lw=document.getElementById('log'); res.diag='html='+(_lw?_lw.innerHTML.slice(0,500):'null')+' ||keys='+Object.keys(s||{}).join(','); } catch (e) { res.diag='diag-err:'+e.message; }
    res.domNow=(document.getElementById('log')||{}).innerHTML?document.getElementById('log').innerHTML.length:0;
    res.liveCards=Math.max(_seen, cards().length);
    s.setLive(sid,null);
    s.setHistory(sid,[
      {role:'user',text:'发我报告'},
      {role:'assistant',text:'文件在这。',out:[{kind:'file',name:LONG,size:123456,path:'D:/x/a.xlsx',key:'fk1'}]},
    ]);
    await new Promise(function(r){setTimeout(r,800);});
    var b=bubble(),cs=cards();
    res.histCards=cs.length; res.card=cs[0]||null; res.bubble=b;
    s.setHistory(sid,[
      {role:'user',text:'再发一个'},
      {role:'assistant',text:'',out:[{kind:'file',name:'x.zip',size:9,path:'D:/x/b.zip',key:'fk2'}]},
    ]);
    await new Promise(function(r){setTimeout(r,800);});
    res.emptyTextCards=cards().length; res.vw=window.innerWidth;
    return res;
  })()`);

  ok('直播推文件 → 卡片当场渲染', out.liveCards >= 1, '卡数 ' + out.liveCards + ' trace=' + out.trace + ' domLen=' + out.domNow);
  ok('落历史（turn.out）→ 卡片还在（不消失）', out.histCards >= 1, '卡数 ' + out.histCards);
  ok('空正文只有文件的轮 → 卡片照常显示', out.emptyTextCards >= 1, '卡数 ' + out.emptyTextCards);
  if (out.card && out.bubble) {
    ok('卡片不超出消息栏（右缘不越过气泡右缘 + 容差）', out.card.r <= out.bubble.r + 8,
      '卡右 ' + out.card.r + ' / 气泡右 ' + out.bubble.r);
    ok('卡片不超出视口', out.card.r <= out.vw);
    ok('卡片宽度守得住（≤ 340px）', out.card.w <= 340, '宽 ' + out.card.w);
    ok('左缘跟工具卡同款对齐（不凸出气泡左缘 12px 以上）', out.card.l >= out.bubble.l - 12,
      '差 ' + (out.card.l - out.bubble.l) + 'px');
  }
} catch (e) {
  ok('真机探针跑通', false, String(e && e.message || e).slice(0, 120));
} finally {
  try { ws && ws.close(); } catch {}
  try { iso && await iso.stop(); } catch {}
}

console.log('\n── 文件卡三态：' + pass + '/' + (pass + fail) + (fail ? ' 有失败' : ' 全过') + ' ──');
process.exit(fail ? 1 : 0);
