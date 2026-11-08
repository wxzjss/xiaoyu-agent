const fs = require("fs");
const P = "scripts/check-live-sync.mjs";
const L = fs.readFileSync(P, "utf8").split(/\r?\n/);
const i = L.findIndex((x) => x.startsWith("function same(a, b)"));
if (i < 0) { console.log("没找到 same"); process.exit(0); }
console.log("--- 原文 ---");
for (let k = i; k < i + 10; k++) console.log((k + 1) + "|" + L[k]);
