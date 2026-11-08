const fs = require("fs");
const L = fs.readFileSync("src/agent.mjs", "utf8").split(/\r?\n/);
for (let k = 1585; k < 1612; k++) console.log((k + 1) + "|" + L[k]);
