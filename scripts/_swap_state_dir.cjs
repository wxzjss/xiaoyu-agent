// 一次性脚本：把 .state 的落盘位置从只读的资源根换到可写的数据根
const fs = require('fs');

const FROM = "config.root, '.state'";
const TO = "config.dataDir, '.state'";

let total = 0;
for (const f of fs.readdirSync('src')) {
  if (!f.endsWith('.mjs')) continue;
  const p = 'src/' + f;
  const t = fs.readFileSync(p, 'utf8');
  if (!t.includes(FROM)) continue;
  const n = t.split(FROM).length - 1;
  fs.writeFileSync(p, t.split(FROM).join(TO), 'utf8');
  console.log(`${f}: ${n} 处`);
  total += n;
}
console.log('合计 ' + total);
