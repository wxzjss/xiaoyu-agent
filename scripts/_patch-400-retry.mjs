import fs from 'node:fs';

const P = 'D:/小鱼Agent/src/agent.mjs';
let s = fs.readFileSync(P, 'utf8');
const orig = s;

const A1 = "        if (!limited || !cfg429.enabled) throw err;";
if (!s.includes(A1)) { console.error('锚点1没找到'); process.exit(1); }
…（中间省略 1603 字）…
s = s.replace(A2, "      try { _meter.finish({ outcome: _turnedOutOK ? 'done' : 'aborted' }); } catch {}");

fs.writeFileSync(P, s, 'utf8');
console.log('OK changed=' + (s.length - orig.length));