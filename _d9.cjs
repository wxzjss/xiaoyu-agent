const fs = require("fs");
const P = "src/agent.mjs";
let L = fs.readFileSync(P, "utf8").split(/\r?\n/);
const i = 1663;
L[i] = "      if (!isFillerReply(text)) messages.push({ role: 'assistant', content: text });";
fs.writeFileSync(P, L.join("\r\n"), "utf8");
console.log("=== 1655-1672 上下文 ===");
const L2 = fs.readFileSync(P, "utf8").split(/\r?\n/);
for (let k = 1654; k < 1673; k++) console.log((k + 1) + "|" + L2[k]);
