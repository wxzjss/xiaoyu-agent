const fs = require("fs");
for (const f of ["src/config.mjs", "src/llm.mjs", "src/agent.mjs", "src/server.mjs"]) {
  if (!fs.existsSync(f)) continue;
  const L = fs.readFileSync(f, "utf8").split(/\r?\n/);
  L.forEach((l, i) => {
    if (/reasoning_effort|reasoningEffort|thinking|思考强度|推理强度|effort/.test(l)) {
      console.log(f + ":" + (i + 1) + "|" + l.trim().slice(0, 120));
    }
  });
}
