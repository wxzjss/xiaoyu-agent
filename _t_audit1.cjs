const fs = require('fs');
const src = String.raw`C:\Users\35453\AppData\Roaming\小鱼Agent\data\code\src`;
const mini = fs.readFileSync(src + String.raw`\mini-deepseek.mjs`, 'utf8');
const server = fs.readFileSync(src + String.raw`\server.mjs`, 'utf8');
const front = fs.readFileSync(String.raw`C:\Users\35453\AppData\Roaming\小鱼Agent\data\public\index.html`, 'utf8');
let pass = 0, fail = 0;
const chk = (n, ok) => { if (ok) { pass++; console.log('PASS', n); } else { fail++; console.log('FAIL', n); } };

// 一、后端 forceRelogin 链
chk('waitForLogin 支持 force', mini.includes('reader, force'));
chk('force 记录旧 token', mini.includes("if (force) { const g0 = read(); if (g0 && g0.token) oldToken = g0.token; }"));
chk('轮询只认新 token', mini.includes('got.token !== oldToken'));
chk('forceRelogin 分支存在', mini.includes('forceRelogin'));
chk('forceRelogin 传 force:true', mini.includes('waitForLogin({ opener, waitMs, force: true })'));

// 二、server.mjs /relogin 路由
const m = server.match(/mini-deepseek\/relogin/);
chk('server 有 /relogin 路由', !!m);
chk('relogin 走 forceRelogin', /relogin[\s\S]{0,400}?forceRelogin\s*:\s*true/.test(server) || server.includes('forceRelogin: true'));
chk('invalidateTokenCache 已 import', server.includes('invalidateTokenCache'));

// 三、前端 relogin 链
chk('前端调 /relogin', front.includes('mini-deepseek/relogin'));
chk('前端识别 token 失效', /invalid[_-]?token|401/i.test(front));

// 四、/v1 自动补 + NoneType 防护（之前两报错的修复）
const models = fs.readFileSync(src + String.raw`\models.mjs`, 'utf8');
chk('models 有 /v1 归一化', /\/v1['"`]/.test(models) || models.includes("endsWith('/v1')"));
const py = fs.readFileSync(String.raw`D:\小鱼Agent\sandbox\mini_ds\mini_ds.py`, 'utf8');
chk('py create_session 防护 NoneType', py.includes('INVALID_TOKEN') || py.includes('data.get("data")') || /if not .*data/i.test(py));

console.log('===', pass, 'pass,', fail, 'fail ===');
process.exit(fail ? 1 : 0);
