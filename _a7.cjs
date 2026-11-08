const fs = require("fs");
const P = "src/agent.mjs";
let t = fs.readFileSync(P, "utf8");
const OLD = "let _fillerRetried = false;";
const before = t.includes(OLD);
console.log("模块级那句还在=" + before);
// 看它周围
const L = t.split(/\r?\n/);
for (let k = 836; k < 848; k++) console.log((k + 1) + "|" + L[k]);
