const fs = require("fs");
const P = "src/plan.mjs";
let t = fs.readFileSync(P, "utf8");
const OLD = '    const st = state || emptyState();\r\n    if (!st.steps.length) return null;\r\n    savePlan(last, { ...st, sessionId: last });';
const NEW = [
  '    const st = state || emptyState();',
  '    if (!st.steps.length) return null;',
  '    // 【2026-11-08 修·踩过的坑】目标位置已经有清单时绝不许覆盖。',
  '    // 刚才就是把幽灵清单接到了自己会话上，把主清单盖掉了（22 步变 1 步，靠 _history 才救回来）。',
  '    if (fs.existsSync(fileFor(last))) return null;',
  '    savePlan(last, { ...st, sessionId: last });',
].join("\r\n");
if (!t.includes(OLD)) { console.log("锚点没找到"); process.exit(1); }
t = t.replace(OLD, NEW);
fs.writeFileSync(P, t, "utf8");
console.log("已加防覆盖");
