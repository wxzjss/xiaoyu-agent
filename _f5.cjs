const fs = require("fs");
const P = "src/agent.mjs";
let L = fs.readFileSync(P, "utf8").split(/\r?\n/);
const i = L.findIndex((x) => x.includes("const FILLER_RE ="));
const NEW = [
  "const FILLER_RE = /^(嗯+[，,]?)?(我)?在(在)?[，,。.！!~～]?\\s*(你继续说|继续说|你说|在的|我在的)?[。.！!~～]?$/;",
  "/**",
  " * 【2026-11-08 加】宽松版的占位判定：剥掉标点和语气词之后，",
  " * 只剩「恩/嗯/我/在/的/你/继/续/说/好/啊/呀」这几个字 —— 那就是一句占位废话，",
  " * 不管它怎么组合（「嗯，我在的」「我在的呀」「嗯嗯我在」都算）。",
  " */",
  "const FILLER_LOOSE = (s) => {",
  "  const t = String(s || '').replace(/[\\s，,。.！!~～、？?…·]/g, '');",
  "  if (!t) return true;",
  "  if (t.length > 12) return false;",
  "  return /^[嗯恩我在的呀啊哦好你继续说行]+$/.test(t) && /在/.test(t);",
  "};",
];
L.splice(i + 1, 0, ...NEW);
fs.writeFileSync(P, L.join("\r\n"), "utf8");
console.log("已加 FILLER_LOOSE");
