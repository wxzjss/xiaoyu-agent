const fs = require("fs");
const L = fs.readFileSync("src/agent.mjs", "utf8").split(/\r?\n/);
L.forEach((l, i) => {
  if (/禁止|不许|别用|占位|敷衍|口头禅/.test(l) && i < 430) console.log((i + 1) + "|" + l.trim().slice(0, 130));
});
