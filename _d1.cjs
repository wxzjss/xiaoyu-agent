const fs = require("fs");
const P = "src/agent.mjs";
let L = fs.readFileSync(P, "utf8").split(/\r?\n/);
// 在 1606 之前插判断：敷衍的话别落历史
const idx = L.findIndex((x, i) => i > 1595 && i < 1615 && x.includes("if (String(text || '').trim()) messages.push({ role: 'assistant', content: text });"));
console.log("找到 1606 行 = 索引 " + idx);
console.log(JSON.stringify(L[idx]));
