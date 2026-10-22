// Minimal CDP client: attach to a page, reload it, collect console errors, then evaluate an expression.
// usage: node scripts/_cdp.mjs <wsUrl> [expr]
const wsUrl = process.argv[2];
const expr = process.argv[3] || '1';

const ws = new WebSocket(wsUrl);
let id = 0;
const pending = new Map();
const logs = [];

function send(method, params = {}) {
  const msgId = ++id;
  ws.send(JSON.stringify({ id: msgId, method, params }));
  return new Promise((resolve) => pending.set(msgId, resolve));
}

ws.addEventListener('message', (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg);
    pending.delete(msg.id);
    return;
  }
  if (msg.method === 'Runtime.consoleAPICalled') {
    const text = (msg.params.args || []).map((a) => a.value ?? a.description ?? a.type).join(' ');
    logs.push(`[console.${msg.params.type}] ${text}`);
  }
  if (msg.method === 'Runtime.exceptionThrown') {
    const d = msg.params.exceptionDetails;
    logs.push(`[exception] ${d.text} ${d.exception?.description ?? ''} @${d.url}:${d.lineNumber}`);
  }
  if (msg.method === 'Log.entryAdded') {
    logs.push(`[log.${msg.params.entry.level}] ${msg.params.entry.text} ${msg.params.entry.url ?? ''}`);
  }
});

ws.addEventListener('open', async () => {
  await send('Runtime.enable');
  await send('Log.enable');
  await send('Page.enable');
  await send('Page.reload', { ignoreCache: true });
  await new Promise((r) => setTimeout(r, 4000));
  const res = await send('Runtime.evaluate', {
    expression: expr,
    returnByValue: true,
    awaitPromise: true,
  });
  console.log('--- logs ---');
  console.log(logs.length ? logs.join('\n') : '(no logs)');
  console.log('--- eval ---');
  if (res.result?.exceptionDetails) {
    console.log('EXCEPTION', JSON.stringify(res.result.exceptionDetails, null, 2));
  } else {
    console.log(JSON.stringify(res.result?.result?.value ?? res.result, null, 2));
  }
  ws.close();
  process.exit(0);
});

ws.addEventListener('error', (e) => {
  console.error('WS ERROR', e.message || e);
  process.exit(1);
});
