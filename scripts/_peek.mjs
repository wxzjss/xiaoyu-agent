// 只看现场、不刷新：把页面里几个关键状态打出来。
// usage: node scripts/_peek.mjs <wsUrl> <exprFile>
import { readFileSync } from 'node:fs';

const [wsUrl, exprFile] = process.argv.slice(2);
const expr = readFileSync(exprFile, 'utf8');

const ws = new WebSocket(wsUrl);
let id = 0;
const pending = new Map();
const send = (method, params = {}) => {
  const msgId = ++id;
  ws.send(JSON.stringify({ id: msgId, method, params }));
  return new Promise((r) => pending.set(msgId, r));
};
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
});
ws.addEventListener('open', async () => {
  await send('Runtime.enable');
  const res = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (res.result?.exceptionDetails) {
    console.log('EXCEPTION ' + JSON.stringify(res.result.exceptionDetails.exception?.description ?? res.result.exceptionDetails));
  } else {
    console.log(JSON.stringify(res.result?.result?.value ?? res.result, null, 2));
  }
  process.exit(0);
});
ws.addEventListener('error', (e) => { console.error('WS ERROR', e.message || e); process.exit(1); });
