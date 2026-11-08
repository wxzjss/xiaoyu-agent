const fs = require("fs");
const L = fs.readFileSync("src/persona.mjs", "utf8").split(/\r?\n/);
L.forEach((l, i) => {
  if (/不许说|别说|禁止|客套|助手腔/.test(l) && l.trim().length < 160) console.log((i + 1) + "|" + l.trim());
});
