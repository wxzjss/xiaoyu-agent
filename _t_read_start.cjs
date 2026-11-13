const fs = require('fs');
const s = fs.readFileSync('src/mini-deepseek.mjs', 'utf8');
const i = s.indexOf('export async function startLocalService');
console.log('fn@' + i);
console.log(s.slice(i, i + 4200));
