const fs = require('node:fs');
const path = require('node:path');
const dir = 'C:\\Users\\35453\\AppData\\Roaming\\小鱼Agent\\data\\.state\\sessions';
const f = path.join(dir, 'smvs3h5v0iajd.json');
const j = JSON.parse(fs.readFileSync(f, 'utf8'));
const msgs = j.messages || [];
let n = 0;
for (let i = 0; i < msgs.length; i++) {
  const m = msgs[i];
  const keys = Object.keys(m).filter((k) => k.startsWith('_'));
  if (m.role !== 'assistant') continue;
  if (!(m._whale || m._whaleSide || m._tale)) continue;
  console.log(i, JSON.stringify({ _whale: m._whale, _whaleSide: m._whaleSide, _tale: m._tale, txt: String(m.content || '').slice(0, 24) }));
  if (++n >= 12) break;
}
console.log('总计带标记的 assistant：', msgs.filter((m) => m.role === 'assistant' && (m._whale || m._whaleSide || m._tale)).length, '/', msgs.length);
