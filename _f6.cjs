const fs = require("fs");
const L = fs.readFileSync("src/agent.mjs", "utf8").split(/\r?\n/);
L.forEach((l, i) => { if (l.includes("const FILLER_RE =")) console.log((i + 1) + "|" + l.trim()); });
