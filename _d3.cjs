const fs = require("fs");
const P = "src/agent.mjs";
let L = fs.readFileSync(P, "utf8").split(/\r?\n/);
const i = L.findIndex((x) => x.includes("isFillerReply(text)) messages.push"));
console.log("坏行索引 " + i + ": " + JSON.stringify(L[i]));
const GOOD = "          if (String(text || '').trim() && !isFillerReply(text)) messages.push({ role: 'assistant', content: text });".replace(/'''/g, "'");
L[i] = GOOD;
fs.writeFileSync(P, L.join("\r\n"), "utf8");
console.log("修好 = " + JSON.stringify(L[i]));
