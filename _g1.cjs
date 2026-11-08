const fs = require("fs");
const P = "src/agent.mjs";
let L = fs.readFileSync(P, "utf8").split(/\r?\n/);
const i = L.findIndex((x) => x.includes("return FILLER_RE.test(t) || t.indexOf('你继续说') >= 0;"));
console.log("找到 = " + (i + 1));
L[i] = "  return FILLER_RE.test(t) || t.indexOf('你继续说') >= 0 || FILLER_LOOSE(t);";
fs.writeFileSync(P, L.join("\r\n"), "utf8");
console.log("改后: " + L[i]);
