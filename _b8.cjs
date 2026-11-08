const fs = require("fs");
const L = fs.readFileSync("src/agent.mjs", "utf8").split(/\r?\n/);
console.log("=== FILLER_RE ===");
L.forEach((l, i) => { if (l.includes("FILLER_RE")) console.log((i + 1) + "|" + l.trim()); });
console.log("=== 1560~1636 之间有没有 return / continue ===");
for (let k = 1555; k < 1636; k++) {
  const s = L[k].trim();
  if (/^return|^continue|^break|正在发送|onEvent\(\{ type: 'text'/.test(s)) console.log((k + 1) + "|" + s.slice(0, 110));
}
