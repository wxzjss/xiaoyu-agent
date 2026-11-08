const fs = require("fs");
const L = fs.readFileSync("src/agent.mjs", "utf8").split(/\r?\n/);
console.log("=== 570~844 之间顶格的 } （说明函数在第几行结束）===");
for (let i = 569; i < 844; i++) {
  if (L[i] === "}") console.log((i + 1) + "| 顶格 }");
}
console.log("=== 844 那行 for 的缩进 ===");
console.log(JSON.stringify(L[843]));
