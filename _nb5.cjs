const fs=require("fs");
for (const n of ["check-tool-hub-leak","check-tool-naming","check-tool-start-pair"]) {
  const p="scripts/"+n+".mjs";
  const b=fs.readFileSync(p);
  if(b[0]===0xEF&&b[1]===0xBB&&b[2]===0xBF){ fs.writeFileSync(p,b.slice(3)); console.log("去BOM "+n); }
}
