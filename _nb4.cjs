const fs=require("fs");
const p="scripts/check-enter-send.mjs";
const b=fs.readFileSync(p);
if(b[0]===0xEF){ fs.writeFileSync(p,b.slice(3)); console.log("去BOM"); } else console.log("无BOM");
