// 把 window.__capB64 取出来存 png（页面里已存好）
const { execSync } = require('child_process');
const fs = require('fs');
process.env.CDP_ID = '9FFF3B9F77DE239201B00D6CF6391705';
const out = execSync('node D:/小鱼Agent/_t_cdp2.cjs eval "window.__capB64"', { encoding: 'utf8' });
let d = out.trim().replace(/^"+|"+$/g, '');
if (d.length < 100) { console.log('BAD: ' + d.slice(0, 100)); process.exit(1); }
fs.writeFileSync('D:/小鱼Agent/_t_captcha.png', Buffer.from(d, 'base64'));
console.log('saved b64len=' + d.length);
