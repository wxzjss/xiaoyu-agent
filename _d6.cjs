const fs = require("fs");
const P = "src/agent.mjs";
let L = fs.readFileSync(P, "utf8").split(/\r?\n/);
const i = L.findIndex((x, k) => k > 1610 && k < 1640 && x.includes("messages.push({ role: 'assistant', content: text })"));
console.log("索引 " + i + " -> " + JSON.stringify(L[i]));
if (i > 0) {
  L[i] = "          if (!isFillerReply(text)) messages.push({ role: 'assistant', content: text });";
  fs.writeFileSync(P, L.join("\r\n"), "utf8");
  console.log("已改 -> " + JSON.stringify(L[i]));
}
