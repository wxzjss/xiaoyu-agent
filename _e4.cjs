const fs = require("fs");
const L = fs.readFileSync("public/index.html", "utf8").split(/\r?\n/);
for (let k = 10290; k < 10312; k++) console.log((k + 1) + "|" + L[k].slice(0, 120));
