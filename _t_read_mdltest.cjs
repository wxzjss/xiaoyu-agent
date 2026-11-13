const fs = require('fs');
const s = fs.readFileSync('public/index.html', 'utf8');
const j = s.indexOf("getElementById('mdlTest')");
console.log('bind@' + j);
console.log(s.slice(j, j + 3400));
