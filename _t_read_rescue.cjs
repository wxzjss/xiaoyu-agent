const fs = require('fs');
const s = fs.readFileSync('public/index.html', 'utf8');
const i = s.indexOf('async function localDeepSeekEnsure');
console.log(s.slice(i - 200, i + 2600));
console.log('\n=====MDLTEST=====\n');
console.log(s.slice(772505, 772505 + 4200));
