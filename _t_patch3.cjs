const fs = require('fs');
const p = 'src/mini-deepseek.mjs';
let t = fs.readFileSync(p, 'utf8');

const old1 = `  st.waitingLogin = true;
  try {
    if (typeof opener === 'function') {
      try { await opener('https://chat.deepseek.com/sign_in'); } catch { /* 打不开就算了，照样轮询 */ }
    }
    const total = Number(waitMs) > 0 ? Number(waitMs) : LOGIN_WAIT_MS;
    const deadline = Date.now() + total;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, POLL_MS));
      const got = read();
      if (got && got.token) {
        st.waitingLogin = false;
        return { ok: true, token: got.token };
      }
    }`;
const new1 = `  st.waitingLogin = true;
  try {
    // force 时旧 token 还躺在 leveldb 里，必须记下来，只认「跟旧的不一样」的新 token，
    // 不然没重登也会把旧死 token 捡回来当登录好了。
    let oldToken = '';
    if (force) { const g0 = read(); if (g0 && g0.token) oldToken = g0.token; }
    if (typeof opener === 'function') {
      try { await opener('https://chat.deepseek.com/sign_in'); } catch { /* 打不开就算了，照样轮询 */ }
    }
    const total = Number(waitMs) > 0 ? Number(waitMs) : LOGIN_WAIT_MS;
    const deadline = Date.now() + total;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, POLL_MS));
      const got = read();
      if (got && got.token && got.token !== oldToken) {
        st.waitingLogin = false;
        return { ok: true, token: got.token };
      }
    }`;
if (!t.includes(old1)) { console.log('E1'); process.exit(1); }
t = t.replace(old1, new1);
fs.writeFileSync(p, t);
console.log('OK', t.length);
