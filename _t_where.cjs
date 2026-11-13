const fs = require('fs');
const t = fs.readFileSync('src/server.mjs', 'utf8');
// relogin 路由的绝对位置
const iRel = t.indexOf("'/api/mini-deepseek/relogin'");
console.log('relogin 位置:', iRel);
// 405 兜底的位置
const i405 = t.indexOf("json(res, 405, { error: 'method not allowed' })");
console.log('405兜底位置:', i405);
// mini-deepseek 路由块的起始
const iBlk = t.indexOf('/api/mini-deepseek/status');
console.log('status路由位置:', iBlk);
console.log('relogin 在 405 之前?', iRel < i405 ? '是(能执行到)' : '否(永远执行不到!)');
// 看 relogin 前后各 400 字符确认作用域
console.log('--- relogin 前 400 ---');
console.log(t.slice(iRel - 400, iRel));
console.log('--- relogin 后 300 ---');
console.log(t.slice(iRel, iRel + 300));
