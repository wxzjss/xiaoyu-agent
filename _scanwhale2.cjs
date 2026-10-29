const fs = require('node:fs');
const path = require('node:path');
const dir = 'C:\\Users\\35453\\AppData\\Roaming\\小鱼Agent\\data\\.state\\sessions';
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json') && !f.includes('.bak'));
for (const f of files) {
  let j;
  try { j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { continue; }
  const msgs = j.messages || [];
  const marked = msgs.filter((m) => m && (m._whale || m._whaleSide || m._tale));
  if (!marked.length) continue;
  console.log('\n===', f, '带标记', marked.length, '/', msgs.length);
  for (const m of marked.slice(0, 4)) {
    console.log('  ', JSON.stringify({ role: m.role, _whale: m._whale, _whaleSide: m._whaleSide, _tale: m._tale, txt: String(m.content || '').slice(0, 20) }));
  }
}
