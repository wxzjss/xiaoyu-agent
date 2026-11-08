const fs = require("fs");
const P = "public/index.html";
const L = fs.readFileSync(P, "utf8").split(/\r?\n/);
const out = [];
let removed = 0;
for (let i = 0; i < L.length; i++) {
  const s = L[i].trim();
  if (s === "window._imeUserTouchedAt = Date.now();") { removed++; console.log("删第 " + (i + 1) + " 行: " + s); continue; }
  if (s === "try { window.imeTypingRecently = imeTypingRecently; } catch {}") { removed++; console.log("删第 " + (i + 1) + " 行: " + s); continue; }
  out.push(L[i]);
}
fs.writeFileSync(P, out.join("\r\n"), "utf8");
console.log("共删 " + removed + " 行，剩 " + out.length + " 行");
