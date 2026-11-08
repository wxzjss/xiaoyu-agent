const fs = require("fs");
const P = "public/index.html";
const L = fs.readFileSync(P, "utf8").split(/\r?\n/);
// 删 11534..11593（1-based），即索引 11533..11592；再删空心的 pointerdown 监听和它的注释（11525..11532 → 索引 11524..11531）
const start1 = 11524, end1 = 11532; // 注释块 + 空监听
const start2 = 11533, end2 = 11592; // 历史注释大块
console.log("删前 11525-11532:");
for (let k = start1; k <= end1; k++) console.log("  " + (k + 1) + "|" + (L[k] || "").slice(0, 60));
console.log("删前 11534-11593 首尾:");
console.log("  " + (start2 + 1) + "|" + (L[start2] || "").slice(0, 60));
console.log("  " + (end2 + 1) + "|" + (L[end2] || "").slice(0, 60));
const out = L.slice(0, start1).concat(L.slice(end2 + 1));
fs.writeFileSync(P, out.join("\r\n"), "utf8");
console.log("删了 " + (end2 + 1 - start1) + " 行，剩 " + out.length + " 行");
