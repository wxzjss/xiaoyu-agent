const fs = require("fs");
const t = fs.readFileSync("src/thinking.mjs", "utf8");
console.log("=== withEffort / 各档发什么 ===");
const i = t.indexOf("export function withEffort");
console.log(t.slice(i - 1500, i + 300));
