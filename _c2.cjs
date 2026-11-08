const fs = require("fs");
const p = "C:/Users/35453/AppData/Roaming/小鱼Agent/data/.state/sessions/smw0jyzki7gbc.json";
const j = JSON.parse(fs.readFileSync(p, "utf8"));
console.log("会话顶层字段: " + Object.keys(j).join(", "));
const msgs = j.messages || [];
// 看最近几条 assistant 的完整结构，找有没有记录思考档位 / usage
const last = msgs.slice(-6);
last.forEach((m, i) => {
  const c = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
  console.log("--- #" + (msgs.length - 6 + i) + " role=" + m.role + " keys=" + Object.keys(m).join(","));
  console.log("    content=" + JSON.stringify(c.slice(0, 100)));
  if (m.usage) console.log("    usage=" + JSON.stringify(m.usage));
});
