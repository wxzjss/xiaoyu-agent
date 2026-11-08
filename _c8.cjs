const fs = require("fs");
const L = fs.readFileSync("src/agent.mjs", "utf8").split(/\r?\n/);
console.log("=== 找 onEvent type:text 和 messages.push assistant text ===");
for (let k = 1400; k < 1640; k++) {
  const s = L[k].trim();
  if (/onEvent\(\{ type: 'text'|messages\.push\(\{ role: 'assistant'/.test(s)) console.log((k + 1) + "|" + s.slice(0, 110));
}
