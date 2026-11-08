const fs = require("fs");
const P = "scripts/check-live-sync.mjs";
let t = fs.readFileSync(P, "utf8");
const OLD = ["  try {", "    const t0 = Date.now();", "    while (Date.now() - t0 < 300) {}", "  } catch {}"].join("\r\n");
const NEW = [
  "  /* 真睡 300ms：Atomics.wait 不烧 CPU（while 空转会顶满一个核） */",
  "  try {",
  "    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300);",
  "  } catch {}",
].join("\r\n");
if (!t.includes(OLD)) { console.log("锚点没找到"); process.exit(1); }
t = t.replace(OLD, NEW);
fs.writeFileSync(P, t, "utf8");
console.log("已改成真睡眠");
