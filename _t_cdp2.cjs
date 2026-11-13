// CDP 工具 v3：CDP_ID 环境变量指定 target；check/eval/shot/frames
// node _t_cdp2.cjs check   （CDP_ID=9FFF... 指定目标页）
const http = require('http');
const net = require('net');
const crypto = require('crypto');
const fs = require('fs');

function getJson(url) {
  return new Promise((res, rej) => {
    const rq = http.get(url, r => { let d = ''; r.on('data', c => d += c); r.on('end', () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } }); });
    rq.on('error', rej);
    rq.setTimeout(5000, () => { rq.destroy(); rej(new Error('http timeout')); });
  });
}

function encodeFrame(str) {
  const payload = Buffer.from(str, 'utf8');
  const len = payload.length;
  const mask = crypto.randomBytes(4);
  let header;
  if (len < 126) header = Buffer.from([0x81, 0x80 | len]);
  else if (len < 65536) header = Buffer.from([0x81, 0x80 | 126, len >> 8, len & 0xff]);
  else { header = Buffer.alloc(10); header[0] = 0x81; header[1] = 0x80 | 127; header.writeBigUInt64BE(BigInt(len), 2); }
  const masked = Buffer.alloc(len);
  for (let i = 0; i < len; i++) masked[i] = payload[i] ^ mask[i % 4];
  return Buffer.concat([header, mask, masked]);
}

function decodeFrame(buf) {
  if (buf.length < 2) return null;
  let len = buf[1] & 0x7f, off = 2;
  if (len === 126) { if (buf.length < 4) return null; len = buf.readUInt16BE(2); off = 4; }
  else if (len === 127) { if (buf.length < 10) return null; len = Number(buf.readBigUInt64BE(2)); off = 10; }
  if (buf.length < off + len) return null;
  return { payload: buf.slice(off, off + len), total: off + len };
}

function wsCall(wsUrl, msg, timeoutMs) {
  return new Promise((res, rej) => {
    const u = new URL(wsUrl);
    const key = crypto.randomBytes(16).toString('base64');
    const sock = net.connect(Number(u.port), u.hostname);
    let buf = Buffer.alloc(0), handshaken = false, done = false;
    const timer = setTimeout(() => { if (!done) { done = true; sock.destroy(); rej(new Error('ws timeout')); } }, timeoutMs || 8000);
    sock.on('connect', () => {
      sock.write(`GET ${u.pathname} HTTP/1.1\r\nHost: ${u.host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`);
    });
    sock.on('data', d => {
      buf = Buffer.concat([buf, d]);
      if (!handshaken) {
        const i = buf.indexOf('\r\n\r\n');
        if (i < 0) return;
        buf = buf.slice(i + 4); handshaken = true;
        sock.write(encodeFrame(JSON.stringify(msg)));
      }
      let consumed = 0;
      while (true) {
        const r = decodeFrame(buf.slice(consumed));
        if (!r) break;
        consumed += r.total;
        try {
          const m = JSON.parse(r.payload.toString('utf8'));
          if (m.id === msg.id) { done = true; clearTimeout(timer); sock.destroy(); res(m); return; }
        } catch (e) {}
      }
      if (consumed > 0) buf = buf.slice(consumed);
    });
    sock.on('error', e => { if (!done) { done = true; clearTimeout(timer); rej(e); } });
  });
}

let idSeq = 1;

async function pickTargets() {
  const list = await getJson('http://127.0.0.1:9222/json');
  const id = process.env.CDP_ID;
  if (id) {
    const t = list.find(x => x.id === id);
    if (!t) throw new Error('target ' + id + ' not found');
    return [t];
  }
  return list.filter(t => t.type === 'page');
}

async function send(method, params) {
  const targets = await pickTargets();
  let lastErr = null;
  for (const t of targets) {
    try {
      const r = await wsCall(t.webSocketDebuggerUrl, { id: idSeq++, method, params }, 8000);
      if (r && !r.error) return r;
      lastErr = new Error('target error: ' + JSON.stringify(r.error || {}));
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error('no responsive page target');
}

function printValue(r) {
  const v = r.result && r.result.result ? r.result.result : r;
  console.log(typeof v.value === 'string' ? v.value : JSON.stringify(v, null, 1));
}

async function main() {
  const cmd = process.argv[2] || 'check';
  if (cmd === 'eval') {
    printValue(await send('Runtime.evaluate', { expression: process.argv[3], returnByValue: true, awaitPromise: true }));
  } else if (cmd === 'shot') {
    const r = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(process.argv[3], Buffer.from(r.result.data, 'base64'));
    console.log('saved ' + process.argv[3]);
  } else if (cmd === 'frames') {
    const r = await send('Page.getFrameTree', {});
    const walk = f => { console.log(f.frame.id, '|', (f.frame.url || '').slice(0, 90)); (f.childFrames || []).forEach(walk); };
    walk(r.result.frameTree);
  } else {
    const js = `(() => {
      const out = {};
      out.url = location.href;
      out.bodyText = document.body.innerText.replace(/\\s+/g, ' ').slice(0, 900);
      out.inputs = [...document.querySelectorAll('input')].map(i => ({ type: i.type, filled: (i.value||'').length, vis: !!(i.offsetWidth||i.offsetHeight) }));
      out.buttons = [...document.querySelectorAll('button, .ds-button, [class*=btn]')].filter(b => b.offsetWidth).map(b => ({ t: b.innerText.trim().slice(0, 20) }));
      out.dialog = !!document.querySelector('[class*=dialog], [class*=modal], [class*=captcha]');
      out.iframes = [...document.querySelectorAll('iframe')].map(f => f.src.slice(0, 80));
      return JSON.stringify(out);
    })()`;
    printValue(await send('Runtime.evaluate', { expression: js, returnByValue: true }));
  }
}

main().catch(e => { console.error('ERR ' + e.message); process.exit(1); });
