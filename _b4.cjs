const fs = require("fs");
for (const f of ["src/agent.mjs", "src/llm.mjs"]) {
  const L = fs.readFileSync(f, "utf8").split(/\r?\n/);
  L.forEach((l, i) => {
    if (/没有回复|空回复|emptyReply|no content|没说话|兜底|fallback|我在/.test(l) && l.trim().length < 150) {
      console.log(f + ":" + (i + 1) + "|" + l.trim());
    }
  });
}
