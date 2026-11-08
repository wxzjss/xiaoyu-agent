const fs = require("fs");
const t = fs.readFileSync("src/thinking.mjs", "utf8");
const i = t.indexOf("LEVELS");
console.log(t.slice(i - 200, i + 1200));
