const fs = require("fs");
const P = "src/tools.mjs";
let t = fs.readFileSync(P, "utf8");
const OLD = "  if (overrideSignal) return runWithToolContext({ sessionId, signal: overrideSignal }, run);\r\n";
const NEW = [
  "  // 【2026-11-08 严检补】sessionId 可能是空的（会话外跑、启动自检）。空的时候别往 ctx 里塞",
  "  // 一个 undefined —— runWithToolContext 里是 { ...CTX, ...ctx }，塞进去会把全局那份好值盖成空。",
  "  // 有值才传，没值就让它按老规矩退回全局 CTX。",
  "  if (overrideSignal) {",
  "    const _ctx = { signal: overrideSignal };",
  "    if (sessionId) _ctx.sessionId = sessionId;",
  "    return runWithToolContext(_ctx, run);",
  "  }",
].join("\r\n") + "\r\n";
if (!t.includes(OLD)) { console.log("锚点没找到"); process.exit(1); }
t = t.replace(OLD, NEW);
fs.writeFileSync(P, t, "utf8");
console.log("已加空值防护");
