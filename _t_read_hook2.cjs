const fs = require('fs');
const s = fs.readFileSync('src/mini-deepseek.mjs', 'utf8');
const i = s.indexOf('__LOGIN_HOOK__');
console.log(JSON.stringify(s.slice(i - 900, i + 700)));
