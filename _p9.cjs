const fs = require("fs");
const P = "scripts/check-ime-compose.mjs";
let t = fs.readFileSync(P, "utf8");
const OLDLINE = "const ui = fs.readFileSync('public/index.html', 'utf8');";
const NEW = [
  "const ui = fs.readFileSync('public/index.html', 'utf8');",
  "",
  "/* 【2026-11-08 退役】主人后来让把「掰输入法」那套从 index.html 和主进程里",
  " * 彻底删掉（commit e5bee55）。前端没有 composition 监听了，本脚本守的东西",
  " * 已经不存在 —— 再跑只会一片红。检测到确实删干净了就宣告跳过，不算失败；",
  " * 哪天这套功能回来（又出现 compositionstart），自动恢复全部断言。 */",
  "const _imeGone = !ui.includes('compositionstart') && !ui.includes('imeMatchOnce');",
  "if (_imeGone) {",
  "  t.ok('输入法掰弯那套已按主人要求彻底删除（本脚本退役）', true);",
  "  t.done();",
  "  process.exit(0);",
  "}",
].join("\n");
if (!t.includes(OLDLINE)) { console.log("锚点没找到"); process.exit(1); }
t = t.replace(OLDLINE, NEW);
fs.writeFileSync(P, t, "utf8");
console.log("已改");
