// CDP 全功能小工具：连 9222 调试口，执行 JS / 截图 / 读页面状态
// 用法：node _cdpx.cjs eval "<js>"   | node _cdpx.cjs shot <out.png> | node _cdpx.cjs status
const http = require('http');
const fs = require('fs');

function getJSON(url) {
  return new Promise((res, rej) => {
    http.get(url, r => { let d = ''; r.on('data', c => d += c); r.on('end', () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } }); }).on('error', rej);
  });
}

let WS;
function loadWS() { try { WS = require('ws'); return true; } catch (e) { return false; } }

// Node >=21 自带 WebSocket 全局；否则试 ws 包
async function connect(wsUrl) {
  if (typeof WebSocket !== 'undefined') return new WebSocket(wsUrl);
  if (loadWS()) return new WS(wsUrl);
  throw new Error('no WebSocket available');
}

let idc = 0;
let pending = new Map();
function send(ws, method, params) {
  const id = ++idc;
  return new Promise((res, rej) => {
    pending.set(id, { res, rej });
    ws.send(JSON.stringify({ id, method, params }));
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); rej(new Error('timeout ' + method)); } }, 15000);
  });
}

async function main() {
  const [, , cmd, ...args] = process.argv;
  const targets = await getJSON('http://127.0.0.1:9222/json');
  // 找 DeepSeek 登录页，找不到就第一个 page
  let t = targets.find(x => x.type === 'page' && /deepseek/i.test(x.url)) || targets.find(x => x.type === 'page');
  if (!t) { console.log('NO_PAGE'); return; }
  const ws = await connect(t.webSocketDebuggerUrl);
  ws.on('message', m => {
    const d = JSON.parse(m);
    if (d.id && pending.has(d.id)) { const p = pending.get(d.id); pending.delete(d.id); d.error ? p.rej(new Error(JSON.stringify(d.error))) : p.res(d.result); }
  });
  await new Promise(r => ws.on('open', r));

  if (cmd === 'eval') {
    const expr = args[0];
    const r = await send(ws, 'Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    console.log(JSON.stringify(r.result && 'value' in r.result ? r.result.value : r.result, null, 1));
  } else if (cmd === 'shot') {
    const r = await send(ws, 'Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(args[0], Buffer.from(r.data, 'base64'));
    console.log('SAVED ' + args[0] + ' url=' + t.url);
  } else if (cmd === 'status') {
    const r = await send(ws, 'Runtime.evaluate', { expression: `JSON.stringify({url:location.href,title:document.title,text:document.body.innerText.slice(0,3000)})`, returnByValue: true });
    console.log(r.result.value);
  } else {
    console.log('usage: eval|shot|status');
  }
  ws.close();
  process.exit(0);
}
main().catch(e => { console.error('ERR ' + e.message); process.exit(1); });
