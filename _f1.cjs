const fs = require("fs");
const a = fs.readFileSync("src/thinking.mjs", "utf8");
const b = fs.readFileSync("C:/Users/35453/AppData/Roaming/小鱼Agent/data/code/src/thinking.mjs", "utf8");
console.log("仓库有修复注释=" + a.includes("「开」= 不思考"));
console.log("生效那份有=" + b.includes("「开」= 不思考"));
console.log("两份逐字节一致=" + (a === b));
