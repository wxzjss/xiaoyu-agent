const fs = require('fs');
let c = fs.readFileSync('public/index.html', 'utf8');

const old = `      } else {
        // token 原因：重新取一次 token 并重启服务
        const tk = await localDeepSeekPost('/api/mini-deepseek/token');
        if (!tk || tk.error) { mdlLocalHint('err', (tk && tk.error) || '重新取 token 失败'); return; }
        // 8321 活着时 ensure 不会重启，旧进程里的失效 token 换不成新的：先停再起，强制重读
        await localDeepSeekPost('/api/mini-deepseek/stop').catch(() => {});
        const st = await localDeepSeekEnsure();
        if (st && st.error) { mdlLocalHint('err', st`;
if (!c.includes(old)) throw new Error('③ 原文没匹配上');
const rep = `      } else {
        // token 原因：旧 token 大概率失效（上游 data:null / 401），重取 leveldb 拿回来的还是同一条
        // → 直接开内置浏览器登录页，等主人重新登录拿新 token（最多十分钟）
        mdlLocalHint('', 'token 失效了，正在打开 DeepSeek 登录页，请重新登录（最多等十分钟）…');
        const rl = await localDeepSeekPost('/api/mini-deepseek/relogin', { waitMs: 10 * 60 * 1000 });
        if (!rl || !rl.ok) { mdlLocalHint('err', (rl && rl.error) || '重新登录没完成'); return; }
        const st = await localDeepSeekEnsure();
        if (st && st.error) { mdlLocalHint('err', st`;
c = c.replace(old, rep);
fs.writeFileSync('public/index.html', c, 'utf8');
console.log('OK index.html');

// 快速语法护栏：把 <script> 抠出来 new Function 试一遍不现实（DOM），只确认改动落位
const s2 = fs.readFileSync('public/index.html', 'utf8');
console.log('relogin 前端调用:', s2.includes('/api/mini-deepseek/relogin'));
console.log('提示文案:', s2.includes('正在打开 DeepSeek 登录页'));
