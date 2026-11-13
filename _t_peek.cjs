const fs = require('fs');
for (const p of ['public/index.html', process.env.APPDATA + String.fromCharCode(92) + '小鱼Agent' + String.fromCharCode(92) + 'data' + String.fromCharCode(92) + 'public' + String.fromCharCode(92) + 'index.html']) {
  const s = fs.readFileSync(p, 'utf8');
  console.log('---', p.includes('APPDATA') || p.includes('小鱼') ? 'data份' : '仓库份', 'len', s.length);
  console.log('带/v1模板串出现:', s.split('/v1`;').length - 1);
  const i = s.indexOf("payload.providerLocalDeepSeek");
  const seg = s.slice(i, i + 900);
  console.log(seg.slice(0, 700));
}
