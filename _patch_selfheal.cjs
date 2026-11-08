const fs = require("fs");
const P = "scripts/check-plan-archive.mjs";
let t = fs.readFileSync(P, "utf8");
const A = "const HIST = path.join(cfg.config.dataDir, '.state', 'plan', '_history');";
const ADD = A + "\n\n// 【2026-11-08 加·自愈】以前只在正常跑完时清自己的探针，中途被打断（重启/掐掉）就留残骸，\n// 日积月累攒了 140 份。现在开跑先把历史残骸扫干净，跑完再清一次。\n{\n  try {\n    const dir = path.join(cfg.config.dataDir, '.state', 'plan');\n    for (const f of fs.readdirSync(dir)) {\n      if (/^__(gate|probe|adopt|ghost|verify)/.test(f)) fs.unlinkSync(path.join(dir, f));\n    }\n  } catch {}\n}";
if (!t.includes(A)) { console.log("锚点没找到"); process.exit(1); }
if (t.includes("自愈")) { console.log("已经加过了"); process.exit(0); }
t = t.replace(A, ADD);
fs.writeFileSync(P, t, "utf8");
console.log("已加自愈清理");
