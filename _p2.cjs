const fs = require("fs");
const P = "scripts/check-plan-gate.mjs";
let t = fs.readFileSync(P, "utf8");
const A = "const t = makeChecker('清单缺失看守');";
const ADD = A + "\n\n// 【2026-11-08 加·自愈】中途被打断会留 __gate_probe_* 残骸，开跑先扫干净。\n{\n  try {\n    const dir = path.join(ROOT, \"..\", \".state\", \"plan\");\n    const dir2 = path.join(ROOT, \".state\", \"plan\");\n    for (const d of [dir, dir2]) {\n      if (!fs.existsSync(d)) continue;\n      for (const f of fs.readdirSync(d)) {\n        if (/^__(gate|probe|adopt|ghost|verify)/.test(f)) fs.unlinkSync(path.join(d, f));\n      }\n    }\n  } catch {}\n}";
if (!t.includes(A)) { console.log("锚点没找到"); process.exit(1); }
if (t.includes("自愈")) { console.log("已加过"); process.exit(0); }
t = t.replace(A, ADD);
fs.writeFileSync(P, t, "utf8");
console.log("已加自愈");
