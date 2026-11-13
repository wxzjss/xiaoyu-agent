const fs = require('fs');
const s = fs.readFileSync('src/mini-deepseek.mjs', 'utf8');
const i = s.indexOf('export async function startLocalService');
const seg = s.slice(i, i + 5900);
fs.writeFileSync('_t_seg_start.txt', seg, 'utf8');
const lines = seg.split('\n');
// 只打关键段：token 读取 + 登录引导
let inLogin = false;
lines.forEach((l, ix) => {
  if (/__LOGIN_HOOK__|hasToken|readDeepSeekToken|opener|waitingLogin|waitForLogin|forceRelogin|spawn|args/.test(l)) console.log(String(ix + 1).padStart(3), l);
});
