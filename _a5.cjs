const fs = require("fs");
const src = fs.readFileSync("src/agent.mjs", "utf8");
const L = src.split(/\r?\n/);
L.forEach((l, i) => { if (l.includes("_fillerRetried")) console.log((i + 1) + "|" + l.trim()); });
console.log("=== 函数边界 ===");
L.forEach((l, i) => { if (/^(export )?(async )?function |^const .* = (async )?\(/.test(l)) console.log((i + 1) + "|" + l.trim().slice(0, 90)); });
