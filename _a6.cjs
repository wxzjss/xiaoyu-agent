const fs = require("fs");
const P = "src/agent.mjs";
const L = fs.readFileSync(P, "utf8").split(/\r?\n/);
// 找 534 附近 runAgent 的 { 后面
let start = -1;
for (let i = 530; i < 560; i++) if (L[i] && L[i].includes("runAgent")) { start = i; break; }
console.log("runAgent 在 " + (start + 1) + " 行");
for (let k = start; k < start + 40; k++) console.log((k + 1) + "|" + L[k]);
