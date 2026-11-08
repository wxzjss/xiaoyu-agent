const fs=require("fs");
const L=fs.readFileSync("_t_ui.mjs","utf8").split(/\r?\n/);
for(let i=144;i<=245;i++) console.log((i+1)+"|"+L[i]);
