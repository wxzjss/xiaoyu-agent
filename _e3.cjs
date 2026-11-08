const fs = require("fs");
const t = fs.readFileSync("public/ui/chat.js", "utf8");
const L = t.split(/\r?\n/);
L.forEach((l, i) => {
  if (/case '|ev\.type ===|switch \(/.test(l) && l.trim().length < 120) console.log((i + 1) + "|" + l.trim());
});
