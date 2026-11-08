const fs = require("fs");
const P = "scripts/check-ime-compose.mjs";
let t = fs.readFileSync(P, "utf8");
const L = t.split(/\r?\n/);
// 找到 "if (cdp2)" 之前的所有静态断言，全部换成守"已删"
const cut = L.findIndex((x) => x.startsWith("if (cdp2)"));
console.log("if (cdp2) 在第 " + (cut + 1) + " 行，共 " + L.length + " 行");
console.log("--- 前 20 行 ---");
for (let k = 0; k < 20; k++) console.log((k + 1) + "|" + L[k]);
