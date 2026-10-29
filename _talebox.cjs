const fs = require('node:fs');
const dir = 'C:\\Users\\35453\\AppData\\Roaming\\小鱼Agent\\data\\.state\\sessions';
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json') && !f.includes('.bak'));
for (const f of files) {
  let j;
  try { j = JSON.parse(fs.readFileSync(dir + '\\' + f, 'utf8')); } catch { continue; }
  const msgs = j.messages || [];
  const cols = new Map();
  for (const m of msgs) {
    const who = m && m._tale && m._tale.who ? m._tale.who : '';
    if (!who) continue;
    const c = String((m._tale && m._tale.color) || '(空)');
    const k = who + ' → ' + c;
    cols.set(k, (cols.get(k) || 0) + 1);
  }
  if (cols.size) console.log(f, JSON.stringify([...cols.entries()]));
}
