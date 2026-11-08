const fs = require("fs");
const src = fs.readFileSync("src/agent.mjs", "utf8");
const m = src.match(/const FILLER_RE = (\/.+\/);/);
const RE = eval(m[1]);
for (const s of ["嗯，我在的", "嗯，我在。", "我在，你继续说。", "我在", "好的我在"]) {
  console.log(JSON.stringify(s) + " -> " + RE.test(s.trim()));
}
