const fs = require("fs");
const P = "src/persona.mjs";
let L = fs.readFileSync(P, "utf8").split(/\r?\n/);
const idx = L.findIndex((x) => x.includes("· 助手腔：") || x.includes("助手腔"));
console.log("找到助手腔那行 = " + (idx + 1));
console.log(JSON.stringify(L[idx]));
