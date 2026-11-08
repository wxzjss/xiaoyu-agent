const fs = require("fs");
const p = "C:/Users/35453/AppData/Roaming/小鱼Agent/data/.state/sessions/smw0jyzki7gbc.json";
const j = JSON.parse(fs.readFileSync(p, "utf8"));
const msgs = j.messages || [];
let shown = 0;
for (let i = 0; i < msgs.length; i++) {
  const c = typeof msgs[i].content === "string" ? msgs[i].content : "";
  if (msgs[i].role === "assistant" && c.includes("嗯，我在") && c.length < 40) {
    // 往回找最近一条真 user
    let u = "(没找到)";
    for (let k = i - 1; k >= 0; k--) {
      if (msgs[k].role === "user" && !msgs[k].context) { u = String(msgs[k].content || "").slice(0, 40); break; }
    }
    console.log("#" + i + "  我说=" + JSON.stringify(c.trim()) + "   主人说=" + JSON.stringify(u));
    shown++;
    if (shown >= 12) break;
  }
}
