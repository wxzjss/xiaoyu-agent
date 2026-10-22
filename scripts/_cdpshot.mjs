// Capture the page via CDP (true renderer pixels).
// usage: node scripts/_cdpshot.mjs <wsUrl> <outPath>
import { writeFileSync } from 'node:fs';

const [wsUrl, out] = process.argv.slice(2);
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
  await send('Page.enable');
  const res = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  const data = res.result?.data;
  if (!data) { console.error('no data', JSON.stringify(res).slice(0, 300)); process.exit(1); }
  writeFileSync(out, Buffer.from(data, 'base64'));
  console.log('saved ' + out);
  process.exit(0);
});
ws.addEventListener('error', (e) => { console.error('WS ERROR', e.message || e); process.exit(1); });
