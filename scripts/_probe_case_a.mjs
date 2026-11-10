#!/usr/bin/env node
/** 【临时探针】复现 check-log-react 案 a 落历史后两段消失的问题。用完即删。 */
import { startIsolated } from './_test-instance.mjs';
import { connect } from '../_t_cdp.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const iso = await startIsolated();
const cdp = await connect({ port: iso.cdpPort });
for (let i = 0; i < 100; i++) {
  try {
    const v = await cdp.eval('return { ready: !!document.getElementById("log"), sid: window.sessionId || "", react: !!window.__logRoot };');
    if (v && v.ready && v.sid && v.react) break;
  } catch (e) {}
  await sleep(300);
}
// 收集 console 错误
await cdp.eval('window.__errs = []; window.addEventListener("error", (e) => window.__errs.push(String(e.message))); return 1;');

const A = 'QA甲段我先说一句';
const B = 'QA乙段工具跑完了再说一句';
const events = [
  { type: 'text', text: A },
  { type: 'tool_start', id: 'lr1', name: 'run_command', args: '{"cmd":"echo hi"}' },
  { type: 'tool_end', id: 'lr1', ok: true, output: 'hi' },
  { type: 'text', text: B },
  { type: 'done' },
];
// 装 stub（与 check-log-react 相同的最小版）
await cdp.eval(`(function(){
  if (window.__lrOrigFetch) return 1;
  window.__lrOrigFetch = window.fetch.bind(window);
  window.__lr = { events: ${JSON.stringify(events)}, i: 0, turns: [
    { role: 'user', text: 'QA 主人一句' },
    { role: 'assistant', text: ${JSON.stringify(A + '\\n\\n' + B)} },
  ] };
  var jsonRes = function(o){ return new Response(JSON.stringify(o), { status: 200, headers: { 'content-type': 'application/json' } }); };
  window.fetch = function(u, opt){
    var url = (typeof u === 'string') ? u : ((u && u.url) || '');
    var qa = window.__lr || {};
    if (/\\/api\\/chat$/.test(url)) {
      var evs = qa.events || [], i = 0;
      var enc = new TextEncoder();
      var stream = new ReadableStream({
        async pull(c){
          if (i >= evs.length) { try { c.close(); } catch(e){} return; }
          var e = evs[i++];
          c.enqueue(enc.encode('data: ' + JSON.stringify(e) + '\\n\\n'));
          await new Promise(function(r){ setTimeout(r, 60); });
        }
      });
      return Promise.resolve(new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } }));
    }
    if (url.indexOf('/api/chat/live') >= 0) {
      var last = (qa.steps || []).length - 1;
      var k = Math.max(0, Math.min(Number(qa.i) || 0, last));
      var items = (qa.steps && qa.steps.length) ? qa.steps[k] : [];
      var stillRunning = (Number(qa.i) || 0) < last;
      return Promise.resolve(jsonRes({ sessionId: qa.sid, running: stillRunning, startedAt: qa.startedAt || Date.now(), events: [], nextSince: 0, items: items }));
    }
    if (url.indexOf('/api/sessions/select') >= 0) {
      return Promise.resolve(jsonRes({ session: qa.turns ? { id: qa.sid, turns: qa.turns } : null }));
    }
    return window.__lrOrigFetch(u, opt);
  };
  return 1;
})();`);
// steps 用服务端真函数算
const fs = await import('node:fs');
const path = await import('node:path');
const SRV = fs.readFileSync(path.join(iso.root || process.cwd(), 'src/server.mjs'), 'utf8');
function grabFn(src, name) {
  const i = src.indexOf('function ' + name + '(');
  const j = src.indexOf('{', i);
  let d = 0;
  for (let k = j; k < src.length; k++) { if (src[k] === '{') d++; else if (src[k] === '}') { d--; if (d === 0) return src.slice(i, k + 1); } }
}
const steps = [];
const bag = [];
// eslint-disable-next-line no-new-func
const srvFns = new Function(grabFn(SRV, 'appendLiveItem') + '\nreturn { appendLiveItem };')();
steps.push([]);
for (const e of events) { srvFns.appendLiveItem(bag, e); steps.push(JSON.parse(JSON.stringify(bag))); }
await cdp.eval('window.__lr.steps = ' + JSON.stringify(steps) + '; return 1;');

await cdp.eval('window.__trace = [];
  ['logSetHistory','logSetLive','renderTurns','renderLog'].forEach(function(n){
    var o = window[n];
    window[n] = function(){ window.__trace.push(n + ' ' + JSON.stringify(Array.from(arguments)).slice(0,180)); return o && o.apply(this, arguments); };
  });
  window.__lrTurnP = window.runTurn({ text: "QA 主人一句" }); return 1;');
await sleep(4000);
for (let i = 0; i < 80; i++) {
  const b = await cdp.eval('return !!window.busy;');
  if (!b) break;
  await sleep(200);
}
await sleep(1500);
const dump = await cdp.eval(`return {
  errs: window.__errs,
  busy: window.busy,
  logText: (document.getElementById('log')||{textContent:''}).textContent.slice(0, 400),
  state: (function(){ var s = window.__logState; return { sid: s.sid, turns: (s.turns||[]).length, live: s.live ? { running: s.live.running, n: (s.live.items||[]).length } : null }; })(),
  snap: (function(){ var st = window.__logStore; return 'no-dump'; })(),
};`);
console.log(JSON.stringify(dump, null, 2));
try { await cdp.eval('return window.__lrOrigFetch("/api/chat/live?sessionId=" + encodeURIComponent(window.sessionId)).then(function(r){return r.json()});').then(x => console.log('live api:', JSON.stringify(x).slice(0, 300))); } catch (e) { console.log('live probe err', e.message); }
try { if (cdp.close) cdp.close(); } catch (e) {}
try { await iso.stop(); } catch (e) {}
process.exit(0);
