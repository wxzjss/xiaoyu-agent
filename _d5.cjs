const fs = require("fs");
const P = "src/agent.mjs";
let L = fs.readFileSync(P, "utf8").split(/\r?\n/);
// 删 1612-1615（0-based 1611..1614），保留 1606-1611 那份带注释的
console.log("要删:");
for (let k = 1611; k < 1615; k++) console.log((k + 1) + "|" + L[k]);
L.splice(1611, 4);
fs.writeFileSync(P, L.join("\r\n"), "utf8");
console.log("删完，从 1604 开始看:");
const L2 = fs.readFileSync(P, "utf8").split(/\r?\n/);
for (let k = 1603; k < 1616; k++) console.log((k + 1) + "|" + L2[k]);
