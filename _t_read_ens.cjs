const fs = require('fs');
const s = fs.readFileSync('public/index.html', 'utf8');
// 添加模型页测连通 onclick 全文（bind@772505）
console.log(s.slice(772505, 772505 + 4600));
