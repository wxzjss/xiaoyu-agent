const fs = require("fs");
const L = fs.readFileSync("src/agent.mjs", "utf8").split(/\r?\n/);
L.forEach((l, i) => {
  if (/onEvent\(\{ type: 'text'/.test(l)) console.log((i + 1) + "|" + l.trim().slice(0, 130));
});
console.log("=== 收尾 return 附近 ===");
L.forEach((l, i) => {
  if (i > 1660 && i < 1800 && /return \{|return text|return String/.test(l.trim())) console.log((i + 1) + "|" + l.trim().slice(0, 120));
});
