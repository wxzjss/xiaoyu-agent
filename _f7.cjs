const fs = require("fs");
const P = "src/agent.mjs";
let L = fs.readFileSync(P, "utf8").split(/\r?\n/);
L.splice(824, 1);
fs.writeFileSync(P, L.join("\r\n"), "utf8");
const L2 = fs.readFileSync(P, "utf8").split(/\r?\n/);
for (let k = 821; k < 840; k++) console.log((k + 1) + "|" + L2[k]);
