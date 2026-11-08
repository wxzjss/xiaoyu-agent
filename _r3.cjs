const fs = require("fs");
const P = "scripts/check-ime-compose.mjs";
let t = fs.readFileSync(P, "utf8");
t = t.replace("if (process.env.SKIP_UI) t.done();", "t.done();");
fs.writeFileSync(P, t, "utf8");
console.log("已补 done");
