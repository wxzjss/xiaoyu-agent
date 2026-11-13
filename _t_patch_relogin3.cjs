const fs = require('fs');

// ============ ② src/server.mjs ============
let b = fs.readFileSync('src/server.mjs', 'utf8');

// 2a. import 补 invalidateTokenCache
const impOld = "  waitForLogin,";
if (!b.includes(impOld)) throw new Error('2a 锚点没找到');
b = b.replace(impOld, impOld + "\n  invalidateTokenCache,");

// 2b. /relogin 路由：停服务 → 作废缓存 → 开登录页等重登 → 带新 token 重启
const anchor = "if (req.method === 'POST' && url.pathname === '/api/mini-deepseek/token') {";
if (!b.includes(anchor)) throw new Error('2b 路由锚点没找到');
const route = `if (req.method === 'POST' && url.pathname === '/api/mini-deepseek/relogin') {
    // token 失效专用：停服务 → 作废 token 缓存 → 开内置浏览器登录页等重登 → 带新 token 重启
    try { stopLocalService(); } catch {}
    invalidateTokenCache();
    const body = await readBody(req).catch(() => ({}));
    const started = await startLocalService({ opener: openInBrowser, waitMs: Number(body && body.waitMs) || 0, forceRelogin: true });
    if (!started.ok) return json(res, 200, { ok: false, reason: started.reason, error: started.error || '重新登录失败' });
    return json(res, 200, { ok: true, hasToken: true, base: MINI_DS_BASE, key: MINI_DS_KEY });
  }

` + anchor;
b = b.replace(anchor, route);
fs.writeFileSync('src/server.mjs', b, 'utf8');
console.log('OK server.mjs');

// ============ ③ public/index.html：token 失效自动走 relogin ============
let c = fs.readFileSync('public/index.html', 'utf8');
// 找到 ensure 里「重新取 token」的分支，把它改成先判断是否失效类错误
const i = c.indexOf("const tk = await localDeepSeekPost('/api/mini-deepseek/token');");
if (i < 0) throw new Error('3 前端 token 锚点没找到');
console.log('--- 前端 token 分支原文 ---');
console.log(c.slice(i - 600, i + 400));
