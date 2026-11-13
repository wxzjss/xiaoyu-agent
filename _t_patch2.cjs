const fs = require('fs');
const p = 'src/mini-deepseek.mjs';
let t = fs.readFileSync(p, 'utf8');

const old1 = "export async function waitForLogin({ opener, waitMs, reader } = {}) {";
const new1 = "export async function waitForLogin({ opener, waitMs, reader, force } = {}) {";
if (!t.includes(old1)) { console.log('E1'); process.exit(1); }
t = t.replace(old1, new1);

const old2 = `  const read = typeof reader === 'function' ? reader : readDeepSeekToken;
  const got0 = read();
  if (got0 && got0.token) return { ok: true, already: true };`;
const new2 = `  const read = typeof reader === 'function' ? reader : readDeepSeekToken;
  // force（forceRelogin）：旧 token 已知失效，跳过预检，必须等真重登
  if (!force) {
    const got0 = read();
    if (got0 && got0.token) return { ok: true, already: true };
  }`;
if (!t.includes(old2)) { console.log('E2'); process.exit(1); }
t = t.replace(old2, new2);

const old3 = "      const w = await waitForLogin({ opener, waitMs });";
const new3 = "      const w = await waitForLogin({ opener, waitMs, force: true });";
if (!t.includes(old3)) { console.log('E3'); process.exit(1); }
t = t.replace(old3, new3);

fs.writeFileSync(p, t);
console.log('OK', t.length);
