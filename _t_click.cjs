// CDP 真鼠标点击：node _t_click.cjs <x> <y>
const CDP_HOST = '127.0.0.1';
const CDP_PORT = 9222;
const targetId = process.env.CDP_ID;

function getWsUrl() {
  return new Promise((res, rej) => {
    http.get(`http://${CDP_HOST}:${CDP_PORT}/json`, r => {
      let d = '';
      r.on('data', c => d += c);
      r.on('end', () => {
        const a = JSON.parse(d);
        const t = a.find(x => x.id === targetId);
        t ? res(t.webSocketDebuggerUrl) : rej(new Error('no target'));
      });
    }).on('error', rej);
  });
}

let idSeq = 1;
function withTimeout(p, ms) {
  return Promise.race([p, new Promise((_, rj) => setTimeout(() => rj(new Error('timeout ' + ms)), ms))]);
}

async function main() {
  const x = parseFloat(process.argv[2]);
  const y = parseFloat(process.argv[3]);
  if (!targetId || isNaN(x) || isNaN(y)) { console.log('need CDP_ID + x y'); return; }
  const WebSocket = (await import('ws')).default;
  const url = await getWsUrl();
  const ws = new WebSocket(url);
  await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });

  function send(method, params) {
    const id = idSeq++;
    return new Promise((res, rej) => {
      const onMsg = m => {
        const d = JSON.parse(m);
        if (d.id === id) { ws.off('message', onMsg); d.error ? rej(new Error(JSON.stringify(d.error))) : res(d.result); }
      };
      ws.on('message', onMsg);
      ws.send(JSON.stringify({ id, method, params }));
    });
  }

  const mv1 = send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', clickCount: 0 });
  const down = send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
  const up = send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 });
  await withTimeout(mv1, 8000);
  await withTimeout(down, 8000);
  await new Promise(r => setTimeout(r, 80));
  await withTimeout(up, 8000);
  console.log('clicked at ' + x + ',' + y);
  ws.close();
}

const http = require('http');
main().catch(e => { console.error('ERR ' + e.message); process.exit(1); });
