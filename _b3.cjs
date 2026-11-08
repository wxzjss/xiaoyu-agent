const fs = require("fs");
console.log("=== thinking.mjs 档位 ===");
const t = fs.readFileSync("src/thinking.mjs", "utf8");
const L = t.split(/\r?\n/);
L.forEach((l, i) => {
  if (/LEVELS|export function|disabled|low|medium|high|max/i.test(l) && l.trim().length < 140) console.log((i + 1) + "|" + l.trim());
});
