const fs = require("fs");
const P = "src/agent.mjs";
let L = fs.readFileSync(P, "utf8").split(/\r?\n/);
const idx = 1605; // 0-based，就是第 1606 行
console.log("原行: " + JSON.stringify(L[idx]));
// 改成：敷衍话不落历史（断掉自我强化），让下面的敷衍闸去重答
const NEW = [
  "          /* 【2026-11-08 修「嗯，我在」自我强化】",
  "           * 原来这里无条件把她这句话落进历史 —— 后来发现模型只说一句「嗯，我在」时，",
  "           * 这句也照样落进去了。攒到二十来条之后，模型看着前面清一色「嗯，我在」，",
  "           * 就跟着学，越回越短、越回越敷衍，拦都拦不住。",
  "           * 所以：敷衍话一律不落历史，交给下面那道闸去重答。 */",
  "          if (String(text || '''').trim() && !isFillerReply(text)) messages.push({ role: '''assistant''', content: text });",
];
L.splice(idx, 1, ...NEW);
fs.writeFileSync(P, L.join("\r\n"), "utf8");
console.log("已改");
