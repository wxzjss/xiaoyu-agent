const fs = require("fs");
const t = fs.readFileSync("src/thinking.mjs", "utf8");
const i = t.indexOf("export function withEffort");
console.log(t.slice(i - 100, i + 1500));
