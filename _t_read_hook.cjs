const fs = require('fs');
const s = fs.readFileSync('src/mini-deepseek.mjs', 'utf8');
const i = s.indexOf('__LOGIN_HOOK__');
console.log(s.slice(i - 2600, i + 1800));
