const fs = require("fs");
const t = fs.readFileSync("public/index.html", "utf8");
const refs = Array.from(t.matchAll(/<script[^>]*src="([^"]+)"/g)).map((m) => m[1]);
console.log("script 引用: " + refs.join(", "));
for (const r of refs) {
  const p = "public/" + r.replace(/^\.\//, "");
  console.log("  " + r + " -> " + (fs.existsSync(p) ? "在" : "缺失!"));
}
console.log("结尾: " + JSON.stringify(t.slice(-30)));
