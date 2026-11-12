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
    var LONG='\u8fd9\u662f\u4e00\u4e2a\u5f88\u957f\u5f88\u957f\u7684\u6587\u4ef6\u540d\u6d4b\u8bd5\u6587\u4ef6\u540d\u6d4b\u8bd5\u6587\u4ef6\u540d\u6d4b\u8bd5_2026-11-12.xlsx';
    function cards(){ var L=document.getElementById('log'); return L?[].slice.call(L.querySelectorAll('.fileRow,.fileCard')).map(function(e){var r=e.getBoundingClientRect();return {l:Math.round(r.left),r:Math.round(r.right),w:Math.round(r.width)};}):[]; }
    function bubble(){ var L=document.getElementById('log'); var b=L?L.querySelector('.msg .bubble'):null; if(!b) return null; var r=b.getBoundingClientRect(); return {l:Math.round(r.left),r:Math.round(r.right)}; }
    function sleep(ms){ return new Promise(function(r){ setTimeout(r, ms); }); }
    // 1) 先确认渲染通路活着：落一条历史，等到真有消息气泡画出来（页面刚起来时 React 还没挂载，这一步把环境抖动吃掉）
    var _warm=false;
    for (var i=0;i<40;i++){
      try{ s.setHistory(sid,[{role:'user',text:'warmup'}]); }catch(e){}
      await sleep(100);
      var _L=document.getElementById('log');
      if(_L && _L.querySelectorAll('.msg').length){ _warm=true; break; }
    }
    var res={};
    // 2) 直播推一条「文字 + 文件」，等卡片
    function push(){ s.setLive(sid,{running:true,startedAt:Date.now()-1000,items:[
      {k:'text',t:'\u53d1\u4f60\u3002'},
      {k:'file',kind:'file',name:LONG,size:123456,path:'D:/x/a.xlsx',key:'fk1'},
    ]}); }
    var _seen=0;
    for (var round=0; round<3; round++){
      push();
      for (var w=0; w<40; w++){
        var n=cards().length;
        if(n>_seen) _seen=n;
        if(n) break;
        await sleep(100);
      }
      if(_seen) break;
    }
    res.liveCards=_seen;

    var _bp=bubble(); res.card=_seen?cards()[0]:null; res.bubble=_bp; res.vw=window.innerWidth;
    s.setLive(sid,null);
    s.setHistory(sid,[
      {role:'user',text:'\u56de\u5386\u53f2\u4e5f\u8981\u6709\u5361'},
      {role:'assistant',text:'\u597d\u7684',out:[{k:'file',kind:'file',name:'b.xlsx',size:2048,path:'D:/x/b.xlsx',key:'fk2'}]},
    ]);
    await sleep(900);
    res.histCards=cards().length;
    s.setHistory(sid,[
      {role:'user',text:'\u7a7a\u6b63\u6587\u4e5f\u8981\u6709\u5361'},
      {role:'assistant',text:'',out:[{k:'file',kind:'file',name:'c.pdf',size:4096,path:'D:/x/c.pdf',key:'fk3'}]},
    ]);
    await sleep(900);
    res.emptyTextCards=cards().length;
    res.cards=cards();
    return res;
  })()`);

  ok('直播推文件 → 卡片当场渲染', out.liveCards >= 1, '卡数 ' + out.liveCards);
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
