const fs = require("fs");
for (const f of ["public/ui/chat.js", "public/index.html"]) {
  const t = fs.readFileSync(f, "utf8");
  if (t.includes("retryReply") || t.includes("filler_retry")) console.log(f + " 有 retry 相关");
  if (t.includes("replaceLast") || t.includes("replaceBubble")) console.log(f + " 有替换气泡");
}
const L = fs.readFileSync("src/agent.mjs", "utf8").split(/\r?\n/);
L.forEach((l, i) => {
  if (/type: 'filler'|filler_retry|retry_reply|type: 'retry'/.test(l)) console.log("agent:" + (i + 1) + "|" + l.trim().slice(0, 110));
});
