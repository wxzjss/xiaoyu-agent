const fs = require("fs");
const src = fs.readFileSync("src/agent.mjs", "utf8");
// 把 FILLER_RE 和两个判据抠出来实测
const m = src.match(/const FILLER_RE = (\/.+\/);/);
console.log("正则: " + (m ? m[1] : "没找到"));
const RE = eval(m[1]);
for (const s of ["嗯，我在。", "嗯，我在，你继续说。", "我在", "嗯，我在的", "现在查最关键的一环", "10"]) {
  console.log(JSON.stringify(s) + " -> 敷衍=" + RE.test(s.trim()));
}
