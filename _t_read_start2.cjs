const fs = require('fs');
const s = fs.readFileSync('src/mini-deepseek.mjs', 'utf8');
const i = s.indexOf('export async function startLocalService');
const seg = s.slice(i, i + 5200);
const lines = seg.split('\n');
lines.forEach((l, ix) => console.log(String(ix + 1).padStart(3), l));
