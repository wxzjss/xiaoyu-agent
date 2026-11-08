const fs = require("fs");
const P = "scripts/check-tool-hub-leak.mjs";
let t = fs.readFileSync(P, "utf8");
const OLDLINE = "const ui = fs.readFileSync('public/index.html', 'utf8');";
if (!t.includes(OLDLINE)) { console.log("锚点没找到"); process.exit(1); }
const NEWLINES = [
  "const _uiHtml = fs.readFileSync('public/index.html', 'utf8');",
  "// 【2026-11-08】柜子那组函数已搬进 ui/hub.js（commit c001137），守卫要跟着去新家找",
  "const _hubJs = fs.existsSync('public/ui/hub.js') ? fs.readFileSync('public/ui/hub.js', 'utf8') : '';",
  "const ui = _uiHtml + '\\n' + _hubJs;",
].join("\n");
t = t.replace(OLDLINE, NEWLINES);
fs.writeFileSync(P, t, "utf8");
console.log("已改");
