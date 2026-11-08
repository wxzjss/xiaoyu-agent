const fs = require("fs");
const L = fs.readFileSync("src/agent.mjs", "utf8").split(/\r?\n/);
L.forEach((l, i) => {
  if (l.includes("isFillerReply") || l.includes("_fillerRetried") || l.includes("needsRealReply")) console.log((i + 1) + "|" + l.trim().slice(0, 130));
});
