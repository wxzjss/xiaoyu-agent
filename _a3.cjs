const fs = require("fs");
const L = fs.readFileSync("src/agent.mjs", "utf8").split(/\r?\n/);
for (let k = 1600; k < 1680; k++) console.log((k + 1) + "|" + L[k]);
