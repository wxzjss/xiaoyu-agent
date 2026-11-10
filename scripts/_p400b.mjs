import fs from 'node:fs';
const P = 'D:/小鱼Agent/src/agent.mjs';
let s = fs.readFileSync(P, 'utf8');
const before = s.length;
const A = "        resetStreak(sessionId + ':drop');";
const i = s.indexOf(A);
if (i < 0) { console.log('ANCHOR-MISS'); process.exit(1); }
const ins = A + "\n        resetStreak(sessionId + ':badshape');";
s = s.slice(0, i) + ins + s.slice(i + A.length);
fs.writeFileSync(P, s, 'utf8');
console.log('OK delta=' + (s.length - before));