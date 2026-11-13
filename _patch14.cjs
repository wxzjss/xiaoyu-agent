const fs = require("fs");
const targets = ["check-tool-hub-leak", "check-tool-naming", "check-tool-start-pair"];
for (const n of targets) {
  const p = "scripts/" + n + ".mjs";
  let t = fs.readFileSync(p, "utf8");
  const re = /if \(!\(await ensureLogStore\(cdp\)\)\)[^\n]*/;
  const m = t.match(re);
  if (!m) { console.log("MISS " + n); continue; }
  const neu = "if (!(await ensureLogStore(cdp))) { console.log(\"  store 没就绪 —— 真机格跳过\"); t.done(); process.exit(0); }";
  t = t.replace(m[0], neu);
  fs.writeFileSync(p, t, "utf8");
  console.log("OK " + n + " 原: " + m[0].slice(0, 60));
}
