const fs = require("fs");
const L = fs.readFileSync("src/agent.mjs", "utf8").split(/\r?\n/);
L.forEach((l, i) => { if (l.includes("_lastUser")) console.log((i + 1) + "|" + l.trim().slice(0, 130)); });
