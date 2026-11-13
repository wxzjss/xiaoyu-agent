const fs=require("fs");
for (const f of fs.readdirSync("scripts")) {
  if(!f.endsWith(".mjs")) continue;
  const p="scripts/"+f;
  const b=fs.readFileSync(p);
  if(b[0]===0xEF&&b[1]===0xBB&&b[2]===0xBF){ fs.writeFileSync(p,b.slice(3)); console.log("去BOM "+f); }
}
