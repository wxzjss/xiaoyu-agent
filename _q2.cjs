const fs = require("fs");
const P = "scripts/check-live-sync.mjs";
const L = fs.readFileSync(P, "utf8").split(/\r?\n/);
const i = L.findIndex((x) => x.startsWith("function same(a, b)"));
if (i < 0) { console.log("没找到"); process.exit(1); }
const NEW = [
  "/* 【2026-11-08 加】全量回归里有脚本会临时把文件改坏再还原（check-gates-self），",
  " * 那一小段时间正好被这里读到，就会假红。不一致时等 300ms 重读一次，",
  " * 仍不一致才判真不一致 —— 别把别人的中间态当成自己的错。 */",
  "function same(a, b) {",
  "  if (!fs.existsSync(a) || !fs.existsSync(b)) return null;",
  "  const eq = () => {",
  "    try {",
  "      const x = fs.readFileSync(a);",
  "      const y = fs.readFileSync(b);",
  "      return x.length === y.length && x.equals(y);",
  "    } catch {",
  "      return null;",
  "    }",
  "  };",
  "  if (eq()) return true;",
  "  try {",
  "    const t0 = Date.now();",
  "    while (Date.now() - t0 < 300) {}",
  "  } catch {}",
  "  return eq();",
  "}",
];
L.splice(i, 6, ...NEW);
fs.writeFileSync(P, L.join("\r\n"), "utf8");
console.log("已加重读");
