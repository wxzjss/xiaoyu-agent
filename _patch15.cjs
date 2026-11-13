const fs = require("fs");
let n = 0;
for (const f of fs.readdirSync("scripts")) {
  if (!f.startsWith("check-") && !f.startsWith("_t_")) continue;
  if (!f.endsWith(".mjs")) continue;
  const p = "scripts/" + f;
  let t = fs.readFileSync(p, "utf8");
  if (!t.includes("_cdp-connect")) continue;
  const before = t;
  t = t.replace(/connect\(\{\s*port:\s*Number\(process\.env\.XY_CDP_PORT\)\s*\}\)/g, "connect({ port: Number(process.env.XY_CDP_PORT), match: process.env.BASE || '127.0.0.1' })");
  t = t.replace(/connect\(\{\s*port:\s*Number\(process\.env\.XY_CDP_PORT\)\s*,\s*\}\)/g, "connect({ port: Number(process.env.XY_CDP_PORT), match: process.env.BASE || '127.0.0.1' })");
  if (t !== before) { fs.writeFileSync(p, t, "utf8"); n += 1; console.log("改了 " + f); }
}
console.log("共 " + n + " 个文件");
