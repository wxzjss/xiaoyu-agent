const fs = require("fs");
const L = fs.readFileSync("src/agent.mjs", "utf8").split(/\r?\n/);
// 找所有顶格开头、且是 function 的行，判断 844 在哪个函数里
for (let i = 0; i < L.length; i++) {
  const l = L[i];
  if (/^(export )?(async )?function /.test(l) || /^const [A-Za-z_$]+ = (async )?\(/.test(l)) {
    if (i > 400 && i < 900) console.log((i + 1) + "|" + l.trim().slice(0, 80));
  }
}
console.log("--- 800-845 缩进样本 ---");
for (let k = 818; k < 846; k++) console.log((k + 1) + "|" + JSON.stringify(L[k].slice(0, 50)));
