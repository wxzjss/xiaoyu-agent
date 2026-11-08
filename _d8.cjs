const fs = require("fs");
const P = "src/agent.mjs";
let L = fs.readFileSync(P, "utf8").split(/\r?\n/);
const i = 1663;
console.log("改前: " + JSON.stringify(L[i]));
L[i] = "          if (!isFillerReply(text)) messages.push({ role: 'assistant', content: text });";
fs.writeFileSync(P, L.join("\r\n"), "utf8");
console.log("改后: " + JSON.stringify(L[i]));
