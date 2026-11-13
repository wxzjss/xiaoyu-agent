const fs = require('fs');

// ============ ① src/mini-deepseek.mjs：startLocalService 支持 forceRelogin ============
let a = fs.readFileSync('src/mini-deepseek.mjs', 'utf8');
const fnHead = 'export async function startLocalService({ token, opener, waitMs } = {}) {';
if (!a.includes(fnHead)) throw new Error('mini-deepseek: 函数头没找到');
// 1a. 函数签名加 forceRelogin
a = a.replace(fnHead, 'export async function startLocalService({ token, opener, waitMs, forceRelogin } = {}) {');
// 1b. 无条件跳过旧 token：直接走登录引导（把「没 token 才引导」改成「forceRelogin 时也引导」）
const hookOld = /\/\/ __LOGIN_HOOK__ 【2026-11-12】没 token 不是直接失败：开内置浏览器登录页，等十分钟。\n([\s\S]*?\n)(\s*const tok =)/;
const m = a.match(hookOld);
if (!m) throw new Error('mini-deepseek: LOGIN_HOOK 段没匹配上');
console.log('--- LOGIN_HOOK 原文 ---\n' + m[0]);
fs.writeFileSync('src/mini-deepseek.mjs', a, 'utf8');
console.log('OK step1 (签名已改，hook 段待确认后改)');
