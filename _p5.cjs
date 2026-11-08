const fs = require("fs");
const P = "src/plan.mjs";
let t = fs.readFileSync(P, "utf8");
const START = "/**\r\n * 【2026-11-08 加】清单的主人会话没了";
const END = "let SESS_DIR = null;";
const i = t.indexOf(START);
const j = t.indexOf(END);
if (i < 0 || j < 0) { console.log("边界没找到 i=" + i + " j=" + j); process.exit(1); }
const NEW = [
  "/**",
  " * 【2026-11-08 加】清单的主人会话没了，就接到最近的活会话上。",
  " *",
  " * 老 bug：跑测试时临时会话（__ord__ 之类）会把清单抢过去，测试一结束会话就删了，",
  " * 清单变成没主的孤儿，谁也不再管。现在读的时候兜一层：发现没主，就接给最近改过的那个会话。",
  " *",
  " * 【2026-11-08 严检补·三条保险】",
  " *   1. 防重入：savePlan 里会回读 loadPlan，而 loadPlan 会走到这儿 —— 不挡就会自己绕自己。",
  " *   2. 只认「真孤儿」：原文件必须存在、而且超过 2 分钟没动过。刚写出来的不算。",
  " *   3. 接完把原文件删掉，不然下次读又接一遍，越接越多。",
  " */",
  "let ADOPTING = false;",
  "function adoptPlanIfOrphan(key, state) {",
  "  if (ADOPTING) return null;",
  "  try {",
  "    ADOPTING = true;",
  "    if (SESS_DIR === null) return null;",
  "    // 会话还在：这不是孤儿，什么都不该做",
  "    if (fs.existsSync(join(SESS_DIR, key + \".json\"))) return null;",
  "    // 原文件得真的在那儿，而且不是刚写出来的（刚写的可能是别的进程正在用）",
  "    const src = fileFor(key);",
  "    if (!fs.existsSync(src)) return null;",
  "    try {",
  "      if (Date.now() - fs.statSync(src).mtimeMs < 120000) return null;",
  "    } catch {",
  "      return null;",
  "    }",
  "    const files = fs",
  "      .readdirSync(SESS_DIR)",
  "      .filter((f) => f.endsWith(\".json\") && !f.startsWith(\"_\"))",
  "      .map((f) => ({ id: f.slice(0, -5), t: fs.statSync(join(SESS_DIR, f)).mtimeMs }))",
  "      .sort((a, b) => b.t - a.t);",
  "    if (!files.length) return null;",
  "    const last = files[0].id;",
  "    if (last === key) return null;",
  "    const st = state || emptyState();",
  "    if (!st.steps.length) return null;",
  "    savePlan(last, { ...st, sessionId: last });",
  "    // 接完把原来那份删掉，不然下次读又来一遍",
  "    try {",
  "      fs.unlinkSync(src);",
  "    } catch {}",
  "    return last;",
  "  } catch {",
  "    return null;",
  "  } finally {",
  "    ADOPTING = false;",
  "  }",
  "}",
  "",
  "",
].join("\r\n");
t = t.slice(0, i) + NEW + t.slice(j);
fs.writeFileSync(P, t, "utf8");
console.log("已重写兜底");
