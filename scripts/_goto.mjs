// 把某个已存在的 CDP 页面导航到指定 URL，等页面稳定后打印基本现场。
// usage: node scripts/_goto.mjs <wsUrl> <url> [waitMs]
const [wsUrl, target, waitMsRaw] = process.argv.slice(2);
const waitMs = Number(waitMsRaw || 6000);

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
  await send('Page.navigate', { url: target });
  await new Promise((r) => setTimeout(r, waitMs));
  const res = await send('Runtime.evaluate', {
    expression: '({url: location.href, title: document.title, vw: innerWidth, vh: innerHeight, dpr: devicePixelRatio})',
    returnByValue: true,
  });
  console.log(JSON.stringify(res.result?.result?.value ?? res, null, 2));
  process.exit(0);
});
ws.addEventListener('error', (e) => { console.error('WS ERROR', e.message || e); process.exit(1); });
