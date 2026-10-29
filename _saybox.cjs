const fs = require('node:fs');
const dir = 'C:\\Users\\35453\\AppData\\Roaming\\小鱼Agent\\data\\.state\\sessions';
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json') && !f.includes('.bak'));
let total = 0;
for (const f of files) {
  let j;
  try { j = JSON.parse(fs.readFileSync(dir + '\\' + f, 'utf8')); } catch { continue; }
  const msgs = j.messages || [];
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i];
    if (!m || !m._say) continue;
    total++;
    if (total <= 12) {
      console.log(f, i, JSON.stringify({ role: m.role, say: m._say, who: m.who, txt: String(m.content || '').slice(0, 24) }));
    }
  }
}
console.log('带 _say 的总数：', total);
