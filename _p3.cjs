const fs = require("fs");
for (const P of ["scripts/check-plan-archive.mjs", "scripts/check-plan-gate.mjs"]) {
  let t = fs.readFileSync(P, "utf8");
  const before = t;
  t = t.replace(/\/\^__\(gate\|probe\|adopt\|ghost\|verify\)\//g, "/^__/");
  t = t.replace(/\/\^__\(gate\|probe\|adopt\|ghost\|verify\)\/\.test/g, null);
  if (t !== before) {
    fs.writeFileSync(P, t, "utf8");
    console.log("改了 " + P);
  } else {
    console.log("没改 " + P + "（看看现在长什么样）");
  }
}
