const fs = require('fs');

// ============ ① src/mini-deepseek.mjs ============
let a = fs.readFileSync('src/mini-deepseek.mjs', 'utf8');

// 1a. 函数签名加 forceRelogin
const headOld = 'export async function startLocalService({ token, opener, waitMs } = {}) {';
const headNew = 'export async function startLocalService({ token, opener, waitMs, forceRelogin } = {}) {';
if (!a.includes(headOld)) throw new Error('1a 函数头没找到');
a = a.replace(headOld, headNew);

// 1b. forceRelogin：跳过旧 token，直接开登录页
const hookOld = `  let tk = String(token || '').trim();
  if (!tk) {
    let got = await refreshTokenAsync();
    // __LOGIN_HOOK__ 【2026-11-12】没 token 不是直接失败：开内置浏览器登录页，等十分钟。
    if (!got.token) {
      const w = await waitForLogin({ opener, waitMs });
      if (!w.ok) return { ok: false, reason: w.reason, error: w.error || '没登录 DeepSeek' };
      tk = w.token;
    } else {
      tk = got.token;
    }
  }`;
const hookNew = `  let tk = String(token || '').trim();
  if (!tk || forceRelogin) {
    // forceRelogin：旧 token 大概率已失效，无视它，直接开登录页等重新登录
    let got = forceRelogin ? { token: '' } : await refreshTokenAsync();
    // __LOGIN_HOOK__ 【2026-11-12】没 token 不是直接失败：开内置浏览器登录页，等十分钟。
    // 【2026-11-13】token 失效也一样：开登录页，等主人重新登录拿新 token。
    if (!got.token) {
      const w = await waitForLogin({ opener, waitMs });
      if (!w.ok) return { ok: false, reason: w.reason, error: w.error || '没登录 DeepSeek' };
      tk = w.token;
    } else {
      tk = got.token;
    }
  }`;
if (!a.includes(hookOld)) throw new Error('1b hook 段没找到');
a = a.replace(hookOld, hookNew);
fs.writeFileSync('src/mini-deepseek.mjs', a, 'utf8');
console.log('OK mini-deepseek.mjs');

// ============ ② src/server.mjs：加 /relogin 路由 ============
let b = fs.readFileSync('src/server.mjs', 'utf8');
// 看 import 块里有没有 stopLocalService / invalidateTokenCache
const imp = b.match(/import\s*{([^}]*)}\s*from\s*'\.\/mini-deepseek\.mjs'/);
if (!imp) throw new Error('2 import 块没找到');
const names = imp[1].split(',').map(x => x.trim()).filter(Boolean);
console.log('imported:', names.join(', '));
const need = ['startLocalService', 'stopLocalService', 'invalidateTokenCache'].filter(n => !names.includes(n));
if (need.length) throw new Error('2 缺 import: ' + need.join(','));
