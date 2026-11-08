const fs = require("fs");
const dir = "C:/Users/35453/AppData/Roaming/小鱼Agent/data/.state/sessions";
const me = "smw0jyzki7gbc.json";
const p = dir + "/" + me;
if (!fs.existsSync(p)) { console.log("没有这个会话文件"); process.exit(0); }
const j = JSON.parse(fs.readFileSync(p, "utf8"));
const msgs = j.messages || j.history || [];
console.log("消息条数=" + msgs.length);
let hit = 0;
const samples = [];
for (let i = 0; i < msgs.length; i++) {
  const c = typeof msgs[i].content === "string" ? msgs[i].content : JSON.stringify(msgs[i].content || "");
  if (c.includes("嗯，我在")) {
    hit++;
    if (samples.length < 6) samples.push(msgs[i].role + " -> " + c.slice(0, 60).replace(/\n/g, " "));
  }
}
console.log("含「嗯，我在」的条数=" + hit);
samples.forEach((s) => console.log("  " + s));
