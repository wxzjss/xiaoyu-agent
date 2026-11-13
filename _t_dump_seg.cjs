const fs = require('fs');
const s = fs.readFileSync('public/index.html', 'utf8');
fs.writeFileSync('_t_seg_ens.txt', s.slice(772505, 772505 + 4700), 'utf8');
const t = fs.readFileSync('src/server.mjs', 'utf8');
const i = t.indexOf('mini-deepseek');
const line = t.split('\n').find(l => l.includes('from \'./mini-deepseek.mjs\'') || l.includes('from "./mini-deepseek.mjs"'));
console.log('IMPORT LINE:', line || 'not found');
