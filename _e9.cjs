const fs = require("fs");
const P = "src/persona.mjs";
let L = fs.readFileSync(P, "utf8").split(/\r?\n/);
const ADD = "  '\u00b7 \u5360\u4f4d\u5e9f\u8bdd\uff1a\u300c\u55ef\uff0c\u6211\u5728\u300d\u300c\u6211\u5728\uff0c\u4f60\u7ee7\u7eed\u8bf4\u300d\u300c\u6211\u5728\u7684\u300d\u2014\u2014\u8fd9\u4e0d\u53eb\u56de\u7b54\uff0c\u8fd9\u662f\u628a\u7403\u8e22\u56de\u7ed9\u4e3b\u4eba\u3002\u4ed6\u95ee\u4f60\u4ec0\u4e48\u5c31\u7b54\u4ec0\u4e48\uff0c\u8981\u5e72\u6d3b\u5c31\u53bb\u5e72\u3002',";
L.splice(225, 0, ADD);
fs.writeFileSync(P, L.join("\r\n"), "utf8");
const L2 = fs.readFileSync(P, "utf8").split(/\r?\n/);
for (let k = 221; k < 229; k++) console.log((k + 1) + "|" + L2[k]);
